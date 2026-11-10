// 3D colour tables (LUTs) for looks measured from real cameras. Each is a
// 32³ table stored as an N²×N PNG (pixel (b·N + r, g) = LUT[r, g, b]),
// fetched the first time a look needs it and kept for the session.

export type Lut = { id: string; size: number; data: Uint8Array };

const cache = new Map<string, Lut>();
const loading = new Map<string, Promise<Lut | null>>();

/** A loaded table, or null if it hasn't been fetched (see `ensureLuts`). */
export function lutSync(id: string): Lut | null {
  return (id && cache.get(id)) || null;
}

export function loadLut(id: string): Promise<Lut | null> {
  if (!id) return Promise.resolve(null);
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let job = loading.get(id);
  if (!job) {
    job = (async () => {
      try {
        const res = await fetch(`/luts/${id}.png`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        const n = bmp.height;
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = n;
        const x = c.getContext("2d", { willReadFrequently: true })!;
        x.drawImage(bmp, 0, 0);
        bmp.close();
        const px = x.getImageData(0, 0, c.width, n).data;
        // Re-pack as r fastest, then g, then b — a 3D texture's layout.
        const data = new Uint8Array(n * n * n * 4);
        for (let b = 0; b < n; b++)
          for (let g = 0; g < n; g++)
            for (let r = 0; r < n; r++) {
              const s = (g * n * n + b * n + r) * 4;
              const d = ((b * n + g) * n + r) * 4;
              data[d] = px[s];
              data[d + 1] = px[s + 1];
              data[d + 2] = px[s + 2];
              data[d + 3] = 255;
            }
        const lut = { id, size: n, data };
        cache.set(id, lut);
        return lut;
      } catch (err) {
        // Flag and carry on: the look renders without its table.
        console.warn(`[pixel] colour table ${id} unavailable`, err);
        loading.delete(id);
        return null;
      }
    })();
    loading.set(id, job);
  }
  return job;
}

/** Fetch every table these recipes use, before a render that needs them. */
export async function ensureLuts(recipes: { lut: string }[]) {
  await Promise.all(recipes.filter((r) => r.lut && !cache.has(r.lut)).map((r) => loadLut(r.lut)));
}

/** Trilinear lookup, 0..1 in and out (the CPU twin of the shader's). */
export function sampleLut(l: Lut, r: number, g: number, b: number): [number, number, number] {
  const n = l.size;
  const m = n - 1;
  const fr = Math.min(m, Math.max(0, r * m));
  const fg = Math.min(m, Math.max(0, g * m));
  const fb = Math.min(m, Math.max(0, b * m));
  const r0 = Math.min(m - 1, fr | 0);
  const g0 = Math.min(m - 1, fg | 0);
  const b0 = Math.min(m - 1, fb | 0);
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  const d = l.data;
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const at = (bb: number, gg: number, rr: number) => d[((bb * n + gg) * n + rr) * 4 + ch];
    const c00 = at(b0, g0, r0) + (at(b0, g0, r0 + 1) - at(b0, g0, r0)) * tr;
    const c01 = at(b0, g0 + 1, r0) + (at(b0, g0 + 1, r0 + 1) - at(b0, g0 + 1, r0)) * tr;
    const c10 = at(b0 + 1, g0, r0) + (at(b0 + 1, g0, r0 + 1) - at(b0 + 1, g0, r0)) * tr;
    const c11 = at(b0 + 1, g0 + 1, r0) + (at(b0 + 1, g0 + 1, r0 + 1) - at(b0 + 1, g0 + 1, r0)) * tr;
    const c0 = c00 + (c01 - c00) * tg;
    const c1 = c10 + (c11 - c10) * tg;
    out[ch] = (c0 + (c1 - c0) * tb) / 255;
  }
  return out;
}
