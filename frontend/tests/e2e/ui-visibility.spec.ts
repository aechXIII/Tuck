import { chooseSelect } from "../fixtures/select";
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
  // This video keeps Transform and leaves out the hidden Audio section
  await page.locator("#insp-tab-edit").click();
  await expect(page.locator("#insp-edit")).toBeVisible();
  await expect(page.locator("#insp-audio")).toBeHidden();
  await page.locator("#insp-tab-export").click();
  await expect(page.locator("#audio-add")).toBeHidden();
  await expect(page.locator("#audio-add")).toBeHidden();
  await expect(page.locator("#frame-blending-panel")).toBeHidden();
  await expect(page.locator("#lut-panel")).toBeHidden();
  await expect(page.getByRole("button", {name:"Compress this video", exact:true})).toBeVisible();
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
  await page.getByRole("button", {name:"Tasks & tools", exact:true}).click();
  const compress = page.getByRole("switch", {name:"Compress"});
  const upscale = page.getByRole("switch", {name:"Upscale"});
  const cut = page.getByRole("switch", {name:"Lossless cut"});
  await upscale.uncheck();
  await cut.uncheck();
  await expect(compress).toBeDisabled();
  await page.getByRole("switch", {name:"Transform panel"}).uncheck();
  await page.getByRole("switch", {name:"Audio panel", exact:true}).uncheck();
  await expect(page.locator("#settings-status")).toHaveText("Saved");
  const saved = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0]);
  expect(saved).toMatchObject({hidden_ui:["upscale", "cut", "panel_video", "panel_audio"]});
  // the launch choices on General only offer what is shown
  await page.getByRole("button", {name:"General", exact:true}).click();
  expect(await page.locator("#set-start-task option").evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value))).toEqual(["last", "compression"]);
  expect(await page.locator("#set-inspector-start option").evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value))).toEqual(["last", "export"]);
  await chooseSelect(page, page.locator("#set-start-task-trigger"), "compression");
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0])).toMatchObject({start_task:"compression"});
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

test("timeline switches start as they were left and are remembered", async ({page}) => {
  await start(page, {timeline_snap:false, timeline_keyframes:true});
  const snap = page.locator("#btn-snap-toggle");
  await expect(snap).toHaveAttribute("aria-pressed", "false");
  await snap.click();
  await expect(snap).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.__tuckFakeBackendCalls?.some(call =>
    call.method === "saveSettings" && (call.args[0] as Record<string, unknown>).timeline_snap === true))).toBe(true);
});

test("Add segment stays reachable when there is no room and says why", async ({page}) => {
  await start(page);
  const add = page.locator("#btn-segment-add");
  // announced as unavailable, but not natively disabled, so it can still take focus
  await expect(add).toHaveAttribute("aria-disabled", "true");
  await expect(add).not.toHaveAttribute("disabled", /.*/);
  await add.focus();
  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Shorten a segment to make room for another.");
});

test("the Lossless cut file name suffix is previewed and saved when the field is left", async ({page}) => {
  await start(page, {cut_suffix:"_cut"});
  await page.getByRole("button", {name:"Settings"}).first().click();
  await page.getByRole("button", {name:"Files & names"}).click();
  const suffix = page.getByLabel("Lossless cut suffix");
  await suffix.fill("_trimmed");
  await expect(page.locator('[data-setting="suffix-cut"] .set-desc')).toHaveText("Morning ride_trimmed.mp4");
  expect(await page.evaluate(() => window.__tuckFakeBackendCalls?.some(call =>
    call.method === "saveSettings" && "cut_suffix" in (call.args[0] as Record<string, unknown>)))).toBe(false);
  await suffix.press("Tab");
  await expect(page.locator("#settings-status")).toHaveText("Saved");
  const saved = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(call => call.method === "saveSettings").at(-1)?.args[0]);
  expect(saved).toMatchObject({cut_suffix:"_trimmed"});
});

test("Export all cuts says why it is unavailable", async ({page}) => {
  const fixture = healthyBackendFixture();
  fixture.startup.files = [source, "C:/videos/Second.mp4"];
  fixture.responses.probeFile = {data:{duration:12,width:1920,height:1080,fps:30,has_audio:true,video_codec:"h264",audio_codec:"aac",file_size:15000000}};
  fixture.responses.getSettings = {...fixture.responses.getSettings as object, last_task:"cut"};
  fixture.holdMethods = ["getCutAnalysis"];
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator(".export-actions > summary").click();
  await expect(page.locator("#btn-all")).toBeDisabled();
  // it names the videos it is still waiting for
  await expect(page.locator("#btn-all-note")).toHaveText("Waiting for keyframes: Morning ride.mp4, Second.mp4.");
  await expect(page.locator("#btn-all")).toHaveAccessibleDescription("Waiting for keyframes: Morning ride.mp4, Second.mp4.");
});
