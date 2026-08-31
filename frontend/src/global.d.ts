import type { BackendCall, BackendClient } from "./backend/types.ts";
import type { DelegatedEventRegistry, bindDelegatedEvents, createDelegatedEventRegistry } from "./ui/delegated-events.ts";
import type { escapeHtml } from "./ui/dom.ts";
import type { notificationPresentation, createNotificationMessage } from "./ui/notifications.ts";
import type { beginProbe, completeProbe, failProbe, probeStatus, isProbeReady, allProbesReady } from "./state/probe.ts";
import type { settingsSnapshot, settingsAreDirty } from "./state/settings-state.ts";
import type * as Layout from "./ui/layout.ts";

declare global {
  interface Window {
    __tuckFakeBackendCalls?: BackendCall[];
    attachBackendClient?: (client: BackendClient) => void;
    initApp?: (data: unknown) => void;
    pywebview?: { api?: unknown };
    tuckBackendClient?: BackendClient;
    Tuck?: {
      dom?: { escapeHtml: typeof escapeHtml };
      delegatedEvents?: { bind: typeof bindDelegatedEvents; createRegistry: typeof createDelegatedEventRegistry };
      uiEvents?: DelegatedEventRegistry;
      [key: string]: unknown;
    };
    TuckNotifications?: { presentation: typeof notificationPresentation; createMessageElement: typeof createNotificationMessage };
    TuckProbeState?: { begin: typeof beginProbe; complete: typeof completeProbe; fail: typeof failProbe; status: typeof probeStatus; isReady: typeof isProbeReady; allReady: typeof allProbesReady };
    TuckSettingsState?: { snapshot: typeof settingsSnapshot; isDirty: typeof settingsAreDirty };
    TuckLayout?: typeof Layout;
  }
}

export {};
