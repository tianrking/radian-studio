const suffix = '</w>';
const tokenPattern = /<start_of_text>|<end_of_text>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

export function clipTokenizer(mergesText: string) {
  const encoded = Array<string>(256);
  const bytes = Array.from({ length: 256 }, (_, n) => n)
    .filter((n) => (n >= 33 && n <= 126) || (n >= 161 && n <= 172) || n >= 174);
  const present = new Set(bytes);
  const codes = [...bytes];
  let extra = 256;
  for (let i = 0; i < 256; i++) {
    if (!present.has(i)) { bytes.push(i); codes.push(extra++); }
  }
  const alphabet = codes.map((n) => String.fromCodePoint(n));
  bytes.forEach((n, i) => { encoded[n] = alphabet[i]; });
  const vocab = [...alphabet, ...alphabet.map((letter) => letter + suffix)];
  const merges = mergesText.split(/\r?\n/).slice(1, 48895);
  if (merges.length !== 48894) throw new Error('Invalid MobileCLIP vocabulary');
  const ranks = new Map<string, number>();
  for (const [rank, line] of merges.entries()) {
    const pair = line.trim().split(' ');
    if (pair.length !== 2) throw new Error('Invalid MobileCLIP merge');
    ranks.set(pair.join(' '), rank);
    vocab.push(pair.join(''));
  }
  const ids = new Map(vocab.map((piece, index) => [piece, index]));
  const encoder = new TextEncoder();
  return (text: string) => {
    const cleaned = text.normalize('NFC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
      .replace(/　/g, ' ').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .trim().replace(/\s+/g, ' ').toLowerCase();
    const out = [49406];
    for (const [, token] of cleaned.matchAll(new RegExp(`(${tokenPattern.source})`, 'giu'))) {
      let parts = Array.from(encoder.encode(token), (n) => encoded[n]);
      parts[parts.length - 1] += suffix;
      while (parts.length > 1) {
        let bestRank = Infinity, bestAt = -1;
        for (let i = 0; i + 1 < parts.length; i++) {
          const value = ranks.get(`${parts[i]} ${parts[i+1]}`) ?? Infinity;
          if (value < bestRank) { bestRank = value; bestAt = i; }
        }
        if (bestAt < 0) break;
        const first = parts[bestAt], second = parts[bestAt+1], result = [];
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === first && parts[i+1] === second) {
            result.push(first + second);
            i++;
          } else result.push(parts[i]);
        }
        parts = result;
      }
      for (const part of parts) {
        const id = ids.get(part);
        if (id !== undefined) out.push(id);
      }
      if (out.length > 76) throw new Error('The prompt exceeds the MobileCLIP context window');
    }
    out.push(49407);
    return BigInt64Array.from([...out, ...Array(77 - out.length).fill(0)].map(BigInt));
  };
}

export function translationTokenizer(tsv: string) {
  const pieces: string[] = [];
  const vocab = new Map<string, { id: number; score: number }>();
  let max = 0, unknownScore = Infinity;
  for (const line of tsv.trimEnd().split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) throw new Error('Invalid Marian vocabulary');
    const score = tab > 0 ? Number(line.slice(0, tab)) : NaN;
    const piece = line.slice(tab+1);
    if (Number.isFinite(score)) {
      vocab.set(piece, { id: pieces.length, score });
      max = Math.max(max, Array.from(piece).length);
      unknownScore = Math.min(score, unknownScore);
    }
    pieces.push(piece);
  }
  if (pieces.length !== 32000 || pieces[0] !== '</s>' || pieces[1] !== '<unk>') throw new Error('Unexpected Marian vocabulary');
  unknownScore -= 10;
  return {
    encode(text: string) {
      const characters = Array.from('▁' + text.normalize('NFKC').trim().replace(/[\p{Z}\s]+/gu, '▁'));
      const score = new Float64Array(characters.length+1).fill(-Infinity);
      const ids = new Int32Array(characters.length+1);
      const previous = new Int32Array(characters.length+1);
      score[0] = 0;
      const visit = (start: number, end: number, id: number, weight: number) => {
        const next = score[start] + weight;
        if (next <= score[end]) return;
        score[end] = next; ids[end] = id; previous[end] = start;
      };
      for (let start = 0; start < characters.length; start++) {
        if (!vocab.has(characters[start])) visit(start, start+1, 1, unknownScore);
        let prefix = '';
        for (let end = start; end < Math.min(characters.length, start + max); end++) {
          prefix += characters[end];
          const item = vocab.get(prefix);
          if (item) visit(start, end+1, item.id, item.score);
        }
      }
      const reversed = [];
      for (let i = characters.length; i > 0; i = previous[i]) {
        if (ids[i] !== 1 || reversed.at(-1) !== 1) reversed.push(ids[i]);
      }
      return BigInt64Array.from([...reversed.reverse(), 0].map(BigInt));
    },
    decode(ids: number[]) {
      return ids.map((id) => id === 1 ? '�' : id > 1 && id < 32000 ? pieces[id] : '')
        .join('').replace(/▁/g, ' ').trim().replace(/\.+$/, '');
    },
  };
}
