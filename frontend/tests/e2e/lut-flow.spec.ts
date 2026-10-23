import {expect, test} from "@playwright/test";
import {healthyBackendFixture, installFakeBackend, withVideo} from "../fixtures/fake-backend";

for (const width of [1240, 960]) {
  test(`LUT flow explains empty, loading, applied, off and removed states at ${width}`, async ({page}, testInfo) => {
    await page.setViewportSize({width, height:width === 960 ? 640 : 800});
    await page.emulateMedia({reducedMotion:"reduce"});
    const fixture = withVideo(healthyBackendFixture());
    fixture.responses.listLuts = {luts:[]};
    fixture.responseSequences = {
      pickLutFile:[{path:""},{path:"broken.cube"},{path:"warm.cube"}],
      loadLut:[{ok:false,error:"The LUT file is invalid. Choose another .cube file."},
        {path:"C:/looks/warm.cube",name:"Warm evening light.cube",size:2,table_url:"https://lut.test/flow",token:"lut"}],
    };
    let releaseTable!: () => void;
    const tableReady = new Promise<void>(resolve => { releaseTable = resolve; });
    await page.route("https://lut.test/flow", async route => {
      await tableReady;
      await route.fulfill({body:Buffer.from(new Float32Array(24).buffer),headers:{"Access-Control-Allow-Origin":"*"}});
    });
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (width === 960) await page.getByRole("button",{name:"Inspector",exact:true}).click();
    const panel = page.locator("#lut-panel");
    await panel.locator(":scope > summary").click();
    const picker = page.getByRole("button",{name:/^LUT /});
    const importButton = panel.getByRole("button",{name:"Import",exact:true});
    const apply = panel.getByRole("switch",{name:"Apply LUT",exact:true});
    await expect(panel.getByRole("switch")).toHaveCount(0);
    await expect(panel.getByRole("slider")).toHaveCount(0);
    await expect(page.locator("#lut-summary")).toHaveText("Not selected");
    await expect(picker).toHaveAccessibleName("LUT No LUT selected");
    await picker.click();
    await expect(page.locator("#lut-options").getByRole("option")).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Remove LUT",exact:true})).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    await importButton.click();
    await expect(page.locator("#lut-summary")).toHaveText("Not selected");
    await expect(page.locator("#lut-error")).toBeHidden();
    await importButton.click();
    await expect(page.locator("#lut-error")).toContainText("Choose another .cube file");
    await expect(importButton).toBeEnabled();
    await panel.screenshot({path:testInfo.outputPath(`empty-error-${width}.png`)});
    await importButton.click();
    await expect(page.locator("#lut-summary")).toHaveText("Loading…");
    await expect(page.locator("#lut-status")).toHaveText("Loading LUT…");
    await expect(picker).toBeDisabled();
    await expect(panel.getByRole("switch")).toHaveCount(0);
    releaseTable();
    await expect(apply).toBeChecked();
    await expect(page.locator("#lut-error")).toBeHidden();
    await page.getByLabel("Strength",{exact:true}).fill("40");
    await expect(page.locator("#lut-summary")).toHaveText("40%");
    await apply.focus();
    await page.keyboard.press("Space");
    await expect(page.locator("#lut-summary")).toHaveText("Off");
    await expect(picker).toHaveText("Warm evening light.cube");
    await expect(page.getByLabel("Strength",{exact:true})).toHaveValue("40");
    await expect(page.getByLabel("Strength",{exact:true})).toBeDisabled();
    await expect(page.locator("#lut-apply-help")).toHaveText("Off in preview and export.");
    await panel.screenshot({path:testInfo.outputPath(`off-${width}.png`)});
    await page.keyboard.press("Space");
    await expect(page.locator("#lut-summary")).toHaveText("40%");
    await apply.uncheck();
    await picker.click();
    await page.getByRole("option",{name:"Warm evening light.cube",exact:true}).click();
    await expect(apply).toBeChecked();
    await expect(page.getByLabel("Strength",{exact:true})).toHaveValue("40");
    await picker.click();
    const remove = page.getByRole("button",{name:"Remove LUT",exact:true});
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(picker).toBeFocused();
    await expect(page.locator("#lut-summary")).toHaveText("Not selected");
    await expect(panel.getByRole("switch")).toHaveCount(0);
    await expect(panel.getByRole("slider")).toHaveCount(0);
    await expect(picker).toHaveAccessibleName("LUT No LUT selected");
    await panel.screenshot({path:testInfo.outputPath(`removed-${width}.png`)});
    await picker.click();
    await expect(page.getByRole("option",{name:"Warm evening light.cube",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Remove LUT",exact:true})).toBeHidden();
  });
}
