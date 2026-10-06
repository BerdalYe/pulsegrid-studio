/** One project in the cloud, as the server describes it. */
export interface CloudRow {
  id: string;
  name: string;
  /** Goes up by one on every upload; how two PCs notice they disagree. */
  revision: number;
  object_path: string;
  size_bytes: number;
  device: string;
  updated_at: string;
}

export interface CommitArgs {
  id: string;
  name: string;
  /** The revision this device last saw; 0 for a project that isn't in the cloud yet. */
  base: number;
  path: string;
  size: number;
  device: string;
}

export type CommitResult =
  | { ok: true; revision: number; oldPath: string | null }
  | { ok: false; reason: "conflict"; revision: number }
  | { ok: false; reason: "missing" | "quota" | "too_many" };

/** Everything the sync engine needs from the server. */
export interface SyncBackend {
  list(): Promise<CloudRow[]>;
  get(id: string): Promise<CloudRow | null>;
  upload(path: string, data: Blob): Promise<void>;
  download(path: string): Promise<Blob>;
  remove(paths: string[]): Promise<void>;
  commit(args: CommitArgs): Promise<CommitResult>;
  /** Deletes the row and returns where its file was, if there was one. */
  deleteRow(id: string): Promise<string | null>;
}

export type CloudErrorKind = "offline" | "quota" | "too_many" | "too_big" | "other";

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/** The biggest file the server accepts (50 MB). */
export const MAX_PROJECT_BYTES = 52428800;
