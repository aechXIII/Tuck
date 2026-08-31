export function settingsSnapshot(value: unknown): string { return JSON.stringify(value ?? {}); }
export function settingsAreDirty(openingSnapshot: string, currentValue: unknown): boolean { return Boolean(openingSnapshot) && settingsSnapshot(currentValue) !== openingSnapshot; }
export { settingsSnapshot as snapshot, settingsAreDirty as isDirty };
