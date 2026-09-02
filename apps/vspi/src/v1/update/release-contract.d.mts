export interface ParsedGitHubVspiRelease {
  version: string;
  checksum: string;
  downloadUrl: string;
}

export function parseGitHubVspiRelease(value: unknown): ParsedGitHubVspiRelease;
