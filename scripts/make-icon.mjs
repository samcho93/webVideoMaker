// 앱 아이콘(build/icon.png, 512×512)을 외부 도구 없이 생성한다.

import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 512;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

function coverage(x, y) {
  // 둥근 사각형 안쪽 여부
  const r = 96;
  const m = 20;
  const dx = Math.max(m + r - x, x - (SIZE - m - r), 0);
  const dy = Math.max(m + r - y, y - (SIZE - m - r), 0);
  return Math.hypot(dx, dy) <= r;
}

function inPlay(x, y) {
  // 재생 삼각형 (190,146) (190,366) (372,256)
  const edge = (ax, ay, bx, by) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  return edge(190, 146, 372, 256) >= 0 && edge(372, 256, 190, 366) >= 0 && edge(190, 366, 190, 146) >= 0;
}

const SAMPLES = 4;
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let bg = 0;
    let play = 0;
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const px = x + (sx + 0.5) / SAMPLES;
        const py = y + (sy + 0.5) / SAMPLES;
        if (coverage(px, py)) bg += 1;
        if (inPlay(px, py)) play += 1;
      }
    }
    const a = bg / SAMPLES ** 2;
    const p = play / SAMPLES ** 2;
    const k = y / SIZE;
    const base = [47 + 30 * (1 - k), 111 + 30 * (1 - k), 224 + 31 * (1 - k)];
    const i = (y * SIZE + x) * 4;
    for (let c = 0; c < 3; c += 1) pixels[i + c] = Math.round(base[c] * (1 - p) + 255 * p);
    pixels[i + 3] = Math.round(a * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync(path.join('build', 'icon.png'), png);
console.log('build/icon.png');
