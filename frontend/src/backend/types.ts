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
  readonly error?: string;
  readonly notes?: string;
  readonly size?: number;
  readonly size_mb?: number;
  readonly version?: string;
}

export interface SendToShortcuts extends JsonObject {
  readonly shortcuts: readonly JsonObject[];
}

export interface DomainBackendClient {
  probeFile(path: string): Promise<BackendResult<DataPayload>>;
  probeAudioFile(path: string): Promise<BackendResult<DataPayload>>;
  getWaveform(path: string): Promise<BackendResult<UrlPayload>>;
  getThumbnail(path: string): Promise<BackendResult<ThumbnailPayload>>;
  getMediaUrl(path: string): Promise<BackendResult<UrlPayload>>;
  releaseMediaToken(token: string): Promise<BackendResult<EmptyPayload>>;
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
  exportProfileToFile(path: string, profileId: string): Promise<BackendResult<EmptyPayload>>;
  checkForUpdates(): Promise<BackendResult<UpdateCheck>>;
  downloadUpdate(): Promise<BackendResult<JsonObject>>;
  getDownloadProgress(): Promise<BackendResult<DownloadProgress>>;
  installUpdate(): Promise<BackendResult<EmptyPayload>>;
  openOutputFolder(path: string): Promise<BackendResult<EmptyPayload>>;
  installGenericSendto(): Promise<BackendResult<EmptyPayload>>;
  removeGenericSendto(): Promise<BackendResult<EmptyPayload>>;
  installProfileSendto(profileId: string, action?: string): Promise<BackendResult<EmptyPayload>>;
  removeProfileSendto(profileId: string): Promise<BackendResult<EmptyPayload>>;
  repairProfileSendto(profileId: string, action?: string): Promise<BackendResult<EmptyPayload>>;
  listSendtoShortcuts(): Promise<BackendResult<SendToShortcuts>>;
  getIpcFiles(): Promise<BackendResult<readonly string[]>>;
  getIpcMetadata(): Promise<BackendResult<JsonObject>>;
}

export interface NativeBackendClient {
  closeWindow(): Promise<BackendResult<EmptyPayload>>;
  pickFiles(): Promise<BackendResult<FileSelection>>;
  pickAudioFiles(): Promise<BackendResult<FileSelection>>;
  pickFolder(): Promise<BackendResult<PathSelection>>;
  pickFfmpegFile(): Promise<BackendResult<PathSelection>>;
  pickFfprobeFile(): Promise<BackendResult<PathSelection>>;
  pickImportFile(): Promise<BackendResult<PathSelection>>;
  pickSaveFile(defaultName?: string): Promise<BackendResult<PathSelection>>;
}

export interface BackendClient extends DomainBackendClient, NativeBackendClient {}

export interface BackendCall {
  args: readonly unknown[];
  method: keyof BackendClient;
}
