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
    ['experience', 'Browsing'],
    ['reflection', 'Reflection'],
    ['done', 'Done'],
];

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

const ACTION_ICONS = {
    click: '👆',
    type: '⌨️',
    scroll: '📜',
    back: '↩️',
    done: '🏁',
    leave: '🚪',
};

let selectedPersonaIds = [];
let personasById = new Map();
let eventSource = null;

// Session state, rebuilt from the event stream.
let cards = new Map(); // personaId -> card entry
let captures = new Map(); // "personaId:step" -> capture payload
let latestCaptureKey = null; // what the screenshot panel follows by default
let pinnedCaptureKey = null; // set by clicking a thumbnail
let shownCaptureKey = null;

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

function personaName(personaId) {
    return personasById.get(personaId)?.name || personaId;
}

function addEventLog(label, message) {
    const item = document.createElement('li');
    item.append(el('small', null, label), el('div', null, message));
    eventList.prepend(item);
}

const captureKey = (personaId, step) => `${personaId}:${step}`;

// Turns "the search bar [e4]" or "sizes [e19, e20]" into text with chips that highlight
// those elements on that capture's screenshot.
function proseWithElementRefs(text, key) {
    const fragment = document.createDocumentFragment();
    for (const part of (text || '').split(/(\[e\d+(?:\s*,\s*e\d+)*\])/)) {
        if (!/^\[e\d+/.test(part)) {
            fragment.append(part);
            continue;
        }
        part.match(/e\d+/g).forEach((id, index) => {
            if (index) fragment.append(' ');
            fragment.append(elementChip(id, key));
        });
    }
    return fragment;
}

function elementChip(elementId, key) {
    const chip = el('button', 'element-chip', elementId);
    chip.type = 'button';
    const element = captures.get(key)?.elements.find((item) => item.id === elementId);
    chip.title = element ? `${element.role}${element.name ? ` "${element.name}"` : ''}` : 'Unknown element';

    const show = () => {
        showCapture(key);
        highlightElement(elementId);
    };
    const hide = () => {
        clearHighlight();
        showCapture(pinnedCaptureKey || latestCaptureKey);
    };
    chip.addEventListener('mouseenter', show);
    chip.addEventListener('focus', show);
    chip.addEventListener('mouseleave', hide);
    chip.addEventListener('blur', hide);
    return chip;
}

// ---------- session view ----------

function resetView(data) {
    cards = new Map();
    captures = new Map();
    latestCaptureKey = null;
    pinnedCaptureKey = null;
    shownCaptureKey = null;

    eventList.innerHTML = '';
    personaFeed.innerHTML = '';
    captureView.innerHTML = '';
    captureView.append(el('p', 'empty-note', 'Screenshots appear here as the personas browse.'));
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

        cards.set(id, { card, badge, status, phases, blocks: new Map(), lastCaptureKey: null });
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

function showCapture(key) {
    const data = key && captures.get(key);
    if (!data || key === shownCaptureKey) return;
    shownCaptureKey = key;
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
        el('span', 'capture-owner', `${personaName(data.personaId)} · screen ${data.step}`),
        el('strong', null, data.title || data.url),
        el('small', null, `${data.device} · ${data.url}`),
    );

    const consent = data.cookieConsent;
    if (consent?.accepted) {
        caption.append(el('small', null, `🍪 Cookie banner accepted automatically ("${consent.label}")`));
    } else if (consent?.error) {
        caption.append(el('p', 'warning', `Could not accept the cookie banner: ${consent.error}`));
    }
    if (data.blockedReason) caption.append(el('p', 'warning', data.blockedReason));

    if (pinnedCaptureKey === key) {
        const follow = el('button', 'link-button', '📌 Pinned — follow live instead');
        follow.type = 'button';
        follow.addEventListener('click', () => {
            pinnedCaptureKey = null;
            showCapture(latestCaptureKey);
        });
        caption.append(follow);
    }

    captureView.append(frame, caption);
}

function highlightElement(elementId) {
    const data = captures.get(shownCaptureKey);
    const element = data?.elements.find((item) => item.id === elementId);
    const frame = captureView.querySelector('.capture-frame');
    if (!element || !frame) return;

    const image = frame.querySelector('img');
    const highlight = frame.querySelector('.element-highlight');
    const scale = image.clientWidth / data.viewport.width;

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

function blockTitle(phase, step) {
    if (phase === 'goal') return 'Goal';
    if (phase === 'reflection') return 'Looking back';
    return `Screen ${step}`;
}

function phaseBlock(entry, phase, step) {
    const key = step ? `${phase}:${step}` : phase;
    if (!entry.blocks.has(key)) {
        const block = el('section', 'phase-block');
        const heading = el('div', 'phase-heading');
        heading.append(el('h4', null, blockTitle(phase, step)));
        const prose = el('p', 'prose');
        const facts = el('div', 'facts');
        block.append(heading, prose, facts);
        entry.phases.append(block);
        entry.blocks.set(key, { block, heading, prose, facts });
    }
    return entry.blocks.get(key);
}

function renderFacts(facts, phase, data, key) {
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
            if (/^e\d+$/.test(observation.elementId || '')) item.append(elementChip(observation.elementId, key), ' ');
            item.append(observation.note || '');
            list.append(item);
        }
        facts.append(list);

        const next = data.nextAction;
        if (next?.type) {
            const line = el('p', 'fact-line', `${ACTION_ICONS[next.type] || '➡️'} Wants to ${next.type} `);
            if (/^e\d+$/.test(next.elementId || '')) line.append(elementChip(next.elementId, key));
            if (next.text) line.append(` "${next.text}"`);
            if (next.reason) line.append(` — ${next.reason}`);
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

    'persona.capture'(data) {
        const entry = cards.get(data.personaId);
        if (!entry) return;

        const key = captureKey(data.personaId, data.step);
        captures.set(key, data);
        entry.lastCaptureKey = key;
        latestCaptureKey = key;

        const { heading } = phaseBlock(entry, 'experience', data.step);
        const thumb = el('img', 'thumb');
        thumb.src = data.screenshotUrl;
        thumb.alt = `Screen ${data.step}: ${data.title || data.url}`;
        thumb.title = 'Show this screen';
        thumb.addEventListener('click', () => {
            pinnedCaptureKey = key;
            shownCaptureKey = null; // re-render to show the pin note
            showCapture(key);
        });
        heading.append(el('small', 'phase-url', data.title || data.url), thumb);

        if (!pinnedCaptureKey) showCapture(key);
        addEventLog('capture', `${personaName(data.personaId)} · screen ${data.step}: ${data.title || data.url}`);
    },

    'persona.phase.started'({ personaId, phase, step }) {
        const entry = cards.get(personaId);
        if (!entry) return;
        entry.status.textContent = `${blockTitle(phase, step)} — thinking aloud…`;
        phaseBlock(entry, phase, step).prose.classList.add('streaming');
    },

    'persona.delta'({ personaId, phase, step, text }) {
        const entry = cards.get(personaId);
        if (!entry) return;
        phaseBlock(entry, phase, step).prose.textContent += text;
    },

    'persona.phase.completed'({ personaId, phase, step, prose, data, parseError }) {
        const entry = cards.get(personaId);
        if (!entry) return;

        const key = step ? captureKey(personaId, step) : entry.lastCaptureKey;
        const block = phaseBlock(entry, phase, step);
        block.prose.classList.remove('streaming');
        block.prose.textContent = '';
        block.prose.append(proseWithElementRefs(prose, key));
        renderFacts(block.facts, phase, data, key);
        if (parseError) block.facts.append(el('p', 'warning', `Structured answer unreadable: ${parseError}`));

        setEmotion(entry, data?.emotion, data?.emotionIntensity);
        entry.status.textContent = `${blockTitle(phase, step)} — done`;
    },

    'persona.action'({ personaId, step, action, outcome }) {
        const entry = cards.get(personaId);
        if (!entry) return;

        const line = el('p', `action-line${outcome.ok ? '' : ' failed'}`);
        line.append(`${outcome.ok ? (ACTION_ICONS[action.type] || '✅') : '⚠️'} `, proseWithElementRefs(outcome.description, captureKey(personaId, step)));
        phaseBlock(entry, 'experience', step).facts.append(line);
    },

    'persona.error'({ personaId, message }) {
        const entry = cards.get(personaId);
        if (entry) {
            entry.status.textContent = `Dropped out: ${message}`;
            entry.card.classList.add('failed');
        }
        addEventLog('persona error', `${personaName(personaId)}: ${message}`);
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
    const maxSteps = Number(document.getElementById('max-steps-input').value);
    const acceptCookies = document.getElementById('accept-cookies-input').checked;

    const response = await fetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, scenario, device, maxSteps, acceptCookies, selectedPersonaIds }),
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
