import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const appRoot = import.meta.dirname;

const main = defineConfig({
  entry: ['./src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  hash: false,
  banner: { js: '#!/usr/bin/env node' },
  plugins: [rawTextPlugin()],
  deps: {
    onlyBundle: false,
    alwaysBundle: [
      /^@vsp\//,
      /^@moonshot-ai\//,
      /^@jimp\//,
      /^@modelcontextprotocol\//,
      'ajv',
      'ajv-formats',
      'chalk',
      'fast-querystring',
      'fastify',
      'grok-mermaid',
      'highlight.js',
      'jimp',
      'marked',
      'smol-toml',
      'xstate',
      'yaml',
    ],
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.mjs',
  },
});

function worker(name: string, entry: string) {
  return defineConfig({
    entry: { [name]: resolve(appRoot, entry) },
    format: ['esm'],
    outDir: 'dist',
    clean: false,
    dts: false,
    hash: false,
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    minify: false,
    silent: true,
    deps: {
      alwaysBundle: [/^@moonshot-ai\//],
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: '[name].mjs',
    },
  });
}

export default [
  main,
  worker('text-build-worker', '../../packages/minidb/src/worker/text-build-worker.ts'),
  worker('search-worker', '../../packages/kap-server/src/search/worker/entry.ts'),
];
