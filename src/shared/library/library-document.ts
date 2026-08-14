import path from 'node:path';

import { z } from 'zod';

import { libraryDisplayNameSchema } from './registry.js';

export const LIBRARY_DOCUMENT_EXTENSION = '.overlooklibrary';
export const LIBRARY_SUMMARY_FILE = 'OverlookSummary.json';
export const LIBRARY_SUMMARY_MAX_BYTES = 4096;

export const libraryDocumentSummarySchema = z
  .object({
    version: z.literal(1),
    name: libraryDisplayNameSchema,
    itemCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type LibraryDocumentSummary = z.output<typeof libraryDocumentSummarySchema>;

export function isLibraryDocumentPath(value: string): boolean {
  return path.extname(value).toLocaleLowerCase('en-US') === LIBRARY_DOCUMENT_EXTENSION;
}

export function ensureLibraryDocumentPath(value: string): string {
  return isLibraryDocumentPath(value) ? value : `${value}${LIBRARY_DOCUMENT_EXTENSION}`;
}
