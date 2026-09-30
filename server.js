require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { listPersonas, listPanels } = require('./src/dataLoader');
const { createSession, getSession, updateSession } = require('./src/sessionStore');
const { getModels, createChatCompletion, streamChatCompletion } = require('./src/llm/nova');
const { runSession } = require('./src/orchestrator/orchestrator');
const { closeBrowser } = require('./src/capture/playwright');

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultModel = process.env.NOVA_MODEL_DEFAULT || 'gemma4:26b';
const capturesDir = path.join(__dirname, 'data', 'captures');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/captures', express.static(capturesDir));

app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'multi-agent-focus-group', timestamp: new Date().toISOString() });
});

app.get('/api/config', async (req, res) => {
    const config = {
        baseUrl: process.env.NOVA_BASE_URL || 'https://api.nova.datalabrotterdam.nl/v1',
        model: defaultModel,
        hasApiKey: Boolean(process.env.NOVA_API_KEY),
    };

    res.json(config);
});

app.get('/api/personas', async (req, res) => {
    try {
        const personas = await listPersonas();
        res.json(personas);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to load personas.' });
    }
});

app.get('/api/panels', async (req, res) => {
    try {
        const panels = await listPanels();
        res.json(panels);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to load panels.' });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const models = await getModels();
        res.json(models);
    } catch (error) {
        res.status(400).json({ error: error.message || 'Failed to load models.' });
    }
});

app.post('/api/sessions/start', async (req, res) => {
    try {
        const {
            url,
            scenario,
            device = 'desktop',
            acceptCookies = true,
            maxSteps = 4,
            discussionRounds = 3,
            selectedPersonaIds = [],
            panelId = null,
        } = req.body || {};

        if (!url) {
            return res.status(400).json({ error: 'URL is required.' });
        }

        // The URL is opened in a real browser, so only allow web pages (no file:// etc.).
        if (!/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: 'URL must start with http:// or https://.' });
        }

        const personas = await listPersonas();
        const selected = selectedPersonaIds.length
            ? personas.filter((persona) => selectedPersonaIds.includes(persona.id))
            : personas.slice(0, 3);

        const sessionId = crypto.randomUUID();
        const session = {
            id: sessionId,
            status: 'started',
            createdAt: new Date().toISOString(),
            url,
            scenario: scenario || 'No scenario specified',
            device: device === 'mobile' ? 'mobile' : 'desktop',
            acceptCookies: acceptCookies !== false,
            maxSteps: clampInt(maxSteps, 1, 8, 4),
            discussionRounds: clampInt(discussionRounds, 0, 6, 3),
            selectedPersonaIds: selected.map((persona) => persona.id),
            personas: selected,
            events: [],
            transcript: [],
        };

        createSession(session);

        broadcastSessionEvent(sessionId, 'session.started', {
            id: sessionId,
            url,
            scenario,
            personas: selected.map((persona) => ({ id: persona.id, name: persona.name })),
        });

        broadcastSessionEvent(sessionId, 'phase.started', {
            phase: 'setup',
            message: `Session created with ${selected.length} personas on ${session.device}, up to ${session.maxSteps} screens each.`,
        });

        const emit = (eventName, payload) => broadcastSessionEvent(sessionId, eventName, payload);
        updateSession(sessionId, { status: 'running' });

        runSession({ session: getSession(sessionId), emit, model: defaultModel, capturesDir })
            .then(() => updateSession(sessionId, { status: 'completed' }))
            .catch((error) => {
                updateSession(sessionId, { status: 'failed' });
                emit('session.error', { message: error.message || 'Session failed.' });
            });

        res.json({ sessionId, status: 'running', url, personaCount: selected.length });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to start session.' });
    }
});

app.get('/api/sessions/:sessionId/stream', (req, res) => {
    const { sessionId } = req.params;
    const session = getSession(sessionId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (!session) {
        res.write(`event: session.error\ndata: ${JSON.stringify({ message: 'Session not found.' })}\n\n`);
        res.end();
        return;
    }

    const listeners = session.listeners || new Set();
    listeners.add(res);
    session.listeners = listeners;

    const events = session.events || [];
    for (const event of events) {
        sendSseEvent(res, event.event, event.data);
    }

    req.on('close', () => {
        listeners.delete(res);
    });
});

app.get('/api/sessions/:sessionId', (req, res) => {
    const session = getSession(req.params.sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found.' });
    }

    res.json({
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        url: session.url,
        scenario: session.scenario,
        personas: session.personas,
        transcript: session.transcript,
    });
});

app.post('/api/test/llm', async (req, res) => {
    try {
        const { message = 'Say hello from Nova in one sentence.' } = req.body || {};
        const result = await createChatCompletion({
            model: defaultModel,
            messages: [{ role: 'user', content: message }],
            max_tokens: 128,
        });

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'LLM test failed.' });
    }
});

app.get('/api/test/llm/stream', async (req, res) => {
    const message = req.query.message || 'Describe your first impression of an online shop homepage in three sentences.';
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    try {
        const stream = streamChatCompletion({
            model: defaultModel,
            messages: [{ role: 'user', content: message }],
            max_tokens: 256,
            signal: abort.signal,
        });

        for await (const event of stream) {
            sendSseEvent(res, event.type === 'delta' ? 'llm.delta' : 'llm.done', event);
        }
    } catch (error) {
        if (!abort.signal.aborted) {
            sendSseEvent(res, 'llm.error', { message: error.message || 'LLM stream failed.' });
        }
    }

    res.end();
});

function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isNaN(number) ? fallback : Math.min(Math.max(number, min), max);
}

function broadcastSessionEvent(sessionId, eventName, payload) {
    const session = getSession(sessionId);
    if (!session) return;

    const event = { event: eventName, data: payload };
    session.events = [...(session.events || []), event];

    if (session.listeners) {
        for (const listener of session.listeners) {
            sendSseEvent(listener, eventName, payload);
        }
    }
}

function sendSseEvent(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`Multi-agent focus group app listening on http://localhost:${port}`);
});

// Playwright installs its own SIGTERM handler, which closes the browser but does
// not exit, so without this `node --watch` restarts and `kill` never complete.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
        await closeBrowser().catch(() => {});
        process.exit(0);
    });
}
