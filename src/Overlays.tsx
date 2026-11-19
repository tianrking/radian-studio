import { useEffect, useRef, type RefObject } from 'react';
import type { AiFrame } from './api';

const colors = ['#d7f976', '#6ee7bd', '#ffbe63', '#8bbaff', '#f9a9dd', '#e9ea8a'];
const poses = [[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]];
const hand = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20]];

export function Overlays({ frame, boxes, regions, grid }: { frame?: AiFrame; boxes: boolean; regions: boolean; grid: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!context || !canvas) return;
    context.resetTransform();
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) return;
    const scale = Math.min(1, 1600 / frame.w);
    canvas.width = Math.max(1, Math.floor(frame.w * scale));
    canvas.height = Math.max(1, Math.floor(frame.h * scale));
    context.scale(scale, scale);
    const { seg } = frame;
    if (regions && seg && Number.isInteger(seg.w) && Number.isInteger(seg.h) && seg.w > 0 && seg.h > 0 && seg.w * seg.h <= 262144 && Array.isArray(seg.rle)) {
      const mask = document.createElement('canvas');
      mask.width = seg.w; mask.height = seg.h;
      const ctx = mask.getContext('2d');
      if (ctx) {
        const img = ctx.createImageData(seg.w, seg.h);
        for (let i = 0, at = 0; i + 1 < seg.rle.length && at < seg.w * seg.h; i += 2) {
          const [value, run] = [seg.rle[i], seg.rle[i + 1]];
          if (!Number.isInteger(value) || !Number.isInteger(run) || run < 1 || at + run > seg.w * seg.h) break;
          if (value > 0) for (let end = at + run; at < end; at++) img.data.set([157, 244, 113, 100], at * 4);
          else at += run;
        }
        ctx.putImageData(img, 0, 0);
        context.imageSmoothingEnabled = false;
        context.drawImage(mask, 0, 0, frame.w, frame.h);
      }
    }
    context.font = `600 ${Math.max(13, frame.w / 69)}px system-ui`;
    context.lineWidth = Math.max(2, frame.w / 430);
    for (const [index, det] of frame.dets.entries()) {
      if (!det || typeof det.label !== 'string' || ![det.x1,det.y1,det.x2,det.y2].every(Number.isFinite)) continue;
      const color = colors[index % colors.length];
      const map = typeof det.map === 'string' ? /^(\d{1,2})x(\d{1,2}):([\da-f]+)$/i.exec(det.map) : null;
      if (regions && map) {
        const cols = Number(map[1]), rows = Number(map[2]), hex = map[3];
        if (cols && rows && cols * rows === hex.length) {
          const cellW = frame.w / cols, cellH = frame.h / rows;
          for (let i = 0; i < hex.length; i++) {
            context.fillStyle = `rgba(193,250,89,${(parseInt(hex[i], 16) / 15) * 0.28})`;
            context.fillRect((i % cols) * cellW, Math.floor(i / cols) * cellH, cellW, cellH);
          }
        }
      }
      if (!boxes) continue;
      context.strokeStyle = color;
      const w = det.x2 - det.x1, h = det.y2 - det.y1;
      if (w > 0 && h > 0) {
        context.strokeRect(det.x1, det.y1, w, h);
        const score = typeof det.sim !== 'number' ? `${Math.round(det.score * 100)}%` : det.sim.toFixed(2);
        const label = `${det.label}  ${score}`;
        const size = Math.max(20, frame.w / 42);
        const y = Math.max(0, det.y1 - size);
        context.fillStyle = color;
        context.fillRect(det.x1, y, context.measureText(label).width + 14, size);
        context.fillStyle = '#101510';
        context.fillText(label, det.x1 + 7, y + size * 0.69);
      }
      if (!Array.isArray(det.kps)) continue;
      const kps = det.kps;
      const valid = (point: [number, number, number] | undefined) => Array.isArray(point) && point.every(Number.isFinite) && point[0] >= 0 && point[1] >= 0 && point[2] > 0;
      const edges = kps.length === 17 ? poses : kps.length === 21 ? hand : kps.length === 4 && frame.model === 'obb' ? [[0,1],[1,2],[2,3],[3,0]] : [];
      context.beginPath();
      for (const [a,b] of edges) {
        if (valid(kps[a]) && valid(kps[b])) {
          context.moveTo(kps[a][0], kps[a][1]);
          context.lineTo(kps[b][0], kps[b][1]);
        }
      }
      context.stroke();
      context.fillStyle = color;
      for (const point of kps) if (valid(point)) {
        context.beginPath();
        context.arc(point[0], point[1], Math.max(2, frame.w / 290), 0, Math.PI*2);
        context.fill();
      }
    }
  }, [frame, boxes, regions]);
  return <><canvas ref={ref} className="ai-canvas" aria-label={frame ? `${frame.dets.length} detections` : 'AI overlay'} />{grid ? <div className="framing-grid" /> : null}</>;
}

export function Histogram({ video }: { video: RefObject<HTMLVideoElement | null> }) {
  const out = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const sample = document.createElement('canvas');
    sample.width = 96; sample.height = 54;
    const input = sample.getContext('2d', { willReadFrequently: true });
    const output = out.current?.getContext('2d');
    if (!output || !input) return;
    const tick = window.setInterval(() => {
      const element = video.current;
      if (!element || element.readyState < 2) return;
      input.drawImage(element, 0, 0, sample.width, sample.height);
      const pixels = input.getImageData(0, 0, sample.width, sample.height).data;
      const levels = new Uint16Array(48);
      for (let i = 0; i < pixels.length; i += 4) {
        const light = pixels[i] * 0.2126 + pixels[i+1] * 0.7152 + pixels[i+2] * 0.0722;
        levels[Math.min(47, Math.floor(light * 48 / 256))]++;
      }
      const max = Math.max(...levels, 1);
      output.clearRect(0,0,192,52);
      output.fillStyle = '#c7ec79';
      levels.forEach((count, index) => {
        const height = count / max * 47;
        output.fillRect(index * 4, 52-height, 3, height);
      });
    }, 500);
    return () => window.clearInterval(tick);
  }, [video]);
  return <canvas className="histogram" width={192} height={52} ref={out} aria-label="Live luminance histogram" />;
}

export function FrameSurface({ video, live }: { video: RefObject<HTMLVideoElement | null>; live: boolean }) {
  const surface = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = surface.current;
    const element = video.current;
    const context = canvas?.getContext('2d', { alpha: false });
    if (!live || !canvas || !element || !context) return;
    let position = -1;
    let token = 0;
    const videoCallbacks = typeof element.requestVideoFrameCallback === 'function';
    function paint() {
      if (!canvas || !element || !context) return;
      if (element.readyState >= 2 && element.videoWidth > 0 && element.currentTime !== position) {
        const width = Math.min(1920, element.videoWidth);
        const height = Math.round(width * element.videoHeight / element.videoWidth);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.drawImage(element, 0, 0, width, height);
        position = element.currentTime;
      }
      token = videoCallbacks ? element.requestVideoFrameCallback(paint) : requestAnimationFrame(paint);
    }
    paint();
    return () => {
      if (videoCallbacks) element.cancelVideoFrameCallback(token);
      else cancelAnimationFrame(token);
    };
  }, [video, live]);
  return <canvas ref={surface} className="painted-preview" hidden={!live} aria-hidden="true"/>;
}
