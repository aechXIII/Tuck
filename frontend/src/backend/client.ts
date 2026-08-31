import type { BackendClient } from "./types.ts";

let applicationClient: BackendClient | undefined;

export function setBackendClient(client: BackendClient): void {
  applicationClient = client;
}

export function getBackendClient(): BackendClient {
  if (!applicationClient) throw new Error("Desktop backend client is not ready");
  return applicationClient;
}

export function hasBackendClient(): boolean {
  return applicationClient !== undefined;
}
