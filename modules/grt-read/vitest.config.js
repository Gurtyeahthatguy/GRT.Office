import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // The sources import the vendored copy, which only exists after `npm
      // run vendor` and is a browser-oriented bundle.
      { find: /^\.\.\/vendor\/pdf-lib\.esm\.js$/, replacement: 'pdf-lib' },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
