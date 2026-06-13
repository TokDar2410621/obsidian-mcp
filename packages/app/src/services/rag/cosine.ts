/** Tiny vector helpers. Vectors are L2-normalised once at index time, so
 * cosine similarity reduces to a dot product at query time. */

/** L2-normalise a raw vector into a Float32Array (unit length). */
export function normalize(vector: number[]): Float32Array {
  let sumSq = 0;
  for (const x of vector) sumSq += x * x;
  const norm = Math.sqrt(sumSq) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/** Dot product of two equal-length normalised vectors == cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}
