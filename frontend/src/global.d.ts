import type { BackendCall, BackendClient } from "./backend/types.ts";

declare global {
  interface Window {
    __tuckFakeBackendCalls?: BackendCall[];
    attachBackendClient?: (client: BackendClient) => void;
    initApp?: (data: unknown) => void;
    tuckBackendClient?: BackendClient;
  }
}

export {};
