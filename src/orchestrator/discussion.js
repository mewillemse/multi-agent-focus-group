const { renderPrompt } = require('../prompts');

/**
 * Moderated group discussion: `rounds` moderator questions, each answered in
 * turn by 1-3 personas who see what was said before them, then a closing
 * summary. Streams through discussion.* events and returns
 * { transcript, summary }.
 */
async function runDiscussion({ agents, moderator, rounds, emit }) {
    const transcript = []; // { speaker: 'moderator' | personaId, name, text }
    const heardUpTo = new Map(agents.map((agent) => [agent, 0])); // transcript index each persona has seen
    const byId = new Map(agents.map((agent) => [agent.persona.id, agent]));
    const maxAddressees = Math.min(3, agents.length);
    let messageCount = 0;

    const format = (entries) => entries.map((entry) => `${entry.name}: ${entry.text}`).join('\n\n');

    async function say(speaker, name, run) {
        const id = `m${++messageCount}`;
        emit('discussion.message.started', { id, speaker, name });
        try {
            const result = await run((text) => emit('discussion.delta', { id, text }));
            transcript.push({ speaker, name, text: result.prose });
            emit('discussion.message.completed', {
                id,
                speaker,
                prose: result.prose,
                data: result.data,
                parseError: result.parseError,
            });
            return result;
        } catch (error) {
            emit('discussion.message.failed', { id, speaker, message: error.message || 'No reply.' });
            throw error;
        }
    }

    function speakingCounts() {
        return agents
            .map((agent) => `${agent.persona.name}: ${transcript.filter((entry) => entry.speaker === agent.persona.id).length}`)
            .join(', ');
    }

    // Unknown or missing ids fall back to whoever has spoken least.
    function pickAddressees(ids) {
        const picked = [...new Set(Array.isArray(ids) ? ids : [])].map((id) => byId.get(id)).filter(Boolean);
        if (picked.length) return picked.slice(0, maxAddressees);

        const quietest = [...agents].sort((a, b) =>
            transcript.filter((entry) => entry.speaker === a.persona.id).length
            - transcript.filter((entry) => entry.speaker === b.persona.id).length)[0];
        return [quietest];
    }

    function updateFor(agent) {
        const firstTime = heardUpTo.get(agent) === 0;
        const others = agents
            .filter((other) => other !== agent)
            .map((other) => `${other.persona.name} (${other.persona.role || 'participant'})`)
            .join(', ');

        return renderPrompt('persona-discussion', {
            intro: firstTime
                ? `Your visit is over. You now join a group discussion, led by a moderator, with other people who visited the same site: ${others}.`
                : 'The group discussion continues.',
            transcript: format(transcript.slice(heardUpTo.get(agent))),
        });
    }

    for (let round = 1; round <= rounds; round += 1) {
        const question = await say('moderator', 'Moderator', (onDelta) => moderator.ask({
            transcript: format(transcript),
            speakingCounts: speakingCounts(),
            round,
            rounds,
            ids: agents.map((agent) => agent.persona.id),
            maxAddressees,
            onDelta,
        }));

        for (const agent of pickAddressees(question.data?.addressees)) {
            try {
                const update = updateFor(agent);
                await say(agent.persona.id, agent.persona.name, (onDelta) => agent.discuss(update, { onDelta }));
                heardUpTo.set(agent, transcript.length);
            } catch {
                // Already reported via discussion.message.failed; the others carry on.
            }
        }
    }

    const closing = await say('moderator', 'Moderator', (onDelta) => moderator.close({ transcript: format(transcript), onDelta }));

    return { transcript, summary: closing.data };
}

module.exports = { runDiscussion };
