import type { IpcHandlerRegistrar } from '../../src/shared/ipc/registry.js';

export interface FakeRegistrar {
  readonly registrar: IpcHandlerRegistrar;
  /** Invokes a registered channel the way the preload transport would. */
  readonly invoke: (channel: string, request: unknown) => Promise<unknown>;
  readonly channels: () => readonly string[];
}

/** The transport envelope wrapHandler answers with for a rejected request. */
export const INVALID_REQUEST = { __overlookIpcFailure: true, error: { code: 'IPC_INVALID_REQUEST' } };

/** Captures handlers the way `ipcMain.handle` would, so an IPC adapter runs
 * under plain Node — no Electron main process behind it. */
export function fakeRegistrar(): FakeRegistrar {
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
  return {
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    invoke: (channel, request) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
      return Promise.resolve(handler({}, request));
    },
    channels: () => [...handlers.keys()],
  };
}

/** Runs `body` with console.error captured: adapters log rejected requests main-side. */
export async function withQuietConsole(body: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  try {
    await body();
  } finally {
    console.error = original;
  }
  return logged;
}
