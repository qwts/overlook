import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { createInteropProtocolRuntime } from '../../src/main/interop/protocol-runtime.js';
import { interopEnvelopeSchema } from '../../src/shared/interop/messages.js';

test('one library runtime composes the canonical Move and Sync repositories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'overlook-interop-protocols-'));
  const db = openLibraryDatabase({ path: join(directory, 'library.db'), dbKey: randomBytes(32) });
  const runtime = createInteropProtocolRuntime(db);
  const fixture = interopEnvelopeSchema.parse(
    JSON.parse(readFileSync('design/handoff/contracts/v1/fixtures/valid-record-message.json', 'utf8')) as unknown,
  );
  const move = interopEnvelopeSchema.parse({
    ...fixture,
    header: { ...fixture.header, sourceProduct: 'overlook', targetProduct: 'image-trail' },
  });

  const queued = runtime.move.queue(move);
  assert.equal(runtime.moveJournals.getJournal(queued.transferId)?.counts.total, 1);

  const sync = runtime.sync.start({
    sessionId: '05a5a92e-9386-4616-b0ab-4d7957020774',
    pairingId: move.header.pairingId,
    sourceProduct: 'image-trail',
    targetProduct: 'overlook',
    direction: 'two-way',
    scope: { kind: 'all', localIds: [] },
  });
  assert.deepEqual(runtime.syncRepository.getSession(sync.sessionId), sync);
  db.close();
});
