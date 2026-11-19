import { native } from './api';

function once(target: EventTarget, name: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const cleanup = () => {
      target.removeEventListener(name, done);
      target.removeEventListener('error', fail);
      target.removeEventListener('sourceclose', fail);
      signal.removeEventListener('abort', fail);
    };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(signal.reason ?? new Error('Media source failed')); };
    target.addEventListener(name, done, { once: true });
    target.addEventListener('error', fail, { once: true });
    target.addEventListener('sourceclose', fail, { once: true });
    signal.addEventListener('abort', fail, { once: true });
  });
}

export async function play(video: HTMLVideoElement, codec: string, session: number, signal: AbortSignal) {
  const mime = `video/mp4; codecs="${codec}"`;
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mime)) {
    throw new Error(`The system WebView does not support ${codec} through MediaSource`);
  }
  const source = new MediaSource();
  const url = URL.createObjectURL(source);
  const release = () => {
    if (video.getAttribute('src') === url) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    URL.revokeObjectURL(url);
  };
  try {
    const opened = once(source, 'sourceopen', signal);
    video.src = url;
    await opened;
    const buffer = source.addSourceBuffer(mime);
    while (!signal.aborted) {
      const chunk = await native.chunk(session);
      if (signal.aborted) return;
      buffer.appendBuffer(chunk);
      await once(buffer, 'updateend', signal);
      const ranges = buffer.buffered;
      if (!ranges.length) continue;
      const start = ranges.start(ranges.length - 1);
      const end = ranges.end(ranges.length - 1);
      if (video.currentTime < start || end - video.currentTime > 2) {
        video.currentTime = Math.max(start, end - 0.35);
      }
      if (video.paused) void video.play().catch(() => {});
      const cutoff = video.currentTime - 4;
      if (ranges.start(0) + 1 < cutoff) {
        buffer.remove(0, cutoff);
        await once(buffer, 'updateend', signal);
      }
    }
  } finally {
    release();
  }
}
