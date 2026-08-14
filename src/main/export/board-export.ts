import type { Readable } from 'node:stream';
import { Readable as ReadableStream } from 'node:stream';
import { buffer as bufferStream } from 'node:stream/consumers';

import sharp from 'sharp';

import { embeddedJpegFromRaf } from '../import/raf-preview.js';
import type { PhotoRecord } from '../../shared/library/types.js';
import type { BoardExportRequest, BoardExportResult } from '../../shared/moodboard/export-contract.js';
import { composeExportLayout, type ExportItem } from '../../shared/moodboard/export-layout.js';

const BOARD_BACKGROUND = {
  ink: '#090a0c',
  paper: '#f5f5f5',
  sepia: '#40351d',
  navy: '#111827',
} as const;

export class BoardExportCancelledError extends Error {
  override readonly name = 'BoardExportCancelledError';
}

interface Overlay {
  readonly input: Buffer;
  readonly left: number;
  readonly top: number;
}

export interface BoardExportDeps {
  readonly getPhoto: (photoId: string) => PhotoRecord | undefined;
  readonly openOriginal: (photo: PhotoRecord) => Promise<{
    readonly stream: Readable;
    readonly release?: (() => Promise<void>) | undefined;
  }>;
  readonly writeFile: (path: string, plaintext: Readable) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly freeBytes: (directory: string) => Promise<number>;
  readonly joinPath: (directory: string, fileName: string) => string;
  readonly progress: (done: number, total: number) => void;
}

function sourceBytes(bytes: Buffer, fileKind: PhotoRecord['fileKind']): Buffer {
  if (fileKind !== 'raw') return bytes;
  const preview = embeddedJpegFromRaf(bytes);
  if (preview === null) throw new Error('RAW has no compositable preview');
  return preview;
}

function checkedSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new BoardExportCancelledError('board export cancelled');
}

async function placementOverlay(bytes: Buffer, fileKind: PhotoRecord['fileKind'], item: ExportItem): Promise<Overlay | null> {
  const oriented = await sharp(sourceBytes(bytes, fileKind), { failOn: 'error' }).rotate().png().toBuffer({ resolveWithObject: true });
  const sourceWidth = oriented.info.width;
  const sourceHeight = oriented.info.height;
  const cropLeft = Math.min(sourceWidth - 1, Math.max(0, Math.floor(item.crop.x * sourceWidth)));
  const cropTop = Math.min(sourceHeight - 1, Math.max(0, Math.floor(item.crop.y * sourceHeight)));
  const cropWidth = Math.max(1, Math.min(sourceWidth - cropLeft, Math.round(item.crop.w * sourceWidth)));
  const cropHeight = Math.max(1, Math.min(sourceHeight - cropTop, Math.round(item.crop.h * sourceHeight)));
  const width = Math.max(1, Math.round(item.dest.w));
  const height = Math.max(1, Math.round(item.dest.h));
  const tile = await sharp(oriented.data)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .resize(width, height, { fit: 'cover' })
    .png()
    .toBuffer();
  const rotation = ((item.rotation % 360) + 360) % 360;
  const rotated =
    rotation === 0
      ? { data: tile, info: { width, height } }
      : await sharp(tile)
          .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer({ resolveWithObject: true });
  return {
    input: rotated.data,
    left: Math.round(item.dest.x + item.dest.w / 2 - rotated.info.width / 2),
    top: Math.round(item.dest.y + item.dest.h / 2 - rotated.info.height / 2),
  };
}

async function clippedOverlay(overlay: Overlay, output: BoardExportRequest['output']): Promise<Overlay | null> {
  const metadata = await sharp(overlay.input).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const sourceLeft = Math.max(0, -overlay.left);
  const sourceTop = Math.max(0, -overlay.top);
  const left = Math.max(0, overlay.left);
  const top = Math.max(0, overlay.top);
  const visibleWidth = Math.min(width - sourceLeft, output.width - left);
  const visibleHeight = Math.min(height - sourceTop, output.height - top);
  if (visibleWidth <= 0 || visibleHeight <= 0) return null;
  if (sourceLeft === 0 && sourceTop === 0 && visibleWidth === width && visibleHeight === height) return overlay;
  const input = await sharp(overlay.input)
    .extract({ left: sourceLeft, top: sourceTop, width: visibleWidth, height: visibleHeight })
    .png()
    .toBuffer();
  return { input, left, top };
}

function safeStem(title: string): string {
  const normalized = [...title.normalize('NFKC')].map((character) => ((character.codePointAt(0) ?? 0) < 32 ? '-' : character)).join('');
  const stem = normalized
    .replace(/[<>:"/\\|?*]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/gu, '')
    .slice(0, 120);
  return stem === '' ? 'Moodboard' : stem;
}

async function availableFileName(request: BoardExportRequest, deps: BoardExportDeps): Promise<string> {
  const stem = safeStem(request.board.title);
  for (let counter = 1; counter < 10_000; counter += 1) {
    const fileName = counter === 1 ? `${stem}.png` : `${stem} (${String(counter)}).png`;
    if (!(await deps.exists(deps.joinPath(request.destination, fileName)))) return fileName;
  }
  throw new Error('could not allocate a unique board export filename');
}

export async function exportBoardPng(request: BoardExportRequest, deps: BoardExportDeps, signal: AbortSignal): Promise<BoardExportResult> {
  checkedSignal(signal);
  const worstCaseBytes = request.output.width * request.output.height * 4;
  const freeBytes = await deps.freeBytes(request.destination);
  if (freeBytes < worstCaseBytes) {
    throw new Error(`destination needs ${String(worstCaseBytes)} bytes free, has ${String(freeBytes)}`);
  }
  const layout = composeExportLayout(request.board, request.output, (placement) => request.availability[placement.id] ?? 'unavailable');
  const overlays: Overlay[] = [];
  let skippedUnavailable = layout.skippedUnavailable;
  const total = request.board.placements.length;
  let done = layout.skipped;
  deps.progress(done, total);

  for (const item of layout.items) {
    checkedSignal(signal);
    const photo = deps.getPhoto(item.photoId);
    let release: (() => Promise<void>) | undefined;
    try {
      if (photo === undefined || photo.deletedAt !== null) {
        skippedUnavailable += 1;
        continue;
      }
      const opened = await deps.openOriginal(photo);
      release = opened.release;
      const bytes = await bufferStream(opened.stream);
      checkedSignal(signal);
      const overlay = await placementOverlay(bytes, photo.fileKind, item);
      const clipped = overlay === null ? null : await clippedOverlay(overlay, request.output);
      if (clipped !== null) overlays.push(clipped);
    } finally {
      await release?.();
      done += 1;
      deps.progress(Math.min(done, total), total);
    }
  }

  checkedSignal(signal);
  const png = await sharp({
    create: {
      width: request.output.width,
      height: request.output.height,
      channels: 4,
      background: BOARD_BACKGROUND[request.board.background],
    },
  })
    .composite(overlays)
    .withIccProfile(request.colorSpace === 'display-p3' ? 'p3' : 'srgb')
    .png()
    .toBuffer();
  checkedSignal(signal);
  const fileName = await availableFileName(request, deps);
  const path = deps.joinPath(request.destination, fileName);
  await deps.writeFile(path, ReadableStream.from([png]));
  return {
    exported: true,
    cancelled: false,
    rendered: overlays.length,
    skipped: layout.skippedLocked + skippedUnavailable,
    skippedLocked: layout.skippedLocked,
    skippedUnavailable,
    fileName,
    path,
  };
}
