import { errorMessage } from "../../backend/errors.ts";
import type { BackendResult, EmptyPayload } from "../../backend/types.ts";

interface ExportFile {
  id: string;
  path: string;
}

export function createExportFileCopy(
  copyFile: (path: string) => Promise<BackendResult<EmptyPayload>>,
  changed: () => void,
) {
  let pending: ExportFile | null = null;
  let copied: ExportFile | null = null;
  const errors = new Map<string, { path: string; message: string }>();
  const matches = (file: ExportFile | null, id: string, path: string): boolean =>
    file?.id === id && file.path === path;

  return {
    state(id: string, path: string) {
      const error = errors.get(id);
      return {
        disabled: pending !== null,
        label: matches(pending, id, path) ? "Copying..." : matches(copied, id, path) ? "Copied" : "Copy file",
        error: error?.path === path ? error.message : "",
      };
    },
    async copy(id: string, path: string): Promise<"copied" | "error" | "ignored"> {
      // clipboard writes share one destination, so a second row must wait too
      if (!id || !path || pending) return "ignored";
      pending = { id, path };
      if (matches(copied, id, path)) copied = null;
      errors.delete(id);
      changed();
      try {
        const result = await copyFile(path);
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
    },
  };
}
