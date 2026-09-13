export { getBackendClient, hasBackendClient, setBackendClient } from "./client.ts";
export { createFakeBackendClient } from "./fake.ts";
export {
  createTauriBackendClient,
  createTauriBackendClientFromWindow,
  hasTauriInvoke,
} from "./tauri.ts";
export type {
  BackendCall,
  BackendClient,
  BackendError,
  BackendResult,
  DomainBackendClient,
  NativeBackendClient,
} from "./types.ts";
export type { TauriBackendClient, TauriInvoke } from "./tauri.ts";
