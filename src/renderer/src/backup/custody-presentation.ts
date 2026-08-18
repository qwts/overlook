import { defineMessages, type IntlShape } from 'react-intl';

import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';

const messages = defineMessages({
  cloudProvider: { id: 'custody.provider.fallback', defaultMessage: 'Cloud provider' },
  sameAccount: { id: 'custody.account.fallback', defaultMessage: 'the recorded account' },
  available: {
    id: 'custody.state.available',
    defaultMessage: 'Offloaded — original available from {provider} as {account}.',
  },
  disconnected: {
    id: 'custody.state.disconnected',
    defaultMessage: '{provider} disconnected — reconnect as {account} to open, restore, or export this original.',
  },
  wrongAccount: {
    id: 'custody.state.wrongAccount',
    defaultMessage: 'Wrong {provider} account — reconnect as {account}; this account cannot satisfy the recorded custody.',
  },
  unavailable: {
    id: 'custody.state.unavailable',
    defaultMessage: '{provider} unavailable — try again without changing the original’s recorded custody.',
  },
  missingCorrupt: {
    id: 'custody.state.missingCorrupt',
    defaultMessage: 'Original missing or corrupt in {provider} — custody remains bound and recovery could not complete.',
  },
  providerRequired: {
    id: 'custody.state.providerRequired',
    defaultMessage: '{provider} required — reconnect as {account} to recover this original.',
  },
  legacyUnbound: {
    id: 'custody.state.legacyUnbound',
    defaultMessage: 'Recovery required — this legacy cloud-only original is not yet bound to a verified provider account.',
  },
});

export interface CustodyPresentation {
  readonly text: string;
  readonly tone: string;
  readonly assertive: boolean;
}

export function custodyPresentation(intl: IntlShape, status: PhotoCustodyStatus): CustodyPresentation {
  const values = {
    provider: status.providerLabel ?? status.providerId ?? intl.formatMessage(messages.cloudProvider),
    account: status.accountLabel ?? intl.formatMessage(messages.sameAccount),
  };
  switch (status.state) {
    case 'available':
      return { text: intl.formatMessage(messages.available, values), tone: 'var(--accent-amber)', assertive: false };
    case 'disconnected':
      return { text: intl.formatMessage(messages.disconnected, values), tone: 'var(--accent-red)', assertive: true };
    case 'wrong-account':
      return { text: intl.formatMessage(messages.wrongAccount, values), tone: 'var(--accent-red)', assertive: true };
    case 'unavailable':
      return { text: intl.formatMessage(messages.unavailable, values), tone: 'var(--accent-red)', assertive: true };
    case 'missing-corrupt':
      return { text: intl.formatMessage(messages.missingCorrupt, values), tone: 'var(--accent-red)', assertive: true };
    case 'provider-required':
      return { text: intl.formatMessage(messages.providerRequired, values), tone: 'var(--accent-red)', assertive: true };
    case 'legacy-unbound':
      return { text: intl.formatMessage(messages.legacyUnbound), tone: 'var(--accent-red)', assertive: true };
  }
}
