import { chooseSelect } from "../fixtures/select";
import {expect, test} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend} from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`export effects match Video controls at ${width}`, async ({page}) => {
    await page.setViewportSize({width,height:width === 960 ? 640 : 800});
    await page.emulateMedia({reducedMotion:"reduce"});
    const fixture = healthyBackendFixture();
    fixture.responses.pickLutFile = {path:"C:/looks/Warm.cube"};
    fixture.responses.loadLut = {path:"C:/looks/Warm.cube",name:"Warm",size:2,table_url:"https://lut.test/table",token:"lut"};
    await page.route("https://lut.test/table", route => route.fulfill({body:Buffer.from(new Float32Array(24).buffer),headers:{"Access-Control-Allow-Origin":"*"}}));
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button",{name:"Inspector",exact:true}).click();
    await page.locator("#frame-blending-panel > summary").click();
    await page.getByLabel("Enable frame blending",{exact:true}).check();
    await chooseSelect(page, page.getByLabel("Weighting",{exact:true}), "gaussian");
    await page.getByText("Advanced settings",{exact:true}).click();
    await page.locator("#lut-panel > summary").click();
    await page.locator("#lut-import").click();
    await expect(page.getByRole("switch", {name:"Apply LUT",exact:true})).toBeChecked();
    await page.locator(".adjust-panel > summary").filter({has: page.locator("#export-audio-summary")}).click();
    const metrics = await page.evaluate(() => {
      const measure = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return {left:bounds.left,right:bounds.right,height:bounds.height,radius:style.borderRadius,font:style.fontFamily,size:style.fontSize,color:style.color};
      };
      return {
        label:measure('label[for="export-res-select-trigger"]'),
        labels:['blend-amount','blend-curve-trigger','blend-sigma','lut-strength'].map(id=>measure(`label[for="${id}"]`)),
        input:measure('#export-fps-select-trigger'),
        inputs:['blend-fps-select-trigger','blend-amount','blend-curve-trigger','blend-sigma'].map(id=>measure(`#${id}`)),
        checks:['blend-enabled','blend-linear','lut-enabled'].map(id=>measure(`#${id} + .toggle-track`)),
        picker:measure('#lut-name'),
        pickerRow:measure('.lut-file-row'),
        audio:measure('#audio-br'),
      };
    });
    for (const label of metrics.labels) {
      expect(label.left).toBeCloseTo(metrics.label.left, 0);
      expect([label.font,label.size,label.color]).toEqual([metrics.label.font,metrics.label.size,metrics.label.color]);
    }
    for (const input of metrics.inputs) {
      expect(input.left).toBeCloseTo(metrics.input.left, 0);
      expect([input.height,input.font,input.size]).toEqual([metrics.input.height,metrics.input.font,metrics.input.size]);
    }
    for (const toggle of metrics.checks) expect(toggle.right).toBeCloseTo(metrics.input.right, 0);
    await page.locator('#frame-blending-panel > summary').click();
    await page.locator('#audio-br').scrollIntoViewIfNeeded();
    await page.screenshot({path:`frontend/.scratch/lut-audio-alignment-${width}.png`});
    expect(metrics.pickerRow.left).toBeCloseTo(metrics.audio.left, 0);
    expect(metrics.pickerRow.right).toBeCloseTo(metrics.audio.right, 0);
    // the existing LUT picker keeps its compact shape alongside the custom selects
    expect(metrics.pickerRow.radius).toEqual("4px");
    expect(metrics.picker.height).toEqual(26);
    await page.locator('#frame-blending-panel').screenshot({path:`frontend/.scratch/effects-alignment-blend-${width}.png`});
    await page.locator('#lut-panel').screenshot({path:`frontend/.scratch/effects-alignment-lut-${width}.png`});
    await page.screenshot({path:`frontend/.scratch/effects-alignment-full-${width}.png`});
  });
}
