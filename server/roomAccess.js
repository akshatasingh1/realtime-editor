const crypto = require('crypto');

// token -> { roomId }. In-memory: a token is only valid while its issuing
// socket session is alive (revoked on disconnect). Single-instance only, like
// the rest of the room state.
const tokens = new Map();

function issue(roomId) {
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { roomId });
    return token;
}

function revoke(token) {
    if (token) tokens.delete(token);
}

function isValid(token, roomId) {
    if (typeof token !== 'string' || typeof roomId !== 'string') return false;
    const entry = tokens.get(token);
    return !!entry && entry.roomId === roomId;
}

// test-only helper
function _clear() {
    tokens.clear();
}

module.exports = { issue, revoke, isValid, _clear };
