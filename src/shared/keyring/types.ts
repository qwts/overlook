// Keyring vocabulary (#517, ADR-0032 §2) shared by the registry, the key
// file format, the IPC surface and the renderer.

/** What a key seals: the whole library, one item, or a shared space. */
export type KeyKind = 'library' | 'item' | 'space';

/** How the material reached this library. `received` is reserved for #518. */
export type KeyOrigin = 'local' | 'imported' | 'received';

export const KEY_KINDS: readonly KeyKind[] = ['library', 'item', 'space'];
export const KEY_ORIGINS: readonly KeyOrigin[] = ['local', 'imported', 'received'];

/** A stable, non-secret 128-bit identity rendered as 32 lowercase hex digits. */
export const KEY_REF_PATTERN = /^[0-9a-f]{32}$/u;

/** Suggested file name for an exported key: the reference's leading digits. */
export function keyFileName(keyRef: string, version: number): string {
  return `overlook-key-${keyRef.slice(0, 8)}-v${String(version)}.key`;
}
