/**
 * Linearly blend two same-size ImageData buffers.
 * amount=0 → returns a, amount=1 → returns b. Allocates a new ImageData.
 */
export function blend(a: ImageData, b: ImageData, amount: number): ImageData {
  if (amount <= 0) return a;
  if (amount >= 1) return b;
  const out = new ImageData(a.width, a.height);
  const inv = 1 - amount;
  const ad = a.data;
  const bd = b.data;
  const od = out.data;
  for (let i = 0; i < ad.length; i += 4) {
    od[i] = ad[i] * inv + bd[i] * amount;
    od[i + 1] = ad[i + 1] * inv + bd[i + 1] * amount;
    od[i + 2] = ad[i + 2] * inv + bd[i + 2] * amount;
    od[i + 3] = ad[i + 3] * inv + bd[i + 3] * amount;
  }
  return out;
}
