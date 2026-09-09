// Keep rate limits out of the way here; the limiter itself is covered in
// test/execute-rate-limit.test.js (separate file => separate module registry,
// so it can load routes.js with a low limit).
process.env.EXECUTE_RATE_PER_MIN = '100000';
process.env.EXECUTE_RATE_GLOBAL_PER_HOUR = '100000';

jest.mock('../server/db', () => ({
    ensureRoom: jest.fn(),
    recordExecution: jest.fn(),
    getRoom: jest.fn(),
    listExecutions: jest.fn(),
}));
jest.mock('../server/judge0', () => ({ execute: jest.fn() }));

const request = require('supertest');
const express = require('express');
const db = require('../server/db');
const judge0 = require('../server/judge0');
const routes = require('../server/routes');

function makeApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api', routes);
    return app;
}

let app;
beforeEach(() => {
    app = makeApp();
    db.ensureRoom.mockResolvedValue({ id: 'r', language_id: 63 });
    db.recordExecution.mockResolvedValue(undefined);
    db.getRoom.mockResolvedValue(null);
    db.listExecutions.mockResolvedValue([]);
    judge0.execute.mockResolvedValue({
        stdout: 'ok\n',
        status: { description: 'Accepted' },
    });
});

describe('POST /api/execute', () => {
    test('400 on a malformed body, without calling Judge0', async () => {
        await request(app).post('/api/execute').send({}).expect(400);
        await request(app)
            .post('/api/execute')
            .send({ language_id: '63', source_code: 'x' })
            .expect(400);
        expect(judge0.execute).not.toHaveBeenCalled();
    });

    test('runs code and records the execution when roomId is given', async () => {
        const res = await request(app)
            .post('/api/execute')
            .send({ language_id: 63, source_code: 'print(1)', roomId: 'room-1' })
            .expect(200);

        expect(res.body.stdout).toBe('ok\n');
        expect(judge0.execute).toHaveBeenCalledWith({
            language_id: 63,
            source_code: 'print(1)',
            stdin: '',
        });
        expect(db.ensureRoom).toHaveBeenCalledWith('room-1', 63);
        expect(db.recordExecution).toHaveBeenCalledWith(
            'room-1',
            63,
            expect.objectContaining({ stdout: 'ok\n' })
        );
    });

    test('does not touch the DB when no roomId is given', async () => {
        await request(app)
            .post('/api/execute')
            .send({ language_id: 63, source_code: 'x' })
            .expect(200);
        expect(db.recordExecution).not.toHaveBeenCalled();
    });

    test('propagates a Judge0 failure status and message', async () => {
        judge0.execute.mockResolvedValue({
            error: 'Code execution is rate-limited right now.',
            status: 429,
        });
        const res = await request(app)
            .post('/api/execute')
            .send({ language_id: 63, source_code: 'x' })
            .expect(429);
        expect(res.body.error).toMatch(/rate-limited/i);
    });

    test('a failed history write does not fail the run', async () => {
        db.recordExecution.mockRejectedValue(new Error('db down'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await request(app)
            .post('/api/execute')
            .send({ language_id: 63, source_code: 'x', roomId: 'r' })
            .expect(200);
    });
});

describe('GET /api/rooms/:id', () => {
    test('404 when the room does not exist', async () => {
        await request(app).get('/api/rooms/nope').expect(404);
    });

    test('returns the room row when it exists', async () => {
        db.getRoom.mockResolvedValue({ id: 'r1', language_id: 71, content: 'x' });
        const res = await request(app).get('/api/rooms/r1').expect(200);
        expect(res.body).toMatchObject({ id: 'r1', language_id: 71 });
    });
});

describe('GET /api/rooms/:id/executions', () => {
    test('returns the list from the DB', async () => {
        db.listExecutions.mockResolvedValue([{ id: '1', status: 'Accepted' }]);
        const res = await request(app).get('/api/rooms/r1/executions').expect(200);
        expect(res.body).toEqual([{ id: '1', status: 'Accepted' }]);
        expect(db.listExecutions).toHaveBeenCalledWith('r1', 20);
    });
});
