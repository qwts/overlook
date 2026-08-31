export const CLIP_TEXT_LENGTH = 77;
const START_OF_TEXT = 49_406;
const END_OF_TEXT = 49_407;

function byteEncoder(): ReadonlyMap<number, string> {
  const bytes: number[] = [];
  for (let value = 33; value <= 126; value += 1) bytes.push(value);
  for (let value = 161; value <= 172; value += 1) bytes.push(value);
  for (let value = 174; value <= 255; value += 1) bytes.push(value);
  const unicode = [...bytes];
  let extra = 0;
  for (let value = 0; value < 256; value += 1) {
    if (bytes.includes(value)) continue;
    bytes.push(value);
    unicode.push(256 + extra);
    extra += 1;
  }
  return new Map(bytes.map((value, index) => [value, String.fromCodePoint(unicode[index]!)]));
}

function pairs(symbols: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (let index = 0; index + 1 < symbols.length; index += 1) {
    result.add(`${symbols[index]!}\u0000${symbols[index + 1]!}`);
  }
  return result;
}

function mergeToken(token: string, ranks: ReadonlyMap<string, number>): readonly string[] {
  if (token.length === 0) return [];
  let symbols = [...token.slice(0, -1), `${token.at(-1)!}</w>`];
  while (symbols.length > 1) {
    const candidate = [...pairs(symbols)]
      .map((key) => [key, ranks.get(key)] as const)
      .filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
      .sort((left, right) => left[1] - right[1])[0];
    if (candidate === undefined) break;
    const [first, second] = candidate[0].split('\u0000');
    const merged: string[] = [];
    for (let index = 0; index < symbols.length; index += 1) {
      if (symbols[index] === first && symbols[index + 1] === second) {
        merged.push(`${first!}${second!}`);
        index += 1;
      } else {
        merged.push(symbols[index]!);
      }
    }
    symbols = merged;
  }
  return symbols;
}

/** Minimal CLIP BPE tokenizer for the pinned text tower. */
export function createClipTokenizer(input: unknown): (text: string) => readonly number[] {
  const root = input as { readonly model?: unknown };
  const model = root.model as { readonly merges?: unknown; readonly vocab?: unknown } | undefined;
  if (
    !Array.isArray(model?.merges) ||
    !model.merges.every((merge: unknown) => typeof merge === 'string') ||
    model.vocab === null ||
    typeof model.vocab !== 'object'
  ) {
    throw new Error('invalid CLIP tokenizer specification');
  }
  const merges = model.merges as readonly string[];
  const vocab = model.vocab as Readonly<Record<string, unknown>>;
  const encodeByte = byteEncoder();
  const ranks = new Map(merges.map((merge, index) => [merge.replace(' ', '\u0000'), index]));
  const pattern = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;
  return (text) => {
    const normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
    const ids = [START_OF_TEXT];
    for (const match of normalized.matchAll(pattern)) {
      const encoded = [...new TextEncoder().encode(match[0])].map((value) => encodeByte.get(value)!).join('');
      for (const symbol of mergeToken(encoded, ranks)) {
        const id = vocab[symbol];
        if (typeof id !== 'number') throw new Error(`tokenizer vocabulary misses ${JSON.stringify(symbol)}`);
        ids.push(id);
      }
    }
    ids.push(END_OF_TEXT);
    if (ids.length > CLIP_TEXT_LENGTH) ids.splice(CLIP_TEXT_LENGTH - 1, ids.length, END_OF_TEXT);
    return ids;
  };
}
