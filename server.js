require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const db = require('./server/db');
const apiRoutes = require('./server/routes');
const { registerSocketHandlers } = require('./server/sockets');

const app = express();
const server = http.createServer(app);

// In production the server serves its own client (same origin). CORS matters
// only in dev, where CRA runs on :3000 and this server on :5000.
const io = new Server(server, { cors: { origin: true } });

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static('build'));
app.use('/api', apiRoutes);

// SPA fallback - GET only, so it never swallows the API routes above.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

const { flushPendingSaves } = registerSocketHandlers(io);

const PORT = process.env.PORT || 5000;

// Start listening regardless of DB state - persistence is optional.
db.init()
    .catch((err) => console.error('Database init failed:', err.message))
    .finally(() => {
        server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
    });

// On redeploy/restart, write out any debounced-but-unsaved room edits before
// exiting so we don't lose the last couple of seconds of everyone's work.
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down...`);

    io.close(); // stop accepting connections / new events

    try {
        const flushed = await flushPendingSaves();
        if (flushed) console.log(`Flushed ${flushed} pending room save(s).`);
    } catch (err) {
        console.error('Flush on shutdown failed:', err.message);
    }

    if (db.isEnabled()) {
        await db.pool.end().catch(() => {});
    }

    server.close(() => process.exit(0));
    // Don't hang forever if a socket won't close.
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
