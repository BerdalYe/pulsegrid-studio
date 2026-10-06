import type { CloudRow } from "./types";

/**
 * What one account may keep in the cloud. The server enforces these in
 * supabase/schema.sql (commit_project); the numbers here only let the panel
 * show how much room is left, so change them in both places together.
 */
export const MAX_PROJECTS = 100;
export const QUOTA_BYTES = 262144000; // 250 MB

export interface CloudUsage {
  count: number;
  bytes: number;
  /** A fraction of the limit that is nearest to being used up, 0 to 1. */
  fullness: number;
  /** Close enough to a limit that the user should be told. */
  nearLimit: boolean;
  atLimit: boolean;
}

export function cloudUsage(projects: readonly Pick<CloudRow, "size_bytes">[]): CloudUsage {
  const count = projects.length;
  const bytes = projects.reduce((total, row) => total + row.size_bytes, 0);
  const fullness = Math.min(1, Math.max(count / MAX_PROJECTS, bytes / QUOTA_BYTES));

  return { count, bytes, fullness, nearLimit: fullness >= 0.9, atLimit: fullness >= 1 };
}

/** "4.2 MB", "310 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}
