import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readProvisioningProfile, validateProvisioningProfile } from './provisioning-profile.mjs';

const TEAM_ID = 'Z5DM34QS5U';
const BUNDLE_ID = 'com.zts1.overlook';
const APPLICATION_ID = `${TEAM_ID}.${BUNDLE_ID}`;
const ICLOUD_CONTAINER_ID = `iCloud.${BUNDLE_ID}`;
const UBIQUITY_CONTAINER_ID = ICLOUD_CONTAINER_ID;
const FILE_PROVIDER_BUNDLE_ID = `${BUNDLE_ID}.file-provider`;
const FILE_PROVIDER_APPLICATION_ID = `${APPLICATION_ID}.file-provider`;
const FILE_PROVIDER_GROUP_ID = `${TEAM_ID}.${FILE_PROVIDER_BUNDLE_ID}`;
const BIOMETRIC_REASON = 'Unlock Overlook with Touch ID.';

function fail(message) {
  console.error(`[overlook] provisioned app verification failed: ${message}`);
  process.exit(1);
}

function plistValue(path, key) {
  try {
    return String(
      execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    ).trim();
  } catch {
    fail(`Info.plist key ${key} is missing or unreadable`);
  }
}

function signedEntitlements(path) {
  // macOS 15's default abstract display reads the active DER entitlement
  // representation. Do not force --xml: modern signatures need not carry a
  // usable legacy XML blob.
  const result = spawnSync('codesign', ['-d', '--entitlements', '-', path], { encoding: 'utf8' });
  if (result.error !== undefined) fail(`codesign could not inspect ${path}: ${result.error.message}`);
  if (result.status !== 0) fail(`codesign could not read entitlements for ${path}`);
  return result.stdout;
}

function stringEntitlement(source, key) {
  const marker = `[Key] ${key}`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const next = source.indexOf('\n\t[Key] ', start + marker.length);
  const block = source.slice(start, next < 0 ? undefined : next);
  return /\[String\] ([^\n]+)/u.exec(block)?.[1]?.trim() ?? null;
}

function containsEntitlement(source, key, value) {
  return source.includes(`[Key] ${key}`) && source.includes(`[String] ${value}`);
}

function verifySignature(path) {
  const result = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', path], { encoding: 'utf8' });
  if (result.error !== undefined) fail(`codesign could not verify ${path}: ${result.error.message}`);
  if (result.status !== 0) fail(`code signature is invalid for ${path}`);
}

if (process.platform !== 'darwin') fail('verification is supported only on macOS');
const argument = process.argv[2];
if (argument === undefined || argument === '') fail('pass the packaged .app path');
const appPath = resolve(argument);
if (!existsSync(appPath)) fail(`app does not exist: ${appPath}`);

const infoPath = join(appPath, 'Contents', 'Info.plist');
if (plistValue(infoPath, 'CFBundleIdentifier') !== BUNDLE_ID) fail(`Info.plist bundle identifier is not ${BUNDLE_ID}`);
if (plistValue(infoPath, 'NSFaceIDUsageDescription') !== BIOMETRIC_REASON) {
  fail('Info.plist biometric usage description is missing or unexpected');
}

const profilePath = join(appPath, 'Contents', 'embedded.provisionprofile');
if (!existsSync(profilePath)) fail('embedded.provisionprofile is missing');
try {
  const profile = readProvisioningProfile(profilePath);
  validateProvisioningProfile(profile, {
    applicationId: APPLICATION_ID,
    teamId: TEAM_ID,
    iCloudContainerId: ICLOUD_CONTAINER_ID,
    ubiquityContainerId: UBIQUITY_CONTAINER_ID,
    appGroupId: FILE_PROVIDER_GROUP_ID,
  });
} catch (error) {
  fail(`embedded profile is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
}

const mainEntitlements = signedEntitlements(appPath);
if (stringEntitlement(mainEntitlements, 'com.apple.application-identifier') !== APPLICATION_ID) {
  fail(`main executable lacks application identifier ${APPLICATION_ID}`);
}
if (stringEntitlement(mainEntitlements, 'com.apple.developer.team-identifier') !== TEAM_ID) {
  fail(`main executable lacks team identifier ${TEAM_ID}`);
}
const ubiquityKey = 'com.apple.developer.ubiquity-container-identifiers';
if (!mainEntitlements.includes(`[Key] ${ubiquityKey}`) || !mainEntitlements.includes(`[String] ${UBIQUITY_CONTAINER_ID}`)) {
  fail(`main executable lacks ${ubiquityKey} authorization for ${UBIQUITY_CONTAINER_ID}`);
}
const iCloudContainerKey = 'com.apple.developer.icloud-container-identifiers';
if (!mainEntitlements.includes(`[Key] ${iCloudContainerKey}`) || !mainEntitlements.includes(`[String] ${ICLOUD_CONTAINER_ID}`)) {
  fail(`main executable lacks ${iCloudContainerKey} authorization for ${ICLOUD_CONTAINER_ID}`);
}
if (!mainEntitlements.includes('[Key] com.apple.developer.icloud-services') || !mainEntitlements.includes('[String] CloudDocuments')) {
  fail('main executable lacks CloudDocuments authorization');
}
if (!containsEntitlement(mainEntitlements, 'com.apple.security.application-groups', FILE_PROVIDER_GROUP_ID)) {
  fail(`main executable lacks app group ${FILE_PROVIDER_GROUP_ID}`);
}

const extensionPath = join(appPath, 'Contents', 'PlugIns', 'OverlookFileProvider.appex');
if (!existsSync(extensionPath)) fail('OverlookFileProvider.appex is missing');
verifySignature(extensionPath);
const extensionInfoPath = join(extensionPath, 'Contents', 'Info.plist');
if (plistValue(extensionInfoPath, 'CFBundleIdentifier') !== FILE_PROVIDER_BUNDLE_ID) {
  fail(`File Provider bundle identifier is not ${FILE_PROVIDER_BUNDLE_ID}`);
}
const extensionProfilePath = join(extensionPath, 'Contents', 'embedded.provisionprofile');
if (!existsSync(extensionProfilePath)) fail('File Provider embedded.provisionprofile is missing');
try {
  const profile = readProvisioningProfile(extensionProfilePath);
  validateProvisioningProfile(profile, {
    applicationId: FILE_PROVIDER_APPLICATION_ID,
    teamId: TEAM_ID,
    appGroupId: FILE_PROVIDER_GROUP_ID,
  });
} catch (error) {
  fail(`File Provider embedded profile is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
}
const extensionEntitlements = signedEntitlements(extensionPath);
if (stringEntitlement(extensionEntitlements, 'com.apple.application-identifier') !== FILE_PROVIDER_APPLICATION_ID) {
  fail(`File Provider extension lacks application identifier ${FILE_PROVIDER_APPLICATION_ID}`);
}
if (stringEntitlement(extensionEntitlements, 'com.apple.developer.team-identifier') !== TEAM_ID) {
  fail(`File Provider extension lacks team identifier ${TEAM_ID}`);
}
if (!containsEntitlement(extensionEntitlements, 'com.apple.security.application-groups', FILE_PROVIDER_GROUP_ID)) {
  fail(`File Provider extension lacks app group ${FILE_PROVIDER_GROUP_ID}`);
}
for (const key of ['com.apple.security.app-sandbox', 'com.apple.security.network.client']) {
  if (!extensionEntitlements.includes(`[Key] ${key}`) || !extensionEntitlements.includes('[Bool] true')) {
    fail(`File Provider extension lacks ${key}`);
  }
}

const rendererHelper = join(appPath, 'Contents', 'Frameworks', 'Overlook Helper (Renderer).app');
const helperEntitlements = signedEntitlements(rendererHelper);
for (const key of [
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
  'com.apple.developer.icloud-container-identifiers',
  'com.apple.developer.icloud-services',
  'com.apple.developer.ubiquity-container-identifiers',
]) {
  if (stringEntitlement(helperEntitlements, key) !== null) fail(`renderer helper unexpectedly claims ${key}`);
}

console.log(`[overlook] provisioned app identity verified for ${APPLICATION_ID}`);
