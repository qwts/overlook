import { ipcMain } from 'electron';

import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';
import { startLocalInbox, type LocalInbox } from './local-inbox.js';
import type { LocalTransferStatus } from '../../shared/ipc/local-transfer-channels.js';

export interface LocalTransferOptions {
  /** Feeds received originals to the standard import chain. */
  readonly importFiles: (paths: readonly string[]) => Promise<unknown>;
}

/**
 * Lifecycle for the loopback transfer inbox. Enabled explicitly from Settings;
 * the sync string exists only while enabled and is regenerated on every
 * enable, so a leaked string dies with the session that displayed it.
 */
export class LocalTransferRuntime {
  #inbox: LocalInbox | null = null;

  constructor(private readonly options: LocalTransferOptions) {}

  status(): LocalTransferStatus {
    return { enabled: this.#inbox !== null, syncString: this.#inbox?.syncString ?? null };
  }

  async enable(): Promise<LocalTransferStatus> {
    if (this.#inbox === null) {
      this.#inbox = await startLocalInbox({ importFiles: this.options.importFiles });
    }
    return this.status();
  }

  async disable(): Promise<LocalTransferStatus> {
    const inbox = this.#inbox;
    this.#inbox = null;
    if (inbox !== null) await inbox.close();
    return this.status();
  }

  async close(): Promise<void> {
    await this.disable();
  }
}

export function registerLocalTransferHandlers(runtime: LocalTransferRuntime, requireContentAccess: () => void): void {
  ipcMain.handle(channels.localTransferStatus.name, (_event, request: unknown) =>
    wrapHandler(channels.localTransferStatus, () => {
      requireContentAccess();
      return Promise.resolve(runtime.status());
    })(request),
  );
  ipcMain.handle(channels.localTransferEnable.name, (_event, request: unknown) =>
    wrapHandler(channels.localTransferEnable, () => {
      requireContentAccess();
      return runtime.enable();
    })(request),
  );
  ipcMain.handle(channels.localTransferDisable.name, (_event, request: unknown) =>
    wrapHandler(channels.localTransferDisable, () => {
      requireContentAccess();
      return runtime.disable();
    })(request),
  );
}
