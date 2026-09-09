const ACTIONS = require('../src/Actions');
const db = require('./db');

// Wait this long after the last keystroke before writing a room to Postgres,
// so a burst of edits becomes one write instead of hundreds.
const SAVE_DEBOUNCE_MS = 2000;

function registerSocketHandlers(io) {
    const userSocketMap = {};
    const pendingSaves = {}; // roomId -> { code, timer }

    function getAllConnectedClients(roomId) {
        return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
            (socketId) => ({
                socketId,
                username: userSocketMap[socketId],
            })
        );
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

    // Write every debounced-but-not-yet-saved room immediately. Called on
    // shutdown so a redeploy doesn't drop the last few seconds of edits.
    async function flushPendingSaves() {
        const entries = Object.entries(pendingSaves);
        for (const [roomId, { timer }] of entries) {
            clearTimeout(timer);
            delete pendingSaves[roomId];
        }
        await Promise.allSettled(
            entries.map(([roomId, { code }]) =>
                db.saveRoomContent(roomId, code)
            )
        );
        return entries.length;
    }

    io.on('connection', (socket) => {
        console.log('socket connected', socket.id);

        socket.on(ACTIONS.JOIN, async ({ roomId, username }) => {
            if (typeof roomId !== 'string' || typeof username !== 'string') {
                return;
            }
            userSocketMap[socket.id] = username;

            // Peers already in the room *before* this socket joined. One of
            // them holds the freshest document (including edits not yet
            // debounce-saved), so it - not the DB - is the sync source when
            // the room is already populated.
            const peers = getAllConnectedClients(roomId);
            socket.join(roomId);

            // Presence broadcast - never behind an await.
            const clients = getAllConnectedClients(roomId);
            clients.forEach(({ socketId }) => {
                io.to(socketId).emit(ACTIONS.JOINED, {
                    clients,
                    username,
                    socketId: socket.id,
                });
            });

            // Code: ask exactly one peer for the live document. Falls through
            // to the DB restore below only when this is the first client in.
            if (peers.length > 0) {
                io.to(peers[0].socketId).emit(ACTIONS.SYNC_REQUEST, {
                    socketId: socket.id,
                });
            }

            // Room row + persisted metadata (best-effort, may lag). Ordered
            // after the realtime handshake so a slow/absent DB never blocks it.
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
            const rooms = [...socket.rooms];
            rooms.forEach((roomId) => {
                socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
                    socketId: socket.id,
                    username: userSocketMap[socket.id],
                });
            });
            delete userSocketMap[socket.id];
        });
    });

    return { flushPendingSaves };
}

module.exports = { registerSocketHandlers };
