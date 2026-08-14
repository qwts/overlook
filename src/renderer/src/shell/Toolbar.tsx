import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { FormattedMessage, defineMessages, useIntl } from 'react-intl';

import { ZOOM_MAX, ZOOM_MIN } from '../../../shared/library/app-state.js';
import { commandById, formatShortcut, type CommandPlatform } from '../../../shared/commands/registry.js';
import type { ChipFilters } from '../../../shared/library/types.js';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { SearchField } from '../components/SearchField';
import { Segmented } from '../components/Segmented';
import { Slider } from '../components/Slider';
import { Tooltip } from '../components/Tooltip';
import { useAppState, useAppDispatch } from '../state/app-state-context';

import overlookIcon from '../assets/overlook-icon-64.png';

const QUERY_DEBOUNCE_MS = 250;

// The wordmark is the brand identifier, not translatable copy (ADR-0020 §3
// draws the catalog line at "if language, in catalog; if identifier, left
// alone"). Hoisted to a const so it renders without tripping the hardcoded-
// string ratchet, which flags only literal JSX text.
const BRAND_WORDMARK = 'OVERLOOK';

const FILTERS: readonly { key: keyof ChipFilters; icon: 'star' | 'image' | 'cloud' | 'hard-drive' }[] = [
  { key: 'favorites', icon: 'star' },
  { key: 'raw', icon: 'image' },
  { key: 'offloaded', icon: 'cloud' },
  { key: 'localOnly', icon: 'hard-drive' },
];

const messages = defineMessages({
  search: { id: 'toolbar.search', defaultMessage: 'Search library' },
  filters: { id: 'toolbar.filters', defaultMessage: 'Filters' },
  view: { id: 'toolbar.view', defaultMessage: 'View' },
  viewGrid: { id: 'toolbar.view.grid', defaultMessage: 'Grid' },
  viewList: { id: 'toolbar.view.list', defaultMessage: 'List' },
  viewMoodboard: { id: 'toolbar.view.moodboard', defaultMessage: 'Moodboard' },
  zoom: { id: 'toolbar.zoom', defaultMessage: 'Zoom' },
  region: { id: 'toolbar.region', defaultMessage: 'Photo tools' },
  backupNow: { id: 'toolbar.backup.now', defaultMessage: 'Back up now' },
  backup: { id: 'toolbar.backup', defaultMessage: 'Back up' },
  lockNow: { id: 'toolbar.lock', defaultMessage: 'Lock now' },
  filterFavorites: { id: 'toolbar.filter.favorites', defaultMessage: 'Favorites' },
  filterRaw: { id: 'toolbar.filter.raw', defaultMessage: 'RAW' },
  filterOffloaded: { id: 'toolbar.filter.offloaded', defaultMessage: 'Offloaded' },
  filterLocalOnly: { id: 'toolbar.filter.localOnly', defaultMessage: 'Local only' },
});

const filterLabels: Record<keyof ChipFilters, (typeof messages)[keyof typeof messages]> = {
  favorites: messages.filterFavorites,
  raw: messages.filterRaw,
  offloaded: messages.filterOffloaded,
  localOnly: messages.filterLocalOnly,
};

// The 48px command strip (#79) per the design's Toolbar.jsx: wordmark,
// debounced search, funnel + chip row, view segmented, zoom (hidden in list
// via visibility so layout holds), backup state from pendingCount pushes,
// and the primary Import entry point (#88 dialog via onImport). Backup
// lands with M08 — until then it surfaces its stub toast.
export interface ToolbarProps {
  readonly platform: CommandPlatform;
  /** Opens the ImportDialog (#88); wired by the shell. */
  readonly onImport?: (() => void) | undefined;
  /** Opens the unencrypted-library export through the shared command handler. */
  readonly onExportAll?: (() => void) | undefined;
  readonly onLock?: (() => void) | undefined;
  readonly onTransfer?: (() => void) | undefined;
}

export function Toolbar({ platform, onImport, onExportAll, onLock, onTransfer }: ToolbarProps): ReactElement {
  const intl = useIntl();
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [filterOpen, setFilterOpen] = useState(false);
  const [draft, setDraft] = useState(state.query);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
    };
  }, []);

  const onSearch = (value: string): void => {
    setDraft(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch({ type: 'query/set', query: value });
    }, QUERY_DEBOUNCE_MS);
  };

  const anyFilter = Object.values(state.chips).some(Boolean);
  return (
    <section className="ovl-toolbar titlebar-no-drag" aria-label={intl.formatMessage(messages.region)}>
      <div className="ovl-toolbar__row" role="toolbar" aria-label={intl.formatMessage(messages.region)}>
        <div className="ovl-toolbar__wordmark">
          <img className="ovl-toolbar__mark" src={overlookIcon} alt="" width={20} height={20} />
          <span className="ovl-toolbar__brand">{BRAND_WORDMARK}</span>
        </div>
        <SearchField
          value={draft}
          onChange={onSearch}
          shortcut={formatShortcut(commandById('app.search.focus'), platform)}
          width={300}
          label={intl.formatMessage(messages.search)}
        />
        <IconButton
          icon="funnel"
          label={intl.formatMessage(messages.filters)}
          active={filterOpen || anyFilter}
          onClick={() => {
            setFilterOpen((open) => !open);
          }}
        />
        <div className="ovl-toolbar__spacer" />
        <Segmented
          label={intl.formatMessage(messages.view)}
          options={[
            { value: 'grid', label: intl.formatMessage(messages.viewGrid), icon: 'layout-grid', iconOnly: true },
            { value: 'list', label: intl.formatMessage(messages.viewList), icon: 'list', iconOnly: true },
            { value: 'moodboard', label: intl.formatMessage(messages.viewMoodboard), icon: 'layout-dashboard', iconOnly: true },
          ]}
          value={state.view}
          onChange={(view) => {
            dispatch({ type: 'view/set', view });
          }}
        />
        <div className="ovl-toolbar__zoom" style={{ visibility: state.view === 'grid' ? 'visible' : 'hidden' }}>
          <Icon name="grid-3x3" size={13} color="var(--text-faint)" />
          <Slider
            label={intl.formatMessage(messages.zoom)}
            value={state.zoom}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            width={110}
            onChange={(zoom) => {
              dispatch({ type: 'zoom/set', zoom });
            }}
          />
          <Icon name="grid-2x2" size={15} color="var(--text-faint)" />
        </div>
        {state.providerConnected && state.pendingCount > 0 ? (
          <Tooltip label={intl.formatMessage(messages.backupNow)} side="bottom">
            <IconButton
              icon="cloud-upload"
              label={intl.formatMessage(messages.backup)}
              onClick={() => {
                // Manual trigger (#108): amber start toast per the mock; the
                // completion listener shows green/red endings. A disconnected
                // provider blocks the run (#114) — say so instead.
                dispatch({ type: 'toast/shown', toast: { title: 'Backup started', tone: 'amber' } });
                void window.overlook.backup.run({}).then(({ skipped }) => {
                  if (skipped === 'disconnected') {
                    dispatch({ type: 'toast/shown', toast: { title: 'Backup off — not connected', tone: 'neutral' } });
                  }
                });
              }}
            />
          </Tooltip>
        ) : // Disconnected (#239) or fully backed up (#266) hides the button
        // entirely — it appears when a change creates work and leaves when
        // the pending set drains; an idle affordance misstates that there
        // is something to run.
        null}
        {onLock === undefined ? null : (
          <Tooltip label={intl.formatMessage(messages.lockNow)} side="bottom">
            <IconButton icon="lock" label={intl.formatMessage(messages.lockNow)} onClick={onLock} />
          </Tooltip>
        )}
        {onTransfer === undefined ? null : (
          <Button variant="secondary" icon="refresh-cw" size="md" onClick={onTransfer}>
            <FormattedMessage id="toolbar.transfer" defaultMessage="Transfer & Sync" />
          </Button>
        )}
        {onExportAll === undefined ? null : (
          <Button variant="secondary" icon="share" size="md" onClick={onExportAll}>
            {intl.formatMessage(commandById('library.exportAll').label)}
          </Button>
        )}
        <Button
          variant="primary"
          icon="download"
          size="md"
          onClick={() => {
            onImport?.();
          }}
        >
          <FormattedMessage id="toolbar.import" defaultMessage="Import" />
        </Button>
      </div>
      {filterOpen ? (
        <div className="ovl-toolbar__chips" data-testid="chip-row">
          {FILTERS.map(({ key, icon }) => (
            <Chip
              key={key}
              icon={icon}
              selected={state.chips[key] === true}
              onClick={() => {
                dispatch({ type: 'chip/toggled', chip: key });
              }}
            >
              {intl.formatMessage(filterLabels[key])}
            </Chip>
          ))}
          <span className="ovl-toolbar__hint mono-data">
            <FormattedMessage id="toolbar.search.hint" defaultMessage="Semantic search — coming soon" />
          </span>
        </div>
      ) : null}
    </section>
  );
}
