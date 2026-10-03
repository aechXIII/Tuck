export const selectSearchThreshold = 8;

export interface SelectOption {
  value: string;
  label: string;
  detail: string;
  disabled: boolean;
}

export function filterSelectOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const text = query.trim().toLocaleLowerCase();
  return options.filter(option => `${option.label} ${option.detail}`.toLocaleLowerCase().includes(text));
}

export function nextSelectIndex(options: readonly SelectOption[], current: number, direction: 1 | -1): number {
  let index = current < 0 ? (direction === 1 ? 0 : options.length - 1) : current + direction;
  while (index >= 0 && index < options.length) {
    if (!options[index]?.disabled) return index;
    index += direction;
  }
  return current;
}

export function nextSelectMatch(options: readonly SelectOption[], current: number, prefix: string, advance: boolean): number {
  const text = prefix.toLocaleLowerCase();
  const start = current < 0 ? 0 : current + Number(advance);
  for (let offset = 0; offset < options.length; offset++) {
    const index = (start + offset) % options.length;
    const option = options[index];
    if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(text)) return index;
  }
  return current;
}

export function selectTypeaheadPrefix(
  typed: string, lastTyped: number, key: string, timestamp: number, repeatToCycle = true,
): string {
  const previous = timestamp - lastTyped > 650 ? "" : typed;
  const repeated = repeatToCycle && previous.length > 0 &&
    [...previous.toLocaleLowerCase()].every(letter => letter === key.toLocaleLowerCase());
  return repeated ? key : previous + key;
}

export function selectPopupPlacement(
  anchor: { left: number; top: number; bottom: number; width: number },
  desiredHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  gap = 6,
): { left: number; top: number; width: number; maxHeight: number } {
  const margin = 8;
  const width = Math.min(anchor.width, Math.max(0, viewportWidth - margin * 2));
  const below = Math.max(0, viewportHeight - margin - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - margin);
  const upward = below < desiredHeight && above > below;
  const maxHeight = upward ? above : below;
  const height = Math.min(desiredHeight, maxHeight);
  return {
    left: Math.max(margin, Math.min(anchor.left, viewportWidth - margin - width)),
    top: Math.max(margin, upward ? anchor.top - gap - height : anchor.bottom + gap),
    width,
    maxHeight: height,
  };
}
