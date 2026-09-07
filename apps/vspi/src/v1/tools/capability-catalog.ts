export type ToolCapabilityStatus = "native" | "available" | "not-connected" | "deferred";

export interface ToolCapability {
  id: "files" | "git" | "ssh" | "images" | "skills" | "browser" | "mcp" | "pty";
  label: string;
  status: ToolCapabilityStatus;
  route: string;
  boundary: string;
}

export const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  {
    id: "files",
    label: "Files & Search",
    status: "native",
    route: "Core Read / Glob / Grep / Edit / Write",
    boundary: "Runtime permission gate before execute",
  },
  {
    id: "git",
    label: "Git",
    status: "native",
    route: "Core Bash",
    boundary: "git-write approval category",
  },
  {
    id: "ssh",
    label: "SSH",
    status: "native",
    route: "Core Bash",
    boundary: "ssh approval category",
  },
  {
    id: "images",
    label: "Images",
    status: "available",
    route: "Core media tools + VSPi attachments",
    boundary: "verified file handle and attachment session",
  },
  {
    id: "skills",
    label: "Skills",
    status: "available",
    route: "Core Skill catalog",
    boundary: "Question confirmation before every mutation",
  },
  {
    id: "browser",
    label: "Browser",
    status: "not-connected",
    route: "No model tool registered",
    boundary: "future isolated Provider",
  },
  {
    id: "mcp",
    label: "MCP",
    status: "not-connected",
    route: "No server registry connected",
    boundary: "future server-scoped adapter",
  },
  {
    id: "pty",
    label: "Persistent PTY",
    status: "deferred",
    route: "Core terminal and background tasks",
    boundary: "daemon-owned process lifecycle",
  },
] as const;
