import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    include: ['tests/**/*.test.js'],
    // Fuzzers kept in tests/tmp run on demand, one at a time.
    exclude: ['tests/tmp/**', 'node_modules/**'],
    // ids.js uses the platform crypto, which Node exposes globally from 19
    // on.
    globals: false,
  },
});
