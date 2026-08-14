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

const PACKAGE_SECRETS = [
  'GOOGLE_DRIVE_CLIENT_ID',
  'GOOGLE_DRIVE_CLIENT_SECRET',
  'PCLOUD_CLIENT_ID',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'MAC_PROVISIONING_PROFILE',
  'FILE_PROVIDER_PROVISIONING_PROFILE',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
] as const;

const APPLE_PACKAGE_ENV = [
  ['CSC_LINK', 'CSC_LINK'],
  ['CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD'],
  ['MAC_PROVISIONING_PROFILE_B64', 'MAC_PROVISIONING_PROFILE'],
  ['FILE_PROVIDER_PROVISIONING_PROFILE_B64', 'FILE_PROVIDER_PROVISIONING_PROFILE'],
  ['APPLE_API_KEY_B64', 'APPLE_API_KEY'],
  ['APPLE_API_KEY_ID', 'APPLE_API_KEY_ID'],
  ['APPLE_API_ISSUER', 'APPLE_API_ISSUER'],
] as const;

const AZURE_PACKAGE_ENV = [
  ['AZURE_TENANT_ID', 'AZURE_TENANT_ID'],
  ['AZURE_CLIENT_ID', 'AZURE_CLIENT_ID'],
  ['AZURE_CLIENT_SECRET', 'AZURE_CLIENT_SECRET'],
] as const;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
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

  test('the reusable Package workflow declares exactly the credentials it consumes', () => {
    const workflow = source('.github/workflows/package.yml');
    const workflowCall = workflow.split('  workflow_call:')[1]?.split('\npermissions:')[0] ?? '';
    const declarationBlock = workflowCall.split('    secrets:')[1] ?? '';
    const declared = [...declarationBlock.matchAll(/^ {6}([A-Z0-9_]+):$/gmu)].map((match) => match[1] ?? '');
    const consumed = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1] ?? '');

    assert.deepEqual(sorted(declared), sorted(PACKAGE_SECRETS));
    assert.deepEqual(sorted(new Set(consumed)), sorted(PACKAGE_SECRETS));
    for (const secret of PACKAGE_SECRETS) {
      assert.match(declarationBlock, new RegExp(`^ {6}${secret}:\\n {8}required: false$`, 'mu'));
    }
  });

  test('Release passes only the declared Package credentials', () => {
    const release = source('.github/workflows/release.yml');
    const build = release.split('\n  build:')[1]?.split('\n  publish:')[0] ?? '';
    const mappings = [...build.matchAll(/^ {6}([A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) \}\}$/gmu)].map((match) => {
      assert.equal(match[1], match[2], 'Package secret names must not be remapped');
      return match[1] ?? '';
    });

    assert.deepEqual(sorted(mappings), sorted(PACKAGE_SECRETS));
    assert.doesNotMatch(build, /secrets: inherit/u);
  });

  test('each signing platform receives only its own credential values', () => {
    const workflow = source('.github/workflows/package.yml');
    const pkg = workflowStep(workflow, 'Package', 'Upload artifacts');
    const referencedSecrets = [...pkg.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1] ?? '');

    for (const [env, secret] of APPLE_PACKAGE_ENV) {
      const expected = `${env}: ` + "${{ runner.os == 'macOS' && secrets." + secret + " || '' }}";
      assert.ok(pkg.includes(expected));
      assert.equal(referencedSecrets.filter((candidate) => candidate === secret).length, 1);
    }
    for (const [env, secret] of AZURE_PACKAGE_ENV) {
      const expected = `${env}: ` + "${{ runner.os == 'Windows' && secrets." + secret + " || '' }}";
      assert.ok(pkg.includes(expected));
      assert.equal(referencedSecrets.filter((candidate) => candidate === secret).length, 1);
    }
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
