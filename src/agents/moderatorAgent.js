const { streamTurn } = require('./streamTurn');
const { renderPrompt } = require('../prompts');

/**
 * Leads the group discussion. Stateless between turns: every call gets the
 * participants' visits (in the system prompt) plus the full transcript.
 */
class ModeratorAgent {
    constructor({ session, agents, model, onUsage = () => {} }) {
        this.model = model;
        this.onUsage = onUsage;
        this.system = renderPrompt('moderator-system', {
            url: session.url,
            device: session.device,
            scenario: session.scenario,
            participants: agents.map(summarizeParticipant).join('\n\n'),
        });
    }

    ask({ transcript, speakingCounts, round, rounds, ids, maxAddressees, onDelta }) {
        let roundNote = '';
        if (round === 1) roundNote = 'Open the discussion: welcome the participants in one sentence, then ask your first question.';
        else if (round === rounds) roundNote = 'This is the last question before you close the discussion.';

        return this.#call(renderPrompt('moderator-question', {
            transcript: transcript || '(nothing yet)',
            speakingCounts,
            round,
            rounds,
            roundNote,
            ids: ids.join(', '),
            maxAddressees,
        }), onDelta);
    }

    close({ transcript, onDelta }) {
        return this.#call(renderPrompt('moderator-close', { transcript }), onDelta, 700);
    }

    async #call(content, onDelta, maxTokens = 400) {
        const result = await streamTurn({
            model: this.model,
            messages: [
                { role: 'system', content: this.system },
                { role: 'user', content },
            ],
            maxTokens,
            temperature: 0.4,
            onDelta,
        });
        this.onUsage(result.usage);
        return result;
    }
}

function summarizeParticipant(agent) {
    const { persona, results } = agent;
    const goal = results.goal?.data?.goal || '(unknown)';
    const reflection = results.reflection?.data || {};
    const list = (items) => (items?.length ? items.join('; ') : 'none mentioned');

    return [
        `### ${persona.name} (id: ${persona.id}) — ${persona.role || 'participant'}`,
        `${persona.oneLiner || ''}`,
        `Goal for the visit: ${goal}`,
        'What they did:',
        agent.describeJourney(),
        `Afterwards: trust ${reflection.trustScore ?? '?'}/5, ${reflection.wouldContinue ? 'would continue' : 'would leave'}.`,
        `Main issues: ${list(reflection.topIssues)}`,
        `What worked: ${list(reflection.positives)}`,
        reflection.quote ? `In their words: "${reflection.quote}"` : '',
    ].filter(Boolean).join('\n');
}

module.exports = { ModeratorAgent };
