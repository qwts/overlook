import type { ProviderDescriptor } from '../../../shared/backup/provider-descriptor.js';

export function resolveProviderTargetId(
  providers: readonly Pick<ProviderDescriptor, 'id'>[],
  persistedId: string | null,
  retainedId: string | null,
  preferredId: string | null,
  defaultId: string | null,
): string | null {
  for (const candidate of [persistedId, retainedId, preferredId, defaultId]) {
    if (candidate !== null && providers.some((provider) => provider.id === candidate)) return candidate;
  }
  return null;
}
