---
'overlook': patch
---

Fix Review Duplicates, Activity, Interop, Keyring, Protected, Restore, the detached Inspector window, and the Diagnostics payload reading design tokens that don't exist, which left them with no corner radii, the wrong text size, and transparent surfaces. A new `lint:tokens` check now fails on any renderer stylesheet that reads an undeclared custom property.
