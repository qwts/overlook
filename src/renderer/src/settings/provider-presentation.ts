import type { ProviderDescriptor } from '../../../shared/backup/provider-descriptor.js';

export function resolveProviderTargetId(
  providers: readonly Pick<ProviderDescriptor, 'id'>[],
  persistedId: string | null,
  retainedId: string | null,
  preferredId: string | null,
  defaultId: string | null,
): string | null {
  // A preferred/retained target is an explicit disconnected selection. It
  // must outrank a persisted provider whose authorization may have expired;
  // a successful connection persists the same target, so the values converge.
  for (const candidate of [preferredId, retainedId, persistedId, defaultId]) {
    if (candidate !== null && providers.some((provider) => provider.id === candidate)) return candidate;
  }
  return null;
}
