import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { IconButton } from './IconButton.js';
import { useAnnouncer } from './LiveAnnouncer.js';
import { Tooltip } from './Tooltip.js';

import './controls.css';

const messages = defineMessages({
  copy: { id: 'copyableValue.copy', defaultMessage: 'Copy {label}' },
  copied: { id: 'copyableValue.copied', defaultMessage: 'Copied {label}.' },
  failed: { id: 'copyableValue.failed', defaultMessage: 'Could not copy {label}.' },
});

export type CopyValue = (value: string) => Promise<void>;

const writeToClipboard: CopyValue = (value) => window.overlook.clipboard.writeText(value);

export interface CopyableValueProps {
  /** Exact text rendered and written to the clipboard. */
  readonly value: string;
  /** Localized semantic name used by the button and live feedback. */
  readonly label: string;
  readonly className?: string;
  readonly textClassName?: string;
  /** Injectable for Storybook and for hosts that require a clipboard bridge. */
  readonly copy?: CopyValue;
}

/** Real selectable machine text with one keyboard-accessible copy action. */
export function CopyableValue({ value, label, className, textClassName, copy = writeToClipboard }: CopyableValueProps): ReactElement {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const copyLabel = intl.formatMessage(messages.copy, { label });
  const classes = ['ovl-copyable-value', className].filter(Boolean).join(' ');
  const textClasses = ['mono-data', 'ovl-copyable-value__text', textClassName].filter(Boolean).join(' ');
  const handleCopy = async (): Promise<void> => {
    try {
      await copy(value);
      announce(intl.formatMessage(messages.copied, { label }), 'polite', `copy-success:${label}`);
    } catch {
      announce(intl.formatMessage(messages.failed, { label }), 'assertive', `copy-failure:${label}`);
    }
  };

  return (
    <span className={classes}>
      <span className={textClasses}>{value}</span>
      <Tooltip label={copyLabel}>
        <IconButton
          icon="copy"
          label={copyLabel}
          size="sm"
          onClick={() => {
            void handleCopy();
          }}
        />
      </Tooltip>
    </span>
  );
}
