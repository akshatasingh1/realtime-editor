// Server-side test lane. The client lane is `npm test` (react-scripts / CRA
// Jest, scoped to src/). This config only sees server/ and test/, so the two
// never collide.
module.exports = {
    testEnvironment: 'node',
    testMatch: [
        '<rootDir>/server/**/*.test.js',
        '<rootDir>/test/**/*.test.js',
    ],
    clearMocks: true,
    // The suite mocks the DB and Judge0; nothing here should touch the network.
    testTimeout: 10000,
    // socket.io keeps internal timers alive briefly after close(); don't hang CI.
    forceExit: true,
};
