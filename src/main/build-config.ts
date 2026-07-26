declare const __OVERLOOK_GOOGLE_DRIVE_CLIENT_ID__: string;
declare const __OVERLOOK_GOOGLE_DRIVE_CLIENT_SECRET__: string;
declare const __OVERLOOK_PCLOUD_ENABLED__: string;
declare const __OVERLOOK_PCLOUD_CLIENT_ID__: string;
declare const __OVERLOOK_IMAGE_TRAIL_EXTENSION_ID__: string;

const CHROMIUM_EXTENSION_ID = /^[a-p]{32}$/u;

/** OAuth desktop client IDs are public identifiers, not secrets. The build
 * embeds the owner-supplied ID; an empty build keeps Drive visible but
 * unavailable instead of reading a steerable runtime environment value. */
export function bundledGoogleDriveClientId(): string | null {
  const value = typeof __OVERLOOK_GOOGLE_DRIVE_CLIENT_ID__ === 'string' ? __OVERLOOK_GOOGLE_DRIVE_CLIENT_ID__.trim() : '';
  return value.endsWith('.apps.googleusercontent.com') ? value : null;
}

/** Some issued Google Desktop clients require their generated credential at
 * the token endpoint. Installed-app credentials are extractable metadata, not
 * a confidentiality boundary; keep this value main-process-only regardless. */
export function bundledGoogleDriveClientSecret(): string | null {
  const value = typeof __OVERLOOK_GOOGLE_DRIVE_CLIENT_SECRET__ === 'string' ? __OVERLOOK_GOOGLE_DRIVE_CLIENT_SECRET__.trim() : '';
  return value === '' ? null : value;
}

export interface PCloudFeatureConfig {
  readonly enabled: boolean;
  readonly clientId: string | null;
}

/** pCloud is disabled unless both the opt-in flag and a public OAuth client
 * ID are supplied. Unpackaged harness values override the bundled inputs;
 * packaged callers pass an env reader that always returns undefined. */
export function pcloudFeatureConfig(harnessEnv: (name: string) => string | undefined): PCloudFeatureConfig {
  const bundledEnabled = typeof __OVERLOOK_PCLOUD_ENABLED__ === 'string' ? __OVERLOOK_PCLOUD_ENABLED__.trim() : '';
  const bundledClientId = typeof __OVERLOOK_PCLOUD_CLIENT_ID__ === 'string' ? __OVERLOOK_PCLOUD_CLIENT_ID__.trim() : '';
  const requested = (harnessEnv('OVERLOOK_PCLOUD_ENABLED') ?? bundledEnabled) === '1';
  const clientId = (harnessEnv('OVERLOOK_PCLOUD_CLIENT_ID') ?? bundledClientId).trim();
  return requested && clientId !== '' ? { enabled: true, clientId } : { enabled: false, clientId: null };
}

/** Native messaging is registered only for an exact, build-owned Chromium
 * extension identity. Unpackaged harnesses may inject a deterministic ID;
 * packaged builds never read a steerable runtime environment value. */
export function imageTrailExtensionId(harnessEnv: (name: string) => string | undefined): string | null {
  const bundled = typeof __OVERLOOK_IMAGE_TRAIL_EXTENSION_ID__ === 'string' ? __OVERLOOK_IMAGE_TRAIL_EXTENSION_ID__.trim() : '';
  const value = (harnessEnv('OVERLOOK_IMAGE_TRAIL_EXTENSION_ID') ?? bundled).trim();
  return CHROMIUM_EXTENSION_ID.test(value) ? value : null;
}
