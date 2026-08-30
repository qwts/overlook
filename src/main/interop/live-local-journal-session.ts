import {
  liveLocalControlSchema,
  liveLocalOpenSchema,
  type LiveLocalOpen,
  type LiveLocalRuntimeState,
} from '../../shared/interop/live-local-runtime.js';
import type { LiveLocalRedemption } from './live-local-security.js';
import type { LiveLocalWebSocketFrame } from './live-local-session.js';
import { LiveLocalObjectStore } from './live-local-object-store.js';
import type { LiveLocalRouteRepository } from './live-local-route-repository.js';
import { INTEROP_CHUNK_BYTES, INTEROP_CONTROL_FRAME_BYTES } from './transport.js';

export interface LiveLocalJournalOperation {
  readonly routes: LiveLocalRouteRepository;
  execute(): Promise<{ readonly completed: boolean }>;
  pause(): void;
  cancel(): void;
}

export interface LiveLocalJournalSocket {
  readonly redemption: LiveLocalRedemption;
  read(maxPayloadBytes: number): Promise<LiveLocalWebSocketFrame>;
  sendText(value: unknown): void;
  sendBinary(value: Buffer): void;
  sendPong(value: Buffer): void;
  close(code?: number): void;
}

export interface LiveLocalJournalSessionOptions {
  readonly createOperation: (input: {
    readonly open: LiveLocalOpen;
    readonly redemption: LiveLocalRedemption;
    readonly store: LiveLocalObjectStore;
  }) => LiveLocalJournalOperation;
  readonly now?: (() => string) | undefined;
  readonly stateChanged?: ((state: LiveLocalRuntimeState) => void) | undefined;
}

function parseText(payload: Buffer): unknown {
  return JSON.parse(payload.toString('utf8')) as unknown;
}

/** Routes an authenticated session into library-scoped durable journals. The
 * socket and its capability are never persisted; only the reviewed operation
 * and remote resume identity enter the library database. */
export class LiveLocalJournalSessionHandler {
  readonly #now: () => string;

  constructor(private readonly options: LiveLocalJournalSessionOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async handle(session: LiveLocalJournalSocket): Promise<void> {
    const first = await session.read(INTEROP_CONTROL_FRAME_BYTES);
    if (first.opcode !== 1) throw new Error('Live local journal session must begin with an open control frame.');
    const open = liveLocalOpenSchema.parse(parseText(first.payload));
    const store = new LiveLocalObjectStore(session);
    const operation = this.options.createOperation({ open, redemption: session.redemption, store });
    operation.routes.open({
      operationId: open.operationId,
      pairingId: session.redemption.pairingId,
      operation: session.redemption.operation,
      remoteSessionId: open.remoteSessionId,
      scopeHash: open.scopeHash,
      at: this.#now(),
    });
    this.publish('connected', session.redemption, open, false);
    session.sendText({ schemaVersion: 1, type: 'state', status: 'connected', operationId: open.operationId });
    let execution: Promise<void> | null = null;
    let terminal = false;
    try {
      for (;;) {
        const frame = await session.read(INTEROP_CHUNK_BYTES);
        if (frame.opcode === 9) {
          session.sendPong(frame.payload);
          continue;
        }
        if (frame.opcode === 8) return;
        if (frame.opcode === 2) {
          const acknowledged = store.receive(frame.payload);
          if (acknowledged !== null) session.sendText({ schemaVersion: 1, type: 'object-ack', ...acknowledged });
          continue;
        }
        if (frame.opcode !== 1) throw new Error('Live local journal session received an unsupported frame.');
        const control = liveLocalControlSchema.parse(parseText(frame.payload));
        if (control.type === 'heartbeat') {
          session.sendText({ schemaVersion: 1, type: 'heartbeat-ack' });
        } else if (control.type === 'object-ack') {
          store.acknowledge(control.path, control.sha256);
        } else if (control.type === 'cancel') {
          terminal = true;
          operation.cancel();
          operation.routes.setState(open.operationId, 'cancelled', this.#now());
          this.publish('paused', session.redemption, open, false);
          session.sendText({ schemaVersion: 1, type: 'state', status: 'paused', operationId: open.operationId });
          session.close();
          return;
        } else if (execution === null) {
          execution = operation
            .execute()
            .then((result) => {
              if (result.completed) {
                terminal = true;
                operation.routes.setState(open.operationId, 'completed', this.#now());
                this.options.stateChanged?.({
                  status: 'available',
                  operation: null,
                  operationId: null,
                  remoteSessionId: null,
                  retryable: false,
                });
              }
              session.sendText({
                schemaVersion: 1,
                type: 'operation-result',
                operationId: open.operationId,
                status: result.completed ? 'completed' : 'reviewing',
              });
            })
            .catch(() => {
              operation.routes.setState(open.operationId, 'failed', this.#now());
              this.publish('paused', session.redemption, open, true);
              session.sendText({ schemaVersion: 1, type: 'state', status: 'paused', operationId: open.operationId, retryable: true });
            });
        }
      }
    } finally {
      store.close();
      await execution?.catch(() => undefined);
      if (!terminal) {
        operation.pause();
        operation.routes.setState(open.operationId, 'paused', this.#now());
        this.publish('paused', session.redemption, open, true);
      }
    }
  }

  private publish(status: 'connected' | 'paused', redemption: LiveLocalRedemption, open: LiveLocalOpen, retryable: boolean): void {
    this.options.stateChanged?.({
      status,
      operation: redemption.operation,
      operationId: open.operationId,
      remoteSessionId: open.remoteSessionId,
      retryable,
    });
  }
}
