import { useCallback, useEffect, useRef } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import './overlays.css';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';
import { useAnnouncer } from './LiveAnnouncer';

export type ToastTone = 'neutral' | 'green' | 'amber' | 'red';

const TONES: Record<ToastTone, { icon: IconName; color: string }> = {
  neutral: { icon: 'info', color: 'var(--text-muted)' },
  green: { icon: 'shield-check', color: 'var(--accent-green)' },
  amber: { icon: 'cloud-upload', color: 'var(--accent-amber)' },
  red: { icon: 'triangle-alert', color: 'var(--accent-red)' },
};

const messages = defineMessages({
  announcement: {
    id: 'toast.announcement',
    defaultMessage: '{title} — {detail}',
  },
  dismiss: {
    id: 'toast.dismiss',
    defaultMessage: 'Dismiss notification',
  },
  notification: {
    id: 'toast.notification',
    defaultMessage: 'Notification',
  },
});

export interface ToastProps {
  readonly tone?: ToastTone;
  readonly icon?: IconName;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
  readonly announce?: boolean;
  readonly onDismiss?: () => void;
}

// feedback/Toast.jsx + aria-live (#59): role=status announces politely.
export function Toast({ tone = 'neutral', icon, title, detail, action, announce = true, onDismiss }: ToastProps): ReactElement {
  const intl = useIntl();
  const t = TONES[tone];
  return (
    <div role={announce ? 'status' : undefined} className="ovl-toast">
      <Icon name={icon ?? t.icon} size={16} color={t.color} />
      <div className="ovl-toast__content">
        <div className="ovl-toast__title">{title}</div>
        {detail === undefined ? null : <div className="ovl-toast__detail">{detail}</div>}
      </div>
      {action}
      {onDismiss === undefined ? null : <IconButton icon="x" label={intl.formatMessage(messages.dismiss)} size="sm" onClick={onDismiss} />}
    </div>
  );
}

export interface ToastItem extends ToastProps {
  readonly id: string;
}

export interface ToastHostProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: string) => void;
  readonly className?: string;
  /** 4s per the design; stories inject a short value to test dismissal. */
  readonly autoDismissMs?: number;
}

function useToastPauseListeners(
  containerRef: RefObject<HTMLDivElement | null>,
  pause: (reason: 'pointer' | 'focus') => void,
  resume: (reason: 'pointer' | 'focus') => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onPointerEnter = (): void => pause('pointer');
    const onPointerLeave = (): void => resume('pointer');
    const onFocusIn = (): void => pause('focus');
    const onFocusOut = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) resume('focus');
    };
    container.addEventListener('pointerenter', onPointerEnter);
    container.addEventListener('pointerleave', onPointerLeave);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    return () => {
      container.removeEventListener('pointerenter', onPointerEnter);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
    };
  }, [containerRef, pause, resume]);
}

function ToastTimer({
  toast,
  onDismiss,
  autoDismissMs,
}: {
  readonly toast: ToastItem;
  readonly onDismiss: (id: string) => void;
  readonly autoDismissMs: number;
}): ReactElement {
  const intl = useIntl();
  const onDismissRef = useRef(onDismiss);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineRef = useRef(0);
  const remainingRef = useRef(autoDismissMs);
  const pointerPausedRef = useRef(false);
  const focusPausedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const startTimer = useCallback((): void => {
    if (toast.action !== undefined || pointerPausedRef.current || focusPausedRef.current || timerRef.current !== null) return;
    const delay = remainingRef.current;
    deadlineRef.current = Date.now() + delay;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onDismissRef.current(toast.id);
    }, delay);
  }, [toast.action, toast.id]);
  useEffect(() => {
    remainingRef.current = autoDismissMs;
    pointerPausedRef.current = false;
    focusPausedRef.current = false;
    startTimer();
    return () => {
      clearTimer();
    };
  }, [toast, autoDismissMs, clearTimer, startTimer]);

  const pause = useCallback(
    (reason: 'pointer' | 'focus'): void => {
      if (reason === 'pointer') pointerPausedRef.current = true;
      else focusPausedRef.current = true;
      if (timerRef.current !== null) {
        remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
        clearTimer();
      }
    },
    [clearTimer],
  );
  const resume = useCallback(
    (reason: 'pointer' | 'focus'): void => {
      if (reason === 'pointer') pointerPausedRef.current = false;
      else focusPausedRef.current = false;
      startTimer();
    },
    [startTimer],
  );
  useToastPauseListeners(containerRef, pause, resume);

  return (
    <div ref={containerRef} role="group" aria-label={intl.formatMessage(messages.notification)}>
      <Toast {...toast} announce={false} onDismiss={() => onDismissRef.current(toast.id)} />
    </div>
  );
}

// Bottom-right stack; action toasts stay until acted on or dismissed. Timed
// toasts preserve their remaining duration while hovered or focused (#411).
export function ToastHost({ toasts, onDismiss, className, autoDismissMs = 4000 }: ToastHostProps): ReactElement {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const latest = toasts.at(-1);
  const announcement =
    latest?.detail === undefined
      ? latest?.title
      : intl.formatMessage(messages.announcement, { title: latest.title, detail: latest.detail });
  useEffect(() => {
    // A surface that announces its own outcome raises a silent toast (#1305).
    if (announcement !== undefined && latest?.announce !== false) {
      announce(announcement, latest?.tone === 'red' ? 'assertive' : 'polite');
    }
  }, [announce, announcement, latest]);
  return (
    <div className={['ovl-toast-host', className].filter(Boolean).join(' ')}>
      {toasts.map((toast) => (
        <ToastTimer key={toast.id} toast={toast} onDismiss={onDismiss} autoDismissMs={autoDismissMs} />
      ))}
    </div>
  );
}
