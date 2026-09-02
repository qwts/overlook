import { z } from 'zod';

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
});

export const albumChannels = {
  albumCreate: defineChannel('album:create', z.object({ name: z.string().min(1).max(120) }), z.object({ album: albumListingSchema })),
  albumSetVisibility: defineChannel(
    'album:set-visibility',
    z.object({ albumId: z.string().min(1), showInAllPhotos: z.boolean() }),
    z.object({ album: albumListingSchema }),
  ),
  albumRename: defineChannel('album:rename', z.object({ albumId: z.string(), name: z.string().min(1).max(120) }), z.object({})),
  albumDelete: defineChannel('album:delete', z.object({ albumId: z.string() }), z.object({})),
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
