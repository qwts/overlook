#!/usr/bin/env node

// Generate THIRD-PARTY-NOTICES.md — the attribution file for every third-party
// package shipped in a packaged Overlook build (#461). Run it after dependency
// changes; CI's license-policy gate (#462) fails if the committed file drifts
// from what this would produce.
//
//   npm run licenses:notices        # regenerate the committed file
//   npm run licenses:notices -- --check   # exit non-zero if it is stale

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveShippedClosure } from './dependency-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_PATH = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const NODE_MODULES_PATH = path.join(ROOT, 'node_modules');

// License texts are read from installed packages, while the closure itself comes
// from the lockfile. That split is deliberate (see dependency-closure.mjs), but it
// means an absent or half-populated node_modules yields a closure whose every entry
// has licenseText === null — which renderNotices turns into the same
// "_No license text file was found_" note used for packages that genuinely ship
// none. The result is a notices file with an intact package table and no
// attribution at all, and --check then agrees with it because it re-renders from
// the same broken input.
//
// Observed healthy baseline: 68 of 72 non-conditional packages resolve a license
// text (the four that do not genuinely ship none). Broken resolves zero. The floor
// below sits far under the healthy rate so it cannot fire on a legitimate change in
// the dependency set.
const MIN_RESOLVED_FRACTION = 0.5;

export function assertLicenseTextsResolvable(closure) {
  if (!existsSync(NODE_MODULES_PATH)) {
    throw new Error(
      'node_modules is absent, so no license texts can be read. Generating now would ' +
        'produce a notices file with every attribution replaced by a "no license text" ' +
        'note. Run: npm install',
    );
  }

  const expected = closure.filter((pkg) => !pkg.conditional);
  if (expected.length === 0) {
    return;
  }
  const resolved = expected.filter((pkg) => pkg.licenseText);
  if (resolved.length / expected.length < MIN_RESOLVED_FRACTION) {
    throw new Error(
      `Only ${resolved.length} of ${expected.length} non-optional packages resolved a ` +
        'license text, which indicates an incomplete node_modules rather than packages ' +
        'that ship no license. Run: npm install',
    );
  }
}

const HEADER = `# Third-Party Notices

Overlook is distributed as a packaged desktop application that bundles the
third-party software listed below. This file is generated — do not edit it by
hand. Regenerate it with \`npm run licenses:notices\` after changing
dependencies.

The bundled Electron runtime additionally embeds Chromium, Node.js, and other
components; their full license texts ship inside the Electron distribution at
\`LICENSES.chromium.html\` and are incorporated here by reference.
`;

export function renderNotices(closure) {
  const summary = closure.map((pkg) => `| \`${pkg.name}\` | ${pkg.version} | ${pkg.license} |`).join('\n');

  const details = closure
    .map((pkg) => {
      const heading = `## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license}`;
      const body = pkg.licenseText
        ? `\n\n\`\`\`\n${pkg.licenseText}\n\`\`\``
        : pkg.conditional
          ? '\n\n_Optional/platform-specific package; its full license text ships alongside the binary in the build variant that bundles it._'
          : '\n\n_No license text file was found in the published package._';
      return `${heading}${body}`;
    })
    .join('\n\n---\n\n');

  return `${HEADER}
## Summary

| Package | Version | License |
| ------- | ------- | ------- |
${summary}

---

${details}
`;
}

export function currentNotices() {
  try {
    return readFileSync(NOTICES_PATH, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const closure = resolveShippedClosure();
  // Guard both paths: a broken environment must not be able to write a stripped
  // file, nor to certify one as current.
  assertLicenseTextsResolvable(closure);
  const rendered = renderNotices(closure);
  const check = process.argv.includes('--check');

  if (check) {
    if (currentNotices() !== rendered) {
      console.error(`THIRD-PARTY-NOTICES.md is stale (covers ${closure.length} packages). Run: npm run licenses:notices`);
      process.exit(1);
    }
    console.log(`THIRD-PARTY-NOTICES.md is up to date (${closure.length} packages).`);
    return;
  }

  writeFileSync(NOTICES_PATH, rendered);
  console.log(`Wrote THIRD-PARTY-NOTICES.md for ${closure.length} shipped packages.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
