const fs = require('fs');
const path = require('path');

const EMOTIONS = ['curious', 'confident', 'pleased', 'neutral', 'confused', 'skeptical', 'frustrated', 'anxious'];

const cache = new Map();

function loadTemplate(name) {
    if (!cache.has(name)) {
        cache.set(name, fs.readFileSync(path.join(__dirname, `${name}.md`), 'utf8'));
    }
    return cache.get(name);
}

// Fills {{placeholders}}; a missing variable is a bug in the caller, so fail loudly.
function renderPrompt(name, variables = {}) {
    const values = { emotions: EMOTIONS.join(' | '), ...variables };

    return loadTemplate(name).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!(key in values)) {
            throw new Error(`Prompt "${name}" needs a value for {{${key}}}.`);
        }
        return String(values[key]);
    });
}

function list(items) {
    return items?.length ? items.join(', ') : 'none';
}

function describePersona(persona) {
    const d = persona.demographics || {};
    const lit = persona.digitalLiteracy || {};
    const emo = persona.emotionalTendencies || {};
    const browse = persona.browsingBehavior || {};
    const comm = persona.communicationStyle || {};

    return [
        `- ${persona.name}, age ${d.ageRange || 'unknown'}, lives in ${d.location || 'unknown'}. ${persona.occupation || persona.role || ''}.`,
        `- Background: ${persona.background || 'not specified'}`,
        `- What you value: ${list(persona.values)}`,
        `- Digital skills: device familiarity ${lit.deviceFamiliarity || 'average'}, privacy awareness ${lit.privacyAwareness || 'average'}. ${lit.notes || ''}`,
        `- Accessibility needs: ${list(persona.accessibility?.needs)}. ${persona.accessibility?.notes || ''}`,
        `- Temperament: baseline mood ${emo.baseline || 'neutral'}; reactivity ${emo.reactivity ?? 3}/5, patience ${emo.patience ?? 3}/5, trust threshold ${emo.trustThreshold ?? 3}/5 (higher = harder to win your trust).`,
        `- Things that frustrate you: ${list(persona.frustrations)}`,
        `- Browsing: prefers ${browse.preferredDevice || 'any device'}, moves ${browse.speed || 'at a normal pace'}; you leave when you hit: ${list(browse.abandonTriggers)}`,
        `- How you talk: ${comm.dominant || 'plain'}, talkativeness ${comm.talkativeness ?? 3}/5. ${persona.llm?.styleNotes || ''}`,
    ].join('\n');
}

module.exports = { EMOTIONS, renderPrompt, describePersona };
