// Loaded in its own file so routes.js picks up a small per-IP limit at import.
process.env.EXECUTE_RATE_PER_MIN = '3';
process.env.EXECUTE_RATE_GLOBAL_PER_HOUR = '100000';

jest.mock('../server/db', () => ({
    ensureRoom: jest.fn().mockResolvedValue({ id: 'r', language_id: 63 }),
    recordExecution: jest.fn().mockResolvedValue(undefined),
    getRoom: jest.fn(),
    listExecutions: jest.fn(),
}));
jest.mock('../server/judge0', () => ({
    execute: jest.fn().mockResolvedValue({
        stdout: 'ok\n',
        status: { description: 'Accepted' },
    }),
}));

const request = require('supertest');
const express = require('express');
const routes = require('../server/routes');

test('POST /api/execute returns 429 once the per-IP limit is exceeded', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api', routes);

    const body = { language_id: 63, source_code: 'x' };

    for (let i = 0; i < 3; i++) {
        await request(app).post('/api/execute').send(body).expect(200);
    }

    const limited = await request(app).post('/api/execute').send(body).expect(429);
    expect(limited.body.error).toMatch(/too many/i);
});
