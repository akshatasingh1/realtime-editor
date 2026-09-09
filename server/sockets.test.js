// Unit tests for the socket handlers. The DB is fully mocked and `io` / sockets
// are hand-rolled fakes, so this runs with no server and no network.
jest.mock('./db', () => ({
    isEnabled: jest.fn(() => false),
    init: jest.fn().mockResolvedValue(undefined),
    getRoom: jest.fn().mockResolvedValue(null),
    ensureRoom: jest.fn().mockResolvedValue(null),
    saveRoomContent: jest.fn().mockResolvedValue(undefined),
    setRoomLanguage: jest.fn().mockResolvedValue(undefined),
    recordExecution: jest.fn().mockResolvedValue(undefined),
    listExecutions: jest.fn().mockResolvedValue([]),
}));

const db = require('./db');
const ACTIONS = require('../src/Actions');
const { registerSocketHandlers } = require('./sockets');

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
    const connectionHandlers = [];
    const emits = []; // { to, event, payload }
    const roomsMap = new Map(); // roomId -> Set(socketId)

    const io = {
        on: (event, fn) => {
            if (event === 'connection') connectionHandlers.push(fn);
        },
        to: (target) => ({
            emit: (event, payload) => emits.push({ to: target, event, payload }),
        }),
        sockets: { adapter: { rooms: roomsMap } },
    };

    const api = registerSocketHandlers(io);

    function connect(id) {
        const handlers = {};
        const socket = {
            id,
            rooms: new Set(),
            on: (event, fn) => {
                handlers[event] = fn;
            },
            join: (roomId) => {
                socket.rooms.add(roomId);
                if (!roomsMap.has(roomId)) roomsMap.set(roomId, new Set());
                roomsMap.get(roomId).add(id);
            },
            in: (roomId) => ({
                emit: (event, payload) =>
                    emits.push({ to: `in:${roomId}`, event, payload }),
            }),
        };
        connectionHandlers.forEach((fn) => fn(socket));
        return { socket, handlers };
    }

    return { emits, connect, ...api };
}

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.ensureRoom.mockResolvedValue(null);
    db.saveRoomContent.mockResolvedValue(undefined);
    db.setRoomLanguage.mockResolvedValue(undefined);
});

describe('JOIN', () => {
    test('broadcasts presence before it awaits the database', async () => {
        db.ensureRoom.mockResolvedValue({ content: 'x', language_id: 71 });
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.JOIN]({ roomId: 'R', username: 'alice' }); // not awaited

        // Synchronous phase only: JOINED is out, DB-derived events are not.
        expect(h.emits.filter((e) => e.event === ACTIONS.JOINED)).toHaveLength(1);
        expect(h.emits.some((e) => e.event === ACTIONS.LANGUAGE_CHANGE)).toBe(false);

        await flushMicrotasks();
        expect(h.emits.some((e) => e.event === ACTIONS.LANGUAGE_CHANGE)).toBe(true);
    });

    test('first client in an empty room gets the persisted document', async () => {
        db.ensureRoom.mockResolvedValue({ content: 'saved code', language_id: 63 });
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.JOIN]({ roomId: 'R', username: 'alice' });
        await flushMicrotasks();

        expect(h.emits.some((e) => e.event === ACTIONS.SYNC_REQUEST)).toBe(false);
        const codeChange = h.emits.find((e) => e.event === ACTIONS.CODE_CHANGE);
        expect(codeChange.payload).toEqual({ code: 'saved code' });
    });

    test('into a populated room, asks exactly one peer for the document', async () => {
        db.ensureRoom.mockResolvedValue({ content: 'db copy', language_id: 63 });
        const h = harness();
        const alice = h.connect('a');
        const carol = h.connect('c');

        alice.handlers[ACTIONS.JOIN]({ roomId: 'R', username: 'alice' });
        carol.handlers[ACTIONS.JOIN]({ roomId: 'R', username: 'carol' });
        await flushMicrotasks();
        h.emits.length = 0;

        const bob = h.connect('b');
        bob.handlers[ACTIONS.JOIN]({ roomId: 'R', username: 'bob' });
        await flushMicrotasks();

        const syncRequests = h.emits.filter((e) => e.event === ACTIONS.SYNC_REQUEST);
        expect(syncRequests).toHaveLength(1);
        expect(syncRequests[0].to).toBe('a'); // peers[0]
        expect(syncRequests[0].payload).toEqual({ socketId: 'b' });
        // No stale DB copy pushed when a peer is answering.
        expect(
            h.emits.some(
                (e) => e.event === ACTIONS.CODE_CHANGE && e.payload.code === 'db copy'
            )
        ).toBe(false);
    });

    test('ignores a malformed JOIN payload', async () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.JOIN]({ roomId: 42, username: 'alice' });
        await flushMicrotasks();

        expect(h.emits).toHaveLength(0);
        expect(db.ensureRoom).not.toHaveBeenCalled();
    });
});

describe('SYNC_CODE relay', () => {
    test('forwards a peer document to the requesting socket', () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.SYNC_CODE]({ socketId: 'b', code: 'peer code' });

        expect(h.emits).toContainEqual({
            to: 'b',
            event: ACTIONS.CODE_CHANGE,
            payload: { code: 'peer code' },
        });
    });
});

describe('CODE_CHANGE', () => {
    test('relays to the room and schedules a debounced save', () => {
        jest.useFakeTimers();
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'R', code: 'hello' });

        expect(h.emits).toContainEqual({
            to: 'in:R',
            event: ACTIONS.CODE_CHANGE,
            payload: { code: 'hello' },
        });
        expect(db.saveRoomContent).not.toHaveBeenCalled();

        jest.advanceTimersByTime(2000);
        expect(db.saveRoomContent).toHaveBeenCalledWith('R', 'hello');
        jest.useRealTimers();
    });

    test('ignores malformed payloads', () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 123, code: 'x' });
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'R', code: null });

        expect(h.emits).toHaveLength(0);
        expect(db.saveRoomContent).not.toHaveBeenCalled();
    });
});

describe('LANGUAGE_CHANGE', () => {
    test('relays to the room and persists', () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.LANGUAGE_CHANGE]({ roomId: 'R', languageId: 71 });

        expect(h.emits).toContainEqual({
            to: 'in:R',
            event: ACTIONS.LANGUAGE_CHANGE,
            payload: { languageId: 71 },
        });
        expect(db.setRoomLanguage).toHaveBeenCalledWith('R', 71);
    });

    test('ignores a non-integer language id', () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.LANGUAGE_CHANGE]({ roomId: 'R', languageId: 'python' });

        expect(h.emits).toHaveLength(0);
        expect(db.setRoomLanguage).not.toHaveBeenCalled();
    });
});

describe('flushPendingSaves', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('writes the latest code per room and cancels the debounce', async () => {
        const h = harness();
        const alice = h.connect('a');

        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'A', code: 'v1' });
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'A', code: 'v2' });
        alice.handlers[ACTIONS.CODE_CHANGE]({ roomId: 'B', code: 'b1' });
        expect(db.saveRoomContent).not.toHaveBeenCalled();

        const count = await h.flushPendingSaves();

        expect(count).toBe(2);
        expect(db.saveRoomContent).toHaveBeenCalledWith('A', 'v2');
        expect(db.saveRoomContent).toHaveBeenCalledWith('B', 'b1');
        expect(db.saveRoomContent).not.toHaveBeenCalledWith('A', 'v1');

        db.saveRoomContent.mockClear();
        jest.advanceTimersByTime(5000);
        expect(db.saveRoomContent).not.toHaveBeenCalled(); // no leaked timer
    });

    test('a second flush with nothing pending is a no-op', async () => {
        const h = harness();
        h.connect('a').handlers[ACTIONS.CODE_CHANGE]({ roomId: 'A', code: 'x' });

        await h.flushPendingSaves();
        db.saveRoomContent.mockClear();

        expect(await h.flushPendingSaves()).toBe(0);
        expect(db.saveRoomContent).not.toHaveBeenCalled();
    });
});
