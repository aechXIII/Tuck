import { expect, test, type Page } from "@playwright/test";

interface ScreenTimes {
  created: number;
  shown: number | null;
}

// a stand-in for the desktop shell: just enough of Tauri's IPC for the page to start its backend
// and answer a close request. Its window never closes, as if the backend took long to stop
async function installShell(page: Page, options: { healthDelayMs: number; queueItems?: unknown[] }): Promise<void> {
  await page.addInitScript((settings) => {
    const callbacks = new Map<number, (message: unknown) => void>();
    const listeners: Array<{ event: string; handler: number }> = [];
    let nextCallback = 1;
    const calls: string[] = [];
    const screens: Record<string, ScreenTimes> = {};
    Reflect.set(window, "__shellCalls", calls);
    Reflect.set(window, "__screens", screens);
    Reflect.set(window, "__emitShellEvent", (event: string, payload: unknown) => {
      for (const listener of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id: listener.handler, payload });
      }
    });
    new MutationObserver(() => {
      for (const id of ["backend-connecting", "app-closing"]) {
        const screen = document.getElementById(id);
        if (!screen) continue;
        const times = (screens[id] ??= { created: performance.now(), shown: null });
        if (!screen.hidden && times.shown === null) times.shown = performance.now();
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    Reflect.set(window, "__TAURI_INTERNALS__", {
      transformCallback: (callback: (message: unknown) => void) => {
        const id = nextCallback++;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        calls.push(command);
        if (command === "plugin:event|listen") {
          listeners.push({ event: String(args.event), handler: Number(args.handler) });
          return listeners.length;
        }
        if (command === "platform_capabilities") {
          return {
            platform: "windows", architecture: "x86_64", customTitleBar: true,
            sendToIntegration: true, publicCli: true, automaticUpdater: true,
            hardwareAcceleration: true, packaged: false,
          };
        }
        if (command === "get_startup_files") return { files: [], task: null };
        if (command === "backend_request") {
          const name = (args.command as { command?: string } | undefined)?.command;
          if (name === "health") {
            await new Promise((resolve) => setTimeout(resolve, settings.healthDelayMs));
            return { ok: true, status: "ready" };
          }
          if (name === "get_queue_state") return { items: settings.queueItems, current_id: null, pending_ids: [] };
          // the editor's own requests wait, as they would on a busy backend
          return new Promise(() => undefined);
        }
        if (command === "confirm_close") return new Promise(() => undefined);
        return null;
      },
    });
  }, { healthDelayMs: options.healthDelayMs, queueItems: options.queueItems ?? [] });
}

const screenTimes = (page: Page, id: string) =>
  page.evaluate((screen) => (Reflect.get(window, "__screens") as Record<string, ScreenTimes>)[screen] ?? null, id);
const called = (page: Page, command: string) =>
  page.evaluate((name) => (Reflect.get(window, "__shellCalls") as string[]).includes(name), command);

async function startQuickly(page: Page, queueItems: unknown[] = []): Promise<void> {
  await installShell(page, { healthDelayMs: 0, queueItems });
  await page.goto("/");
  await expect.poll(() => called(page, "get_startup_files")).toBe(true);
  await expect(page.locator("#editor-shell")).not.toHaveAttribute("inert", "");
}

test("a quick start goes straight to the editor without a starting screen", async ({ page }) => {
  await startQuickly(page);
  // well past the moment the screen would have appeared
  await page.waitForTimeout(800);
  expect((await screenTimes(page, "backend-connecting"))?.shown ?? null).toBeNull();
  await expect(page.locator("#backend-connecting")).toHaveCount(0);
});

test("a slow start keeps the editor out of reach and shows the starting screen after a moment", async ({ page }) => {
  await installShell(page, { healthDelayMs: 2_000 });
  await page.goto("/");
  const screen = page.locator("#backend-connecting");
  await expect(screen).toBeAttached();
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");

  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Starting Tuck…");
  const times = await screenTimes(page, "backend-connecting");
  expect(times?.shown).not.toBeNull();
  expect(times!.shown! - times!.created).toBeGreaterThanOrEqual(450);

  await expect(screen).toHaveCount(0);
  await expect(page.locator("#editor-shell")).not.toHaveAttribute("inert", "");
});

test("a plain close shows its screen only if the window is still open after a moment", async ({ page }) => {
  await startQuickly(page);
  await page.evaluate(() => (Reflect.get(window, "__emitShellEvent") as (event: string, payload: unknown) => void)("close-requested", { request: 1 }));
  await expect.poll(() => called(page, "confirm_close")).toBe(true);
  const screen = page.locator("#app-closing");
  await expect(screen).toBeAttached();
  // nothing new can start while Tuck closes, even before the screen shows
  await expect(page.locator("#editor-shell")).toHaveAttribute("inert", "");

  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Closing Tuck…");
  const times = await screenTimes(page, "app-closing");
  expect(times!.shown! - times!.created).toBeGreaterThanOrEqual(450);
});

test("stopping exports to close shows its screen at once", async ({ page }) => {
  await startQuickly(page, [{ id: "a", state: "running" }]);
  await page.evaluate(() => (Reflect.get(window, "__emitShellEvent") as (event: string, payload: unknown) => void)("close-requested", { request: 1 }));
  await page.getByRole("button", { name: "Close anyway", exact: true }).click();
  const screen = page.locator("#app-closing");
  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Stopping exports…");
  const times = await screenTimes(page, "app-closing");
  expect(times!.shown! - times!.created).toBeLessThan(100);
});
