const { streamChatCompletion } = require('../llm/nova');
const { splitProseAndJson } = require('../llm/structuredStream');
const { renderPrompt, describePersona } = require('../prompts');
const { describeElements } = require('../capture/playwright');

/**
 * One simulated participant. Keeps its own conversation so every phase
 * builds on what the persona said before, and streams its think-aloud
 * through `emit(eventName, payload)`.
 */
class PersonaAgent {
    constructor({ persona, session, model, emit }) {
        this.persona = persona;
        this.session = session;
        this.model = model;
        this.emit = emit;
        this.results = {};
        this.journey = [];

        const talkativeness = persona.communicationStyle?.talkativeness ?? 3;
        this.messages = [
            {
                role: 'system',
                content: renderPrompt('persona-system', {
                    name: persona.name,
                    profile: describePersona(persona),
                    language: persona.demographics?.language || 'English',
                    proseLength: talkativeness >= 4 ? '5 to 7 sentences' : talkativeness <= 2 ? '2 to 3 sentences' : '3 to 5 sentences',
                }),
            },
        ];
    }

    formGoal() {
        return this.#turn('goal', renderPrompt('persona-goal', {
            url: this.session.url,
            device: this.session.device,
            scenario: this.session.scenario,
        }));
    }

    async experience(capture) {
        const prompt = renderPrompt('persona-experience', {
            device: capture.device,
            title: capture.title || '(no title)',
            pageUrl: capture.url,
            elements: describeElements(capture.elements, { onlyInViewport: true }) || '(none)',
            text: capture.visibleText || '(no text)',
        });

        const result = await this.#turn('experience', [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${capture.screenshotBase64}` } },
        ], { maxTokens: 1200 });

        this.journey.push({ title: capture.title || capture.url, plannedAction: result.data?.nextAction?.type });
        return result;
    }

    reflect() {
        return this.#turn('reflection', renderPrompt('persona-reflection', { journey: this.#describeJourney() }));
    }

    // Plain account of what actually happened, so reflections cannot invent steps.
    #describeJourney() {
        if (!this.journey.length) return '- You did not get to see the page.';

        const lines = this.journey.map((step, index) => `- Screen ${index + 1}: you looked at "${step.title}" without scrolling.`);
        const last = this.journey[this.journey.length - 1];
        if (last.plannedAction) {
            lines.push(`- You planned to ${last.plannedAction} next, but the visit ended before you could.`);
        }
        return lines.join('\n');
    }

    async #turn(phase, content, { maxTokens = 800 } = {}) {
        const personaId = this.persona.id;
        this.messages.push({ role: 'user', content });
        this.emit('persona.phase.started', { personaId, phase });

        let result;
        const stream = splitProseAndJson(streamChatCompletion({
            model: this.model,
            messages: this.messages,
            max_tokens: maxTokens,
            temperature: this.persona.llm?.temperature,
        }));

        for await (const event of stream) {
            if (event.type === 'delta') {
                this.emit('persona.delta', { personaId, phase, text: event.text });
            } else {
                result = event;
            }
        }

        this.messages.push({ role: 'assistant', content: result.content });
        this.results[phase] = result;

        this.emit('persona.phase.completed', {
            personaId,
            phase,
            prose: result.prose,
            data: result.data,
            parseError: result.parseError,
            finishReason: result.finishReason,
        });

        return result;
    }
}

module.exports = { PersonaAgent };
