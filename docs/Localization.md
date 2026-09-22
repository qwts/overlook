# Localization Workflow

Overlook ships English (`en`) today. Its locale runtime, live switching, and
right-to-left layout support are ready for reviewed translations; adding a
shipping locale is intentionally a catalog change, not a second runtime.

The governing decisions are in
[ADR-0020](./adr/ADR-0020-Internationalization-Architecture.md). This page is
the contributor procedure.

## Add a Locale

1. Open an issue naming the locale and its native-language reviewer. A machine
   translation may seed a draft, but a native speaker must approve all copy
   before release.
2. Copy `src/shared/i18n/messages/en.json` to
   `src/shared/i18n/messages/<locale>.json` and translate message values. Keep
   message ids, ICU arguments, plural/select branches, and rich-text tags
   unchanged.
3. Add the locale to `SHIPPED_LOCALES` in
   `src/shared/i18n/locales.ts`. Add its base language to the RTL set there when
   the script reads right-to-left.
4. Run `npm run i18n:extract`. Resolve every missing or obsolete entry; do not
   copy untranslated English into the shipping catalog to silence the check.
5. Exercise the catalog from Storybook's locale toolbar. Use `en-XA` for long
   strings and `en-XB` for bidi/RTL layout before reviewing the real locale.
6. Run `npm run ci`, `npm run test:stories:ci`, and `npm run test:e2e` before
   requesting review.

## Review Checklist

- A native speaker reviews the complete catalog in the pull request and states
  that explicitly in the review.
- Destructive and irreversible actions receive a second, focused review:
  delete, purge, offload, restore, relock, and recovery-key/password warnings.
- Screenshots or Storybook evidence cover the settings, grid, lightbox,
  inspector, import, restore, and destructive-confirmation surfaces.
- Variable interpolation, plurals, dates, numbers, units, and relative times
  are checked with realistic values. Formatting stays in `Intl`; translated
  messages never assemble locale-sensitive values by string concatenation.
- RTL locales prove root `lang`/`dir`, sidebar placement, directional icons,
  lightbox key behavior, and unmirrored photographs.

## Update Existing Copy

`npm run i18n:extract` also derives argument contracts from FormatJS's compiled
ICU AST. The generated English module preserves literal IDs and records the
values required by placeholders, plurals, dates, selects, and rich-text tags.
The shared declaration connects those contracts to FormatJS's public typed
descriptors; every TypeScript project includes it through the root config.
Keep message-key mappings narrow with `satisfies` so selecting a label does
not accidentally widen its type to messages requiring interpolation.

The `defineMessages` overload bridges registered IDs to their argument types
because the upstream inferred overload otherwise assigns an empty contract.
Remove that bridge when upstream inference supports the registered catalog,
keeping the negative compile checks in `tests/i18n/message-contracts.test.ts`.
Extraction freshness, invalid-value type checks, and runtime plural/rich-text
and translated custody tests cover this contract.

Change the source message in code, run `npm run i18n:extract`, and update every
shipping catalog in the same pull request. A catalog mismatch is a failing
gate, not a fallback-to-English policy. Translator context belongs beside the
message definition so extraction preserves it.

Generated pseudo-locales are development and CI fixtures. Never add `en-XA` or
`en-XB` to `SHIPPED_LOCALES`, hand-edit their output, or expose them in release
settings.
