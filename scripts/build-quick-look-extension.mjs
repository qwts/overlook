import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const EXTENSION_NAME = 'OverlookQuickLook';

export function buildQuickLookExtension(appOutDir, productName = 'Overlook', version = '1.0.0', buildVersion = version) {
  const app = path.join(appOutDir, `${productName}.app`);
  const extension = path.join(app, 'Contents', 'PlugIns', `${EXTENSION_NAME}.appex`);
  const contents = path.join(extension, 'Contents');
  const executable = path.join(contents, 'MacOS', EXTENSION_NAME);
  const moduleCache = path.join(appOutDir, '.quick-look-modules');
  rmSync(extension, { recursive: true, force: true });
  mkdirSync(path.dirname(executable), { recursive: true });
  execFileSync(
    'xcrun',
    [
      'clang',
      '-fobjc-arc',
      '-fmodules',
      `-fmodules-cache-path=${moduleCache}`,
      '-bundle',
      '-mmacosx-version-min=12.0',
      '-framework',
      'AppKit',
      '-framework',
      'QuickLookUI',
      '-o',
      executable,
      'native/quick-look-extension/OverlookQuickLook.m',
    ],
    { stdio: 'inherit' },
  );
  copyFileSync('native/quick-look-extension/Info.plist', path.join(contents, 'Info.plist'));
  execFileSync('plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, path.join(contents, 'Info.plist')]);
  execFileSync('plutil', ['-replace', 'CFBundleVersion', '-string', buildVersion, path.join(contents, 'Info.plist')]);
  rmSync(moduleCache, { recursive: true, force: true });
  return extension;
}
