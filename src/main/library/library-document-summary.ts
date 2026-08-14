import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  isLibraryDocumentPath,
  LIBRARY_SUMMARY_FILE,
  LIBRARY_SUMMARY_MAX_BYTES,
  libraryDocumentSummarySchema,
  type LibraryDocumentSummary,
} from '../../shared/library/library-document.js';

function encode(summary: LibraryDocumentSummary): string {
  const value = `${JSON.stringify(libraryDocumentSummarySchema.parse(summary))}\n`;
  if (Buffer.byteLength(value) > LIBRARY_SUMMARY_MAX_BYTES) throw new Error('Library summary exceeds its privacy bound');
  return value;
}

export function writeLibraryDocumentSummary(directory: string, summary: LibraryDocumentSummary): void {
  if (!isLibraryDocumentPath(directory)) return;
  const target = path.join(directory, LIBRARY_SUMMARY_FILE);
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, encode(summary), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
}

export function updateLibraryDocumentSummaryName(directory: string, name: string): void {
  const target = path.join(directory, LIBRARY_SUMMARY_FILE);
  if (!isLibraryDocumentPath(directory) || !existsSync(target)) return;
  try {
    const metadata = lstatSync(target);
    if (!metadata.isFile() || metadata.size > LIBRARY_SUMMARY_MAX_BYTES) return;
    const bytes = readFileSync(target);
    if (bytes.byteLength > LIBRARY_SUMMARY_MAX_BYTES) return;
    const parsed = libraryDocumentSummarySchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (parsed.success) writeLibraryDocumentSummary(directory, { ...parsed.data, name });
  } catch {
    // A corrupt public summary is replaced only by the next authorized DB refresh.
  }
}
