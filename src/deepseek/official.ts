// Adapted from pi-dsh-minimal v0.4.0 (MIT), commit
// bdc2bec3c5fbd8ec2f9497e61d0a30e2ca079386. Keep this wire fixture exact.
export const DEEPSEEK_HARNESS_PERSONA = "You are a helpful software engineer assistant.";

export const DEEPSEEK_HARNESS_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

export const DEEPSEEK_HARNESS_EDITOR_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

const BASH_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description: "The bash command to run. Relative path is preferred in the command.",
    },
  },
  required: ["command"],
} as const;

const EDITOR_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert"],
      description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
    },
    path: {
      type: "string",
      description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
    },
    file_text: {
      type: "string",
      description: "Required parameter of `create` command, with the content of the file to be created.",
    },
    insert_line: {
      type: "integer",
      description:
        "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
    },
    new_str: {
      type: "string",
      description:
        "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
    },
    old_str: {
      type: "string",
      description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
    },
    view_range: {
      type: "array",
      items: { type: "integer" },
      description:
        "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
    },
  },
  required: ["command", "path"],
} as const;

export interface DeepSeekHarnessToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const DEEPSEEK_HARNESS_TOOLS: readonly DeepSeekHarnessToolSchema[] = [
  {
    name: "bash",
    description: DEEPSEEK_HARNESS_BASH_DESCRIPTION,
    parameters: structuredClone(BASH_PARAMETERS) as unknown as Record<string, unknown>,
  },
  {
    name: "str_replace_editor",
    description: DEEPSEEK_HARNESS_EDITOR_DESCRIPTION,
    parameters: structuredClone(EDITOR_PARAMETERS) as unknown as Record<string, unknown>,
  },
];
