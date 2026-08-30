import { randomUUID } from 'node:crypto';

import type { InteropReviewCategory } from '../../shared/interop/contract.js';
import { interopEnvelopeSchema, type InteropCounts, type InteropEnvelope, type InteropError } from '../../shared/interop/messages.js';
import { moveAcknowledgementPath, moveOriginalBlobPath } from '../../shared/interop/sealed-transport-contract.js';
import { deterministicInboundPhotoId, type InboundAcceptance, type InboundPhotoImporter } from './inbound-photo-importer.js';
import {
  InboundMoveDiscovery,
  type DiscoveredMoveBlob,
  type DiscoveredMoveMessage,
  type DiscoveredMoveTransfer,
} from './inbound-move-discovery.js';
import type { InboundMoveObjectJournal, InboundObjectPhase } from './inbound-move-object-journal.js';
import type { MoveJournalRepository } from './move-journal-repository.js';
import type { InteropKeyCustody } from './pairing-custody.js';
import { openInteropBlob, openInteropMessage, sealInteropMessage } from './sealed-transport.js';
import type { InteropTranslationService } from './translation-service.js';
import { EncryptedInteropTransport, type InteropObjectStore } from './transport.js';

type RecordEnvelope = Omit<InteropEnvelope, 'payload'> & {
  readonly payload: Extract<InteropEnvelope['payload'], { readonly kind: 'record' }>;
};
type BlobEnvelope = Omit<InteropEnvelope, 'payload'> & {
  readonly payload: Extract<InteropEnvelope['payload'], { readonly kind: 'blob' }>;
};

export interface IncomingMoveItem {
  readonly request: RecordEnvelope;
  readonly recordMessage: DiscoveredMoveMessage;
  readonly blobMessage: DiscoveredMoveMessage | null;
  readonly blobEnvelope: BlobEnvelope | null;
  readonly original: DiscoveredMoveBlob | null;
  readonly reviewCategory: InteropReviewCategory;
  readonly acknowledged: boolean;
  readonly outcome: 'pending' | 'accepted' | 'retained' | 'failed';
  readonly reason: string | null;
}

export interface IncomingMoveBatch {
  readonly transferId: string;
  readonly items: readonly IncomingMoveItem[];
  readonly counts: InteropCounts;
}

export interface IncomingMoveRunResult {
  readonly transferId: string;
  readonly accepted: number;
  readonly retained: number;
  readonly changedPhotoIds: readonly string[];
}

export interface InboundMoveRunControl {
  readonly signal?: AbortSignal | undefined;
  readonly beforeItem?: ((item: IncomingMoveItem, index: number, total: number) => Promise<void> | void) | undefined;
  readonly itemCompleted?:
    ((item: IncomingMoveItem, acceptance: InboundAcceptance, index: number, total: number) => Promise<void> | void) | undefined;
}

export interface InboundMoveRuntimeOptions {
  readonly store: InteropObjectStore;
  readonly custody: () => InteropKeyCustody;
  readonly translation: Pick<InteropTranslationService, 'previewRecord'>;
  readonly importer: Pick<InboundPhotoImporter, 'acceptOriginal' | 'acceptWithoutOriginal'>;
  readonly journals: MoveJournalRepository;
  readonly objects: Pick<InboundMoveObjectJournal, 'discover' | 'advance' | 'require'>;
  readonly now?: (() => string) | undefined;
  readonly createMessageId?: (() => string) | undefined;
  readonly onPhotoChanged?: ((photoId: string) => void) | undefined;
  readonly beginWork?: (() => () => void) | undefined;
}

export class InboundMoveRuntimeError extends Error {
  override readonly name = 'InboundMoveRuntimeError';
}

function isRecord(envelope: InteropEnvelope): envelope is RecordEnvelope {
  return envelope.payload.kind === 'record';
}

function isBlob(envelope: InteropEnvelope): envelope is BlobEnvelope {
  return envelope.payload.kind === 'blob';
}

function sanitizedError(reason: string, recordInteropId: string, retryable = false): InteropError {
  return {
    code: retryable ? 'partial-failure' : 'unsupported-record',
    message: reason.slice(0, 240),
    retryable,
    recordInteropId,
  };
}

function storedErrorMessage(error: unknown): string | null {
  if (!Array.isArray(error)) return null;
  for (const candidate of error) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const message = (candidate as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message.slice(0, 240);
  }
  return null;
}

export class InboundMoveRuntime {
  readonly #discovery: InboundMoveDiscovery;
  readonly #transport: EncryptedInteropTransport;
  readonly #now: () => string;
  readonly #createMessageId: () => string;

  constructor(private readonly options: InboundMoveRuntimeOptions) {
    this.#discovery = new InboundMoveDiscovery(options.store);
    this.#transport = new EncryptedInteropTransport(options.store);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createMessageId = options.createMessageId ?? randomUUID;
  }

  async refresh(signal?: AbortSignal): Promise<readonly IncomingMoveBatch[]> {
    return this.withWork(async () => {
      signal?.throwIfAborted();
      const custody = this.options.custody();
      if ((await this.options.store.authState()) !== 'connected') {
        throw new InboundMoveRuntimeError('Connect the interoperability provider before checking for transfers.');
      }
      const transfers = await this.#discovery.discover(custody.pairingId);
      signal?.throwIfAborted();
      const batches: IncomingMoveBatch[] = [];
      for (const transfer of transfers) batches.push(await this.openTransfer(transfer, custody, signal));
      return batches;
    });
  }

  async start(transferId: string, control: InboundMoveRunControl = {}): Promise<IncomingMoveRunResult> {
    return this.withWork(async () => {
      control.signal?.throwIfAborted();
      const custody = this.options.custody();
      const transfer = (await this.#discovery.discover(custody.pairingId)).find((candidate) => candidate.transferId === transferId);
      if (transfer === undefined) throw new InboundMoveRuntimeError('Incoming transfer is no longer available from the provider.');
      const batch = await this.openTransfer(transfer, custody, control.signal);
      let accepted = 0;
      let retained = 0;
      const changedPhotoIds: string[] = [];
      for (const [index, item] of batch.items.entries()) {
        control.signal?.throwIfAborted();
        await control.beforeItem?.(item, index, batch.items.length);
        control.signal?.throwIfAborted();
        const result = await this.acceptItem(item, custody, control.signal);
        if (result.accepted) accepted += 1;
        else retained += 1;
        if (result.photoChanged && result.targetLocalId !== null) {
          changedPhotoIds.push(result.targetLocalId);
          this.options.onPhotoChanged?.(result.targetLocalId);
        }
        await control.itemCompleted?.(item, result, index, batch.items.length);
        control.signal?.throwIfAborted();
      }
      return { transferId, accepted, retained, changedPhotoIds };
    });
  }

  private async openTransfer(
    transfer: DiscoveredMoveTransfer,
    custody: InteropKeyCustody,
    signal?: AbortSignal,
  ): Promise<IncomingMoveBatch> {
    const scope = { pairingId: custody.pairingId, transferId: transfer.transferId };
    const opened = new Map<number, { discovered: DiscoveredMoveMessage; envelope: InteropEnvelope }>();
    for (const discovered of transfer.messages) {
      signal?.throwIfAborted();
      const encrypted = await this.#transport.download(scope, discovered.logicalPath);
      try {
        signal?.throwIfAborted();
        const envelope = openInteropMessage(encrypted, custody);
        this.assertMessageIdentity(envelope, discovered, transfer.transferId, custody.pairingId);
        opened.set(discovered.sequence, { discovered, envelope });
      } finally {
        encrypted.fill(0);
      }
    }
    const originals = new Map(transfer.originals.map((original) => [original.recordInteropId, original] as const));
    const consumed = new Set<number>();
    const consumedOriginals = new Set<string>();
    const items: Omit<IncomingMoveItem, 'acknowledged' | 'outcome' | 'reason'>[] = [];
    for (const [sequence, entry] of opened) {
      if (consumed.has(sequence)) continue;
      if (!isRecord(entry.envelope))
        throw new InboundMoveRuntimeError('Incoming Move sequence must begin each item with a record message.');
      const request = entry.envelope;
      const record = request.payload.record;
      let blobEntry: { discovered: DiscoveredMoveMessage; envelope: BlobEnvelope } | null = null;
      let original: DiscoveredMoveBlob | null = null;
      if (record.original.state === 'available') {
        const following = opened.get(sequence + 1);
        if (following === undefined || !isBlob(following.envelope)) {
          throw new InboundMoveRuntimeError('Incoming original is missing its ordered blob message.');
        }
        this.assertBlobMessage(following.envelope, request);
        original = originals.get(record.identity.interopId) ?? null;
        if (original === null || original.logicalPath !== following.envelope.payload.encryptedPath) {
          throw new InboundMoveRuntimeError('Incoming original is missing its canonical encrypted object.');
        }
        blobEntry = { discovered: following.discovered, envelope: following.envelope };
        consumed.add(sequence + 1);
        consumedOriginals.add(record.identity.interopId);
      }
      const reviewCategory = this.options.translation.previewRecord(record);
      this.journalDiscovery(request, entry.discovered, blobEntry, reviewCategory);
      items.push({
        request,
        recordMessage: entry.discovered,
        blobMessage: blobEntry?.discovered ?? null,
        blobEnvelope: blobEntry?.envelope ?? null,
        original,
        reviewCategory,
      });
      consumed.add(sequence);
    }
    if (consumed.size !== opened.size || consumedOriginals.size !== originals.size) {
      throw new InboundMoveRuntimeError('Incoming Move contains unmatched messages or original objects.');
    }
    const storedItems = new Map(this.options.journals.items(transfer.transferId).map((item) => [item.interopId, item] as const));
    const pendingAcknowledgements = new Set(
      this.options.journals.pendingOutbox(transfer.transferId).map((envelope) => envelope.header.messageId),
    );
    const journal = this.options.journals.getJournal(transfer.transferId);
    if (journal === undefined) throw new InboundMoveRuntimeError('Incoming Move journal was not created during discovery.');
    return {
      transferId: transfer.transferId,
      counts: journal.counts,
      items: items.map((item) => {
        const stored = storedItems.get(item.request.payload.record.identity.interopId);
        if (stored === undefined) throw new InboundMoveRuntimeError('Incoming Move item was not journaled during discovery.');
        const acknowledgementPending =
          stored.acknowledgementMessageId !== null && pendingAcknowledgements.has(stored.acknowledgementMessageId);
        return {
          ...item,
          acknowledged: stored.acknowledgedAt !== null,
          outcome: acknowledgementPending
            ? 'failed'
            : stored.state === 'acknowledged' || stored.state === 'finalizing' || stored.state === 'finalized'
              ? 'accepted'
              : stored.state === 'rejected'
                ? 'retained'
                : stored.state === 'failed'
                  ? 'failed'
                  : 'pending',
          reason: acknowledgementPending ? 'Acknowledgement delivery is pending.' : storedErrorMessage(stored.error),
        };
      }),
    };
  }

  private journalDiscovery(
    request: RecordEnvelope,
    message: DiscoveredMoveMessage,
    blob: { readonly discovered: DiscoveredMoveMessage; readonly envelope: BlobEnvelope } | null,
    reviewCategory: InteropReviewCategory,
  ): void {
    const at = this.#now();
    this.options.journals.recordDiscovery(request, reviewCategory, at);
    this.options.objects.discover({
      transferId: request.header.transferId,
      sourceMessageId: request.header.messageId,
      objectPath: message.logicalPath,
      objectKind: 'record-message',
      sequence: message.sequence,
      interopId: request.payload.record.identity.interopId,
      deterministicTargetId: deterministicInboundPhotoId(request.payload.record.identity.interopId),
      at,
    });
    if (blob !== null) {
      this.options.objects.discover({
        transferId: request.header.transferId,
        sourceMessageId: blob.envelope.header.messageId,
        objectPath: blob.discovered.logicalPath,
        objectKind: 'blob-message',
        sequence: blob.discovered.sequence,
        interopId: request.payload.record.identity.interopId,
        deterministicTargetId: deterministicInboundPhotoId(request.payload.record.identity.interopId),
        at,
      });
    }
  }

  private async acceptItem(item: IncomingMoveItem, custody: InteropKeyCustody, signal?: AbortSignal): Promise<InboundAcceptance> {
    signal?.throwIfAborted();
    const paths = [item.recordMessage.logicalPath, ...(item.blobMessage === null ? [] : [item.blobMessage.logicalPath])];
    const prior = this.options.journals.responseForReceipt(item.request.header.pairingId, item.request.header.messageId);
    if (prior !== undefined) {
      if (prior.payload.kind !== 'acknowledgement') throw new InboundMoveRuntimeError('Stored Move response is not an acknowledgement.');
      const phase = prior.payload.status === 'accepted' ? 'ack-journaled' : 'retained';
      paths.forEach((path) => this.advanceIf(path, item.request.header.transferId, phase, prior.header.messageId));
      await this.uploadAcknowledgement(item, prior, custody, signal);
      return this.acceptanceFromAcknowledgement(prior);
    }
    for (const path of paths) this.advanceIf(path, item.request.header.transferId, 'validated');
    let acceptance: InboundAcceptance;
    if (item.request.payload.record.original.state === 'available') {
      acceptance = await this.acceptAvailable(item, custody, paths, signal);
    } else {
      acceptance = this.options.importer.acceptWithoutOriginal(
        item.request.payload.record,
        item.request.payload.albums,
        item.reviewCategory,
        {
          assertActive: () => signal?.throwIfAborted(),
          databaseCommitted: () => paths.forEach((path) => this.advanceIf(path, item.request.header.transferId, 'database-committed')),
        },
      );
    }
    const acknowledgement = this.createAcknowledgement(item, acceptance);
    this.options.journals.recordTargetAcknowledgement({
      request: item.request,
      acknowledgement,
      reviewCategory: acceptance.reviewCategory,
      targetLocalId: acceptance.targetLocalId,
      metadataPersisted: acceptance.metadataPersisted,
      originalVerification: acceptance.originalVerification,
      error: acceptance.reason === null ? null : [sanitizedError(acceptance.reason, item.request.payload.record.identity.interopId)],
      at: this.#now(),
    });
    if (acceptance.accepted) {
      paths.forEach((path) => this.advanceIf(path, item.request.header.transferId, 'ack-journaled', acknowledgement.header.messageId));
    } else {
      paths.forEach((path) => this.advanceIf(path, item.request.header.transferId, 'retained'));
    }
    await this.uploadAcknowledgement(item, acknowledgement, custody, signal);
    return acceptance;
  }

  private async acceptAvailable(
    item: IncomingMoveItem,
    custody: InteropKeyCustody,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<InboundAcceptance> {
    signal?.throwIfAborted();
    if (item.original === null || item.blobEnvelope === null || item.blobMessage === null) {
      throw new InboundMoveRuntimeError('Incoming original custody is incomplete.');
    }
    const encrypted = await this.#transport.download(
      { pairingId: custody.pairingId, transferId: item.request.header.transferId },
      item.original.logicalPath,
    );
    const opened = openInteropBlob(encrypted, custody);
    encrypted.fill(0);
    try {
      this.assertOpenedBlob(item, opened.descriptor);
      signal?.throwIfAborted();
      return await this.options.importer.acceptOriginal(
        item.request.payload.record,
        item.request.payload.albums,
        item.reviewCategory,
        opened.bytes,
        {
          assertActive: () => signal?.throwIfAborted(),
          blobCommitted: () => paths.forEach((path) => this.advanceIf(path, item.request.header.transferId, 'blob-committed')),
          databaseCommitted: () => paths.forEach((path) => this.advanceIf(path, item.request.header.transferId, 'database-committed')),
        },
      );
    } finally {
      opened.bytes.fill(0);
    }
  }

  private createAcknowledgement(item: IncomingMoveItem, acceptance: InboundAcceptance): InteropEnvelope {
    const reason = acceptance.reason;
    return interopEnvelopeSchema.parse({
      header: {
        ...item.request.header,
        messageId: this.#createMessageId(),
        sourceProduct: 'overlook',
        targetProduct: 'image-trail',
        kind: 'acknowledgement',
        createdAt: this.#now(),
      },
      payload: {
        kind: 'acknowledgement',
        schemaVersion: 1,
        status: acceptance.accepted ? 'accepted' : 'rejected',
        recordInteropId: item.request.payload.record.identity.interopId,
        targetLocalId: acceptance.targetLocalId,
        metadataPersisted: acceptance.metadataPersisted,
        originalVerification: acceptance.originalVerification,
        acknowledgedMessageIds: [item.request.header.messageId, ...(item.blobMessage === null ? [] : [item.blobMessage.messageId])],
        errors: reason === null ? [] : [sanitizedError(reason, item.request.payload.record.identity.interopId)],
      },
    });
  }

  private async uploadAcknowledgement(
    item: IncomingMoveItem,
    acknowledgement: InteropEnvelope,
    custody: InteropKeyCustody,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const sealed = sealInteropMessage(acknowledgement, custody);
    try {
      await this.#transport.upload(
        { pairingId: custody.pairingId, transferId: item.request.header.transferId },
        moveAcknowledgementPath(acknowledgement.header.sequence, acknowledgement.header.messageId),
        sealed,
      );
      this.options.journals.markDelivered(acknowledgement.header.messageId, this.#now());
      for (const path of [item.recordMessage.logicalPath, ...(item.blobMessage === null ? [] : [item.blobMessage.logicalPath])]) {
        const stored = this.options.objects.require(item.request.header.transferId, path);
        if (stored.phase === 'ack-journaled')
          this.options.objects.advance(item.request.header.transferId, path, 'ack-uploaded', this.#now(), acknowledgement.header.messageId);
      }
      signal?.throwIfAborted();
    } finally {
      sealed.fill(0);
    }
  }

  private acceptanceFromAcknowledgement(envelope: InteropEnvelope): InboundAcceptance {
    if (envelope.payload.kind !== 'acknowledgement') throw new InboundMoveRuntimeError('Stored Move response is not an acknowledgement.');
    return {
      accepted: envelope.payload.status === 'accepted',
      reviewCategory: envelope.payload.status === 'accepted' ? 'eligible' : 'unsupported',
      targetLocalId: envelope.payload.targetLocalId,
      metadataPersisted: envelope.payload.metadataPersisted,
      originalVerification: envelope.payload.originalVerification,
      photoChanged: false,
      reason: envelope.payload.errors[0]?.message ?? null,
    };
  }

  private assertMessageIdentity(envelope: InteropEnvelope, discovered: DiscoveredMoveMessage, transferId: string, pairingId: string): void {
    const header = envelope.header;
    if (
      header.messageId !== discovered.messageId ||
      header.sequence !== discovered.sequence ||
      header.transferId !== transferId ||
      header.pairingId !== pairingId ||
      header.sourceProduct !== 'image-trail' ||
      header.targetProduct !== 'overlook' ||
      header.operation !== 'move'
    ) {
      throw new InboundMoveRuntimeError('Incoming message identity does not match its canonical provider path.');
    }
  }

  private assertBlobMessage(blob: BlobEnvelope, request: RecordEnvelope): void {
    const original = request.payload.record.original;
    if (
      original.state !== 'available' ||
      blob.payload.recordInteropId !== request.payload.record.identity.interopId ||
      blob.payload.role !== 'original' ||
      blob.payload.chunkIndex !== 0 ||
      blob.payload.chunkCount !== 1 ||
      blob.payload.encryptedPath !== moveOriginalBlobPath(request.payload.record.identity.interopId) ||
      JSON.stringify(blob.payload.blob) !== JSON.stringify(original)
    ) {
      throw new InboundMoveRuntimeError('Incoming blob message does not match its canonical record.');
    }
  }

  private assertOpenedBlob(item: IncomingMoveItem, descriptor: ReturnType<typeof openInteropBlob>['descriptor']): void {
    const original = item.request.payload.record.original;
    if (
      original.state !== 'available' ||
      descriptor.transferId !== item.request.header.transferId ||
      descriptor.recordInteropId !== item.request.payload.record.identity.interopId ||
      descriptor.blobId !== original.blobId ||
      descriptor.mimeType !== original.mimeType ||
      descriptor.byteLength !== original.byteLength ||
      descriptor.contentHash !== original.contentHash
    ) {
      throw new InboundMoveRuntimeError('Incoming encrypted original does not match its authenticated record.');
    }
  }

  private advanceIf(path: string, transferId: string, phase: InboundObjectPhase, acknowledgementMessageId: string | null = null): void {
    const current = this.options.objects.require(transferId, path);
    if (current.phase === phase || current.phase === 'ack-uploaded' || current.phase === 'retained') return;
    this.options.objects.advance(transferId, path, phase, this.#now(), acknowledgementMessageId);
  }

  private async withWork<T>(operation: () => Promise<T>): Promise<T> {
    const done = this.options.beginWork?.() ?? (() => undefined);
    try {
      return await operation();
    } finally {
      done();
    }
  }
}
