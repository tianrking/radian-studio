/// <reference types="vite/client" />
import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import module from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { clipTokenizer, translationTokenizer } from './tokenizer';

env.wasm.numThreads = 1;
env.wasm.wasmPaths = { wasm, mjs: module };

const clip = (name: string) => new URL(`/clip/${name}`, globalThis.location.href).toString();
async function readText(name: string) {
  const result = await fetch(clip(name));
  if (!result.ok) throw new Error('Install the matching Android CLIP assets in this Studio build');
  return result.text();
}

let tokenizer: ReturnType<typeof clipTokenizer> | undefined;
let translation: ReturnType<typeof translationTokenizer> | undefined;
let textModel: InferenceSession | undefined;
let encoder: InferenceSession | undefined;
let decoder: InferenceSession | undefined;

function create(file: string) {
  return InferenceSession.create(clip(file), { executionProviders: ['wasm'] });
}

const tensor = (ids: BigInt64Array) => new Tensor('int64', ids, [1, ids.length]);

async function translate(text: string) {
  translation ??= translationTokenizer(await readText('translation/pieces.tsv'));
  const source = translation.encode(text);
  if (source.length > 256) throw new Error('The description exceeds the Marian context window');
  if (!encoder || !decoder) {
    [encoder, decoder] = await Promise.all([create('translation/encoder.onnx'), create('translation/decoder.onnx')]);
  }
  const input = tensor(source);
  try {
    const memory = (await encoder.run({ tokens: input }))[encoder.outputNames[0]];
    try {
      const target = [32000];
      for (let step = 0; step < 63; step++) {
        const prefix = tensor(BigInt64Array.from(target.map(BigInt)));
        try {
          const output = (await decoder.run({ tokens: prefix, memory }))[decoder.outputNames[0]];
          try {
            const logits = output.data as Float32Array;
            let best = 0;
            for (let i = 1; i < 32000; i++) if (logits[i] > logits[best]) best = i;
            if (best === 0) return translation.decode(target);
            target.push(best);
          } finally { output.dispose(); }
        } finally { prefix.dispose(); }
      }
      throw new Error('Translation did not finish in 63 tokens');
    } finally { memory.dispose(); }
  } finally { input.dispose(); }
}

async function encode(raw: string) {
  const text = /\p{Script=Han}/u.test(raw) ? await translate(raw) : raw;
  tokenizer ??= clipTokenizer(await readText('bpe_simple_vocab_16e6.txt'));
  const input = tensor(tokenizer(`a photo of ${text.trim()}`));
  try {
    textModel ??= await create('text_encoder.onnx');
    const output = (await textModel.run({ tokens: input }))[textModel.outputNames[0]];
    try {
      const data = Array.from(output.data as Float32Array);
      const norm = Math.hypot(...data);
      if (data.length !== 512 || !Number.isFinite(norm) || norm <= 1e-10) throw new Error('Invalid MobileCLIP embedding');
      return { text, vector: data.map((value) => value / norm) };
    } finally { output.dispose(); }
  } finally { input.dispose(); }
}

self.addEventListener('message', ({ data }: MessageEvent<string>) => {
  void encode(data).then((result) => self.postMessage({ result }), (error: unknown) =>
    self.postMessage({ error: error instanceof Error ? error.message : String(error) }));
});
