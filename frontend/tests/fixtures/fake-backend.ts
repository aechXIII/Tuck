import type { Page } from "@playwright/test";

import type { BackendCall, BackendClient } from "../../src/backend/types.ts";
import { fixtureEngineScript } from "./fixture-engine.ts";

export interface FakeBackendCall extends BackendCall {}

declare global {
  interface Window {
    __tuckReleaseHeld?: (method: string, value?: unknown) => void;
  }
}

export interface FakeBackendFixture {
  timelineSprites?: {url: string; token: string};
  holdMethods?: readonly (keyof BackendClient)[];
  queueStateAfterEnqueue?: unknown;
  responseSequences?: Partial<Record<keyof BackendClient, unknown[]>>;
  responses: Partial<Record<keyof BackendClient, unknown>>;
  startup: {
    files: string[];
    sendto: null;
    task?: "compression" | "upscale" | "cut" | null;
  };
}

export function healthyBackendFixture(): FakeBackendFixture {
  return {
    responses: {
      getSettings: {
        available_encoders: [],
        check_updates: false,
        cut_suffix: "_cut",
        default_profile_id: "",
        inspector_start_panel: "export",
        last_compress_profile_id: "",
        last_inspector_panel: "export",
        last_task: "compression",
        last_upscale_profile_id: "",
        profiles: [],
        shortcut_overrides: {},
        timeline_height: 150,
        timeline_keyframes: true,
        timeline_snap: true,
      },
      listLuts: {luts:[]},
      clearLutHistory: {cleared:true},
      getIpcFiles: [],
      getIpcMetadata: {},
      getQueueState: { items: [] },
      // the native player's mix; the fixture engine records it and plays nothing
      compilePreviewMix: { data: { duration: 1, voices: [] } },
    },
    startup: { files: [], sendto: null },
  };
}

/**
 * Puts one readable video in the Library at launch. The Inspector's export controls only show
 * once the Library has a video, so specs about those controls start with one.
 */
export function withVideo(
  fixture: FakeBackendFixture,
  path = "C:\\videos\\Clip.mp4",
): FakeBackendFixture {
  fixture.startup.files = [path];
  fixture.responses.probeFile ??= {
    ok: true,
    data: { duration: 12, width: 1920, height: 1080, fps: 30, has_audio: true, video_codec: "h264", audio_codec: "aac", file_size: 15_000_000 },
  };
  return fixture;
}

export async function installFakeBackend(
  page: Page,
  fixture: FakeBackendFixture,
): Promise<void> {
  await page.addInitScript(
    ({ holdMethods, queueStateAfterEnqueue, responseSequences, responses, startup, timelineSprites }) => {
      const calls: BackendCall[] = [];
      const held = new Map<string, Array<(value: unknown) => void>>();
      let hasEnqueuedWork = false;
      const clone = (value: unknown): unknown =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      // the editor talks to a typed BackendClient that returns
      // { ok: true, value } | { ok: false, error: { code, message, details } }.
      // fixtures still describe responses in the old bridge shape: a bare payload
      // for success, or { ok: false, error: "message" } for a failure. translate
      // here so specs stay terse and the fake needs no separate adapter module.
      const toResult = (raw: unknown): unknown => {
        if (raw !== null && typeof raw === "object" && "ok" in raw) {
          const record = raw as Record<string, unknown>;
          if (record.ok === false) {
            const message =
              typeof record.error === "string" && record.error
                ? record.error
                : "Desktop backend call failed";
            const code =
              typeof record.code === "string" ? record.code : "BACKEND_REJECTED";
            const details =
              record.details !== null && typeof record.details === "object"
                ? (record.details as Record<string, unknown>)
                : {};
            return { ok: false, error: { code, message, details } };
          }
          const value: Record<string, unknown> = { ...record };
          delete value.ok;
          return { ok: true, value };
        }
        return { ok: true, value: raw };
      };
      const respond = async (
        method: keyof BackendClient,
        args: readonly unknown[],
      ): Promise<unknown> => {
        const clonedArgs = clone(args);
        calls.push({
          args: Array.isArray(clonedArgs) ? clonedArgs : [],
          method,
        });
        if (holdMethods?.includes(method)) {
          const released = await new Promise((resolve) => {
            const queue = held.get(method) ?? [];
            queue.push(resolve);
            held.set(method, queue);
          });
          if (released !== undefined) return toResult(clone(released));
        }
        if (method === "enqueueWithOptions" || method === "enqueueBatch") {
          hasEnqueuedWork = true;
        }
        if (
          method === "getQueueState" &&
          hasEnqueuedWork &&
          queueStateAfterEnqueue !== undefined
        ) {
          return toResult(clone(queueStateAfterEnqueue));
        }
        const sequence = responseSequences?.[method];
        if (sequence?.length) return toResult(clone(sequence.shift()));
        return toResult(clone(responses[method] ?? { ok: true }));
      };
      (
        window as Window & {
          __tuckReleaseHeld?: (method: string, value?: unknown) => void;
        }
      ).__tuckReleaseHeld = (method, value) => {
        const queue = held.get(method);
        const resolve = queue?.shift();
        resolve?.(value);
      };
      const api = {
        copyFile: (path: string) => respond("copyFile", [path]),
        probeFile: (path: string) => respond("probeFile", [path]),
        probeAudioFile: (path: string) => respond("probeAudioFile", [path]),
        getWaveform: (path: string, track?: number) =>
          respond("getWaveform", track ? [path, track] : [path]),
        getThumbnail: (path: string) => respond("getThumbnail", [path]),
        getTimelineFrames: async (path: string, start: number, step: number, count: number, mode: string, exact: boolean) => {
          const result = await respond("getTimelineFrames", [path,start,step,count,mode,exact]);
          if (!timelineSprites || (typeof result === "object" && result !== null && "ok" in result && result.ok === false)) return result;
          return {ok:true,value:{...timelineSprites,start,step,count,tile_width:150,tile_height:84,columns:count}};
        },
        openLocalDocument: (document: string) => respond("openLocalDocument", [document]),
        listLuts: () => respond("listLuts", []),
        clearLutHistory: () => respond("clearLutHistory", []),
        loadLut: (path: string) => respond("loadLut", [path]),
        pickLutFile: () => respond("pickLutFile", []),
        getMediaUrl: (path: string, track?: number) => respond("getMediaUrl", track === undefined ? [path] : [path, track]),
        releaseMediaToken: (token: string) => respond("releaseMediaToken", [token]),
        createPlan: (request: unknown) => respond("createPlan", [request]),
        compilePreviewMix: (request: unknown) => respond("compilePreviewMix", [request]),
        exportFrame: (request: unknown) => respond("exportFrame", [request]),
        analyzeCut: (path: string, workId: string) => respond("analyzeCut", [path, workId]),
        getCutAnalysis: (path: string) => respond("getCutAnalysis", [path]),
        cancelCutWork: (workId: string) => respond("cancelCutWork", [workId]),
        enqueueWithOptions: (request: unknown) => respond("enqueueWithOptions", [request]),
        enqueueBatch: (requests: unknown) => respond("enqueueBatch", [requests]),
        cancelItem: (itemId: string) => respond("cancelItem", [itemId]),
        removeItem: (itemId: string) => respond("removeItem", [itemId]),
        cancelAllItems: () => respond("cancelAllItems", []),
        clearCompleted: () => respond("clearCompleted", []),
        moveItem: (itemId: string, newIndex: number) => respond("moveItem", [itemId, newIndex]),
        retryItem: (itemId: string) => respond("retryItem", [itemId]),
        stopAfterCurrent: () => respond("stopAfterCurrent", []),
        getQueueState: () => respond("getQueueState", []),
        getDiagnostics: (context?: unknown) =>
          respond("getDiagnostics", context === undefined ? [] : [context]),
        copyText: (text: string) => respond("copyText", [text]),
        openLogsFolder: () => respond("openLogsFolder", []),
        openConfigFolder: () => respond("openConfigFolder", []),
        getSettings: () => respond("getSettings", []),
        saveSettings: (settings: unknown) => respond("saveSettings", [settings]),
        refreshEncoders: () => respond("refreshEncoders", []),
        getProfilesJson: () => respond("getProfilesJson", []),
        createProfile: (profile: unknown) => respond("createProfile", [profile]),
        updateProfile: (profileId: string, profile: unknown) =>
          respond("updateProfile", [profileId, profile]),
        deleteProfile: (profileId: string) => respond("deleteProfile", [profileId]),
        duplicateProfile: (profileId: string) => respond("duplicateProfile", [profileId]),
        importProfilesFromFile: (path: string) => respond("importProfilesFromFile", [path]),
        exportProfileToFile: (path: string, profileId: string) =>
          respond("exportProfileToFile", [path, profileId]),
        exportSettingsToFile: (path: string) => respond("exportSettingsToFile", [path]),
        importSettingsFromFile: (path: string) => respond("importSettingsFromFile", [path]),
        resetSettings: () => respond("resetSettings", []),
        checkForUpdates: () => respond("checkForUpdates", []),
        downloadUpdate: () => respond("downloadUpdate", []),
        getDownloadProgress: () => respond("getDownloadProgress", []),
        installUpdate: () => respond("installUpdate", []),
        openOutputFolder: (path: string) => respond("openOutputFolder", [path]),
        openExportFile: (itemId: string) => respond("openExportFile", [itemId]),
        startExportDrag: (itemId: string) => respond("startExportDrag", [itemId]),
        installGenericSendto: (kind: string) => respond("installGenericSendto", [kind]),
        removeGenericSendto: (kind: string) => respond("removeGenericSendto", [kind]),
        repairGenericSendto: (kind: string) => respond("repairGenericSendto", [kind]),
        installProfileSendto: (profileId: string, action = "start") =>
          respond("installProfileSendto", [profileId, action]),
        removeProfileSendto: (profileId: string) => respond("removeProfileSendto", [profileId]),
        repairProfileSendto: (profileId: string, action = "start") =>
          respond("repairProfileSendto", [profileId, action]),
        listSendtoShortcuts: () => respond("listSendtoShortcuts", []),
        getIpcFiles: () => respond("getIpcFiles", []),
        getIpcMetadata: () => respond("getIpcMetadata", []),
        closeWindow: () => respond("closeWindow", []),
        pickFiles: () => respond("pickFiles", []),
        pickAudioFiles: () => respond("pickAudioFiles", []),
        pickFolder: () => respond("pickFolder", []),
        pickFfmpegFile: () => respond("pickFfmpegFile", []),
        pickFfprobeFile: () => respond("pickFfprobeFile", []),
        pickImportFile: () => respond("pickImportFile", []),
        pickSaveFile: (defaultName = "profiles.json",format?: "json" | "png") => respond("pickSaveFile", format ? [defaultName,format] : [defaultName]),
        setInterfaceSize: (size: string) => respond("setInterfaceSize", [size]),
        notifyWhenUnfocused: (title: string, body: string) =>
          respond("notifyWhenUnfocused", [title, body]),
        setTaskbarProgress: (state: string, progress: number | null, flash: boolean) =>
          respond("setTaskbarProgress", [state, progress, flash]),
      };
      window.__tuckFakeBackendCalls = calls;
      // the app takes window.tuckBackendClient as a ready BackendClient before it
      // looks for the Tauri bridge, which is exactly what this fake provides
      window.tuckBackendClient = api as unknown as BackendClient;
      window.addEventListener(
        "load",
        () => {
          window.initApp?.(startup);
        },
        { once: true },
      );
    },
    {
      holdMethods: fixture.holdMethods,
      queueStateAfterEnqueue: fixture.queueStateAfterEnqueue,
      responseSequences: fixture.responseSequences,
      responses: fixture.responses,
      startup: fixture.startup,
      timelineSprites: fixture.timelineSprites,
    },
  );
  // TUCK_E2E_NATIVE_PREVIEW=engine plays every spec through the native player's fixture engine
  // instead of the HTML player. A spec with its own desktop shell stand-in keeps it, whether it
  // was added before this (left alone here) or after (it replaces this one)
  if (process.env.TUCK_E2E_NATIVE_PREVIEW === "engine") {
    const engine = fixtureEngineScript({ nativePreview: "engine" });
    await page.addInitScript({ content: `if (!("__TAURI_INTERNALS__" in window)) ${engine}` });
  }
}
