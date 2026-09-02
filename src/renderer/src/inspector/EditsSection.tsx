import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { MetadataRow } from '../components/MetadataRow';
import { usePhotoEdits } from '../lightbox/use-photo-edits';

// Inspector "Edits" section (#493, ADR-0031 §2): what the persisted head
// applies to the original and how many revisions the photo carries. Reads
// the same head the lightbox edits; hidden when no edit bridge is reachable.

const messages = defineMessages({
  title: { id: 'inspector.edits.title', defaultMessage: 'Edits' },
  revisions: { id: 'inspector.edits.revisions', defaultMessage: 'Revisions' },
  applied: { id: 'inspector.edits.applied', defaultMessage: 'Applied' },
  none: { id: 'inspector.edits.none', defaultMessage: 'Original — no edits' },
  rotated: { id: 'inspector.edits.rotated', defaultMessage: 'Rotated {degrees}°' },
  flipped: { id: 'inspector.edits.flipped', defaultMessage: 'Flipped' },
  cropped: { id: 'inspector.edits.cropped', defaultMessage: 'Cropped to {width}% × {height}%' },
  unsupported: { id: 'inspector.edits.unsupported', defaultMessage: 'Newer format — view only' },
  separator: { id: 'inspector.edits.separator', defaultMessage: ' · ' },
});

const SECTION_CLASS = 'ovl-inspector__section';
const TITLE_CLASS = 'ovl-inspector__sectionTitle';
const TEST_ID = 'inspector-edits';
const UNSUPPORTED_TONE = 'var(--accent-amber)';

export function EditsSection({ photoId }: { readonly photoId: string }): ReactElement | null {
  const intl = useIntl();
  const edits = usePhotoEdits(photoId);
  const payload = edits.state.head;
  if (!edits.available || payload === null) return null;
  const head = payload.head;
  const parts: string[] = [];
  if (head !== null && head.unsupported === null) {
    const { transform } = head;
    if (transform.quarterTurns !== 0) parts.push(intl.formatMessage(messages.rotated, { degrees: transform.quarterTurns * 90 }));
    if (transform.flipped) parts.push(intl.formatMessage(messages.flipped));
    if (transform.crop !== null) {
      parts.push(
        intl.formatMessage(messages.cropped, {
          width: Math.round(transform.crop.width * 100),
          height: Math.round(transform.crop.height * 100),
        }),
      );
    }
  }
  const unsupported = head !== null && head.unsupported !== null;
  const applied = unsupported
    ? intl.formatMessage(messages.unsupported)
    : parts.length === 0
      ? intl.formatMessage(messages.none)
      : parts.join(intl.formatMessage(messages.separator));
  return (
    <section className={SECTION_CLASS} data-testid={TEST_ID}>
      <h3 className={TITLE_CLASS}>{intl.formatMessage(messages.title)}</h3>
      <MetadataRow label={intl.formatMessage(messages.revisions)} value={intl.formatNumber(payload.history.length)} />
      <MetadataRow label={intl.formatMessage(messages.applied)} value={applied} {...(unsupported ? { tone: UNSUPPORTED_TONE } : {})} />
    </section>
  );
}
