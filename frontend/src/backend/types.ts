import type { CutAnalysisPayload, CutCancellation, CutPlanPayload, CutPlanRequest, KeyframeCursor } from "./cutting-types.ts";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface BackendError {
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

export type BackendResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: BackendError };

export type EmptyPayload = JsonObject;
export type PlanRequest = JsonObject;
export type SettingsPatch = JsonObject;
export type ProfileInput = JsonObject;
export type DiagnosticsContext = JsonObject;

export interface DataPayload extends JsonObject {
  readonly data: JsonObject;
  readonly _request_id?: number;
}

export interface UrlPayload extends JsonObject {
  readonly token?: string;
  readonly url: string;
}

export interface ThumbnailPayload extends JsonObject {
  readonly thumbnail: string;
}

export interface QueueState extends JsonObject {
  readonly items: readonly JsonObject[];
}

export interface Settings extends JsonObject {
  readonly profiles?: readonly Profile[];
  readonly cut_suffix?: string;
  readonly timeline_snap?: boolean;
  readonly timeline_keyframes?: boolean;
  /** command id -> chosen key combos; an empty list means every key was removed */
  readonly shortcut_overrides?: Readonly<Record<string, readonly string[]>>;
  readonly accent_color?: AccentColor;
  readonly interface_size?: InterfaceSize;
  readonly animations?: boolean;
  readonly time_format?: TimeFormat;
  readonly output_location?: OutputLocation;
  readonly output_subfolder?: string;
  readonly keep_file_dates?: boolean;
  readonly notify_when_done?: boolean;
  readonly keep_awake?: boolean;
  readonly background_exports?: boolean;
  readonly reopen_last_videos?: boolean;
  readonly last_session_files?: readonly string[];
  readonly loop_playback?: boolean;
  readonly timeline_style?: TimelineStyle;
  /** how far Shift with an arrow key skips: "1", "3", "5", or "10" seconds */
  readonly skip_seconds?: string;
  readonly name_taken?: "number" | "replace";
  /** profiles listed first in the profile picker */
  readonly pinned_profile_ids?: readonly string[];
  /** profiles left out of the profile picker */
  readonly hidden_profile_ids?: readonly string[];
}

export type AccentColor = "violet" | "blue" | "teal" | "green" | "amber" | "rose";
export type InterfaceSize = "compact" | "default" | "large";
export type TimelineStyle = "graphite" | "violet";
export type TimeFormat = "seconds" | "timecode" | "frames";
export type OutputLocation = "source" | "subfolder" | "folder";

export interface SettingsImport extends JsonObject {
  /** paths from the backup that don't exist on this computer and were left as they were */
  readonly skipped?: readonly string[];
}

export interface NotificationResult extends JsonObject {
  readonly shown: boolean;
}

export interface Profile extends JsonObject {
  readonly name?: string;
  readonly profile_id?: string;
  readonly workflow?: string;
}

export interface FileSelection extends JsonObject {
  readonly files: readonly string[];
}

export interface PathSelection extends JsonObject {
  readonly path: string;
}

export interface DiagnosticsPayload extends JsonObject {
  readonly text: string;
}

export interface EncoderPayload extends JsonObject {
  readonly available_encoders: readonly JsonValue[];
}

export interface DownloadProgress extends JsonObject {
  readonly done?: boolean;
  readonly downloading: boolean;
  readonly error?: string;
  readonly progress?: number;
}

export interface UpdateCheck extends JsonObject {
  readonly available: boolean;
  readonly notes?: string;
  readonly version?: string;
}

/** The generic Send To shortcuts Tuck manages one at a time. */
export type SendToKind = "open" | "compress" | "upscale" | "cut";

export interface SendToShortcut extends JsonObject {
  readonly name: string;
  readonly path: string;
  readonly type: string;
  readonly status: string;
  /** set on generic shortcuts */
  readonly kind?: SendToKind;
  /** set on profile shortcuts */
  readonly profile_id?: string;
}

export interface SendToShortcuts extends JsonObject {
  readonly shortcuts: readonly SendToShortcut[];
}

export interface LutEntry extends JsonObject {
  readonly path: string;
  readonly name: string;
}

export interface LutLibraryPayload extends JsonObject {
  readonly luts: readonly LutEntry[];
}

export interface LutHistoryClearedPayload extends JsonObject {
  readonly cleared: true;
}

export interface LutPayload extends JsonObject {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly table_url: string;
  readonly token: string;
}

export interface DomainBackendClient {
  analyzeCut(path: string, workId: string): Promise<BackendResult<CutAnalysisPayload>>;
  getCutAnalysis(path: string, keyframes?: KeyframeCursor): Promise<BackendResult<CutAnalysisPayload>>;
  cancelCutWork(workId: string): Promise<BackendResult<CutCancellation>>;
  clearLutHistory(): Promise<BackendResult<LutHistoryClearedPayload>>;
  listLuts(): Promise<BackendResult<LutLibraryPayload>>;
  loadLut(path: string): Promise<BackendResult<LutPayload>>;
  probeFile(path: string): Promise<BackendResult<DataPayload>>;
  probeAudioFile(path: string): Promise<BackendResult<DataPayload>>;
  getWaveform(path: string): Promise<BackendResult<UrlPayload>>;
  getThumbnail(path: string): Promise<BackendResult<ThumbnailPayload>>;
  getMediaUrl(path: string): Promise<BackendResult<UrlPayload>>;
  releaseMediaToken(token: string): Promise<BackendResult<EmptyPayload>>;
  createPlan(request: CutPlanRequest): Promise<BackendResult<CutPlanPayload>>;
  createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>>;
  enqueueWithOptions(request: PlanRequest): Promise<BackendResult<JsonObject>>;
  enqueueBatch(requests: readonly PlanRequest[]): Promise<BackendResult<JsonObject>>;
  cancelItem(itemId: string): Promise<BackendResult<EmptyPayload>>;
  cancelAllItems(): Promise<BackendResult<EmptyPayload>>;
  clearCompleted(): Promise<BackendResult<EmptyPayload>>;
  moveItem(itemId: string, newIndex: number): Promise<BackendResult<EmptyPayload>>;
  retryItem(itemId: string): Promise<BackendResult<EmptyPayload>>;
  stopAfterCurrent(): Promise<BackendResult<EmptyPayload>>;
  getQueueState(): Promise<BackendResult<QueueState>>;
  getDiagnostics(context?: DiagnosticsContext): Promise<BackendResult<DiagnosticsPayload>>;
  copyText(text: string): Promise<BackendResult<EmptyPayload>>;
  openLogsFolder(): Promise<BackendResult<EmptyPayload>>;
  openConfigFolder(): Promise<BackendResult<EmptyPayload>>;
  getSettings(): Promise<BackendResult<Settings>>;
  saveSettings(settings: SettingsPatch): Promise<BackendResult<EmptyPayload>>;
  refreshEncoders(): Promise<BackendResult<EncoderPayload>>;
  getProfilesJson(): Promise<BackendResult<readonly Profile[]>>;
  createProfile(profile: ProfileInput): Promise<BackendResult<JsonObject>>;
  updateProfile(profileId: string, profile: ProfileInput): Promise<BackendResult<JsonObject>>;
  deleteProfile(profileId: string): Promise<BackendResult<EmptyPayload>>;
  duplicateProfile(profileId: string): Promise<BackendResult<JsonObject>>;
  importProfilesFromFile(path: string): Promise<BackendResult<JsonObject>>;
  exportSettingsToFile(path: string): Promise<BackendResult<EmptyPayload>>;
  importSettingsFromFile(path: string): Promise<BackendResult<SettingsImport>>;
  resetSettings(): Promise<BackendResult<EmptyPayload>>;
  exportProfileToFile(path: string, profileId: string): Promise<BackendResult<EmptyPayload>>;
  checkForUpdates(): Promise<BackendResult<UpdateCheck>>;
  downloadUpdate(): Promise<BackendResult<JsonObject>>;
  getDownloadProgress(): Promise<BackendResult<DownloadProgress>>;
  installUpdate(): Promise<BackendResult<EmptyPayload>>;
  openOutputFolder(path: string): Promise<BackendResult<EmptyPayload>>;
  installGenericSendto(kind: SendToKind): Promise<BackendResult<EmptyPayload>>;
  removeGenericSendto(kind: SendToKind): Promise<BackendResult<EmptyPayload>>;
  repairGenericSendto(kind: SendToKind): Promise<BackendResult<EmptyPayload>>;
  installProfileSendto(profileId: string, action?: string): Promise<BackendResult<EmptyPayload>>;
  removeProfileSendto(profileId: string): Promise<BackendResult<EmptyPayload>>;
  repairProfileSendto(profileId: string, action?: string): Promise<BackendResult<EmptyPayload>>;
  listSendtoShortcuts(): Promise<BackendResult<SendToShortcuts>>;
  getIpcFiles(): Promise<BackendResult<readonly string[]>>;
  getIpcMetadata(): Promise<BackendResult<JsonObject>>;
}

export interface NativeBackendClient {
  closeWindow(): Promise<BackendResult<EmptyPayload>>;
  pickLutFile(): Promise<BackendResult<PathSelection>>;
  pickFiles(): Promise<BackendResult<FileSelection>>;
  pickAudioFiles(): Promise<BackendResult<FileSelection>>;
  pickFolder(): Promise<BackendResult<PathSelection>>;
  pickFfmpegFile(): Promise<BackendResult<PathSelection>>;
  pickFfprobeFile(): Promise<BackendResult<PathSelection>>;
  pickImportFile(): Promise<BackendResult<PathSelection>>;
  pickSaveFile(defaultName?: string): Promise<BackendResult<PathSelection>>;
  setInterfaceSize(size: InterfaceSize): Promise<BackendResult<EmptyPayload>>;
  notifyWhenUnfocused(title: string, body: string): Promise<BackendResult<NotificationResult>>;
}

export interface BackendClient extends DomainBackendClient, NativeBackendClient {}

export interface BackendCall {
  args: readonly unknown[];
  method: keyof BackendClient;
}
