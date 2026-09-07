import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'vspi',
    include: ['test/**/*.test.ts'],
  },
});
