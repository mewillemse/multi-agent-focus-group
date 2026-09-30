const path = require('path');
const { capturePage } = require('../capture/playwright');
const { PersonaAgent } = require('../agents/personaAgent');

/**
 * Runs one focus-group session end to end, reporting progress through
 * `emit(eventName, payload)`. Current phases:
 *   goal -> (capture) -> experience -> reflection
 * Discussion, convergence and reporting come later.
 */
async function runSession({ session, emit, model, capturesDir }) {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    const startPhase = (phase, message) => emit('phase.started', { phase, message });

    let agents = session.personas.map((persona) => new PersonaAgent({ persona, session, model, emit }));

    // Load the page while personas form their goals; they must not see it yet.
    const capturePromise = capturePage({
        url: session.url,
        device: session.device,
        outputDir: path.join(capturesDir, session.id),
        acceptCookies: session.acceptCookies,
    });
    capturePromise.catch(() => {}); // awaited below; avoid an unhandled rejection meanwhile

    startPhase('goal', 'Personas are deciding what they want from this visit.');
    agents = await runPhase(agents, (agent) => agent.formGoal());

    startPhase('capture', 'Loading the page in a real browser.');
    const capture = await capturePromise;

    emit('capture.completed', {
        url: capture.url,
        title: capture.title,
        status: capture.status,
        device: capture.device,
        viewport: capture.viewport,
        screenshotUrl: `/captures/${session.id}/${capture.screenshotFile}`,
        elements: capture.elements,
        blockedReason: capture.blockedReason,
        cookieConsent: capture.cookieConsent,
    });

    if (capture.blockedReason) {
        throw new Error(`Cannot evaluate this page. ${capture.blockedReason}`);
    }

    startPhase('experience', 'Personas are exploring the page and thinking aloud.');
    agents = await runPhase(agents, (agent) => agent.experience(capture));

    startPhase('reflection', 'Personas are looking back on their visit.');
    agents = await runPhase(agents, (agent) => agent.reflect());

    emit('session.completed', {
        usage,
        personas: agents.map((agent) => ({
            personaId: agent.persona.id,
            goal: agent.results.goal?.data,
            experience: agent.results.experience?.data,
            reflection: agent.results.reflection?.data,
        })),
    });

    async function runPhase(activeAgents, step) {
        const outcomes = await Promise.allSettled(activeAgents.map(step));
        const survivors = [];

        outcomes.forEach((outcome, index) => {
            const agent = activeAgents[index];
            if (outcome.status === 'fulfilled') {
                addUsage(outcome.value.usage);
                survivors.push(agent);
            } else {
                emit('persona.error', { personaId: agent.persona.id, message: outcome.reason?.message || 'Persona failed.' });
            }
        });

        emit('usage.updated', usage);

        if (!survivors.length) {
            throw new Error(`All personas failed. First error: ${outcomes[0].reason?.message}`);
        }
        return survivors;
    }

    function addUsage(callUsage) {
        usage.calls += 1;
        if (!callUsage) return;
        usage.promptTokens += callUsage.prompt_tokens || 0;
        usage.completionTokens += callUsage.completion_tokens || 0;
        usage.totalTokens += callUsage.total_tokens || 0;
    }
}

module.exports = { runSession };
