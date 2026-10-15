import { build as bundle } from "esbuild";
import { build as vite } from "vite";
await vite({
  root: process.cwd(),
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
});
await bundle({
  entryPoints: {
    main: "src/main/main.ts",
    preload: "src/preload.ts",
    "askpass-client": "src/main/askpass-client.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "info",
});
