import type { AccentColor, InterfaceSize } from "../../backend/types.ts";

export const ACCENT_COLORS: readonly AccentColor[] = ["violet", "blue", "teal", "green", "amber", "rose"];
export const INTERFACE_SIZES: readonly InterfaceSize[] = ["compact", "default", "large"];

export function accentColor(value: unknown): AccentColor {
  return ACCENT_COLORS.includes(value as AccentColor) ? (value as AccentColor) : "violet";
}

export function interfaceSize(value: unknown): InterfaceSize {
  return INTERFACE_SIZES.includes(value as InterfaceSize) ? (value as InterfaceSize) : "default";
}

/** Puts the look the user chose on the root element; the stylesheets read these attributes. */
export function applyAppearance(root: HTMLElement, settings: Readonly<Record<string, unknown>>): void {
  const accent = accentColor(settings.accent_color);
  if (accent === "violet") delete root.dataset.accent;
  else root.dataset.accent = accent;
  if (settings.animations === false) root.dataset.motion = "off";
  else delete root.dataset.motion;
}

/**
 * Keeps the window's interface size in step with the setting. The native call only runs when
 * the size changes; a failure is logged and the interface stays at its current size.
 */
export function createInterfaceSizer(apply: (size: InterfaceSize) => Promise<{ ok: boolean; error?: unknown }>) {
  let applied: InterfaceSize = "default";
  let wanted: InterfaceSize = "default";
  let queue: Promise<void> = Promise.resolve();
  // changes run one at a time and each applies the newest choice, so a quick second change
  // can't be skipped while the first is still on its way
  return (value: unknown): Promise<void> => {
    wanted = interfaceSize(value);
    queue = queue.then(async () => {
      const size = wanted;
      if (size === applied) return;
      const result = await apply(size);
      if (result.ok) applied = size;
      else console.warn("[tuck] could not change the interface size", result.error);
    });
    return queue;
  };
}
