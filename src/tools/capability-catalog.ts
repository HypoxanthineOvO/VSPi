export type ToolCapabilityStatus = "native" | "available" | "not-connected" | "deferred";

export interface ToolCapability {
  id: "files" | "git" | "ssh" | "images" | "browser" | "mcp" | "pty";
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
    route: "Pi read / ls / find / grep / edit / write",
    boundary: "VSPi approval before native execute",
  },
  {
    id: "git",
    label: "Git",
    status: "native",
    route: "Pi Bash",
    boundary: "git-write approval category",
  },
  {
    id: "ssh",
    label: "SSH",
    status: "native",
    route: "Pi Bash",
    boundary: "ssh approval category",
  },
  {
    id: "images",
    label: "Images",
    status: "available",
    route: "Pi read image content + VSPi attachments",
    boundary: "verified file handle and attachment session",
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
    route: "One-shot Pi Bash only",
    boundary: "persistent process ownership deferred",
  },
] as const;
