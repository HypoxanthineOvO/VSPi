import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'vsp-runtime',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
