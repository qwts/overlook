import { readFile } from 'node:fs/promises';

import { dialog } from 'electron';

import { events } from '../../shared/ipc/channels.js';
import { createEmitter } from '../../shared/ipc/registry.js';
import { broadcast } from '../app-window.js';
import type { ImportRuntime } from '../import/import-runtime.js';
import type { LibraryParts } from '../library/library-parts.js';
import { InboundMoveController } from './inbound-move-controller.js';
import type { InboundMoveRuntime } from './inbound-move-runtime.js';
import { createInboundMoveRuntime } from './inbound-move-runtime-factory.js';
import { createInteropProtocolRuntime, type InteropProtocolRuntime } from './protocol-runtime.js';
import { getInteropRuntime } from './runtime.js';

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
    const authority = getInteropRuntime();
    const emitStatus = createEmitter(events.interopStatusChanged, (name, payload) =>
      broadcast((window) => window.webContents.send(name, payload)),
    );
    this.#controller = new InboundMoveController({
      pairing: authority.pairing,
      provider: authority.pcloud,
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
        broadcast((window) => window.webContents.send(events.libraryChanged.name, { photoIds: [photoId] }));
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

export async function closeProductionInboundMoveLibrary(): Promise<void> {
  await production?.closeLibrary();
}
