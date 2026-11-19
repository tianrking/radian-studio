import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { errorText, native, type AiFrame, type Caps, type Transport } from './api';
import { play } from './player';

type Phase = 'idle' | 'probing' | 'loading' | 'live' | 'retrying' | 'error';
type Target = { host: string; transport: Transport };
type Status = { phase: Phase; error?: string; target?: Target };
const retries = [500, 1000, 2000, 4000, 5000];

export function useCamera() {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>({ phase: 'idle' });
  const [caps, setCaps] = useState<Caps>();
  const [frame, setFrame] = useState<AiFrame>();
  const [recording, setRecording] = useState(false);
  const [lastCapture, setLastCapture] = useState('');
  const [ready, setReady] = useState(false);
  const [codec, setCodec] = useState('');
  const target = useRef<Target | null>(null);
  const active = useRef(0);
  const authenticated = useRef<number | null>(null);
  const retry = useRef<number | undefined>(undefined);
  const attempts = useRef(0);
  const playback = useRef<AbortController | null>(null);
  const watch = useRef({ id: 0, last: 0, position: -1 });
  const lastAi = useRef(0);
  const beginRef = useRef<(next: Target) => void>(() => {});

  const fail = useCallback((id: number, error: string) => {
    if (active.current !== id || !target.current || retry.current !== undefined) return;
    playback.current?.abort();
    const next = target.current;
    const terminal = /Unsupported protocol|Invalid GET_CAPS|Invalid capability|does not advertise|does not support|Could not launch FFmpeg|Enter a valid IPv4/i.test(error);
    authenticated.current = null;
    setRecording(false);
    setFrame(undefined);
    setStatus({ phase: terminal ? 'error' : 'retrying', error, target: next });
    if (!terminal) {
      const delay = retries[Math.min(attempts.current++, retries.length - 1)];
      retry.current = window.setTimeout(() => {
        retry.current = undefined;
        beginRef.current(next);
      }, delay);
    } else {
      void native.close(id).catch(() => {});
    }
  }, []);

  const begin = useCallback((next: Target) => {
    window.clearTimeout(retry.current);
    retry.current = undefined;
    playback.current?.abort();
    target.current = next;
    const element = video.current;
    if (element?.hasAttribute("src")) { element.removeAttribute("src"); element.load(); }
    const id = ++active.current;
    authenticated.current = null;
    watch.current = { id, last: performance.now(), position: -1 };
    lastAi.current = 0;
    setCaps(undefined);
    setRecording(false);
    setFrame(undefined);
    setCodec('');
    setStatus({ phase: 'probing', target: next });
    void native.connect(next.host, next.transport, id).then((found) => {
      if (id !== active.current || !target.current) return;
      authenticated.current = id;
      setCaps(found);
      setStatus((previous) => previous.phase === 'probing' ? { phase: 'loading', target: next } : previous);
    }, (error: unknown) => fail(id, errorText(error)));
  }, [fail]);

  useEffect(() => { beginRef.current = begin; }, [begin]);

  const stop = useCallback(() => {
    target.current = null;
    const id = active.current++;
    authenticated.current = null;
    window.clearTimeout(retry.current);
    retry.current = undefined;
    playback.current?.abort();
    setFrame(undefined);
    setCaps(undefined);
    setRecording(false);
    setCodec('');
    setStatus({ phase: 'idle' });
    void native.close(id).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const observers = Promise.all([
      listen<{ session: number; codec: string }>('preview-format', ({ payload }) => {
        const element = video.current;
        if (!element || active.current !== payload.session || !target.current) return;
        playback.current?.abort();
        const controller = new AbortController();
        playback.current = controller;
        setCodec(payload.codec);
        void play(element, payload.codec, payload.session, controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) fail(payload.session, errorText(error));
        });
      }),
      listen<{ session: number; error: string }>('preview-ended', ({ payload }) => fail(payload.session, payload.error)),
      listen<{ session: number; data: AiFrame }>('ai-frame', ({ payload }) => {
        if (active.current !== payload.session || !target.current) return;
        const now = performance.now();
        if (now - lastAi.current < 45) return;
        lastAi.current = now;
        setFrame(payload.data);
      }),
      listen<boolean>('recording-ended', ({ payload }) => {
        setRecording(false);
        if (payload) setLastCapture('Clip saved after connection closed');
      }),
      listen<string>('ai-error', ({ payload }) => setLastCapture(payload)),
      listen<string>('recording-error', ({ payload }) => {
        setRecording(false);
        setLastCapture(payload);
      }),
    ]);
    void observers.then(() => { if (alive) setReady(true); }, (err: unknown) => {
      if (alive) setStatus({ phase: 'error', error: errorText(err) });
    });
    const clock = window.setInterval(() => {
      const current = target.current;
      const element = video.current;
      const state = watch.current;
      const now = performance.now();
      if (!current || !element || retry.current !== undefined || state.id !== active.current) return;
      if (lastAi.current && now - lastAi.current > 1500) {
        lastAi.current = 0;
        setFrame(undefined);
      }
      if (element.readyState >= 2 && element.videoWidth > 0 && element.currentTime > state.position + 0.001) {
        const first = state.position < 0;
        state.last = now;
        state.position = element.currentTime;
        if (first) {
          attempts.current = 0;
          setStatus({ phase: 'live', target: current });
        }
      } else if (authenticated.current === state.id && now - state.last > (state.position < 0 ? 6500 : 3000)) {
        fail(state.id, state.position < 0 ? 'No decodable first frame yet' : 'The camera stopped sending new frames');
      }
    }, 250);
    return () => {
      alive = false;
      window.clearInterval(clock);
      window.clearTimeout(retry.current);
      playback.current?.abort();
      void observers.then((results) => results.forEach((unlisten) => unlisten()), () => {});
    };
  }, [fail]);

  function connect(next: Target) {
    attempts.current = 0;
    begin(next);
  }

  async function capture() {
    const element = video.current;
    if (!element?.videoWidth || element.readyState < 2) throw new Error('Wait for a live frame');
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot initialize photo capture');
    ctx.drawImage(element, 0, 0);
    const jpg = await new Promise<Blob>((ok, fail) =>
      canvas.toBlob((data) => data ? ok(data) : fail(new Error('Photo encoding failed')), 'image/jpeg', 0.93));
    const name = await native.savePhoto(Array.from(new Uint8Array(await jpg.arrayBuffer())));
    setLastCapture(name);
  }

  async function toggleRecording() {
    const next = !recording;
    const saved = await native.recording(active.current, next);
    setRecording(next);
    if (saved) setLastCapture(saved);
    if (!next && !saved) setLastCapture('No video keyframe arrived before recording stopped');
  }

  return { video, status, caps, frame, recording, lastCapture, ready, codec, connect, stop, capture,
    toggleRecording, session: authenticated.current };
}
