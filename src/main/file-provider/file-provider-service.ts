import type { Readable } from 'node:stream';

import type { AlbumSummary, PhotoRecord } from '../../shared/library/types.js';
import {
  FILE_PROVIDER_CONSENT_VERSION,
  disabledFileProviderConfig,
  type FileProviderConfig,
  type FileProviderItem,
  type FileProviderScope,
} from '../../shared/file-provider/contract.js';
import type { FileProviderBridge, FileProviderDomain } from './file-provider-bridge.js';
import type { FileProviderStore } from './file-provider-store.js';

const ROOT_ID = 'root';

export interface OpenedProviderOriginal {
  readonly stream: Readable;
  readonly release?: (() => Promise<void>) | undefined;
}

export interface FileProviderServiceDeps {
  readonly bridge: FileProviderBridge;
  readonly store: FileProviderStore;
  readonly library: { readonly id: string; readonly name: string };
  readonly albums: () => readonly AlbumSummary[];
  readonly selectPhotoIds: (albumId?: string) => readonly string[];
  readonly getPhoto: (photoId: string) => PhotoRecord | undefined;
  readonly isMigrating: (photoId: string) => boolean;
  readonly openOriginal: (photo: PhotoRecord) => Promise<OpenedProviderOriginal>;
  readonly admit: () => boolean;
}

export interface FileProviderStatus {
  readonly available: boolean;
  readonly reason: ReturnType<FileProviderBridge['status']>['reason'];
  readonly config: FileProviderConfig;
}

function segment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function unsegment(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return segment(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function albumItemId(albumId: string): string {
  return `album.${segment(albumId)}`;
}

function photoItemId(photoId: string, albumId?: string): string {
  return `photo.${albumId === undefined ? 'library' : segment(albumId)}.${segment(photoId)}`;
}

function parseAlbumItemId(itemId: string): string | null {
  return itemId.startsWith('album.') ? unsegment(itemId.slice('album.'.length)) : null;
}

function parsePhotoItemId(itemId: string): { readonly photoId: string; readonly albumId?: string } | null {
  const parts = itemId.split('.');
  if (parts.length !== 3 || parts[0] !== 'photo') return null;
  const photoId = unsegment(parts[2] ?? '');
  if (photoId === null) return null;
  if (parts[1] === 'library') return { photoId };
  const albumId = unsegment(parts[1] ?? '');
  return albumId === null ? null : { photoId, albumId };
}

function mediaType(photo: PhotoRecord): string {
  if (photo.fileKind === 'video') return 'public.movie';
  if (photo.fileKind === 'audio') return 'public.audio';
  if (photo.fileKind === 'raw') return 'public.camera-raw-image';
  return 'public.image';
}

function safeName(name: string): string {
  const normalized = name.normalize('NFC');
  return normalized !== '' && normalized !== '.' && normalized !== '..' && !normalized.includes('/') && !normalized.includes('\0')
    ? normalized
    : 'Untitled';
}

function uniqueNames(photos: readonly PhotoRecord[]): readonly string[] {
  const used = new Set<string>();
  return photos.map((photo) => {
    const original = safeName(photo.fileName);
    const dot = original.lastIndexOf('.');
    const stem = dot <= 0 ? original : original.slice(0, dot);
    const extension = dot <= 0 ? '' : original.slice(dot);
    let candidate = original;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase('en-US'))) candidate = `${stem} (${String(suffix++)})${extension}`;
    used.add(candidate.toLocaleLowerCase('en-US'));
    return candidate;
  });
}

export class FileProviderService {
  private closed = false;

  constructor(private readonly deps: FileProviderServiceDeps) {}

  status(): FileProviderStatus {
    const native = this.deps.bridge.status();
    return { ...native, config: this.deps.admit() ? this.deps.store.load() : disabledFileProviderConfig };
  }

  availableAlbums(): readonly AlbumSummary[] {
    return this.deps.admit() ? this.deps.albums() : [];
  }

  async enable(scope: FileProviderScope, consentVersion: number): Promise<FileProviderStatus> {
    this.requireOpen();
    if (consentVersion !== FILE_PROVIDER_CONSENT_VERSION) throw new Error('File Provider disclosure must be accepted');
    const native = this.deps.bridge.status();
    if (!native.available) throw new Error('File Provider is unavailable');
    this.validateScope(scope);
    const config: FileProviderConfig = { version: 1, enabled: true, consentVersion: FILE_PROVIDER_CONSENT_VERSION, scope };
    await this.deps.bridge.register(this.domain());
    try {
      this.deps.store.save(config);
      await this.deps.bridge.changed(this.domain().id);
    } catch (error) {
      await this.deps.bridge.remove(this.domain().id).catch(() => undefined);
      throw error;
    }
    return this.status();
  }

  async disable(): Promise<FileProviderStatus> {
    this.requireAdmitted();
    this.deps.store.save(disabledFileProviderConfig);
    await this.deps.bridge.evict(this.domain().id);
    await this.deps.bridge.remove(this.domain().id);
    return this.status();
  }

  async reconcile(): Promise<void> {
    const config = this.deps.store.load();
    if (!config.enabled || !this.deps.admit() || !this.deps.bridge.status().available) return;
    this.validateScope(config.scope);
    await this.deps.bridge.register(this.domain());
  }

  enumerate(parentId: string): readonly FileProviderItem[] {
    const config = this.requireEnabled();
    if (parentId === ROOT_ID) {
      return config.scope.kind === 'library' ? this.photoItems() : this.albumItems(config.scope.albumIds);
    }
    const albumId = parseAlbumItemId(parentId);
    if (albumId === null || config.scope.kind !== 'albums' || !config.scope.albumIds.includes(albumId)) return [];
    return this.photoItems(albumId);
  }

  async materialize(itemId: string): Promise<OpenedProviderOriginal> {
    const parsed = parsePhotoItemId(itemId);
    if (parsed === null) throw new Error('File Provider item is unavailable');
    const config = this.requireEnabled();
    if (!this.scopeContains(config.scope, parsed)) throw new Error('File Provider item is unavailable');
    const photo = this.deps.getPhoto(parsed.photoId);
    if (photo === undefined || photo.deletedAt !== null || this.deps.isMigrating(photo.id))
      throw new Error('File Provider item is unavailable');
    const selected = this.deps.selectPhotoIds(parsed.albumId);
    if (!selected.includes(photo.id)) throw new Error('File Provider item is unavailable');
    const opened = await this.deps.openOriginal(photo);
    if (!this.deps.admit() || !this.deps.store.load().enabled) {
      await opened.release?.();
      throw new Error('File Provider item is unavailable');
    }
    return opened;
  }

  rejectMutation(): never {
    throw new Error('File Provider is read-only');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.deps.store.load().enabled) await this.deps.bridge.evict(this.domain().id).catch(() => undefined);
    this.deps.bridge.close();
  }

  private photoItems(albumId?: string): readonly FileProviderItem[] {
    const photos = this.deps
      .selectPhotoIds(albumId)
      .map((id) => this.deps.getPhoto(id))
      .filter((photo): photo is PhotoRecord => photo !== undefined && photo.deletedAt === null && !this.deps.isMigrating(photo.id));
    const names = uniqueNames(photos);
    return photos.map((photo, index) => ({
      id: photoItemId(photo.id, albumId),
      parentId: albumId === undefined ? ROOT_ID : albumItemId(albumId),
      name: names[index] ?? 'Untitled',
      kind: 'file',
      size: photo.bytes,
      contentType: mediaType(photo),
      modifiedAt: photo.takenAt ?? photo.importedAt,
      dataless: photo.syncState === 'offloaded',
      readOnly: true,
    }));
  }

  private albumItems(enabledIds: readonly string[]): readonly FileProviderItem[] {
    return this.deps
      .albums()
      .filter((album) => enabledIds.includes(album.id))
      .map((album) => ({
        id: albumItemId(album.id),
        parentId: ROOT_ID,
        name: safeName(album.name),
        kind: 'folder',
        size: 0,
        contentType: 'public.folder',
        modifiedAt: '1970-01-01T00:00:00.000Z',
        dataless: false,
        readOnly: true,
      }));
  }

  private validateScope(scope: FileProviderScope): void {
    this.requireAdmitted();
    if (scope.kind === 'albums') {
      const current = new Set(this.deps.albums().map((album) => album.id));
      if (scope.albumIds.some((id) => !current.has(id))) throw new Error('File Provider selection is stale');
    }
  }

  private scopeContains(scope: FileProviderScope, item: { readonly albumId?: string }): boolean {
    return scope.kind === 'library' ? item.albumId === undefined : item.albumId !== undefined && scope.albumIds.includes(item.albumId);
  }

  private requireEnabled(): FileProviderConfig {
    this.requireOpen();
    const config = this.deps.store.load();
    if (!config.enabled) throw new Error('File Provider is unavailable');
    return config;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('File Provider is unavailable');
    this.requireAdmitted();
  }

  private requireAdmitted(): void {
    if (!this.deps.admit()) throw new Error('File Provider is unavailable');
  }

  private domain(): FileProviderDomain {
    return { id: `com.zts1.overlook.library.${this.deps.library.id}`, displayName: this.deps.library.name };
  }
}
