import { invoke } from '@tauri-apps/api/core';

export type Transport = 'http-ts' | 'udp-ts';
export type ControlName = 'bitrate' | 'gop' | 'idr' | 'isp' | 'isp_preset' | 'scene_preset' | 'enhance' | 'highlights' | 'telemetry';
export type Caps = {
  protocol: { major: number; minor: number };
  device: { board: string; soc: string; sensor: string };
  preview?: { width: number; height: number; fps: number; codec: string; transports: string[] } | null;
  ai: { models: { id: string; task: string; label?: string }[]; clip_user?: { model_id: string; embedding_space: string; dimensions: number } };
  controls?: string[];
};

export function supportsControl(caps: Caps | undefined, control: ControlName): boolean {
  return !!caps && (caps.controls?.includes(control) ?? true);
}
export type Detection = {
  cls: number; label: string; score: number; x1: number; y1: number; x2: number; y2: number;
  kps?: [number, number, number][]; sim?: number; map?: string;
};
export type AiFrame = {
  ts: number; model: string; w: number; h: number; infer_ms: number;
  dets: Detection[]; seg?: { w: number; h: number; rle: number[] };
};
export type Device = { host: string; caps: Caps };
export type Item = { name: string; path: string; kind: 'video' | 'photo'; bytes: number; modified: number; highlights: { seconds: number; label: string; score: number }[] };

export const native = {
  connect: (host: string, transport: Transport, session: number) =>
    invoke<Caps>('connect_device', { host, transport, session }),
  close: (session: number) => invoke<void>('disconnect_device', { session }),
  chunk: (session: number) => invoke<ArrayBuffer>('read_preview_chunk', { session }),
  scan: (host: string) => invoke<Device[]>('discover', { host }),
  run: <T = unknown>(session: number, command: string) => invoke<T>('control', { session, command }),
  clip: (session: number, id: number, label: string | null, vector: number[] | null) =>
    invoke('clip_prompt', { session, id, label, vector }),
  recording: (session: number, start: boolean) => invoke<string | null>('record_clip', { session, start }),
  savePhoto: (image: number[]) => invoke<string>('save_photo', { image }),
  gallery: () => invoke<Item[]>('gallery'),
  delete: (name: string) => invoke<void>('delete_media', { name }),
  trim: (name: string, from: number, to: number) => invoke<string>('trim_media', { name, from, to }),
  export: (name: string, directory: string) => invoke<string>('export_media', { name, directory }),
  network: () => invoke<void>('open_network_settings'),
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
