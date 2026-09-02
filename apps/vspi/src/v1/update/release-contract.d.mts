export interface ParsedVspiRelease {
  version: string;
  checksum: string;
  downloadUrl: string;
}

export function parseVspiRelease(value: unknown): ParsedVspiRelease;
