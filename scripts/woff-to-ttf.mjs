// Turns the IBM Plex WOFF files (from the @ibm/plex-sans and @ibm/plex-mono
// npm packages, SIL Open Font License 1.1) into the TrueType files the
// cutting sheet PDF embeds, keeping only the tables a PDF needs.
//
//   node scripts/woff-to-ttf.mjs <input.woff> <output.ttf>
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const KEEP = new Set(['cmap', 'cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'OS/2', 'post', 'prep']);
const [input, output] = process.argv.slice(2);
const woff = readFileSync(input);
if (woff.toString('ascii', 0, 4) !== 'wOFF') throw new Error('not a WOFF file');
const flavor = woff.readUInt32BE(4);
const count = woff.readUInt16BE(12);
const tables = [];
for (let i = 0; i < count; i++) {
  const at = 44 + i * 20;
  const tag = woff.toString('ascii', at, at + 4);
  const offset = woff.readUInt32BE(at + 4);
  const compressed = woff.readUInt32BE(at + 8);
  const length = woff.readUInt32BE(at + 12);
  if (!KEEP.has(tag)) continue;
  const raw = woff.subarray(offset, offset + compressed);
  const data = compressed < length ? inflateSync(raw) : Buffer.from(raw);
  if (data.length !== length) throw new Error(`bad length for ${tag}`);
  tables.push({ tag, data });
}
tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));

const checksum = (data) => {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
};
const n = tables.length;
const entrySelector = Math.floor(Math.log2(n));
const searchRange = 2 ** entrySelector * 16;
const header = Buffer.alloc(12 + n * 16);
header.writeUInt32BE(flavor, 0);
header.writeUInt16BE(n, 4);
header.writeUInt16BE(searchRange, 6);
header.writeUInt16BE(entrySelector, 8);
header.writeUInt16BE(n * 16 - searchRange, 10);
let offset = header.length;
const bodies = [];
tables.forEach((table, i) => {
  if (table.tag === 'head') table.data.writeUInt32BE(0, 8); // checkSumAdjustment, set below
  const at = 12 + i * 16;
  header.write(table.tag, at, 'ascii');
  header.writeUInt32BE(checksum(table.data), at + 4);
  header.writeUInt32BE(offset, at + 8);
  header.writeUInt32BE(table.data.length, at + 12);
  const padding = Buffer.alloc((4 - (table.data.length % 4)) % 4);
  bodies.push(table.data, padding);
  offset += table.data.length + padding.length;
});
const font = Buffer.concat([header, ...bodies]);
const head = tables.find((t) => t.tag === 'head');
const headOffset = header.readUInt32BE(12 + tables.indexOf(head) * 16 + 8);
font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
writeFileSync(output, font);
console.log(`${output}: ${n} tables, ${font.length} bytes`);
