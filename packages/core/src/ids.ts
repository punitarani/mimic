const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32. Sorts by time. Pass `rng` only for
 * reproducible offline runs (tests); IDs in the app are always random.
 */
export function ulid(now: number = Date.now(), rng?: () => number): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  if (rng) for (let i = 0; i < 16; i++) rand[i] = Math.floor(rng() * 32);
  else crypto.getRandomValues(rand);
  let r = '';
  for (let i = 0; i < 16; i++) r += ALPHABET[rand[i]! % 32];
  return ts + r;
}

/** Timestamp (ms) encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < 10; i++) t = t * 32 + ALPHABET.indexOf(id[i]!);
  return t;
}
