const path = require('path');
const { BrowserSession } = require('../capture/playwright');
const { PersonaAgent } = require('../agents/personaAgent');
const { ModeratorAgent } = require('../agents/moderatorAgent');
const { runDiscussion } = require('./discussion');

/**
 * Runs one focus-group session end to end, reporting progress through
 * `emit(eventName, payload)`. Current phases:
 *   goal -> experience (each persona browses up to maxSteps screens)
 *   -> reflection -> discussion (moderated, needs 2+ personas)
 * Reporting comes later.
 */
async function runSession({ session, emit, model, capturesDir }) {
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    const startPhase = (phase, message) => emit('phase.started', { phase, message });
    const outputDir = path.join(capturesDir, session.id);
    const maxSteps = session.maxSteps;

    let agents = session.personas.map((persona) => new PersonaAgent({ persona, session, model, emit, onUsage: addUsage }));

    // Each persona gets its own tab, opened while it forms its goal; it must not see the page yet.
    const browsers = new Map();
    for (const agent of agents) {
        const opening = BrowserSession.open({ url: session.url, device: session.device, acceptCookies: session.acceptCookies });
        opening.catch(() => {}); // awaited in explore(); avoid an unhandled rejection meanwhile
        browsers.set(agent, opening);
    }

    try {
        startPhase('goal', 'Personas are deciding what they want from this visit.');
        agents = await runPhase(agents, (agent) => agent.formGoal());

        startPhase('experience', `Personas are browsing the site and thinking aloud (up to ${maxSteps} screens each).`);
        agents = await runPhase(agents, (agent) => explore(agent, browsers.get(agent)));

        startPhase('reflection', 'Personas are looking back on their visit.');
        agents = await runPhase(agents, (agent) => agent.reflect());

        let discussion = null;
        if (agents.length >= 2 && session.discussionRounds > 0) {
            startPhase('discussion', 'The moderator is leading a group discussion.');
            const moderator = new ModeratorAgent({ session, agents, model, onUsage: addUsage });
            discussion = await runDiscussion({ agents, moderator, rounds: session.discussionRounds, emit });
        }

        emit('session.completed', {
            usage,
            personas: agents.map((agent) => ({
                personaId: agent.persona.id,
                goal: agent.results.goal?.data,
                journey: agent.journey,
                reflection: agent.results.reflection?.data,
            })),
            discussion,
        });
    } finally {
        await Promise.all([...browsers.values()].map((opening) => opening.then((browser) => browser.close(), () => {})));
    }

    async function explore(agent, opening) {
        const personaId = agent.persona.id;
        const browser = await opening;
        let situation = 'The page has loaded.';

        for (let step = 1; step <= maxSteps; step += 1) {
            const capture = await browser.capture({ outputDir, name: `${personaId}-step${step}` });

            emit('persona.capture', {
                personaId,
                step,
                url: capture.url,
                title: capture.title,
                status: capture.status,
                device: capture.device,
                viewport: capture.viewport,
                screenshotUrl: `/captures/${session.id}/${capture.screenshotFile}`,
                elements: capture.elements,
                blockedReason: step === 1 ? capture.blockedReason : null,
                cookieConsent: step === 1 ? capture.cookieConsent : null,
            });

            if (step === 1 && capture.blockedReason) {
                throw new Error(`Cannot evaluate this page. ${capture.blockedReason}`);
            }

            const result = await agent.experience(capture, { step, maxSteps, situation });
            const action = result.data?.nextAction;

            if (!action?.type || ['done', 'leave'].includes(action.type) || step === maxSteps) break;

            const outcome = await browser.perform(action);
            agent.recordOutcome(outcome);
            emit('persona.action', { personaId, step, action, outcome });
            situation = outcome.description;
        }
    }

    async function runPhase(activeAgents, step) {
        const outcomes = await Promise.allSettled(activeAgents.map(step));
        const survivors = [];

        outcomes.forEach((outcome, index) => {
            const agent = activeAgents[index];
            if (outcome.status === 'fulfilled') {
                survivors.push(agent);
            } else {
                emit('persona.error', { personaId: agent.persona.id, message: outcome.reason?.message || 'Persona failed.' });
            }
        });

        if (!survivors.length) {
            throw new Error(`All personas failed. First error: ${outcomes[0].reason?.message}`);
        }
        return survivors;
    }

    function addUsage(callUsage) {
        usage.calls += 1;
        if (callUsage) {
            usage.promptTokens += callUsage.prompt_tokens || 0;
            usage.completionTokens += callUsage.completion_tokens || 0;
            usage.totalTokens += callUsage.total_tokens || 0;
        }
        emit('usage.updated', { ...usage }); // copy: stored events must not change afterwards
    }
}

module.exports = { runSession };
