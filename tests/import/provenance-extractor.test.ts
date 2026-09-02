import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { classifyTool, extractProvenanceSources, findXmpPacket, xmpSources } from '../../src/main/import/provenance-extractor.js';
import { deriveProvenanceTier } from '../../src/shared/library/provenance.js';

// #495 / ADR-0031 §5: local, bounded, non-validating extraction. Fixtures
// (tests/fixtures/provenance, generated in-repo) cover every honest state
// the extractor can produce: declared generator, declared AI edit, declared
// tool, EXIF Software, PNG generator text, a present C2PA container (which
// is unverifiable — never valid — in a build without a validator), a sidecar
// declaration, and no evidence at all.

const FIXTURES = join(import.meta.dirname, '../../../tests/fixtures/provenance');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

describe('provenance extraction (#495)', () => {
  test('a declared generator yields generation declarations from XMP and the Declared tier', async () => {
    const sources = await extractProvenanceSources(fixture('declared-generator.jpg'));
    assert.deepEqual(
      sources.map((source) => (source.kind === 'declaration' ? [source.field, source.claim] : source.kind)),
      [
        ['Iptc4xmpExt:DigitalSourceType', 'generated'],
        ['xmp:CreatorTool', 'generated'],
      ],
    );
    assert.equal(deriveProvenanceTier(sources), 'declared');
  });

  test('a declared AI edit reports the composite source type and the generator agent in history', async () => {
    const sources = await extractProvenanceSources(fixture('declared-edited.jpg'));
    const claims = sources.map((source) => (source.kind === 'declaration' ? `${source.field}=${source.claim}` : source.kind));
    assert.deepEqual(claims, ['Iptc4xmpExt:DigitalSourceType=edited', 'xmp:CreatorTool=tool', 'xmpMM:History/stEvt:softwareAgent=edited']);
  });

  test('a tool declaration alone is a tool claim, never an AI claim', async () => {
    const sources = await extractProvenanceSources(fixture('declared-tool.jpg'));
    assert.deepEqual(
      sources.map((source) => (source.kind === 'declaration' ? source.claim : source.kind)),
      ['tool'],
    );
    assert.equal(classifyTool('Adobe Photoshop 25.0'), 'tool');
    assert.equal(classifyTool('Midjourney v6'), 'generated');
    assert.equal(classifyTool('DALL·E 3'), 'generated');
  });

  test('EXIF Software naming a generator is a declaration of generation', async () => {
    const sources = await extractProvenanceSources(fixture('declared-exif-software.jpg'));
    assert.deepEqual(
      sources.map((source) => (source.kind === 'declaration' ? [source.origin, source.field, source.value, source.claim] : source.kind)),
      [['exif', 'Software', 'Midjourney v6', 'generated']],
    );
  });

  test('PNG generator text (A1111 parameters) declares generation with the text verbatim', async () => {
    const sources = await extractProvenanceSources(fixture('png-parameters.png'));
    assert.equal(sources.length, 1);
    const [source] = sources;
    assert.ok(source?.kind === 'declaration');
    assert.equal(source.origin, 'png-text');
    assert.equal(source.field, 'parameters');
    assert.equal(source.claim, 'generated');
    assert.match(source.value, /Steps: 20/u);
  });

  test('a present C2PA container is reported unverifiable with no validator — never valid', async () => {
    const sources = await extractProvenanceSources(fixture('credential-stub.jpg'));
    assert.equal(sources.length, 1);
    const [source] = sources;
    assert.ok(source?.kind === 'credential');
    assert.equal(source.container, 'jpeg-app11');
    assert.equal(source.outcome, 'unverifiable');
    assert.equal(source.validator, null);
    assert.ok(source.bytes > 0);
    assert.equal(deriveProvenanceTier(sources), 'declared');
  });

  test('a file with no supported evidence yields nothing (Unknown, not human-made)', async () => {
    assert.deepEqual(await extractProvenanceSources(fixture('unknown.jpg')), []);
    assert.deepEqual(await extractProvenanceSources(Buffer.alloc(0)), []);
    assert.deepEqual(await extractProvenanceSources(Buffer.from('not an image at all')), []);
  });

  test('an XMP sidecar in custody contributes sidecar-origin declarations', async () => {
    const sources = await extractProvenanceSources(fixture('unknown.jpg'), [fixture('declared-sidecar.xmp')]);
    assert.deepEqual(
      sources.map((source) => (source.kind === 'declaration' ? [source.origin, source.claim] : source.kind)),
      [
        ['xmp-sidecar', 'generated'],
        ['xmp-sidecar', 'generated'],
      ],
    );
  });

  test('XMP forms: element, attribute, rdf:resource, and an unknown source type contributes nothing', () => {
    const attribute =
      '<rdf:Description xmp:CreatorTool="Stable Diffusion WebUI" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"/>';
    assert.deepEqual(
      xmpSources(attribute, 'xmp').map((source) => (source.kind === 'declaration' ? source.claim : source.kind)),
      ['capture', 'generated'],
    );
    const resource =
      '<Iptc4xmpExt:DigitalSourceType rdf:resource="http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia"/></Iptc4xmpExt:DigitalSourceType>';
    assert.deepEqual(
      xmpSources(resource, 'xmp').map((source) => (source.kind === 'declaration' ? source.claim : source.kind)),
      ['generated'],
    );
    assert.deepEqual(xmpSources('<Iptc4xmpExt:DigitalSourceType>made-up</Iptc4xmpExt:DigitalSourceType>', 'xmp'), []);
    assert.equal(findXmpPacket(Buffer.from('<x:xmpmeta>unterminated')), null);
    assert.equal(findXmpPacket(Buffer.from('prefix<rdf:RDF>x</rdf:RDF>suffix')), '<rdf:RDF>x</rdf:RDF>');
  });

  test('hostile containers degrade to nothing: truncated JPEG segments, bogus PNG chunk lengths, tiny ISO-BMFF', async () => {
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xeb, 0xff, 0xff, 0x4a, 0x50]);
    assert.deepEqual(await extractProvenanceSources(truncated), []);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from('caBX'),
    ]);
    const sources = await extractProvenanceSources(png);
    assert.deepEqual(
      sources.map((source) => source.kind),
      ['credential'],
    );
    const iso = Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('ftyp'), Buffer.from([0, 0, 0, 1]), Buffer.from('uuid')]);
    assert.deepEqual(await extractProvenanceSources(iso), []);
  });
});
