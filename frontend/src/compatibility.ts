import { bindDelegatedEvents, createDelegatedEventRegistry } from "./ui/delegated-events.ts";
import { escapeHtml } from "./ui/dom.ts";
import {
  initialTimelineHeightSetting,
  initialWorkspacePanels,
  clampTimelineHeight,
  normalizeTimelineHeightSetting,
  timelineAutoHeight,
  timelineHeightBounds,
  timelineHeightForKey,
  timelineHeightForTrackCount,
  toggleWorkspacePanelState,
  workspaceMode,
} from "./ui/layout.ts";
import { createNotificationMessage, notificationPresentation } from "./ui/notifications.ts";
import { allProbesReady, beginProbe, completeProbe, failProbe, isProbeReady, probeStatus } from "./state/probe.ts";
import { settingsAreDirty, settingsSnapshot } from "./state/settings-state.ts";

export interface CompatibilityExport {
  readonly name: string;
  readonly owner: string;
  readonly purpose: string;
  readonly removeAfter: "legacy frontend removal";
}

export const COMPATIBILITY_EXPORTS: readonly CompatibilityExport[] = Object.freeze([
  {
    name: "window.Tuck",
    owner: "frontend/src/compatibility.ts",
    purpose: "Named namespace used by remaining classic feature scripts.",
    removeAfter: "legacy frontend removal",
  },
  {
    name: "window.TuckNotifications",
    owner: "frontend/src/ui/notifications.ts",
    purpose: "Safe notification presentation helpers for the classic application shell.",
    removeAfter: "legacy frontend removal",
  },
  {
    name: "window.TuckProbeState",
    owner: "frontend/src/state/probe.ts",
    purpose: "Probe lifecycle helpers retained for editor feature scripts.",
    removeAfter: "legacy frontend removal",
  },
  {
    name: "window.TuckSettingsState",
    owner: "frontend/src/state/settings-state.ts",
    purpose: "Settings dirty-state helpers retained for the settings feature script.",
    removeAfter: "legacy frontend removal",
  },
  {
    name: "window.TuckLayout",
    owner: "frontend/src/ui/layout.ts",
    purpose: "Shared responsive layout helpers retained for editor feature scripts.",
    removeAfter: "legacy frontend removal",
  },
]);

export function installLegacyFoundationCompatibility(windowRef: Window): void {
  const tuck = windowRef.Tuck ?? {};
  tuck.dom = { escapeHtml };
  tuck.delegatedEvents = { bind: bindDelegatedEvents, createRegistry: createDelegatedEventRegistry };
  if (windowRef.document.body && !tuck.uiEvents) {
    tuck.uiEvents = createDelegatedEventRegistry(windowRef.document.body);
  }
  windowRef.Tuck = tuck;
  windowRef.TuckNotifications = { presentation: notificationPresentation, createMessageElement: createNotificationMessage };
  windowRef.TuckProbeState = { begin: beginProbe, complete: completeProbe, fail: failProbe, status: probeStatus, isReady: isProbeReady, allReady: allProbesReady };
  windowRef.TuckSettingsState = { snapshot: settingsSnapshot, isDirty: settingsAreDirty };
  windowRef.TuckLayout = { timelineHeightBounds, timelineAutoHeight, clampTimelineHeight, normalizeTimelineHeightSetting, initialTimelineHeightSetting, timelineHeightForTrackCount, timelineHeightForKey, workspaceMode, initialWorkspacePanels, toggleWorkspacePanelState };
}

const LEGACY_FEATURE_SCRIPTS = [
  "./legacy/encoding-ui.js",
  "./legacy/queue.js",
  "./legacy/settings-profiles.js",
  "./legacy/settings.js",
  "./legacy/ui-bindings.js",
] as const;

export type LegacyScriptLoader = (source: (typeof LEGACY_FEATURE_SCRIPTS)[number]) => Promise<void>;

export async function loadLegacyFeatureScripts(
  load: LegacyScriptLoader,
): Promise<void> {
  for (const source of LEGACY_FEATURE_SCRIPTS) await load(source);
}

export function loadClassicScript(documentRef: Document, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = documentRef.createElement("script");
    script.src = source;
    script.async = false;
    script.onload = (): void => resolve();
    script.onerror = (): void => reject(new Error(`Could not load ${source}`));
    documentRef.head.append(script);
  });
}
