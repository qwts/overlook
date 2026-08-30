import type { InteropKeyCustody } from './pairing-custody.js';
import type { InteropProtocolRuntime } from './protocol-runtime.js';
import { openInteropMessage } from './sealed-transport.js';
import { EncryptedInteropTransport, type InteropObjectStore } from './transport.js';

const manifestSuffix = '.manifest.json';

function logicalPath(scopePrefix: string, providerPath: string): string | null {
  if (!providerPath.startsWith(scopePrefix) || !providerPath.endsWith(manifestSuffix)) return null;
  const path = providerPath.slice(scopePrefix.length, -manifestSuffix.length);
  return /^messages\/outbox\/[0-9]{12}-[0-9a-f-]{36}\.json\.aesgcm$/iu.test(path) ? path : null;
}

/** Receives canonical encrypted Sync record messages from a local object
 * session into an already-reviewed Sync journal. Decisions and applies remain
 * owned by the existing Sync service and renderer workflow. */
export class LiveLocalSyncRuntime {
  readonly #transport: EncryptedInteropTransport;

  constructor(
    private readonly protocols: InteropProtocolRuntime,
    private readonly store: InteropObjectStore,
    private readonly custody: InteropKeyCustody,
    private readonly sessionId: string,
  ) {
    this.#transport = new EncryptedInteropTransport(store);
  }

  async receive(): Promise<number> {
    const session = this.protocols.syncRepository.getSession(this.sessionId);
    if (session === undefined) throw new Error('Local Sync requires an existing reviewed durable session.');
    if (session.pairingId !== this.custody.pairingId) throw new Error('Local Sync session does not match pairing authority.');
    if (!session.connected || session.phase === 'paused') this.protocols.sync.resume(this.sessionId);
    const scope = { pairingId: this.custody.pairingId, transferId: this.sessionId };
    const prefix = `pairings/${scope.pairingId}/transfers/${scope.transferId}/objects/`;
    const paths: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.#transport.list(scope, cursor);
      for (const entry of page.entries) {
        const path = logicalPath(prefix, entry.path);
        if (path !== null) paths.push(path);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    let received = 0;
    for (const path of [...new Set(paths)].sort()) {
      const sealed = await this.#transport.download(scope, path);
      try {
        const envelope = openInteropMessage(sealed, this.custody);
        if (envelope.header.operation !== 'sync' || envelope.header.transferId !== this.sessionId || envelope.payload.kind !== 'record') {
          throw new Error('Live local Sync object is outside the reviewed session.');
        }
        const local = this.protocols.interop.getRecord(envelope.payload.record.identity.interopId)?.record ?? null;
        this.protocols.sync.receive(this.sessionId, envelope, local);
        received += 1;
      } finally {
        sealed.fill(0);
      }
    }
    return received;
  }

  pause(): void {
    const session = this.protocols.syncRepository.getSession(this.sessionId);
    if (session?.connected === true && session.phase !== 'completed' && session.phase !== 'cancelled') {
      this.protocols.sync.disconnect(this.sessionId);
    }
  }

  cancel(): void {
    const session = this.protocols.syncRepository.getSession(this.sessionId);
    if (session !== undefined && session.phase !== 'cancelled') this.protocols.sync.cancel(this.sessionId);
  }
}
