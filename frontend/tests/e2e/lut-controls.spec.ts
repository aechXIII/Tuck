import { chooseSelect } from "../fixtures/select";
import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend, withVideo } from "../fixtures/fake-backend";
import { expectLutShown, nativePreview } from "../fixtures/lut-check";

for (const width of [1240, 960]) {
  test(`LUT import, strength and workflow persistence at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 960 ? 640 : 800});
    await page.emulateMedia({reducedMotion:"reduce"});
    const fixture = healthyBackendFixture();
    fixture.responses.pickFiles = {ok:true,files:["C:/media/source.mp4"]};
    fixture.responses.probeFile = {ok:true,data:{duration:12,width:1920,height:1080,fps:60,has_audio:true}};
    fixture.responses.getMediaUrl = {ok:true,url:"https://media.test/v",token:"t"};
    fixture.responses.getThumbnail = {ok:true,thumbnail:""};
    fixture.responses.pickLutFile = {ok:true,path:"C:/looks/Warm.cube"};
    fixture.responses.loadLut = {ok:true,path:"C:/managed/abc.cube",name:"Warm.cube",size:2,table_url:"http://127.0.0.1:4321/token/table",token:"lut-token"};
    fixture.responses.enqueueWithOptions = {ok:true};
    fixture.responseSequences = {pickLutFile:[{path:"C:/looks/Warm.cube"},{path:""},{path:"bad.lut"}],loadLut:[fixture.responses.loadLut,{ok:false,error:"Unsupported LUT format. Export a .cube file."}]};
    const pixels = new Float32Array(24);
    for (let i=0;i<8;i++) pixels.set([i&1,(i>>1)&1,(i>>2)&1],i*3);
    await page.route("http://127.0.0.1:4321/token/table", route => route.fulfill({body:Buffer.from(pixels.buffer),headers:{"Access-Control-Allow-Origin":"*","Content-Type":"application/octet-stream"}}));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button", {name:"Library",exact:true}).click();
    await page.locator("#btn-add").click();
    if (width === 960) await page.getByRole("button", {name:"Inspector",exact:true}).click();
    const panel = page.locator("#lut-panel");
    await panel.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Apply LUT", {exact:true})).toBeHidden();
    await expect(page.getByLabel("Strength", {exact:true})).toBeHidden();
    await panel.getByRole("button", {name:"Import",exact:true}).click();
    await expect(page.locator("#lut-current-name")).toHaveText("Warm.cube");
    await expect(page.getByLabel("Apply LUT", {exact:true})).toBeChecked();
    const strength = page.getByLabel("Strength", {exact:true});
    await strength.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#lut-strength-value")).toHaveText("1%");
    await strength.fill("35");
    await expect(page.locator("#lut-strength-value")).toHaveText("35%");
    await page.evaluate(async () => {
      const source = document.createElement("canvas");
      source.width = 128; source.height = 72;
      const paint = source.getContext("2d")!;
      paint.fillStyle = "rgb(32,96,192)"; paint.fillRect(0,0,128,72);
      const video = document.querySelector<HTMLVideoElement>("#vid")!;
      video.srcObject = source.captureStream(0);
      await video.play(); video.pause();
    });
    await expectLutShown(page, .35);
    if (!nativePreview) {
      // the HTML player's overlay covers the video exactly
      const bounds = await page.evaluate(() => {
        const video = document.querySelector("#vid")!.getBoundingClientRect();
        const canvas = document.querySelector("[data-lut-preview]")!.getBoundingClientRect();
        return [canvas.left-video.left, canvas.top-video.top, canvas.width-video.width, canvas.height-video.height];
      });
      for (const difference of bounds) expect(Math.abs(difference)).toBeLessThan(1);
    }
    await page.getByRole("button", {name:"Compress this video",exact:true}).click();
    const request = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c=>c.method==="enqueueWithOptions").at(-1)?.args[0]);
    expect(request).toMatchObject({lut:{enabled:true,path:"C:/managed/abc.cube",name:"Warm.cube",strength:.35}});
    await panel.getByRole("button", {name:"Import",exact:true}).click();
    await expect(page.locator("#lut-current-name")).toHaveText("Warm.cube");
    await panel.getByRole("button", {name:"Import",exact:true}).click();
    await expect(page.locator("#lut-error")).toContainText("Export a .cube");
    await expect(page.locator("#lut-current-name")).toHaveText("Warm.cube");
    await page.getByRole("button", {name:"Upscale",exact:true}).click();
    await page.getByLabel("Apply LUT", {exact:true}).uncheck();
    await expect(strength).toBeDisabled();
    await page.getByRole("button", {name:"Upscale this video",exact:true}).click();
    const disabled = await page.evaluate(() => window.__tuckFakeBackendCalls?.filter(c=>c.method==="enqueueWithOptions").at(-1)?.args[0]);
    expect(disabled).toMatchObject({lut:{enabled:false,strength:.35}});
    expect(await panel.evaluate(el=>el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}


test("saved LUT profiles reload and old profiles disable the effect", async ({page}) => {
  const fixture = withVideo(healthyBackendFixture());
  const lut = {enabled:true,path:"C:/managed/look.cube",name:"Saved look",strength:.4};
  const base = {workflow:"compression",target_size_bytes:10485760,resolution_mode:"source",fps_mode:"source",video_encoder:"libx264",preset:"medium",audio_bitrate:128000};
  fixture.responses.getSettings = {...fixture.responses.getSettings as object,profiles:[{...base,profile_id:"old",name:"Original"},{...base,profile_id:"look",name:"With LUT",lut}]};
  fixture.responses.loadLut = {ok:true,path:lut.path,name:"hash",size:2,table_url:"http://127.0.0.1:4321/token/table",token:"lut-token"};
  await page.route("http://127.0.0.1:4321/token/table", route => route.fulfill({body:Buffer.from(new Float32Array(24).buffer),headers:{"Access-Control-Allow-Origin":"*"}}));
  await installFakeBackend(page,fixture);
  await page.goto("/");
  await page.locator("#lut-panel > summary").click();
  await expect(page.getByLabel("Apply LUT",{exact:true})).not.toBeChecked();
  await page.locator("#prof-pick").click();
  await page.locator('#prof-options [data-profile-id="look"]').click();
  await expect(page.getByLabel("Strength",{exact:true})).toBeEnabled();
  await expect(page.locator("#lut-current-name")).toHaveText("Saved look");
  await expect(page.locator("#lut-strength-value")).toHaveText("40%");
  await page.getByLabel("Strength",{exact:true}).fill("55");
  await page.getByRole("button",{name:"Save to profile",exact:true}).click();
  const update = await page.evaluate(() => window.__tuckFakeBackendCalls?.find(c=>c.method==="updateProfile")?.args[1]);
  expect(update).toMatchObject({lut:{...lut,strength:.55}});
  await page.locator("#prof-pick").click();
  await page.locator('#prof-options [data-profile-id="old"]').click();
  await expect(page.getByLabel("Apply LUT",{exact:true})).not.toBeChecked();
  await expect(page.getByLabel("Strength",{exact:true})).toBeDisabled();
  await expect(page.locator("#lut-current-name")).toHaveText("No LUT selected");
});


test("blending errors leave the LUT preview enabled and FPS controls stay synchronized", async ({page}) => {
  await page.setViewportSize({width:960,height:640});
  const fixture = withVideo(healthyBackendFixture());
  fixture.responses.pickFiles = {files:["C:/media/highfps.mp4"]};
  fixture.responses.probeFile = {data:{width:1920,height:1080,fps:900,duration:12,has_audio:true}};
  fixture.responses.getMediaUrl = {url:"https://media.test/v",token:"v"};
  fixture.responses.getThumbnail = {thumbnail:""};
  fixture.responses.listLuts = {luts:[{path:"C:/managed/saved.cube",name:"Saved look"},{path:"C:/managed/other.cube",name:"Other look"}]};
  fixture.responses.loadLut = {path:"C:/managed/saved.cube",name:"Saved look",size:2,table_url:"http://127.0.0.1:4321/token/table",token:"t"};
  fixture.responses.createPlan = {ok:false,error:"Frame blending supports up to 240 FPS. Choose a lower output frame rate.",details:{field:"frame_blending"}};
  await page.route("http://127.0.0.1:4321/token/table", route => route.fulfill({body:Buffer.from(new Float32Array(24).buffer),headers:{"Access-Control-Allow-Origin":"*"}}));
  await installFakeBackend(page,fixture);
  await page.goto("/");
  await page.getByRole("button",{name:"Library",exact:true}).click();
  await page.locator("#btn-add").click();
  await page.getByRole("button",{name:"Inspector",exact:true}).click();
  await page.locator("#lut-panel > summary").click();
  await page.getByRole("button",{name:/^LUT /}).click();
  await page.locator("#lut-options").getByRole("option",{name:"Saved look",exact:true}).click();
  await expect(page.getByLabel("Apply LUT",{exact:true})).toBeChecked();
  await expect(page.getByLabel("Strength",{exact:true})).toBeEnabled();
  await page.evaluate(async () => {
    const source = document.createElement("canvas"); source.width=128; source.height=72;
    source.getContext("2d")!.fillRect(0,0,128,72);
    const video = document.querySelector<HTMLVideoElement>("#vid")!;
    video.srcObject=source.captureStream(0); await video.play(); video.pause();
  });
  await expectLutShown(page);
  await page.locator("#frame-blending-panel > summary").click();
  await page.getByLabel("Enable frame blending",{exact:true}).check();
  await expect(page.locator("#blend-error")).toContainText("240 FPS");
  await expect(page.locator("#lut-error")).toBeHidden();
  await expectLutShown(page);
  await expect(page.getByLabel("Apply LUT",{exact:true})).toBeChecked();
  const blendFps = page.getByLabel("Frame blending output frame rate",{exact:true});
  const videoFps = page.getByLabel("Output frame rate",{exact:true});
  await chooseSelect(page, blendFps, "60");
  await expect(page.locator("#export-fps-select")).toHaveValue("60");
  await chooseSelect(page, videoFps, "30");
  await expect(page.locator("#blend-fps-select")).toHaveValue("30");
  await chooseSelect(page, blendFps, "custom");
  const custom = page.getByLabel("Frame blending custom frame rate",{exact:true});
  await expect(custom).toBeFocused();
  await custom.fill("59.94");
  await expect(page.getByLabel("Target frame rate",{exact:true})).toHaveValue("59.94");
  await page.getByLabel("Target frame rate",{exact:true}).fill("47.5");
  await expect(custom).toHaveValue("47.5");
  const calls = await page.evaluate(() => window.__tuckFakeBackendCalls ?? []);
  expect(calls.filter(call=>call.method==="pickLutFile")).toHaveLength(0);
  expect(calls.filter(call=>call.method==="createPlan").at(-1)?.args[0]).toMatchObject({custom_fps:47.5,lut:{enabled:true},frame_blending:{enabled:true}});
  await page.reload();
  await page.getByRole("button",{name:"Inspector",exact:true}).click();
  await page.locator("#lut-panel > summary").click();
  await page.getByRole("button",{name:/^LUT /}).click();
  await expect(page.locator("#lut-options").getByRole("option")).toHaveCount(2);
});
