import type { CutAnalysisPayload, CutCancellation, CutPlanPayload, CutPlanRequest, KeyframeCursor } from "./cutting-types.ts";
import type { FrameExportRequest, FrameExportResult } from "./frame-types.ts";
import type { JoinCancellation, JoinStatus } from "./join-types.ts";
import type { PreviewMixPayload } from "./preview-mix-types.ts";
import type { SizeEstimateCancellation, SizeEstimatePayload } from "./size-estimate-types.ts";
import type { GifPreviewCancellation, GifPreviewPayload, GifRequest } from "./gif-types.ts";
import type { TimelineFramesPayload } from "./timeline-frame-types.ts";
export type { FrameExportRequest, FrameExportResult, VideoTransformJSON, LutSettingsJSON } from "./frame-types.ts";

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

/** The exports a whole-queue action sent back to the queue, in the order they will run. */
export interface QueuedIdsPayload extends JsonObject {
  readonly item_ids: readonly string[];
}

export interface Settings extends JsonObject {
  readonly profiles?: readonly Profile[];
  readonly cut_suffix?: string;
  readonly timeline_snap?: boolean;
  /** the Save as GIF settings last saved with */
  readonly gif_settings?: JsonObject;
  readonly timeline_keyframes?: boolean;
  readonly timeline_frames?: boolean;
  readonly timeline_preserve_source?: boolean;
  readonly timeline_frame_mode?: "center" | "whole";
  /** command id -> chosen key combos; an empty list means every key was removed */
  readonly shortcut_overrides?: Readonly<Record<string, readonly string[]>>;
  readonly accent_color?: AccentColor;
  readonly interface_size?: InterfaceSize;
  readonly text_size?: TextSize;
  readonly animations?: boolean;
  readonly time_format?: TimeFormat;
  readonly output_location?: OutputLocation;
  readonly output_subfolder?: string;
  readonly keep_file_dates?: boolean;
  readonly notify_when_done?: boolean;
  readonly keep_awake?: boolean;
  readonly background_exports?: boolean;
  /** take a video out of the Library once its export finishes */
  readonly remove_after_export?: boolean;
  readonly copy_finished_export?: boolean;
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

/** Hardware playback in Settings: `on` is saved for the next start, `running` is what this run started with. */
export interface HardwarePlayback {
  readonly on: boolean;
  readonly running: boolean;
}

export type AccentColor = "violet" | "blue" | "teal" | "green" | "amber" | "rose";
export type InterfaceSize = "compact" | "default" | "large";
export type TextSize = "default" | "large" | "extra_large";

/** What the taskbar button shows for the export queue. */
export type TaskbarProgressState = "none" | "normal" | "indeterminate" | "error";
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

/** The videos in the folders among some dropped or chosen paths. */
export interface FolderVideos extends JsonObject {
  /** the paths that are folders */
  readonly folders: readonly string[];
  readonly videos: readonly string[];
  /** the shell stopped looking early, so there are more videos than listed */
  readonly truncated: boolean;
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

export interface TrashResult extends JsonObject {
  readonly path: string;
  readonly outcome: "moved" | "no_trash" | "missing" | "failed";
}

export interface RenamedVideo extends JsonObject {
  readonly path: string;
}

export interface TenBitPayload extends JsonObject {
  readonly ten_bit: boolean;
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
  exportFrame(request: FrameExportRequest): Promise<BackendResult<FrameExportResult>>;
  /** a background read waits behind the video on screen and gives way to it */
  analyzeCut(path: string, workId: string, background?: boolean): Promise<BackendResult<CutAnalysisPayload>>;
  getCutAnalysis(path: string, keyframes?: KeyframeCursor): Promise<BackendResult<CutAnalysisPayload>>;
  cancelCutWork(workId: string): Promise<BackendResult<CutCancellation>>;
  /** starts joining videos, in this order, into one new file beside the first one */
  joinVideos(paths: readonly string[], workId: string): Promise<BackendResult<JoinStatus>>;
  getJoin(workId: string): Promise<BackendResult<JoinStatus>>;
  cancelJoin(workId: string): Promise<BackendResult<JoinCancellation>>;
  clearLutHistory(): Promise<BackendResult<LutHistoryClearedPayload>>;
  listLuts(): Promise<BackendResult<LutLibraryPayload>>;
  loadLut(path: string): Promise<BackendResult<LutPayload>>;
  probeFile(path: string): Promise<BackendResult<DataPayload>>;
  probeAudioFile(path: string): Promise<BackendResult<DataPayload>>;
  // track counts a video's audio tracks from 0; leaving it out asks for the first
  getWaveform(path: string, track?: number): Promise<BackendResult<UrlPayload>>;
  getThumbnail(path: string): Promise<BackendResult<ThumbnailPayload>>;
  getTimelineFrames(path: string, start: number, step: number, count: number, mode: "center" | "whole", exact: boolean): Promise<BackendResult<TimelineFramesPayload>>;
  getMediaUrl(path: string, track?: number): Promise<BackendResult<UrlPayload>>;
  releaseMediaToken(token: string): Promise<BackendResult<EmptyPayload>>;
  createPlan(request: CutPlanRequest): Promise<BackendResult<CutPlanPayload>>;
  createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>>;
  /** the native player's mix for the edit an export of `request` would make */
  /** encodes a few short pieces of a Quality export; a newer estimate or a cancel stops it */
  estimateSize(request: PlanRequest): Promise<BackendResult<SizeEstimatePayload>>;
  cancelSizeEstimate(): Promise<BackendResult<SizeEstimateCancellation>>;
  /** Save as GIF: makes the GIF the dialog shows; a newer preview or a cancel stops it */
  makeGifPreview(request: GifRequest): Promise<BackendResult<GifPreviewPayload>>;
  /** stops the preview being made and removes the one shown, as the dialog closes */
  cancelGifPreview(): Promise<BackendResult<GifPreviewCancellation>>;
  enqueueGif(request: GifRequest): Promise<BackendResult<JsonObject>>;
  compilePreviewMix(request: PlanRequest): Promise<BackendResult<PreviewMixPayload>>;
  enqueueWithOptions(request: PlanRequest): Promise<BackendResult<JsonObject>>;
  enqueueBatch(requests: readonly PlanRequest[]): Promise<BackendResult<JsonObject>>;
  cancelItem(itemId: string): Promise<BackendResult<EmptyPayload>>;
  // drops a finished, failed, cancelled or waiting export from the list; a running one must be cancelled first
  removeItem(itemId: string): Promise<BackendResult<EmptyPayload>>;
  cancelAllItems(): Promise<BackendResult<EmptyPayload>>;
  clearCompleted(): Promise<BackendResult<EmptyPayload>>;
  // completed and canceled exports; failed ones stay so they can be retried
  clearFinished(): Promise<BackendResult<EmptyPayload>>;
  moveItem(itemId: string, newIndex: number): Promise<BackendResult<EmptyPayload>>;
  retryItem(itemId: string): Promise<BackendResult<EmptyPayload>>;
  retryAllItems(): Promise<BackendResult<QueuedIdsPayload>>;
  // exports that came back paused after Tuck closed mid-batch
  resumeExports(): Promise<BackendResult<QueuedIdsPayload>>;
  stopAfterCurrent(): Promise<BackendResult<EmptyPayload>>;
  getQueueState(): Promise<BackendResult<QueueState>>;
  getDiagnostics(context?: DiagnosticsContext): Promise<BackendResult<DiagnosticsPayload>>;
  copyText(text: string): Promise<BackendResult<EmptyPayload>>;
  openLogsFolder(): Promise<BackendResult<EmptyPayload>>;
  openConfigFolder(): Promise<BackendResult<EmptyPayload>>;
  getSettings(): Promise<BackendResult<Settings>>;
  saveSettings(settings: SettingsPatch): Promise<BackendResult<EmptyPayload>>;
  refreshEncoders(): Promise<BackendResult<EncoderPayload>>;
  // one test frame the first time, then remembered by the backend
  checkTenBit(encoder: string): Promise<BackendResult<TenBitPayload>>;
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
  copyFile(path: string): Promise<BackendResult<EmptyPayload>>;
  /** puts several files on the clipboard as one copy, so a single paste brings them all */
  copyFiles(paths: readonly string[]): Promise<BackendResult<EmptyPayload>>;
  /** each video's outcome; a video that can't go to the Trash stays where it is, never deleted */
  moveVideosToTrash(paths: readonly string[]): Promise<BackendResult<readonly TrashResult[]>>;
  /** renames the video in its folder and gives back its new path */
  renameVideo(path: string, name: string): Promise<BackendResult<RenamedVideo>>;
  /** opens a finished export in the system's default app; named by queue id, never by path */
  openExportFile(itemId: string): Promise<BackendResult<EmptyPayload>>;
  /** drags a finished export out of the window as a file; false when the press already ended */
  startExportDrag(itemId: string): Promise<BackendResult<{ started: boolean }>>;
  /** drags several finished exports out as one drag of their files */
  startExportsDrag(itemIds: readonly string[]): Promise<BackendResult<{ started: boolean }>>;
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

export type LocalDocument = "license" | "third_party_notices";

export interface NativeBackendClient {
  openLocalDocument(document: LocalDocument): Promise<BackendResult<EmptyPayload>>;
  closeWindow(): Promise<BackendResult<EmptyPayload>>;
  pickLutFile(): Promise<BackendResult<PathSelection>>;
  pickFiles(): Promise<BackendResult<FileSelection>>;
  /** existing files copied in a file manager or as absolute paths; an empty list when there are none */
  readClipboardFiles(): Promise<BackendResult<FileSelection>>;
  pickAudioFiles(): Promise<BackendResult<FileSelection>>;
  pickFolder(): Promise<BackendResult<PathSelection>>;
  listFolderVideos(paths: readonly string[]): Promise<BackendResult<FolderVideos>>;
  pickFfmpegFile(): Promise<BackendResult<PathSelection>>;
  pickFfprobeFile(): Promise<BackendResult<PathSelection>>;
  pickImportFile(): Promise<BackendResult<PathSelection>>;
  pickSaveFile(defaultName?: string, format?: "json" | "png"): Promise<BackendResult<PathSelection>>;
  setInterfaceSize(size: InterfaceSize): Promise<BackendResult<EmptyPayload>>;
  hardwarePlayback(): Promise<BackendResult<HardwarePlayback>>;
  /** saves the choice for the next start; the running preview keeps its player */
  setHardwarePlayback(on: boolean): Promise<BackendResult<HardwarePlayback>>;
  /** restarts Tuck at the user's request; running exports stop, so ask about them first */
  restartTuck(): Promise<BackendResult<EmptyPayload>>;
  notifyWhenUnfocused(title: string, body: string): Promise<BackendResult<NotificationResult>>;
  setTaskbarProgress(state: TaskbarProgressState, progress: number | null, flash: boolean): Promise<BackendResult<EmptyPayload>>;
}

export interface BackendClient extends DomainBackendClient, NativeBackendClient {}

export interface BackendCall {
  args: readonly unknown[];
  method: keyof BackendClient;
}
