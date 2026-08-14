import type { FileProviderBridge, FileProviderDomain } from './file-provider-bridge.js';

/** E2E-only registration seam; production always uses the signed native bridge. */
export class TestFileProviderBridge implements FileProviderBridge {
  constructor(private readonly directory: string) {}

  status() {
    return { available: true, reason: null } as const;
  }

  stateDirectory(): string {
    return this.directory;
  }

  register(_domain: FileProviderDomain): Promise<void> {
    return Promise.resolve();
  }

  remove(_domainId: string): Promise<void> {
    return Promise.resolve();
  }

  evict(_domainId: string): Promise<void> {
    return Promise.resolve();
  }

  changed(_domainId: string): Promise<void> {
    return Promise.resolve();
  }

  close(): void {}
}
