import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function workflowStep(workflow: string, name: string, nextName: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  const end = workflow.indexOf(`- name: ${nextName}`);
  assert.ok(start !== -1, `workflow must have a "${name}" step`);
  assert.ok(end > start, `workflow must have a "${nextName}" step after "${name}"`);
  return workflow.slice(start, end);
}

// Signing material must never be visible to the build phase: a compromised
// build-time dependency running under electron-vite could exfiltrate the mac
// certificate or the Azure Trusted Signing service principal and sign malware
// outside the release workflow (#855). The build runs in its own step with no
// signing secrets in env; the Package step signs the already-built output via
// the dist* scripts, which never rebuild.
describe('signing secret scope (#855)', () => {
  const SIGNING_SECRETS =
    /CSC_LINK|CSC_KEY_PASSWORD|MAC_PROVISIONING_PROFILE|APPLE_API|AZURE_TENANT_ID|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET/u;

  test('the Build step carries no signing secrets', () => {
    const workflow = source('.github/workflows/package.yml');
    const build = workflowStep(workflow, 'Build', 'Package');
    assert.match(build, /npm run build/u);
    assert.doesNotMatch(build, SIGNING_SECRETS);
  });

  test('the Package step signs without rebuilding', () => {
    const workflow = source('.github/workflows/package.yml');
    const pkg = workflowStep(workflow, 'Package', 'Upload artifacts');
    assert.match(pkg, SIGNING_SECRETS);
    assert.doesNotMatch(pkg, /npm run build/u);
    // Only the build-free dist* scripts may run under the signing env — the
    // compound package* scripts rebuild first.
    assert.doesNotMatch(pkg, /npm run "?package/u);
  });

  test('dist scripts package without rebuilding; package scripts compose build + dist', () => {
    const packageJson = JSON.parse(source('package.json')) as { readonly scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    const pairs = [
      ['package', 'dist'],
      ['package:win:x64', 'dist:win:x64'],
      ['package:win:arm64', 'dist:win:arm64'],
      ['package:signed', 'dist:signed'],
      ['package:signed:provisioned', 'dist:signed:provisioned'],
    ] as const;
    for (const [pkg, dist] of pairs) {
      assert.equal(scripts[pkg], `npm run build && npm run ${dist}`, `${pkg} must be build + ${dist}`);
      assert.doesNotMatch(scripts[dist] ?? '', /npm run build|electron-vite/u, `${dist} must not rebuild`);
    }
  });
});
