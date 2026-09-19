import {expect, test} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";

const media = resolve(".scratch/lut-frame-media");
test.beforeAll(() => {
  mkdirSync(media, {recursive:true});
  const bundled = resolve("packaging/staging/app/ffmpeg/ffmpeg.exe");
  const ffmpeg = process.platform === "win32" && existsSync(bundled) ? bundled : "ffmpeg";
  for (const color of ["red", "blue"]) execFileSync(ffmpeg, ["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",`color=${color}:s=160x90:r=30:d=3`,"-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",`${media}/${color}.mp4`]);
  execFileSync(ffmpeg, ["-hide_banner","-loglevel","error","-y",
    "-f","lavfi","-i","color=red:s=160x90:r=30:d=1",
    "-f","lavfi","-i","color=green:s=160x90:r=30:d=1",
    "-f","lavfi","-i","color=blue:s=160x90:r=30:d=1",
    "-filter_complex","[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]","-map","[v]",
    "-c:v","libx264","-g","90","-pix_fmt","yuv420p","-movflags","+faststart",`${media}/red.mp4`]);
});

for (const stalledCallbacks of [false, true]) {
test(`LUT playback, switching and seeking with ${stalledCallbacks ? "stalled" : "normal"} video callbacks`, async ({page}, testInfo) => {
  await page.addInitScript(stalled => {
    if (stalled) {
      const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
      const cancelFrame = HTMLVideoElement.prototype.cancelVideoFrameCallback;
      // suppress playback notifications while retaining paused load/seek callbacks
      HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
        return this.paused ? requestFrame.call(this, callback) : 0;
      };
      HTMLVideoElement.prototype.cancelVideoFrameCallback = function(id) {
        if (id !== 0) cancelFrame.call(this, id);
      };
    }
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function(...args) {
      draw.apply(this,args);
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.hasAttribute("data-lut-preview")) {
        const pixel = new Uint8Array(4);
        this.readPixels(0,0,1,1,this.RGBA,this.UNSIGNED_BYTE,pixel);
        this.canvas.dataset.pixel = Array.from(pixel).slice(0,3).join(",");
      }
    };
  }, stalledCallbacks);
  const fixture = healthyBackendFixture();
  fixture.responses.pickFiles = {files:["C:/red.mp4","C:/blue.mp4"]};
  fixture.responses.probeFile = {data:{width:160,height:90,duration:3,fps:30,has_audio:false}};
  fixture.responses.getThumbnail = {thumbnail:""};
  fixture.responses.pickLutFile = {path:"invert.cube"};
  fixture.responses.loadLut = {path:"invert.cube",name:"Invert",size:2,table_url:"https://lut.test/invert",token:"lut"};
  fixture.responseSequences = {getMediaUrl:[{url:"https://media.test/red.mp4",token:"red"},{url:"https://media.test/blue.mp4",token:"blue"},{url:"https://media.test/red.mp4",token:"red2"}]};
  for (const color of ["red","blue"]) await page.route(`https://media.test/${color}.mp4`, route => {
    const body = readFileSync(`${media}/${color}.mp4`);
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({status:range ? 206 : 200, body:body.subarray(start,end+1),contentType:"video/mp4",headers:{
      "Access-Control-Allow-Origin":"*", "Accept-Ranges":"bytes",
      ...(range ? {"Content-Range":`bytes ${start}-${end}/${body.length}`} : {}),
    }});
  });
  const table = new Float32Array(24);
  for(let i=0;i<8;i++) table.set([1-(i&1),1-((i>>1)&1),1-((i>>2)&1)],i*3);
  await page.route("https://lut.test/invert", route => route.fulfill({body:Buffer.from(table.buffer),headers:{"Access-Control-Allow-Origin":"*"}}));
  await installFakeBackend(page,fixture);
  await page.goto("/");
  await page.getByRole("button",{name:"Add videos",exact:true}).click();
  await expect.poll(()=>page.locator("#vid").evaluate((video:HTMLVideoElement)=>video.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator("#lut-panel > summary").click();
  await page.locator("#lut-import").click();
  const canvas = page.locator("[data-lut-preview]");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(async element => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const gl = (element as HTMLCanvasElement).getContext("webgl2")!;
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return Array.from(pixel).slice(0, 3).join(",");
  })).toMatch(/^([0-9]|1[0-9]),25[0-5],25[0-5]$/);
  await expect.poll(()=>canvas.getAttribute("data-pixel")).toMatch(/^([0-9]|1[0-9]),25[0-5],25[0-5]$/);
  await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.play());
  await page.getByRole("switch", { name: "Apply LUT", exact: true }).uncheck();
  await page.getByRole("switch", { name: "Apply LUT", exact: true }).check();
  await expect.poll(async () => {
    const pixel = (await canvas.getAttribute("data-pixel"))!.split(",").map(Number);
    return pixel[0]! > 245 && pixel[1]! > 100 && pixel[1]! < 150 && pixel[2]! > 245;
  }, { intervals: [50], timeout: 2500 }).toBe(true);
  await page.locator("#vid").evaluate((video: HTMLVideoElement) => video.pause());
  await page.locator('.clip[data-clip-path="C:/blue.mp4"]').click();
  await expect(page.locator("#vid")).toHaveAttribute("src","https://media.test/blue.mp4");
  await expect.poll(()=>canvas.getAttribute("data-pixel")).toMatch(/^25[0-5],25[0-5],([0-9]|1[0-9])$/);
  await expect(page.locator("#vid")).toHaveJSProperty("paused",true);
  await page.locator('.clip[data-clip-path="C:/red.mp4"]').click();
  await expect.poll(()=>canvas.getAttribute("data-pixel")).toMatch(/^([0-9]|1[0-9]),25[0-5],25[0-5]$/);
  const track = await page.locator("#tl-track").boundingBox();
  const ruler = await page.locator("#sequence-ruler").boundingBox();
  expect(track).not.toBeNull();
  expect(ruler).not.toBeNull();
  const y = ruler!.y + ruler!.height / 2;
  await page.locator("#sequence-ruler").click({position:{x:ruler!.width * .85,y:ruler!.height / 2}});
  await expect.poll(()=>page.locator("#vid").evaluate((video:HTMLVideoElement)=>video.currentTime)).toBeGreaterThan(2);
  await expect.poll(()=>canvas.getAttribute("data-pixel")).toMatch(/^25[0-5],25[0-5],([0-9]|1[0-9])$/);
  await page.mouse.move(track!.x + track!.width * .85, y);
  await page.mouse.down();
  await page.mouse.move(track!.x + track!.width * .15, y, {steps:12});
  await page.mouse.up();
  await expect.poll(()=>canvas.getAttribute("data-pixel")).toMatch(/^([0-9]|1[0-9]),25[0-5],25[0-5]$/);
  const beforeToggle = await page.locator("#vid").evaluate((video:HTMLVideoElement)=>video.currentTime);
  const pixel = await canvas.getAttribute("data-pixel");
  for (let i=0; i<3; i++) {
    await page.getByRole("switch",{name:"Apply LUT",exact:true}).uncheck();
    await expect(canvas).toBeHidden();
    await page.getByRole("switch",{name:"Apply LUT",exact:true}).check();
    await expect(canvas).toHaveAttribute("data-pixel",pixel!);
    await expect(page.locator("#vid")).toHaveJSProperty("currentTime",beforeToggle);
  }
  await page.getByRole("switch",{name:"Apply LUT",exact:true}).uncheck();
  await page.locator("#sequence-ruler").click({position:{x:ruler!.width * .85,y:ruler!.height / 2}});
  await expect.poll(() => page.locator("#vid").evaluate((video: HTMLVideoElement) => {
    if (video.seeking) return false;
    const sample = document.createElement("canvas");
    sample.width = sample.height = 1;
    const context = sample.getContext("2d")!;
    context.drawImage(video, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    // decoder color conversion can differ by a few channel values
    return red! < 10 && green! < 10 && blue! > 245;
  })).toBe(true);
  await page.getByRole("switch",{name:"Apply LUT",exact:true}).check();
  await expect.poll(()=>canvas.getAttribute("data-pixel")).toMatch(/^25[0-5],25[0-5],([0-9]|1[0-9])$/);
  await page.screenshot({path:testInfo.outputPath("lut-paused-seek.png")});
  await page.setViewportSize({width:960,height:640});
  await expect(canvas).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("lut-compact.png")});

});


}
