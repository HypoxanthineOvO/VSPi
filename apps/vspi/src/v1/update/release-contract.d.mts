export interface ParsedGitHubVspiRelease {
  version: string;
  checksum: string;
  downloadUrl: string;
}

export function releaseVersionFromLatestRedirect(value: string): string;

export function parseReleaseChecksums(value: string, version: string): string;

export function releaseTagVersion(value: unknown): string;

export function selectGitHubVspiRelease(value: unknown): Record<string, unknown>;

export function parseGitHubVspiRelease(value: unknown): ParsedGitHubVspiRelease;
