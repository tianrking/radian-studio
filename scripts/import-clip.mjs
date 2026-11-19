import { cp, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('Pass the path to app/src/main/assets/clip from the Android repository.');
const destination = resolve('public/clip');
const assets = [
  'bpe_simple_vocab_16e6.txt', 'text_encoder.onnx', 'presets.json', 'presets.bin',
  'translation/encoder.onnx', 'translation/decoder.onnx', 'translation/pieces.tsv',
  'translation/LICENSE.txt', 'translation/NOTICE.txt',
];
await Promise.all(assets.map(async (path) => {
  if (!(await stat(join(source, path))).isFile()) throw new Error(`Missing asset: ${path}`);
}));
await mkdir(join(destination, 'translation'), { recursive: true });
await Promise.all(assets.map((path) => cp(join(source, path), join(destination, path))));
console.log('Imported CLIP and Marian model assets for local builds.');
