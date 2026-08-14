import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('Windows ARM64 packaging + signing (#683)', () => {
  test('the package matrix builds macOS plus a Windows leg per architecture', () => {
    const workflow = source('.github/workflows/package.yml');
    assert.match(workflow, /include:/u);
    assert.match(workflow, /os: macos-latest/u);
    assert.match(workflow, /os: windows-latest\s+win-arch: x64/u);
    assert.match(workflow, /os: windows-latest\s+win-arch: arm64/u);
    // No lingering single-axis matrix that would build only one Windows arch.
    assert.doesNotMatch(workflow, /os: \[macos-latest, windows-latest\]/u);
  });

  test('artifacts are architecture-qualified so the two Windows legs never collide', () => {
    const workflow = source('.github/workflows/package.yml');
    const builder = source('electron-builder.yml');
    assert.match(
      workflow,
      /name: overlook-\$\{\{ matrix\.win-arch != '' && format\('windows-\{0\}', matrix\.win-arch\) \|\| matrix\.os \}\}/u,
    );
    assert.match(builder, /artifactName: \$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}/u);
  });

  test('each Windows leg drives the arch through a dedicated dist script', () => {
    const packageJson = JSON.parse(source('package.json')) as { readonly scripts?: Record<string, string> };
    const workflow = source('.github/workflows/package.yml');
    assert.match(packageJson.scripts?.['dist:win:x64'] ?? '', /electron-builder --publish never --win --x64/u);
    assert.match(packageJson.scripts?.['dist:win:arm64'] ?? '', /electron-builder --publish never --win --arm64/u);
    assert.match(workflow, /npm run "dist:win:\$WIN_ARCH"/u);
    assert.match(workflow, /WIN_ARCH: \$\{\{ matrix\.win-arch \}\}/u);
  });

  test('every Windows leg verifies the payload architecture post-build', () => {
    const workflow = source('.github/workflows/package.yml');
    assert.match(workflow, /node scripts\/verify-windows-arch\.mjs "\$WIN_ARCH"/u);
  });

  test('the NSIS payload uses a filter the installer can actually decode', () => {
    const workflow = source('.github/workflows/package.yml');
    // electron-builder's downloaded 7-Zip 24.x auto-applies its ARM64 branch
    // filter (method 0A) to ARM64 binaries, but the nsis7z plugin unpacking
    // the payload at install time predates that filter and silently skips
    // every file using it -- shipping an arm64 installer that installed
    // everything except Overlook.exe and 10 ARM64 DLLs (#683). Pinning an
    // older filter keeps the payload decodable; extracted bytes are identical.
    assert.match(workflow, /export ELECTRON_BUILDER_7Z_FILTER=BCJ2/u);
  });

  test('cross-compiled legs lock, verify, and isolate the target sharp binary', () => {
    const workflow = source('.github/workflows/package.yml');
    // npm ci installs only the host sharp binary; the arm64 leg must pull the
    // target-arch @img/sharp-win32-<arch> and prune the rest, or a mixed
    // payload would ship (and fail verify-windows-arch). Uses npm pack + extract
    // (not `npm install --cpu/--os`, which would prune the host build toolchain).
    assert.match(workflow, /npm pack "@img\/\$pkg@\$sharp_ver"/u);
    assert.match(workflow, /require\("\.\/package-lock\.json"\)\.packages/u);
    assert.match(workflow, /locked\.version !== version/u);
    assert.match(workflow, /createHash\("sha512"\)/u);
    assert.match(workflow, /actual !== locked\.integrity/u);
    assert.ok(workflow.indexOf('actual !== locked.integrity') < workflow.indexOf('tar -xzf "$tgz"'));
    assert.doesNotMatch(workflow, /npm install --no-save --cpu="\$WIN_ARCH" --os=win32 sharp/u);
    assert.match(workflow, /find node_modules\/@img .* -name 'sharp-win32-\*' ! -name "\$pkg"/u);
  });

  test('Windows signing uses Azure Trusted Signing, isolated from the mac certificate', () => {
    const workflow = source('.github/workflows/package.yml');
    const builder = source('electron-builder.yml');
    // Separate secrets: the Azure service principal, never the mac CSC_*.
    assert.match(workflow, /AZURE_TENANT_ID: \$\{\{ runner\.os == 'Windows' && secrets\.AZURE_TENANT_ID \|\| '' \}\}/u);
    assert.match(workflow, /AZURE_CLIENT_ID: \$\{\{ runner\.os == 'Windows' && secrets\.AZURE_CLIENT_ID \|\| '' \}\}/u);
    assert.match(workflow, /AZURE_CLIENT_SECRET: \$\{\{ runner\.os == 'Windows' && secrets\.AZURE_CLIENT_SECRET \|\| '' \}\}/u);
    assert.match(workflow, /unset CSC_LINK CSC_KEY_PASSWORD/u);
    // The Windows branch is its own arm.
    assert.match(workflow, /elif \[ "\$RUNNER_OS" = "Windows" \]; then/u);
    // Azure Trusted Signing has no opportunistic-cert fallback, so the full
    // service principal's absence must force it off via CLI override rather
    // than let electron-builder fail the build outright. Gated on all three
    // secrets, not just AZURE_TENANT_ID, so a partially-configured principal
    // doesn't get mislabeled as signed.
    const azureGate = 'if [ -n "$AZURE_TENANT_ID" ] && [ -n "$AZURE_CLIENT_ID" ] && [ -n "$AZURE_CLIENT_SECRET" ]; then';
    assert.strictEqual(workflow.split(azureGate).length - 1, 2);
    // The override is applied to a direct electron-builder invocation, not
    // routed through the compound package:win:* npm script -- `npm run x --
    // args` appends args to the whole script rather than the electron-builder
    // call inside it.
    assert.match(workflow, /npx --no-install electron-builder --publish never --win --"\$WIN_ARCH" \\\s+-c\.win\.azureSignOptions=null/u);
    // Signature verification is guarded by secret presence and targets the
    // arch-qualified installer(s). Get-AuthenticodeSignature, not signtool.exe
    // -- the latter ships with the Windows SDK but isn't on windows-latest's
    // PATH, while Get-AuthenticodeSignature is a builtin PowerShell cmdlet.
    assert.match(workflow, /for installer in release\/Overlook-\*-"\$WIN_ARCH"\.exe; do/u);
    assert.match(workflow, /Get-AuthenticodeSignature -FilePath '\$installer'/u);
    assert.match(workflow, /if \(\\\$sig\.Status -ne 'Valid'\) \{ exit 1 \}/u);
    assert.doesNotMatch(workflow, /signtool verify/u);
    // electron-builder.yml carries the Trusted Signing account coordinates,
    // never a local certificate.
    assert.match(builder, /azureSignOptions:/u);
    assert.match(builder, /publisherName:/u);
    assert.match(builder, /endpoint:/u);
    assert.match(builder, /codeSigningAccountName:/u);
    assert.match(builder, /certificateProfileName:/u);
    assert.doesNotMatch(builder, /signtoolOptions:/u);
    assert.doesNotMatch(builder, /certificateFile:/u);
    assert.doesNotMatch(builder, /certificatePassword:/u);
  });

  test('release asset labels use the Windows signing gate independently', () => {
    const release = source('.github/workflows/release.yml');
    assert.match(
      release,
      /WINDOWS_SIGNED: \$\{\{ secrets\.AZURE_TENANT_ID != '' && secrets\.AZURE_CLIENT_ID != '' && secrets\.AZURE_CLIENT_SECRET != '' \}\}/u,
    );
    assert.match(release, /if \[ "\$WINDOWS_SIGNED" = "true" \]; then status=signed; else status=unsigned; fi/u);
  });
});
