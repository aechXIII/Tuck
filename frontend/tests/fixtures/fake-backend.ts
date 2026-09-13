import type { Page } from "@playwright/test";

import type { BackendCall, BackendClient } from "../../src/backend/types.ts";

export interface FakeBackendCall extends BackendCall {}

export interface FakeBackendFixture {
  holdMethods?: readonly (keyof BackendClient)[];
  queueStateAfterEnqueue?: unknown;
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
    ({ holdMethods, queueStateAfterEnqueue, responseSequences, responses, startup }) => {
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
    },
  );
}
