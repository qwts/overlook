import { existsSync } from 'node:fs';
import path from 'node:path';

import { signAsync } from '@electron/osx-sign';

const EXTENSION_BUNDLE = `${path.sep}OverlookFileProvider.appex${path.sep}`;
const QUICK_LOOK_BUNDLE = `${path.sep}OverlookQuickLook.appex${path.sep}`;

function isFileProviderExtension(filePath) {
  return filePath.includes(EXTENSION_BUNDLE) || filePath.endsWith(`${path.sep}OverlookFileProvider.appex`);
}

function isQuickLookExtension(filePath) {
  return filePath.includes(QUICK_LOOK_BUNDLE) || filePath.endsWith(`${path.sep}OverlookQuickLook.appex`);
}

function extensionEntitlements(filePath) {
  if (isFileProviderExtension(filePath)) return path.resolve('native/file-provider-extension/entitlements.plist');
  if (isQuickLookExtension(filePath)) return path.resolve('native/quick-look-extension/entitlements.plist');
  return null;
}

export default async function signMacApp(configuration) {
  const inherited = configuration.optionsForFile;
  const inheritedIgnore = configuration.ignore;
  const extension = path.join(configuration.app, 'Contents', 'PlugIns', 'OverlookFileProvider.appex');
  const quickLook = path.join(configuration.app, 'Contents', 'PlugIns', 'OverlookQuickLook.appex');
  const nestedExtensions = [extension, quickLook].filter(existsSync);
  const binaries = nestedExtensions.length > 0 ? [...(configuration.binaries ?? []), ...nestedExtensions] : configuration.binaries;
  await signAsync({
    ...configuration,
    binaries,
    // Profiles are embedded and validated by our provisioned packaging path.
    // osx-sign has only one profile input and would otherwise apply the main
    // app profile while auto-processing the separately identified extension.
    ...(nestedExtensions.length > 0
      ? { provisioningProfile: undefined, preEmbedProvisioningProfile: false, preAutoEntitlements: false }
      : {}),
    // electron-builder skips Contents/PlugIns by default. These extensions
    // are built by our afterPack hook, so opt only their reviewed bundles in.
    ignore: (filePath) => (extensionEntitlements(filePath) !== null ? false : (inheritedIgnore?.(filePath) ?? false)),
    optionsForFile: (filePath) => {
      const defaults = inherited?.(filePath) ?? {};
      const entitlements = extensionEntitlements(filePath);
      return entitlements === null ? defaults : { ...defaults, entitlements };
    },
  });
}
