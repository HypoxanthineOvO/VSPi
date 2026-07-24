import type { TerminalCapabilities } from "../src/ui/capabilities.js";
import { createTheme } from "../src/ui/theme.js";

export function capabilities(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    colorLevel: 0,
    truecolor: false,
    unicode: true,
    reducedMotion: true,
    ssh: false,
    ...overrides,
  };
}

export function plainTheme(overrides: Partial<TerminalCapabilities> = {}) {
  return createTheme(capabilities(overrides));
}

export interface SgrCell {
  character: string;
  modifiers: ReadonlySet<number>;
  foreground: string | undefined;
  background: string | undefined;
}

interface MutableSgrState {
  modifiers: Set<number>;
  foreground: string | undefined;
  background: string | undefined;
}

function applySgr(params: number[], state: MutableSgrState): void {
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index] ?? 0;
    if (code === 0) {
      state.modifiers.clear();
      state.foreground = undefined;
      state.background = undefined;
    } else if (code === 1 || code === 4 || code === 7) {
      state.modifiers.add(code);
    } else if (code === 22) {
      state.modifiers.delete(1);
    } else if (code === 24) {
      state.modifiers.delete(4);
    } else if (code === 27) {
      state.modifiers.delete(7);
    } else if (code === 39) {
      state.foreground = undefined;
    } else if (code === 49) {
      state.background = undefined;
    } else if ((code === 38 || code === 48) && params[index + 1] === 2) {
      const color = `rgb(${params[index + 2]},${params[index + 3]},${params[index + 4]})`;
      if (code === 38) state.foreground = color;
      else state.background = color;
      index += 4;
    } else if ((code === 38 || code === 48) && params[index + 1] === 5) {
      const color = `ansi256(${params[index + 2]})`;
      if (code === 38) state.foreground = color;
      else state.background = color;
      index += 2;
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      state.foreground = `ansi(${code})`;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      state.background = `ansi(${code})`;
    }
  }
}

export function sgrCells(rendered: string): SgrCell[] {
  const state: MutableSgrState = { modifiers: new Set(), foreground: undefined, background: undefined };
  const cells: SgrCell[] = [];
  for (let index = 0; index < rendered.length; ) {
    if (rendered.charCodeAt(index) === 27) {
      const introducer = rendered[index + 1];
      if (introducer === "[") {
        let end = index + 2;
        while (end < rendered.length && !/[@-~]/.test(rendered[end] ?? "")) end += 1;
        if (rendered[end] === "m") {
          const params = rendered
            .slice(index + 2, end)
            .split(";")
            .map((value) => Number(value || 0));
          applySgr(params, state);
        }
        index = Math.min(rendered.length, end + 1);
        continue;
      }
      if (introducer === "]" || introducer === "_") {
        index += 2;
        while (index < rendered.length) {
          if (rendered.charCodeAt(index) === 7) {
            index += 1;
            break;
          }
          if (rendered.charCodeAt(index) === 27 && rendered[index + 1] === "\\") {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 2;
      continue;
    }

    const codePoint = rendered.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    cells.push({
      character,
      modifiers: new Set(state.modifiers),
      foreground: state.foreground,
      background: state.background,
    });
    index += character.length;
  }
  return cells;
}

export function cellsForText(rendered: string, target: string, occurrence = 0): SgrCell[] {
  const cells = sgrCells(rendered);
  const targetCells = Array.from(target);
  let seen = 0;
  for (let start = 0; start <= cells.length - targetCells.length; start += 1) {
    if (!targetCells.every((character, offset) => cells[start + offset]?.character === character)) continue;
    if (seen === occurrence) return cells.slice(start, start + targetCells.length);
    seen += 1;
  }
  return [];
}

export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nkwAAAAASUVORK5CYII=",
  "base64",
);
