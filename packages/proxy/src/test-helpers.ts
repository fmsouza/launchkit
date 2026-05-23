export const collectStream = async (s: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = s.getReader(); const dec = new TextDecoder(); let out = ""
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value) }
  return out
}
export async function* fromArray<T>(xs: readonly T[]): AsyncIterable<T> { for (const x of xs) yield x }
