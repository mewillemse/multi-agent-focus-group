const FENCE = '```json';

/**
 * Wraps a streamChatCompletion() iterable for replies shaped as
 *
 *   free-form prose the user should see live...
 *   ```json
 *   { "emotion": "skeptical", ... }
 *   ```
 *
 * Yields { type: 'delta', text } for prose only (the JSON block is never
 * streamed), then { type: 'done', prose, data, parseError, content, usage, ... }.
 * `data` is null when no fenced block was found or it failed to parse.
 */
async function* splitProseAndJson(stream) {
    let pending = '';
    let jsonText = null;

    for await (const event of stream) {
        if (event.type === 'done') {
            if (jsonText === null && pending) {
                yield { type: 'delta', text: pending };
            }

            const prose = jsonText === null ? event.content : event.content.slice(0, event.content.indexOf(FENCE));
            yield { ...event, prose: prose.trim(), ...parseJsonBlock(jsonText) };
            return;
        }

        if (jsonText !== null) {
            jsonText += event.text;
            continue;
        }

        pending += event.text;

        const fenceIndex = pending.indexOf(FENCE);
        if (fenceIndex !== -1) {
            const before = pending.slice(0, fenceIndex);
            if (before) yield { type: 'delta', text: before };
            jsonText = pending.slice(fenceIndex + FENCE.length);
            pending = '';
            continue;
        }

        // Hold back a tail that could be the start of a fence split across chunks.
        const holdBack = partialFenceLength(pending);
        const ready = pending.slice(0, pending.length - holdBack);
        if (ready) yield { type: 'delta', text: ready };
        pending = pending.slice(ready.length);
    }
}

function partialFenceLength(text) {
    for (let length = Math.min(text.length, FENCE.length - 1); length > 0; length -= 1) {
        if (FENCE.startsWith(text.slice(-length))) return length;
    }
    return 0;
}

function parseJsonBlock(jsonText) {
    if (jsonText === null) {
        return { data: null, parseError: 'No ```json block found in reply.' };
    }

    const body = jsonText.replace(/```[\s\S]*$/, '').trim();
    try {
        return { data: JSON.parse(body), parseError: null };
    } catch (error) {
        return { data: null, parseError: error.message };
    }
}

module.exports = { splitProseAndJson };
