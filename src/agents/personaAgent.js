const { streamTurn } = require('./streamTurn');
const { renderPrompt, describePersona } = require('../prompts');
const { describeElements } = require('../capture/playwright');

/**
 * One simulated participant. Keeps its own conversation so every phase
 * builds on what the persona said before, and streams its think-aloud
 * through `emit(eventName, payload)`.
 */
class PersonaAgent {
    constructor({ persona, session, model, emit, onUsage = () => {} }) {
        this.persona = persona;
        this.session = session;
        this.model = model;
        this.emit = emit;
        this.onUsage = onUsage;
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

    /**
     * One step of browsing: the persona looks at `capture` and picks a nextAction.
     * `situation` tells it what just happened ("The page has loaded.", "You clicked ...").
     */
    async experience(capture, { step, maxSteps, situation }) {
        const prompt = renderPrompt('persona-experience', {
            situation,
            step,
            maxSteps,
            device: capture.device,
            title: capture.title || '(no title)',
            pageUrl: capture.url,
            elements: describeElements(capture.elements, { onlyInViewport: true }) || '(none)',
            text: capture.visibleText || '(no text)',
        });

        const result = await this.#turn('experience', [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${capture.screenshotBase64}` } },
        ], { maxTokens: 1200, step });

        this.journey.push({ title: capture.title || capture.url, action: result.data?.nextAction || null, outcome: null });
        return result;
    }

    // What happened when the last step's nextAction was carried out.
    recordOutcome(outcome) {
        const last = this.journey[this.journey.length - 1];
        if (last) last.outcome = outcome;
    }

    reflect() {
        return this.#turn('reflection', renderPrompt('persona-reflection', { journey: this.describeJourney() }));
    }

    // Plain account of what actually happened, so reflections cannot invent steps.
    describeJourney() {
        if (!this.journey.length) return '- You did not get to see the page.';

        return this.journey.map((step, index) => {
            const seen = `- Screen ${index + 1}: you looked at "${step.title}".`;
            if (step.outcome) return `${seen} ${step.outcome.description}`;

            const type = step.action?.type;
            if (type === 'done') return `${seen} You felt you were done.`;
            if (type === 'leave') return `${seen} You decided to leave the site.`;
            if (type) return `${seen} You wanted to ${type} next, but the visit ended there (time was up).`;
            return seen;
        }).join('\n');
    }

    // Older screenshots are replaced by a note: the model only needs the current one, and images are costly.
    #dropOldScreenshots() {
        for (const message of this.messages) {
            if (!Array.isArray(message.content)) continue;
            const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
            message.content = `${text}\n\n(Screenshot of this earlier screen omitted.)`;
        }
    }

    /**
     * One contribution to the group discussion. `update` holds what was said
     * since this persona last spoke plus the moderator's question; the caller
     * decides where the streamed prose goes.
     */
    async discuss(update, { onDelta }) {
        return this.#ask(update, { maxTokens: 600, onDelta });
    }

    async #ask(content, { maxTokens, onDelta }) {
        this.#dropOldScreenshots();
        this.messages.push({ role: 'user', content });

        const result = await streamTurn({
            model: this.model,
            messages: this.messages,
            maxTokens,
            temperature: this.persona.llm?.temperature,
            onDelta,
        });

        this.messages.push({ role: 'assistant', content: result.content });
        this.onUsage(result.usage);
        return result;
    }

    async #turn(phase, content, { maxTokens = 800, step } = {}) {
        const personaId = this.persona.id;
        this.emit('persona.phase.started', { personaId, phase, step });

        const result = await this.#ask(content, {
            maxTokens,
            onDelta: (text) => this.emit('persona.delta', { personaId, phase, step, text }),
        });
        this.results[phase] = result;

        this.emit('persona.phase.completed', {
            personaId,
            phase,
            step,
            prose: result.prose,
            data: result.data,
            parseError: result.parseError,
            finishReason: result.finishReason,
        });

        return result;
    }
}

module.exports = { PersonaAgent };
