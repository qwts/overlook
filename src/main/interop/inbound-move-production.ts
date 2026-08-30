import { readFile } from 'node:fs/promises';

import { dialog } from 'electron';

import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { broadcast } from '../app-window.js';
import type { ImportRuntime } from '../import/import-runtime.js';
import type { LibraryParts } from '../library/library-parts.js';
import type { LiveLocalOpen } from '../../shared/interop/live-local-runtime.js';
import { InboundMoveController } from './inbound-move-controller.js';
import type { InboundMoveRuntime } from './inbound-move-runtime.js';
import { createInboundMoveRuntime } from './inbound-move-runtime-factory.js';
import type { LiveLocalJournalOperation, LiveLocalJournalSocket } from './live-local-journal-session.js';
import { LiveLocalSyncRuntime } from './live-local-sync-runtime.js';
import { LiveLocalObjectRepository } from './live-local-object-repository.js';
import { LiveLocalObjectStore } from './live-local-object-store.js';
import { createInteropProtocolRuntime, type InteropProtocolRuntime } from './protocol-runtime.js';
import { configuredInteropRuntime, getInteropPairing, getInteropRuntime } from './runtime.js';

interface ProductionOptions {
  readonly library: () => LibraryParts;
  readonly imports: () => ImportRuntime | undefined;
  readonly pairingFixture: () => string | undefined;
  readonly imported: () => void;
}

class ProductionInboundMove {
  #runtime: InboundMoveRuntime | undefined;
  #protocols: InteropProtocolRuntime | undefined;
  #controller: InboundMoveController | undefined;

  constructor(private readonly options: ProductionOptions) {}

  controller(): InboundMoveController {
    if (this.#controller !== undefined) return this.#controller;
    const pairing = getInteropPairing();
    const provider = configuredInteropRuntime()?.pcloud ?? {
      state: () => Promise.resolve({ provider: 'pcloud' as const, status: 'not-connected' as const, busy: false }),
      connect: () => Promise.resolve({ ok: false as const, reason: 'pCloud interoperability is unavailable in this build.' }),
      disconnect: () => ({ ok: false as const, reason: 'pCloud interoperability is unavailable in this build.' }),
    };
    const emitStatus = createEmitter(events.interopStatusChanged, (name, payload) =>
      broadcast((window) => window.webContents.send(name, payload)),
    );
    this.#controller = new InboundMoveController({
      pairing,
      provider,
      runtime: () => this.runtime(),
      pickPairingBundle: () => this.pickPairingBundle(),
      statusChanged: emitStatus,
    });
    return this.#controller;
  }

  async closeLibrary(): Promise<void> {
    await this.#controller?.shutdown();
    this.#runtime = undefined;
    this.#protocols = undefined;
  }

  private runtime(): InboundMoveRuntime {
    if (this.#runtime !== undefined) return this.#runtime;
    const library = this.options.library();
    const imports = this.options.imports();
    if (imports === undefined) throw new Error('Library import runtime is unavailable for inbound Move.');
    const authority = getInteropRuntime();
    this.#protocols ??= createInteropProtocolRuntime(library.db);
    this.#runtime = createInboundMoveRuntime({
      db: library.db,
      blobs: library.blobStore,
      blobsReady: library.blobStoreReady,
      currentKey: () => library.keyStore.currentKey(),
      resolveKey: library.keyStore.resolver(),
      thumbnails: imports.thumbnails,
      store: authority.pcloud.objectStore(),
      custody: () => authority.pairing.withUnlocked((custody) => custody),
      photoChanged: (photoId) => {
        broadcast((window) => window.webContents.send(events.libraryChanged.name, { photoIds: [photoId], membership: 'library' }));
        this.options.imported();
      },
      beginWork: () => {
        authority.workChanged(1);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          authority.workChanged(-1);
        };
      },
      protocols: this.#protocols,
    });
    return this.#runtime;
  }

  localOperation(store: LiveLocalObjectStore, operation: 'move' | 'sync', open: LiveLocalOpen): LiveLocalJournalOperation {
    const protocols = this.protocols();
    const custody = getInteropPairing().withUnlocked((value) => value);
    if (operation === 'sync') {
      if (open.review.operation !== 'sync') throw new Error('Live local Sync is missing its reviewed operation choices.');
      const sync = new LiveLocalSyncRuntime(protocols, store, custody, open.operationId, open.review);
      return {
        routes: protocols.routes,
        execute: async () => {
          await sync.receive();
          return { completed: false };
        },
        pause: () => sync.pause(),
        cancel: () => sync.cancel(),
      };
    }
    const runtime = this.createRuntime(store, () => () => undefined);
    const controller = new AbortController();
    let running: Promise<{ readonly completed: boolean }> | null = null;
    const stop = async () => {
      controller.abort();
      await running?.catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    };
    return {
      routes: protocols.routes,
      execute: () => {
        running ??= (async () => {
          const batch = (await runtime.refresh(controller.signal)).find((candidate) => candidate.transferId === open.operationId);
          if (batch === undefined) throw new Error('Live local Move did not publish the reviewed transfer.');
          await runtime.start(open.operationId, { signal: controller.signal });
          return { completed: true };
        })();
        return running;
      },
      pause: stop,
      cancel: stop,
    };
  }

  localStore(session: LiveLocalJournalSocket, operationId: string): LiveLocalObjectStore {
    return new LiveLocalObjectStore(session, new LiveLocalObjectRepository(this.options.library().db, operationId));
  }

  private protocols(): InteropProtocolRuntime {
    this.#protocols ??= createInteropProtocolRuntime(this.options.library().db);
    return this.#protocols;
  }

  private createRuntime(store: Parameters<typeof createInboundMoveRuntime>[0]['store'], beginWork: () => () => void): InboundMoveRuntime {
    const library = this.options.library();
    const imports = this.options.imports();
    if (imports === undefined) throw new Error('Library import runtime is unavailable for inbound Move.');
    return createInboundMoveRuntime({
      db: library.db,
      blobs: library.blobStore,
      blobsReady: library.blobStoreReady,
      currentKey: () => library.keyStore.currentKey(),
      resolveKey: library.keyStore.resolver(),
      thumbnails: imports.thumbnails,
      store,
      custody: () => getInteropPairing().withUnlocked((custody) => custody),
      photoChanged: (photoId) => {
        broadcast((window) => window.webContents.send(events.libraryChanged.name, { photoIds: [photoId], membership: 'library' }));
        this.options.imported();
      },
      beginWork,
      protocols: this.protocols(),
    });
  }

  private async pickPairingBundle(): Promise<unknown> {
    const fixture = this.options.pairingFixture();
    const selected =
      fixture === undefined || fixture === ''
        ? await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Interop pairing bundle', extensions: ['json'] }] })
        : null;
    const filePath = fixture === undefined || fixture === '' ? (selected?.canceled === false ? selected.filePaths[0] : undefined) : fixture;
    return filePath === undefined ? null : (JSON.parse(await readFile(filePath, 'utf8')) as unknown);
  }
}

let production: ProductionInboundMove | undefined;

export function configureProductionInboundMove(
  library: ProductionOptions['library'],
  imports: ProductionOptions['imports'],
  pairingFixture: ProductionOptions['pairingFixture'],
  imported: ProductionOptions['imported'],
): void {
  production ??= new ProductionInboundMove({ library, imports, pairingFixture, imported });
}

export function getProductionInboundMoveController(): InboundMoveController {
  if (production === undefined) throw new Error('Production inbound Move is not configured.');
  return production.controller();
}

export function createProductionLiveLocalOperation(
  store: LiveLocalObjectStore,
  operation: 'move' | 'sync',
  open: LiveLocalOpen,
): LiveLocalJournalOperation {
  if (production === undefined) throw new Error('Production interop library is not configured.');
  return production.localOperation(store, operation, open);
}

export function createProductionLiveLocalObjectStore(session: LiveLocalJournalSocket, operationId: string): LiveLocalObjectStore {
  if (production === undefined) throw new Error('Production interop library is not configured.');
  return production.localStore(session, operationId);
}

export async function closeProductionInboundMoveLibrary(): Promise<void> {
  await production?.closeLibrary();
}
