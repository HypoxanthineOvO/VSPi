export interface SessionLeaseOwner {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  sessionPath: string;
  socketPath: string;
  token: string;
  schemaVersion: 1 | 2;
}

export type ExternalSessionSource = 'codex' | 'claude';

export interface ExternalSessionSummary {
  id: string;
  source: ExternalSessionSource;
  sourceId: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  archived?: boolean;
}

export interface ExternalTranscriptItem {
  role: 'user' | 'assistant';
  kind: 'message' | 'thinking';
  text: string;
  timestamp?: number;
}

export interface ExternalContextCheckpoint {
  summary: string;
  tailStartIndex: number;
  sourceContextWindow?: number;
}

export interface ExternalSessionPreview extends ExternalSessionSummary {
  items: ExternalTranscriptItem[];
  messageCount: number;
  toolCount: number;
  estimatedTokens: number;
  sourceContextWindow?: number;
  contextCheckpoint?: ExternalContextCheckpoint;
  fingerprint: string;
  snapshotBytes: number;
  snapshotModifiedAt: string;
}
