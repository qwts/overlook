import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { z } from 'zod';

import { queryAll, queryGet, runNamed } from '../db/sql.js';
import {
  interopConflictActionSchema,
  interopProductSchema,
  interopRevisionVectorSchema,
  type InteropConflictAction,
  type InteropProduct,
} from '../../shared/interop/contract.js';
import { interopEnvelopeSchema, type InteropEnvelope } from '../../shared/interop/messages.js';
import { interopRecordSchema, type InteropRecord } from '../../shared/interop/records.js';
import { SYNC_FIELDS, type SyncAnalysis, type SyncField } from '../../shared/interop/sync-resolution.js';

const timestampSchema = z.string().datetime();
const directionSchema = z.enum(['image-trail-to-overlook', 'overlook-to-image-trail', 'two-way']);
const scopeSchema = z
  .object({
    kind: z.enum(['all', 'selected', 'album']),
    localIds: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (new Set(scope.localIds).size !== scope.localIds.length) {
      context.addIssue({ code: 'custom', message: 'Sync scope ids must be unique.' });
    }
    const validCount =
      (scope.kind === 'all' && scope.localIds.length === 0) ||
      (scope.kind === 'selected' && scope.localIds.length > 0) ||
      (scope.kind === 'album' && scope.localIds.length === 1);
    if (!validCount) context.addIssue({ code: 'custom', message: 'Sync scope ids do not match the selected scope kind.' });
  });
const sessionPhaseSchema = z.enum(['reviewing', 'transferring', 'paused', 'completed', 'cancelled', 'failed']);
const itemStateSchema = z.enum(['eligible', 'duplicate', 'conflict', 'delete-review', 'ready', 'applied', 'skipped', 'failed']);
const deleteDecisionSchema = z.enum(['apply', 'keep']);
const conflictSchema = z
  .object({
    field: z.enum(SYNC_FIELDS),
    imageTrailRevision: interopRevisionVectorSchema,
    overlookRevision: interopRevisionVectorSchema,
  })
  .strict();
const analysisSchema = z
  .object({
    category: z.enum(['eligible', 'duplicate', 'conflict', 'delete-review']),
    merged: interopRecordSchema,
    conflicts: z.array(conflictSchema).readonly(),
  })
  .strict();
const decisionsSchema = z.record(z.string(), interopConflictActionSchema);

export type SyncDirection = z.output<typeof directionSchema>;
export type SyncScope = z.output<typeof scopeSchema>;
export type SyncSessionPhase = z.output<typeof sessionPhaseSchema>;
export type SyncItemState = z.output<typeof itemStateSchema>;
export type SyncDeleteDecision = z.output<typeof deleteDecisionSchema>;

interface SessionRow {
  session_id: string;
  pairing_id: string;
  source_product: string;
  target_product: string;
  direction: string;
  scope_json: string;
  phase: string;
  connected: number;
  image_trail_checkpoint: number;
  overlook_checkpoint: number;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  session_id: string;
  interop_id: string;
  image_trail_record_json: string | null;
  overlook_record_json: string | null;
  analysis_json: string;
  decisions_json: string;
  delete_decision: string | null;
  state: string;
  error_json: string | null;
  received_at: string;
  applied_at: string | null;
}

interface ReceiptRow {
  session_id: string;
  interop_id: string;
  envelope_json: string;
}

interface AuditRow {
  event_key: string;
  session_id: string;
  interop_id: string | null;
  event: string;
  details_json: string;
  created_at: string;
}

export interface StoredSyncSession {
  readonly sessionId: string;
  readonly pairingId: string;
  readonly sourceProduct: InteropProduct;
  readonly targetProduct: InteropProduct;
  readonly direction: SyncDirection;
  readonly scope: SyncScope;
  readonly phase: SyncSessionPhase;
  readonly connected: boolean;
  readonly checkpoints: Readonly<Record<InteropProduct, number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredSyncItem {
  readonly sessionId: string;
  readonly interopId: string;
  readonly imageTrailRecord: InteropRecord | null;
  readonly overlookRecord: InteropRecord | null;
  readonly analysis: SyncAnalysis;
  readonly decisions: Readonly<Partial<Record<SyncField, InteropConflictAction>>>;
  readonly deleteDecision: SyncDeleteDecision | null;
  readonly state: SyncItemState;
  readonly error: unknown;
  readonly receivedAt: string;
  readonly appliedAt: string | null;
}

export interface SyncProgressCounts {
  total: number;
  eligible: number;
  duplicate: number;
  conflict: number;
  deleteReview: number;
  ready: number;
  applied: number;
  skipped: number;
  failed: number;
}

export interface StoredSyncAuditEvent {
  readonly eventKey: string;
  readonly sessionId: string;
  readonly interopId: string | null;
  readonly event: string;
  readonly details: unknown;
  readonly createdAt: string;
}

export class SyncRepositoryError extends Error {
  override readonly name = 'SyncRepositoryError';
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new SyncRepositoryError('Stored Sync journal JSON is corrupt.');
  }
}

function parseRecord(value: string | null): InteropRecord | null {
  return value === null ? null : interopRecordSchema.parse(parseJson(value));
}

function parseDecisions(value: string): Readonly<Partial<Record<SyncField, InteropConflictAction>>> {
  const parsed = decisionsSchema.parse(parseJson(value));
  for (const field of Object.keys(parsed)) {
    if (!(SYNC_FIELDS as readonly string[]).includes(field)) throw new SyncRepositoryError(`Unknown Sync field ${field}.`);
  }
  return parsed;
}

function hydrateSession(row: SessionRow): StoredSyncSession {
  return {
    sessionId: z.string().uuid().parse(row.session_id),
    pairingId: z.string().uuid().parse(row.pairing_id),
    sourceProduct: interopProductSchema.parse(row.source_product),
    targetProduct: interopProductSchema.parse(row.target_product),
    direction: directionSchema.parse(row.direction),
    scope: scopeSchema.parse(parseJson(row.scope_json)),
    phase: sessionPhaseSchema.parse(row.phase),
    connected: row.connected === 1,
    checkpoints: { 'image-trail': row.image_trail_checkpoint, overlook: row.overlook_checkpoint },
    createdAt: timestampSchema.parse(row.created_at),
    updatedAt: timestampSchema.parse(row.updated_at),
  };
}

function hydrateItem(row: ItemRow): StoredSyncItem {
  const imageTrailRecord = parseRecord(row.image_trail_record_json);
  const overlookRecord = parseRecord(row.overlook_record_json);
  const interopId = z.string().uuid().parse(row.interop_id);
  for (const record of [imageTrailRecord, overlookRecord]) {
    if (record !== null && record.identity.interopId !== interopId) {
      throw new SyncRepositoryError('Stored Sync item index does not match its canonical record.');
    }
  }
  return {
    sessionId: z.string().uuid().parse(row.session_id),
    interopId,
    imageTrailRecord,
    overlookRecord,
    analysis: analysisSchema.parse(parseJson(row.analysis_json)),
    decisions: parseDecisions(row.decisions_json),
    deleteDecision: row.delete_decision === null ? null : deleteDecisionSchema.parse(row.delete_decision),
    state: itemStateSchema.parse(row.state),
    error: row.error_json === null ? null : parseJson(row.error_json),
    receivedAt: timestampSchema.parse(row.received_at),
    appliedAt: row.applied_at === null ? null : timestampSchema.parse(row.applied_at),
  };
}

function emptyCounts(): SyncProgressCounts {
  return { total: 0, eligible: 0, duplicate: 0, conflict: 0, deleteReview: 0, ready: 0, applied: 0, skipped: 0, failed: 0 };
}

function hasTombstone(item: StoredSyncItem): boolean {
  return (
    (item.imageTrailRecord !== null && item.imageTrailRecord.deletedAt !== null) ||
    (item.overlookRecord !== null && item.overlookRecord.deletedAt !== null)
  );
}

export class SyncRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  createSession(input: {
    readonly sessionId: string;
    readonly pairingId: string;
    readonly sourceProduct: InteropProduct;
    readonly targetProduct: InteropProduct;
    readonly direction: SyncDirection;
    readonly scope: SyncScope;
    readonly at: string;
  }): StoredSyncSession {
    const at = timestampSchema.parse(input.at);
    const scope = scopeSchema.parse(input.scope);
    if (input.sourceProduct === input.targetProduct) throw new SyncRepositoryError('Sync source and target products must differ.');
    if (
      (input.direction === 'image-trail-to-overlook' && (input.sourceProduct !== 'image-trail' || input.targetProduct !== 'overlook')) ||
      (input.direction === 'overlook-to-image-trail' && (input.sourceProduct !== 'overlook' || input.targetProduct !== 'image-trail'))
    ) {
      throw new SyncRepositoryError('Sync direction does not match the selected source and target products.');
    }
    runNamed(
      this.db,
      `INSERT OR IGNORE INTO interop_sync_sessions (
         session_id, pairing_id, source_product, target_product, direction, scope_json, phase, created_at, updated_at
       ) VALUES (
         @sessionId, @pairingId, @sourceProduct, @targetProduct, @direction, @scopeJson, 'reviewing', @at, @at
       )`,
      {
        ...input,
        sessionId: z.string().uuid().parse(input.sessionId),
        pairingId: z.string().uuid().parse(input.pairingId),
        sourceProduct: interopProductSchema.parse(input.sourceProduct),
        targetProduct: interopProductSchema.parse(input.targetProduct),
        direction: directionSchema.parse(input.direction),
        scopeJson: JSON.stringify(scope),
        at,
      },
    );
    const session = this.requireSession(input.sessionId);
    if (
      session.pairingId !== input.pairingId ||
      session.sourceProduct !== input.sourceProduct ||
      session.targetProduct !== input.targetProduct ||
      session.direction !== input.direction ||
      JSON.stringify(session.scope) !== JSON.stringify(scope)
    ) {
      throw new SyncRepositoryError('Sync session identity was reused with different first-run choices.');
    }
    this.auditEvent(`${input.sessionId}:started`, input.sessionId, null, 'started', { direction: input.direction, scope }, at);
    return session;
  }

  getSession(sessionId: string): StoredSyncSession | undefined {
    const row = queryGet<SessionRow>(this.db, 'SELECT * FROM interop_sync_sessions WHERE session_id = ?', sessionId);
    return row === undefined ? undefined : hydrateSession(row);
  }

  activeSession(sessionId: string): StoredSyncSession {
    return this.requireActiveSession(sessionId);
  }

  putItem(input: {
    readonly sessionId: string;
    readonly imageTrailRecord: InteropRecord | null;
    readonly overlookRecord: InteropRecord | null;
    readonly analysis: SyncAnalysis;
    readonly at: string;
  }): StoredSyncItem {
    const session = this.requireActiveSession(input.sessionId);
    const at = timestampSchema.parse(input.at);
    const analysis = analysisSchema.parse(input.analysis);
    const interopId = analysis.merged.identity.interopId;
    runNamed(
      this.db,
      `INSERT INTO interop_sync_items (
         session_id, interop_id, image_trail_record_json, overlook_record_json,
         analysis_json, decisions_json, delete_decision, state, error_json, received_at, applied_at
       ) VALUES (
         @sessionId, @interopId, @imageTrailRecordJson, @overlookRecordJson,
         @analysisJson, '{}', NULL, @state, NULL, @at, NULL
       )
       ON CONFLICT (session_id, interop_id) DO UPDATE SET
         image_trail_record_json = excluded.image_trail_record_json,
         overlook_record_json = excluded.overlook_record_json,
         analysis_json = excluded.analysis_json,
         decisions_json = '{}',
         delete_decision = NULL,
         state = excluded.state,
         error_json = NULL,
         received_at = excluded.received_at,
         applied_at = NULL`,
      {
        sessionId: session.sessionId,
        interopId,
        imageTrailRecordJson: input.imageTrailRecord === null ? null : JSON.stringify(interopRecordSchema.parse(input.imageTrailRecord)),
        overlookRecordJson: input.overlookRecord === null ? null : JSON.stringify(interopRecordSchema.parse(input.overlookRecord)),
        analysisJson: JSON.stringify(analysis),
        state: analysis.category,
        at,
      },
    );
    this.auditEvent(
      `${input.sessionId}:${interopId}:received:${at}`,
      input.sessionId,
      interopId,
      'received',
      { category: analysis.category },
      at,
    );
    return this.requireItem(input.sessionId, interopId);
  }

  recordReceipt(sessionId: string, envelopeInput: InteropEnvelope, atInput: string): void {
    const envelope = interopEnvelopeSchema.parse(envelopeInput);
    const at = timestampSchema.parse(atInput);
    if (envelope.payload.kind !== 'record') throw new SyncRepositoryError('Sync receipts require a record envelope.');
    runNamed(
      this.db,
      `INSERT OR IGNORE INTO interop_sync_receipts (
         pairing_id, message_id, session_id, interop_id, envelope_json, received_at
       ) VALUES (@pairingId, @messageId, @sessionId, @interopId, @envelopeJson, @at)`,
      {
        pairingId: envelope.header.pairingId,
        messageId: envelope.header.messageId,
        sessionId,
        interopId: envelope.payload.record.identity.interopId,
        envelopeJson: JSON.stringify(envelope),
        at,
      },
    );
    const receipt = queryGet<ReceiptRow>(
      this.db,
      'SELECT session_id, interop_id, envelope_json FROM interop_sync_receipts WHERE pairing_id = ? AND message_id = ?',
      envelope.header.pairingId,
      envelope.header.messageId,
    );
    if (
      receipt === undefined ||
      receipt.session_id !== sessionId ||
      receipt.interop_id !== envelope.payload.record.identity.interopId ||
      receipt.envelope_json !== JSON.stringify(envelope)
    ) {
      throw new SyncRepositoryError('Sync message identity was replayed with different content.');
    }
  }

  itemForReceipt(pairingId: string, messageId: string, envelopeInput: InteropEnvelope): StoredSyncItem | undefined {
    const envelope = interopEnvelopeSchema.parse(envelopeInput);
    const receipt = queryGet<ReceiptRow>(
      this.db,
      'SELECT session_id, interop_id, envelope_json FROM interop_sync_receipts WHERE pairing_id = ? AND message_id = ?',
      pairingId,
      messageId,
    );
    if (receipt === undefined) return undefined;
    if (receipt.envelope_json !== JSON.stringify(envelope)) {
      throw new SyncRepositoryError('Sync message identity was replayed with different content.');
    }
    return this.requireItem(receipt.session_id, receipt.interop_id);
  }

  getItem(sessionId: string, interopId: string): StoredSyncItem | undefined {
    const row = queryGet<ItemRow>(
      this.db,
      'SELECT * FROM interop_sync_items WHERE session_id = ? AND interop_id = ?',
      sessionId,
      interopId,
    );
    return row === undefined ? undefined : hydrateItem(row);
  }

  items(sessionId: string): readonly StoredSyncItem[] {
    return queryAll<ItemRow>(this.db, 'SELECT * FROM interop_sync_items WHERE session_id = @sessionId ORDER BY interop_id', {
      sessionId,
    }).map(hydrateItem);
  }

  counts(sessionId: string): SyncProgressCounts {
    const counts = emptyCounts();
    for (const item of this.items(sessionId)) {
      counts.total += 1;
      if (item.state === 'delete-review') counts.deleteReview += 1;
      else counts[item.state] += 1;
    }
    return counts;
  }

  decide(
    sessionId: string,
    interopId: string,
    field: SyncField,
    action: InteropConflictAction,
    applyToAll: boolean,
    atInput: string,
  ): StoredSyncItem {
    this.requireActiveSession(sessionId);
    const item = this.requireItem(sessionId, interopId);
    if (item.state !== 'conflict') throw new SyncRepositoryError('Sync item is not awaiting conflict resolution.');
    const at = timestampSchema.parse(atInput);
    const conflictFields = item.analysis.conflicts.map((conflict) => conflict.field);
    if (!conflictFields.includes(field)) throw new SyncRepositoryError(`Sync field ${field} is not conflicted.`);
    const decisions = { ...item.decisions, [field]: interopConflictActionSchema.parse(action) };
    if (applyToAll) for (const conflictField of conflictFields) decisions[conflictField] = action;
    const ready = conflictFields.every((conflictField) => decisions[conflictField] !== undefined);
    runNamed(
      this.db,
      `UPDATE interop_sync_items SET decisions_json = @decisionsJson, state = @state
       WHERE session_id = @sessionId AND interop_id = @interopId`,
      {
        sessionId,
        interopId,
        decisionsJson: JSON.stringify(decisions),
        state: ready ? (hasTombstone(item) ? 'delete-review' : 'ready') : 'conflict',
      },
    );
    this.auditEvent(`${sessionId}:${interopId}:decision:${at}`, sessionId, interopId, 'decision', { field, action, applyToAll }, at);
    return this.requireItem(sessionId, interopId);
  }

  reviewDelete(sessionId: string, interopId: string, decisionInput: SyncDeleteDecision, atInput: string): StoredSyncItem {
    this.requireActiveSession(sessionId);
    const item = this.requireItem(sessionId, interopId);
    if (item.state !== 'delete-review') throw new SyncRepositoryError('Sync item is not awaiting delete review.');
    const decision = deleteDecisionSchema.parse(decisionInput);
    const at = timestampSchema.parse(atInput);
    runNamed(
      this.db,
      `UPDATE interop_sync_items SET delete_decision = @decision, state = @state
       WHERE session_id = @sessionId AND interop_id = @interopId`,
      { sessionId, interopId, decision, state: decision === 'apply' ? 'ready' : 'skipped' },
    );
    this.auditEvent(`${sessionId}:${interopId}:delete:${at}`, sessionId, interopId, 'delete-reviewed', { decision }, at);
    return this.requireItem(sessionId, interopId);
  }

  setControl(sessionId: string, action: 'pause' | 'resume' | 'cancel' | 'disconnect', atInput: string): StoredSyncSession {
    const session = this.requireSession(sessionId);
    if (action !== 'disconnect' && action !== 'resume' && !session.connected) {
      throw new SyncRepositoryError('Disconnected Sync sessions cannot resume or change state.');
    }
    if (session.phase === 'cancelled' && action !== 'disconnect') {
      throw new SyncRepositoryError('Cancelled Sync sessions cannot resume or change state.');
    }
    const at = timestampSchema.parse(atInput);
    const phase = action === 'pause' || action === 'disconnect' ? 'paused' : action === 'resume' ? 'reviewing' : 'cancelled';
    const connected = action === 'disconnect' ? 0 : 1;
    runNamed(
      this.db,
      `UPDATE interop_sync_sessions SET phase = @phase, connected = @connected, updated_at = @at WHERE session_id = @sessionId`,
      { sessionId, phase, connected, at },
    );
    const event = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : action === 'cancel' ? 'cancelled' : 'disconnected';
    this.auditEvent(`${sessionId}:${event}:${at}`, sessionId, null, event, {}, at);
    return this.requireSession(sessionId);
  }

  markApplied(sessionId: string, interopId: string, atInput: string): StoredSyncItem {
    const at = timestampSchema.parse(atInput);
    runNamed(
      this.db,
      `UPDATE interop_sync_items SET state = 'applied', error_json = NULL, applied_at = COALESCE(applied_at, @at)
       WHERE session_id = @sessionId AND interop_id = @interopId`,
      { sessionId, interopId, at },
    );
    this.auditEvent(`${sessionId}:${interopId}:applied`, sessionId, interopId, 'applied', {}, at);
    return this.requireItem(sessionId, interopId);
  }

  markFailed(sessionId: string, interopId: string, error: unknown, atInput: string): StoredSyncItem {
    const at = timestampSchema.parse(atInput);
    runNamed(
      this.db,
      `UPDATE interop_sync_items SET state = 'failed', error_json = @errorJson
       WHERE session_id = @sessionId AND interop_id = @interopId`,
      { sessionId, interopId, errorJson: JSON.stringify(error) },
    );
    this.auditEvent(`${sessionId}:${interopId}:failed:${at}`, sessionId, interopId, 'failed', error, at);
    return this.requireItem(sessionId, interopId);
  }

  changesAfter(sessionId: string, product: InteropProduct, checkpoint: number): readonly InteropRecord[] {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) throw new SyncRepositoryError('Sync checkpoint must be nonnegative.');
    return this.items(sessionId)
      .map((item) => (product === 'image-trail' ? item.imageTrailRecord : item.overlookRecord))
      .filter(
        (record): record is InteropRecord =>
          record !== null && record.revision[product === 'image-trail' ? 'imageTrail' : 'overlook'] > checkpoint,
      )
      .sort((left, right) => left.identity.interopId.localeCompare(right.identity.interopId));
  }

  advanceCheckpoint(sessionId: string, product: InteropProduct, checkpoint: number, atInput: string): StoredSyncSession {
    this.requireActiveSession(sessionId);
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) throw new SyncRepositoryError('Sync checkpoint must be nonnegative.');
    const at = timestampSchema.parse(atInput);
    const column = product === 'image-trail' ? 'image_trail_checkpoint' : 'overlook_checkpoint';
    this.db
      .prepare(`UPDATE interop_sync_sessions SET ${column} = max(${column}, @checkpoint), updated_at = @at WHERE session_id = @sessionId`)
      .run({
        sessionId,
        checkpoint,
        at,
      });
    this.auditEvent(`${sessionId}:checkpoint:${product}:${checkpoint}`, sessionId, null, 'checkpoint', { product, checkpoint }, at);
    return this.requireSession(sessionId);
  }

  audit(sessionId: string): readonly StoredSyncAuditEvent[] {
    return queryAll<AuditRow>(this.db, 'SELECT * FROM interop_sync_audit WHERE session_id = @sessionId ORDER BY created_at, event_key', {
      sessionId,
    }).map((row) => ({
      eventKey: row.event_key,
      sessionId: row.session_id,
      interopId: row.interop_id,
      event: row.event,
      details: parseJson(row.details_json),
      createdAt: timestampSchema.parse(row.created_at),
    }));
  }

  private requireSession(sessionId: string): StoredSyncSession {
    const session = this.getSession(sessionId);
    if (session === undefined) throw new SyncRepositoryError(`Sync session ${sessionId} does not exist.`);
    return session;
  }

  private requireActiveSession(sessionId: string): StoredSyncSession {
    const session = this.requireSession(sessionId);
    if (!session.connected || session.phase === 'cancelled') throw new SyncRepositoryError('Sync session is disconnected or cancelled.');
    if (session.phase === 'paused') throw new SyncRepositoryError('Sync session is paused.');
    return session;
  }

  private requireItem(sessionId: string, interopId: string): StoredSyncItem {
    const item = this.getItem(sessionId, interopId);
    if (item === undefined) throw new SyncRepositoryError('Sync item does not exist.');
    return item;
  }

  private auditEvent(eventKey: string, sessionId: string, interopId: string | null, event: string, details: unknown, at: string): void {
    runNamed(
      this.db,
      `INSERT OR IGNORE INTO interop_sync_audit (
         event_key, session_id, interop_id, event, details_json, created_at
       ) VALUES (@eventKey, @sessionId, @interopId, @event, @detailsJson, @at)`,
      { eventKey, sessionId, interopId, event, detailsJson: JSON.stringify(details), at },
    );
  }
}
