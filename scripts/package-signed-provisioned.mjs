import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { readProvisioningProfile, validateProvisioningProfile } from './provisioning-profile.mjs';

const TEAM_ID = 'Z5DM34QS5U';
const APPLICATION_ID = `${TEAM_ID}.com.zts1.overlook`;
const EXTENSION_APPLICATION_ID = `${APPLICATION_ID}.file-provider`;
const ICLOUD_CONTAINER_ID = 'iCloud.com.zts1.overlook';
const APP_GROUP_ID = `${TEAM_ID}.com.zts1.overlook.file-provider`;
const profile = process.env['OVERLOOK_MAC_PROVISIONING_PROFILE'];
const extensionProfile = process.env['OVERLOOK_FILE_PROVIDER_PROVISIONING_PROFILE'];

function fail(message) {
  console.error(`[overlook] ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('provisioned signing is supported only on macOS');
if (profile === undefined || profile === '') fail('OVERLOOK_MAC_PROVISIONING_PROFILE is required');
if (extensionProfile === undefined || extensionProfile === '') fail('OVERLOOK_FILE_PROVIDER_PROVISIONING_PROFILE is required');

const profilePath = resolve(profile);
const extensionProfilePath = resolve(extensionProfile);
if (!existsSync(profilePath)) fail(`provisioning profile does not exist: ${profilePath}`);
if (!existsSync(extensionProfilePath)) fail(`File Provider provisioning profile does not exist: ${extensionProfilePath}`);

let metadata;
let extensionMetadata;
try {
  metadata = readProvisioningProfile(profilePath);
  extensionMetadata = readProvisioningProfile(extensionProfilePath);
} catch (error) {
  fail(`provisioning profile is malformed: ${error instanceof Error ? error.message : 'unknown error'}`);
}

try {
  validateProvisioningProfile(metadata, {
    applicationId: APPLICATION_ID,
    teamId: TEAM_ID,
    iCloudContainerId: ICLOUD_CONTAINER_ID,
    ubiquityContainerId: ICLOUD_CONTAINER_ID,
    appGroupId: APP_GROUP_ID,
  });
  validateProvisioningProfile(extensionMetadata, {
    applicationId: EXTENSION_APPLICATION_ID,
    teamId: TEAM_ID,
    appGroupId: APP_GROUP_ID,
  });
} catch (error) {
  fail(error instanceof Error ? error.message : 'provisioning profile validation failed');
}

if (process.argv.includes('--validate-only')) {
  console.log(
    `[overlook] provisioning profiles are valid for ${APPLICATION_ID} and ${EXTENSION_APPLICATION_ID} through ${new Date(
      Math.min(metadata.expiresAt, extensionMetadata.expiresAt),
    ).toISOString()}`,
  );
  process.exit(0);
}

const result = spawnSync(
  'electron-builder',
  ['--publish', 'never', '-c.mac.entitlements=build/entitlements.mac.provisioned.plist', `-c.mac.provisioningProfile=${profilePath}`],
  { stdio: 'inherit' },
);
if (result.error !== undefined) fail(`electron-builder failed to start: ${result.error.message}`);
process.exit(result.status ?? 1);
