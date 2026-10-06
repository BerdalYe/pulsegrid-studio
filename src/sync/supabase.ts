import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CloudError,
  type CloudRow,
  type CommitArgs,
  type CommitResult,
  type SyncBackend
} from "./types";

const BUCKET = "projects";
const COLUMNS = "id,name,revision,object_path,size_bytes,device,updated_at";

interface ApiError {
  message?: string;
  status?: number;
  statusCode?: string | number;
  name?: string;
}

/** Turn whatever the library threw into something the app can act on. */
export function toCloudError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;

  const failure = (error ?? {}) as ApiError;
  const text = `${failure.name ?? ""} ${failure.message ?? ""}`;

  if (
    failure.status === 0 ||
    /fetch|network|failed to load|timeout|offline|retryable/i.test(text) ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  ) {
    return new CloudError("offline", "Can't reach the cloud. Changes sync when you're back online.");
  }

  if (/exceeded the maximum allowed size|payload too large|413/i.test(text)) {
    return new CloudError("too_big", "That project is too big to keep in the cloud (over 50 MB).");
  }

  return new CloudError("other", failure.message || "The cloud returned an error.");
}

function check<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw toCloudError(result.error);
  return result.data;
}

export function createSupabaseBackend(client: SupabaseClient): SyncBackend {
  const files = () => client.storage.from(BUCKET);

  return {
    async list() {
      const data = check(
        await client.from("cloud_projects").select(COLUMNS).order("updated_at", { ascending: false })
      );
      return (data ?? []) as CloudRow[];
    },

    async get(id) {
      const data = check(await client.from("cloud_projects").select(COLUMNS).eq("id", id).maybeSingle());
      return (data ?? null) as CloudRow | null;
    },

    async upload(path, data) {
      check(
        await files().upload(path, data, {
          contentType: "application/octet-stream",
          upsert: false
        })
      );
    },

    async download(path) {
      const blob = check(await files().download(path));
      if (!blob) throw new CloudError("other", "The project's file wasn't found in the cloud.");
      return blob;
    },

    async remove(paths) {
      check(await files().remove(paths));
    },

    async commit(args: CommitArgs): Promise<CommitResult> {
      const data = check(
        await client.rpc("commit_project", {
          p_id: args.id,
          p_name: args.name,
          p_base: args.base,
          p_path: args.path,
          p_size: args.size,
          p_device: args.device
        })
      ) as {
        ok: boolean;
        reason?: "conflict" | "missing" | "quota" | "too_many";
        revision?: number;
        old_path?: string | null;
      } | null;

      if (!data) throw new CloudError("other", "The cloud returned an empty answer.");
      if (data.ok) return { ok: true, revision: Number(data.revision), oldPath: data.old_path ?? null };
      if (data.reason === "conflict") return { ok: false, reason: "conflict", revision: Number(data.revision) };
      return { ok: false, reason: data.reason ?? "missing" } as CommitResult;
    },

    async deleteRow(id) {
      const data = check(await client.from("cloud_projects").delete().eq("id", id).select("object_path"));
      const rows = (data ?? []) as Array<{ object_path: string }>;
      return rows[0]?.object_path ?? null;
    }
  };
}
