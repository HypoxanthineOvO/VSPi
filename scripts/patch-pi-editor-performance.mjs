import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PI_TUI_PACKAGE = "@earendil-works/pi-tui";
export const PI_TUI_VERSION = "0.84.3";
export const EDITOR_RELATIVE_PATH = "dist/components/editor.js";
export const PATCH_MARKER = "/* vspi-pi-editor-performance-patch:0.84.3 */";

const SOURCE_MAP_MARKER = "//# sourceMappingURL=editor.js.map";
const SOURCE_ANCHORS = [
  ["Editor export", "export class Editor {", 1],
  ["layoutText", "    layoutText(contentWidth) {", 1],
  ["buildVisualLineMap", "    buildVisualLineMap(width) {", 1],
  ["moveCursor", "    moveCursor(deltaLine, deltaCol) {", 1],
  ["grapheme movement", 'const graphemes = [...this.segment(beforeCursor, "grapheme")];', 2],
  ["layout wrapping", 'const chunks = wordWrapLine(line, contentWidth, [...this.segment(line, "grapheme")]);', 1],
  ["cursor-map wrapping", 'const chunks = wordWrapLine(line, width, [...this.segment(line, "grapheme")]);', 1],
];

const PERFORMANCE_PATCH = String.raw`
${PATCH_MARKER}
// Cache only editor-local derived data. The official Editor remains the owner of
// input, IME, autocomplete, undo, paste markers, and vertical cursor semantics.
const vspiEditorPerformanceOriginalSegment = Editor.prototype.segment;
const vspiEditorPerformanceCaches = new WeakMap();

function vspiEditorPerformanceCacheFor(editor) {
    let cache = vspiEditorPerformanceCaches.get(editor);
    if (!cache) {
        cache = { segments: new Map(), wraps: new Map() };
        vspiEditorPerformanceCaches.set(editor, cache);
    }
    return cache;
}

function vspiEditorPerformancePasteSignature(editor) {
    return String(editor.pasteCounter) + ":" + [...editor.pastes.keys()].join(",");
}

function vspiEditorPerformanceSegments(editor, text, mode) {
    const cache = vspiEditorPerformanceCacheFor(editor);
    const key = [mode, vspiEditorPerformancePasteSignature(editor), text].join("\u0000");
    if (cache.segments.has(key)) {
        return cache.segments.get(key);
    }
    const segments = [...vspiEditorPerformanceOriginalSegment.call(editor, text, mode)];
    cache.segments.set(key, segments);
    if (cache.segments.size > 512) {
        cache.segments.delete(cache.segments.keys().next().value);
    }
    return segments;
}

function vspiEditorPerformanceWrap(editor, line, width) {
    const cache = vspiEditorPerformanceCacheFor(editor);
    const key = [width, vspiEditorPerformancePasteSignature(editor), line].join("\u0000");
    if (cache.wraps.has(key)) {
        return cache.wraps.get(key);
    }
    const chunks = wordWrapLine(line, width, vspiEditorPerformanceSegments(editor, line, "grapheme"));
    cache.wraps.set(key, chunks);
    if (cache.wraps.size > 256) {
        cache.wraps.delete(cache.wraps.keys().next().value);
    }
    return chunks;
}

function vspiEditorPerformanceLayoutText(contentWidth) {
    const layoutLines = [];
    if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
        layoutLines.push({
            text: "",
            hasCursor: true,
            cursorPos: 0,
        });
        return layoutLines;
    }
    for (let i = 0; i < this.state.lines.length; i++) {
        const line = this.state.lines[i] || "";
        const isCurrentLine = i === this.state.cursorLine;
        const lineVisibleWidth = visibleWidth(line);
        if (lineVisibleWidth <= contentWidth) {
            layoutLines.push({
                text: line,
                hasCursor: isCurrentLine,
                ...(isCurrentLine ? { cursorPos: this.state.cursorCol } : {}),
            });
            continue;
        }
        const chunks = vspiEditorPerformanceWrap(this, line, contentWidth);
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            if (!chunk)
                continue;
            const cursorPos = this.state.cursorCol;
            const isLastChunk = chunkIndex === chunks.length - 1;
            let hasCursorInChunk = false;
            let adjustedCursorPos = 0;
            if (isCurrentLine) {
                if (isLastChunk) {
                    hasCursorInChunk = cursorPos >= chunk.startIndex;
                    adjustedCursorPos = cursorPos - chunk.startIndex;
                }
                else {
                    hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
                    if (hasCursorInChunk) {
                        adjustedCursorPos = Math.min(cursorPos - chunk.startIndex, chunk.text.length);
                    }
                }
            }
            layoutLines.push({
                text: chunk.text,
                hasCursor: hasCursorInChunk,
                ...(hasCursorInChunk ? { cursorPos: adjustedCursorPos } : {}),
            });
        }
    }
    return layoutLines;
}

function vspiEditorPerformanceBuildVisualLineMap(width) {
    const visualLines = [];
    for (let i = 0; i < this.state.lines.length; i++) {
        const line = this.state.lines[i] || "";
        const lineVisWidth = visibleWidth(line);
        if (line.length === 0) {
            visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
        }
        else if (lineVisWidth <= width) {
            visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
        }
        else {
            const chunks = vspiEditorPerformanceWrap(this, line, width);
            for (const chunk of chunks) {
                visualLines.push({
                    logicalLine: i,
                    startCol: chunk.startIndex,
                    length: chunk.endIndex - chunk.startIndex,
                });
            }
        }
    }
    return visualLines;
}

function vspiEditorPerformanceCurrentVisualSegment(editor, line, col) {
    const width = Math.max(1, editor.lastWidth);
    const chunks = vspiEditorPerformanceWrap(editor, line, width);
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isLast = i === chunks.length - 1;
        if (chunk && col >= chunk.startIndex && (col < chunk.endIndex || (isLast && col === chunk.endIndex))) {
            return chunk;
        }
    }
    return chunks[chunks.length - 1];
}

function vspiEditorPerformanceMoveHorizontal(editor, deltaCol) {
    editor.lastAction = null;
    const currentLine = editor.state.lines[editor.state.cursorLine] || "";
    const segments = vspiEditorPerformanceSegments(editor, currentLine, "grapheme");
    if (deltaCol > 0) {
        if (editor.state.cursorCol < currentLine.length) {
            let nextCol = currentLine.length;
            for (const segment of segments) {
                const end = segment.index + segment.segment.length;
                if (editor.state.cursorCol < end) {
                    nextCol = end;
                    break;
                }
            }
            editor.setCursorCol(nextCol);
        }
        else if (editor.state.cursorLine < editor.state.lines.length - 1) {
            editor.state.cursorLine++;
            editor.setCursorCol(0);
        }
        else {
            const currentSegment = vspiEditorPerformanceCurrentVisualSegment(editor, currentLine, editor.state.cursorCol);
            if (currentSegment) {
                editor.preferredVisualCol = editor.state.cursorCol - currentSegment.startIndex;
            }
        }
    }
    else if (deltaCol < 0) {
        if (editor.state.cursorCol > 0) {
            let previousCol = 0;
            for (const segment of segments) {
                if (editor.state.cursorCol <= segment.index) {
                    break;
                }
                previousCol = segment.index;
                if (editor.state.cursorCol <= segment.index + segment.segment.length) {
                    break;
                }
            }
            editor.setCursorCol(previousCol);
        }
        else if (editor.state.cursorLine > 0) {
            editor.state.cursorLine--;
            const previousLine = editor.state.lines[editor.state.cursorLine] || "";
            editor.setCursorCol(previousLine.length);
        }
    }
}

Editor.prototype.segment = function(text, mode) {
    return vspiEditorPerformanceSegments(this, text, mode);
};
Editor.prototype.layoutText = vspiEditorPerformanceLayoutText;
Editor.prototype.buildVisualLineMap = vspiEditorPerformanceBuildVisualLineMap;
Editor.prototype.moveCursor = function(deltaLine, deltaCol) {
    if (deltaLine === 0) {
        vspiEditorPerformanceMoveHorizontal(this, deltaCol);
        return;
    }
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    const targetVisualLine = currentVisualLine + deltaLine;
    if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
        this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
    }
};
`;

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function assertSourceStructure(source) {
  for (const [label, anchor, expectedCount] of SOURCE_ANCHORS) {
    const count = countOccurrences(source, anchor);
    if (count !== expectedCount) {
      throw new Error(
        `Refusing to patch Pi Editor: ${label} source guard matched ${count} times (expected ${expectedCount})`,
      );
    }
  }
  if (countOccurrences(source, SOURCE_MAP_MARKER) !== 1) {
    throw new Error("Refusing to patch Pi Editor: editor.js source-map guard did not match exactly once");
  }
}

export function patchEditorSource(source) {
  const markerCount = countOccurrences(source, PATCH_MARKER);
  if (markerCount > 1) {
    throw new Error(`Refusing to patch Pi Editor: patch marker matched ${markerCount} times`);
  }
  if (markerCount === 1) {
    for (const sentinel of ["vspiEditorPerformanceSegments", "vspiEditorPerformanceMoveHorizontal"]) {
      if (!source.includes(sentinel)) {
        throw new Error(`Refusing to accept malformed Pi Editor patch: missing ${sentinel}`);
      }
    }
    return source;
  }

  assertSourceStructure(source);
  const sourceMapOffset = source.lastIndexOf(SOURCE_MAP_MARKER);
  if (sourceMapOffset < 0) {
    throw new Error("Refusing to patch Pi Editor: source-map marker is missing");
  }
  return `${source.slice(0, sourceMapOffset)}${PERFORMANCE_PATCH}\n${source.slice(sourceMapOffset)}`;
}

async function resolvePackagePath(specifier) {
  if (typeof import.meta.resolve === "function") {
    try {
      return fileURLToPath(import.meta.resolve(specifier));
    } catch {
      // Fall through to the filesystem walk below (e.g. vitest transforms).
    }
  }
  const segments = specifier.split("/");
  const candidates = [];
  let cursor = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parse(cursor).root;
  while (cursor !== filesystemRoot) {
    candidates.push(join(cursor, "node_modules", ...segments));
    cursor = dirname(cursor);
  }
  cursor = process.cwd?.() ?? filesystemRoot;
  while (cursor !== filesystemRoot) {
    candidates.push(join(cursor, "node_modules", ...segments));
    cursor = dirname(cursor);
  }
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} for Pi Editor patch`);
}

async function packageRoot(specifier, expectedName) {
  let resolved;
  try {
    resolved = await resolvePackagePath(specifier);
  } catch (error) {
    throw new Error(`Cannot resolve ${expectedName} for Pi Editor patch`, { cause: error });
  }
  let cursor = resolved;
  if (!(await pathExists(join(cursor, "package.json")))) cursor = dirname(cursor);
  const filesystemRoot = parse(cursor).root;
  while (cursor !== filesystemRoot) {
    try {
      const manifest = JSON.parse(await readFile(join(cursor, "package.json"), "utf8"));
      if (manifest.name === expectedName) return { path: cursor, version: manifest.version };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
  throw new Error(`Cannot locate package root for ${expectedName}`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

export async function resolvePiTuiRoots() {
  const direct = await packageRoot(PI_TUI_PACKAGE, PI_TUI_PACKAGE);
  const agent = await packageRoot("@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent");
  const candidates = [direct.path, join(agent.path, "node_modules", "@earendil-works", "pi-tui")];
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!(await pathExists(join(candidate, "package.json")))) continue;
    const resolved = await realpath(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  if (roots.length === 0) {
    throw new Error("Cannot locate any physical @earendil-works/pi-tui installation");
  }
  return roots;
}

export async function prepareEditorPackage(root) {
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== PI_TUI_PACKAGE) {
    throw new Error(`Refusing to patch unexpected package at ${root}: ${manifest.name ?? "<unnamed>"}`);
  }
  if (manifest.version !== PI_TUI_VERSION) {
    throw new Error(`Refusing to patch ${PI_TUI_PACKAGE}: expected ${PI_TUI_VERSION}, found ${manifest.version}`);
  }
  const editorPath = join(root, EDITOR_RELATIVE_PATH);
  const source = await readFile(editorPath, "utf8");
  const patched = patchEditorSource(source);
  return { root, editorPath, source, patched, changed: patched !== source };
}

export async function patchEditorPackage(root) {
  const plan = await prepareEditorPackage(root);
  if (plan.changed) await writeFile(plan.editorPath, plan.patched, "utf8");
  return plan;
}

export async function main() {
  const roots = await resolvePiTuiRoots();
  // Prepare every copy before writing any copy: a bad sibling must fail closed.
  const plans = await Promise.all(roots.map((root) => prepareEditorPackage(root)));
  for (const plan of plans) {
    if (plan.changed) await writeFile(plan.editorPath, plan.patched, "utf8");
    console.log(`${plan.changed ? "Patched" : "Verified"} ${PI_TUI_PACKAGE} ${PI_TUI_VERSION}: ${plan.editorPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
