import { z } from 'zod';

import { ENUMERATED_FACETS, smartPredicateSchema } from '../library/smart-album.js';

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(name: string, request: TRequest, response: TResponse) => ({
  name,
  request,
  response,
});

/** An album as the sidebar lists it (#80) with its All Photos policy and the
 * ADR-0030 §2 disclosure (#494): photos another visible album keeps in All
 * Photos, and which albums those are. */
export const albumListingSchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
  showInAllPhotos: z.boolean(),
  visibleElsewhere: z.number().int().nonnegative(),
  visibleVia: z.array(z.object({ id: z.string(), name: z.string() })).readonly(),
  kind: z.enum(['album', 'folder', 'smart']),
  parentId: z.string().nullable(),
  inheritsVisibility: z.boolean(),
  tags: z.array(z.string()).readonly(),
  /** A Smart Album's saved query (#514); null for albums and folders, and
   * for a Smart Album this app cannot evaluate — `unsupported` then says why. */
  predicate: smartPredicateSchema.nullable(),
  unsupported: z.string().nullable(),
});

/** Deleting a non-empty folder is a ceremony (#505, ADR-0023 Tier M): the
 * caller either names where the children go or confirms removing the
 * structure recursively. Photos are never among what is removed. */
export const folderDeletionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('move'), destinationId: z.string().min(1).nullable() }),
  z.object({ mode: z.literal('recursive') }),
]);

export const albumChannels = {
  albumCreate: defineChannel(
    'album:create',
    z.object({
      name: z.string().min(1).max(120),
      kind: z.enum(['album', 'folder', 'smart']).optional(),
      parentId: z.string().min(1).nullable().optional(),
      /** Required for kind 'smart'. */
      predicate: smartPredicateSchema.optional(),
    }),
    z.object({ album: albumListingSchema }),
  ),
  albumSetPredicate: defineChannel(
    'album:set-predicate',
    z.object({ albumId: z.string().min(1), predicate: smartPredicateSchema }),
    z.object({ album: albumListingSchema }),
  ),
  albumDuplicate: defineChannel('album:duplicate', z.object({ albumId: z.string().min(1) }), z.object({ album: albumListingSchema })),
  libraryFacetValues: defineChannel(
    'library:facet-values',
    z.object({ facet: z.enum(ENUMERATED_FACETS) }),
    z.object({ values: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative() })).readonly() }),
  ),
  albumSetVisibility: defineChannel(
    'album:set-visibility',
    z.object({ albumId: z.string().min(1), showInAllPhotos: z.union([z.boolean(), z.literal('inherit')]) }),
    z.object({ album: albumListingSchema }),
  ),
  albumMove: defineChannel(
    'album:move',
    z.object({ albumId: z.string().min(1), parentId: z.string().min(1).nullable() }),
    z.object({ album: albumListingSchema }),
  ),
  albumSetTags: defineChannel(
    'album:set-tags',
    z.object({ albumId: z.string().min(1), tags: z.array(z.string().max(60)).max(50).readonly() }),
    z.object({ album: albumListingSchema }),
  ),
  albumRename: defineChannel('album:rename', z.object({ albumId: z.string(), name: z.string().min(1).max(120) }), z.object({})),
  albumDelete: defineChannel('album:delete', z.object({ albumId: z.string(), folder: folderDeletionSchema.optional() }), z.object({})),
  albumAddPhotos: defineChannel(
    'album:add-photos',
    z.object({ albumId: z.string(), photoIds: z.array(z.string()).min(1) }),
    z.object({ added: z.number().int().nonnegative() }),
  ),
  albumRemovePhotos: defineChannel(
    'album:remove-photos',
    z.object({ albumId: z.string(), photoIds: z.array(z.string()).min(1) }),
    z.object({ removed: z.number().int().nonnegative() }),
  ),
  albumMovePhotos: defineChannel(
    'album:move-photos',
    z.object({ sourceAlbumId: z.string(), targetAlbumId: z.string(), photoIds: z.array(z.string()).min(1) }),
    z.object({ moved: z.number().int().nonnegative(), alreadyInTarget: z.number().int().nonnegative() }),
  ),
  albumReorder: defineChannel(
    'album:reorder',
    z.object({
      albumId: z.string().min(1),
      position: z.number().int().nonnegative(),
      commandId: z.enum(['album.reorder.up', 'album.reorder.down', 'album.reorder.top', 'album.reorder.bottom']),
    }),
    z.object({ changed: z.boolean(), position: z.number().int().nonnegative(), total: z.number().int().positive() }),
  ),
} as const;
