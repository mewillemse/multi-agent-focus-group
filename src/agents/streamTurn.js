const { streamChatCompletion } = require('../llm/nova');
const { splitProseAndJson } = require('../llm/structuredStream');

/**
 * One model call for a "prose + ```json" reply: prose is passed to onDelta
 * as it streams, and the final { prose, data, parseError, content, usage, ... }
 * is returned.
 */
async function streamTurn({ model, messages, maxTokens = 800, temperature, onDelta = () => {} }) {
    let result;
    const stream = splitProseAndJson(streamChatCompletion({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
    }));

    for await (const event of stream) {
        if (event.type === 'delta') {
            onDelta(event.text);
        } else {
            result = event;
        }
    }
    return result;
}

module.exports = { streamTurn };
