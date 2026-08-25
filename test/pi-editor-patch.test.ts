import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  PATCH_MARKER,
  PI_TUI_PACKAGE,
  patchEditorSource,
  prepareEditorPackage,
  resolvePiTuiRoots,
} from "../scripts/patch-pi-editor-performance.mjs";

/** Runtime-public Editor methods that the 0.84.3 declarations mark private. */
interface EditorTestAccess {
  moveToLineEnd(): void;
  handlePaste(text: string): void;
  isOnFirstVisualLine(): boolean;
}

function fakeTui(rows = 60): ConstructorParameters<typeof Editor>[0] {
  return {
    terminal: { rows },
    requestRender() {},
  } as never;
}

function fakeTheme(): ConstructorParameters<typeof Editor>[1] {
  return {
    borderColor: (value: string) => value,
    selectList: {
      selectedPrefix: (value: string) => value,
      selectedText: (value: string) => value,
      description: (value: string) => value,
      scrollInfo: (value: string) => value,
      noMatch: (value: string) => value,
    },
  } as never;
}

function testAccess(editor: Editor): EditorTestAccess {
  return editor as unknown as EditorTestAccess;
}

async function installedEditorSource(): Promise<string> {
  const roots = await resolvePiTuiRoots();
  const root = roots[0];
  if (!root) throw new Error("no pi-tui installation found");
  return readFile(join(root, "dist/components/editor.js"), "utf8");
}

function stripPatch(source: string): string {
  const markerIndex = source.indexOf(PATCH_MARKER);
  if (markerIndex < 0) return source;
  const mapIndex = source.indexOf("//# sourceMappingURL=editor.js.map", markerIndex);
  return `${source.slice(0, markerIndex)}${source.slice(mapIndex)}`;
}

describe("pi editor performance patch source guard", () => {
  it("applies exactly once and is idempotent", async () => {
    const source = stripPatch(await installedEditorSource());
    expect(source).not.toContain(PATCH_MARKER);
    const once = patchEditorSource(source);
    expect(once).toContain(PATCH_MARKER);
    expect(once).not.toBe(source);
    expect(patchEditorSource(once)).toBe(once);
  });

  it("fails closed when the source no longer matches the 0.84.3 contract", async () => {
    const source = stripPatch(await installedEditorSource());
    expect(() =>
      patchEditorSource(
        source.replace("    moveCursor(deltaLine, deltaCol) {", "    moveCursor(deltaLine, deltaCol, extra) {"),
      ),
    ).toThrow(/source guard/);
    expect(() =>
      patchEditorSource(source.replace("export class Editor {", "export class Editor {\nexport class Editor {")),
    ).toThrow(/source guard/);
    expect(() => patchEditorSource(`${source}\nexport class Editor {`)).toThrow(/source guard/);
  });

  it("refuses to patch an unexpected pi-tui version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vspi-pi-editor-guard-"));
    const root = join(dir, "node_modules", "@earendil-works", "pi-tui");
    await mkdir(join(root, "dist", "components"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: PI_TUI_PACKAGE, version: "0.84.1" }));
    const source = await installedEditorSource();
    await writeFile(join(root, "dist/components/editor.js"), source);
    await expect(prepareEditorPackage(root)).rejects.toThrow(/expected 0\.84\.3/);
  });
});

describe("installed pi editor performance patch", () => {
  it("is applied to the editor used by the runtime", async () => {
    const roots = await resolvePiTuiRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      const source = await readFile(join(root, "dist/components/editor.js"), "utf8");
      expect(source).toContain(PATCH_MARKER);
      expect(source).toContain("vspiEditorPerformanceMoveHorizontal");
    }
  });

  it("moves by grapheme for combining characters and ZWJ emoji", () => {
    const editor = new Editor(fakeTui(), fakeTheme(), { paddingX: 1 });
    editor.handleInput("e\u0301");
    editor.handleInput("\x1b[D");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
    editor.handleInput("\x1b[C");
    expect(editor.getCursor()).toEqual({ line: 0, col: 2 });

    editor.setText("👨‍👩‍👧");
    testAccess(editor).moveToLineEnd();
    expect(editor.getCursor()).toEqual({ line: 0, col: 8 });
    editor.handleInput("\x1b[D");
    expect(editor.getCursor()).toEqual({ line: 0, col: 0 });
  });

  it("keeps paste markers atomic while moving and deleting", () => {
    const editor = new Editor(fakeTui(), fakeTheme(), { paddingX: 1 });
    const pasted = "x".repeat(1_200);
    testAccess(editor).handlePaste(pasted);
    expect(editor.getExpandedText()).toBe(pasted);
    expect(editor.getText()).toContain("[paste #1");
    const end = editor.getCursor().col;
    expect(end).toBeGreaterThan(0);
    editor.handleInput("\x1b[D");
    expect(editor.getCursor().col).toBe(0);
    testAccess(editor).moveToLineEnd();
    editor.handleInput("\x7f");
    expect(editor.getText()).toBe("");
    expect(editor.getExpandedText()).toBe("");
  });

  it("still supports vertical navigation on wrapped long lines", () => {
    const editor = new Editor(fakeTui(), fakeTheme(), { paddingX: 1 });
    editor.setText(`word ${"x".repeat(240)} tail`);
    testAccess(editor).moveToLineEnd();
    expect(testAccess(editor).isOnFirstVisualLine()).toBe(false);
    expect(editor.render(40).length).toBeGreaterThan(2);
    for (let index = 0; index < 12; index += 1) {
      editor.handleInput("\x1b[A");
    }
    expect(testAccess(editor).isOnFirstVisualLine()).toBe(true);
    expect(editor.getCursor().line).toBe(0);
  });

  it("keeps horizontal cursor movement on a 10K line far below the upstream O(N) baseline", () => {
    const editor = new Editor(fakeTui(), fakeTheme(), { paddingX: 1 });
    const text = `${"abcdefghij".repeat(1_000)} tail`;
    editor.setText(text);
    testAccess(editor).moveToLineEnd();
    const start = performance.now();
    for (let index = 0; index < 120; index += 1) {
      editor.handleInput("\x1b[D");
      editor.render(120);
    }
    const elapsedMs = performance.now() - start;
    expect(editor.getCursor().col).toBe(text.length - 120);
    // Upstream 0.84.3 takes ~1.5s for the same 120 moves + redraws; the cache
    // prototype measured ~7ms. 500ms leaves ample CI headroom while still
    // catching a regression to the uncached path.
    expect(elapsedMs).toBeLessThan(500);
  });
});
