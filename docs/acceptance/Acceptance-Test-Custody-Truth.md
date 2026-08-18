# Custody truth acceptance

## Purpose

Verify that disconnect and cloud-only original failures preserve the recorded
provider/account binding and tell the user exactly what recovery action is
required. This is the executable acceptance companion for #734 and ADR-0028.

## Automated evidence

- `tests/e2e/offload-ui.spec.ts` composes an offload, blocked disconnect,
  restore-first action, emergency authorization removal, and provider-required
  banner with exact item and byte counts.
- Settings, Inspector, Lightbox, and Export Storybook interactions cover safe,
  at-risk, wrong-account, provider-required, legacy-unbound, and
  missing-or-corrupt presentations.
- `tests/backup/custody-presentation.test.ts` proves that all seven custody
  states have distinct actionable copy; routing and ephemeral-original tests
  prove the underlying typed state projection.

## Manual script

1. Back up and offload one original, then open the provider disconnect dialog.
   Confirm the dialog names the provider and account, shows exact `.mono-data`
   item and byte counts, offers Restore all first, and does not show safe
   reassurance while either count is nonzero.
2. Exercise emergency authorization removal. Confirm the ledger and authority
   remain intact, the Settings banner names the exact provider/account, and the
   photo becomes provider-required rather than appearing local or available.
3. Open the affected photo in Inspector and Lightbox, then export it. Confirm
   every surface reports the same distinct state and recovery action for:
   disconnected, wrong account, unavailable, missing/corrupt,
   provider-required, and legacy-unbound custody.
4. Reconnect the recorded account and namespace. Confirm the state becomes
   available without changing the offloaded ledger row. Repeat with a different
   account and confirm it remains wrong-account.
5. Repeat the failure transitions with VoiceOver. Confirm each meaningful
   change is announced once and controls remain keyboard operable.
