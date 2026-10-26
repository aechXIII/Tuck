import type { Page } from "@playwright/test";

import type { FixtureEngine } from "./fixture-engine";

declare global {
  interface Window {
    __fixtureEngine?: FixtureEngine;
    __mixRequests?: Record<string, unknown>[];
  }
}

/**
 * Answers every preview mix compile with its own numbered mix and keeps the request, standing in
 * for Python, whose mixes `tests/test_audio_mix.py` checks. Run it after the page has loaded and
 * before the first video opens.
 */
export async function answerMixes(page: Page, duration: number): Promise<void> {
  await page.evaluate((duration) => {
    window.__mixRequests = [];
    window.tuckBackendClient!.compilePreviewMix = async (request) => {
      window.__mixRequests!.push(JSON.parse(JSON.stringify(request)));
      const piece = { start: 0, end: duration, sourceIn: 0, gain: 1, fadeIn: 0, fadeOut: 0, loopStart: 0, loopSpan: 0 };
      const data = { duration, voices: [{ path: `answer-${window.__mixRequests!.length}`, stream: 0, pieces: [piece] }] };
      return { ok: true, value: { data } };
    };
  }, duration);
}

/** The newest request the page asked to have mixed. */
export function newestMixRequest(page: Page): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(() => window.__mixRequests?.at(-1));
}

/**
 * How many mixes were asked for, and which answer the engine was last given; equal when the
 * engine plays the answer to the newest request.
 */
export function mixAnswers(page: Page): Promise<{ asked: number; playing: number }> {
  return page.evaluate(() => {
    const last = (window.__fixtureEngine?.mixes ?? []).at(-1) as { voices?: Array<{ path?: string }> } | undefined;
    const playing = Number(/^answer-(\d+)$/.exec(last?.voices?.[0]?.path ?? "")?.[1] ?? 0);
    return { asked: window.__mixRequests?.length ?? 0, playing };
  });
}
