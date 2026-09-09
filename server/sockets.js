const ACTIONS = require('../src/Actions');
const db = require('./db');

// Wait this long after the last keystroke before writing a room to Postgres,
// so a burst of edits becomes one write instead of hundreds.
const SAVE_DEBOUNCE_MS = 2000;

function registerSocketHandlers(io) {
    const userSocketMap = {};
    const saveTimers = {}; // roomId -> pending setTimeout

    function getAllConnectedClients(roomId) {
        return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
            (socketId) => ({
                socketId,
                username: userSocketMap[socketId],
            })
        );
    }

    function scheduleSave(roomId, code) {
        clearTimeout(saveTimers[roomId]);
        saveTimers[roomId] = setTimeout(() => {
            delete saveTimers[roomId];
            db.saveRoomContent(roomId, code).catch((err) =>
                console.error('saveRoomContent failed:', err.message)
            );
        }, SAVE_DEBOUNCE_MS);
    }

    // Best-effort: restore a room's persisted code to a single joiner. Never
    // blocks the join handshake - if Postgres is slow or down, the room just
    // starts empty and live peers still sync via SYNC_CODE.
    async function restorePersistedCode(roomId, socketId) {
        try {
            const room = await db.ensureRoom(roomId);
            if (room && room.content) {
                io.to(socketId).emit(ACTIONS.CODE_CHANGE, { code: room.content });
            }
        } catch (err) {
            console.error('room load on join failed:', err.message);
        }
    }

    io.on('connection', (socket) => {
        console.log('socket connected', socket.id);

        socket.on(ACTIONS.JOIN, ({ roomId, username }) => {
            if (typeof roomId !== 'string' || typeof username !== 'string') {
                return;
            }
            userSocketMap[socket.id] = username;
            socket.join(roomId);

            // Realtime handshake first - this path must not wait on the DB.
            const clients = getAllConnectedClients(roomId);
            clients.forEach(({ socketId }) => {
                io.to(socketId).emit(ACTIONS.JOINED, {
                    clients,
                    username,
                    socketId: socket.id,
                });
            });

            // Then hand the joiner whatever was persisted. Covers the
            // "everyone left" and "server restarted" cases that the
            // client-to-client SYNC_CODE handshake alone cannot.
            restorePersistedCode(roomId, socket.id);
        });

        socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
            if (typeof roomId !== 'string' || typeof code !== 'string') return;
            socket.in(roomId).emit(ACTIONS.CODE_CHANGE, { code });
            scheduleSave(roomId, code);
        });

        socket.on(ACTIONS.SYNC_CODE, ({ socketId, code }) => {
            io.to(socketId).emit(ACTIONS.CODE_CHANGE, { code });
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
}

module.exports = { registerSocketHandlers };
