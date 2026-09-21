/**
 * ChatGPT Context Monitor - Icon Generator
 * 
 * Generates valid, pixel-perfect PNG icons (16x16, 48x48, 128x128)
 * using Node.js built-in zlib module without any external dependencies.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const iconsDir = path.resolve(__dirname, '../assets/icons');

// Precomputed CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const toCrc = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function generatePngBuffer(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8-bit depth
  ihdrData[9] = 6; // Color type 6 (RGBA)
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method
  const ihdrChunk = createChunk('IHDR', ihdrData);

  // Raw image scanlines
  // Color palette: Background dark slate #131418 with ChatGPT Emerald #10a37f badge
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  const cx = width / 2;
  const cy = height / 2;
  const rOuter = width * 0.44;
  const rInner = width * 0.32;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter byte 0 (None)

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= rOuter && dist >= rInner) {
        // Emerald gauge arc (#10a37f)
        rawData[pxOffset] = 16;     // R
        rawData[pxOffset + 1] = 163; // G
        rawData[pxOffset + 2] = 127; // B
        rawData[pxOffset + 3] = 255; // A
      } else if (dist < rInner) {
        // Inner circle dark slate (#1c1d22)
        rawData[pxOffset] = 28;
        rawData[pxOffset + 1] = 29;
        rawData[pxOffset + 2] = 34;
        rawData[pxOffset + 3] = 255;
      } else {
        // Rounded corner outer mask
        const cornerR = width * 0.22;
        const inCornerX = x < cornerR || x >= width - cornerR;
        const inCornerY = y < cornerR || y >= height - cornerR;
        
        // Background rounded square
        rawData[pxOffset] = 19;
        rawData[pxOffset + 1] = 20;
        rawData[pxOffset + 2] = 24;
        rawData[pxOffset + 3] = 255;
      }
    }
  }

  // Compress IDAT
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressed);

  // IEND
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Ensure directory exists
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate icons
const sizes = [16, 48, 128];
for (const size of sizes) {
  const buf = generatePngBuffer(size, size);
  const filePath = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, buf);
  console.log(`[IconGen] Generated ${filePath} (${size}x${size}, ${buf.length} bytes)`);
}
