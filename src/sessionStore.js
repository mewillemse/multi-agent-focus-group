const sessions = new Map();

function createSession(session) {
    sessions.set(session.id, {
        ...session,
        listeners: new Set(),
        events: session.events || [],
    });

    return sessions.get(session.id);
}

function getSession(sessionId) {
    return sessions.get(sessionId);
}

function updateSession(sessionId, updates) {
    const session = sessions.get(sessionId);
    if (!session) return null;

    const next = { ...session, ...updates };
    sessions.set(sessionId, next);
    return next;
}

module.exports = {
    createSession,
    getSession,
    updateSession,
    sessions,
};
