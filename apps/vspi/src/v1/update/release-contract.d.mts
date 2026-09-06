export interface ParsedGitHubVspiRelease {
  version: string;
  checksum: string;
  downloadUrl: string;
}

export function releaseTagVersion(value: unknown): string;

export function selectGitHubVspiRelease(value: unknown): Record<string, unknown>;

export function parseGitHubVspiRelease(value: unknown): ParsedGitHubVspiRelease;
