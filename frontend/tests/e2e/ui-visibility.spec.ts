import {expect, test, type Page} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";

const source = "C:/videos/Morning ride.mp4";

async function start(page: Page, settings: Record<string, unknown> = {}, profiles: unknown[] = []) {
  const fixture = healthyBackendFixture();
  fixture.startup.files = [source];
  fixture.responses.probeFile = {data:{duration:12,width:1920,height:1080,fps:30,has_audio:true,video_codec:"h264",audio_codec:"aac",file_size:15000000}};
  fixture.responses.getSettings = {...fixture.responses.getSettings as object, profiles, ...settings};
  fixture.responses.saveSettings = {ok:true};
  await installFakeBackend(page, fixture);
  // the sidecar reads saved settings back; the fake returns its fixture unless told otherwise
  await page.addInitScript(() => {
    const backend = window.tuckBackendClient!;
    let saved: Record<string, unknown> = {};
    const get = backend.getSettings.bind(backend);
    const save = backend.saveSettings.bind(backend);
    backend.getSettings = async () => {
      const result = await get();
      return result.ok ? {...result, value:{...result.value, ...saved} as typeof result.value} : result;
    };
    backend.saveSettings = async (settings) => {
      saved = {...saved, ...(settings as Record<string, unknown>)};
      return save(settings);
    };
  });
  await page.goto("/");
  await expect(page.locator(`[data-clip-path="${source}"]`)).toBeVisible();
}

test("hidden parts leave the editor", async ({page}) => {
  await start(page, {hidden_ui:["upscale", "cut", "panel_audio", "audio_editing", "frame_blending", "lut"]});
  await expect(page.locator("#task-wf")).toBeHidden();
  await expect(page.locator("#insp-tab-audio")).toBeHidden();
  await expect(page.locator("#insp-tab-edit")).toBeVisible();
  await expect(page.locator(".lib-tabs")).toBeHidden();
  await expect(page.locator("#audio-add")).toBeHidden();
  await expect(page.locator("#frame-blending-panel")).toBeHidden();
  await expect(page.locator("#lut-panel")).toBeHidden();
  await expect(page.getByRole("button", {name:"Compress selected", exact:true})).toBeVisible();
});

test("an effect a profile turns on stays visible while hidden", async ({page}) => {
  await start(page, {hidden_ui:["frame_blending"], default_profile_id:"blend", last_compress_profile_id:"blend"}, [
    {profile_id:"blend", name:"Blend", workflow:"compression", frame_blending:{enabled:true, amount:1, curve:"box", sigma:0.3, custom_weights:[], linear_light:false}},
  ]);
  await expect(page.locator("#frame-blending-panel")).toBeVisible();
});

test("Settings keeps one task on and applies what is hidden", async ({page}) => {
  await start(page);
  await page.getByRole("button", {name:"Settings"}).first().click();
  const compress = page.getByRole("switch", {name:"Compress"});
  const upscale = page.getByRole("switch", {name:"Upscale"});
  const cut = page.getByRole("switch", {name:"Lossless cut"});
  await upscale.uncheck();
  await cut.uncheck();
  await expect(compress).toBeDisabled();
  await expect(page.locator('#set-start-task option[value="cut"]')).toBeDisabled();
  await page.locator("#set-start-task").selectOption("compression");
  await page.getByRole("switch", {name:"Transform"}).uncheck();
  await expect(page.locator('#set-inspector-start option[value="video"]')).toBeDisabled();
  await page.locator('[data-settings-click="save-general"]').click();
  const saved = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0]);
  expect(saved).toMatchObject({hidden_ui:["upscale", "cut", "panel_video"], start_task:"compression"});
  await page.keyboard.press("Escape");
  await expect(page.locator("#task-wf")).toBeHidden();
  await expect(page.locator("#insp-tab-edit")).toBeHidden();
});

test("Tuck opens in the start task and a shortcut can ask for another", async ({page}) => {
  await start(page, {start_task:"upscale", last_task:"compression"});
  await expect(page.locator("#wf-u")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(path => window.initApp?.({files:[path], task:"cut"}), "C:/videos/Second.mp4");
  await expect(page.locator("#wf-l")).toHaveAttribute("aria-pressed", "true");
});

test("a shortcut cannot open a hidden task", async ({page}) => {
  await start(page, {hidden_ui:["cut"], last_task:"compression"});
  await page.evaluate(path => window.initApp?.({files:[path], task:"cut"}), "C:/videos/Second.mp4");
  await expect(page.locator("#wf-c")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#wf-l")).toBeHidden();
});

test("Send to shortcuts are added one at a time", async ({page}) => {
  const fixture = healthyBackendFixture();
  fixture.responses.getSettings = {...fixture.responses.getSettings as object, hidden_ui:["cut"]};
  fixture.responses.listSendtoShortcuts = {shortcuts:[
    {name:"Tuck", type:"generic", kind:"open", status:"ok"},
    {name:"Tuck Upscale", type:"generic", kind:"upscale", status:"broken"},
  ]};
  fixture.responses.installGenericSendto = {ok:true};
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.getByRole("button", {name:"Settings"}).first().click();
  await page.getByRole("button", {name:"File Explorer"}).click();
  const rows = page.locator("#st-fixed .settings-list-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Tuck");
  await expect(rows.nth(0)).toContainText("Added");
  await expect(rows.nth(0).getByRole("button")).toHaveText(["Remove"]);
  await expect(rows.nth(1)).toContainText("Tuck Compress");
  await expect(rows.nth(1).getByRole("button")).toHaveText(["Add"]);
  await expect(rows.nth(2)).toContainText("Needs repair");
  await expect(rows.nth(2).getByRole("button")).toHaveText(["Repair", "Remove"]);
  await expect(page.locator("#st-fixed")).not.toContainText("Lossless Cut");
  await rows.nth(1).getByRole("button", {name:"Add"}).click();
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.find(call => call.method === "installGenericSendto")?.args)).toEqual(["compress"]);
});
