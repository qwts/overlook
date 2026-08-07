import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { classifyMediaFile } from '../../shared/library/media-files.js';
import type { PhotoKitAsset, PhotoKitAuthorization } from '../../shared/ipc/photo-kit-channels.js';
import type { PhotoKitAccess, PhotoKitBridge, PhotoKitExportAsset, PhotoKitMaterializedAsset } from './photo-kit-bridge.js';

interface FixtureAsset extends PhotoKitAsset {
  readonly sourcePath: string;
}

function fixtureId(sourcePath: string): string {
  return `fixture-${createHash('sha256').update(sourcePath).digest('hex').slice(0, 24)}`;
}

export class TestPhotoKitBridge implements PhotoKitBridge {
  private readonly fixtureAssets: readonly FixtureAsset[];
  private closed = false;

  constructor(
    importSource: string | undefined,
    private readonly exportDestination: string | undefined,
  ) {
    this.fixtureAssets =
      importSource === undefined || importSource === ''
        ? []
        : readdirSync(importSource, { withFileTypes: true })
            .filter((entry) => entry.isFile() && classifyMediaFile(entry.name) !== null)
            .map((entry) => {
              const sourcePath = path.join(importSource, entry.name);
              const kind = classifyMediaFile(entry.name);
              return {
                id: fixtureId(sourcePath),
                fileName: entry.name,
                mediaType: kind === 'video' ? ('video' as const) : ('image' as const),
                width: 0,
                height: 0,
                createdAt: null,
                latitude: null,
                longitude: null,
                sourcePath,
              };
            });
  }

  status(): { readonly available: boolean; readonly reason: null } {
    return { available: !this.closed, reason: null };
  }

  authorization(_access: PhotoKitAccess): PhotoKitAuthorization {
    return this.closed ? 'denied' : 'authorized';
  }

  requestAuthorization(access: PhotoKitAccess): Promise<PhotoKitAuthorization> {
    return Promise.resolve(this.authorization(access));
  }

  assets(): readonly PhotoKitAsset[] {
    return this.fixtureAssets.map(({ sourcePath: _sourcePath, ...asset }) => asset);
  }

  async materialize(assetIds: readonly string[], destination: string): Promise<readonly PhotoKitMaterializedAsset[]> {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const byId = new Map(this.fixtureAssets.map((asset) => [asset.id, asset]));
    return Promise.all(
      assetIds.map(async (id) => {
        const asset = byId.get(id);
        if (asset === undefined) throw new Error('fixture Photos asset is unavailable');
        const target = path.join(destination, asset.fileName);
        await copyFile(asset.sourcePath, target);
        await chmod(target, 0o600);
        const { sourcePath: _sourcePath, ...publicAsset } = asset;
        return { ...publicAsset, path: target };
      }),
    );
  }

  async exportAssets(assets: readonly PhotoKitExportAsset[]): Promise<void> {
    if (this.exportDestination === undefined || this.exportDestination === '') throw new Error('fixture Photos export is unavailable');
    await mkdir(this.exportDestination, { recursive: true });
    await Promise.all(assets.map((asset) => copyFile(asset.path, path.join(this.exportDestination!, asset.fileName))));
  }

  cancelAll(): void {}

  close(): void {
    this.closed = true;
  }
}
