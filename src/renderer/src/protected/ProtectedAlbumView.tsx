import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { ProtectedAlbumSummary, ProtectedPageCursor, ProtectedPhotoRecord } from '../../../shared/library/protected-types.js';
import { protectedThumbUrl } from '../../../shared/library/thumb-url.js';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { PhotoTile } from '../components/PhotoTile';
import { VirtualGrid } from '../grid/VirtualGrid';
import { useAppState } from '../state/app-state-context';
import { ProtectedLightbox } from './ProtectedLightbox';

import './protected.css';

const PAGE_SIZE = 100;

export interface ProtectedAlbumViewProps {
  readonly albumId: string;
  readonly onRelocked: () => void;
  /** Storybook supplies real bundled photographs; production uses the
   * authorization-gated protected media protocols. */
  readonly mediaSrc?: ((photo: ProtectedPhotoRecord, kind: 'thumb' | 'full') => string) | undefined;
}

export function ProtectedAlbumView({ albumId, onRelocked, mediaSrc }: ProtectedAlbumViewProps): ReactElement {
  const { formatCount } = useFormats();
  const { query, zoom } = useAppState();
  const [summary, setSummary] = useState<ProtectedAlbumSummary | null>(null);
  const [photos, setPhotos] = useState<readonly ProtectedPhotoRecord[]>([]);
  const [cursor, setCursor] = useState<ProtectedPageCursor | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const relockedRef = useRef(false);
  const requestRef = useRef(0);
  const favoritePendingRef = useRef<ReadonlySet<string>>(new Set());
  const [favoritePending, setFavoritePending] = useState<ReadonlySet<string>>(() => new Set());
  const requestKey = `${albumId}\0${query}\0${generation}`;
  const loading = loadedKey !== requestKey || loadingMore;

  const unavailable = useCallback((): void => {
    if (relockedRef.current) return;
    relockedRef.current = true;
    requestRef.current += 1;
    setPhotos([]);
    setSummary(null);
    setFocusedId(null);
    onRelocked();
  }, [onRelocked]);

  useEffect(() => {
    relockedRef.current = false;
  }, [albumId]);

  useEffect(
    () =>
      window.overlook.protectedAlbums.onChanged(() => {
        requestRef.current += 1;
        setPhotos([]);
        setSummary(null);
        setFocusedId(null);
        setGeneration((value) => value + 1);
      }),
    [],
  );

  useEffect(() => {
    const request = ++requestRef.current;
    void Promise.all([
      window.overlook.protectedAlbums.summary({ albumId }),
      window.overlook.protectedAlbums.page({ albumId, limit: PAGE_SIZE, query }),
    ])
      .then(([nextSummary, page]) => {
        if (request !== requestRef.current || relockedRef.current) return;
        setSummary(nextSummary);
        setPhotos(page.photos);
        setCursor(page.nextCursor);
        setLoadedKey(requestKey);
      })
      .catch(unavailable);
  }, [albumId, query, requestKey, unavailable]);

  const loadMore = useCallback((): void => {
    if (cursor === null || loading || relockedRef.current) return;
    const request = ++requestRef.current;
    setLoadingMore(true);
    void window.overlook.protectedAlbums
      .page({ albumId, limit: PAGE_SIZE, query, cursor })
      .then((page) => {
        if (request !== requestRef.current || relockedRef.current) return;
        setPhotos((current) => [...current, ...page.photos]);
        setCursor(page.nextCursor);
      })
      .catch(unavailable)
      .finally(() => {
        if (request === requestRef.current) setLoadingMore(false);
      });
  }, [albumId, cursor, loading, query, unavailable]);

  const relock = (): void => {
    if (relockedRef.current) return;
    relockedRef.current = true;
    requestRef.current += 1;
    setPhotos([]);
    setSummary(null);
    setFocusedId(null);
    void window.overlook.protectedAlbums.relock({ albumId }).finally(onRelocked);
  };

  const focusedIndex = photos.findIndex((photo) => photo.id === focusedId);
  const focused = focusedIndex === -1 ? null : (photos[focusedIndex] ?? null);
  const step = (delta: -1 | 1): void => {
    if (photos.length === 0 || focusedIndex === -1) return;
    setFocusedId(photos[(focusedIndex + delta + photos.length) % photos.length]?.id ?? null);
  };

  return (
    <section className="ovl-protected-route" aria-label={summary?.name ?? 'Protected album'}>
      <header className="ovl-protected-route__header">
        <div>
          <div className="ovl-protected-route__eyebrow mono-data">
            <Icon name="lock" size={13} /> Session unlocked
          </div>
          <h1>{summary?.name ?? 'Protected album'}</h1>
          <div className={`ovl-protected-route__count ${summary === null ? 'prose-note' : 'mono-data'}`} aria-live="polite">
            {summary === null ? 'Opening securely…' : `${formatCount(summary.count)} ${summary.count === 1 ? 'photo' : 'photos'}`}
          </div>
        </div>
        <Button variant="secondary" icon="lock" onClick={relock}>
          Relock
        </Button>
      </header>
      <div className="ovl-protected-route__grid">
        {summary !== null && photos.length === 0 && !loading ? (
          <div className="ovl-empty" data-testid="protected-empty-state">
            <Icon name="image-off" size={28} color="var(--text-faint)" />
            <div className="ovl-empty__title">Nothing matches inside this album</div>
            <div className="ovl-empty__hint">Clear search to see its authorized photos.</div>
          </div>
        ) : (
          <VirtualGrid
            photos={photos}
            total={cursor === null ? photos.length : photos.length + 1}
            zoom={zoom}
            onNeedMore={loadMore}
            renderTile={(photo) => (
              <PhotoTile
                src={mediaSrc?.(photo, 'thumb') ?? protectedThumbUrl(albumId, photo.id)}
                alt={photo.fileName}
                favorite={photo.favorite}
                showStatus={false}
                onClick={() => setFocusedId(photo.id)}
                favoritePending={favoritePending.has(photo.id)}
                onToggleFavorite={() => {
                  if (favoritePendingRef.current.has(photo.id)) return;
                  const pending = new Set(favoritePendingRef.current);
                  pending.add(photo.id);
                  favoritePendingRef.current = pending;
                  setFavoritePending(pending);
                  void window.overlook.protectedAlbums
                    .toggleFavorite({ albumId, photoId: photo.id })
                    .then(({ favorite }) => {
                      setPhotos((current) => current.map((item) => (item.id === photo.id ? { ...item, favorite } : item)));
                    })
                    .catch(unavailable)
                    .finally(() => {
                      const remaining = new Set(favoritePendingRef.current);
                      remaining.delete(photo.id);
                      favoritePendingRef.current = remaining;
                      setFavoritePending(remaining);
                    });
                }}
              />
            )}
          />
        )}
      </div>
      {focused === null ? null : (
        <ProtectedLightbox
          albumId={albumId}
          photo={focused}
          {...(mediaSrc === undefined ? {} : { imageSrc: mediaSrc(focused, 'full') })}
          onClose={() => setFocusedId(null)}
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          onToggleFavorite={() => {
            void window.overlook.protectedAlbums
              .toggleFavorite({ albumId, photoId: focused.id })
              .then(({ favorite }) => {
                setPhotos((current) => current.map((photo) => (photo.id === focused.id ? { ...photo, favorite } : photo)));
              })
              .catch(unavailable);
          }}
        />
      )}
    </section>
  );
}
