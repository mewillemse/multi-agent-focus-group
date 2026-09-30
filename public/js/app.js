const personaList = document.getElementById('persona-list');
const sessionForm = document.getElementById('session-form');
const sessionSummary = document.getElementById('session-summary');
const eventList = document.getElementById('event-list');
const phaseSteps = document.getElementById('phase-steps');
const captureView = document.getElementById('capture');
const personaFeed = document.getElementById('persona-feed');

const PHASES = [
    ['setup', 'Setup'],
    ['goal', 'Goals'],
    ['capture', 'Page load'],
    ['experience', 'Experience'],
    ['reflection', 'Reflection'],
    ['done', 'Done'],
];

const PERSONA_PHASE_TITLES = {
    goal: 'Goal',
    experience: 'First impression',
    reflection: 'Looking back',
};

const EMOTIONS = {
    curious: '🤔',
    confident: '😎',
    pleased: '🙂',
    neutral: '😐',
    confused: '😕',
    skeptical: '🤨',
    frustrated: '😤',
    anxious: '😟',
};

let selectedPersonaIds = [];
let personasById = new Map();
let eventSource = null;
let capture = null;
let cards = new Map();

async function loadPersonas() {
    const response = await fetch('/api/personas');
    const personas = await response.json();

    personasById = new Map(personas.map((persona) => [persona.id, persona]));
    selectedPersonaIds = personas.slice(0, 3).map((persona) => persona.id);
    renderPersonas(personas);
}

function renderPersonas(personas) {
    personaList.innerHTML = '';

    for (const persona of personas) {
        const card = document.createElement('label');
        card.className = 'persona-card';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedPersonaIds.includes(persona.id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked && !selectedPersonaIds.includes(persona.id)) {
                selectedPersonaIds.push(persona.id);
            }

            if (!checkbox.checked && selectedPersonaIds.includes(persona.id)) {
                selectedPersonaIds = selectedPersonaIds.filter((id) => id !== persona.id);
            }
        });

        const meta = el('div', 'persona-meta');
        meta.append(el('strong', null, persona.name), el('small', null, persona.role || 'Persona'));

        card.append(checkbox, avatar(persona), meta);
        personaList.appendChild(card);
    }
}

// ---------- small DOM helpers ----------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function avatar(persona) {
    const node = el('span', 'persona-avatar', (persona?.name || '?').charAt(0).toUpperCase());
    node.style.background = persona?.avatarColor || '#4b6bff';
    return node;
}

function addEventLog(label, message) {
    const item = document.createElement('li');
    item.append(el('small', null, label), el('div', null, message));
    eventList.prepend(item);
}

// Turns "the search bar [e4]" into text with a hoverable element chip.
function proseWithElementRefs(text) {
    const fragment = document.createDocumentFragment();
    for (const part of text.split(/(\[e\d+\])/)) {
        const match = part.match(/^\[(e\d+)\]$/);
        fragment.append(match ? elementChip(match[1]) : document.createTextNode(part));
    }
    return fragment;
}

function elementChip(elementId, label) {
    const chip = el('button', 'element-chip', label || elementId);
    chip.type = 'button';
    const element = capture?.elements.find((item) => item.id === elementId);
    chip.title = element ? `${element.role}${element.name ? ` "${element.name}"` : ''}` : 'Unknown element';
    const show = () => highlightElement(elementId);
    chip.addEventListener('mouseenter', show);
    chip.addEventListener('focus', show);
    chip.addEventListener('mouseleave', clearHighlight);
    chip.addEventListener('blur', clearHighlight);
    return chip;
}

// ---------- session view ----------

function resetView(data) {
    capture = null;
    cards = new Map();
    eventList.innerHTML = '';
    personaFeed.innerHTML = '';
    captureView.innerHTML = '';
    captureView.append(el('p', 'empty-note', 'The page screenshot appears here once it has loaded.'));
    renderPhaseSteps(null);

    sessionSummary.innerHTML = '';
    sessionSummary.append(
        el('strong', null, data.url),
        el('p', 'scenario', data.scenario || ''),
        el('small', 'usage', 'Waiting for the first model call…'),
    );

    for (const { id, name } of data.personas) {
        const persona = personasById.get(id) || { id, name };
        const card = el('article', 'feed-card');

        const header = el('header', 'feed-card-header');
        const who = el('div', 'persona-meta');
        who.append(el('strong', null, persona.name), el('small', null, persona.role || ''));
        const badge = el('span', 'emotion-badge', '…');
        badge.title = 'Current emotion';
        header.append(avatar(persona), who, badge);

        const status = el('p', 'feed-status', 'Waiting…');
        const phases = el('div', 'feed-phases');
        card.append(header, status, phases);
        personaFeed.append(card);

        cards.set(id, { card, badge, status, phases, blocks: new Map() });
    }
}

function renderPhaseSteps(current) {
    phaseSteps.innerHTML = '';
    const currentIndex = PHASES.findIndex(([key]) => key === current);

    PHASES.forEach(([key, label], index) => {
        const step = el('li', null, label);
        if (index < currentIndex || current === 'done') step.classList.add('done');
        if (index === currentIndex && current !== 'done') step.classList.add('active');
        phaseSteps.append(step);
    });
}

function setEmotion(entry, emotion, intensity) {
    if (!emotion) return;
    entry.badge.textContent = `${EMOTIONS[emotion] || '💬'} ${emotion}`;
    entry.badge.dataset.emotion = emotion;
    entry.badge.title = intensity ? `Intensity ${intensity}/5` : emotion;
}

function renderCapture(data) {
    capture = data;
    captureView.innerHTML = '';

    const frame = el('div', 'capture-frame');
    frame.dataset.device = data.device;
    const image = el('img');
    image.src = data.screenshotUrl;
    image.alt = `Screenshot of ${data.title || data.url}`;
    const highlight = el('div', 'element-highlight');
    frame.append(image, highlight);

    const caption = el('figcaption');
    caption.append(
        el('strong', null, data.title || data.url),
        el('small', null, `${data.device} · HTTP ${data.status ?? '?'} · ${data.elements.length} elements`),
    );
    const consent = data.cookieConsent;
    if (consent?.accepted) {
        caption.append(el('small', null, `🍪 Cookie banner accepted automatically ("${consent.label}")`));
    } else if (consent?.error) {
        caption.append(el('p', 'warning', `Could not accept the cookie banner: ${consent.error}`));
    }
    if (data.blockedReason) caption.append(el('p', 'warning', data.blockedReason));

    captureView.append(frame, caption);
}

function highlightElement(elementId) {
    const element = capture?.elements.find((item) => item.id === elementId);
    const frame = captureView.querySelector('.capture-frame');
    if (!element || !frame) return;

    const image = frame.querySelector('img');
    const highlight = frame.querySelector('.element-highlight');
    const scale = image.clientWidth / capture.viewport.width;

    highlight.classList.toggle('offscreen', !element.inViewport);
    highlight.textContent = element.inViewport ? '' : `${elementId} is not visible on this screen`;

    if (element.inViewport) {
        const { x, y, width, height } = element.box;
        Object.assign(highlight.style, {
            left: `${x * scale}px`,
            top: `${y * scale}px`,
            width: `${width * scale}px`,
            height: `${height * scale}px`,
        });
    } else {
        Object.assign(highlight.style, { left: '', top: '', width: '', height: '' });
    }
    highlight.classList.add('visible');
}

function clearHighlight() {
    captureView.querySelector('.element-highlight')?.classList.remove('visible');
}

function phaseBlock(entry, phase) {
    if (!entry.blocks.has(phase)) {
        const block = el('section', 'phase-block');
        const prose = el('p', 'prose streaming');
        const facts = el('div', 'facts');
        block.append(el('h4', null, PERSONA_PHASE_TITLES[phase] || phase), prose, facts);
        entry.phases.append(block);
        entry.blocks.set(phase, { prose, facts });
    }
    return entry.blocks.get(phase);
}

function renderFacts(facts, phase, data) {
    facts.innerHTML = '';
    if (!data) return;

    if (phase === 'goal') {
        facts.append(el('p', 'fact-line', `🎯 ${data.goal || ''}`));
    }

    if (phase === 'experience') {
        const list = el('ul', 'observations');
        for (const observation of data.observations || []) {
            const item = el('li');
            item.dataset.sentiment = observation.sentiment || 'neutral';
            if (observation.elementId && observation.elementId !== 'null') item.append(elementChip(observation.elementId));
            item.append(document.createTextNode(` ${observation.note || ''}`));
            list.append(item);
        }
        facts.append(list);

        const next = data.nextAction;
        if (next?.type) {
            const line = el('p', 'fact-line', `➡️ Next: ${next.type} `);
            if (next.elementId && next.elementId !== 'null') line.append(elementChip(next.elementId));
            if (next.reason) line.append(document.createTextNode(` — ${next.reason}`));
            facts.append(line);
        }
    }

    if (phase === 'reflection') {
        const trust = Number(data.trustScore) || 0;
        facts.append(el('p', 'fact-line',
            `Trust ${'★'.repeat(trust)}${'☆'.repeat(Math.max(0, 5 - trust))} · ${data.wouldContinue ? 'would continue' : 'would leave'}`));
        if (data.quote) facts.append(el('blockquote', null, `“${data.quote}”`));
    }
}

// ---------- event handlers ----------

const handlers = {
    'session.started'(data) {
        resetView(data);
        addEventLog('session', `Started: ${data.url}`);
    },

    'phase.started'(data) {
        renderPhaseSteps(data.phase);
        addEventLog('phase', `${data.phase}: ${data.message}`);
    },

    'persona.phase.started'({ personaId, phase }) {
        const entry = cards.get(personaId);
        if (!entry) return;
        entry.status.textContent = `${PERSONA_PHASE_TITLES[phase] || phase} — thinking aloud…`;
        phaseBlock(entry, phase);
    },

    'persona.delta'({ personaId, phase, text }) {
        const entry = cards.get(personaId);
        if (!entry) return;
        phaseBlock(entry, phase).prose.textContent += text;
    },

    'persona.phase.completed'({ personaId, phase, prose, data, parseError }) {
        const entry = cards.get(personaId);
        if (!entry) return;

        const block = phaseBlock(entry, phase);
        block.prose.classList.remove('streaming');
        block.prose.textContent = '';
        block.prose.append(proseWithElementRefs(prose));
        renderFacts(block.facts, phase, data);
        if (parseError) block.facts.append(el('p', 'warning', `Structured answer unreadable: ${parseError}`));

        setEmotion(entry, data?.emotion, data?.emotionIntensity);
        entry.status.textContent = `${PERSONA_PHASE_TITLES[phase] || phase} — done`;
    },

    'persona.error'({ personaId, message }) {
        const entry = cards.get(personaId);
        if (entry) {
            entry.status.textContent = `Dropped out: ${message}`;
            entry.card.classList.add('failed');
        }
        addEventLog('persona error', `${personaId}: ${message}`);
    },

    'capture.completed'(data) {
        renderCapture(data);
        addEventLog('capture', `${data.title || data.url} (HTTP ${data.status})`);
    },

    'usage.updated'(usage) {
        const line = sessionSummary.querySelector('.usage');
        if (line) {
            line.textContent = `${usage.calls} model calls · ${usage.totalTokens.toLocaleString()} tokens `
                + `(${usage.promptTokens.toLocaleString()} in / ${usage.completionTokens.toLocaleString()} out)`;
        }
    },

    'session.completed'() {
        renderPhaseSteps('done');
        for (const entry of cards.values()) {
            if (!entry.card.classList.contains('failed')) entry.status.textContent = 'Finished';
        }
        addEventLog('session', 'Completed');
        closeStream();
    },

    'session.error'(data) {
        sessionSummary.append(el('p', 'warning', data.message || 'Session error'));
        addEventLog('error', data.message || 'Session error');
        closeStream();
    },
};

function closeStream() {
    eventSource?.close();
    eventSource = null;
}

sessionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    closeStream();

    const url = document.getElementById('url-input').value;
    const scenario = document.getElementById('scenario-input').value;
    const device = document.getElementById('device-input').value;
    const acceptCookies = document.getElementById('accept-cookies-input').checked;

    const response = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, scenario, device, acceptCookies, selectedPersonaIds }),
    });

    const payload = await response.json();
    if (!response.ok) {
        sessionSummary.innerHTML = '';
        sessionSummary.append(el('p', 'warning', payload.error || 'Could not start session.'));
        return;
    }

    // The server replays every event on (re)connect, starting with session.started, which resets the view.
    eventSource = new EventSource(`/api/sessions/${payload.sessionId}/stream`);
    for (const [name, handler] of Object.entries(handlers)) {
        eventSource.addEventListener(name, (message) => handler(JSON.parse(message.data)));
    }
});

loadPersonas().catch((error) => {
    console.error('Failed to load personas', error);
    sessionSummary.innerHTML = '<p>Unable to load personas.</p>';
});
