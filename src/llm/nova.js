const baseUrl = process.env.NOVA_BASE_URL || 'https://api.nova.datalabrotterdam.nl/v1';
const runtimeApiKey = process.env.NOVA_API_KEY || '';
const REQUEST_TIMEOUT_MS = 120000;

// The timeout covers the whole call, including reading a streamed body.
async function request(path, { signal, timeoutMs = REQUEST_TIMEOUT_MS, ...options } = {}) {
    const url = `${baseUrl}${path}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;

    try {
        response = await fetch(url, {
            ...options,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${runtimeApiKey}`,
                ...(options.headers || {}),
            },
        });
    } catch (error) {
        throw timeout.aborted ? new Error(`Nova did not respond within ${timeoutMs / 1000}s.`) : error;
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Nova API error (${response.status}): ${errorText || response.statusText}`);
    }

    return response;
}

function assertApiKey() {
    if (!runtimeApiKey) {
        throw new Error('NOVA_API_KEY is not set. Add it to your .env file before testing the LLM adapter.');
    }
}

function buildPayload({ model, messages, max_tokens, temperature }) {
    const payload = { model, messages, max_tokens };

    if (temperature !== undefined) {
        payload.temperature = temperature;
    }

    return payload;
}

async function getModels() {
    const response = await request('/models');
    return response.json();
}

async function createChatCompletion({ model, messages, max_tokens = 256, temperature = undefined, signal }) {
    assertApiKey();

    const response = await request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...buildPayload({ model, messages, max_tokens, temperature }), stream: false }),
        signal,
    });

    return response.json();
}

/**
 * Streams a chat completion as an async iterable of events:
 *   { type: 'delta', text }                              — for each content chunk
 *   { type: 'done', content, usage, finishReason, model } — once, at the end
 *
 * `usage` is { prompt_tokens, completion_tokens, total_tokens } when the
 * upstream honours stream_options.include_usage, otherwise null.
 */
async function* streamChatCompletion({ model, messages, max_tokens = 1024, temperature = undefined, signal }) {
    assertApiKey();

    const response = await request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
            ...buildPayload({ model, messages, max_tokens, temperature }),
            stream: true,
            stream_options: { include_usage: true },
        }),
        signal,
    });

    let content = '';
    let usage = null;
    let finishReason = null;
    let responseModel = model;

    for await (const chunk of readServerSentData(response.body)) {
        if (chunk.error) {
            throw new Error(`Nova stream error: ${chunk.error.message || JSON.stringify(chunk.error)}`);
        }

        if (chunk.model) responseModel = chunk.model;
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const text = choice.delta?.content;
        if (text) {
            content += text;
            yield { type: 'delta', text };
        }
    }

    yield { type: 'done', content, usage, finishReason, model: responseModel };
}

// Parses an OpenAI-style SSE body into JSON payloads, stopping at [DONE].
async function* readServerSentData(body) {
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();

        for (const line of lines) {
            const payload = parseDataLine(line);
            if (payload === DONE) return;
            if (payload) yield payload;
        }
    }

    const payload = parseDataLine(buffer + decoder.decode());
    if (payload && payload !== DONE) yield payload;
}

const DONE = Symbol('done');

function parseDataLine(line) {
    if (!line.startsWith('data:')) return null;

    const data = line.slice(5).trim();
    if (data === '[DONE]') return DONE;
    return data ? JSON.parse(data) : null;
}

module.exports = {
    getModels,
    createChatCompletion,
    streamChatCompletion,
};
