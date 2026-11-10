import zlib from 'zlib';

// Source texture helpers: PNG encoding and VTF decoding (DXT1/3/5, RGBA8888 family, RGBA16F).
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
export function png(w, h, ch, data) { // ch 3 or 4
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * ch + 1) + 1, y * w * ch, (y + 1) * w * ch);
  const chunk = (type, body) => { const b = Buffer.alloc(12 + body.length); b.writeUInt32BE(body.length); b.write(type, 4, 'latin1'); body.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + body.length)), 8 + body.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const FMT = { 0: [4, 'rgba'], 1: [4, 'abgr'], 2: [3, 'rgb'], 3: [3, 'bgr'], 12: [4, 'bgra'] };
const blockBytes = (f) => (f === 13 ? 8 : 16);
const imgBytes = (f, w, h) => (f === 24 ? 8 * w * h : FMT[f] ? FMT[f][0] * w * h : Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes(f));
export function vtfToRgba(buf) {
  if (buf.toString('latin1', 0, 3) !== 'VTF') throw new Error('bad VTF');
  const W = buf.readUInt16LE(16), H = buf.readUInt16LE(18), frames = buf.readUInt16LE(24), fmt = buf.readInt32LE(52), mips = buf.readUInt8(56);
  const lf = buf.readInt32LE(57), lw = buf.readUInt8(61), lh = buf.readUInt8(62);
  if (fmt !== 13 && fmt !== 14 && fmt !== 15 && fmt !== 24 && !FMT[fmt]) throw new Error('unsupported VTF format ' + fmt);
  let off = buf.readUInt32LE(12) + (lf >= 0 && lw && lh ? imgBytes(lf, lw, lh) : 0);
  if (buf.readUInt32LE(8) >= 3) for (let i = 0, n = buf.readUInt32LE(68); i < n; i++) { // 7.3+: a resource directory says where the image is
    const e = 80 + i * 8; if ((buf.readUInt32LE(e) & 0xffffff) === 0x30) off = buf.readUInt32LE(e + 4);
  }
  for (let m = mips - 1; m >= 1; m--) off += frames * imgBytes(fmt, Math.max(1, W >> m), Math.max(1, H >> m));
  const out = Buffer.alloc(W * H * 4);
  if (fmt === 24) { // RGBA16161616F (HDR skies): linear half floats, gamma-encoded and clamped to 0..1
    const half = (h) => { const e = (h >> 10) & 31, m = h & 1023, v = e ? (1 + m / 1024) * 2 ** (e - 15) : (m / 1024) * 2 ** -14; return h & 0x8000 ? -v : v; };
    for (let i = 0; i < W * H * 4; i++) { const v = half(buf.readUInt16LE(off + i * 2)); out[i] = (i & 3) === 3 ? 255 : Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2)); }
    return { W, H, rgba: out };
  }
  if (FMT[fmt]) {
    const [bpp, order] = FMT[fmt];
    for (let i = 0; i < W * H; i++) {
      const s = off + i * bpp, g = (c) => (order.includes(c) ? buf[s + order.indexOf(c)] : 255);
      out[i * 4] = g('r'); out[i * 4 + 1] = g('g'); out[i * 4 + 2] = g('b'); out[i * 4 + 3] = g('a');
    }
    return { W, H, rgba: out };
  }
  const c565 = (v) => [(v >> 11) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31].map(Math.round);
  for (let by = 0; by < H / 4; by++) for (let bx = 0; bx < W / 4; bx++) {
    let s = off + (by * (W / 4) + bx) * blockBytes(fmt), alpha = null;
    if (fmt === 14) { alpha = []; for (let i = 0; i < 16; i++) alpha.push(((buf[s + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17); s += 8; }
    else if (fmt === 15) {
      const a0 = buf[s], a1 = buf[s + 1];
      const pal = a0 > a1 ? [a0, a1, ...[1, 2, 3, 4, 5, 6].map((k) => ((7 - k) * a0 + k * a1) / 7)] : [a0, a1, ...[1, 2, 3, 4].map((k) => ((5 - k) * a0 + k * a1) / 5), 0, 255];
      let bits = 0n; for (let i = 7; i >= 2; i--) bits = (bits << 8n) | BigInt(buf[s + i]);
      alpha = Array.from({ length: 16 }, (_, i) => Math.round(pal[Number((bits >> BigInt(i * 3)) & 7n)])); s += 8;
    }
    const v0 = buf.readUInt16LE(s), v1 = buf.readUInt16LE(s + 2), a = c565(v0), b = c565(v1);
    const pal = v0 > v1 || fmt !== 13 ? [a, b, a.map((x, i) => Math.round((2 * x + b[i]) / 3)), a.map((x, i) => Math.round((x + 2 * b[i]) / 3))] : [a, b, a.map((x, i) => Math.round((x + b[i]) / 2)), null];
    const idx = buf.readUInt32LE(s + 4);
    for (let i = 0; i < 16; i++) {
      const col = pal[(idx >>> (i * 2)) & 3], o = ((by * 4 + (i >> 2)) * W + bx * 4 + (i & 3)) * 4;
      if (col) out.set(col, o);
      out[o + 3] = alpha ? alpha[i] : col ? 255 : 0;
    }
  }
  return { W, H, rgba: out };
}

