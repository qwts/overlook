import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PROVENANCE_EVALUATOR,
  buildProvenanceEvidence,
  credentialOutcome,
  deriveProvenanceTier,
  parseProvenanceEvidence,
  provenanceIsStale,
  strongestClaim,
  type ProvenanceSource,
} from '../../src/shared/library/provenance.js';

// #495 / ADR-0031 §5: tiers are non-collapsible evidence, not a verdict.
// Only a validated credential is Verified; a present or invalid credential
// and any declaration are Declared; a detector that did not report negative
// is Detected; nothing is Unknown. Records bind to subject bytes and the
// evaluator, and a newer record format fails closed.

const HASH = 'a'.repeat(64);
const AT = '2026-09-02T10:00:00.000Z';

const credential = (outcome: 'valid' | 'invalid' | 'unverifiable', validator: string | null = null): ProvenanceSource => ({
  kind: 'credential',
  format: 'c2pa',
  container: 'jpeg-app11',
  bytes: 1200,
  outcome,
  validator,
  reason: 'test',
});
const declaration = (claim: 'generated' | 'edited' | 'tool' | 'capture'): ProvenanceSource => ({
  kind: 'declaration',
  origin: 'xmp',
  field: 'xmp:CreatorTool',
  value: 'Fixture',
  claim,
});
const detector = (result: 'positive' | 'negative' | 'inconclusive'): ProvenanceSource => ({
  kind: 'detector',
  name: 'fixture-detector',
  version: '1',
  result,
  confidence: 0.5,
  limits: 'fixture limits',
});

describe('provenance evidence model (#495)', () => {
  test('tiers derive from the strongest supported evidence and never collapse', () => {
    assert.equal(deriveProvenanceTier([]), 'unknown');
    assert.equal(deriveProvenanceTier([detector('negative')]), 'unknown');
    assert.equal(deriveProvenanceTier([detector('inconclusive')]), 'detected');
    assert.equal(deriveProvenanceTier([detector('positive')]), 'detected');
    assert.equal(deriveProvenanceTier([declaration('tool')]), 'declared');
    assert.equal(deriveProvenanceTier([declaration('capture'), detector('positive')]), 'declared');
    // A present credential this build cannot validate is Declared, not Verified.
    assert.equal(deriveProvenanceTier([credential('unverifiable')]), 'declared');
    assert.equal(deriveProvenanceTier([credential('invalid')]), 'declared');
    assert.equal(deriveProvenanceTier([credential('valid', 'c2pa-rs 0.40 · default trust list')]), 'verified');
  });

  test('summary helpers rank claims and credential outcomes honestly', () => {
    assert.equal(strongestClaim([]), null);
    assert.equal(strongestClaim([declaration('capture'), declaration('tool')]), 'tool');
    assert.equal(strongestClaim([declaration('edited'), declaration('generated'), declaration('tool')]), 'generated');
    assert.equal(credentialOutcome([]), null);
    assert.equal(credentialOutcome([credential('unverifiable')]), 'unverifiable');
    assert.equal(credentialOutcome([credential('unverifiable'), credential('invalid')]), 'invalid');
    assert.equal(credentialOutcome([credential('invalid'), credential('valid', 'v')]), 'valid');
  });

  test('a built record binds the subject hash and evaluator, is local, and detects staleness', () => {
    const evidence = buildProvenanceEvidence({ subjectHash: HASH, evaluatedAt: AT, sources: [declaration('generated')] });
    assert.equal(evidence.version, 1);
    assert.equal(evidence.evaluator, PROVENANCE_EVALUATOR);
    assert.equal(evidence.network, false);
    assert.equal(evidence.tier, 'declared');
    assert.equal(provenanceIsStale(evidence, HASH), false);
    assert.equal(provenanceIsStale(evidence, 'b'.repeat(64)), true);
    assert.equal(provenanceIsStale({ ...evidence, evaluator: 'overlook-provenance/0' }, HASH), true);
  });

  test('parsing fails closed: a newer format is reported unsupported, malformed input too', () => {
    const evidence = buildProvenanceEvidence({ subjectHash: HASH, evaluatedAt: AT, sources: [] });
    assert.deepEqual(parseProvenanceEvidence(evidence), { evidence, unsupported: null });
    const newer = parseProvenanceEvidence({ ...evidence, version: 2, future: true });
    assert.equal(newer.evidence, null);
    assert.match(newer.unsupported ?? '', /newer/u);
    assert.equal(parseProvenanceEvidence({ version: 1, tier: 'verified' }).evidence, null);
    assert.equal(parseProvenanceEvidence('nope').evidence, null);
  });

  test('the schema rejects an out-of-model tier or a credential with an unknown outcome', () => {
    const evidence = buildProvenanceEvidence({ subjectHash: HASH, evaluatedAt: AT, sources: [] });
    assert.equal(parseProvenanceEvidence({ ...evidence, tier: 'human' }).evidence, null);
    assert.equal(parseProvenanceEvidence({ ...evidence, sources: [{ ...credential('valid'), outcome: 'probably' }] }).evidence, null);
  });
});
