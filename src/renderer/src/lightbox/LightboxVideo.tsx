import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { formatDuration, preservedCodecLabel } from '../../../shared/library/media-info-format.js';
import { derivePlayability, type DeviceMediaCapabilities } from '../../../shared/library/playability.js';
import type { PhotoRecord } from '../../../shared/library/types.js';
import { deviceMediaCapabilities } from '../media/device-capabilities.js';
import { createTransportStreamRemux, type TransportStreamRemux } from '../media/ts-remux.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { usePrefersReducedMotion } from './use-reduced-motion.js';

import './lightbox-video.css';

// ADR-0026 §5/§7 + the Video & Apple media spec: the full viewer is the
// Lightbox with a native <video> surface swapped for the <img>. Playback is
// intentional (never autostarts), keyboard-operable, and announced through a
// single polite live region. Preserved-only and decode-error states are honest
// and keep every custody action available. MPEG-TS inherits all of it; until
// the §5 remux adapter + Range-served overlook-full:// land, TS resolves
// preserved-only here (deviceMediaCapabilities), so the transport is exercised
// by stories rather than a live TS stream today.

const messages = defineMessages({
  player: { id: 'lightbox.video.player', defaultMessage: 'Video player — {name}' },
  play: { id: 'lightbox.video.play', defaultMessage: 'Play video' },
  pause: { id: 'lightbox.video.pause', defaultMessage: 'Pause' },
  seek: { id: 'lightbox.video.seek', defaultMessage: 'Seek' },
  seekValue: { id: 'lightbox.video.seekValue', defaultMessage: '{at} of {total}' },
  volume: { id: 'lightbox.video.volume', defaultMessage: 'Volume' },
  mute: { id: 'lightbox.video.mute', defaultMessage: 'Mute' },
  unmute: { id: 'lightbox.video.unmute', defaultMessage: 'Unmute' },
  fullscreen: { id: 'lightbox.video.fullscreen', defaultMessage: 'Full screen' },
  preservedHeading: { id: 'lightbox.video.preservedHeading', defaultMessage: "Can't play on this device" },
  preservedBody: {
    id: 'lightbox.video.preservedBody',
    defaultMessage: 'This {codec} video is saved and protected. It just can’t be decoded here.',
  },
  errorHeading: { id: 'lightbox.video.errorHeading', defaultMessage: 'Playback stopped' },
  errorBody: {
    id: 'lightbox.video.errorBody',
    defaultMessage: 'This video couldn’t be decoded. The original is unchanged and can still be exported.',
  },
  tryAgain: { id: 'lightbox.video.tryAgain', defaultMessage: 'Try again' },
  exportOriginal: { id: 'lightbox.video.exportOriginal', defaultMessage: 'Export original' },
  moveToTrail: { id: 'lightbox.video.moveToTrail', defaultMessage: 'Move to Image Trail' },
  loading: { id: 'lightbox.video.loading', defaultMessage: 'Loading video…' },
  annPlaying: { id: 'lightbox.video.ann.playing', defaultMessage: 'Playing.' },
  annPaused: { id: 'lightbox.video.ann.paused', defaultMessage: 'Paused.' },
  annMuted: { id: 'lightbox.video.ann.muted', defaultMessage: 'Muted.' },
  annUnmuted: { id: 'lightbox.video.ann.unmuted', defaultMessage: 'Unmuted.' },
  annEnded: { id: 'lightbox.video.ann.ended', defaultMessage: 'Video ended.' },
  annPreserved: {
    id: 'lightbox.video.ann.preserved',
    defaultMessage: 'This video can’t be played on this device. The original is saved and can be exported.',
  },
  annError: { id: 'lightbox.video.ann.error', defaultMessage: 'Video couldn’t be played. The original is unchanged.' },
});

export interface LightboxVideoProps {
  readonly photo: PhotoRecord;
  /** Range-served original (overlook-full://); Storybook injects a bundled URL. */
  readonly src: string;
  /** Poster/placeholder shown at rest and behind the transport. */
  readonly posterSrc?: string | undefined;
  readonly chromeVisible: boolean;
  readonly onActivity: () => void;
  readonly onExport: () => void;
  readonly onTransfer?: (() => void) | undefined;
  /** Injectable for stories/tests; production derives from the live device. */
  readonly capabilities?: DeviceMediaCapabilities | undefined;
}

export function LightboxVideo({
  photo,
  src,
  posterSrc,
  chromeVisible,
  onActivity,
  onExport,
  onTransfer,
  capabilities,
}: LightboxVideoProps): ReactElement {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const reducedMotion = usePrefersReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const remuxRef = useRef<TransportStreamRemux | null>(null);

  const tier = derivePlayability('video', photo.mediaInfo, capabilities ?? deviceMediaCapabilities());
  const preserved = tier === 'preserved-only';
  // MPEG-TS is not servable to <video> directly; it plays through the §5 remux
  // adapter (TS → fMP4 over MediaSource). Other containers set src directly.
  const isTransportStream = photo.mediaInfo?.container === 'MPEG-TS';
  const durationHint = photo.mediaInfo?.durationSeconds ?? 0;

  const [started, setStarted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationHint);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.7);
  const [buffering, setBuffering] = useState(false);
  const [errored, setErrored] = useState(false);

  const name = photo.fileName;
  const ann = useCallback(
    (id: 'annPreserved' | 'annError' | 'annPlaying' | 'annPaused' | 'annEnded') =>
      announce(intl.formatMessage(messages[id]), 'polite', 'lightbox-video'),
    [announce, intl],
  );

  // Playback consent + transport state reset on photo change by remount: the
  // parent keys this component on photo.id, so no cross-photo state leaks and
  // paging always returns to the poster (never autostarts anywhere).
  useEffect(() => {
    if (preserved) ann('annPreserved');
  }, [preserved, ann]);

  // Tear the remux player down on unmount (photo change remounts via key).
  useEffect(
    () => () => {
      remuxRef.current?.destroy();
      remuxRef.current = null;
    },
    [],
  );

  const play = useCallback(() => {
    setStarted(true);
    onActivity();
    const el = videoRef.current;
    if (el === null) return;
    const fail = (): void => {
      setErrored(true);
      ann('annError');
    };
    if (isTransportStream) {
      const adapter = createTransportStreamRemux(el, src);
      remuxRef.current = adapter;
      if (adapter !== null) {
        void adapter.play().catch(fail);
        return;
      }
    }
    void el.play().catch(fail);
  }, [onActivity, ann, isTransportStream, src]);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (el === null) return;
    if (el.paused) void el.play().catch(() => setErrored(true));
    else el.pause();
  }, []);

  const seekBy = useCallback(
    (delta: number) => {
      const el = videoRef.current;
      if (el === null) return;
      el.currentTime = Math.min(el.duration || duration, Math.max(0, el.currentTime + delta));
      setCurrent(el.currentTime);
    },
    [duration],
  );

  const setVol = useCallback((next: number) => {
    const clamped = Math.min(1, Math.max(0, next));
    setVolume(clamped);
    setMuted(false);
    const el = videoRef.current;
    if (el !== null) {
      el.volume = clamped;
      el.muted = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      if (videoRef.current !== null) videoRef.current.muted = next;
      announce(intl.formatMessage(next ? messages.annMuted : messages.annUnmuted), 'polite', 'lightbox-video');
      return next;
    });
  }, [announce, intl]);

  if (preserved || errored) {
    const heading = errored ? messages.errorHeading : messages.preservedHeading;
    const body = errored
      ? intl.formatMessage(messages.errorBody)
      : intl.formatMessage(messages.preservedBody, { codec: preservedCodecLabel(photo.mediaInfo) });
    return (
      <div className="ovl-video ovl-video--static" role="group" aria-label={intl.formatMessage(messages.player, { name })}>
        {posterSrc === undefined ? (
          <div className="ovl-video__placeholder" />
        ) : (
          <img className="ovl-video__poster" src={posterSrc} alt="" />
        )}
        <div className="ovl-video__notice" data-variant={errored ? 'error' : 'preserved'}>
          <span className="ovl-video__notice-glyph">
            <Icon name={errored ? 'triangle-alert' : 'film'} size={20} />
          </span>
          <h2 className="ovl-video__notice-heading">{intl.formatMessage(heading)}</h2>
          <p className="ovl-video__notice-body">{body}</p>
          <div className="ovl-video__notice-actions">
            {errored ? (
              <Button size="sm" icon="refresh-cw" onClick={() => setErrored(false)}>
                {intl.formatMessage(messages.tryAgain)}
              </Button>
            ) : null}
            <Button size="sm" icon="share" onClick={onExport}>
              {intl.formatMessage(messages.exportOriginal)}
            </Button>
            {onTransfer === undefined ? null : (
              <Button size="sm" variant="ghost" icon="refresh-cw" onClick={onTransfer}>
                {intl.formatMessage(messages.moveToTrail)}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const chromeClass = chromeVisible ? ' ovl-video__transport--on' : '';
  return (
    <div className="ovl-video" role="group" aria-label={intl.formatMessage(messages.player, { name })}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- caption/track UI
          is surfaced only when the container carries subtitle tracks (ADR-0026
          §7); MPEG-TS v1 carries none and transcript support is a §10 follow-up. */}
      <video
        ref={videoRef}
        className="ovl-video__el"
        src={started && !isTransportStream ? src : undefined}
        poster={posterSrc}
        playsInline
        preload="none"
        onPlay={() => {
          setPlaying(true);
          ann('annPlaying');
        }}
        onPause={() => {
          setPlaying(false);
          ann('annPaused');
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : durationHint)}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onVolumeChange={(e) => setVolume(e.currentTarget.volume)}
        onEnded={() => {
          setPlaying(false);
          setStarted(false);
          ann('annEnded');
        }}
        onError={() => {
          setErrored(true);
          ann('annError');
        }}
      />
      {started ? null : (
        <button type="button" className="ovl-video__bigplay" aria-label={intl.formatMessage(messages.play)} onClick={play}>
          <Icon name="play" size={28} />
        </button>
      )}
      {started && buffering ? (
        <div className="ovl-video__buffering" role="status">
          {reducedMotion ? <span className="mono-data">{intl.formatMessage(messages.loading)}</span> : <Icon name="loader" size={28} />}
        </div>
      ) : null}
      {started ? (
        <div className={`ovl-video__transport${chromeClass}`} onPointerMove={onActivity}>
          <div className="ovl-video__scrubrow">
            <span className="ovl-video__time mono-data">{formatDuration(current)}</span>
            <div
              className="ovl-video__seek"
              role="slider"
              tabIndex={0}
              aria-label={intl.formatMessage(messages.seek)}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(current)}
              aria-valuetext={intl.formatMessage(messages.seekValue, { at: formatDuration(current), total: formatDuration(duration) })}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  e.stopPropagation();
                  seekBy(5);
                } else if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  e.stopPropagation();
                  seekBy(-5);
                }
              }}
            >
              <div className="ovl-video__seek-fill" style={{ inlineSize: `${duration > 0 ? (current / duration) * 100 : 0}%` }} />
            </div>
            <span className="ovl-video__time mono-data">{formatDuration(duration)}</span>
          </div>
          <div className="ovl-video__buttons">
            <button
              type="button"
              className="ovl-video__ctl"
              aria-label={intl.formatMessage(playing ? messages.pause : messages.play)}
              onClick={togglePlay}
            >
              <Icon name={playing ? 'pause' : 'play'} size={16} />
            </button>
            <button
              type="button"
              className="ovl-video__ctl"
              aria-label={intl.formatMessage(muted ? messages.unmute : messages.mute)}
              onClick={toggleMute}
            >
              <Icon name={muted ? 'volume-x' : 'volume-2'} size={16} />
            </button>
            <div
              className="ovl-video__vol"
              role="slider"
              tabIndex={0}
              aria-label={intl.formatMessage(messages.volume)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setVol(volume + 0.05);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setVol(volume - 0.05);
                }
              }}
            >
              <div className="ovl-video__vol-fill" style={{ inlineSize: `${(muted ? 0 : volume) * 100}%` }} />
            </div>
            <span className="ovl-video__spacer" />
            <button
              type="button"
              className="ovl-video__ctl"
              aria-label={intl.formatMessage(messages.fullscreen)}
              onClick={() => {
                void videoRef.current?.requestFullscreen?.();
              }}
            >
              <Icon name="maximize" size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
