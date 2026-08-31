export type NotificationKind = "err" | "ok" | "info";
export interface NotificationPresentation { readonly kind: NotificationKind; readonly role: "alert" | "status"; readonly live: "assertive" | "polite"; readonly duration: number; }
export function notificationPresentation(kind: string): NotificationPresentation {
  if (kind === "err") return { kind: "err", role: "alert", live: "assertive", duration: 6000 };
  if (kind === "ok") return { kind: "ok", role: "status", live: "polite", duration: 3500 };
  return { kind: "info", role: "status", live: "polite", duration: 3500 };
}
export function createNotificationMessage(documentRef: Document, message: unknown): HTMLSpanElement {
  const element = documentRef.createElement("span"); element.className = "tmsg"; element.textContent = String(message); return element;
}
export { notificationPresentation as presentation, createNotificationMessage as createMessageElement };
