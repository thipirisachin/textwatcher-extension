import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals:     true,
    setupFiles:  ['./tests/unit/setup.js'],
    include:     ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include:  ['src/shared/**', 'src/background/**'],
      exclude:  ['src/content/**', 'src/popup/**', 'src/options/**'],
    },
  },
});
