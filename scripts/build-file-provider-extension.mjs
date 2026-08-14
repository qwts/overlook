import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const EXTENSION_NAME = 'OverlookFileProvider';

export function buildFileProviderExtension(appOutDir, productName = 'Overlook', version = '1.0.0', buildVersion = version) {
  const profile = process.env['OVERLOOK_FILE_PROVIDER_PROVISIONING_PROFILE'];
  if (profile === undefined || profile === '') return null;
  const mainProfile = process.env['OVERLOOK_MAC_PROVISIONING_PROFILE'];
  if (mainProfile === undefined || mainProfile === '') throw new Error('OVERLOOK_MAC_PROVISIONING_PROFILE is required');
  const app = path.join(appOutDir, `${productName}.app`);
  const extension = path.join(app, 'Contents', 'PlugIns', `${EXTENSION_NAME}.appex`);
  const contents = path.join(extension, 'Contents');
  const executable = path.join(contents, 'MacOS', EXTENSION_NAME);
  const moduleCache = path.join(appOutDir, '.file-provider-modules');
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
      'FileProvider',
      '-framework',
      'Foundation',
      '-framework',
      'UniformTypeIdentifiers',
      '-o',
      executable,
      'native/file-provider-extension/OverlookFileProvider.m',
    ],
    { stdio: 'inherit' },
  );
  copyFileSync('native/file-provider-extension/Info.plist', path.join(contents, 'Info.plist'));
  execFileSync('plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, path.join(contents, 'Info.plist')]);
  execFileSync('plutil', ['-replace', 'CFBundleVersion', '-string', buildVersion, path.join(contents, 'Info.plist')]);
  copyFileSync(profile, path.join(contents, 'embedded.provisionprofile'));
  copyFileSync(mainProfile, path.join(app, 'Contents', 'embedded.provisionprofile'));
  execFileSync('plutil', ['-replace', 'ElectronTeamID', '-string', 'Z5DM34QS5U', path.join(app, 'Contents', 'Info.plist')]);
  rmSync(moduleCache, { recursive: true, force: true });
  return extension;
}
