import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { DEEPSEEK_HARNESS_TOOLS } from "./official.js";

const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED_MESSAGE = "\n<response clipped>";

interface EditorInput {
  command: "view" | "create" | "str_replace" | "insert";
  path: string;
  file_text?: string;
  insert_line?: number;
  new_str?: string;
  old_str?: string;
  view_range?: number[];
}

const editorDefinition =
  DEEPSEEK_HARNESS_TOOLS.find((tool) => tool.name === "str_replace_editor") ?? missingEditorDefinition();

function missingEditorDefinition(): never {
  throw new Error("DeepSeek str_replace_editor fixture is missing");
}

export function createDeepSeekEditorToolDefinition(): ToolDefinition {
  return {
    name: editorDefinition.name,
    label: "str_replace_editor",
    description: editorDefinition.description,
    parameters: structuredClone(editorDefinition.parameters) as TSchema,
    async execute(_toolCallId, rawInput) {
      const input = rawInput as EditorInput;
      const text = await executeEditorCommand(input);
      return { content: [{ type: "text", text }], details: { command: input.command, path: input.path } };
    },
  };
}

async function executeEditorCommand(input: EditorInput): Promise<string> {
  assertAbsolutePath(input.path);
  switch (input.command) {
    case "view":
      return viewPath(input.path, input.view_range);
    case "create":
      return createFile(input.path, input.file_text);
    case "str_replace":
      return replaceInFile(input.path, input.old_str, input.new_str);
    case "insert":
      return insertInFile(input.path, input.insert_line, input.new_str);
  }
}

function assertAbsolutePath(path: string): void {
  if (path.trim().length === 0) throw new Error("path must be a non-empty string");
  if (!isAbsolute(path)) {
    throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`);
  }
}

async function viewPath(path: string, viewRange: number[] | undefined): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
  if (info.isDirectory()) {
    if (viewRange !== undefined) {
      throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
    }
    return listDirectory(path);
  }
  if (!info.isFile()) throw new Error(`cannot view "${path}": not a regular file or directory`);
  return formatFileView(path, await readFile(path, "utf8"), viewRange);
}

function formatFileView(path: string, content: string, viewRange?: number[]): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange;
    if (
      viewRange.length !== 2 ||
      requestedInitialLine === undefined ||
      requestedFinalLine === undefined ||
      !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = requestedInitialLine;
    finalLine = requestedFinalLine;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      );
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      );
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
      );
    }
    lines = finalLine === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
  }
  const numbered = lines.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`).join("\n");
  return truncate(`${prompt}:\n${numbered}\n`);
}

async function listDirectory(path: string): Promise<string> {
  async function visit(directory: string, depth: number): Promise<string[]> {
    const rows: string[] = [];
    for (const entry of (await readdir(directory, { withFileTypes: true })).filter(
      (candidate) =>
        !candidate.name.startsWith(".") && candidate.name !== "node_modules" && candidate.name !== "__pycache__",
    )) {
      const child = join(directory, entry.name);
      rows.push(`${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"}\t${child}`);
      if (entry.isDirectory() && depth < 2) rows.push(...(await visit(child, depth + 1)));
    }
    return rows;
  }
  const rows = [`d\t${path}`, ...(await visit(path, 1))].sort((left, right) => {
    const leftPath = left.slice(left.indexOf("\t") + 1);
    const rightPath = right.slice(right.indexOf("\t") + 1);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${truncate(`${rows.join("\n")}\n`)}\n`;
}

async function createFile(path: string, fileText: string | undefined): Promise<string> {
  if (fileText === undefined) throw new Error("Parameter `file_text` is required for command: create");
  try {
    await stat(path);
    throw new Error(`File already exists at: ${path}. Cannot overwrite files using command \`create\`.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, fileText, "utf8");
  return `New file created successfully at: ${path}`;
}

async function replaceInFile(path: string, oldStr: string | undefined, newStr: string | undefined): Promise<string> {
  if (oldStr === undefined) throw new Error("Parameter `old_str` is required for command: str_replace");
  if (oldStr.length === 0) throw new Error("Parameter `old_str` is empty for command: str_replace");
  const before = await readableFile(path, "edit");
  const offsets = matchOffsets(before, oldStr);
  const offset = offsets[0];
  if (offset === undefined) {
    throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`);
  }
  if (offsets.length > 1) {
    throw new Error(
      `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${lineNumbersAt(before, offsets).join(", ")}]. Please ensure it is unique`,
    );
  }
  await writeFile(path, before.slice(0, offset) + (newStr ?? "") + before.slice(offset + oldStr.length), "utf8");
  return `The file ${path} has been edited successfully.`;
}

async function insertInFile(path: string, insertLine: number | undefined, newStr: string | undefined): Promise<string> {
  if (insertLine === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
  if (newStr === undefined) throw new Error("Parameter `new_str` is required for command: insert");
  const before = await readableFile(path, "insert into");
  const lines = before.split("\n");
  if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
    throw new Error(
      `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    );
  }
  await writeFile(path, [...lines.slice(0, insertLine), ...newStr.split("\n"), ...lines.slice(insertLine)].join("\n"));
  return `The file ${path} has been edited successfully.`;
}

async function readableFile(path: string, operation: string): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
  if (info.isDirectory()) {
    throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
  }
  if (!info.isFile()) throw new Error(`cannot ${operation} "${path}": not a regular file`);
  return readFile(path, "utf8");
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  for (let offset = 0; ; ) {
    const match = content.indexOf(search, offset);
    if (match < 0) return offsets;
    offsets.push(match);
    offset = match + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

function truncate(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS ? content : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}
