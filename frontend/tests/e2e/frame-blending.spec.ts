import { chooseSelect } from "../fixtures/select";
import { expect, test } from "@playwright/test";
import { healthyBackendFixture, installFakeBackend } from "../fixtures/fake-backend";

declare global { interface Window { __firstBar?: Element | null } }

for (const size of [{width:1240,height:800}, {width:960,height:640}]) {
  test(`frame blending controls at ${size.width}x${size.height}`, async ({page}) => {
    await page.setViewportSize(size);
    await page.emulateMedia({reducedMotion:"reduce"});
    const fixture = healthyBackendFixture();
    fixture.responses.pickFiles = {ok:true,files:["C:\\media\\high-fps.mp4"]};
    fixture.responses.probeFile = {ok:true,data:{duration:12,width:1920,height:1080,fps:120,has_audio:true}};
    fixture.responses.getMediaUrl = {ok:true,url:"https://media.test/v",token:"t"};
    fixture.responses.getThumbnail = {ok:true,thumbnail:""};
    fixture.responses.enqueueWithOptions = {ok:true};
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installFakeBackend(page, fixture);
    await page.goto("/");
    if (size.width === 960) await page.getByRole("button", {name:"Library", exact:true}).click();
    await page.locator("#btn-add").click();
    if (size.width === 960) await page.getByRole("button", {name:"Inspector", exact:true}).click();
    const panel = page.locator("#frame-blending-panel");
    await expect(panel.locator("#blend-summary")).toHaveText("Off");
    await panel.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Enable frame blending")).toBeVisible();
    await expect(page.getByLabel("Blur amount")).toBeVisible();
    await expect(page.getByLabel("Blur amount")).toBeDisabled();
    await page.getByLabel("Enable frame blending").check();
    await page.getByLabel("Blur amount").focus();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByLabel("Blur amount")).toHaveValue("1.01");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByLabel("Blur amount")).toHaveValue("1");
    await page.getByLabel("Blur amount").fill("1.23");
    await expect(page.getByRole("button", {name:"Compress this video", exact:true})).toBeEnabled();
    await page.getByLabel("Blur amount").fill("1");
    await chooseSelect(page, page.getByLabel("Output frame rate", {exact:true}), "30");
    await expect(page.locator("#blend-readout")).toHaveCount(0);
    await expect(page.locator("#blend-amount-help")).toHaveCount(0);
    await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "vegas");
    await expect(page.locator("#blend-chart")).toHaveAttribute("aria-label", /vegas/);
    const preview = await page.locator(".blend-preview").evaluate(figure => {
      const bars = Array.from(figure.querySelectorAll("rect"));
      const labels = figure.querySelectorAll("figcaption span");
      return {
        visible: bars.every(bar => bar.getBoundingClientRect().height > 0),
        left: bars[0]!.getBoundingClientRect().left - labels[0]!.getBoundingClientRect().left,
        right: bars.at(-1)!.getBoundingClientRect().right - labels[2]!.getBoundingClientRect().right,
      };
    });
    expect(preview.visible).toBe(true);
    expect(Math.abs(preview.left)).toBeLessThan(1);
    expect(Math.abs(preview.right)).toBeLessThan(1);
    await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "equal");
    await chooseSelect(page, page.getByLabel("Output frame rate", {exact:true}), "custom");
    await page.getByLabel("Target frame rate", {exact:true}).fill("29.97");
    const equalChart = await page.locator("#blend-chart").innerHTML();
    await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "gaussian");
    expect(await page.locator("#blend-chart").innerHTML()).not.toBe(equalChart);
    await page.getByText("Advanced settings", {exact:true}).click();
    await expect(page.getByLabel("Gaussian width", {exact:true})).toBeVisible();
    await page.getByLabel("Gaussian width", {exact:true}).fill("");
    await expect(page.getByRole("button", {name:"Compress this video", exact:true})).toBeDisabled();
    await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "equal");
    await expect(page.getByRole("button", {name:"Compress this video", exact:true})).toBeEnabled();
    await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "gaussian");
    await page.getByLabel("Gaussian width", {exact:true}).fill("0.3");
    await page.getByLabel("Custom weights", {exact:false}).fill("0, 0");
    await expect(page.locator("#blend-error")).toContainText("positive");
    await expect(page.getByRole("button", {name:"Compress this video", exact:true})).toBeDisabled();
    await page.getByLabel("Custom weights", {exact:false}).fill("1, 2, 1");
    await page.getByLabel("Blend in linear light", {exact:true}).check();
    await expect(page.locator("#blend-error")).toBeHidden();
    await page.getByRole("button", {name:"Compress this video", exact:true}).click();
    await expect.poll(async () => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter(c=>c.method==="enqueueWithOptions").length)).toBe(1);
    const request = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).find(c=>c.method==="enqueueWithOptions")?.args[0]);
    expect(request).toMatchObject({custom_fps:29.97, frame_blending:{enabled:true,curve:"gaussian",sigma:.3,custom_weights:[1,2,1],linear_light:true}});
    await page.getByRole("button", {name:"Upscale", exact:true}).click();
    await expect(panel).toBeVisible();
    await page.getByLabel("Blur amount").fill("");
    await page.getByLabel("Custom weights", {exact:false}).fill("0, 0");
    await page.getByLabel("Enable frame blending").uncheck();
    await expect(page.getByLabel("Blur amount")).toBeVisible();
    await expect(page.getByLabel("Blur amount")).toBeDisabled();
    await page.getByRole("button", {name:"Upscale this video", exact:true}).click();
    const disabledRequest = await page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter(c=>c.method==="enqueueWithOptions").at(-1)?.args[0]);
    expect(disabledRequest).toMatchObject({frame_blending:{enabled:false,amount:1,custom_weights:[]}});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}


test("Vegas has a weight preview before a video is added", async ({page}) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.locator("#frame-blending-panel > summary").click();
  await page.getByLabel("Enable frame blending").check();
  await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "vegas");
  const bars = page.locator("#blend-chart rect");
  await expect(bars).toHaveCount(32);
  expect(await bars.evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height > 0))).toBe(true);
});

test("the weight chart keeps its bars while the queue polls", async ({page}) => {
  await installFakeBackend(page, healthyBackendFixture());
  await page.goto("/");
  await page.locator("#frame-blending-panel > summary").click();
  await page.getByLabel("Enable frame blending").check();
  await expect(page.locator("#blend-chart rect")).toHaveCount(32);
  const polls = () => page.evaluate(() => (window.__tuckFakeBackendCalls ?? []).filter(call => call.method === "getQueueState").length);
  await page.evaluate(() => { window.__firstBar = document.querySelector("#blend-chart rect"); });
  const before = await polls();
  // every poll refreshes the export panel; the bars must survive it
  await expect.poll(polls).toBeGreaterThanOrEqual(before + 2);
  expect(await page.evaluate(() => document.querySelector("#blend-chart rect") === window.__firstBar)).toBe(true);
  await chooseSelect(page, page.getByLabel("Weighting", {exact:true}), "ascending");
  const heights = await page.locator("#blend-chart rect").evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("height"))));
  expect(heights[0]).toBeLessThan(heights[31]!);
  expect(await page.evaluate(() => document.querySelector("#blend-chart rect") === window.__firstBar)).toBe(true);
});
