import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import {
  RelocationDestinationAuthority,
  RelocationDestinationGrantError,
} from '../../src/main/library/relocation-destination-authority.js';

const TOKEN_A = '00000000-0000-4000-8000-000000000001';
const TOKEN_B = '00000000-0000-4000-8000-000000000002';

function fixture(t: TestContext): {
  root: string;
  outside: string;
} {
  const base = mkdtempSync(path.join(tmpdir(), 'overlook-relocation-authority-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'chosen');
  const outside = path.join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  return { root, outside };
}

describe('RelocationDestinationAuthority', () => {
  test('canonicalizes the selected root and authorizes only its canonical descendants', async (t) => {
    const { root, outside } = fixture(t);
    const rootAlias = path.join(path.dirname(root), 'chosen-alias');
    symlinkSync(root, rootAlias);
    const authority = new RelocationDestinationAuthority({ createToken: () => TOKEN_A });
    const grant = await authority.issue(7, rootAlias);

    assert.equal(grant.root, realpathSync(root));
    const lease = await authority.acquire(7, grant.authorization, path.join(rootAlias, 'Library', 'new'));
    assert.equal(lease.destination, path.join(grant.root, 'Library', 'new'));
    lease.release();

    await assert.rejects(authority.acquire(7, grant.authorization, path.join(outside, 'Library')), RelocationDestinationGrantError);
  });

  test('rejects a symlink escape through the nearest existing ancestor', async (t) => {
    const { root, outside } = fixture(t);
    symlinkSync(outside, path.join(root, 'escape'));
    const authority = new RelocationDestinationAuthority({ createToken: () => TOKEN_A });
    const grant = await authority.issue(7, root);

    await assert.rejects(
      authority.acquire(7, grant.authorization, path.join(root, 'escape', 'not-created-yet')),
      RelocationDestinationGrantError,
    );
  });

  test('binds grants to the sender and preserves the owner grant after a foreign attempt', async (t) => {
    const { root } = fixture(t);
    const authority = new RelocationDestinationAuthority({ createToken: () => TOKEN_A });
    const grant = await authority.issue(7, root);

    await assert.rejects(authority.acquire(8, grant.authorization, path.join(root, 'Library')), RelocationDestinationGrantError);
    assert.equal(authority.revoke(8, grant.authorization), false);
    const ownerLease = await authority.acquire(7, grant.authorization, path.join(root, 'Library'));
    ownerLease.release();
  });

  test('reselection, explicit close, and sender destruction revoke a batch grant', async (t) => {
    const { root } = fixture(t);
    const secondRoot = path.join(path.dirname(root), 'second');
    mkdirSync(secondRoot);
    const tokens = [TOKEN_A, TOKEN_B];
    const authority = new RelocationDestinationAuthority({ createToken: () => tokens.shift() ?? TOKEN_B });
    const first = await authority.issue(7, root);
    const second = await authority.issue(7, secondRoot);

    await assert.rejects(authority.acquire(7, first.authorization, path.join(root, 'Library')), RelocationDestinationGrantError);
    assert.equal(authority.revoke(7, second.authorization), true);
    await assert.rejects(authority.acquire(7, second.authorization, path.join(secondRoot, 'Library')), RelocationDestinationGrantError);

    const third = await authority.issue(7, root);
    authority.revokeSender(7);
    await assert.rejects(authority.acquire(7, third.authorization, path.join(root, 'Library')), RelocationDestinationGrantError);
  });

  test('active work survives the idle deadline and settlement renews the whole batch', async (t) => {
    const { root } = fixture(t);
    let now = 0;
    const authority = new RelocationDestinationAuthority({ now: () => now, createToken: () => TOKEN_A, idleMs: 10 });
    const grant = await authority.issue(7, root);
    now = 9;
    const longMove = await authority.acquire(7, grant.authorization, path.join(root, 'First'));

    now = 100;
    const overlappingProbe = await authority.acquire(7, grant.authorization, path.join(root, 'Second'));
    overlappingProbe.release();
    longMove.release();

    now = 109;
    const retry = await authority.acquire(7, grant.authorization, path.join(root, 'Retry'));
    retry.release();
    now = 119;
    await assert.rejects(authority.acquire(7, grant.authorization, path.join(root, 'Expired')), /expired/u);
  });

  test('revocation does not interrupt a lease already handed to the relocation runtime', async (t) => {
    const { root } = fixture(t);
    const authority = new RelocationDestinationAuthority({ createToken: () => TOKEN_A });
    const grant = await authority.issue(7, root);
    const lease = await authority.acquire(7, grant.authorization, path.join(root, 'Library'));

    assert.equal(authority.revoke(7, grant.authorization), true);
    assert.equal(lease.destination, path.join(grant.root, 'Library'));
    assert.doesNotThrow(() => lease.release());
    await assert.rejects(authority.acquire(7, grant.authorization, path.join(root, 'Again')), RelocationDestinationGrantError);
  });
});
