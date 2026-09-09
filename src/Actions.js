const ACTIONS = {
    JOIN: 'join',
    JOINED: 'joined',
    DISCONNECTED: 'disconnected',
    CODE_CHANGE: 'code-change',
    SYNC_CODE: 'sync-code',
    SYNC_REQUEST: 'sync-request',
    LANGUAGE_CHANGE: 'language-change',
    LEAVE: 'leave',

    // Lockable rooms / admit flow
    HOST: 'host', // server -> client: you are the host { hostToken }
    ROOM_ACCESS: 'room-access', // server -> client on entry { token, locked, isHost }
    ROOM_LOCK_STATE: 'room-lock-state', // server -> room { locked }
    LOCK_ROOM: 'lock-room', // host -> server { roomId }
    UNLOCK_ROOM: 'unlock-room', // host -> server { roomId }
    WAITING: 'waiting', // server -> joiner: you're in the lobby { roomId }
    KNOCK: 'knock', // server -> host: someone wants in { socketId, username }
    PENDING: 'pending', // server -> host: full lobby list { pending: [{socketId, username}] }
    ADMIT: 'admit', // host -> server { roomId, socketId }
    DENY: 'deny', // host -> server { roomId, socketId }
    ADMITTED: 'admitted', // server -> joiner: you're in { roomId }
    DENIED: 'denied', // server -> joiner: turned away { reason }
};

module.exports = ACTIONS;
