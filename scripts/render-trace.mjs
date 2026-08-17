#!/usr/bin/env node

// C15 render performance trace tool (no screen content persisted).
//
// Frames are approximated at pty-write granularity: pi-tui issues one
// terminal.write per TUI frame; node-pty usually delivers each write as one
// onData chunk.  Classification marks each write as fullRedraw / shift / rowDiff.
//
// Usage:
//   node scripts/render-trace.mjs record --cmd "node" --args "dist/index.js" \
//     --cols 100 --rows 30 --duration 60 --label mylabel \
//     [--script path.json] [--raw-out tmp/x.ansi] [--cwd dir] [--env K=V ...]
//
// Script JSON: [{ "at": ms, "input": "text with \\e escapes", "resize": [cols, rows] }]
// Output: tmp/c15/<label>.metrics.json  (aggregates only; raw stream only via --raw-out → tmp/)

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import process from "node:process";
import { spawn } from "@homebridge/node-pty-prebuilt-multiarch";
import headlessXterm from "@xterm/headless";

const { Terminal } = headlessXterm;

function parseArgs(argv) {
  const out = { env: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "record") out.mode = "record";
    else if (a === "--cmd") out.cmd = argv[++i];
    else if (a === "--args") out.args = argv[++i].split(" ").filter(Boolean);
    else if (a === "--cols") out.cols = Number(argv[++i]);
    else if (a === "--rows") out.rows = Number(argv[++i]);
    else if (a === "--duration") out.duration = Number(argv[++i]);
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--script") out.script = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--raw-out") out.rawOut = argv[++i];
    else if (a === "--env") {
      const [k, ...v] = argv[++i].split("=");
      out.env[k] = v.join("=");
    } else throw new Error(`unknown arg ${a}`);
  }
  if (out.mode !== "record") throw new Error("only record mode is supported");
  if (!out.cmd || !out.label) throw new Error("--cmd and --label are required");
  out.cols ??= 100;
  out.rows ??= 30;
  out.duration ??= 30;
  out.args ??= [];
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const RE_ROW_UPDATE = /\u001b\[(\d+);1H\u001b\[2K/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const RE_CUP = /\u001b\[(?:\d*;)?\d*H/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const RE_CLEAR = /\u001b\[(?:\d*J|2K)/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const RE_SGR = /\u001b\[\d*m/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const RE_SCROLL_REGION = /\u001b\[\d+(?:;\d+)?r/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control sequences are the protocol being parsed.
const RE_SU_SD = /\u001b\[\d*[ST]/gu;
const FULL_REDRAW = "\u001b[2J";

function decodeEscapes(s) {
  return s
    .replace(/\\e/g, "\u001b")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

function countMatches(s, re) {
  const clone = new RegExp(re.source, re.flags);
  let n = 0;
  while (clone.exec(s)) n += 1;
  return n;
}

function snapshotViewport(term, rows) {
  const buf = term.buffer.active;
  const lines = [];
  for (let r = 0; r < rows; r += 1) lines.push(buf.getLine(r)?.translateToString(true) ?? "");
  return lines;
}

function diffRows(before, after) {
  let changed = 0;
  for (let r = 0; r < Math.max(before.length, after.length); r += 1) if (before[r] !== after[r]) changed += 1;
  return changed;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const script =
    opts.script && existsSync(opts.script)
      ? JSON.parse(readFileSync(opts.script, "utf8")).map((s) => ({
          ...s,
          input: s.input ? decodeEscapes(s.input) : undefined,
        }))
      : [];

  const term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: 5000, allowProposedApi: true });
  const pty = spawn(opts.cmd, opts.args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env },
  });

  const hr0 = process.hrtime.bigint();
  const nowMs = () => Number(process.hrtime.bigint() - hr0) / 1e6;

  const frames = [];
  let lastViewport = snapshotViewport(term, opts.rows);
  let rawFd = null;
  if (opts.rawOut) {
    const dir = opts.rawOut.slice(0, opts.rawOut.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    rawFd = openSync(opts.rawOut, "w");
  }

  pty.onData((data) => {
    const t = nowMs();
    if (rawFd) {
      try {
        writeSync(rawFd, data);
      } catch {
        /* closed */
      }
    }
    const before = lastViewport;
    term.write(data);
    const after = snapshotViewport(term, term.rows);
    const rowUpdates = countMatches(data, RE_ROW_UPDATE);
    const scrollRegion = countMatches(data, RE_SCROLL_REGION);
    const suSd = countMatches(data, RE_SU_SD);
    frames.push({
      t,
      bytes: Buffer.byteLength(data, "utf8"),
      changedRows: diffRows(before, after),
      rowUpdates,
      cup: countMatches(data, RE_CUP),
      clear: countMatches(data, RE_CLEAR),
      sgr: countMatches(data, RE_SGR),
      scrollRegion,
      suSd,
      kind: data.includes(FULL_REDRAW)
        ? "fullRedraw"
        : scrollRegion > 0 && suSd > 0
          ? "shift"
          : rowUpdates > 0
            ? "rowDiff"
            : "other",
    });
    lastViewport = snapshotViewport(term, term.rows);
  });

  const cpuSamples = [];
  let childPid = pty.pid;
  const sampleCpu = () => {
    try {
      const stat = readFileSync(`/proc/${childPid}/stat`, "utf8").split(" ");
      cpuSamples.push({ t: nowMs(), utime: Number(stat[13]), stime: Number(stat[14]) });
    } catch {
      /* exited */
    }
  };

  // schedule scripted inputs
  for (const step of script) {
    const delay = Number(step.at) - nowMs();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (step.input !== undefined) pty.write(step.input);
    if (step.resize) {
      pty.resize(step.resize[0], step.resize[1]);
      term.resize(step.resize[0], step.resize[1]);
      lastViewport = snapshotViewport(term, term.rows);
    }
  }

  const cpuTimer = setInterval(sampleCpu, 500);
  await new Promise((r) => setTimeout(r, Math.max(0, opts.duration * 1000 - nowMs())));
  clearInterval(cpuTimer);
  try {
    pty.kill();
  } catch {}
  childPid = -1;
  await new Promise((r) => setTimeout(r, 200));
  if (rawFd) {
    try {
      closeSync(rawFd);
    } catch {}
    rawFd = null;
  }

  const gaps = [];
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].t - frames[i - 1].t);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const byKind = {};
  for (const f of frames) {
    let k = byKind[f.kind];
    if (!k) k = byKind[f.kind] = { count: 0, bytes: 0, rows: 0 };
    k.count += 1;
    k.bytes += f.bytes;
    k.rows += f.changedRows;
  }
  const windows = new Map();
  for (const f of frames) {
    const w = Math.floor(f.t / 1000);
    const cur = windows.get(w) ?? { frames: 0, bytes: 0, rows: 0, rowUpdates: 0 };
    cur.frames += 1;
    cur.bytes += f.bytes;
    cur.rows += f.changedRows;
    cur.rowUpdates += f.rowUpdates;
    windows.set(w, cur);
  }
  const windowList = [...windows.entries()].map(([sec, v]) => ({ sec, ...v })).sort((a, b) => a.sec - b.sec);
  const cpu = [];
  for (let i = 1; i < cpuSamples.length; i += 1) {
    const dt = (cpuSamples[i].t - cpuSamples[i - 1].t) / 1000;
    const ticks = cpuSamples[i].utime + cpuSamples[i].stime - cpuSamples[i - 1].utime - cpuSamples[i - 1].stime;
    if (dt > 0) cpu.push({ t: Math.round(cpuSamples[i].t), percent: +((ticks / 100 / dt) * 100).toFixed(1) });
  }
  const bytesSorted = frames.map((f) => f.bytes).sort((a, b) => a - b);
  const rowsSorted = frames.map((f) => f.changedRows).sort((a, b) => a - b);

  const summary = {
    frames: frames.length,
    frameBytes: frames.reduce((s, f) => s + f.bytes, 0),
    changedRowsTotal: frames.reduce((s, f) => s + f.changedRows, 0),
    rowUpdatesTotal: frames.reduce((s, f) => s + f.rowUpdates, 0),
    byKind,
    gapMs: { p50: percentile(sortedGaps, 50), p95: percentile(sortedGaps, 95), max: sortedGaps.at(-1) ?? 0 },
    frameBytesP95: percentile(bytesSorted, 95),
    frameBytesMax: bytesSorted.at(-1) ?? 0,
    changedRowsP95: percentile(rowsSorted, 95),
    changedRowsMax: rowsSorted.at(-1) ?? 0,
    maxFramesPer1s: Math.max(0, ...windowList.map((w) => w.frames)),
    maxBytesPer1s: Math.max(0, ...windowList.map((w) => w.bytes)),
    maxRowsPer1s: Math.max(0, ...windowList.map((w) => w.rows)),
    cpuAvg: cpu.length ? +(cpu.reduce((s, c) => s + c.percent, 0) / cpu.length).toFixed(1) : 0,
    cpuMax: cpu.length ? Math.max(...cpu.map((c) => c.percent)) : 0,
  };
  const metrics = {
    label: opts.label,
    cmd: `${opts.cmd} ${opts.args.join(" ")}`.trim(),
    env: opts.env,
    cols: opts.cols,
    rows: opts.rows,
    startedAt: new Date().toISOString(),
    summary,
    frames: frames.map((f) => ({
      t: +f.t.toFixed(1),
      bytes: f.bytes,
      rows: f.changedRows,
      ru: f.rowUpdates,
      kind: f.kind,
    })),
    windows: windowList,
    cpu,
  };
  mkdirSync("tmp/c15", { recursive: true });
  const outPath = `tmp/c15/${opts.label}.metrics.json`;
  writeFileSync(outPath, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ outPath, summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
