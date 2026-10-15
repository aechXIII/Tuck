import type { CutPlanPayload, CutPlanRequest, KeyframeCursor } from "./cutting-types.ts";
import type {
  BackendCall,
  BackendClient,
  BackendResult,
  FrameExportRequest,
  DiagnosticsContext,
  DataPayload,
  InterfaceSize,
  TaskbarProgressState,
  PlanRequest,
  ProfileInput,
  SendToKind,
  SettingsPatch,
} from "./types.ts";

type MethodResult<K extends keyof BackendClient> = Awaited<
  ReturnType<BackendClient[K]>
>;

export type FakeBackendResponses = {
  readonly [K in keyof BackendClient]?: MethodResult<K>;
};

export interface FakeBackend {
  readonly calls: BackendCall[];
  readonly client: BackendClient;
}

function success<T>(value: T): BackendResult<T> {
  return { ok: true, value };
}

function notConfigured(message: string): BackendResult<never> {
  return { ok: false, error: { code: "NOT_CONFIGURED", message, details: {} } };
}

class DeterministicFakeBackend implements BackendClient {
  readonly calls: BackendCall[] = [];
  readonly #responses: FakeBackendResponses;

  constructor(responses: FakeBackendResponses) {
    this.#responses = responses;
  }

  exportFrame(request: FrameExportRequest) {
    return this.#record("exportFrame",[request],this.#responses.exportFrame ?? notConfigured("Frame export is not configured"));
  }

  #record<K extends keyof BackendClient>(
    method: K,
    args: readonly unknown[],
    result: MethodResult<K>,
  ): Promise<MethodResult<K>> {
    this.calls.push({ method, args });
    return Promise.resolve(result);
  }

  probeFile(path: string) {
    return this.#record(
      "probeFile",
      [path],
      this.#responses.probeFile ?? success({ data: {} }),
    );
  }

  probeAudioFile(path: string) {
    return this.#record(
      "probeAudioFile",
      [path],
      this.#responses.probeAudioFile ?? success({ data: {} }),
    );
  }

  getWaveform(path: string, track?: number) {
    return this.#record(
      "getWaveform",
      track ? [path, track] : [path],
      this.#responses.getWaveform ?? success({ url: "" }),
    );
  }

  getTimelineFrames(path: string, start: number, step: number, count: number, mode: "center" | "whole", exact: boolean) {
    return this.#record("getTimelineFrames", [path, start, step, count, mode, exact],
      this.#responses.getTimelineFrames ?? notConfigured("Timeline pictures are not configured"));
  }

  openLocalDocument(document: "license" | "third_party_notices") {
    return this.#record("openLocalDocument", [document],
      this.#responses.openLocalDocument ?? success({}));
  }

  getThumbnail(path: string) {
    return this.#record(
      "getThumbnail",
      [path],
      this.#responses.getThumbnail ?? success({ thumbnail: "" }),
    );
  }

  listLuts() {
    return this.#record("listLuts", [], this.#responses.listLuts ?? success({luts:[]}));
  }

  clearLutHistory() {
    return this.#record("clearLutHistory", [], this.#responses.clearLutHistory ?? success({cleared:true as const}));
  }

  loadLut(path: string) {
    return this.#record("loadLut", [path], this.#responses.loadLut ?? success({path, name:"LUT", size:2, table_url:"http://127.0.0.1:1/token/table", token:"token"}));
  }

  pickLutFile() {
    return this.#record("pickLutFile", [], this.#responses.pickLutFile ?? success({path:""}));
  }

  getMediaUrl(path: string, track?: number) {
    return this.#record(
      "getMediaUrl",
      track === undefined ? [path] : [path, track],
      this.#responses.getMediaUrl ?? success({ url: "" }),
    );
  }

  releaseMediaToken(token: string) {
    return this.#record(
      "releaseMediaToken",
      [token],
      this.#responses.releaseMediaToken ?? success({}),
    );
  }

  analyzeCut(path: string, workId: string) {
    return this.#record(
      "analyzeCut",
      [path, workId],
      this.#responses.analyzeCut ?? notConfigured("No cut analysis fixture is configured."),
    );
  }

  getCutAnalysis(path: string, keyframes?: KeyframeCursor) {
    return this.#record(
      "getCutAnalysis",
      keyframes ? [path, keyframes] : [path],
      this.#responses.getCutAnalysis ?? {
        ok: true,
        value: {
          work_id: "",
          status: "missing",
          progress: null,
          coverage_end: { ticks: "0", time_base_num: 1, time_base_den: 1 },
          keyframes: [],
          issue: null,
          analysis: null,
        },
      },
    );
  }

  cancelCutWork(workId: string) {
    return this.#record(
      "cancelCutWork",
      [workId],
      this.#responses.cancelCutWork ?? success({ cancelled: false }),
    );
  }

  createPlan(request: CutPlanRequest): Promise<BackendResult<CutPlanPayload>>;
  createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>>;
  createPlan(request: PlanRequest): Promise<BackendResult<DataPayload>> {
    if (request.operation === "cut" && !this.#responses.createPlan) {
      return this.#record(
        "createPlan",
        [request],
        notConfigured("No cut plan fixture is configured."),
      );
    }
    return this.#record(
      "createPlan",
      [request],
      this.#responses.createPlan ?? success({ data: {} }),
    );
  }

  enqueueWithOptions(request: PlanRequest) {
    return this.#record(
      "enqueueWithOptions",
      [request],
      this.#responses.enqueueWithOptions ?? success({}),
    );
  }

  enqueueBatch(requests: readonly PlanRequest[]) {
    return this.#record(
      "enqueueBatch",
      [requests],
      this.#responses.enqueueBatch ?? success({}),
    );
  }

  removeItem(itemId: string) {
    return this.#record(
      "removeItem",
      [itemId],
      this.#responses.removeItem ?? success({}),
    );
  }

  cancelItem(itemId: string) {
    return this.#record(
      "cancelItem",
      [itemId],
      this.#responses.cancelItem ?? success({}),
    );
  }

  cancelAllItems() {
    return this.#record(
      "cancelAllItems",
      [],
      this.#responses.cancelAllItems ?? success({}),
    );
  }

  clearCompleted() {
    return this.#record(
      "clearCompleted",
      [],
      this.#responses.clearCompleted ?? success({}),
    );
  }

  moveItem(itemId: string, newIndex: number) {
    return this.#record(
      "moveItem",
      [itemId, newIndex],
      this.#responses.moveItem ?? success({}),
    );
  }

  retryItem(itemId: string) {
    return this.#record(
      "retryItem",
      [itemId],
      this.#responses.retryItem ?? success({}),
    );
  }

  stopAfterCurrent() {
    return this.#record(
      "stopAfterCurrent",
      [],
      this.#responses.stopAfterCurrent ?? success({}),
    );
  }

  getQueueState() {
    return this.#record(
      "getQueueState",
      [],
      this.#responses.getQueueState ?? success({ items: [] }),
    );
  }

  getDiagnostics(context?: DiagnosticsContext) {
    return this.#record(
      "getDiagnostics",
      context === undefined ? [] : [context],
      this.#responses.getDiagnostics ?? success({ text: "" }),
    );
  }

  copyText(text: string) {
    return this.#record(
      "copyText",
      [text],
      this.#responses.copyText ?? success({}),
    );
  }

  openLogsFolder() {
    return this.#record(
      "openLogsFolder",
      [],
      this.#responses.openLogsFolder ?? success({}),
    );
  }

  openConfigFolder() {
    return this.#record(
      "openConfigFolder",
      [],
      this.#responses.openConfigFolder ?? success({}),
    );
  }

  getSettings() {
    return this.#record(
      "getSettings",
      [],
      this.#responses.getSettings ?? success({ profiles: [] }),
    );
  }

  saveSettings(settings: SettingsPatch) {
    return this.#record(
      "saveSettings",
      [settings],
      this.#responses.saveSettings ?? success({}),
    );
  }

  refreshEncoders() {
    return this.#record(
      "refreshEncoders",
      [],
      this.#responses.refreshEncoders ?? success({ available_encoders: [] }),
    );
  }

  getProfilesJson() {
    return this.#record(
      "getProfilesJson",
      [],
      this.#responses.getProfilesJson ?? success([]),
    );
  }

  createProfile(profile: ProfileInput) {
    return this.#record(
      "createProfile",
      [profile],
      this.#responses.createProfile ?? success({}),
    );
  }

  updateProfile(profileId: string, profile: ProfileInput) {
    return this.#record(
      "updateProfile",
      [profileId, profile],
      this.#responses.updateProfile ?? success({}),
    );
  }

  deleteProfile(profileId: string) {
    return this.#record(
      "deleteProfile",
      [profileId],
      this.#responses.deleteProfile ?? success({}),
    );
  }

  duplicateProfile(profileId: string) {
    return this.#record(
      "duplicateProfile",
      [profileId],
      this.#responses.duplicateProfile ?? success({}),
    );
  }

  importProfilesFromFile(path: string) {
    return this.#record(
      "importProfilesFromFile",
      [path],
      this.#responses.importProfilesFromFile ?? success({}),
    );
  }

  exportProfileToFile(path: string, profileId: string) {
    return this.#record(
      "exportProfileToFile",
      [path, profileId],
      this.#responses.exportProfileToFile ?? success({}),
    );
  }

  exportSettingsToFile(path: string) {
    return this.#record(
      "exportSettingsToFile",
      [path],
      this.#responses.exportSettingsToFile ?? success({}),
    );
  }

  importSettingsFromFile(path: string) {
    return this.#record(
      "importSettingsFromFile",
      [path],
      this.#responses.importSettingsFromFile ?? success({ skipped: [] }),
    );
  }

  resetSettings() {
    return this.#record("resetSettings", [], this.#responses.resetSettings ?? success({}));
  }

  checkForUpdates() {
    return this.#record(
      "checkForUpdates",
      [],
      this.#responses.checkForUpdates ?? success({ available: false }),
    );
  }

  downloadUpdate() {
    return this.#record(
      "downloadUpdate",
      [],
      this.#responses.downloadUpdate ?? success({}),
    );
  }

  getDownloadProgress() {
    return this.#record(
      "getDownloadProgress",
      [],
      this.#responses.getDownloadProgress ?? success({ downloading: false }),
    );
  }

  installUpdate() {
    return this.#record(
      "installUpdate",
      [],
      this.#responses.installUpdate ?? success({}),
    );
  }

  openOutputFolder(path: string) {
    return this.#record(
      "openOutputFolder",
      [path],
      this.#responses.openOutputFolder ?? success({}),
    );
  }

  installGenericSendto(kind: SendToKind) {
    return this.#record(
      "installGenericSendto",
      [kind],
      this.#responses.installGenericSendto ?? success({}),
    );
  }

  removeGenericSendto(kind: SendToKind) {
    return this.#record(
      "removeGenericSendto",
      [kind],
      this.#responses.removeGenericSendto ?? success({}),
    );
  }

  repairGenericSendto(kind: SendToKind) {
    return this.#record(
      "repairGenericSendto",
      [kind],
      this.#responses.repairGenericSendto ?? success({}),
    );
  }

  installProfileSendto(profileId: string, action = "start") {
    return this.#record(
      "installProfileSendto",
      [profileId, action],
      this.#responses.installProfileSendto ?? success({}),
    );
  }

  removeProfileSendto(profileId: string) {
    return this.#record(
      "removeProfileSendto",
      [profileId],
      this.#responses.removeProfileSendto ?? success({}),
    );
  }

  repairProfileSendto(profileId: string, action = "start") {
    return this.#record(
      "repairProfileSendto",
      [profileId, action],
      this.#responses.repairProfileSendto ?? success({}),
    );
  }

  listSendtoShortcuts() {
    return this.#record(
      "listSendtoShortcuts",
      [],
      this.#responses.listSendtoShortcuts ?? success({ shortcuts: [] }),
    );
  }

  getIpcFiles() {
    return this.#record(
      "getIpcFiles",
      [],
      this.#responses.getIpcFiles ?? success([]),
    );
  }

  getIpcMetadata() {
    return this.#record(
      "getIpcMetadata",
      [],
      this.#responses.getIpcMetadata ?? success({}),
    );
  }

  closeWindow() {
    return this.#record(
      "closeWindow",
      [],
      this.#responses.closeWindow ?? success({}),
    );
  }

  pickFiles() {
    return this.#record(
      "pickFiles",
      [],
      this.#responses.pickFiles ?? success({ files: [] }),
    );
  }

  pickAudioFiles() {
    return this.#record(
      "pickAudioFiles",
      [],
      this.#responses.pickAudioFiles ?? success({ files: [] }),
    );
  }

  pickFolder() {
    return this.#record(
      "pickFolder",
      [],
      this.#responses.pickFolder ?? success({ path: "" }),
    );
  }

  pickFfmpegFile() {
    return this.#record(
      "pickFfmpegFile",
      [],
      this.#responses.pickFfmpegFile ?? success({ path: "" }),
    );
  }

  pickFfprobeFile() {
    return this.#record(
      "pickFfprobeFile",
      [],
      this.#responses.pickFfprobeFile ?? success({ path: "" }),
    );
  }

  pickImportFile() {
    return this.#record(
      "pickImportFile",
      [],
      this.#responses.pickImportFile ?? success({ path: "" }),
    );
  }

  pickSaveFile(defaultName = "profiles.json", format?: "json" | "png") {
    return this.#record(
      "pickSaveFile",
      format ? [defaultName,format] : [defaultName],
      this.#responses.pickSaveFile ?? success({ path: "" }),
    );
  }

  setInterfaceSize(size: InterfaceSize) {
    return this.#record("setInterfaceSize", [size], this.#responses.setInterfaceSize ?? success({}));
  }

  notifyWhenUnfocused(title: string, body: string) {
    return this.#record(
      "notifyWhenUnfocused",
      [title, body],
      this.#responses.notifyWhenUnfocused ?? success({ shown: false }),
    );
  }

  setTaskbarProgress(state: TaskbarProgressState, progress: number | null, flash: boolean) {
    return this.#record(
      "setTaskbarProgress",
      [state, progress, flash],
      this.#responses.setTaskbarProgress ?? success({}),
    );
  }
}

export function createFakeBackendClient(
  responses: FakeBackendResponses = {},
): FakeBackend {
  const backend = new DeterministicFakeBackend(responses);
  return { calls: backend.calls, client: backend };
}
