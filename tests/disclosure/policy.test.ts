import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOUNDARY_FIELDS,
  compileDisclosurePlan,
  DEFAULT_DISCLOSURE_POLICY,
  DISCLOSURE_FIELDS,
  disclosurePolicySchema,
  EMBEDDED_FIELDS,
  permissivePlan,
  PINNED_PRIVATE,
  resolveFieldClass,
  type DisclosurePolicy,
} from '../../src/shared/disclosure/policy.js';
import { diagnosticEventSchema } from '../../src/main/diagnostics/event-contract.js';
import { interopRecordSchema } from '../../src/shared/interop/records.js';
import { llmChannels } from '../../src/shared/ipc/llm-channels.js';

// ADR-0032 §6 as executable policy (#509): defaults, scope resolution,
// the operation-scope rules, and the boundaries that carry nothing.

const LIBRARY: DisclosurePolicy = DEFAULT_DISCLOSURE_POLICY;

describe('disclosure policy (#509, ADR-0032 §6)', () => {
  test('§6 defaults: nothing is public; location, ratings and faces are private; the rest shared', () => {
    assert.deepEqual(disclosurePolicySchema.parse(LIBRARY), LIBRARY);
    assert.equal(DISCLOSURE_FIELDS.length, 11);
    for (const field of DISCLOSURE_FIELDS) assert.notEqual(LIBRARY.fields[field], 'public');
    assert.deepEqual(
      DISCLOSURE_FIELDS.filter((field) => LIBRARY.fields[field] === 'private'),
      ['location', 'ratings', 'faces'],
    );
    // The pinned set is named, non-empty and not a classifiable field.
    assert.ok(PINNED_PRIVATE.length >= 10);
    for (const pinned of PINNED_PRIVATE) assert.ok(!(DISCLOSURE_FIELDS as readonly string[]).includes(pinned));
    // A policy that tries to widen a field this build does not know is rejected, not widened.
    assert.throws(() => disclosurePolicySchema.parse({ version: 1, fields: { ...LIBRARY.fields, custody: 'public' } }));
    assert.throws(() => disclosurePolicySchema.parse({ version: 2, fields: LIBRARY.fields }));
  });

  test('scope resolution narrows anywhere, widens only where recorded as explicit, and never inherits widening downward', () => {
    // Collection narrows title to private.
    assert.equal(
      resolveFieldClass('title', { library: LIBRARY, collections: [[{ field: 'title', class: 'private', widened: false }]] }),
      'private',
    );
    // Collection tries to widen location without the explicit flag: ignored.
    assert.equal(
      resolveFieldClass('location', { library: LIBRARY, collections: [[{ field: 'location', class: 'public', widened: false }]] }),
      'private',
    );
    // …and with it: applied at that level.
    assert.equal(
      resolveFieldClass('location', { library: LIBRARY, collections: [[{ field: 'location', class: 'shared', widened: true }]] }),
      'shared',
    );
    // Two collections: the narrowest wins.
    assert.equal(
      resolveFieldClass('title', {
        library: LIBRARY,
        collections: [[{ field: 'title', class: 'public', widened: true }], [{ field: 'title', class: 'private', widened: false }]],
      }),
      'private',
    );
    // Photo narrows below a widened collection.
    assert.equal(
      resolveFieldClass('location', {
        library: LIBRARY,
        collections: [[{ field: 'location', class: 'public', widened: true }]],
        photo: [{ field: 'location', class: 'private', widened: false }],
      }),
      'private',
    );
  });

  test('the plan: class ≥ destination crosses, narrow withholds, widen is the recorded exception', () => {
    const shared = compileDisclosurePlan({ boundary: 'export', destination: 'shared', chain: { library: LIBRARY } });
    assert.deepEqual(shared.disclosed, ['title', 'description', 'tags', 'captureTime', 'camera', 'lens']);
    assert.deepEqual(shared.withheld, ['location']);
    assert.deepEqual(shared.widened, []);
    const published = compileDisclosurePlan({ boundary: 'export', destination: 'public', chain: { library: LIBRARY } });
    assert.deepEqual(published.disclosed, [], 'nothing defaults to public');
    const narrowed = compileDisclosurePlan({
      boundary: 'export',
      destination: 'shared',
      chain: { library: LIBRARY },
      operation: { narrow: ['title', 'tags'], widen: [] },
    });
    assert.deepEqual(narrowed.withheld, ['title', 'tags', 'location']);
    assert.equal(narrowed.decisions.find((decision) => decision.field === 'title')?.reason, 'narrowed');
    const widened = compileDisclosurePlan({
      boundary: 'export',
      destination: 'shared',
      chain: { library: LIBRARY },
      operation: { narrow: [], widen: ['location'] },
    });
    assert.deepEqual(widened.widened, ['location']);
    assert.ok(widened.disclosed.includes('location'));
    // Widening a field the operation also narrows: narrow wins (the user withheld it here).
    const both = compileDisclosurePlan({
      boundary: 'export',
      destination: 'shared',
      chain: { library: LIBRARY },
      operation: { narrow: ['location'], widen: ['location'] },
    });
    assert.ok(!both.disclosed.includes('location'));
    assert.equal(shared.policyVersion, 1);
  });

  test('every boundary compiles only over the fields it can carry; embedded fields are a subset of export', () => {
    for (const boundary of Object.keys(BOUNDARY_FIELDS) as (keyof typeof BOUNDARY_FIELDS)[]) {
      const plan = compileDisclosurePlan({ boundary, destination: 'shared', chain: { library: LIBRARY } });
      assert.deepEqual(
        plan.decisions.map((decision) => decision.field),
        BOUNDARY_FIELDS[boundary],
      );
    }
    for (const field of EMBEDDED_FIELDS) assert.ok(BOUNDARY_FIELDS.export.includes(field));
    assert.deepEqual(BOUNDARY_FIELDS.diagnostics, []);
    assert.deepEqual(permissivePlan('llm').disclosed, ['captureTime', 'camera']);
  });

  test('boundaries that carry nothing classified stay that way: diagnostics events, the LLM ask request, the interop record', () => {
    const classified = new Set<string>([...DISCLOSURE_FIELDS, 'gpsLat', 'gpsLon', 'takenAt', 'camera', 'lens', 'place']);
    const leaks = (keys: readonly string[]): readonly string[] => keys.filter((key) => classified.has(key));
    assert.deepEqual(leaks(Object.keys(diagnosticEventSchema.shape)), []);
    assert.deepEqual(leaks(Object.keys(llmChannels.llmAsk.request.shape)), []);
    // The interop record carries a title and timestamps (both §6 shared by
    // default) and nothing private: no location, camera, lens, ratings or faces.
    const interopKeys = Object.keys(interopRecordSchema.shape);
    assert.deepEqual(leaks(interopKeys), ['title']);
    assert.ok(!interopKeys.some((key) => /gps|latitude|longitude|camera|lens|rating|face/iu.test(key)));
  });
});
