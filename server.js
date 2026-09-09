require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const db = require('./server/db');
const apiRoutes = require('./server/routes');
const { registerSocketHandlers } = require('./server/sockets');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '256kb' }));
app.use(express.static('build'));
app.use('/api', apiRoutes);

// SPA fallback - GET only, so it never swallows the API routes above.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

registerSocketHandlers(io);

const PORT = process.env.PORT || 5000;

// Start listening regardless of DB state - persistence is optional.
db.init()
    .catch((err) => console.error('Database init failed:', err.message))
    .finally(() => {
        server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
    });
