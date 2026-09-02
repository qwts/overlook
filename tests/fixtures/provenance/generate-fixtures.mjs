// Deterministic provenance fixture generator (#495, ADR-0031 §5 test notes).
// Run from the repo root:  node tests/fixtures/provenance/generate-fixtures.mjs
// Regenerates the checked-in fixtures byte-identically (no timestamps, no
// randomness) and prints their SHA-256 digests for provenance.json. Every
// image is a synthetic 16×16 gradient — nothing here is a real photograph —
// and every declaration is written by this script, so the fixtures describe
// what a file CLAIMS, never what any generator produced.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const OUT = dirname(fileURLToPath(import.meta.url));

function gradient() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 3;
      pixels[at] = x * 16;
      pixels[at + 1] = y * 16;
      pixels[at + 2] = 128;
    }
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } });
}

function xmp(body) {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
}

const DECLARED_GENERATOR = xmp(
  '<xmp:CreatorTool>Adobe Firefly 3.0</xmp:CreatorTool>' +
    '<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>',
);
const DECLARED_EDITED = xmp(
  '<xmp:CreatorTool>Adobe Photoshop 25.0 (Macintosh)</xmp:CreatorTool>' +
    '<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>' +
    '<xmpMM:History><rdf:Seq><rdf:li stEvt:action="edited" stEvt:softwareAgent="Adobe Firefly"/></rdf:Seq></xmpMM:History>',
);
const DECLARED_TOOL = xmp('<xmp:CreatorTool>Adobe Photoshop 25.0 (Macintosh)</xmp:CreatorTool>');

/** A JPEG APP11 JUMBF segment whose superbox carries the C2PA manifest-store
 * label — a CONTAINER stub only: no manifest, no signature. Extraction must
 * report it present and unverifiable, never valid. */
function c2paStubSegment() {
  const label = Buffer.from('c2pa\0', 'latin1');
  const jumdUuid = Buffer.from('6332706100110010800000aa00389b71', 'hex');
  const jumd = Buffer.concat([Buffer.alloc(4), Buffer.from('jumd', 'latin1'), jumdUuid, Buffer.from([0x03]), label]);
  jumd.writeUInt32BE(jumd.length, 0);
  const jumb = Buffer.concat([Buffer.alloc(4), Buffer.from('jumb', 'latin1'), jumd]);
  jumb.writeUInt32BE(jumb.length, 0);
  const payload = Buffer.concat([Buffer.from('JP', 'latin1'), Buffer.from([0x00, 0x01]), Buffer.from([0, 0, 0, 1]), jumb]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xeb]), Buffer.alloc(2), payload]);
  segment.writeUInt16BE(payload.length + 2, 2);
  return segment;
}

function withApp11(jpeg) {
  return Buffer.concat([jpeg.subarray(0, 2), c2paStubSegment(), jpeg.subarray(2)]);
}

/** Appends a PNG tEXt chunk before IEND. */
function withText(png, keyword, text) {
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  const type = Buffer.from('tEXt', 'latin1');
  const crc = crc32(Buffer.concat([type, data]));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([length, type, data, crc]);
  const iend = png.length - 12;
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const out = Buffer.alloc(4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return out;
}

const PARAMETERS =
  'a synthetic gradient, test fixture\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Size: 16x16, Model: fixture';

async function jpeg(extra = (image) => image) {
  return extra(gradient().jpeg({ quality: 80, mozjpeg: false })).toBuffer();
}

const fixtures = {
  'declared-generator.jpg': await jpeg((image) => image.withXmp(DECLARED_GENERATOR)),
  'declared-edited.jpg': await jpeg((image) => image.withXmp(DECLARED_EDITED)),
  'declared-tool.jpg': await jpeg((image) => image.withXmp(DECLARED_TOOL)),
  'declared-exif-software.jpg': await jpeg((image) => image.withExif({ IFD0: { Software: 'Midjourney v6' } })),
  'credential-stub.jpg': withApp11(await jpeg()),
  'unknown.jpg': await jpeg(),
  'png-parameters.png': withText(await gradient().png({ compressionLevel: 9 }).toBuffer(), 'parameters', PARAMETERS),
  'declared-sidecar.xmp': Buffer.from(
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>${DECLARED_GENERATOR}<?xpacket end="w"?>`,
    'utf8',
  ),
};

for (const [name, bytes] of Object.entries(fixtures)) {
  await writeFile(join(OUT, name), bytes);
  console.log(`${name}\t${String(bytes.length)}\t${createHash('sha256').update(bytes).digest('hex')}`);
}
