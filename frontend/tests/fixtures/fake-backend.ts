import type { Page } from "@playwright/test";

export interface FakeBackendCall {
  args: unknown[];
  method: string;
}

export interface FakeBackendFixture {
  responses: Record<string, unknown>;
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
    ({ responses, startup }) => {
      const calls: FakeBackendCall[] = [];
      const clone = (value: unknown): unknown =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value));
      const api = new Proxy<Record<string, unknown>>(
        {},
        {
          get: (_target, property) =>
            async (...args: unknown[]) => {
              const method = String(property);
              const clonedArgs = clone(args);
              calls.push({
                args: Array.isArray(clonedArgs) ? clonedArgs : [],
                method,
              });
              return clone(responses[method] ?? { ok: true });
            },
        },
      );
      const testWindow = window as Window & {
        __tuckFakeBackendCalls?: FakeBackendCall[];
        initApp?: (data: typeof startup) => void;
        pywebview?: { api: typeof api };
      };
      testWindow.__tuckFakeBackendCalls = calls;
      testWindow.pywebview = { api };
      window.addEventListener(
        "load",
        () => {
          testWindow.initApp?.(startup);
        },
        { once: true },
      );
    },
    fixture,
  );
}
