import { isLibraryDocumentPath } from '../../shared/library/library-document.js';
import { commandLineOpenPaths, openPathKey } from './external-open-intake.js';

const MAX_PENDING_LIBRARY_DOCUMENTS = 100_000;

/** Keeps Finder document opens ordered and deduplicated until the library
 * runtime is ready to switch identities. */
export class LibraryDocumentIntake {
  private readonly pending = new Map<string, string>();
  private handler: ((path: string) => Promise<void>) | undefined;
  private drain = Promise.resolve();

  enqueue(paths: readonly string[], cwd = process.cwd()): readonly string[] {
    const imports: string[] = [];
    for (const candidate of commandLineOpenPaths(['Overlook', ...paths], true, cwd)) {
      if (!isLibraryDocumentPath(candidate)) {
        imports.push(candidate);
        continue;
      }
      if (this.pending.size < MAX_PENDING_LIBRARY_DOCUMENTS) this.pending.set(openPathKey(candidate), candidate);
    }
    return imports;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  handle(handler: (path: string) => Promise<void>): Promise<void> {
    this.handler = handler;
    return this.flush();
  }

  flush(): Promise<void> {
    const handler = this.handler;
    if (handler === undefined || this.pending.size === 0) return this.drain;
    const paths = [...this.pending.values()];
    this.pending.clear();
    this.drain = this.drain
      .catch(() => undefined)
      .then(async () => {
        for (const path of paths) await handler(path);
      });
    void this.drain.catch(() => undefined);
    return this.drain;
  }

  close(): void {
    this.handler = undefined;
    this.pending.clear();
  }
}
