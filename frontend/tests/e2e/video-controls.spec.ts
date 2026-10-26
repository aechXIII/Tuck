import { chooseSelect } from "../fixtures/select";
import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`video controls stay editable and synchronized at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height:width === 960 ? 640 : 800});
    await page.emulateMedia({reducedMotion:"reduce"});
    const fixture = healthyBackendFixture();
    fixture.responses.pickFiles = {ok:true,files:["C:\\media\\900fps.mp4"]};
    fixture.responses.probeFile = {ok:true,data:{width:1920,height:1080,fps:900,duration:12,has_audio:true}};
    fixture.responses.getMediaUrl = {ok:true,url:"https://media.test/v",token:"t"};
    fixture.responses.getThumbnail = {ok:true,thumbnail:""};
    fixture.responses.enqueueWithOptions = {ok:true};
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", {name:"Library",exact:true}).click();
    await page.locator("#btn-add").click();
    if (width === 960) await page.getByRole("button", {name:"Inspector",exact:true}).click();
    const panel = page.locator("#export-video-panel");
    const resolution = page.getByLabel("Resolution", {exact:true});
    const fps = page.getByLabel("Target frame rate", {exact:true});
    const fpsPreset = page.getByLabel("Frame rate", {exact:true});
    await expect(page.getByLabel("Custom width", {exact:true})).toBeHidden();
    await expect(page.getByLabel("Scaling", {exact:true})).toBeVisible();
    await expect(page.getByLabel("Scaling", {exact:true})).toHaveAccessibleDescription(/Sharp pixels keeps hard edges/);
    expect(await page.locator("#export-fps-select option").evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual(["source", "24", "30", "60", "120", "custom"]);
    await expect(fps).toBeHidden();
    await expect(fps).toHaveValue("900");
    await chooseSelect(page, fpsPreset, "60");
    await expect(fps).toHaveValue("60");
    await chooseSelect(page, resolution, "720p");
    await expect(page.getByLabel("Custom width", {exact:true})).toHaveValue("1280");
    await expect(page.getByLabel("Custom height", {exact:true})).toHaveValue("720");
    await chooseSelect(page, resolution, "custom");
    await page.getByLabel("Custom width", {exact:true}).fill("1600");
    await page.getByLabel("Custom height", {exact:true}).fill("900");
    await expect(page.locator("#export-res-select")).toHaveValue("custom");
    await chooseSelect(page, fpsPreset, "custom");
    await expect(fps).toBeFocused();
    await fps.fill("59.94");
    await expect(page.locator("#export-fps-select")).toHaveValue("custom");
    await expect(fps).toBeFocused();
    await fps.fill("");
    await expect(page.getByRole("button", {name:"Compress this video",exact:true})).toBeDisabled();
    await expect(page.locator("#video-error")).toContainText("frame rate");
    await fps.fill("59.94");
    await page.getByLabel("Custom width", {exact:true}).fill("1");
    await expect(page.locator("#video-error")).toContainText("2 pixels");
    await page.getByLabel("Custom width", {exact:true}).fill("1600");
    await expect(page.locator("#video-error")).toBeHidden();
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole("button", {name:"Compress this video",exact:true}).click();
    const request = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).find(c => c.method === "enqueueWithOptions")?.args[0]);
    expect(request).toMatchObject({resolution_mode:"custom",custom_width:1600,custom_height:900,fps_mode:"custom",custom_fps:59.94});
    await chooseSelect(page, resolution, "source");
    await chooseSelect(page, fpsPreset, "source");
    await expect(page.getByLabel("Custom width", {exact:true})).toHaveValue("1920");
    await expect(page.getByLabel("Custom height", {exact:true})).toHaveValue("1080");
    await expect(fps).toHaveValue("900");
    await page.getByRole("button", {name:"Upscale",exact:true}).click();
    await chooseSelect(page, fpsPreset, "60");
    await chooseSelect(page, resolution, "2160p");
    await expect(page.getByLabel("Custom width", {exact:true})).toHaveValue("3840");
    await expect(page.getByRole("button", {name:"Upscale this video",exact:true})).toBeEnabled();
    await page.getByRole("button", {name:"Upscale this video",exact:true}).click();
    // a preset sizes each video's short side, so the planner gets the side, not a box
    const upscale = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter(c => c.method === "enqueueWithOptions").at(-1)?.args[0]);
    expect(upscale).toMatchObject({workflow:"upscale",resolution_mode:"short_side",short_side:2160,scaler:"lanczos"});
    expect(errors).toEqual([]);
  });
}

test("export controls are announced by the label people see", async ({page}) => {
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = {ok:true,files:["C:\\media\\clip.mp4"]};
  fixture.responses.probeFile = {ok:true,data:{width:1920,height:1080,fps:30,duration:12,has_audio:true}};
  fixture.responses.getMediaUrl = {ok:true,url:"https://media.test/v",token:"t"};
  fixture.responses.getThumbnail = {ok:true,thumbnail:""};
  await installFakeBackend(page, fixture);
  await page.goto("/");
  await page.locator("#btn-add").click();
  await page.locator("#wf-u").click();
  await page.locator("#adv-toggle").evaluate(button => (button.closest("details") as HTMLDetailsElement).open = true);
  await page.locator("#adv-toggle").click();
  // the label text is read from the page, so a renamed label still has to match what is announced
  const announcedAsShown = async (id: string) => {
    const label = (await page.locator(`label[for="${id}"]`).textContent())!.trim();
    expect(label).not.toBe("");
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(label);
  };
  for (const id of ["export-res-select-trigger", "export-fps-select-trigger", "scaler-sel-trigger", "rc-sel-trigger", "quality-val"]) {
    await announcedAsShown(id);
  }
  await chooseSelect(page, page.locator("#rc-sel-trigger"), "CBR");
  await announcedAsShown("br-val");
  await page.locator("#wf-c").click();
  await expect(page.getByRole("switch", {name:"Two-pass encoding",exact:true})).toBeVisible();
});
