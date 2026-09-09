// `pg` is mocked so nothing hits a real database. db.js reads DATABASE_URL and
// keeps `enabled` as module state, so tests reset the registry per scenario.
const mockQuery = jest.fn();

jest.mock('pg', () => ({
    Pool: jest.fn(() => ({
        query: mockQuery,
        on: jest.fn(),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

describe('db without DATABASE_URL (persistence disabled)', () => {
    let db;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.DATABASE_URL;
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockQuery.mockReset();
        db = require('./db');
    });

    test('isEnabled() stays false, even after init()', async () => {
        expect(db.isEnabled()).toBe(false);
        await expect(db.init()).resolves.toBeUndefined();
        expect(db.isEnabled()).toBe(false);
    });

    test('reads return empty values and issue no query', async () => {
        await db.init();
        expect(await db.getRoom('x')).toBeNull();
        expect(await db.ensureRoom('x')).toBeNull();
        expect(await db.listExecutions('x')).toEqual([]);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('writes are silent no-ops', async () => {
        await db.init();
        await expect(db.saveRoomContent('x', 'code')).resolves.toBeUndefined();
        await expect(db.setRoomLanguage('x', 71)).resolves.toBeUndefined();
        await expect(db.recordExecution('x', 63, {})).resolves.toBeUndefined();
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('db.init() with DATABASE_URL', () => {
    afterAll(() => {
        delete process.env.DATABASE_URL;
    });

    test('applies schema.sql and enables persistence', async () => {
        jest.resetModules();
        process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/test';
        jest.spyOn(console, 'log').mockImplementation(() => {});
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [] });

        const db = require('./db');
        await db.init();

        expect(db.isEnabled()).toBe(true);
        expect(mockQuery).toHaveBeenCalledWith(
            expect.stringContaining('CREATE TABLE IF NOT EXISTS rooms')
        );
    });
});

describe('db queries with DATABASE_URL (mocked pg)', () => {
    let db;

    beforeEach(async () => {
        jest.resetModules();
        process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/test';
        jest.spyOn(console, 'log').mockImplementation(() => {});
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [] });
        db = require('./db');
        await db.init();
        mockQuery.mockClear();
    });

    afterAll(() => {
        delete process.env.DATABASE_URL;
    });

    test('ensureRoom upserts and returns the row', async () => {
        mockQuery.mockResolvedValueOnce({
            rows: [{ id: 'r1', language_id: 63 }],
        });

        const room = await db.ensureRoom('r1', 63);

        expect(room).toEqual({ id: 'r1', language_id: 63 });
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO rooms/i);
        expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
        expect(params).toEqual(['r1', 63]);
    });

    test('saveRoomContent updates content and preserves language when null', async () => {
        await db.saveRoomContent('r1', 'hello world');

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/UPDATE rooms/i);
        expect(sql).toMatch(/COALESCE/i);
        expect(params).toEqual(['r1', 'hello world', null]);
    });

    test('setRoomLanguage updates only the language', async () => {
        await db.setRoomLanguage('r1', 71);

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/SET language_id = \$2/i);
        expect(sql).not.toMatch(/content/i);
        expect(params).toEqual(['r1', 71]);
    });

    test('recordExecution flattens the Judge0 result into columns', async () => {
        await db.recordExecution('r1', 63, {
            stdout: 'out',
            stderr: null,
            status: { description: 'Accepted' },
        });

        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO executions/i);
        expect(params).toEqual(['r1', 63, 'out', null, null, 'Accepted']);
    });

    test('listExecutions returns rows, newest-first and limited', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [{ id: '2' }, { id: '1' }] });

        const rows = await db.listExecutions('r1', 20);

        expect(rows).toHaveLength(2);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/ORDER BY created_at DESC/i);
        expect(params).toEqual(['r1', 20]);
    });
});
