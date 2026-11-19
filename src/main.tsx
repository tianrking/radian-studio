import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Aperture, Camera, Circle, Focus, Grid3X3, Image, Lock, Maximize, Radio, RotateCcw, Scan, SlidersHorizontal, Square, Wifi, X } from 'lucide-react';
import { errorText, native, supportsControl, type Device, type Transport } from './api';
import { Controls } from './Controls';
import { Gallery } from './Gallery';
import { FrameSurface, Histogram, Overlays } from './Overlays';
import { SceneSearch } from './SceneSearch';
import { useCamera } from './useCamera';
import './style.css';

const hostKey = 'radian.host.v1';
const phaseName = { idle:'Disconnected', probing:'Checking device', loading:'Waiting for video', live:'Live', retrying:'Reconnecting', error:'Connection error' };

function App() {
  const camera = useCamera();
  const [host,setHost] = useState(() => localStorage.getItem(hostKey) || '192.168.88.1');
  const [transport,setTransport] = useState<Transport>('http-ts');
  const [section,setSection] = useState<'settings' | 'search'>('settings');
  const [model,setModel] = useState('');
  const [encoder,setEncoder] = useState<{ session: number; bitrate?: number; gop?: number }>();
  const [discovered,setDiscovered] = useState<Device[]>();
  const [scanning,setScanning] = useState(false);
  const [gallery,setGallery] = useState(false);
  const [message,setMessage] = useState('');
  const [grid,setGrid] = useState(false);
  const [histogram,setHistogram] = useState(false);
  const [boxes,setBoxes] = useState(true);
  const [regions,setRegions] = useState(true);
  const [compare,setCompare] = useState(false);
  const [split,setSplit] = useState(50);
  const [hud,setHud] = useState(false);
  const [telemetry,setTelemetry] = useState<{ depth: string; temp: string; max: string; duration: string }>();
  const [locked,setLocked] = useState(false);
  const [level,setLevel] = useState(false);
  const [orientation,setOrientation] = useState<number>();
  const [recordStart,setRecordStart] = useState<number>();
  const [recordSeconds,setRecordSeconds] = useState(0);
  const [flipX,setFlipX] = useState(false);
  const [flipY,setFlipY] = useState(false);
  const [zoom,setZoom] = useState(1);
  const [pan,setPan] = useState({ x: 0, y: 0 });
  const [captureMode,setCaptureMode] = useState('single');
  const [countdown,setCountdown] = useState(0);
  const [capturePending,setCapturePending] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const live = camera.status.phase === 'live';
  const connected = camera.session !== null;
  const hasAi = !!camera.caps?.ai.models.length;
  const hasSceneSearch = camera.caps?.ai.models.some((item) => item.task === 'open_vocab_search') ?? false;
  const hasTelemetry = supportsControl(camera.caps, 'telemetry');
  const streaming = camera.status.phase === "retrying" || connected;
  const busy = camera.status.phase === 'probing';
  const hasSession = streaming || busy;
  const profile = camera.caps?.preview;
  const imageRatio = profile ? profile.width / profile.height : 16 / 9;
  const actualVideo = camera.video.current;
  const aspect = live && actualVideo?.videoWidth ? actualVideo.videoWidth / actualVideo.videoHeight : imageRatio;
  const [aspectBounds,setAspectBounds] = useState({ width: 1, height: 1 });

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setAspectBounds({ width, height });
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!hud || !hasTelemetry || camera.session === null) return;
    const current = camera.session;
    let alive = true;
    function poll() {
      void native.run<string>(current, 'TELEM').then((value) => {
        if (!alive || typeof value !== 'string') return;
        const p = Object.fromEntries([...value.matchAll(/([a-z_]+)=(-?[\d.]+)/g)].map(([, k, v]) => [k, v]));
        if (p.depth && p.temp) setTelemetry({ depth: p.depth, temp: p.temp, max: p.max_depth, duration: p.dive_sec });
      }, () => {});
    }
    poll();
    const id = window.setInterval(poll, 2200);
    return () => { alive = false; window.clearInterval(id); };
  }, [hud, hasTelemetry, camera.session]);
  useEffect(() => {
    if (!level) return;
    const update = (e: DeviceOrientationEvent) => { if (e.gamma !== null) setOrientation(e.gamma); };
    window.addEventListener('deviceorientation', update);
    return () => window.removeEventListener('deviceorientation', update);
  }, [level]);
  useEffect(() => {
    if (!camera.recording || recordStart === undefined) return;
    const id = window.setInterval(() => setRecordSeconds(Math.floor((performance.now()-recordStart)/1000)), 250);
    return () => window.clearInterval(id);
  }, [camera.recording, recordStart]);
  useEffect(() => {
    if (!locked) return;
    const release = (e: KeyboardEvent) => { if (e.key === 'Escape') setLocked(false); };
    window.addEventListener('keydown', release);
    return () => window.removeEventListener('keydown', release);
  }, [locked]);

  const imageWidth = Math.min(aspectBounds.width, aspectBounds.height * aspect);

  useEffect(() => {
    if (camera.session === null) return;
    const session = camera.session;
    let alive = true;
    void native.run<{ model?: string; bitrate?: number; gop?: number }>(session, 'STATUS').then((value) => {
      if (!alive) return;
      if (typeof value.model === 'string') setModel(value.model);
      setEncoder({ session, bitrate: value.bitrate, gop: value.gop });
    }, () => {});
    return () => { alive = false; };
  }, [camera.session]);

  function error(err: unknown) { setMessage(errorText(err)); }
  async function task(fn: () => Promise<unknown>) { try { await fn(); } catch (err) { error(err); } }

  function connect(address = host) {
    const value = address.trim();
    setModel('');
    setMessage('');
    setHost(value);
    localStorage.setItem(hostKey, value);
    camera.connect({ host: value, transport });
  }

  async function scan() {
    setScanning(true);
    try { setDiscovered(await native.scan(host)); }
    catch (err) { error(err); }
    finally { setScanning(false); }
  }

  function send(command: string) {
    if (camera.session === null) return Promise.reject(new Error('Connect a camera first'));
    return native.run(camera.session, command);
  }

  async function selectModel(value: string) {
    await send(`AI MODEL ${value}`);
    setModel(value);
  }

  async function toggleRecording() {
    await camera.toggleRecording();
    if (!camera.recording) { setRecordSeconds(0); setRecordStart(performance.now()); }
  }

  async function capture() {
    if (capturePending) return;
    setCapturePending(true);
    try {
      if (captureMode === 'timer') {
        for (let value = 3; value > 0; value--) {
          setCountdown(value);
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        setCountdown(0);
      }
      const count = captureMode === 'burst' ? 3 : 1;
      for (let i = 0; i < count; i++) {
        await camera.capture();
        if (i + 1 < count) await new Promise((resolve) => window.setTimeout(resolve, 130));
      }
      setMessage(count > 1 ? '3 photos saved' : 'Photo saved');
    } catch (err) { error(err); }
    finally { setCapturePending(false); setCountdown(0); }
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    const limit = (zoom-1) * imageWidth / 2;
    const vert = limit / aspect;
    const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
    setPan({ x: clamp(start.px + e.clientX - start.x, limit), y: clamp(start.py + e.clientY - start.y, vert) });
  }

  return <div className="studio">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Aperture size={23}/></span><div>Radian Studio<small>Camera workstation</small></div></div>
      <div className="top-actions">
        <span className={`status ${camera.status.phase}`}><i/>{phaseName[camera.status.phase]}</span>
        <button className="subtle" onClick={() => setGallery(true)}><Image size={17}/> Library</button>
      </div>
    </header>
    <div className="workspace">
      <main className="viewfinder">
        <div className="view-head"><div><h1>Viewfinder</h1><p>{camera.caps ? `${camera.caps.device.board} · ${camera.status.target?.host}` : 'Direct camera connection'}</p></div>
          <button className="icon" aria-label="Fullscreen video" title="Fullscreen" onClick={() => void task(async () => {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await viewport.current?.requestFullscreen();
          })}><Maximize size={18}/></button></div>
        <div ref={viewport} className="viewport" onPointerMove={move} onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }} onPointerDown={(e) => {
            if (locked || compare || zoom <= 1 || !live) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
          }}>
          <div className="visual" style={{ width: imageWidth, height: imageWidth / aspect,
            transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom * (flipX ? -1 : 1)},${zoom * (flipY ? -1 : 1)})` }}>
            <video ref={camera.video} muted playsInline autoPlay aria-label="Live camera video"/>
            <FrameSurface video={camera.video} live={live}/>
            {live ? <Overlays frame={camera.frame} boxes={boxes} regions={regions} grid={grid} /> : null}
          </div>
          {!live ? <div className="standby">
            <div className="focus-icon"><Focus size={44} strokeWidth={1.15}/></div>
            <h2>{camera.status.phase === 'idle' ? 'No camera connected' : phaseName[camera.status.phase]}</h2>
            <p>{camera.status.error ?? (camera.status.phase === 'idle' ? 'Enter your camera’s IP address to start a live preview.' : 'Waiting for the camera to deliver a frame.')}</p>
            {camera.status.phase === 'error' ? <button onClick={() => connect()}><RotateCcw size={16}/> Retry connection</button> : null}
          </div> : null}
          {live && compare ? <div className="compare-layer" style={{ '--split': `${split}%` } as React.CSSProperties}>
            <div className="compare-tint"/><div className="compare-divider"/><span>Original</span><span>Aqua color</span>
            <input type="range" min="10" max="90" value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="Aqua comparison split"/>
          </div> : null}
          {live && hud && hasTelemetry && telemetry ? <div className="dive-hud"><b>{telemetry.depth} m</b><span>{telemetry.temp} °C</span><span>Max {telemetry.max} m</span><span>{telemetry.duration} s</span></div> : null}
          {live && level ? <div className="level-mark" style={{ rotate: `${orientation ?? 0}deg` }} title={orientation === undefined ? "Framing guide · hardware tilt unavailable" : "Device orientation"}/> : null}
          {camera.recording ? <span className="record-tag"><i/> {String(Math.floor(recordSeconds/60)).padStart(2,'0')}:{String(recordSeconds%60).padStart(2,'0')}</span> : null}
          {locked ? <button className="unlock" onClick={() => setLocked(false)}><Lock size={16}/> Unlock controls</button> : null}
          {live && histogram ? <Histogram video={camera.video}/> : null}
          {countdown > 0 ? <div className="countdown">{countdown}</div> : null}
        </div>
        <div className="viewport-meta">
          <div><Radio size={14}/><span>{transport === 'http-ts' ? 'HTTP / MPEG-TS' : 'UDP / MPEG-TS'}</span></div>
          <span>{profile ? `${profile.width}×${profile.height} · ${profile.fps} fps` : live && actualVideo ? `${actualVideo.videoWidth}×${actualVideo.videoHeight}` : '—'}{camera.codec ? ` · ${camera.codec}` : ''}</span>
        </div>
        <div className="capturebar" inert={locked} aria-label="Capture tools">
          <div className="flex">
            <button className={`icon ${grid ? 'selected' : ''}`} aria-pressed={grid} aria-label="Framing grid" title="Framing grid" onClick={() => setGrid((value) => !value)}><Grid3X3 size={18}/></button>
            <button className={`icon ${histogram ? 'selected' : ''}`} aria-pressed={histogram} aria-label="Luminance histogram" title="Luminance histogram" onClick={() => setHistogram((value) => !value)}><Activity size={18}/></button>
          </div>
          <div className="flex capture-actions">
            <select aria-label="Photo mode" value={captureMode} onChange={(e) => setCaptureMode(e.target.value)}>
              <option value="single">Single photo</option><option value="timer">3 s timer</option><option value="burst">Burst ×3</option>
            </select>
            <button className="primary" disabled={!live || capturePending} onClick={() => void capture()}><Camera size={18}/> Capture</button>
            <button className={camera.recording ? 'recording' : ''} disabled={!live} onClick={() => void task(toggleRecording)}>
              {camera.recording ? <Square size={16}/> : <Circle size={16}/>} {camera.recording ? 'Stop recording' : 'Record'}
            </button>
          </div>
        </div>
        {message || camera.lastCapture ? <div className="notice flex between" role="status">
          <span>{message || camera.lastCapture}</span>{message ? <button className="icon" aria-label="Dismiss notification" onClick={() => setMessage('')}><X size={15}/></button> : null}
        </div> : null}
      </main>
      <aside className="inspector" inert={locked}>
        <section className="panel-content stack connection">
          <div className="section-title"><Wifi size={18}/><h2>Camera connection</h2></div>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (hasSession) camera.stop(); else connect(); }}>
            <label htmlFor="camera-address">Device address</label>
            <div className="address-row"><input id="camera-address" aria-label="Device address" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.88.1" />
              <button type="submit" className={hasSession ? "" : "primary"} disabled={!hasSession && (!camera.ready || !host.trim())}>{hasSession ? "Disconnect" : "Connect"}</button>
            </div>
            <div role="group" aria-label="Video transport" className="stack">
              <span className="muted">Transport</span>
              <div className="segmented">
                <button type="button" disabled={streaming || busy} aria-pressed={transport === "http-ts"} className={transport === "http-ts" ? "selected" : ""} onClick={() => setTransport("http-ts")}>HTTP · 8554</button>
                <button type="button" disabled={streaming || busy} aria-pressed={transport === "udp-ts"} className={transport === "udp-ts" ? "selected" : ""} onClick={() => setTransport("udp-ts")}>UDP · 8555</button>
              </div>
            </div>
          </form>
          <div className="pair">
            <button disabled={scanning} onClick={() => void scan()}><Scan size={15}/> {scanning ? 'Scanning…' : 'Find cameras'}</button>
            <button onClick={() => void task(native.network)}><Wifi size={15}/> Wi-Fi settings</button>
          </div>
          {discovered ? <div className="scan-results">{discovered.length ? discovered.map((device) =>
            <button key={device.host} onClick={() => connect(device.host)}>{device.caps.device.board}<span className="mono">{device.host}</span></button>)
            : <p className="muted">No Radian cameras found on the local network.</p>}</div> : null}
          {camera.caps ? <div className="device-facts"><span>{camera.caps.device.soc} / {camera.caps.device.sensor}</span>
            <span>Protocol {camera.caps.protocol.major}.{camera.caps.protocol.minor}</span></div> : null}
        </section>
        <div className="tabs" aria-label="Camera panels">
          <button aria-pressed={section === 'settings'} className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')}><SlidersHorizontal size={16}/> Controls</button>
          {hasSceneSearch ? <button aria-pressed={section === 'search'} className={section === 'search' ? 'active' : ''} onClick={() => setSection('search')}><Focus size={16}/> Scene search</button> : null}
        </div>
        {section === 'settings' || !hasSceneSearch ? <>
          <section className="panel-content stack preview-settings">
            <div className="section-title"><Focus size={17}/><h2>Framing & overlays</h2></div>
            <div className="check-grid">
              {hasAi ? <label className="switch"><input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)}/> Detection boxes</label> : null}
              {hasAi ? <label className="switch"><input type="checkbox" checked={regions} onChange={(e) => setRegions(e.target.checked)}/> AI regions</label> : null}
              <label className="switch"><input type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)}/> Mirror</label>
              <label className="switch"><input type="checkbox" checked={flipY} onChange={(e) => setFlipY(e.target.checked)}/> Flip vertical</label>
              <label className="switch"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)}/> Aqua comparison</label>
              {hasTelemetry ? <label className="switch"><input type="checkbox" checked={hud} onChange={(e) => setHud(e.target.checked)}/> Dive telemetry</label> : null}
              <label className="switch"><input type="checkbox" checked={level} onChange={(e) => setLevel(e.target.checked)}/> Horizon guide</label>
              <button disabled={!live} onClick={() => setLocked(true)}><Lock size={13}/> Lock controls</button>
            </div>
            <label className="range">Digital zoom <span className="mono">{zoom.toFixed(1)}×</span>
              <input type="range" min="1" max="5" step="0.1" value={zoom} onChange={(e) => { setZoom(Number(e.target.value)); setPan({ x:0, y:0 }); }}/>
            </label>
          </section>
          <Controls key={camera.session ?? 'offline'} caps={connected ? camera.caps : undefined} frame={camera.frame} send={send} model={model} select={selectModel} onError={error} encoder={encoder?.session === camera.session ? encoder : undefined}/>
        </> : camera.caps && camera.session !== null ? <SceneSearch key={camera.session} host={camera.status.target?.host ?? host} session={camera.session} caps={camera.caps} selectModel={selectModel} showError={setMessage}/> :
          <p className="panel-content muted">Connect a camera to see its scene-search capabilities.</p>}
      </aside>
    </div>
    {gallery ? <Gallery close={() => setGallery(false)} notify={setMessage}/> : null}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
