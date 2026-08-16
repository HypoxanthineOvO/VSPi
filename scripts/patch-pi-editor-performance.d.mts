export const PI_TUI_PACKAGE: string;
export const PI_TUI_VERSION: string;
export const EDITOR_RELATIVE_PATH: string;
export const PATCH_MARKER: string;

export interface EditorPatchPlan {
  root: string;
  editorPath: string;
  source: string;
  patched: string;
  changed: boolean;
}

export function patchEditorSource(source: string): string;
export function prepareEditorPackage(root: string): Promise<EditorPatchPlan>;
export function patchEditorPackage(root: string): Promise<EditorPatchPlan>;
export function resolvePiTuiRoots(): Promise<string[]>;
export function main(): Promise<void>;
