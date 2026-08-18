import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { fullUrl } from '../../../shared/library/full-url.js';
import { thumbUrl } from '../../../shared/library/thumb-url.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { destructiveActions } from '../../../shared/destructive-actions.js';
import { LightboxViewport } from './LightboxViewport';
import { LightboxVideo } from './LightboxVideo';
import { DEFAULT_VIEW_INTENT } from './geometry.js';
import { useLightboxChrome } from './use-lightbox-chrome';
import { usePrefersReducedMotion } from './use-reduced-motion.js';
import { useFormats } from '../i18n/use-formats.js';
import { directionOf } from '../../../shared/i18n/locales.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { custodyPresentation } from '../backup/custody-presentation.js';
import { usePhotoCustodyStatus } from '../backup/use-photo-custody-status.js';

import './lightbox.css';

// Lightbox (#92, README §3): image-first, chrome that gets out of the way.
// The photo arrives decrypted in memory over overlook-full:// (#91); RAW
// records render their embedded preview (ADR-0006), badged PREVIEW. Chrome
// fades in on mousemove and auto-hides after 2.2s idle (200ms ease-out
// fades), waking on photo change. Keyboard lands with #93, Inspector with
// #94; delete stays a disabled stub until M10's soft-delete.

export const animationMessages = defineMessages({
  play: {
    id: 'lightbox.animation.play',
    defaultMessage: 'Play animation',
  },
  stop: {
    id: 'lightbox.animation.stop',
    defaultMessage: 'Show static poster',
  },
});

export interface LightboxProps {
  readonly platform?: string | undefined;
  readonly photo: PhotoRecord;
  /** Storybook supplies a bundled real-photo URL; production uses the decrypted protocol. */
  readonly imageSrc?: string | undefined;
  /** Static poster for reduced-motion animated media; defaults to the mid derivative. */
  readonly posterSrc?: string | undefined;
  readonly onClose: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onToggleFavorite: () => void;
  readonly inspectorOpen: boolean;
  readonly onToggleInspector: () => void;
  /** Export dialog arrives with M07 (count=1); stub until then. */
  readonly onExport: () => void;
  readonly onTransfer?: (() => void) | undefined;
  /** Opens verified offload preflight for this photo. */
  readonly onOffload: () => void;
  /** Rehydrate failed — the host shows the red toast (#107). */
  readonly onRehydrateError?: (() => void) | undefined;
  readonly onRepairDimensions: (width: number, height: number) => void;
  /** An offload for this photo is being confirmed or executed. */
  readonly suppressRehydrate?: boolean | undefined;
  /** Soft-deletes this photo (#120) — the row leaving the visible set
   * closes the lightbox via the reducer's intersection rule. */
  readonly onDelete: () => void;
}

/** The bottom strip's EXIF line — only what the file actually states. */
function exifStrip(photo: PhotoRecord): string {
  const parts = [
    photo.camera,
    photo.aperture === null ? null : `ƒ/${photo.aperture}`,
    photo.shutter === null ? null : `${photo.shutter}S`,
    photo.iso === null ? null : `ISO ${String(photo.iso)}`,
    photo.focalLength === null ? null : `${String(photo.focalLength)}MM`,
  ];
  return parts.filter((part) => part !== null).join(' · ');
}

export function Lightbox({
  platform = 'darwin',
  photo,
  imageSrc,
  posterSrc,
  onClose,
  onPrev,
  onNext,
  onToggleFavorite,
  inspectorOpen,
  onToggleInspector,
  onExport,
  onTransfer,
  onOffload,
  onRehydrateError,
  onRepairDimensions,
  suppressRehydrate = false,
  onDelete,
}: LightboxProps): ReactElement {
  const intl = useIntl();
  const { formatCalendarDate } = useFormats();
  const { announce } = useAnnouncer();
  const direction = directionOf(intl.locale);
  const [ephemeralState, setEphemeralState] = useState<{
    readonly photoId: string;
    readonly stage: 'fetching' | 'verifying' | 'ready' | 'released' | 'error';
  } | null>(null);
  const [viewIntent, setViewIntent] = useState(DEFAULT_VIEW_INTENT);
  const { chrome, rootRef, armTimer, wakeChrome, startClickGesture, trackClickGesture, cancelClickGesture, hideForImageClick } =
    useLightboxChrome(photo.id);

  const offloaded = photo.syncState === 'offloaded';
  const remoteCustodyCandidate = offloaded || photo.syncState === 'error';
  const custodyStatus = usePhotoCustodyStatus(photo.id, remoteCustodyCandidate);
  const custody = custodyStatus === null ? null : custodyPresentation(intl, custodyStatus);
  const rehydrateErrorRef = useRef(onRehydrateError);
  useEffect(() => {
    rehydrateErrorRef.current = onRehydrateError;
  });
  useEffect(() => {
    let active = true;
    const unsubscribe = window.overlook.backup.onEphemeralState((state) => {
      if (state.photoId !== photo.id) return;
      setEphemeralState(state);
      if (state.stage === 'error') rehydrateErrorRef.current?.();
    });
    void window.overlook.backup.ephemeralStatus({ photoId: photo.id }).then(({ stage }) => {
      if (active && stage !== null) setEphemeralState({ photoId: photo.id, stage });
    });
    if (remoteCustodyCandidate && !suppressRehydrate) {
      void window.overlook.backup.prepareEphemeral({ photoId: photo.id }).catch(() => rehydrateErrorRef.current?.());
    }
    return () => {
      active = false;
      unsubscribe();
      void window.overlook.backup.releaseEphemeral({ photoId: photo.id });
    };
  }, [photo.id, remoteCustodyCandidate, suppressRehydrate]);

  const ephemeralStage = ephemeralState?.photoId === photo.id ? ephemeralState.stage : null;

  // ADR-0026 §7: the full viewer plays animated GIF/WebP with source timing,
  // but under prefers-reduced-motion it opens on the static poster and waits
  // for an intentional play action. The choice resets on every photo change.
  const isVideo = photo.fileKind === 'video';
  const animated = (photo.fileKind === 'gif' || photo.fileKind === 'webp') && photo.mediaInfo?.animated === true;
  const reducedMotion = usePrefersReducedMotion();
  // Derived, not effect-reset: playback consent is held per photo id, so
  // paging to another item naturally returns to the poster.
  const [animationStartedFor, setAnimationStartedFor] = useState<string | null>(null);
  const animationStarted = animationStartedFor === photo.id;
  const posterHeld = animated && reducedMotion && !animationStarted;
  const animatedSource = imageSrc ?? fullUrl(photo.id);
  const source = posterHeld ? (posterSrc ?? thumbUrl(photo.id, 'mid')) : animatedSource;
  const sourceCustody = remoteCustodyCandidate && !suppressRehydrate ? 'offloaded' : 'local';
  const requestKey = `${photo.id}:${sourceCustody}:${source}`;

  const taken = photo.takenAt ?? photo.importedAt;
  const chromeClass = chrome ? ' ovl-lightbox__chrome--on' : '';
  useEffect(() => {
    announce(
      `${photo.fileName}, ${formatCalendarDate(taken)}${photo.place === null ? '' : `, ${photo.place}`}`,
      'polite',
      'lightbox-photo',
    );
  }, [announce, formatCalendarDate, photo.fileName, photo.place, taken]);
  useEffect(() => {
    if (ephemeralStage === null || ephemeralStage === 'released') return;
    const custodyMessage =
      ephemeralStage === 'fetching'
        ? 'Fetching original'
        : ephemeralStage === 'verifying'
          ? 'Verifying original'
          : ephemeralStage === 'ready'
            ? 'Streaming original. It will be offloaded again when the lightbox closes.'
            : (custody?.text ?? 'Original unavailable');
    announce(custodyMessage, ephemeralStage === 'error' ? 'assertive' : 'polite', 'lightbox-custody');
  }, [announce, custody?.text, ephemeralStage]);

  return (
    // The lightbox surface observes pointer activity and image/background clicks
    // without becoming a control itself; every actionable child remains a native
    // button with its own keyboard behavior.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={rootRef}
      className={`ovl-lightbox${inspectorOpen ? ' ovl-lightbox--docked' : ''}`}
      data-testid="lightbox"
      data-chrome={chrome ? 'on' : 'off'}
      onPointerDown={startClickGesture}
      onPointerMove={trackClickGesture}
      onPointerCancel={cancelClickGesture}
      onClick={hideForImageClick}
      onDoubleClickCapture={wakeChrome}
      onKeyDown={wakeChrome}
      onFocusCapture={wakeChrome}
      onBlurCapture={armTimer}
    >
      {isVideo ? (
        <LightboxVideo
          key={photo.id}
          photo={photo}
          src={imageSrc ?? fullUrl(photo.id)}
          posterSrc={posterSrc ?? thumbUrl(photo.id, 'mid')}
          chromeVisible={chrome}
          onActivity={wakeChrome}
          onExport={onExport}
          onTransfer={onTransfer}
        />
      ) : (
        <LightboxViewport
          key={requestKey}
          requestKey={requestKey}
          photo={photo}
          viewIntent={viewIntent}
          onViewIntentChange={setViewIntent}
          imageSrc={source}
          chromeVisible={chrome}
          onActivity={wakeChrome}
          onDimensionsResolved={onRepairDimensions}
          platform={platform}
        />
      )}
      {photo.fileKind === 'raw' ? (
        <span className={`ovl-lightbox__preview ovl-lightbox__chrome${chromeClass} mono-data`}>Preview</span>
      ) : null}
      {animated && reducedMotion ? (
        // Always visible (never chrome-faded): reduced-motion users must not
        // have to wake hover chrome to find the intentional playback action.
        <div className="ovl-lightbox__animation" data-testid="lightbox-animation-toggle">
          <Button
            size="md"
            icon={posterHeld ? 'play' : 'pause'}
            aria-pressed={!posterHeld}
            onClick={() => setAnimationStartedFor(posterHeld ? photo.id : null)}
          >
            {intl.formatMessage(posterHeld ? animationMessages.play : animationMessages.stop)}
          </Button>
        </div>
      ) : null}
      <div className={`ovl-lightbox__top ovl-lightbox__chrome${chromeClass}`}>
        <IconButton icon="arrow-left" label="Back to library (Esc)" onClick={onClose} />
        <span className="ovl-lightbox__title mono-data">
          {photo.fileName} — {formatCalendarDate(taken)}
        </span>
        <IconButton icon="star" label="Favorite" active={photo.favorite} onClick={onToggleFavorite} />
        <IconButton icon="share" label="Export" onClick={onExport} />
        {onTransfer === undefined ? null : <IconButton icon="refresh-cw" label="Transfer & Sync" onClick={onTransfer} />}
        {photo.syncState === 'synced' && photo.deletedAt === null ? (
          <IconButton icon="cloud-upload" label="Offload original" onClick={onOffload} />
        ) : null}
        <IconButton icon="info" label="Inspector (I)" active={inspectorOpen} onClick={onToggleInspector} />
        {photo.deletedAt === null ? (
          // Already-trashed rows use the grid's restore or purge ceremonies.
          <IconButton icon="trash-2" label={destructiveActions.movePhotosToTrash.label} onClick={onDelete} />
        ) : null}
        {/* Explicit close at the conventional corner (#269) — the back arrow
            reads as navigation, not dismissal, and Esc is invisible. */}
        <IconButton icon="x" label="Close (Esc)" onClick={onClose} />
      </div>
      <div className={`ovl-lightbox__nav ovl-lightbox__chrome${chromeClass}`}>
        <IconButton icon="chevron-left" size="lg" label={`Previous (${direction === 'rtl' ? '→' : '←'})`} onClick={onPrev} />
        <IconButton icon="chevron-right" size="lg" label={`Next (${direction === 'rtl' ? '←' : '→'})`} onClick={onNext} />
      </div>
      <div className={`ovl-lightbox__strip ovl-lightbox__chrome${chromeClass}`}>
        {isVideo ? null : <span className="ovl-lightbox__exif mono-data">{exifStrip(photo)}</span>}
        {remoteCustodyCandidate && ephemeralStage !== null && ephemeralStage !== 'released' ? (
          <div className="ovl-lightbox__custody">
            {ephemeralStage === 'fetching' ? <span className="mono-data">Fetching original…</span> : null}
            {ephemeralStage === 'verifying' ? <span className="mono-data">Verifying original…</span> : null}
            {ephemeralStage === 'ready' ? <span className="mono-data">Streaming original · re-offloads on close</span> : null}
            {ephemeralStage === 'error' ? <span className="mono-data">{custody?.text ?? 'Original unavailable'}</span> : null}
            {ephemeralStage === 'ready' && offloaded ? (
              <Button
                size="sm"
                icon="cloud-download"
                onClick={() => {
                  void window.overlook.backup.keepDownloaded({ photoId: photo.id }).catch(() => rehydrateErrorRef.current?.());
                }}
              >
                Keep downloaded
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
