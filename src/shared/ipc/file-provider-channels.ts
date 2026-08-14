import { z } from 'zod';

import { FILE_PROVIDER_CONSENT_VERSION, fileProviderConfigSchema, fileProviderScopeSchema } from '../file-provider/contract.js';
import type { ChannelDefinition } from './channels.js';

function channel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const statusSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['unsupported-platform', 'unsigned-build', 'native-unavailable']).nullable(),
  config: fileProviderConfigSchema,
  albums: z.array(z.object({ id: z.string(), name: z.string(), count: z.number().int().nonnegative() })).readonly(),
});

export const fileProviderChannels = {
  fileProviderStatus: channel('file-provider:status', z.object({}), statusSchema),
  fileProviderEnable: channel(
    'file-provider:enable',
    z.object({ scope: fileProviderScopeSchema, consentVersion: z.literal(FILE_PROVIDER_CONSENT_VERSION) }),
    statusSchema,
  ),
  fileProviderDisable: channel('file-provider:disable', z.object({}), statusSchema),
} as const;
