import type { Page } from "@playwright/test";

import type { BackendCall, BackendClient } from "../../src/backend/types.ts";

export interface FakeBackendCall extends BackendCall {}

export interface FakeBackendFixture {
  responseSequences?: Partial<Record<keyof BackendClient, unknown[]>>;
  responses: Partial<Record<keyof BackendClient, unknown>>;
  startup: {
    files: string[];
    sendto: null;
  };
}

export function healthyBackendFixture(): FakeBackendFixture {
  return {
    responses: {
      getSettings: {
        available_encoders: [],
        check_updates: false,
        default_profile_id: "",
        inspector_start_panel: "export",
        last_compress_profile_id: "",
        last_inspector_panel: "export",
        last_task: "compression",
        last_upscale_profile_id: "",
        profiles: [],
        timeline_height: 150,
      },
      getIpcFiles: [],
      getIpcMetadata: {},
      getQueueState: { items: [] },
    },
    startup: { files: [], sendto: null },
  };
}

export async function installFakeBackend(
  page: Page,
  fixture: FakeBackendFixture,
): Promise<void> {
  await page.addInitScript(
    ({ responseSequences, responses, startup }) => {
      const calls: BackendCall[] = [];
      const clone = (value: unknown): unknown =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      const respond = async (
        method: keyof BackendClient,
        args: readonly unknown[],
      ): Promise<unknown> => {
        const clonedArgs = clone(args);
        calls.push({
          args: Array.isArray(clonedArgs) ? clonedArgs : [],
          method,
        });
        const sequence = responseSequences?.[method];
        if (sequence?.length) return clone(sequence.shift());
        return clone(responses[method] ?? { ok: true });
      };
      const api = {
        probeFile: (path: string) => respond("probeFile", [path]),
        probeAudioFile: (path: string) => respond("probeAudioFile", [path]),
        getWaveform: (path: string) => respond("getWaveform", [path]),
        getThumbnail: (path: string) => respond("getThumbnail", [path]),
        getMediaUrl: (path: string) => respond("getMediaUrl", [path]),
        releaseMediaToken: (token: string) => respond("releaseMediaToken", [token]),
        createPlan: (request: unknown) => respond("createPlan", [request]),
        enqueueWithOptions: (request: unknown) => respond("enqueueWithOptions", [request]),
        enqueueBatch: (requests: unknown) => respond("enqueueBatch", [requests]),
        cancelItem: (itemId: string) => respond("cancelItem", [itemId]),
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
        checkForUpdates: () => respond("checkForUpdates", []),
        downloadUpdate: () => respond("downloadUpdate", []),
        getDownloadProgress: () => respond("getDownloadProgress", []),
        installUpdate: () => respond("installUpdate", []),
        openOutputFolder: (path: string) => respond("openOutputFolder", [path]),
        installGenericSendto: () => respond("installGenericSendto", []),
        removeGenericSendto: () => respond("removeGenericSendto", []),
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
        pickSaveFile: (defaultName = "profiles.json") => respond("pickSaveFile", [defaultName]),
      };
      window.__tuckFakeBackendCalls = calls;
      window.pywebview = { api };
      window.addEventListener(
        "load",
        () => {
          window.initApp?.(startup);
        },
        { once: true },
      );
    },
    fixture,
  );
}
