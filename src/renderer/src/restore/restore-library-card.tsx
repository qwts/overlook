import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { RestoreLibrarySummary } from '../../../shared/backup/restore-contract.js';
import { useFormats } from '../i18n/use-formats.js';
import { Badge } from '../components/Badge.js';
import { CopyableValue } from '../components/CopyableValue.js';

const messages = defineMessages({
  copyLibraryId: { id: 'restore.copy.libraryId', defaultMessage: 'library ID' },
  selectLibrary: { id: 'restore.select.library', defaultMessage: 'Select library {libraryId}' },
});

export function RestoreLibraryCard({
  library,
  selected,
  onSelect,
}: {
  readonly library: RestoreLibrarySummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const intl = useIntl();
  const { formatBytes, formatCount } = useFormats();
  const valid = library.validation === 'valid';
  return (
    <div className={`ovl-restore__library${selected ? ' ovl-restore__library--selected' : ''}`} data-testid="restore-library-card">
      <div className="ovl-restore__libraryHead">
        <CopyableValue
          value={library.libraryId}
          label={intl.formatMessage(messages.copyLibraryId)}
          textClassName="ovl-restore__libraryId"
        />
        <Badge tone={valid ? 'green' : library.validation === 'unsupported' ? 'amber' : 'red'}>
          {valid ? 'Validated' : library.validation.replace('-', ' ')}
        </Badge>
      </div>
      <button
        type="button"
        className="ovl-restore__librarySelect"
        disabled={!valid}
        aria-pressed={selected}
        aria-label={intl.formatMessage(messages.selectLibrary, { libraryId: library.libraryId })}
        onClick={onSelect}
      >
        {valid ? (
          <div className="ovl-restore__meta mono-data">
            Gen {String(library.generation)} · {formatCount(library.photos ?? 0)} photos · {formatBytes(library.totalBytes ?? 0)} ·{' '}
            {formatCount(library.albums ?? 0)} albums
          </div>
        ) : (
          <div className="ovl-restore__meta">Metadata is unavailable until this backup validates.</div>
        )}
        {library.generatedAt === null ? null : (
          <div className="ovl-restore__date">
            Backed up {intl.formatDate(library.generatedAt, { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        )}
        {library.fallbackGenerations > 0 ? (
          <div className="ovl-restore__notice">{formatCount(library.fallbackGenerations)} retained fallback generation available</div>
        ) : null}
        {library.resumable ? <div className="ovl-restore__notice">Verified staged work is ready to resume</div> : null}
      </button>
    </div>
  );
}
