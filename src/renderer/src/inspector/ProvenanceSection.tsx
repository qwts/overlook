import type { ReactElement } from 'react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';

import { Badge, type BadgeTone } from '../components/Badge';
import { Button } from '../components/Button';
import type { IconName } from '../components/Icon.js';
import { MetadataRow } from '../components/MetadataRow';
import { useFormats } from '../i18n/use-formats.js';
import {
  credentialOutcome,
  strongestClaim,
  type ProvenanceClaim,
  type ProvenanceSource,
  type ProvenanceTier,
} from '../../../shared/library/provenance.js';
import { usePhotoProvenance, type PhotoProvenanceApi } from './use-photo-provenance';

// Inspector "Provenance" section (#495, ADR-0031 §5): the evidence tier as a
// badge, the one-line honest summary, every source verbatim, when it was
// checked, and the limitation that applies to the tier. Unknown is never
// worded as human-made; a present credential this build cannot validate is
// never worded as verified.

const messages = defineMessages({
  title: { id: 'inspector.provenance.title', defaultMessage: 'Provenance' },
  tierVerified: { id: 'inspector.provenance.tier.verified', defaultMessage: 'Verified provenance' },
  tierDeclared: { id: 'inspector.provenance.tier.declared', defaultMessage: 'Declared' },
  tierDetected: { id: 'inspector.provenance.tier.detected', defaultMessage: 'Detected' },
  tierUnknown: { id: 'inspector.provenance.tier.unknown', defaultMessage: 'Unknown' },
  claimGenerated: { id: 'inspector.provenance.claim.generated', defaultMessage: 'AI-generated' },
  claimEdited: { id: 'inspector.provenance.claim.edited', defaultMessage: 'AI-edited' },
  claimTool: { id: 'inspector.provenance.claim.tool', defaultMessage: 'Tool named' },
  claimCapture: { id: 'inspector.provenance.claim.capture', defaultMessage: 'Capture declared' },
  summaryVerified: { id: 'inspector.provenance.summary.verified', defaultMessage: 'Content Credentials valid for these bytes' },
  summaryInvalid: { id: 'inspector.provenance.summary.invalid', defaultMessage: 'Content Credentials invalid for these bytes' },
  summaryUnverifiable: {
    id: 'inspector.provenance.summary.unverifiable',
    defaultMessage: 'Content Credentials present — not validated by this build',
  },
  summaryDeclared: { id: 'inspector.provenance.summary.declared', defaultMessage: '{claim} — declared by metadata, not verified' },
  summaryDetected: { id: 'inspector.provenance.summary.detected', defaultMessage: 'Detector report — not verified' },
  summaryUnknown: { id: 'inspector.provenance.summary.unknown', defaultMessage: 'No supported evidence' },
  summaryUnsupported: { id: 'inspector.provenance.summary.unsupported', defaultMessage: 'Newer evidence format — view only' },
  summaryPending: { id: 'inspector.provenance.summary.pending', defaultMessage: 'Not checked yet' },
  noteUnknown: { id: 'inspector.provenance.note.unknown', defaultMessage: 'Unknown is not a claim that a person made this image.' },
  noteDeclared: {
    id: 'inspector.provenance.note.declared',
    defaultMessage: 'Declarations can be added, changed, or removed by any tool. They are not proof.',
  },
  noteDetected: {
    id: 'inspector.provenance.note.detected',
    defaultMessage: 'Detectors have false positives and false negatives. {limits}',
  },
  noteVerified: { id: 'inspector.provenance.note.verified', defaultMessage: 'Validated locally against {validator}.' },
  stale: { id: 'inspector.provenance.stale', defaultMessage: 'Re-check needed — the bytes or the checker changed' },
  deferred: { id: 'inspector.provenance.deferred', defaultMessage: 'Original not local — checked when it returns' },
  local: { id: 'inspector.provenance.local', defaultMessage: 'Local check only · no network' },
  evidence: { id: 'inspector.provenance.evidence', defaultMessage: 'Evidence' },
  checked: { id: 'inspector.provenance.checked', defaultMessage: 'Checked' },
  originXmp: { id: 'inspector.provenance.origin.xmp', defaultMessage: 'XMP' },
  originExif: { id: 'inspector.provenance.origin.exif', defaultMessage: 'EXIF' },
  originPng: { id: 'inspector.provenance.origin.png', defaultMessage: 'PNG text' },
  originSidecar: { id: 'inspector.provenance.origin.sidecar', defaultMessage: 'Sidecar' },
  originCredential: { id: 'inspector.provenance.origin.credential', defaultMessage: 'Credential' },
  originDetector: { id: 'inspector.provenance.origin.detector', defaultMessage: 'Detector' },
  declarationValue: { id: 'inspector.provenance.value.declaration', defaultMessage: '{field}: {value}' },
  credentialValue: { id: 'inspector.provenance.value.credential', defaultMessage: 'C2PA · {container} · {bytes} bytes · {outcome}' },
  detectorValue: { id: 'inspector.provenance.value.detector', defaultMessage: '{name} {version} · {result}' },
  detectorConfidence: { id: 'inspector.provenance.value.detectorConfidence', defaultMessage: '{name} {version} · {result} · {confidence}' },
  refresh: { id: 'inspector.provenance.refresh', defaultMessage: 'Re-check' },
  checking: { id: 'inspector.provenance.checking', defaultMessage: 'Checking…' },
});

const SECTION_CLASS = 'ovl-inspector__section';
const TITLE_CLASS = 'ovl-inspector__sectionTitle';
const BADGES_CLASS = 'ovl-inspector__badges';
const NOTE_CLASS = 'ovl-inspector__provenanceNote';
const ACTIONS_CLASS = 'ovl-inspector__provenanceActions';
const TEST_ID = 'inspector-provenance';
const TIER_TEST_ID = 'inspector-provenance-tier';
const STALE_TONE = 'var(--accent-amber)';

const TIER_PRESENTATION: Readonly<
  Record<ProvenanceTier, { readonly tone: BadgeTone; readonly icon: IconName; readonly label: keyof typeof messages }>
> = {
  verified: { tone: 'green', icon: 'shield-check', label: 'tierVerified' },
  declared: { tone: 'cyan', icon: 'info', label: 'tierDeclared' },
  detected: { tone: 'amber', icon: 'eye', label: 'tierDetected' },
  unknown: { tone: 'neutral', icon: 'info', label: 'tierUnknown' },
};

const CLAIM_LABEL: Readonly<Record<ProvenanceClaim, keyof typeof messages>> = {
  generated: 'claimGenerated',
  edited: 'claimEdited',
  tool: 'claimTool',
  capture: 'claimCapture',
};

function summaryOf(intl: IntlShape, tier: ProvenanceTier, sources: readonly ProvenanceSource[]): string {
  const credential = credentialOutcome(sources);
  if (credential === 'valid') return intl.formatMessage(messages.summaryVerified);
  if (credential === 'invalid') return intl.formatMessage(messages.summaryInvalid);
  const claim = strongestClaim(sources);
  if (claim !== null) return intl.formatMessage(messages.summaryDeclared, { claim: intl.formatMessage(messages[CLAIM_LABEL[claim]]) });
  if (credential === 'unverifiable') return intl.formatMessage(messages.summaryUnverifiable);
  return intl.formatMessage(tier === 'detected' ? messages.summaryDetected : messages.summaryUnknown);
}

function noteOf(intl: IntlShape, tier: ProvenanceTier, sources: readonly ProvenanceSource[]): string {
  switch (tier) {
    case 'verified': {
      const validator = sources.find((source) => source.kind === 'credential' && source.outcome === 'valid');
      return intl.formatMessage(messages.noteVerified, { validator: validator?.kind === 'credential' ? (validator.validator ?? '') : '' });
    }
    case 'declared':
      return intl.formatMessage(messages.noteDeclared);
    case 'detected': {
      const limits = sources.flatMap((source) => (source.kind === 'detector' ? [source.limits] : []));
      return intl.formatMessage(messages.noteDetected, { limits: limits.join(' ') });
    }
    case 'unknown':
      return intl.formatMessage(messages.noteUnknown);
  }
}

function sourceRow(intl: IntlShape, source: ProvenanceSource): { readonly label: string; readonly value: string } {
  switch (source.kind) {
    case 'credential':
      return {
        label: intl.formatMessage(messages.originCredential),
        value: intl.formatMessage(messages.credentialValue, {
          container: source.container,
          bytes: intl.formatNumber(source.bytes),
          outcome: source.outcome,
        }),
      };
    case 'detector':
      return {
        label: intl.formatMessage(messages.originDetector),
        value:
          source.confidence === null
            ? intl.formatMessage(messages.detectorValue, { name: source.name, version: source.version, result: source.result })
            : intl.formatMessage(messages.detectorConfidence, {
                name: source.name,
                version: source.version,
                result: source.result,
                confidence: intl.formatNumber(source.confidence, { style: 'percent' }),
              }),
      };
    case 'declaration': {
      const origin = {
        xmp: messages.originXmp,
        exif: messages.originExif,
        'png-text': messages.originPng,
        'xmp-sidecar': messages.originSidecar,
      }[source.origin];
      return {
        label: intl.formatMessage(origin),
        value: intl.formatMessage(messages.declarationValue, { field: source.field, value: source.value }),
      };
    }
  }
}

export interface ProvenanceSectionProps {
  readonly photoId: string;
  /** Test/story seam; production resolves the preload bridge. */
  readonly api?: PhotoProvenanceApi;
}

export function ProvenanceSection({ photoId, api }: ProvenanceSectionProps): ReactElement | null {
  const intl = useIntl();
  const { formatCalendarDate } = useFormats();
  const provenance = usePhotoProvenance(photoId, api);
  if (!provenance.available) return null;
  const payload = provenance.payload;
  const evidence = payload?.evidence ?? null;
  const tier: ProvenanceTier = evidence?.tier ?? 'unknown';
  const sources = evidence?.sources ?? [];
  const presentation = TIER_PRESENTATION[tier];
  const unsupported = payload?.unsupported ?? null;
  const summary =
    unsupported !== null
      ? intl.formatMessage(messages.summaryUnsupported)
      : evidence === null
        ? intl.formatMessage(messages.summaryPending)
        : summaryOf(intl, tier, sources);
  const stale = payload?.stale === true;
  const deferred = payload?.status === 'deferred';
  return (
    <section className={SECTION_CLASS} data-testid={TEST_ID} data-tier={tier} data-stale={stale} data-status={payload?.status ?? 'loading'}>
      <h3 className={TITLE_CLASS}>{intl.formatMessage(messages.title)}</h3>
      <div className={BADGES_CLASS}>
        <Badge tone={presentation.tone} icon={presentation.icon} data-testid={TIER_TEST_ID}>
          {intl.formatMessage(messages[presentation.label])}
        </Badge>
      </div>
      <MetadataRow label={intl.formatMessage(messages.evidence)} value={summary} mono={false} />
      {sources.map((source, index) => {
        const row = sourceRow(intl, source);
        return <MetadataRow key={`${source.kind}-${String(index)}`} label={row.label} value={row.value} />;
      })}
      {evidence === null ? null : (
        <MetadataRow label={intl.formatMessage(messages.checked)} value={formatCalendarDate(evidence.evaluatedAt)} />
      )}
      {stale ? (
        <p className={NOTE_CLASS} style={{ color: STALE_TONE }}>
          {intl.formatMessage(messages.stale)}
        </p>
      ) : null}
      {deferred ? (
        <p className={NOTE_CLASS} style={{ color: STALE_TONE }}>
          {intl.formatMessage(messages.deferred)}
        </p>
      ) : null}
      {evidence === null || unsupported !== null ? null : <p className={NOTE_CLASS}>{noteOf(intl, tier, sources)}</p>}
      <p className={NOTE_CLASS}>{intl.formatMessage(messages.local)}</p>
      <div className={ACTIONS_CLASS}>
        <Button size="sm" icon="refresh-cw" disabled={provenance.busy} onClick={() => void provenance.refresh()}>
          {intl.formatMessage(provenance.busy ? messages.checking : messages.refresh)}
        </Button>
      </div>
    </section>
  );
}
