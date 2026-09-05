import assert from "node:assert/strict";
import test from "node:test";

import { installPanels, type PanelsHost } from "../../src/features/panels/panels.ts";
import type { BackendClient, BackendResult, EmptyPayload } from "../../src/backend/types.ts";
import { createFakeBackendClient } from "../../src/backend/fake.ts";

function fakeElement() {
  return {
    classList: {
      add() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    inert: false,
    offsetParent: null,
    isConnected: true,
    focus() {},
    removeAttribute() {},
    setAttribute() {},
    querySelectorAll() {
      return [];
    },
  };
}

test("workspace resize is safe before the later timeline script loads", () => {
  const listeners: Record<string, Array<() => void>> = {};
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const body = fakeElement();

  const api = installPanels({
    byId: ((id: string) => {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id) as unknown as HTMLElement;
    }) as PanelsHost["byId"],
    document: {
      activeElement: null,
      body,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Document,
    window: {
      innerWidth: 960,
      addEventListener(type: string, listener: () => void) {
        (listeners[type] ??= []).push(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        listeners[type] = (listeners[type] ?? []).filter((item) => item !== listener);
      },
    } as unknown as Window & typeof globalThis,
    clips: () => ({}),
    selPath: () => null,
    appSettings: {},
    backend: createFakeBackendClient({}).client,
    toast() {},
    formatTime: (seconds) => String(seconds),
    formatBytes: (bytes) => String(bytes),
    errorSummary: (error) => error,
    retryProbeClip() {},
    clipDetails: {
      render() {},
      sourceFileRows: () => [],
    },
  });

  assert.doesNotThrow(() => {
    for (const listener of listeners.resize ?? []) listener();
  });
  assert.equal(api.getWorkspaceViewportMode(), "overlay");
  api.dispose();
});

test("selecting an Inspector tab remembers the user-facing panel name", async () => {
  const elements = new Map<string, ReturnType<typeof fakeElement>>();
  const saved: Array<Record<string, unknown>> = [];
  const appSettings: Record<string, unknown> = {};
  const backend: Pick<BackendClient, "saveSettings"> = {
    async saveSettings(settings) {
      saved.push(settings);
      const result: BackendResult<EmptyPayload> = { ok: true, value: {} };
      return result;
    },
  };

  const api = installPanels({
    byId: ((id: string) => {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id) as unknown as HTMLElement;
    }) as PanelsHost["byId"],
    document: {
      activeElement: null,
      body: fakeElement(),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Document,
    window: {
      innerWidth: 1240,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Window & typeof globalThis,
    clips: () => ({}),
    selPath: () => null,
    appSettings,
    backend,
    toast() {},
    formatTime: (seconds) => String(seconds),
    formatBytes: (bytes) => String(bytes),
    errorSummary: (error) => error,
    retryProbeClip() {},
    clipDetails: {
      render() {},
      sourceFileRows: () => [],
    },
  });

  api.setInspectorTab("export");
  await api.inspectorSettingsSave;

  assert.equal(appSettings.last_inspector_panel, "export");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.last_inspector_panel, "export");
  api.dispose();
});
