import { errorMessage } from "../../backend/errors.ts";
import type { BackendResult, EmptyPayload } from "../../backend/types.ts";

interface ExportFile {
  id: string;
  path: string;
}

export type CopyStatus = "idle" | "copying" | "copied";

export function createExportFileCopy(
  copyFile: (path: string) => Promise<BackendResult<EmptyPayload>>,
  changed: () => void,
  // several files go to the clipboard as one copy, so they are one entry here too
  copyFiles: (paths: readonly string[]) => Promise<BackendResult<EmptyPayload>> = async () => ({
    ok: false,
    error: { code: "UNSUPPORTED_OPERATION", message: "Copying several files isn't available here.", details: {} },
  }),
) {
  let pending: ExportFile | null = null;
  let copied: ExportFile | null = null;
  const errors = new Map<string, { path: string; message: string }>();
  const matches = (file: ExportFile | null, id: string, path: string): boolean =>
    file?.id === id && file.path === path;

  async function run(id: string, path: string, write: () => Promise<BackendResult<EmptyPayload>>): Promise<"copied" | "error" | "ignored"> {
    // clipboard writes share one destination, so a second row must wait too
    if (!id || !path || pending) return "ignored";
    pending = { id, path };
    if (matches(copied, id, path)) copied = null;
    errors.delete(id);
    changed();
    try {
      const result = await write();
      if (!result.ok) {
        errors.set(id, { path, message: result.error.message });
        return "error";
      }
      copied = { id, path };
      return "copied";
    } catch (error) {
      errors.set(id, { path, message: errorMessage(error, "Could not copy file. Try again.") });
      return "error";
    } finally {
      pending = null;
      changed();
    }
  }

  return {
    state(id: string, path: string) {
      const error = errors.get(id);
      const status: CopyStatus = matches(pending, id, path) ? "copying" : matches(copied, id, path) ? "copied" : "idle";
      return {
        disabled: pending !== null,
        status,
        label: status === "copying" ? "Copying..." : status === "copied" ? "Copied" : "Copy file",
        error: error?.path === path ? error.message : "",
      };
    },
    copy(id: string, path: string): Promise<"copied" | "error" | "ignored"> {
      return run(id, path, () => copyFile(path));
    },
    /** Copies several files at once under `id`; their paths together name the entry. */
    copyMany(id: string, paths: readonly string[]): Promise<"copied" | "error" | "ignored"> {
      if (paths.length === 1 && paths[0]) return run(id, paths[0], () => copyFile(paths[0]!));
      return run(id, paths.join("\n"), () => copyFiles(paths));
    },
  };
}
