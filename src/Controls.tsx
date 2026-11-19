import { useState, type ReactNode } from 'react';
import { Aperture, BrainCircuit, ScanLine, SlidersHorizontal } from 'lucide-react';
import type { AiFrame, Caps } from './api';

const scenes = {
  WIDE: ['0','0','16667','1600'],
  MACRO: ['5500','-3','8333','800'],
  NIGHT: ['4500','7','33333','6400'],
  TIMELAPSE: ['5200','0','16667','800'],
} as const;
type Send = (command: string) => Promise<unknown>;
type Props = { caps?: Caps; frame?: AiFrame; send: Send; onError: (error: unknown) => void; model: string; select: (id: string) => Promise<void> };

function NumberField({ label, value, set, min, max, step = 1 }: { label: string; value: string; set: (value: string) => void; min: number; max: number; step?: number }) {
  return <label>{label}<input type="number" value={value} min={min} max={max} step={step} onChange={(e) => set(e.target.value)} /></label>;
}

export function Controls({ caps, frame, send, onError, model, select }: Props) {
  const [bitrate,setBitrate] = useState('2000');
  const [gop,setGop] = useState('30');
  const [wb,setWb] = useState('0');
  const [ev,setEv] = useState('0');
  const [shutter,setShutter] = useState('0');
  const [iso,setIso] = useState('0');
  const [preset,setPreset] = useState('normal');
  const [scene,setScene] = useState<keyof typeof scenes>('WIDE');
  const [flags,setFlags] = useState([false,false,false,false,false]);
  const [conf,setConf] = useState('0.25');
  const [nms,setNms] = useState('0.45');
  const [interval,setIntervalMs] = useState('33');
  const [data,setData] = useState<unknown>();
  const [mode,setMode] = useState('stream');
  const [busy,setBusy] = useState(false);

  async function run(operation: () => Promise<unknown>, show = false) {
    if (busy) return;
    setBusy(true);
    try {
      const output = await operation();
      if (show) setData(output);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  }

  const action = (label: string, command: string, show = false) =>
    <button type="button" onClick={() => void run(() => send(command), show)}>{label}</button>;
  const group = (icon: ReactNode, title: string) => <div className="section-title">{icon}<h2>{title}</h2></div>;
  return <fieldset className="panel-content stack" disabled={!caps || busy}>
    {group(<BrainCircuit size={17}/>, 'On-device AI')}
    <label>Model <select value={model} onChange={(e) => {
      const value = e.target.value;
      if (value) void run(() => select(value));
    }}>
      <option value="">Select a camera model</option>
      {caps?.ai.models.map((item) => <option key={item.id} value={item.id}>{item.label ?? item.id}</option>)}
    </select></label>
    <div className="segmented">
      {(['stream','ai','eco'] as const).map((value) => <button key={value} className={mode === value ? 'selected' : ''} onClick={() => void run(async () => {
        await send(value === 'stream' ? 'AI OFF' : value === 'ai' ? 'AI ON' : 'MODE eco');
        setMode(value);
      })}>{({stream:'Off',ai:'Full speed',eco:'Eco'})[value]}</button>)}
    </div>
    <div className="pair">
      <NumberField label="Confidence" value={conf} set={setConf} min={0.05} max={0.95} step={0.01}/>
      <NumberField label="NMS" value={nms} set={setNms} min={0.10} max={0.95} step={0.01}/>
    </div>
    <div className="pair">
      {action('Apply thresholds', `AI THRESH ${conf} ${nms}`)}
      <NumberField label="Interval (ms)" value={interval} set={(value) => setIntervalMs(value)} min={0} max={5000}/>
    </div>
    {action('Apply interval', `AI INTERVAL ${interval}`)}
    {frame ? <div className="readout"><span>{frame.model}</span><span>{frame.dets.length} results</span><span>{Number(frame.infer_ms).toFixed(1)} ms</span></div> : null}
    <hr />
    {group(<SlidersHorizontal size={17}/>, 'Video encoder')}
    <div className="pair">
      <NumberField label="Bitrate (kb/s)" value={bitrate} set={setBitrate} min={200} max={10000}/>
      <NumberField label="GOP (frames)" value={gop} set={setGop} min={5} max={120}/>
    </div>
    <div className="pair">
      <button onClick={() => void run(async () => { await send(`BITRATE ${bitrate}`); await send(`GOP ${gop}`); })}>Apply encoder</button>
      {action('Request keyframe', 'IDR')}
    </div>
    <hr />
    {group(<Aperture size={17}/>, 'Camera image')}
    <div className="pair">
      <label>Scene preset <select value={scene} onChange={(e) => setScene(e.target.value as keyof typeof scenes)}>
        <option value="WIDE">Wide angle</option><option value="MACRO">Macro</option><option value="NIGHT">Low light</option><option value="TIMELAPSE">Time lapse</option>
      </select></label>
      <button onClick={() => void run(async () => {
        const [white,exposure,speed,maxIso] = scenes[scene];
        await send(`PRESET ${scene}`);
        await send(`ISP ${white} ${exposure} ${speed} ${maxIso}`);
        setWb(white); setEv(exposure); setShutter(speed); setIso(maxIso);
      })}>Apply scene</button>
    </div>
    <div className="pair">
      <NumberField label="White balance (K)" value={wb} set={setWb} min={0} max={12000}/>
      <NumberField label="Exposure (0.1 EV)" value={ev} set={setEv} min={-30} max={30}/>
      <NumberField label="Max shutter (µs)" value={shutter} set={setShutter} min={0} max={1000000}/>
      <NumberField label="Max ISO" value={iso} set={setIso} min={0} max={102400}/>
    </div>
    {action('Apply exposure', `ISP ${wb} ${ev} ${shutter} ${iso}`)}
    <div className="pair">
      <label>ISP preset <select value={preset} onChange={(e) => setPreset(e.target.value)}>
        <option value="normal">Normal</option><option value="aqua">Underwater</option><option value="dehaze">Dehaze</option><option value="night">Low light</option>
      </select></label>
      {action('Apply preset', `ISP PRESET ${preset}`)}
    </div>
    <div className="check-grid">{['Aqua color','Dehaze','Denoise','Stabilization flag','Horizon flag'].map((label, index) =>
      <label className="switch" key={label}><input type="checkbox" checked={flags[index]} onChange={(e) => {
        const checked = e.target.checked;
        setFlags((previous) => previous.map((value, i) => i === index ? checked : value));
      }}/>{label}</label>)}</div>
    {action('Apply enhancements', `ENHANCE ${flags.map(Number).join(' ')}`)}
    <hr />
    {group(<ScanLine size={17}/>, 'Device data')}
    <div className="pair">{action('Read status', 'STATUS', true)}{action('Highlights', 'HIGHLIGHTS', true)}{action('Telemetry', 'TELEM', true)}
      <button onClick={() => { if (window.confirm('Clear the camera’s highlight list?')) void run(() => send('HIGHLIGHT_CLEAR'), true); }}>Clear highlights</button>
    </div>
    {data !== undefined ? <pre className="device-data">{typeof data === 'string' ? data : JSON.stringify(data, null, 2)}</pre> : null}
  </fieldset>;
}
