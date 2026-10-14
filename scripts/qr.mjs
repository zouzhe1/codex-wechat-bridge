import fs from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import qrcode from '../vendor/qrcode.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
export async function saveQr(text, file) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const count = qr.getModuleCount(); const scale = 8; const dimension = (count + 8) * scale;
  const raw = Buffer.alloc(dimension * (dimension + 1), 255);
  for (let y = 0; y < dimension; y++) {
    raw[y * (dimension + 1)] = 0;
    for (let x = 0; x < dimension; x++) {
      const r = Math.floor(y / scale) - 4; const c = Math.floor(x / scale) - 4;
      if (r >= 0 && c >= 0 && r < count && c < count && qr.isDark(r, c)) raw[y * (dimension + 1) + x + 1] = 0;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dimension, 0); ihdr.writeUInt32BE(dimension, 4); ihdr[8] = 8;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  await fs.writeFile(file, png, { mode: 0o600 });
  return { width: dimension, height: dimension };
}
