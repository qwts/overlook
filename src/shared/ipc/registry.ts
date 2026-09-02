import type { z } from 'zod';

import type { ChannelDefinition, EventDefinition } from './channels.js';

// Transport-agnostic wiring so the validation logic is unit-testable without
// Electron: preload passes ipcRenderer.invoke, main passes the handler, tests
// pass fakes. Both directions validate at the boundary — malformed traffic
// throws (rejects loudly) instead of crossing.

export type InvokeTransport = (channelName: string, request: unknown) => Promise<unknown>;

export type SubscribeTransport = (eventName: string, listener: (payload: unknown) => void) => () => void;

export const ipcFailureCodes = ['IPC_INVALID_REQUEST', 'IPC_HANDLER_FAILED', 'IPC_INVALID_RESPONSE'] as const;
export type IpcFailureCode = (typeof ipcFailureCodes)[number];

export interface IpcFailureEnvelope {
  readonly __overlookIpcFailure: true;
  readonly error: { readonly code: IpcFailureCode };
}

export interface HandlerErrorReport {
  readonly channelName: string;
  readonly code: IpcFailureCode;
  readonly error: unknown;
}

export interface HandlerOptions {
  readonly reportError?: (report: HandlerErrorReport) => void;
}

/** Renderer-safe rejection. The original main-process exception is never attached as a cause. */
export class IpcRemoteError extends Error {
  constructor(readonly code: IpcFailureCode) {
    super(code);
    this.name = 'IpcRemoteError';
  }
}

function isFailureCode(value: unknown): value is IpcFailureCode {
  return typeof value === 'string' && ipcFailureCodes.some((code) => code === value);
}

function isFailureEnvelope(value: unknown): value is IpcFailureEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as { __overlookIpcFailure?: unknown; error?: unknown };
  if (envelope.__overlookIpcFailure !== true || typeof envelope.error !== 'object' || envelope.error === null) return false;
  return isFailureCode((envelope.error as { code?: unknown }).code);
}

function failure(code: IpcFailureCode): IpcFailureEnvelope {
  return { __overlookIpcFailure: true, error: { code } };
}

function reportFailure(options: HandlerOptions, report: HandlerErrorReport): IpcFailureEnvelope {
  try {
    options.reportError?.(report);
  } catch {
    // Logging must never reopen the renderer boundary or replace the opaque response.
  }
  return failure(report.code);
}

/** Renderer-side (preload) invoker: validates the request before it leaves
 * and the response before the renderer sees it. */
export function createInvoker<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  channel: ChannelDefinition<TRequest, TResponse>,
  transport: InvokeTransport,
): (request: z.input<TRequest>) => Promise<z.output<TResponse>> {
  return async (request) => {
    const parsedRequest = channel.request.parse(request);
    const rawResponse = await transport(channel.name, parsedRequest);
    if (isFailureEnvelope(rawResponse)) throw new IpcRemoteError(rawResponse.error.code);
    return channel.response.parse(rawResponse);
  };
}

/** Main-side handler wrapper: validates both directions and converts every
 * failure into a detail-free transport envelope. Full detail stays main-side. */
/** The `ipcMain.handle` surface an IPC adapter registers on; tests hand in a map
 * so the adapter runs without Electron. */
export interface IpcHandlerRegistrar {
  readonly handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) => void;
}

export function wrapHandler<TRequest extends z.ZodType, TResponse extends z.ZodType>(
  channel: ChannelDefinition<TRequest, TResponse>,
  handler: (request: z.output<TRequest>) => Promise<z.output<TResponse>> | z.output<TResponse>,
  options: HandlerOptions = {},
): (rawRequest: unknown) => Promise<z.output<TResponse> | IpcFailureEnvelope> {
  return async (rawRequest) => {
    let request: z.output<TRequest>;
    try {
      request = channel.request.parse(rawRequest);
    } catch (error) {
      return reportFailure(options, { channelName: channel.name, code: 'IPC_INVALID_REQUEST', error });
    }

    let response: z.output<TResponse>;
    try {
      response = await handler(request);
    } catch (error) {
      return reportFailure(options, { channelName: channel.name, code: 'IPC_HANDLER_FAILED', error });
    }

    try {
      return channel.response.parse(response);
    } catch (error) {
      return reportFailure(options, { channelName: channel.name, code: 'IPC_INVALID_RESPONSE', error });
    }
  };
}

/** Main-side event emitter: validates the payload before it is pushed. */
export function createEmitter<TPayload extends z.ZodType>(
  event: EventDefinition<TPayload>,
  send: (eventName: string, payload: unknown) => void,
): (payload: z.input<TPayload>) => void {
  return (payload) => {
    send(event.name, event.payload.parse(payload));
  };
}

/** Renderer-side (preload) subscriber: validates each payload before the
 * listener sees it. Returns an unsubscribe function. */
export function createSubscriber<TPayload extends z.ZodType>(
  event: EventDefinition<TPayload>,
  subscribe: SubscribeTransport,
): (listener: (payload: z.output<TPayload>) => void) => () => void {
  return (listener) =>
    subscribe(event.name, (payload) => {
      listener(event.payload.parse(payload));
    });
}
