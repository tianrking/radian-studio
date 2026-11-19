import { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Download, Film, Image, Scissors, Trash2, X } from 'lucide-react';
import { errorText, native, type Item } from './api';

export function Gallery({ close, notify }: { close: () => void; notify: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [items,setItems] = useState<Item[]>([]);
  const [name,setName] = useState('');
  const [destination,setDestination] = useState('');
  const [from,setFrom] = useState('0');
  const [to,setTo] = useState('5');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const selected = items.find((item) => item.name === name) ?? items[0];
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    void native.gallery().then((found) => { if (alive) setItems(found); }, (err: unknown) => { if (alive) setError(errorText(err)); });
    return () => { alive = false; };
  }, []);

  async function run(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try { await action(); } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="gallery" onCancel={close}>
    <header className="flex between"><div className="section-title"><Image size={19}/><h2>Capture library</h2></div>
      <button className="icon" aria-label="Close library" onClick={close}><X size={20}/></button></header>
    {error ? <div className="alert" role="alert">{error}</div> : null}
    {!selected ? <div className="gallery-empty"><Image size={28}/><h3>No captures yet</h3><p>Photos and recordings from the viewfinder will appear here.</p></div> :
      <div className="gallery-grid"><nav aria-label="Media list">{items.map((item) => <button key={item.name} onClick={() => setName(item.name)} className={item === selected ? 'selected' : ''}>
        {item.kind === 'video' ? <Film size={17}/> : <Image size={17}/>}<span>{item.kind === 'video' ? 'Video' : 'Photo'}<small>{new Date(item.modified).toLocaleString()}</small></span>
      </button>)}</nav>
      <div className="stack library-item">
        <div className="media-review">{selected.kind === 'video' ? <video ref={player} key={selected.path} controls src={convertFileSrc(selected.path)} /> :
          <img src={convertFileSrc(selected.path)} alt="Captured camera frame"/>}</div>
        <div className="flex between"><span className="mono muted">{selected.name} · {(selected.bytes / 1048576).toFixed(2)} MB</span>
          <button className="icon" aria-label="Delete media" disabled={busy} onClick={() => {
            if (window.confirm(`Delete ${selected.name}?`)) void run(async () => { await native.delete(selected.name); setItems(await native.gallery()); });
          }}><Trash2 size={17}/></button></div>
        {selected.highlights.length ? <div className="tags" aria-label="AI highlights">
          {selected.highlights.map((highlight, index) => <button key={index} onClick={() => {
            if (player.current) player.current.currentTime = highlight.seconds;
            setFrom(highlight.seconds.toFixed(1)); setTo((highlight.seconds + 15).toFixed(1));
          }}>{Math.round(highlight.seconds)} s · {highlight.label}</button>)}</div> : null}
        {selected.kind === 'video' ? <div className="flex gallery-form">
          <label>From (s)<input type="number" min="0" step="0.1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To (s)<input type="number" min="0.1" step="0.1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button disabled={busy} onClick={() => void run(async () => {
            const output = await native.trim(selected.name, Number(from), Number(to));
            setItems(await native.gallery()); setName(output); notify('Trimmed clip saved');
          })}><Scissors size={15}/> Trim copy</button>
          <button disabled={busy} onClick={() => void run(async () => {
            const current = player.current?.currentTime ?? 0;
            const output = await native.trim(selected.name, current, current + 15);
            setItems(await native.gallery()); setName(output); notify("Highlight clip saved");
          })}>Save 15 s</button>
        </div> : null}
        <div className="flex gallery-form"><label>Export to folder<input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Absolute folder path" /></label>
          <button disabled={busy || !destination.trim()} onClick={() => void run(async () => {
            const path = await native.export(selected.name, destination.trim());
            notify(`Exported to ${path}`);
          })}><Download size={15}/> Export</button></div>
      </div></div>}
  </dialog>;
}
