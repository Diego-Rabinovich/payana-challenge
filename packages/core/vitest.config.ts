import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Business timezone. Without this, date tests pass or fail depending on
    // the machine that runs them.
    env: { TZ: 'America/Bogota' },
  },
});
