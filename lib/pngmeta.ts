// Embed the recipe code in exported PNGs as a tEXt chunk (keyword "lores"),
// and read it back when someone drops a lores PNG in — their look comes with
// the file, no server involved.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const KEYWORD = "lores";

export async function embedRecipe(png: Blob, code: string): Promise<Blob> {
  const buf = new Uint8Array(await png.arrayBuffer());
  const text = new TextEncoder().encode(`${KEYWORD}\0${code}`);
  const chunk = new Uint8Array(12 + text.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, text.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
  chunk.set(text, 8);
  dv.setUint32(8 + text.length, crc32(chunk.subarray(4, 8 + text.length)));
  // Insert right after IHDR (8-byte signature + 25-byte IHDR chunk).
  const at = 33;
  const out = new Uint8Array(buf.length + chunk.length);
  out.set(buf.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(buf.subarray(at), at + chunk.length);
  return new Blob([out], { type: "image/png" });
}

export async function readRecipe(file: Blob): Promise<string | null> {
  if (file.type && file.type !== "image/png") return null;
  const buf = new Uint8Array(await file.slice(0, 1 << 20).arrayBuffer());
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const dv = new DataView(buf.buffer);
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    if (type === "tEXt" && p + 8 + len <= buf.length) {
      const body = new TextDecoder().decode(buf.subarray(p + 8, p + 8 + len));
      const nul = body.indexOf("\0");
      if (nul > 0 && body.slice(0, nul) === KEYWORD) return body.slice(nul + 1);
    }
    if (type === "IDAT" || type === "IEND") break;
    p += 12 + len;
  }
  return null;
}
