import { invoke } from "@tauri-apps/api/core";

import { backendFailure, errorMessage, isBackendError } from "./errors.ts";
import type {
  BackendClient,
  BackendError,
  BackendResult,
  DataPayload,
  DiagnosticsContext,
  DiagnosticsPayload,
  DownloadProgress,
  EmptyPayload,
  EncoderPayload,
  FileSelection,
  JsonObject,
  JsonValue,
  PathSelection,
  PlanRequest,
  Profile,
  ProfileInput,
  QueueState,
  SendToShortcuts,
  Settings,
  SettingsPatch,
  ThumbnailPayload,
  UpdateCheck,
  UrlPayload,
} from "./types.ts";

export type TauriInvoke = (
  command: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export interface TauriBackendClient extends BackendClient {
  health(): Promise<BackendResult<JsonObject>>;
  onFatal(listener: (error: BackendError) => void): () => void;
}

type TauriBackendCommand =
  | { command: "health" }
  | { command: "probe_file"; payload: { path: string } }
  | { command: "probe_audio_file"; payload: { path: string } }
  | { command: "get_waveform"; payload: { path: string } }
  | { command: "get_thumbnail"; payload: { path: string } }
  | { command: "get_media_url"; payload: { path: string } }
  | { command: "release_media_token"; payload: { token: string } }
  | { command: "create_plan"; payload: { request: PlanRequest } }
  | { command: "enqueue_with_options"; payload: { request: PlanRequest } }
  | { command: "enqueue_batch"; payload: { requests: readonly PlanRequest[] } }
  | { command: "get_queue_state" }
  | { command: "cancel_item"; payload: { item_id: string } }
  | { command: "cancel_all_items" }
  | { command: "clear_completed" }
  | { command: "move_item"; payload: { item_id: string; new_index: number } }
  | { command: "retry_item"; payload: { item_id: string } }
  | { command: "stop_after_current" }
  | { command: "get_diagnostics"; payload?: { context: DiagnosticsContext } }
  | { command: "get_settings" }
  | { command: "save_settings"; payload: { settings: SettingsPatch } }
  | { command: "refresh_encoders" }
  | { command: "get_profiles_json" }
  | { command: "create_profile"; payload: { profile: ProfileInput } }
  | { command: "update_profile"; payload: { profile_id: string; profile: ProfileInput } }
  | { command: "delete_profile"; payload: { profile_id: string } }
  | { command: "duplicate_profile"; payload: { profile_id: string } }
  | { command: "import_profiles_from_file"; payload: { path: string } }
  | { command: "export_profile_to_file"; payload: { path: string; profile_id: string } }
  | { command: "install_generic_sendto"; payload?: { executable_path?: string } }
  | { command: "remove_generic_sendto" }
  | { command: "install_profile_sendto"; payload: { profile_id: string; action?: string; executable_path?: string } }
  | { command: "remove_profile_sendto"; payload: { profile_id: string } }
  | { command: "repair_profile_sendto"; payload: { profile_id: string; action?: string; executable_path?: string } }
  | { command: "list_sendto_shortcuts" }
  | { command: "shutdown" };

type Guard<T> = (value: unknown) => value is T;

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
}

function isJsonObjectArray(value: unknown): value is readonly JsonObject[] {
  return Array.isArray(value) && value.every(isJsonObject);
}

function isDataPayload(value: unknown): value is DataPayload {
  return isJsonObject(value) && isJsonObject(value.data);
}

function isQueueState(value: unknown): value is QueueState {
  return (
    isJsonObject(value) &&
    Array.isArray(value.items) &&
    value.items.every(isJsonObject)
  );
}

function isUrlPayload(value: unknown): value is UrlPayload {
  return (
    isJsonObject(value) &&
    typeof value.url === "string" &&
    (value.token === undefined || typeof value.token === "string")
  );
}

function isThumbnailPayload(value: unknown): value is ThumbnailPayload {
  return isJsonObject(value) && typeof value.thumbnail === "string";
}

function isSettings(value: unknown): value is Settings {
  return (
    isJsonObject(value) &&
    (value.profiles === undefined || isJsonObjectArray(value.profiles))
  );
}

function isDiagnosticsPayload(value: unknown): value is DiagnosticsPayload {
  return isJsonObject(value) && typeof value.text === "string";
}

function isEncoderPayload(value: unknown): value is EncoderPayload {
  return isJsonObject(value) && Array.isArray(value.available_encoders);
}

function isSendToShortcuts(value: unknown): value is SendToShortcuts {
  return isJsonObject(value) && isJsonObjectArray(value.shortcuts);
}

function unavailable<T>(method: string): BackendResult<T> {
  return backendFailure(
    "BACKEND_METHOD_UNAVAILABLE",
    `Desktop backend method ${method} is not available in the Tauri shell yet`,
    { method },
  );
}

function normalizeBridgeError<T>(method: string, value: JsonObject): BackendResult<T> {
  const code = typeof value.code === "string" ? value.code : "BACKEND_REJECTED";
  const message =
    typeof value.error === "string" && value.error
      ? value.error
      : `Desktop backend method ${method} failed`;
  const details = isJsonObject(value.details) ? value.details : {};
  return backendFailure(code, message, details);
}

function stripSuccessFlag(value: JsonObject): JsonObject {
  const payload: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "ok") payload[key] = item;
  }
  return payload;
}

function normalizeBridgeResult<T>(
  method: string,
  raw: unknown,
  guard: Guard<T>,
): BackendResult<T> {
  let payload = raw;
  if (isJsonObject(raw) && Object.hasOwn(raw, "ok")) {
    if (raw.ok === false) return normalizeBridgeError(method, raw);
    if (raw.ok !== true) {
      return backendFailure(
        "MALFORMED_BRIDGE_RESULT",
        `Desktop backend method ${method} returned an invalid result`,
        { method },
      );
    }
    payload = stripSuccessFlag(raw);
  }
  if (!guard(payload)) {
    return backendFailure(
      "MALFORMED_BRIDGE_RESULT",
      `Desktop backend method ${method} returned an invalid result`,
      { method },
    );
  }
  return { ok: true, value: payload };
}

class TauriTransport implements TauriBackendClient {
  readonly #invoke: TauriInvoke;
  readonly #fatalListeners = new Set<(error: BackendError) => void>();

  constructor(invokeCommand: TauriInvoke) {
    this.#invoke = invokeCommand;
  }

  async #request<T>(
    method: string,
    command: TauriBackendCommand,
    guard: Guard<T>,
  ): Promise<BackendResult<T>> {
    try {
      const raw = await this.#invoke("backend_request", { command });
      return this.#finish(normalizeBridgeResult(method, raw, guard));
    } catch (error) {
      return this.#finish(
        isBackendError(error)
          ? { ok: false, error }
          : backendFailure(
              "TAURI_INVOKE_FAILED",
              errorMessage(error, `Desktop backend method ${method} failed`),
              { method },
            ),
      );
    }
  }

  #finish<T>(result: BackendResult<T>): BackendResult<T> {
    if (
      !result.ok &&
      (result.error.code === "BACKEND_EXITED" ||
        result.error.code === "MALFORMED_BACKEND_OUTPUT")
    ) {
      this.#fatalListeners.forEach((listener) => listener(result.error));
    }
    return result;
  }

  onFatal(listener: (error: BackendError) => void): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  health(): Promise<BackendResult<JsonObject>> {
    return this.#request("health", { command: "health" }, isJsonObject);
  }

  probeFile(path: string): Promise<BackendResult<DataPayload>> {
    return this.#request(
      "probeFile",
      { command: "probe_file", payload: { path } },
      isDataPayload,
    );
  }

  probeAudioFile(path: string): Promise<BackendResult<DataPayload>> {
    return this.#request(
      "probeAudioFile",
      { command: "probe_audio_file", payload: { path } },
      isDataPayload,
    );
  }

  getWaveform(path: string): Promise<BackendResult<UrlPayload>> {
    return this.#request(
      "getWaveform",
      { command: "get_waveform", payload: { path } },
      isUrlPayload,
    );
  }

  getThumbnail(path: string): Promise<BackendResult<ThumbnailPayload>> {
    return this.#request(
      "getThumbnail",
      { command: "get_thumbnail", payload: { path } },
      isThumbnailPayload,
    );
  }

  getMediaUrl(path: string): Promise<BackendResult<UrlPayload>> {
    return this.#request(
      "getMediaUrl",
      { command: "get_media_url", payload: { path } },
      isUrlPayload,
    );
  }

  releaseMediaToken(token: string): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "releaseMediaToken",
      { command: "release_media_token", payload: { token } },
      isJsonObject,
    );
  }

  createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>> {
    return this.#request(
      "createPlan",
      { command: "create_plan", payload: { request } },
      isDataPayload,
    );
  }

  enqueueWithOptions(request: PlanRequest): Promise<BackendResult<JsonObject>> {
    return this.#request(
      "enqueueWithOptions",
      { command: "enqueue_with_options", payload: { request } },
      isJsonObject,
    );
  }

  enqueueBatch(requests: readonly PlanRequest[]): Promise<BackendResult<JsonObject>> {
    return this.#request(
      "enqueueBatch",
      { command: "enqueue_batch", payload: { requests } },
      isJsonObject,
    );
  }

  getQueueState(): Promise<BackendResult<QueueState>> {
    return this.#request("getQueueState", { command: "get_queue_state" }, isQueueState);
  }

  cancelItem(itemId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "cancelItem",
      { command: "cancel_item", payload: { item_id: itemId } },
      isJsonObject,
    );
  }

  cancelAllItems(): Promise<BackendResult<EmptyPayload>> {
    return this.#request("cancelAllItems", { command: "cancel_all_items" }, isJsonObject);
  }

  clearCompleted(): Promise<BackendResult<EmptyPayload>> {
    return this.#request("clearCompleted", { command: "clear_completed" }, isJsonObject);
  }

  moveItem(itemId: string, newIndex: number): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "moveItem",
      { command: "move_item", payload: { item_id: itemId, new_index: newIndex } },
      isJsonObject,
    );
  }

  retryItem(itemId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "retryItem",
      { command: "retry_item", payload: { item_id: itemId } },
      isJsonObject,
    );
  }

  stopAfterCurrent(): Promise<BackendResult<EmptyPayload>> {
    return this.#request("stopAfterCurrent", { command: "stop_after_current" }, isJsonObject);
  }

  getDiagnostics(context?: DiagnosticsContext): Promise<BackendResult<DiagnosticsPayload>> {
    return this.#request(
      "getDiagnostics",
      context !== undefined
        ? { command: "get_diagnostics", payload: { context } }
        : { command: "get_diagnostics" },
      isDiagnosticsPayload,
    );
  }

  async copyText(text: string): Promise<BackendResult<EmptyPayload>> {
    try {
      await this.#invoke("copy_text", { text });
      return { ok: true, value: {} };
    } catch (error) {
      return this.#finish(isBackendError(error) ? { ok: false, error } : backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not copy text"), { method: "copyText" }));
    }
  }

  async openLogsFolder(): Promise<BackendResult<EmptyPayload>> {
    try {
      await this.#invoke("open_logs_folder", {});
      return { ok: true, value: {} };
    } catch (error) {
      return this.#finish(isBackendError(error) ? { ok: false, error } : backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not open logs folder"), { method: "openLogsFolder" }));
    }
  }

  async openConfigFolder(): Promise<BackendResult<EmptyPayload>> {
    try {
      await this.#invoke("open_config_folder", {});
      return { ok: true, value: {} };
    } catch (error) {
      return this.#finish(isBackendError(error) ? { ok: false, error } : backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not open config folder"), { method: "openConfigFolder" }));
    }
  }

  getSettings(): Promise<BackendResult<Settings>> {
    return this.#request("getSettings", { command: "get_settings" }, isSettings);
  }

  saveSettings(settings: SettingsPatch): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "saveSettings",
      { command: "save_settings", payload: { settings } },
      isJsonObject,
    );
  }

  refreshEncoders(): Promise<BackendResult<EncoderPayload>> {
    return this.#request("refreshEncoders", { command: "refresh_encoders" }, isEncoderPayload);
  }

  getProfilesJson(): Promise<BackendResult<readonly Profile[]>> {
    return this.#request("getProfilesJson", { command: "get_profiles_json" }, isJsonObjectArray);
  }

  createProfile(profile: ProfileInput): Promise<BackendResult<JsonObject>> {
    return this.#request(
      "createProfile",
      { command: "create_profile", payload: { profile } },
      isJsonObject,
    );
  }

  updateProfile(profileId: string, profile: ProfileInput): Promise<BackendResult<JsonObject>> {
    return this.#request(
      "updateProfile",
      { command: "update_profile", payload: { profile_id: profileId, profile } },
      isJsonObject,
    );
  }

  deleteProfile(profileId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "deleteProfile",
      { command: "delete_profile", payload: { profile_id: profileId } },
      isJsonObject,
    );
  }

  duplicateProfile(profileId: string): Promise<BackendResult<JsonObject>> {
    return this.#request(
      "duplicateProfile",
      { command: "duplicate_profile", payload: { profile_id: profileId } },
      isJsonObject,
    );
  }

  importProfilesFromFile(path: string): Promise<BackendResult<JsonObject>> {
    return this.#request(
      "importProfilesFromFile",
      { command: "import_profiles_from_file", payload: { path } },
      isJsonObject,
    );
  }

  exportProfileToFile(path: string, profileId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "exportProfileToFile",
      { command: "export_profile_to_file", payload: { path, profile_id: profileId } },
      isJsonObject,
    );
  }

  async checkForUpdates(): Promise<BackendResult<UpdateCheck>> {
    try {
      const result = (await this.#invoke("check_for_updates", {})) as UpdateCheck;
      return { ok: true, value: result };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not check for updates"), { method: "checkForUpdates" });
    }
  }

  async downloadUpdate(): Promise<BackendResult<JsonObject>> {
    try {
      await this.#invoke("download_update", {});
      return { ok: true, value: {} };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not download update"), { method: "downloadUpdate" });
    }
  }

  async getDownloadProgress(): Promise<BackendResult<DownloadProgress>> {
    try {
      const result = (await this.#invoke("get_download_progress", {})) as DownloadProgress;
      return { ok: true, value: result };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not get download progress"), { method: "getDownloadProgress" });
    }
  }

  async installUpdate(): Promise<BackendResult<EmptyPayload>> {
    try {
      await this.#invoke("install_update", {});
      return { ok: true, value: {} };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not install update"), { method: "installUpdate" });
    }
  }

  async openOutputFolder(path: string): Promise<BackendResult<EmptyPayload>> {
    try {
      await this.#invoke("open_output_folder", { path });
      return { ok: true, value: {} };
    } catch (error) {
      return this.#finish(isBackendError(error) ? { ok: false, error } : backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not open output folder"), { method: "openOutputFolder" }));
    }
  }

  installGenericSendto(): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "installGenericSendto",
      { command: "install_generic_sendto" },
      isJsonObject,
    );
  }

  removeGenericSendto(): Promise<BackendResult<EmptyPayload>> {
    return this.#request("removeGenericSendto", { command: "remove_generic_sendto" }, isJsonObject);
  }

  installProfileSendto(profileId: string, action?: string): Promise<BackendResult<EmptyPayload>> {
    const payload: { profile_id: string; action?: string } = { profile_id: profileId };
    if (action !== undefined) payload.action = action;
    return this.#request(
      "installProfileSendto",
      { command: "install_profile_sendto", payload },
      isJsonObject,
    );
  }

  removeProfileSendto(profileId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#request(
      "removeProfileSendto",
      { command: "remove_profile_sendto", payload: { profile_id: profileId } },
      isJsonObject,
    );
  }

  repairProfileSendto(profileId: string, action?: string): Promise<BackendResult<EmptyPayload>> {
    const payload: { profile_id: string; action?: string } = { profile_id: profileId };
    if (action !== undefined) payload.action = action;
    return this.#request(
      "repairProfileSendto",
      { command: "repair_profile_sendto", payload },
      isJsonObject,
    );
  }

  listSendtoShortcuts(): Promise<BackendResult<SendToShortcuts>> {
    return this.#request(
      "listSendtoShortcuts",
      { command: "list_sendto_shortcuts" },
      isSendToShortcuts,
    );
  }

  getIpcFiles(): Promise<BackendResult<readonly string[]>> {
    return Promise.resolve(unavailable("getIpcFiles"));
  }

  getIpcMetadata(): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("getIpcMetadata"));
  }

  async closeWindow(): Promise<BackendResult<EmptyPayload>> {
    try {
      await this.#invoke("close_window", {});
      return { ok: true, value: {} };
    } catch (error) {
      return this.#finish(isBackendError(error) ? { ok: false, error } : backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not close window"), { method: "closeWindow" }));
    }
  }

  async pickFiles(): Promise<BackendResult<FileSelection>> {
    try {
      const files = (await this.#invoke("pick_video_files", {})) as string[];
      return { ok: true, value: { files } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick files"), { method: "pickFiles" });
    }
  }

  async pickAudioFiles(): Promise<BackendResult<FileSelection>> {
    try {
      const files = (await this.#invoke("pick_audio_files", {})) as string[];
      return { ok: true, value: { files } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick audio files"), { method: "pickAudioFiles" });
    }
  }

  async pickFolder(): Promise<BackendResult<PathSelection>> {
    try {
      const path = (await this.#invoke("pick_folder", {})) as string | null;
      return { ok: true, value: { path: path ?? "" } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick folder"), { method: "pickFolder" });
    }
  }

  async pickFfmpegFile(): Promise<BackendResult<PathSelection>> {
    try {
      const path = (await this.#invoke("pick_ffmpeg_file", {})) as string | null;
      return { ok: true, value: { path: path ?? "" } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick FFmpeg file"), { method: "pickFfmpegFile" });
    }
  }

  async pickFfprobeFile(): Promise<BackendResult<PathSelection>> {
    try {
      const path = (await this.#invoke("pick_ffprobe_file", {})) as string | null;
      return { ok: true, value: { path: path ?? "" } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick FFprobe file"), { method: "pickFfprobeFile" });
    }
  }

  async pickImportFile(): Promise<BackendResult<PathSelection>> {
    try {
      const path = (await this.#invoke("pick_import_file", {})) as string | null;
      return { ok: true, value: { path: path ?? "" } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick import file"), { method: "pickImportFile" });
    }
  }

  async pickSaveFile(defaultName?: string): Promise<BackendResult<PathSelection>> {
    try {
      const path = (await this.#invoke("pick_save_file", { defaultName: defaultName ?? "profiles.json" })) as string | null;
      return { ok: true, value: { path: path ?? "" } };
    } catch (error) {
      if (isBackendError(error)) return { ok: false, error };
      return backendFailure("TAURI_INVOKE_FAILED", errorMessage(error, "Could not pick save file"), { method: "pickSaveFile" });
    }
  }
}

export function createTauriBackendClient(invokeCommand: TauriInvoke): TauriBackendClient {
  return new TauriTransport(invokeCommand);
}

export function hasTauriInvoke(host: unknown): boolean {
  if (typeof host !== "object" || host === null) return false;
  const internals = Reflect.get(host, "__TAURI_INTERNALS__");
  return (
    typeof internals === "object" &&
    internals !== null &&
    typeof Reflect.get(internals, "invoke") === "function"
  );
}

export function createTauriBackendClientFromWindow(host: unknown): TauriBackendClient | undefined {
  return hasTauriInvoke(host)
    ? createTauriBackendClient((command, arguments_) => invoke(command, arguments_))
    : undefined;
}