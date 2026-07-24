---
'overlook': patch
---

Windows installers now sign via Azure Trusted Signing instead of Authenticode. `electron-builder.yml`'s `win.azureSignOptions` replaces `signtoolOptions`, and the Package workflow authenticates with `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` instead of `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`. See `SIGNING.md` for the required secrets and verification steps.
