// The original asset's envelope binds the id of the photo that imported it
// (AAD, ADR-0009); a variant (#496) decrypts the shared original under that
// id, not its own. Every row carries it so the binding survives the root's
// purge; null means the row is its own owner.
export function assetOwnerOf(photo: { readonly id: string; readonly assetOwnerId?: string | null | undefined }): string {
  return photo.assetOwnerId ?? photo.id;
}
