import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  isLibraryDocumentPath,
  libraryDocumentSummarySchema,
  LIBRARY_SUMMARY_FILE,
  LIBRARY_SUMMARY_MAX_BYTES,
} from '../../shared/library/library-document.js';
import { truncateLibraryDisplayName } from '../../shared/library/registry.js';
import type { SwitchOutcome } from './switch-runtime.js';
import { LibraryRegistryError, type LibraryRegistry } from './library-registry.js';

const LIBRARY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export interface LibraryDocumentRouterOptions {
  readonly registry: LibraryRegistry;
  readonly open: (id: string) => Promise<SwitchOutcome>;
  readonly now?: (() => Date) | undefined;
  readonly failure: (message: string) => void;
}

function readIdentity(directory: string): string | null {
  try {
    const identityPath = path.join(directory, 'library-id');
    if (!statSync(directory).isDirectory() || !lstatSync(path.join(directory, 'library.db')).isFile() || !lstatSync(identityPath).isFile())
      return null;
    const bytes = readFileSync(identityPath);
    if (bytes.byteLength > 128) return null;
    const value = bytes.toString('utf8').trim();
    return LIBRARY_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readName(directory: string): string {
  try {
    const summaryPath = path.join(directory, LIBRARY_SUMMARY_FILE);
    const metadata = lstatSync(summaryPath);
    if (!metadata.isFile() || metadata.size > LIBRARY_SUMMARY_MAX_BYTES) throw new Error('summary exceeds privacy bound');
    const bytes = readFileSync(summaryPath);
    if (bytes.byteLength > LIBRARY_SUMMARY_MAX_BYTES) throw new Error('summary exceeds privacy bound');
    const parsed = libraryDocumentSummarySchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (parsed.success) return parsed.data.name;
  } catch {
    // An absent or malformed public summary never authorizes the package.
  }
  return truncateLibraryDisplayName(path.basename(directory, path.extname(directory))) || 'Overlook Library';
}

function sameLocation(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export class LibraryDocumentRouter {
  constructor(private readonly options: LibraryDocumentRouterOptions) {}

  async open(directory: string): Promise<void> {
    if (!isLibraryDocumentPath(directory)) {
      this.options.failure('This item is not a valid Overlook library.');
      return;
    }
    const id = readIdentity(directory);
    if (id === null) {
      this.options.failure('This item is not a valid Overlook library.');
      return;
    }
    let entry = this.options.registry.get(id);
    try {
      if (entry === undefined) {
        entry = this.options.registry.register({
          id,
          name: readName(directory),
          path: directory,
          createdAt: (this.options.now?.() ?? new Date()).toISOString(),
          lastOpenedAt: null,
        });
      } else if (!sameLocation(entry.path, directory)) {
        if (existsSync(entry.path)) {
          this.options.failure('This library identity is already registered at another location.');
          return;
        }
        entry = this.options.registry.updatePath(id, directory);
      }
    } catch (error) {
      this.options.failure(error instanceof LibraryRegistryError ? error.message : 'The library could not be registered.');
      return;
    }
    try {
      const result = await this.options.open(entry.id);
      if (!result.ok) this.options.failure(this.message(result));
    } catch {
      this.options.failure('The library could not be opened.');
    }
  }

  private message(result: Extract<SwitchOutcome, { readonly ok: false }>): string {
    if (result.reason === 'missing') return 'The registered library is missing.';
    if (result.reason === 'locked-elsewhere') return `The library is open on ${result.host ?? 'another Mac'}.`;
    if (result.reason === 'provider-busy') return 'Wait for current storage work to finish before opening another library.';
    if (result.reason === 'switch-in-progress') return 'Another library is already opening.';
    return 'Unlock Overlook before opening another library.';
  }
}
