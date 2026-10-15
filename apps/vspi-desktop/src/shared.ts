import type {
  AgentHandle,
  Klient,
  SessionHandle,
  TerminalStreamFrame,
  DesktopSettingsSnapshot,
  ProviderSettingsEdit,
} from "@moonshot-ai/klient";
export type AgentHistoryPage = Awaited<ReturnType<AgentHandle["getHistory"]>>;
export type {
  TerminalStreamFrame,
  DesktopSettingsSnapshot,
  ProviderSettingsEdit,
};
export interface RemoteHostView {
  id: string;
  label: string;
  host: string;
  port?: number;
  executable?: string;
  homeDir?: string;
}
export interface LocalConfigView {
  executable?: string;
  executableArgs?: string[];
  homeDir?: string;
}
export interface HostListView {
  active: string;
  local: LocalConfigView & { resolvedCommand: string };
  remotes: RemoteHostView[];
}
export interface ConnectionInfo {
  kind: "local" | "ssh";
  runtimeId: string;
  version: string;
  homeDir: string;
  host: string;
  label: string;
}
export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size?: number;
  mime?: string;
}
export interface FilePreview {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  mime: string;
  truncated: boolean;
}
export interface AgentToolTaskView {
  description: string;
  subagentType?: string;
  model?: string;
}
export interface SessionView {
  history: AgentHistoryPage;
  agentOutputs: Record<string, string>;
  agentTasks: Record<string, AgentToolTaskView>;
  approvals: Awaited<ReturnType<SessionHandle["approvals"]["list"]>>;
  questions: Awaited<ReturnType<SessionHandle["questions"]["list"]>>;
  permission: Awaited<ReturnType<AgentHandle["getPermission"]>>;
}
export interface DesktopMethods {
  aliases: { input: undefined; output: string[] };
  connectHost: { input: { id: string }; output: ConnectionInfo };
  disconnect: { input: undefined; output: void };
  listHosts: { input: undefined; output: HostListView };
  upsertRemote: {
    input: Omit<RemoteHostView, "id"> & { id?: string };
    output: HostListView;
  };
  removeRemote: { input: { id: string }; output: HostListView };
  setLocalConfig: { input: LocalConfigView; output: HostListView };
  authAnswer: { input: { id: string; answer: string | null }; output: void };
  workspaces: {
    input: undefined;
    output: Awaited<ReturnType<Klient["global"]["workspaces"]["list"]>>;
  };
  browse: {
    input: { path?: string };
    output: Awaited<ReturnType<Klient["global"]["hostFs"]["browse"]>>;
  };
  sessions: {
    input: { workspaceId?: string; before?: string };
    output: Awaited<ReturnType<Klient["global"]["sessions"]["list"]>>;
  };
  create: { input: { path: string }; output: string };
  open: { input: { sessionId: string }; output: SessionView };
  history: {
    input: { sessionId: string; before?: number };
    output: AgentHistoryPage;
  };
  rename: { input: { sessionId: string; title: string }; output: void };
  archive: { input: { sessionId: string }; output: void };
  submit: {
    input: {
      sessionId: string;
      promptId: string;
      text: string;
      mode: "queue" | "steer";
    };
    output: Awaited<ReturnType<AgentHandle["submitOnce"]>>;
  };
  receipt: {
    input: { sessionId: string; promptId: string };
    output: Awaited<ReturnType<AgentHandle["getSubmission"]>>;
  };
  stop: { input: { sessionId: string }; output: void };
  approve: {
    input: { sessionId: string; id: string; decision: "approved" | "rejected" };
    output: void;
  };
  answer: {
    input: { sessionId: string; id: string; answers: Record<string, string> };
    output: void;
  };
  models: {
    input: undefined;
    output: Awaited<ReturnType<Klient["global"]["kosong"]["listModels"]>>;
  };
  model: {
    input: { sessionId: string; model: string; thinking?: string };
    output: unknown;
  };
  permission: {
    input: { sessionId: string; mode: "auto" | "manual" | "yolo" };
    output: void;
  };
  files: {
    input: { sessionId: string; path: string };
    output: { items: FileEntry[]; truncated: boolean };
  };
  preview: { input: { sessionId: string; path: string }; output: FilePreview };
  changes: {
    input: { sessionId: string };
    output: { branch: string; entries: Record<string, string> };
  };
  diff: {
    input: { sessionId: string; path: string };
    output: { diff: string; truncated: boolean };
  };
  settings: { input: undefined; output: DesktopSettingsSnapshot };
  saveProvider: {
    input: ProviderSettingsEdit;
    output: DesktopSettingsSnapshot;
  };
  removeProvider: {
    input: { revision: string; id: string };
    output: DesktopSettingsSnapshot;
  };
  testProvider: { input: { model: string }; output: string };
  terminalOpen: {
    input: { sessionId: string; streamId: string; cols: number; rows: number };
    output: void;
  };
  terminalWrite: {
    input: { sessionId: string; id: string; data: string };
    output: void;
  };
  terminalResize: {
    input: { sessionId: string; id: string; cols: number; rows: number };
    output: void;
  };
  terminalClose: { input: { streamId: string }; output: void };
}
export type DesktopEvent =
  | { type: "connection"; message: string; disconnected?: boolean }
  | { type: "auth"; id: string; prompt: string; confirm: boolean }
  | { type: "session"; sessionId: string; view: SessionView }
  | { type: "terminal"; streamId: string; frame: TerminalStreamFrame }
  | { type: "error"; message: string; streamId?: string };
export interface DesktopApi {
  call<M extends keyof DesktopMethods>(
    this: void,
    method: M,
    input: DesktopMethods[M]["input"],
  ): Promise<DesktopMethods[M]["output"]>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
}
declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
