import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  createSyncString,
  deriveAuthToken,
  derivePayloadKey,
  parseSyncString,
  startLocalInbox,
} from '../../src/main/transfer-sync/local-inbox.js';

function sealAsImageTrail(secret: Buffer, name: string, plaintext: Buffer): { meta: string; body: Buffer; token: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivePayloadKey(secret), iv);
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const body = Buffer.concat([sealed, cipher.getAuthTag()]);
  const meta = Buffer.from(
    JSON.stringify({ name, iv: iv.toString('base64url'), sha256: createHash('sha256').update(plaintext).digest('hex') }),
    'utf8',
  ).toString('base64url');
  return { meta, body, token: deriveAuthToken(secret) };
}

describe('local transfer inbox', () => {
  test('sync string round-trips port and secret', () => {
    const secret = randomBytes(32);
    const parsed = parseSyncString(createSyncString({ port: 47111, secret }));
    assert.equal(parsed.port, 47111);
    assert.deepEqual(parsed.secret, secret);
    assert.throws(() => parseSyncString('OV1.not-base64!'), /incomplete|Unrecognized/u);
    assert.throws(() => parseSyncString('junk'), /Unrecognized/u);
  });

  test('accepts an authenticated encrypted upload and feeds the import chain', async () => {
    const imported: string[][] = [];
    const inbox = await startLocalInbox({
      importFiles: (paths) => {
        imported.push(paths.map((path) => readFileSync(path, 'utf8')));
        return Promise.resolve(undefined);
      },
    });
    try {
      const { port, secret } = parseSyncString(inbox.syncString);
      const plaintext = Buffer.from('original image bytes', 'utf8');
      const { meta, body, token } = sealAsImageTrail(secret, 'korn.jpg', plaintext);
      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/transfer`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'x-transfer-meta': meta },
        body,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.deepEqual(imported, [['original image bytes']]);
    } finally {
      await inbox.close();
    }
  });

  test('rejects wrong tokens, tampered payloads, and unsafe names without importing', async () => {
    const imported: string[] = [];
    const inbox = await startLocalInbox({
      importFiles: (paths) => {
        imported.push(...paths);
        return Promise.resolve(undefined);
      },
    });
    try {
      const { port, secret } = parseSyncString(inbox.syncString);
      const plaintext = Buffer.from('payload', 'utf8');
      const sealed = sealAsImageTrail(secret, 'a.jpg', plaintext);
      const url = `http://127.0.0.1:${String(port)}/v1/transfer`;

      const wrongToken = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer 0000', 'x-transfer-meta': sealed.meta },
        body: sealed.body,
      });
      assert.equal(wrongToken.status, 401);

      const tampered = Buffer.from(sealed.body);
      const first = tampered[0] ?? 0;
      tampered[0] = first ^ 0xff;
      const badBody = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${sealed.token}`, 'x-transfer-meta': sealed.meta },
        body: tampered,
      });
      assert.equal(badBody.status, 400);

      const traversal = sealAsImageTrail(secret, 'a.jpg', plaintext);
      const unsafeMeta = Buffer.from(
        Buffer.from(traversal.meta, 'base64url').toString('utf8').replace('"a.jpg"', '"../escape.jpg"'),
        'utf8',
      ).toString('base64url');
      const badName = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${traversal.token}`, 'x-transfer-meta': unsafeMeta },
        body: traversal.body,
      });
      assert.equal(badName.status, 400);

      assert.deepEqual(imported, []);
    } finally {
      await inbox.close();
    }
  });
});
