import { randomUUID } from 'node:crypto';

import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';
import type { ProtectedAlbumAuthorityRegistry } from '../crypto/protected-album-authority.js';
import type { ProtectedAlbumMetadata } from '../crypto/protected-album-credentials.js';
import type { ProtectedAlbumService } from '../crypto/protected-album-service.js';
import type { ProtectedMigrationAuthority, ProtectedPhotoMigrationService } from '../crypto/protected-photo-migration-service.js';
import type { ProtectedAlbumRepository } from '../db/protected-album-repository.js';
import type { PhotosRepository } from '../db/photos-repository.js';

export type ProtectedWorkflowStage = 'preparing' | 'copying' | 'verifying' | 'committing' | 'purging' | 'complete';

export interface ProtectedWorkflowProgress {
  readonly operation: 'protect' | 'unprotect';
  readonly stage: ProtectedWorkflowStage;
  readonly done: number;
  readonly total: number;
}

export type ProtectedWorkflowResult =
  | { readonly ok: true; readonly albumId: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'empty' | 'conflict' | 'wrong-password' | 'cancelled' | 'failed' };

export type ProtectedWorkflowUnlockResult =
  | { readonly ok: true; readonly outcome: 'opened' | 'protection-completed' | 'removal-completed' }
  | { readonly ok: false; readonly reason: 'not-found' | 'wrong-password' | 'invalid-record' | 'interrupted' | 'failed' };

export interface ProtectedWorkflowServiceOptions {
  readonly albums: ProtectedAlbumService;
  readonly albumRecords: ProtectedAlbumRepository;
  readonly authorities: ProtectedAlbumAuthorityRegistry;
  readonly migrations: ProtectedPhotoMigrationService;
  readonly photos: PhotosRepository;
  readonly masterKey: () => Buffer;
  readonly resolveLibraryKey: () => KeyResolver;
  readonly currentLibraryKey: () => EnvelopeKey;
  readonly progress: (progress: ProtectedWorkflowProgress) => void;
  readonly changed: () => void;
  readonly ordinaryChanged: (photoIds: readonly string[]) => void;
  readonly createId?: (() => string) | undefined;
}

/** Renderer-safe coordinator. Passwords stay within one invocation, album
 * keys never leave main, and cancellation occurs only at durable boundaries. */
export class ProtectedWorkflowService {
  private controller: AbortController | undefined;

  constructor(private readonly options: ProtectedWorkflowServiceOptions) {}

  cancel(): boolean {
    if (this.controller === undefined) return false;
    this.controller.abort();
    return true;
  }

  relock(albumId: string): boolean {
    const relocked = this.options.albums.relock(albumId);
    if (relocked) this.options.changed();
    return relocked;
  }

  async changePassword(albumId: string, currentPassword: string, nextPassword: string): Promise<boolean> {
    const changed = await this.options.albums.changePassword(albumId, currentPassword, nextPassword);
    if (changed) this.options.changed();
    return changed;
  }

  async recoverPassword(input: {
    readonly albumId: string;
    readonly recoveryFile: Buffer;
    readonly recoveryPassword: string;
    readonly nextPassword: string;
  }): Promise<{ readonly recovered: boolean; readonly reason: 'not-found' | 'wrong-recovery-key' | 'invalid-record' | null }> {
    const result = await this.options.albums.recoverPassword(input);
    if (result.ok) {
      this.options.changed();
      return { recovered: true, reason: null };
    }
    return { recovered: false, reason: result.reason };
  }

  async unlock(albumId: string, password: string): Promise<ProtectedWorkflowUnlockResult> {
    if (this.controller !== undefined) return { ok: false, reason: 'failed' };
    const unlocked = await this.options.albums.unlock(albumId, password);
    if (!unlocked.ok) return unlocked;

    await this.options.migrations.repairStartup();
    const record = this.options.albumRecords.get(albumId);
    if (record?.migrationState === 'staged') {
      const pending = this.options.migrations.pendingForAlbum(albumId, 'protect');
      if (pending === undefined) {
        await this.options.albums.discardStaged(albumId, password);
        this.options.changed();
        return { ok: false, reason: 'interrupted' };
      }
      return this.resumeProtection(albumId, unlocked.metadata, pending.migrationId);
    }

    const pendingRemoval = this.options.migrations.pendingForAlbum(albumId, 'unprotect');
    if (pendingRemoval !== undefined) {
      return this.resumeRemoval(albumId, unlocked.metadata, pendingRemoval.migrationId);
    }
    this.options.changed();
    return { ok: true, outcome: 'opened' };
  }

  async protect(ordinaryAlbumId: string, password: string): Promise<ProtectedWorkflowResult> {
    if (this.controller !== undefined) return { ok: false, reason: 'conflict' };
    const source = this.options.photos.albumForProtection(ordinaryAlbumId);
    if (source === undefined) return { ok: false, reason: 'not-found' };
    if (source.photoIds.length === 0) return { ok: false, reason: 'empty' };

    const albumId = this.options.createId?.() ?? randomUUID();
    const masterKey = this.options.masterKey();
    let albumKey: Buffer | undefined;
    let migrationId: string | undefined;
    let migrationCompleted = false;
    this.controller = new AbortController();
    try {
      await this.options.albums.provision({
        albumId,
        password,
        masterKey,
        metadata: {
          version: 1,
          name: source.name,
          createdAt: source.createdAt,
          position: source.position,
          ordinaryAlbum: { id: source.id, createdAt: source.createdAt, position: source.position, showInAllPhotos: source.showInAllPhotos },
          members: source.photoIds.map((photoId, position) => ({ photoId, position, ordinaryMemberships: [] })),
        },
      });
      albumKey = this.copyAlbumKey(albumId);
      migrationId = this.options.migrations.prepareProtect({ albumId, albumKey, photoIds: source.photoIds });
      await this.advanceAll(migrationId, 'protect', source.photoIds.length, {
        targetAlbumKey: albumKey,
        libraryResolver: this.options.resolveLibraryKey(),
      });
      migrationCompleted = true;
      this.finishProtection(albumId, source.id, source.photoIds);
      return { ok: true, albumId };
    } catch {
      await this.options.migrations.repairStartup();
      const phase = migrationId === undefined ? undefined : this.options.migrations.migrationPhase(migrationId);
      const durable = migrationCompleted || phase === 'commit' || phase === 'purge';
      if (durable && albumKey !== undefined && migrationId !== undefined) {
        try {
          await this.advanceAll(migrationId, 'protect', source.photoIds.length, {
            targetAlbumKey: albumKey,
            libraryResolver: this.options.resolveLibraryKey(),
          });
          this.finishProtection(albumId, source.id, source.photoIds);
          return { ok: true, albumId };
        } catch {
          this.options.changed();
          return { ok: false, reason: 'failed' };
        }
      }
      await this.options.albums.discardStaged(albumId, password);
      this.options.changed();
      return { ok: false, reason: this.controller.signal.aborted ? 'cancelled' : 'failed' };
    } finally {
      albumKey?.fill(0);
      masterKey.fill(0);
      this.controller = undefined;
    }
  }

  async unprotect(albumId: string, password: string): Promise<ProtectedWorkflowResult> {
    if (this.controller !== undefined) return { ok: false, reason: 'conflict' };
    const unlocked = await this.options.albums.unlock(albumId, password);
    if (!unlocked.ok) return { ok: false, reason: unlocked.reason === 'wrong-password' ? 'wrong-password' : 'not-found' };
    return this.unprotectAuthorized(albumId, unlocked.metadata);
  }

  private async unprotectAuthorized(albumId: string, metadata: ProtectedAlbumMetadata): Promise<ProtectedWorkflowResult> {
    const restoration = metadata.ordinaryAlbum;
    if (restoration === undefined) return { ok: false, reason: 'failed' };
    const photoIds = metadata.members.map((member) => member.photoId);
    const albumKey = this.copyAlbumKey(albumId);
    const targetLibraryKey = this.options.currentLibraryKey();
    this.controller = new AbortController();
    let committed = false;
    try {
      await this.options.migrations.repairStartup();
      const pending = this.options.migrations.pendingForAlbum(albumId, 'unprotect');
      if (pending === undefined && this.options.photos.albumForProtection(restoration.id) !== undefined) {
        return { ok: false, reason: 'conflict' };
      }
      const migrationId = pending?.migrationId ?? this.options.migrations.prepareUnprotect({ albumId, albumKey, photoIds });
      const authority: ProtectedMigrationAuthority = {
        sourceAlbumKey: albumKey,
        targetLibraryKey,
        ordinaryAlbum: { ...restoration, name: metadata.name },
      };
      await this.advanceUntilCommitted(migrationId, 'unprotect', photoIds.length, authority);
      committed = true;
      await this.advanceAll(migrationId, 'unprotect', photoIds.length, authority);
      this.finishRemoval(albumId, photoIds);
      return { ok: true, albumId };
    } catch (error) {
      console.error('[overlook] protected album unprotect failed', error);
      if (!committed) await this.options.migrations.repairStartup();
      return { ok: false, reason: this.controller.signal.aborted ? 'cancelled' : 'failed' };
    } finally {
      albumKey.fill(0);
      this.controller = undefined;
    }
  }

  private async resumeProtection(
    albumId: string,
    metadata: ProtectedAlbumMetadata,
    migrationId: string,
  ): Promise<ProtectedWorkflowUnlockResult> {
    const albumKey = this.copyAlbumKey(albumId);
    this.controller = new AbortController();
    try {
      await this.advanceAll(migrationId, 'protect', metadata.members.length, {
        targetAlbumKey: albumKey,
        libraryResolver: this.options.resolveLibraryKey(),
      });
      this.finishProtection(
        albumId,
        metadata.ordinaryAlbum?.id,
        metadata.members.map((member) => member.photoId),
      );
      return { ok: true, outcome: 'protection-completed' };
    } catch {
      return { ok: false, reason: 'failed' };
    } finally {
      albumKey.fill(0);
      this.controller = undefined;
    }
  }

  private async resumeRemoval(
    albumId: string,
    metadata: ProtectedAlbumMetadata,
    migrationId: string,
  ): Promise<ProtectedWorkflowUnlockResult> {
    const restoration = metadata.ordinaryAlbum;
    if (restoration === undefined) return { ok: false, reason: 'failed' };
    const albumKey = this.copyAlbumKey(albumId);
    this.controller = new AbortController();
    try {
      await this.advanceAll(migrationId, 'unprotect', metadata.members.length, {
        sourceAlbumKey: albumKey,
        targetLibraryKey: this.options.currentLibraryKey(),
        ordinaryAlbum: { ...restoration, name: metadata.name },
      });
      this.finishRemoval(
        albumId,
        metadata.members.map((member) => member.photoId),
      );
      return { ok: true, outcome: 'removal-completed' };
    } catch {
      return { ok: false, reason: 'failed' };
    } finally {
      albumKey.fill(0);
      this.controller = undefined;
    }
  }

  private finishProtection(albumId: string, ordinaryAlbumId: string | undefined, photoIds: readonly string[]): void {
    const state = this.options.albumRecords.get(albumId)?.migrationState;
    if (state === 'staged' && !this.options.albumRecords.transition(albumId, 'staged', 'active')) {
      throw new Error('protected album activation failed');
    }
    if (state !== 'staged' && state !== 'active') throw new Error('protected album activation failed');
    if (ordinaryAlbumId !== undefined) this.options.photos.deleteAlbum(ordinaryAlbumId);
    this.options.albums.relock(albumId);
    this.options.ordinaryChanged(photoIds);
    this.options.changed();
  }

  private finishRemoval(albumId: string, photoIds: readonly string[]): void {
    const state = this.options.albumRecords.get(albumId)?.migrationState;
    if (state === 'active' && !this.options.albumRecords.transition(albumId, 'active', 'retiring')) {
      throw new Error('protected album retirement failed');
    }
    this.options.albums.relock(albumId);
    if (this.options.albumRecords.get(albumId) !== undefined && !this.options.albumRecords.deleteRetiring(albumId)) {
      throw new Error('protected album retirement did not finish');
    }
    this.options.ordinaryChanged(photoIds);
    this.options.changed();
  }

  private async advanceUntilCommitted(
    migrationId: string,
    operation: 'protect' | 'unprotect',
    total: number,
    authority: ProtectedMigrationAuthority,
  ): Promise<void> {
    for (;;) {
      const phase = this.options.migrations.migrationPhase(migrationId);
      if (phase === undefined || phase === 'commit' || phase === 'purge') return;
      const stage = phase === 'prepare' ? 'preparing' : phase === 'copy' ? 'copying' : 'verifying';
      this.emit(operation, stage, phase === 'verify' ? total : 0, total);
      this.assertContinuable();
      await this.options.migrations.advance(migrationId, authority);
    }
  }

  private async advanceAll(
    migrationId: string,
    operation: 'protect' | 'unprotect',
    total: number,
    authority: ProtectedMigrationAuthority,
  ): Promise<void> {
    for (;;) {
      const phase = this.options.migrations.migrationPhase(migrationId);
      if (phase === undefined) break;
      const stage =
        phase === 'prepare'
          ? 'preparing'
          : phase === 'copy'
            ? 'copying'
            : phase === 'verify'
              ? 'verifying'
              : phase === 'commit'
                ? 'committing'
                : 'purging';
      this.emit(operation, stage, phase === 'prepare' || phase === 'copy' ? 0 : total, total);
      if (phase === 'prepare' || phase === 'copy' || phase === 'verify') this.assertContinuable();
      await this.options.migrations.advance(migrationId, authority);
    }
    this.emit(operation, 'complete', total, total);
  }

  private copyAlbumKey(albumId: string): Buffer {
    return this.options.authorities.withAuthority(albumId, (key) => Buffer.from(key));
  }

  private assertContinuable(): void {
    if (this.controller?.signal.aborted === true) throw new Error('protected workflow cancelled');
  }

  private emit(operation: 'protect' | 'unprotect', stage: ProtectedWorkflowStage, done: number, total: number): void {
    this.options.progress({ operation, stage, done, total });
  }
}
