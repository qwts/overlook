export type FileProviderUnavailableReason = 'unsupported-platform' | 'unsigned-build' | 'native-unavailable';

export interface FileProviderDomain {
  readonly id: string;
  readonly displayName: string;
}

/** Narrow main-process boundary. The extension never receives database or key access. */
export interface FileProviderBridge {
  status(): { readonly available: boolean; readonly reason: FileProviderUnavailableReason | null };
  register(domain: FileProviderDomain): Promise<void>;
  remove(domainId: string): Promise<void>;
  evict(domainId: string): Promise<void>;
  changed(domainId: string): Promise<void>;
  close(): void;
}
