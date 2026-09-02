import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type { AlbumSummary } from '../../../shared/library/types.js';
import { useFormats } from '../i18n/use-formats.js';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { useAppDispatch } from '../state/app-state-context';
import { ProtectedAlbumCeremony, type ProtectedAlbumCeremonyMode } from './ProtectedAlbumCeremony';

interface ProtectedSettingsRow {
  readonly id: string;
  readonly label: string;
  readonly locked: boolean;
  readonly name?: string | undefined;
  readonly count?: number | undefined;
}

interface CeremonyTarget {
  readonly mode: ProtectedAlbumCeremonyMode;
  readonly albumId: string;
  readonly albumName?: string | undefined;
}

export function ProtectedAlbumSettings(): ReactElement {
  const { formatCount } = useFormats();
  const dispatch = useAppDispatch();
  const [ordinary, setOrdinary] = useState<readonly AlbumSummary[]>([]);
  const [protectedRows, setProtectedRows] = useState<readonly ProtectedSettingsRow[]>([]);
  const [target, setTarget] = useState<CeremonyTarget | null>(null);

  const refresh = useCallback((): void => {
    void Promise.all([window.overlook.library.albums(), window.overlook.protectedAlbums.list()]).then(async ([albums, protectedList]) => {
      const rows = await Promise.all(
        protectedList.albums.map(async (album): Promise<ProtectedSettingsRow> => {
          if (album.locked) return album;
          try {
            const summary = await window.overlook.protectedAlbums.summary({ albumId: album.id });
            return { ...album, name: summary.name, count: summary.count };
          } catch {
            return { ...album, locked: true };
          }
        }),
      );
      // Folders are not tree nodes protection knows about (ADR-0030 §7).
      setOrdinary(albums.albums.filter((album) => album.kind === 'album'));
      setProtectedRows(rows);
    });
  }, []);

  useEffect(() => {
    refresh();
    const offLibrary = window.overlook.library.onChanged(refresh);
    const offProtected = window.overlook.protectedAlbums.onChanged(refresh);
    return () => {
      offLibrary();
      offProtected();
    };
  }, [refresh]);

  const complete = (message: string): void => {
    setTarget(null);
    refresh();
    dispatch({ type: 'toast/shown', toast: { title: message, tone: 'green' } });
  };

  return (
    <section className="ovl-protected-settings" aria-labelledby="protected-albums-title">
      <div className="ovl-protected-settings__head">
        <div>
          <div id="protected-albums-title" className="ovl-settings__fieldLabel">
            Protected albums
          </div>
          <div className="ovl-settings__fieldHint">
            Independent passwords seal photo bytes and metadata. Locked rows reveal no album name, count, date, or size.
          </div>
        </div>
        <Icon name="lock" size={14} color="var(--accent-amber)" />
      </div>
      <div className="ovl-protected-settings__group mono-data">Eligible albums</div>
      {ordinary.filter((album) => album.count > 0).length === 0 ? (
        <div className="ovl-protected-settings__empty">Create a non-empty album to protect it.</div>
      ) : (
        ordinary
          .filter((album) => album.count > 0)
          .map((album) => (
            <div key={album.id} className="ovl-protected-settings__row">
              <div className="ovl-protected-settings__identity">
                <Icon name="album" size={14} color="var(--text-faint)" />
                <div>
                  <div className="ovl-protected-settings__name">{album.name}</div>
                  <div className="mono-data ovl-protected-settings__meta">
                    {formatCount(album.count)} {album.count === 1 ? 'photo' : 'photos'}
                  </div>
                </div>
              </div>
              <Button
                variant="secondary"
                icon="lock"
                onClick={() => setTarget({ mode: 'protect', albumId: album.id, albumName: album.name })}
              >
                Protect…
              </Button>
            </div>
          ))
      )}
      <div className="ovl-protected-settings__group mono-data">Protected custody</div>
      {protectedRows.length === 0 ? (
        <div className="ovl-protected-settings__empty">No protected albums.</div>
      ) : (
        protectedRows.map((album) => (
          <div key={album.id} className="ovl-protected-settings__row">
            <div className="ovl-protected-settings__identity">
              <Icon name="lock" size={14} color="var(--accent-amber)" />
              <div>
                <div className="ovl-protected-settings__name">{album.locked ? album.label : (album.name ?? album.label)}</div>
                <div className="mono-data ovl-protected-settings__meta">
                  {album.locked
                    ? 'Locked · metadata sealed'
                    : `${formatCount(album.count ?? 0)} ${(album.count ?? 0) === 1 ? 'photo' : 'photos'} · session unlocked`}
                </div>
              </div>
            </div>
            <div className="ovl-protected-settings__actions">
              {album.locked ? (
                <Button variant="secondary" onClick={() => setTarget({ mode: 'unlock', albumId: album.id })}>
                  Unlock…
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void window.overlook.protectedAlbums.relock({ albumId: album.id }).then(() => {
                        dispatch({ type: 'protectedAlbum/set', albumId: null });
                        dispatch({ type: 'toast/shown', toast: { title: 'Protected album relocked', tone: 'neutral' } });
                        refresh();
                      });
                    }}
                  >
                    Relock
                  </Button>
                  <Button variant="ghost" onClick={() => setTarget({ mode: 'change', albumId: album.id })}>
                    Change…
                  </Button>
                  <Button variant="ghost" onClick={() => setTarget({ mode: 'remove', albumId: album.id })}>
                    Remove…
                  </Button>
                </>
              )}
              <Button variant="ghost" onClick={() => setTarget({ mode: 'recover', albumId: album.id })}>
                Recover…
              </Button>
            </div>
          </div>
        ))
      )}
      {target === null ? null : (
        <ProtectedAlbumCeremony
          key={`${target.mode}-${target.albumId}`}
          mode={target.mode}
          albumId={target.albumId}
          {...(target.albumName === undefined ? {} : { albumName: target.albumName })}
          onClose={() => setTarget(null)}
          onComplete={complete}
        />
      )}
    </section>
  );
}
