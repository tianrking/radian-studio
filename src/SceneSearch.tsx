import { useEffect, useRef, useState } from 'react';
import { Crosshair, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { errorText, native, type Caps } from './api';

type ClipInfo = { ids?: number[]; grid?: number[]; src?: string; thresh?: number; max_user?: number };
type Term = { id: number; label: string; text: string };
type Result = { text: string; vector: number[] };
type Props = { session: number; host: string; caps: Caps; selectModel: (id: string) => Promise<void>; showError: (message: string) => void };

function readTerms(key: string): Term[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data.filter((t) => typeof t?.id === 'number' && typeof t.label === 'string' && typeof t.text === 'string');
  } catch { return []; }
}

export function SceneSearch({ session, host, caps, selectModel, showError }: Props) {
  const key = `radian.clip.v1.${host}`;
  const [terms, setTerms] = useState(() => readTerms(key));
  const [bank, setBank] = useState<string[]>([]);
  const [info, setInfo] = useState<ClipInfo>();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<number>();
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState('all');
  const [threshold, setThreshold] = useState('0.20');
  const [maps, setMaps] = useState(true);
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const model = caps.ai.models.find((m) => m.task === 'open_vocab_search');
  const descriptor = caps.ai.clip_user;
  const custom = descriptor?.model_id === model?.id && descriptor?.dimensions === 512 && descriptor.embedding_space === 'mobileclip2-s0-dfndr2b-v1';

  useEffect(() => {
    const id = ++generation.current;
    return () => { if (generation.current === id) generation.current++; worker.current?.terminate(); worker.current = null; };
  }, []);

  function save(next: Term[]) {
    localStorage.setItem(key, JSON.stringify(next));
    setTerms(next);
  }

  async function refresh() {
    const [state, inventory] = await Promise.all([
      native.run<ClipInfo>(session, 'CLIP INFO'), native.run<{ prompts: string[] }>(session, 'CLIP LIST'),
    ]);
    setInfo(state);
    if (typeof state.thresh === 'number') setThreshold(state.thresh.toFixed(2));
    setBank(Array.isArray(inventory.prompts) ? inventory.prompts : []);
  }

  async function action(callback: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    try { await callback(); } catch (error) { showError(errorText(error)); }
    finally { setPending(false); }
  }

  function encode(prompt: string): Promise<Result> {
    if (!worker.current) worker.current = new Worker(new URL('./clip.worker.ts', import.meta.url), { type: 'module' });
    const instance = worker.current;
    return new Promise((resolve, reject) => {
      function cleanup() {
        instance.removeEventListener('message', done);
        instance.removeEventListener('error', failed);
      }
      function done(event: MessageEvent<{ error?: string; result?: Result }>) {
        cleanup();
        if (event.data.result) resolve(event.data.result);
        else reject(new Error(event.data.error || 'CLIP encoding failed'));
      }
      function failed(event: ErrorEvent) {
        cleanup();
        instance.terminate();
        if (worker.current === instance) worker.current = null;
        reject(new Error(event.message || 'CLIP worker failed to start'));
      }
      instance.addEventListener('message', done);
      instance.addEventListener('error', failed);
      instance.postMessage(prompt);
    });
  }

  async function add() {
    const label = text.trim();
    if (!custom || !label || new TextEncoder().encode(label).length > 95) throw new Error('Enter a search phrase of up to 95 UTF-8 bytes');
    const idWhenStarted = generation.current;
    const result = await encode(label);
    if (idWhenStarted !== generation.current) return;
    const board = await native.run<ClipInfo>(session, 'CLIP INFO');
    let id = 1;
    const used = new Set([...terms.map((term) => term.id), ...(board.ids ?? [])]);
    while (used.has(id)) id++;
    if (editing !== undefined) id = editing;
    await native.clip(session, id, label, result.vector);
    save([...terms.filter((term) => term.id !== id), { id, label, text: result.text }]);
    setText(''); setEditing(undefined);
    await native.run(session, 'CLIP SRC user');
    await refresh();
  }

  if (!model) return <p className="muted">This camera has no scene-search model installed.</p>;
  return <section className="stack panel-content">
    <div className="section-title"><Crosshair size={17} /><h2>Scene search</h2></div>
    <button className="primary" disabled={pending} onClick={() => void action(async () => {
      await selectModel(model.id);
      await native.run(session, 'AI ON');
      await refresh();
    })}>Activate {model.label ?? model.id}</button>
    <div className="pair">
      <label>Vocabulary <select value={info?.src ?? 'bank'} disabled={pending} onChange={(e) => {
        const value = e.target.value;
        void action(async () => { await native.run(session, `CLIP SRC ${value}`); await refresh(); });
      }}><option value="bank">Camera presets</option><option value="user" disabled={!custom}>Custom terms</option></select></label>
      <label>Category <select value={filter} disabled={pending} onChange={(e) => {
        const value = e.target.value;
        setFilter(value);
        void action(async () => { await native.run(session, `CLIP FILTER ${value}`); await refresh(); });
      }}><option value="all">All</option><option value="underwater">Underwater</option><option value="daily">Daily</option></select></label>
    </div>
    <div className="pair">
      <label>Threshold <input type="number" min="0.05" max="0.5" step="0.01" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
      <button disabled={pending} onClick={() => void action(async () => { await native.run(session, `CLIP THRESH ${threshold}`); await refresh(); })}>Apply</button>
    </div>
    <div className="flex between"><label className="switch"><input type="checkbox" checked={maps} onChange={(e) => {
      const enable = e.target.checked;
      void action(async () => { await native.run(session, `CLIP MAP ${enable ? 1 : 0}`); setMaps(enable); });
    }} /> Region map</label><span className="mono muted">{info?.grid?.join(' × ') || '—'} grid</span></div>
    <div className="section-title"><h3>Custom terms</h3></div>
    {custom ? <form className="pair" onSubmit={(e) => { e.preventDefault(); void action(add); }}>
      <input aria-label="Search phrase" placeholder="e.g. sea turtle or 海龟" value={text} onChange={(e) => setText(e.target.value)} disabled={pending} />
      <button aria-label={editing === undefined ? "Add search phrase" : "Save search phrase"} disabled={pending || !text.trim()}>{pending ? <LoaderCircle size={16} className="spin" /> : <Plus size={16}/>}</button>
    </form> : <p className="muted">This camera does not advertise the matching MobileCLIP space.</p>}
    {editing !== undefined ? <button onClick={() => { setEditing(undefined); setText(''); }}>Cancel edit</button> : null}
    {terms.map((term) => <div className="termlist" key={term.id}>
      <div>{term.label}{term.text !== term.label ? <small>{term.text}</small> : null}</div>
      <div className="flex"><button aria-label={`Edit ${term.label}`} disabled={pending} onClick={() => { setEditing(term.id); setText(term.label); }}><Pencil size={15}/></button>
      <button aria-label={`Remove ${term.label}`} disabled={pending} onClick={() => void action(async () => {
        await native.clip(session, term.id, null, null);
        save(terms.filter((value) => value.id !== term.id)); await refresh();
      })}><Trash2 size={15}/></button></div>
    </div>)}
    {bank.length ? <div><h3>Active presets · {bank.length}</h3><div className="tags">{bank.slice(0, 60).map((term, i) => <span key={`${i}-${term}`}>{term}</span>)}</div></div> : null}
  </section>;
}
