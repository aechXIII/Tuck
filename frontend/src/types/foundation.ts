export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly muted?: boolean;
}

export interface ClipState {
  readonly name: string;
  readonly path: string;
  readonly [key: string]: JsonValue | readonly Segment[] | undefined;
}

export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
}

export interface QueueItemState {
  readonly id: string;
  readonly state: string;
}

export type AppSettings = Readonly<Record<string, JsonValue>>;
