import { execFileSync } from 'node:child_process';

function commandText(run, file, args, options) {
  return String(run(file, args, { ...options, encoding: 'utf8' })).trim();
}

function authorizesIdentifier(authorized, expected) {
  if (authorized === expected) return true;
  if (typeof authorized !== 'string' || !authorized.endsWith('*')) return false;
  const prefix = authorized.slice(0, -1);
  return prefix.endsWith('.') && expected.length > prefix.length && expected.startsWith(prefix);
}

export function readProvisioningProfile(profilePath, run = execFileSync) {
  const plist = run('security', ['cms', '-D', '-i', profilePath]);
  const extracted = (key, format) =>
    commandText(run, 'plutil', ['-extract', key, format, '-o', '-', '-'], {
      input: plist,
    });

  return {
    entitlements: JSON.parse(extracted('Entitlements', 'json')),
    teams: JSON.parse(extracted('TeamIdentifier', 'json')),
    expiresAt: Date.parse(extracted('ExpirationDate', 'raw')),
  };
}

export function validateProvisioningProfile(metadata, expected, now = Date.now()) {
  if (metadata.entitlements?.['com.apple.application-identifier'] !== expected.applicationId) {
    throw new Error(`profile does not authorize application identifier ${expected.applicationId}`);
  }
  if (metadata.entitlements?.['com.apple.developer.team-identifier'] !== expected.teamId) {
    throw new Error(`profile does not authorize team ${expected.teamId}`);
  }
  if (!Array.isArray(metadata.teams) || !metadata.teams.includes(expected.teamId)) {
    throw new Error(`profile TeamIdentifier does not contain ${expected.teamId}`);
  }
  if (expected.iCloudContainerId !== undefined) {
    const iCloudContainers = metadata.entitlements?.['com.apple.developer.icloud-container-identifiers'];
    if (
      !Array.isArray(iCloudContainers) ||
      !iCloudContainers.some((authorized) => authorizesIdentifier(authorized, expected.iCloudContainerId))
    ) {
      throw new Error(`profile does not authorize iCloud container ${expected.iCloudContainerId}`);
    }
  }
  if (expected.ubiquityContainerId !== undefined) {
    const ubiquityContainers = metadata.entitlements?.['com.apple.developer.ubiquity-container-identifiers'];
    const services = metadata.entitlements?.['com.apple.developer.icloud-services'];
    if (
      !Array.isArray(ubiquityContainers) ||
      !ubiquityContainers.some((authorized) => authorizesIdentifier(authorized, expected.ubiquityContainerId))
    ) {
      throw new Error(`profile does not authorize ubiquity container ${expected.ubiquityContainerId}`);
    }
    if (services !== '*' && (!Array.isArray(services) || !services.includes('CloudDocuments'))) {
      throw new Error('profile does not authorize iCloud Documents');
    }
  }
  if (expected.appGroupId !== undefined) {
    const groups = metadata.entitlements?.['com.apple.security.application-groups'];
    if (!Array.isArray(groups) || !groups.some((authorized) => authorizesIdentifier(authorized, expected.appGroupId))) {
      throw new Error(`profile does not authorize app group ${expected.appGroupId}`);
    }
  }
  if (!Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= now) {
    throw new Error('provisioning profile is expired or has no valid expiry');
  }
}
