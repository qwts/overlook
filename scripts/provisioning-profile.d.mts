export interface ProvisioningProfileMetadata {
  readonly entitlements: Record<string, unknown>;
  readonly teams: unknown;
  readonly expiresAt: number;
}

export interface ExpectedProvisioningIdentity {
  readonly applicationId: string;
  readonly teamId: string;
  readonly iCloudContainerId?: string;
  readonly ubiquityContainerId?: string;
  readonly appGroupId?: string;
}

export type ProvisioningCommandRunner = (
  file: string,
  args: readonly string[],
  options?: { readonly input?: Buffer; readonly encoding?: 'utf8' },
) => Buffer | string;

export function readProvisioningProfile(profilePath: string, run?: ProvisioningCommandRunner): ProvisioningProfileMetadata;

export function validateProvisioningProfile(
  metadata: ProvisioningProfileMetadata,
  expected: ExpectedProvisioningIdentity,
  now?: number,
): void;
