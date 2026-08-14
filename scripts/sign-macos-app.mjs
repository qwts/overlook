import { existsSync } from 'node:fs';
import path from 'node:path';

import { signAsync } from '@electron/osx-sign';

const EXTENSION_BUNDLE = `${path.sep}OverlookFileProvider.appex${path.sep}`;

function isFileProviderExtension(filePath) {
  return filePath.includes(EXTENSION_BUNDLE) || filePath.endsWith(`${path.sep}OverlookFileProvider.appex`);
}

export default async function signMacApp(configuration) {
  const inherited = configuration.optionsForFile;
  const inheritedIgnore = configuration.ignore;
  const extension = path.join(configuration.app, 'Contents', 'PlugIns', 'OverlookFileProvider.appex');
  const hasExtension = existsSync(extension);
  const binaries = hasExtension ? [...(configuration.binaries ?? []), extension] : configuration.binaries;
  await signAsync({
    ...configuration,
    binaries,
    // Profiles are embedded and validated by our provisioned packaging path.
    // osx-sign has only one profile input and would otherwise apply the main
    // app profile while auto-processing the separately identified extension.
    ...(hasExtension ? { provisioningProfile: undefined, preEmbedProvisioningProfile: false, preAutoEntitlements: false } : {}),
    // electron-builder skips Contents/PlugIns by default. This extension is
    // built by our afterPack hook, so opt only its reviewed bundle back in.
    ignore: (filePath) => (isFileProviderExtension(filePath) ? false : (inheritedIgnore?.(filePath) ?? false)),
    optionsForFile: (filePath) => {
      const defaults = inherited?.(filePath) ?? {};
      return isFileProviderExtension(filePath)
        ? { ...defaults, entitlements: path.resolve('native/file-provider-extension/entitlements.plist') }
        : defaults;
    },
  });
}
