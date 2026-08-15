#!/usr/bin/env node
/* Generate PWA PNG icons (dark rounded square + accent chip + typing dots). */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// --- CRC32 (PNG chunk integrity) ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, left, top, w, h, r) {
  if (x < left || x > left + w || y < top || y > top + h) return false;
  const dx = Math.max(left + r - x, 0, x - (left + w - r));
  const dy = Math.max(top + r - y, 0, y - (top + h - r));
  return dx * dx + dy * dy <= r * r;
}

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [11, 18, 32]; // #0b1220
  const accent = [59, 130, 246]; // #3b82f6
  const white = [230, 237, 247];

  const corner = size * 0.18;
  const sq = size * 0.54;
  const sqLeft = (size - sq) / 2;
  const sqTop = (size - sq) / 2;
  const sqR = sq * 0.24;
  const dotR = size * 0.042;
  const dotY = size * 0.5;
  const dotsX = [size * 0.38, size * 0.5, size * 0.62];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      if (!inRoundedRect(x, y, 0, 0, size - 1, size - 1, corner)) {
        buf[p + 3] = 0;
        continue;
      }
      buf[p] = bg[0];
      buf[p + 1] = bg[1];
      buf[p + 2] = bg[2];
      buf[p + 3] = 255;
      if (inRoundedRect(x, y, sqLeft, sqTop, sq, sq, sqR)) {
        buf[p] = accent[0];
        buf[p + 1] = accent[1];
        buf[p + 2] = accent[2];
      }
      for (const dx of dotsX) {
        const ddx = x - dx;
        const ddy = y - dotY;
        if (ddx * ddx + ddy * ddy <= dotR * dotR) {
          buf[p] = white[0];
          buf[p + 1] = white[1];
          buf[p + 2] = white[2];
        }
      }
    }
  }
  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log('wrote', file);
}
