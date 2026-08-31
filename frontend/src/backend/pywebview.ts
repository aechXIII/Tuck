import { backendFailure, errorMessage } from "./errors.ts";
import type {
  BackendClient,
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

const DEFAULT_TIMEOUT_MS = 30_000;
export const PYWEBVIEW_READY_EVENT = "pywebviewready";

export interface PywebviewClientOptions {
  timeoutMs?: number;
}

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

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonObjectArray(value: unknown): value is readonly JsonObject[] {
  return Array.isArray(value) && value.every(isJsonObject);
}

function isDataPayload(value: unknown): value is DataPayload {
  return isJsonObject(value) && isJsonObject(value.data);
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

function isFileSelection(value: unknown): value is FileSelection {
  return isJsonObject(value) && isStringArray(value.files);
}

function isPathSelection(value: unknown): value is PathSelection {
  return isJsonObject(value) && typeof value.path === "string";
}

function isQueueState(value: unknown): value is QueueState {
  return isJsonObject(value) && isJsonObjectArray(value.items);
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

function isDownloadProgress(value: unknown): value is DownloadProgress {
  return (
    isJsonObject(value) &&
    typeof value.downloading === "boolean" &&
    (value.done === undefined || typeof value.done === "boolean") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.progress === undefined || typeof value.progress === "number")
  );
}

function isUpdateCheck(value: unknown): value is UpdateCheck {
  return (
    isJsonObject(value) &&
    typeof value.available === "boolean" &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.notes === undefined || typeof value.notes === "string") &&
    (value.size === undefined || typeof value.size === "number") &&
    (value.size_mb === undefined || typeof value.size_mb === "number") &&
    (value.version === undefined || typeof value.version === "string")
  );
}

function isSendToShortcuts(value: unknown): value is SendToShortcuts {
  return isJsonObject(value) && isJsonObjectArray(value.shortcuts);
}

function normalizeDetails(value: unknown): Readonly<Record<string, unknown>> {
  return isJsonObject(value) ? value : {};
}

function backendError<T>(method: string, value: JsonObject): BackendResult<T> {
  const code = typeof value.code === "string" ? value.code : "BACKEND_REJECTED";
  const message =
    typeof value.error === "string" && value.error
      ? value.error
      : `Desktop backend method ${method} failed`;
  return backendFailure(code, message, normalizeDetails(value.details));
}

function stripSuccessFlag(value: JsonObject): JsonObject {
  const payload: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "ok") payload[key] = item;
  }
  return payload;
}

function normalizeResult<T>(
  method: string,
  raw: unknown,
  guard: Guard<T>,
): BackendResult<T> {
  let payload: unknown = raw;
  if (isJsonObject(raw) && Object.hasOwn(raw, "ok")) {
    if (raw.ok === false) return backendError(method, raw);
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

function rawMethod(rawApi: unknown, method: string): ((...args: unknown[]) => unknown) | undefined {
  if ((typeof rawApi !== "object" && typeof rawApi !== "function") || rawApi === null)
    return undefined;
  const candidate = Reflect.get(rawApi, method);
  return typeof candidate === "function" ? candidate : undefined;
}

class PywebviewBackendClient implements BackendClient {
  readonly #rawApi: unknown;
  readonly #timeoutMs: number;

  constructor(rawApi: unknown, timeoutMs: number) {
    this.#rawApi = rawApi;
    this.#timeoutMs = timeoutMs;
  }

  async #call<T>(
    method: string,
    args: readonly unknown[],
    guard: Guard<T>,
  ): Promise<BackendResult<T>> {
    const callable = rawMethod(this.#rawApi, method);
    if (!callable) {
      return backendFailure(
        "BRIDGE_METHOD_UNAVAILABLE",
        `Desktop backend method ${method} is unavailable`,
        { method },
      );
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new BridgeTimeoutError(method, this.#timeoutMs)),
          this.#timeoutMs,
        );
      });
      const raw = await Promise.race([
        Promise.resolve().then(() => Reflect.apply(callable, this.#rawApi, [...args])),
        timeout,
      ]);
      return normalizeResult(method, raw, guard);
    } catch (error) {
      if (error instanceof BridgeTimeoutError) {
        return backendFailure(
          "BRIDGE_CALL_TIMEOUT",
          `Desktop backend method ${method} timed out`,
          { method, timeout_ms: this.#timeoutMs },
        );
      }
      return backendFailure(
        "BRIDGE_CALL_FAILED",
        errorMessage(error, `Desktop backend method ${method} failed`),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  probeFile(path: string): Promise<BackendResult<DataPayload>> {
    return this.#call("probeFile", [path], isDataPayload);
  }

  probeAudioFile(path: string): Promise<BackendResult<DataPayload>> {
    return this.#call("probeAudioFile", [path], isDataPayload);
  }

  getWaveform(path: string): Promise<BackendResult<UrlPayload>> {
    return this.#call("getWaveform", [path], isUrlPayload);
  }

  getThumbnail(path: string): Promise<BackendResult<ThumbnailPayload>> {
    return this.#call("getThumbnail", [path], isThumbnailPayload);
  }

  getMediaUrl(path: string): Promise<BackendResult<UrlPayload>> {
    return this.#call("getMediaUrl", [path], isUrlPayload);
  }

  releaseMediaToken(token: string): Promise<BackendResult<EmptyPayload>> {
    return this.#call("releaseMediaToken", [token], isJsonObject);
  }

  createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>> {
    return this.#call("createPlan", [request], isDataPayload);
  }

  enqueueWithOptions(request: PlanRequest): Promise<BackendResult<JsonObject>> {
    return this.#call("enqueueWithOptions", [request], isJsonObject);
  }

  enqueueBatch(
    requests: readonly PlanRequest[],
  ): Promise<BackendResult<JsonObject>> {
    return this.#call("enqueueBatch", [requests], isJsonObject);
  }

  cancelItem(itemId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#call("cancelItem", [itemId], isJsonObject);
  }

  cancelAllItems(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("cancelAllItems", [], isJsonObject);
  }

  clearCompleted(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("clearCompleted", [], isJsonObject);
  }

  moveItem(
    itemId: string,
    newIndex: number,
  ): Promise<BackendResult<EmptyPayload>> {
    return this.#call("moveItem", [itemId, newIndex], isJsonObject);
  }

  retryItem(itemId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#call("retryItem", [itemId], isJsonObject);
  }

  stopAfterCurrent(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("stopAfterCurrent", [], isJsonObject);
  }

  getQueueState(): Promise<BackendResult<QueueState>> {
    return this.#call("getQueueState", [], isQueueState);
  }

  getDiagnostics(
    context?: DiagnosticsContext,
  ): Promise<BackendResult<DiagnosticsPayload>> {
    return this.#call(
      "getDiagnostics",
      context === undefined ? [] : [context],
      isDiagnosticsPayload,
    );
  }

  copyText(text: string): Promise<BackendResult<EmptyPayload>> {
    return this.#call("copyText", [text], isJsonObject);
  }

  openLogsFolder(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("openLogsFolder", [], isJsonObject);
  }

  openConfigFolder(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("openConfigFolder", [], isJsonObject);
  }

  getSettings(): Promise<BackendResult<Settings>> {
    return this.#call("getSettings", [], isSettings);
  }

  saveSettings(
    settings: SettingsPatch,
  ): Promise<BackendResult<EmptyPayload>> {
    return this.#call("saveSettings", [settings], isJsonObject);
  }

  refreshEncoders(): Promise<BackendResult<EncoderPayload>> {
    return this.#call("refreshEncoders", [], isEncoderPayload);
  }

  getProfilesJson(): Promise<BackendResult<readonly Profile[]>> {
    return this.#call("getProfilesJson", [], isJsonObjectArray);
  }

  createProfile(profile: ProfileInput): Promise<BackendResult<JsonObject>> {
    return this.#call("createProfile", [profile], isJsonObject);
  }

  updateProfile(
    profileId: string,
    profile: ProfileInput,
  ): Promise<BackendResult<JsonObject>> {
    return this.#call("updateProfile", [profileId, profile], isJsonObject);
  }

  deleteProfile(profileId: string): Promise<BackendResult<EmptyPayload>> {
    return this.#call("deleteProfile", [profileId], isJsonObject);
  }

  duplicateProfile(profileId: string): Promise<BackendResult<JsonObject>> {
    return this.#call("duplicateProfile", [profileId], isJsonObject);
  }

  importProfilesFromFile(path: string): Promise<BackendResult<JsonObject>> {
    return this.#call("importProfilesFromFile", [path], isJsonObject);
  }

  exportProfileToFile(
    path: string,
    profileId: string,
  ): Promise<BackendResult<EmptyPayload>> {
    return this.#call("exportProfileToFile", [path, profileId], isJsonObject);
  }

  checkForUpdates(): Promise<BackendResult<UpdateCheck>> {
    return this.#call("checkForUpdates", [], isUpdateCheck);
  }

  downloadUpdate(): Promise<BackendResult<JsonObject>> {
    return this.#call("downloadUpdate", [], isJsonObject);
  }

  getDownloadProgress(): Promise<BackendResult<DownloadProgress>> {
    return this.#call("getDownloadProgress", [], isDownloadProgress);
  }

  installUpdate(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("installUpdate", [], isJsonObject);
  }

  openOutputFolder(path: string): Promise<BackendResult<EmptyPayload>> {
    return this.#call("openOutputFolder", [path], isJsonObject);
  }

  installGenericSendto(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("installGenericSendto", [], isJsonObject);
  }

  removeGenericSendto(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("removeGenericSendto", [], isJsonObject);
  }

  installProfileSendto(
    profileId: string,
    action = "start",
  ): Promise<BackendResult<EmptyPayload>> {
    return this.#call(
      "installProfileSendto",
      [profileId, action],
      isJsonObject,
    );
  }

  removeProfileSendto(
    profileId: string,
  ): Promise<BackendResult<EmptyPayload>> {
    return this.#call("removeProfileSendto", [profileId], isJsonObject);
  }

  repairProfileSendto(
    profileId: string,
    action = "start",
  ): Promise<BackendResult<EmptyPayload>> {
    return this.#call(
      "repairProfileSendto",
      [profileId, action],
      isJsonObject,
    );
  }

  listSendtoShortcuts(): Promise<BackendResult<SendToShortcuts>> {
    return this.#call("listSendtoShortcuts", [], isSendToShortcuts);
  }

  getIpcFiles(): Promise<BackendResult<readonly string[]>> {
    return this.#call("getIpcFiles", [], isStringArray);
  }

  getIpcMetadata(): Promise<BackendResult<JsonObject>> {
    return this.#call("getIpcMetadata", [], isJsonObject);
  }

  closeWindow(): Promise<BackendResult<EmptyPayload>> {
    return this.#call("closeWindow", [], isJsonObject);
  }

  pickFiles(): Promise<BackendResult<FileSelection>> {
    return this.#call("pickFiles", [], isFileSelection);
  }

  pickAudioFiles(): Promise<BackendResult<FileSelection>> {
    return this.#call("pickAudioFiles", [], isFileSelection);
  }

  pickFolder(): Promise<BackendResult<PathSelection>> {
    return this.#call("pickFolder", [], isPathSelection);
  }

  pickFfmpegFile(): Promise<BackendResult<PathSelection>> {
    return this.#call("pickFfmpegFile", [], isPathSelection);
  }

  pickFfprobeFile(): Promise<BackendResult<PathSelection>> {
    return this.#call("pickFfprobeFile", [], isPathSelection);
  }

  pickImportFile(): Promise<BackendResult<PathSelection>> {
    return this.#call("pickImportFile", [], isPathSelection);
  }

  pickSaveFile(
    defaultName = "profiles.json",
  ): Promise<BackendResult<PathSelection>> {
    return this.#call("pickSaveFile", [defaultName], isPathSelection);
  }
}

class BridgeTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} timed out after ${timeoutMs} ms`);
  }
}

export function createPywebviewClient(
  rawApi: unknown,
  options: PywebviewClientOptions = {},
): BackendClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive finite number");
  return new PywebviewBackendClient(rawApi, timeoutMs);
}

interface PywebviewHost {
  pywebview: { api: unknown };
}

export function hasPywebviewApi(host: unknown): host is PywebviewHost {
  if (typeof host !== "object" || host === null) return false;
  const pywebview = Reflect.get(host, "pywebview");
  if (typeof pywebview !== "object" || pywebview === null) return false;
  const api = Reflect.get(pywebview, "api");
  return (typeof api === "object" && api !== null) || typeof api === "function";
}

export function createPywebviewClientFromWindow(
  host: Window,
  options: PywebviewClientOptions = {},
): BackendClient | undefined {
  if (!hasPywebviewApi(host)) return undefined;
  return createPywebviewClient(host.pywebview.api, options);
}
