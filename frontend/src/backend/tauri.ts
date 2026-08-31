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
  | { command: "create_plan"; payload: { request: PlanRequest } }
  | { command: "enqueue_with_options"; payload: { request: PlanRequest } }
  | { command: "get_queue_state" }
  | { command: "cancel_item"; payload: { item_id: string } }
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

  probeAudioFile(_path: string): Promise<BackendResult<DataPayload>> {
    return Promise.resolve(unavailable("probeAudioFile"));
  }

  getWaveform(_path: string): Promise<BackendResult<UrlPayload>> {
    return Promise.resolve(unavailable("getWaveform"));
  }

  getThumbnail(_path: string): Promise<BackendResult<ThumbnailPayload>> {
    return Promise.resolve(unavailable("getThumbnail"));
  }

  getMediaUrl(_path: string): Promise<BackendResult<UrlPayload>> {
    return Promise.resolve(unavailable("getMediaUrl"));
  }

  releaseMediaToken(_token: string): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("releaseMediaToken"));
  }

  enqueueBatch(_requests: readonly PlanRequest[]): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("enqueueBatch"));
  }

  cancelAllItems(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("cancelAllItems"));
  }

  clearCompleted(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("clearCompleted"));
  }

  moveItem(_itemId: string, _newIndex: number): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("moveItem"));
  }

  retryItem(_itemId: string): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("retryItem"));
  }

  stopAfterCurrent(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("stopAfterCurrent"));
  }

  getDiagnostics(_context?: DiagnosticsContext): Promise<BackendResult<DiagnosticsPayload>> {
    return Promise.resolve(unavailable("getDiagnostics"));
  }

  copyText(_text: string): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("copyText"));
  }

  openLogsFolder(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("openLogsFolder"));
  }

  openConfigFolder(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("openConfigFolder"));
  }

  getSettings(): Promise<BackendResult<Settings>> {
    return Promise.resolve(unavailable("getSettings"));
  }

  saveSettings(_settings: SettingsPatch): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("saveSettings"));
  }

  refreshEncoders(): Promise<BackendResult<EncoderPayload>> {
    return Promise.resolve(unavailable("refreshEncoders"));
  }

  getProfilesJson(): Promise<BackendResult<readonly Profile[]>> {
    return Promise.resolve(unavailable("getProfilesJson"));
  }

  createProfile(_profile: ProfileInput): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("createProfile"));
  }

  updateProfile(
    _profileId: string,
    _profile: ProfileInput,
  ): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("updateProfile"));
  }

  deleteProfile(_profileId: string): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("deleteProfile"));
  }

  duplicateProfile(_profileId: string): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("duplicateProfile"));
  }

  importProfilesFromFile(_path: string): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("importProfilesFromFile"));
  }

  exportProfileToFile(
    _path: string,
    _profileId: string,
  ): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("exportProfileToFile"));
  }

  checkForUpdates(): Promise<BackendResult<UpdateCheck>> {
    return Promise.resolve(unavailable("checkForUpdates"));
  }

  downloadUpdate(): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("downloadUpdate"));
  }

  getDownloadProgress(): Promise<BackendResult<DownloadProgress>> {
    return Promise.resolve(unavailable("getDownloadProgress"));
  }

  installUpdate(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("installUpdate"));
  }

  openOutputFolder(_path: string): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("openOutputFolder"));
  }

  installGenericSendto(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("installGenericSendto"));
  }

  removeGenericSendto(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("removeGenericSendto"));
  }

  installProfileSendto(
    _profileId: string,
    _action?: string,
  ): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("installProfileSendto"));
  }

  removeProfileSendto(_profileId: string): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("removeProfileSendto"));
  }

  repairProfileSendto(
    _profileId: string,
    _action?: string,
  ): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("repairProfileSendto"));
  }

  listSendtoShortcuts(): Promise<BackendResult<SendToShortcuts>> {
    return Promise.resolve(unavailable("listSendtoShortcuts"));
  }

  getIpcFiles(): Promise<BackendResult<readonly string[]>> {
    return Promise.resolve(unavailable("getIpcFiles"));
  }

  getIpcMetadata(): Promise<BackendResult<JsonObject>> {
    return Promise.resolve(unavailable("getIpcMetadata"));
  }

  closeWindow(): Promise<BackendResult<EmptyPayload>> {
    return Promise.resolve(unavailable("closeWindow"));
  }

  pickFiles(): Promise<BackendResult<FileSelection>> {
    return Promise.resolve(unavailable("pickFiles"));
  }

  pickAudioFiles(): Promise<BackendResult<FileSelection>> {
    return Promise.resolve(unavailable("pickAudioFiles"));
  }

  pickFolder(): Promise<BackendResult<PathSelection>> {
    return Promise.resolve(unavailable("pickFolder"));
  }

  pickFfmpegFile(): Promise<BackendResult<PathSelection>> {
    return Promise.resolve(unavailable("pickFfmpegFile"));
  }

  pickFfprobeFile(): Promise<BackendResult<PathSelection>> {
    return Promise.resolve(unavailable("pickFfprobeFile"));
  }

  pickImportFile(): Promise<BackendResult<PathSelection>> {
    return Promise.resolve(unavailable("pickImportFile"));
  }

  pickSaveFile(_defaultName?: string): Promise<BackendResult<PathSelection>> {
    return Promise.resolve(unavailable("pickSaveFile"));
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
