import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';

import { queryGet, runNamed } from '../db/sql.js';

const operationSchema = z.enum(['move', 'sync']);
const transportSchema = z.enum(['local-overlook', 'pcloud', 'google-drive', 'icloud']);
const stateSchema = z.enum(['connecting', 'connected', 'paused', 'completed', 'cancelled', 'failed']);
const timestampSchema = z.string().datetime();

interface RouteRow {
  operation_id: string;
  pairing_id: string;
  operation: string;
  transport: string;
  remote_session_id: string;
  scope_hash: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface StoredInteropTransportRoute {
  readonly operationId: string;
  readonly pairingId: string;
  readonly operation: 'move' | 'sync';
  readonly transport: 'local-overlook' | 'pcloud' | 'google-drive' | 'icloud';
  readonly remoteSessionId: string;
  readonly scopeHash: string;
  readonly state: 'connecting' | 'connected' | 'paused' | 'completed' | 'cancelled' | 'failed';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class LiveLocalRouteError extends Error {
  override readonly name = 'LiveLocalRouteError';
}

function hydrate(row: RouteRow): StoredInteropTransportRoute {
  return {
    operationId: z.string().uuid().parse(row.operation_id),
    pairingId: z.string().uuid().parse(row.pairing_id),
    operation: operationSchema.parse(row.operation),
    transport: transportSchema.parse(row.transport),
    remoteSessionId: z.string().uuid().parse(row.remote_session_id),
    scopeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(row.scope_hash),
    state: stateSchema.parse(row.state),
    createdAt: timestampSchema.parse(row.created_at),
    updatedAt: timestampSchema.parse(row.updated_at),
  };
}

export class LiveLocalRouteRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(operationId: string): StoredInteropTransportRoute | undefined {
    const row = queryGet<RouteRow>(this.db, 'SELECT * FROM interop_transport_routes WHERE operation_id = ?', operationId);
    return row === undefined ? undefined : hydrate(row);
  }

  open(input: {
    readonly operationId: string;
    readonly pairingId: string;
    readonly operation: 'move' | 'sync';
    readonly remoteSessionId: string;
    readonly scopeHash: string;
    readonly at: string;
  }): StoredInteropTransportRoute {
    const parsed = {
      operationId: z.string().uuid().parse(input.operationId),
      pairingId: z.string().uuid().parse(input.pairingId),
      operation: operationSchema.parse(input.operation),
      remoteSessionId: z.string().uuid().parse(input.remoteSessionId),
      scopeHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(input.scopeHash),
      at: timestampSchema.parse(input.at),
    };
    const existing = this.get(parsed.operationId);
    if (existing !== undefined) {
      if (
        existing.pairingId !== parsed.pairingId ||
        existing.operation !== parsed.operation ||
        existing.remoteSessionId !== parsed.remoteSessionId ||
        existing.scopeHash !== parsed.scopeHash
      ) {
        throw new LiveLocalRouteError('Local route resume did not match the reviewed operation identity.');
      }
      if (existing.transport !== 'local-overlook') {
        throw new LiveLocalRouteError('Operation is assigned to a different reviewed transport.');
      }
      if (existing.state === 'completed' || existing.state === 'cancelled') return existing;
    }
    runNamed(
      this.db,
      `INSERT INTO interop_transport_routes (
         operation_id, pairing_id, operation, transport, remote_session_id, scope_hash, state, created_at, updated_at
       ) VALUES (
         @operationId, @pairingId, @operation, 'local-overlook', @remoteSessionId, @scopeHash, 'connected', @at, @at
       )
       ON CONFLICT (operation_id) DO UPDATE SET state = 'connected', updated_at = excluded.updated_at`,
      parsed,
    );
    return this.require(parsed.operationId);
  }

  setState(
    operationId: string,
    state: 'connected' | 'paused' | 'completed' | 'cancelled' | 'failed',
    atInput: string,
  ): StoredInteropTransportRoute {
    const at = timestampSchema.parse(atInput);
    const existing = this.require(operationId);
    if (existing.state === 'completed' || existing.state === 'cancelled') return existing;
    runNamed(this.db, 'UPDATE interop_transport_routes SET state = @state, updated_at = @at WHERE operation_id = @operationId', {
      operationId,
      state: stateSchema.parse(state),
      at,
    });
    return this.require(operationId);
  }

  changeTransport(
    operationId: string,
    transport: Exclude<StoredInteropTransportRoute['transport'], 'local-overlook'>,
    reviewedScopeHash: string,
    atInput: string,
  ): StoredInteropTransportRoute {
    const existing = this.require(operationId);
    if (existing.state !== 'paused') throw new LiveLocalRouteError('Transport changes require a paused operation.');
    if (existing.scopeHash !== reviewedScopeHash) throw new LiveLocalRouteError('Transport change altered the reviewed scope.');
    const at = timestampSchema.parse(atInput);
    runNamed(
      this.db,
      `UPDATE interop_transport_routes
       SET transport = @transport, state = 'connecting', updated_at = @at
       WHERE operation_id = @operationId`,
      { operationId, transport: transportSchema.exclude(['local-overlook']).parse(transport), at },
    );
    return this.require(operationId);
  }

  private require(operationId: string): StoredInteropTransportRoute {
    const route = this.get(z.string().uuid().parse(operationId));
    if (route === undefined) throw new LiveLocalRouteError('Interop transport route does not exist.');
    return route;
  }
}
