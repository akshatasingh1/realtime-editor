const express = require('express');
const db = require('./db');
const judge0 = require('./judge0');

const router = express.Router();

// Proxy code execution through the server so the Judge0 key never reaches the
// browser, and persist each run against its room.
router.post('/execute', async (req, res) => {
    const { language_id, source_code, stdin = '', roomId } = req.body || {};

    if (!Number.isInteger(language_id) || typeof source_code !== 'string') {
        return res.status(400).json({
            error: 'language_id (int) and source_code (string) are required.',
        });
    }

    const result = await judge0.execute({ language_id, source_code, stdin });

    if (result.error) {
        return res
            .status(result.status || 502)
            .json({ error: result.error });
    }

    if (roomId) {
        try {
            await db.ensureRoom(roomId, language_id);
            await db.recordExecution(roomId, language_id, result);
        } catch (err) {
            // A failed history write must not fail the run itself.
            console.error('recordExecution failed:', err.message);
        }
    }

    res.json(result);
});

router.get('/rooms/:id', async (req, res) => {
    try {
        const room = await db.getRoom(req.params.id);
        if (!room) return res.status(404).json({ error: 'Room not found.' });
        res.json(room);
    } catch (err) {
        console.error('getRoom failed:', err.message);
        res.status(500).json({ error: 'Failed to load room.' });
    }
});

router.get('/rooms/:id/executions', async (req, res) => {
    try {
        const rows = await db.listExecutions(req.params.id, 20);
        res.json(rows);
    } catch (err) {
        console.error('listExecutions failed:', err.message);
        res.status(500).json({ error: 'Failed to load run history.' });
    }
});

module.exports = router;
