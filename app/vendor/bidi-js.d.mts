// Types for the vendored bidi-js (bidi-js.mjs): the part of its API clued uses.

export type EmbeddingLevels = {
  /** The resolved embedding level of each UTF-16 code unit: odd is right to left. */
  levels: Uint8Array
  /** One per paragraph; `start` and `end` inclusive. */
  paragraphs: { start: number; end: number; level: number }[]
}

export type Bidi = {
  getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels
  /** The ranges to reverse, in order (UAX #9 L1 and L2), of `text` from `start` to `end` inclusive. */
  getReorderSegments(text: string, levels: EmbeddingLevels, start?: number, end?: number): [number, number][]
  getMirroredCharacter(char: string): string | null
  getBidiCharTypeName(char: string): string
}

export default function bidiFactory(): Bidi
