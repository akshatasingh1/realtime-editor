const crypto = require('crypto');
const ACTIONS = require('../src/Actions');
const db = require('./db');
const roomAccess = require('./roomAccess');

// Wait this long after the last keystroke before writing a room to Postgres,
// so a burst of edits becomes one write instead of hundreds.
const SAVE_DEBOUNCE_MS = 2000;

const randomToken = () => crypto.randomBytes(24).toString('hex');

function registerSocketHandlers(io) {
    const userSocketMap = {}; // socketId -> username
    const pendingSaves = {}; // roomId -> { code, timer }
    const socketTokens = {}; // socketId -> room access token (for revoke)

    // roomId -> { hostId, hostToken, locked, waiting: Map<socketId, {username}> }
    // In-memory and session-scoped: cleared when the room empties.
    const rooms = {};

    function roomStateFor(roomId) {
        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: null,
                hostToken: null,
                locked: false,
                waiting: new Map(),
            };
        }
        return rooms[roomId];
    }

    function memberIds(roomId) {
        return Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    }

    function clientList(roomId) {
        return memberIds(roomId).map((socketId) => ({
            socketId,
            username: userSocketMap[socketId],
        }));
    }

    function sendPending(roomId) {
        const state = rooms[roomId];
        if (!state || !state.hostId) return;
        io.to(state.hostId).emit(ACTIONS.PENDING, {
            pending: Array.from(state.waiting, ([socketId, w]) => ({
                socketId,
                username: w.username,
            })),
        });
    }

    function scheduleSave(roomId, code) {
        if (pendingSaves[roomId]) clearTimeout(pendingSaves[roomId].timer);
        pendingSaves[roomId] = {
            code,
            timer: setTimeout(() => {
                delete pendingSaves[roomId];
                db.saveRoomContent(roomId, code).catch((err) =>
                    console.error('saveRoomContent failed:', err.message)
                );
            }, SAVE_DEBOUNCE_MS),
        };
    }

    async function flushPendingSaves() {
        const entries = Object.entries(pendingSaves);
        for (const [roomId, { timer }] of entries) {
            clearTimeout(timer);
            delete pendingSaves[roomId];
        }
        await Promise.allSettled(
            entries.map(([roomId, { code }]) => db.saveRoomContent(roomId, code))
        );
        return entries.length;
    }

    // Bring a socket fully into the room: join, issue a REST access token,
    // assign host if needed, broadcast presence, sync code + language.
    async function enterRoom(socket, roomId, username, { asHost }) {
        const state = roomStateFor(roomId);
        userSocketMap[socket.id] = username;

        const peers = clientList(roomId); // captured before this socket joins
        socket.join(roomId);

        const token = roomAccess.issue(roomId);
        socketTokens[socket.id] = token;

        if (asHost || !state.hostId) {
            state.hostId = socket.id;
            if (!state.hostToken) state.hostToken = randomToken();
            io.to(socket.id).emit(ACTIONS.HOST, { hostToken: state.hostToken });
        }

        io.to(socket.id).emit(ACTIONS.ROOM_ACCESS, {
            token,
            locked: state.locked,
            isHost: state.hostId === socket.id,
        });

        const clients = clientList(roomId);
        clients.forEach(({ socketId }) => {
            io.to(socketId).emit(ACTIONS.JOINED, {
                clients,
                username,
                socketId: socket.id,
            });
        });

        if (peers.length > 0) {
            io.to(peers[0].socketId).emit(ACTIONS.SYNC_REQUEST, {
                socketId: socket.id,
            });
        }

        try {
            const room = await db.ensureRoom(roomId);
            if (room) {
                if (peers.length === 0 && room.content) {
                    io.to(socket.id).emit(ACTIONS.CODE_CHANGE, {
                        code: room.content,
                    });
                }
                io.to(socket.id).emit(ACTIONS.LANGUAGE_CHANGE, {
                    languageId: room.language_id,
                });
            }
        } catch (err) {
            console.error('room load on join failed:', err.message);
        }

        if (state.hostId === socket.id) sendPending(roomId);
    }

    function admitFromLobby(roomId, socketId) {
        const state = rooms[roomId];
        if (!state) return;
        const waiter = state.waiting.get(socketId);
        if (!waiter) return;
        state.waiting.delete(socketId);
        const target = io.sockets.sockets.get(socketId);
        if (target) {
            io.to(socketId).emit(ACTIONS.ADMITTED, { roomId });
            enterRoom(target, roomId, waiter.username, { asHost: false });
        }
    }

    io.on('connection', (socket) => {
        console.log('socket connected', socket.id);

        socket.on(ACTIONS.JOIN, async ({ roomId, username, hostToken }) => {
            if (typeof roomId !== 'string' || typeof username !== 'string') {
                return;
            }

            const state = roomStateFor(roomId);
            const others = memberIds(roomId).filter((id) => id !== socket.id);
            const returningHost =
                typeof hostToken === 'string' && hostToken === state.hostToken;

            // Empty room: reset the lock; whoever walks in hosts.
            if (others.length === 0) {
                state.locked = false;
                await enterRoom(socket, roomId, username, { asHost: true });
                return;
            }

            if (!state.locked || returningHost) {
                await enterRoom(socket, roomId, username, {
                    asHost: returningHost,
                });
                return;
            }

            // Locked, and not the returning host: go to the lobby.
            state.waiting.set(socket.id, { username });
            io.to(socket.id).emit(ACTIONS.WAITING, { roomId });
            if (state.hostId) {
                io.to(state.hostId).emit(ACTIONS.KNOCK, {
                    socketId: socket.id,
                    username,
                });
                sendPending(roomId);
            }
        });

        socket.on(ACTIONS.LOCK_ROOM, ({ roomId }) => {
            const state = rooms[roomId];
            if (!state || state.hostId !== socket.id) return;
            state.locked = true;
            io.in(roomId).emit(ACTIONS.ROOM_LOCK_STATE, { locked: true });
        });

        socket.on(ACTIONS.UNLOCK_ROOM, ({ roomId }) => {
            const state = rooms[roomId];
            if (!state || state.hostId !== socket.id) return;
            state.locked = false;
            io.in(roomId).emit(ACTIONS.ROOM_LOCK_STATE, { locked: false });
            for (const socketId of [...state.waiting.keys()]) {
                admitFromLobby(roomId, socketId);
            }
            sendPending(roomId);
        });

        socket.on(ACTIONS.ADMIT, ({ roomId, socketId }) => {
            const state = rooms[roomId];
            if (!state || state.hostId !== socket.id) return;
            admitFromLobby(roomId, socketId);
            sendPending(roomId);
        });

        socket.on(ACTIONS.DENY, ({ roomId, socketId }) => {
            const state = rooms[roomId];
            if (!state || state.hostId !== socket.id) return;
            if (state.waiting.delete(socketId)) {
                io.to(socketId).emit(ACTIONS.DENIED, { reason: 'denied' });
            }
            sendPending(roomId);
        });

        // A peer answering a SYNC_REQUEST: relay its document to the joiner.
        socket.on(ACTIONS.SYNC_CODE, ({ socketId, code }) => {
            if (typeof code !== 'string') return;
            io.to(socketId).emit(ACTIONS.CODE_CHANGE, { code });
        });

        socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
            if (typeof roomId !== 'string' || typeof code !== 'string') return;
            socket.in(roomId).emit(ACTIONS.CODE_CHANGE, { code });
            scheduleSave(roomId, code);
        });

        socket.on(ACTIONS.LANGUAGE_CHANGE, ({ roomId, languageId }) => {
            if (typeof roomId !== 'string' || !Number.isInteger(languageId)) {
                return;
            }
            socket.in(roomId).emit(ACTIONS.LANGUAGE_CHANGE, { languageId });
            db.setRoomLanguage(roomId, languageId).catch((err) =>
                console.error('setRoomLanguage failed:', err.message)
            );
        });

        socket.on('disconnecting', () => {
            roomAccess.revoke(socketTokens[socket.id]);
            delete socketTokens[socket.id];

            // Drop from any lobby it was waiting in.
            for (const roomId of Object.keys(rooms)) {
                if (rooms[roomId].waiting.delete(socket.id)) sendPending(roomId);
            }

            const joined = [...socket.rooms].filter((r) => r !== socket.id);
            joined.forEach((roomId) => {
                socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
                    socketId: socket.id,
                    username: userSocketMap[socket.id],
                });

                const state = rooms[roomId];
                if (!state) return;

                if (state.hostId === socket.id) {
                    const remaining = memberIds(roomId).filter(
                        (id) => id !== socket.id
                    );
                    if (remaining.length > 0) {
                        state.hostId = remaining[0];
                        state.hostToken = randomToken();
                        io.to(state.hostId).emit(ACTIONS.HOST, {
                            hostToken: state.hostToken,
                        });
                        io.to(state.hostId).emit(ACTIONS.ROOM_ACCESS, {
                            token: socketTokens[state.hostId],
                            locked: state.locked,
                            isHost: true,
                        });
                        sendPending(roomId);
                    } else {
                        // Host gone, nobody left to run the room.
                        for (const wid of state.waiting.keys()) {
                            io.to(wid).emit(ACTIONS.DENIED, {
                                reason: 'host-left',
                            });
                        }
                        delete rooms[roomId];
                    }
                } else if (memberIds(roomId).filter((id) => id !== socket.id).length === 0) {
                    delete rooms[roomId];
                }
            });

            delete userSocketMap[socket.id];
        });
    });

    return { flushPendingSaves };
}

module.exports = { registerSocketHandlers };
