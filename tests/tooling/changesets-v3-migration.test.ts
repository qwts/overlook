import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('Changesets v3 migration (#1018)', () => {
  const manifest = json(join(root, 'package.json'));
  const config = json(join(root, '.changeset/config.json'));

  test('pins v3 and explicitly versions the private application without private tags', () => {
    const devDependencies = manifest['devDependencies'] as Record<string, string>;

    assert.equal(manifest['private'], true);
    assert.equal(devDependencies['@changesets/cli'], '3.0.1');
    assert.equal(config['$schema'], 'https://unpkg.com/@changesets/config@4.0.0/schema.json');
    assert.deepEqual(config['privatePackages'], { version: true, tag: false });
  });

  test('isolates release versioning before the Dependabot catch-all', () => {
    const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8');
    const releaseVersioning = dependabot.indexOf('release-versioning:');
    const catchAll = dependabot.indexOf('dev-tooling:');

    assert.ok(releaseVersioning >= 0);
    assert.ok(releaseVersioning < catchAll);
    assert.match(dependabot.slice(releaseVersioning, catchAll), /- '@changesets\/\*'/u);
  });

  test('status and version include a private package when the opt-in is enabled', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'overlook-changesets-v3-'));
    const changesetDir = join(fixture, '.changeset');
    const cli = join(root, 'node_modules/@changesets/cli/bin.js');
    const statusPath = join(fixture, 'status.json');
    const fixtureConfig = { ...config, changelog: false, commit: false, format: false };
    const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, env: environment, stdio: 'pipe' });

    try {
      mkdirSync(changesetDir);
      writeFileSync(
        join(fixture, 'package.json'),
        `${JSON.stringify({ name: 'fixture-private-app', version: '1.0.0', private: true }, null, 2)}\n`,
      );
      writeFileSync(join(changesetDir, 'config.json'), `${JSON.stringify(fixtureConfig, null, 2)}\n`);

      git('init', '--initial-branch=main');
      git('config', 'user.email', 'changesets-v3@example.invalid');
      git('config', 'user.name', 'Changesets v3 fixture');
      git('add', 'package.json', '.changeset/config.json');
      git('commit', '-m', 'fixture baseline');
      git('switch', '--create', 'changesets-v3-test');

      writeFileSync(join(changesetDir, 'private-app.md'), '---\n"fixture-private-app": patch\n---\n\nProve private versioning.\n');
      git('add', '.changeset/private-app.md');
      git('commit', '-m', 'add fixture changeset');

      execFileSync(process.execPath, [cli, 'status', '--output', statusPath], { cwd: fixture, env: environment, stdio: 'pipe' });
      const status = json(statusPath);
      assert.deepEqual(status['releases'], [
        {
          name: 'fixture-private-app',
          type: 'patch',
          oldVersion: '1.0.0',
          changesets: ['private-app'],
          newVersion: '1.0.1',
        },
      ]);

      execFileSync(process.execPath, [cli, 'version'], { cwd: fixture, env: environment, stdio: 'pipe' });
      assert.equal(json(join(fixture, 'package.json'))['version'], '1.0.1');
      assert.equal(existsSync(join(changesetDir, 'private-app.md')), false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
