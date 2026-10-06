/**
 * Draws the app icon without any image tooling: a violet rounded square with a
 * 4×4 step-sequencer grid, some steps lit.
 *
 *   build/icon.png   512×512, the app and installer icon
 *   build/icon.ico   16–256 px, for .pulsegrid files in Explorer
 *   public/icon.png  the website and web studio favicon
 *
 *   node scripts/make-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

// The lit steps: a kick-and-snare shape reading left to right.
const LIT = new Set(["0,0", "2,0", "1,1", "3,1", "0,2", "1,2", "2,3", "3,3"]);

/** Render the icon at `size` pixels; the design is laid out on a 512 grid. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const k = size / 512;

  const blend = (index, [r, g, b], alpha) => {
    if (alpha <= 0) return;
    const inv = 1 - alpha;
    pixels[index] = Math.round(r * alpha + pixels[index] * inv);
    pixels[index + 1] = Math.round(g * alpha + pixels[index + 1] * inv);
    pixels[index + 2] = Math.round(b * alpha + pixels[index + 2] * inv);
    pixels[index + 3] = Math.round(255 * alpha + pixels[index + 3] * inv);
  };

  const cell = 78 * k;
  const gap = 20 * k;
  const gridStart = (size - (cell * 4 + gap * 3)) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      const tile = roundedRect(px, py, size / 2, size / 2, 240 * k, 240 * k, 96 * k);
      const t = clamp01((px + py) / (size * 2));
      blend(index, [mix(139, 67, t), mix(92, 32, t), mix(246, 163, t)], clamp01(0.5 - tile));

      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const cx = gridStart + col * (cell + gap) + cell / 2;
          const cy = gridStart + row * (cell + gap) + cell / 2;
          const coverage = clamp01(0.5 - roundedRect(px, py, cx, cy, cell / 2, cell / 2, 16 * k));
          if (coverage === 0) continue;

          const on = LIT.has(`${col},${row}`);
          blend(index, on ? [93, 230, 255] : [255, 255, 255], coverage * (on ? 1 : 0.16));
        }
      }
    }
  }

  return encodePng(size, pixels);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  const stride = size * 4 + 1;
  const rows = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    pixels.copy(rows, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** An .ico holding PNG images, which Windows has read since Vista. */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

function write(relative, data) {
  const out = path.join(root, relative);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  console.log(`wrote ${relative} (${data.length} bytes)`);
}

const large = render(512);
write("build/icon.png", large);
write("public/icon.png", large);
write("build/icon.ico", encodeIco([256, 48, 32, 16].map((size) => ({ size, png: render(size) }))));
