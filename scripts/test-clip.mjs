import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { env, InferenceSession, Tensor } from 'onnxruntime-web';
import { clipTokenizer, translationTokenizer } from '../src/tokenizer.ts';

const referencePath = process.argv[2];
if (!referencePath) throw new Error('Pass tokenizer_vectors.json from the Android reference repository.');
env.wasm.numThreads = 1;
const asset = (name) => readFileSync(new URL(`../public/clip/${name}`, import.meta.url));
const tokenizer = clipTokenizer(asset('bpe_simple_vocab_16e6.txt').toString('utf8'));
const vectors = JSON.parse(readFileSync(referencePath, 'utf8')).cases;
for (const item of vectors) assert.deepEqual([...tokenizer(item.text)].map(Number), item.ids);
console.log(`PASS ${vectors.length} Android MobileCLIP token vectors`);

const create = (name) => InferenceSession.create(new Uint8Array(asset(name)), { executionProviders: ['wasm'] });
const tensor = (ids) => new Tensor('int64', ids, [1, ids.length]);
const clip = await create('text_encoder.onnx');
const sample = vectors[0];
const output = (await clip.run({ tokens: tensor(tokenizer(sample.text)) }))[clip.outputNames[0]];
const embedding = Array.from(output.data);
assert.equal(embedding.length, 512);
const norm = Math.hypot(...embedding);
for (const [i, expected] of sample.emb_head.entries()) assert.ok(Math.abs(embedding[i] / norm - expected) < 0.005);
output.dispose();
await clip.release();
console.log('PASS MobileCLIP embedding against Android reference');

const tokenizerZh = translationTokenizer(asset('translation/pieces.tsv').toString('utf8'));
const [encoder, decoder] = await Promise.all([create('translation/encoder.onnx'), create('translation/decoder.onnx')]);
const memory = (await encoder.run({ tokens: tensor(tokenizerZh.encode('海龟')) }))[encoder.outputNames[0]];
const prefix = [32000];
for (let step = 0; step < 63; step++) {
  const prediction = (await decoder.run({ tokens: tensor(BigInt64Array.from(prefix.map(BigInt))), memory }))[decoder.outputNames[0]];
  const scores = prediction.data;
  let top = 0;
  for (let index = 1; index < 32000; index++) if (scores[index] > scores[top]) top = index;
  prediction.dispose();
  if (top === 0) break;
  prefix.push(top);
}
const translated = tokenizerZh.decode(prefix);
assert.match(translated, /turtle/i);
memory.dispose();
await Promise.all([encoder.release(), decoder.release()]);
console.log(`PASS Marian translation 海龟 → ${translated}`);
