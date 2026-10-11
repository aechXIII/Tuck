import {expect, test} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`switching LUTs replaces colors without duplicating or rebuilding options at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 960 ? 640 : 800});
    const fixture = healthyBackendFixture();
    fixture.responses.pickFiles = {files:["C:/media/source.mp4"]};
    fixture.responses.probeFile = {data:{width:128,height:72,fps:60,duration:12,has_audio:false}};
    fixture.responses.getMediaUrl = {url:"https://media.test/v",token:"v"};
    fixture.responses.getThumbnail = {thumbnail:""};
    const entries = [{path:"C:/managed/invert.cube",name:"Invert"},{path:"C:/managed/swap.cube",name:"Swap"}];
    fixture.responses.listLuts = {luts:entries};
    const payload = (index: number) => ({...entries[index],size:2,table_url:`http://127.0.0.1:4321/token/${index}`,token:`t${index}`});
    fixture.responseSequences = {loadLut:[payload(0),payload(1),payload(0),payload(1),{ok:false,error:"The LUT file is unavailable. Import it again."}]};
    for (let index=0;index<2;index++) {
      const table = new Float32Array(24);
      for(let i=0;i<8;i++) {
        const [r,g,b] = [i&1,(i>>1)&1,(i>>2)&1];
        table.set(index === 0 ? [1-r!,1-g!,1-b!] : [g!,r!,b!], i*3);
      }
      await page.route(`http://127.0.0.1:4321/token/${index}`, route => route.fulfill({body:Buffer.from(table.buffer),headers:{"Access-Control-Allow-Origin":"*"}}));
    }
    const errors: string[] = [];
    page.on("pageerror", error=>errors.push(error.message));
    await installFakeBackend(page,fixture);
    await page.goto("/");
    if(width===960) await page.getByRole("button",{name:"Library",exact:true}).click();
    await page.locator("#btn-add").click();
    if(width===960) await page.getByRole("button",{name:"Inspector",exact:true}).click();
    await page.locator("#lut-panel > summary").click();
    const select = page.getByRole("button",{name:/^LUT /});
    await select.click();
    await expect(page.locator("#lut-options").getByRole("option")).toHaveCount(2);
    const firstOption = await page.locator("#lut-options").getByRole("option").nth(0).elementHandle();
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      const source = document.createElement("canvas"); source.width=128;source.height=72;
      const paint=source.getContext("2d")!;paint.fillStyle="rgb(32,96,192)";paint.fillRect(0,0,128,72);
      const video=document.querySelector<HTMLVideoElement>("#vid")!;
      video.srcObject=source.captureStream(0); await video.play();video.pause();
    });
    for(const index of [0,1,0,1]) {
      await select.click();
      await page.locator("#lut-options").getByRole("option",{name:entries[index]!.name,exact:true}).click();
      await expect(select).toBeEnabled();
      await expect(select).toHaveText(entries[index]!.name);
      expect(await page.locator("#lut-options [role=option]").allTextContents()).toEqual(["Invert","Swap"]);
      expect(await firstOption!.evaluate(node=>node.isConnected)).toBe(true);
      await expect(page.locator("[data-lut-preview]")).toHaveCount(1);
      const pixel = await page.evaluate(() => {
        document.querySelector("#vid")!.dispatchEvent(new Event("seeked"));
        const canvas=document.querySelector<HTMLCanvasElement>("[data-lut-preview]")!;
        const gl=canvas.getContext("webgl2")!;
        const bytes=new Uint8Array(4);gl.readPixels(4,4,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        return Array.from(bytes).slice(0,3);
      });
      const expected = index === 0 ? [223,159,63] : [96,32,192];
      pixel.forEach((value,i)=>expect(Math.abs(value-expected[i]!)).toBeLessThanOrEqual(2));
    }
    await page.locator("#lut-panel").screenshot({path:`frontend/.scratch/lut-selection-${width}.png`});
    await select.click();
    await page.locator("#lut-options").getByRole("option",{name:"Invert",exact:true}).click();
    await expect(page.locator("#lut-error")).toHaveText("The LUT file is unavailable. Import it again.");
    await expect(select).toHaveText("Swap");
    await expect(page.locator("[data-lut-preview]")).toBeVisible();
    await expect(select).toBeFocused();
    await select.click();
    await page.getByRole("button",{name:"Remove LUT",exact:true}).click();
    await expect(page.locator("[data-lut-preview]")).toBeHidden();
    expect(errors).toEqual([]);
  });
}
