import { z } from 'zod';

import { interopInboundStatusSchema } from '../interop/inbound-ui.js';
import { liveLocalRuntimeStateSchema } from '../interop/live-local-runtime.js';
import type { ChannelDefinition, EventDefinition } from './channels.js';

function defineChannel<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> {
  return { name, request, response };
}

const defineEvent = <TPayload extends z.ZodType>(name: string, payload: TPayload): EventDefinition<TPayload> => ({ name, payload });

export const interopChannels = {
  interopStatus: defineChannel('interop:status', z.object({}), interopInboundStatusSchema),
  interopLocalStatus: defineChannel('interop:local-status', z.object({}), liveLocalRuntimeStateSchema),
  interopProviderConnect: defineChannel(
    'interop:provider-connect',
    z.object({ provider: z.literal('pcloud') }),
    interopInboundStatusSchema,
  ),
  interopProviderDisconnect: defineChannel(
    'interop:provider-disconnect',
    z.object({ provider: z.literal('pcloud') }),
    interopInboundStatusSchema,
  ),
  interopPairingSelect: defineChannel('interop:pairing-select', z.object({}), interopInboundStatusSchema),
  interopPairingUnlock: defineChannel(
    'interop:pairing-unlock',
    z.object({ password: z.string().min(1).max(1024) }),
    interopInboundStatusSchema,
  ),
  interopRefresh: defineChannel('interop:refresh', z.object({}), interopInboundStatusSchema),
  interopStart: defineChannel('interop:start', z.object({ transferId: z.string().uuid() }), interopInboundStatusSchema),
  interopPause: defineChannel('interop:pause', z.object({}), interopInboundStatusSchema),
  interopResume: defineChannel('interop:resume', z.object({}), interopInboundStatusSchema),
  interopCancel: defineChannel('interop:cancel', z.object({}), interopInboundStatusSchema),
  interopRetry: defineChannel('interop:retry', z.object({}), interopInboundStatusSchema),
} as const;

export const interopEvents = {
  interopStatusChanged: defineEvent('interop:status-changed', interopInboundStatusSchema),
  interopLocalStatusChanged: defineEvent('interop:local-status-changed', liveLocalRuntimeStateSchema),
} as const;
