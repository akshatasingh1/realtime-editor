const roomAccess = require('./roomAccess');

beforeEach(() => roomAccess._clear());

test('issue returns a token that validates for its room only', () => {
    const token = roomAccess.issue('room-1');

    expect(roomAccess.isValid(token, 'room-1')).toBe(true);
    expect(roomAccess.isValid(token, 'room-2')).toBe(false);
});

test('tokens are unique per issue', () => {
    expect(roomAccess.issue('r')).not.toBe(roomAccess.issue('r'));
});

test('revoke invalidates a token', () => {
    const token = roomAccess.issue('room-1');
    roomAccess.revoke(token);
    expect(roomAccess.isValid(token, 'room-1')).toBe(false);
});

test('isValid rejects missing / non-string input', () => {
    expect(roomAccess.isValid(undefined, 'room-1')).toBe(false);
    expect(roomAccess.isValid('nope', 'room-1')).toBe(false);
    expect(roomAccess.isValid(roomAccess.issue('r'), undefined)).toBe(false);
});
