import { tsImport } from 'tsx/esm/api';
import { register } from 'node:module';

register('./dev-hooks.mjs', import.meta.url);
await tsImport('./entry.ts', import.meta.url);
