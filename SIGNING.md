# Windows code signing

Windows installers are signed with [Azure Trusted
Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/overview)
(individual identity validation), configured in `electron-builder.yml` under
`win.azureSignOptions` (#683). There is no local `.pfx`/`.p12` — signing
happens against the Trusted Signing Account in Azure at build time.

## Required repository secrets

The Package workflow (`.github/workflows/package.yml`) authenticates to
Microsoft Entra ID as a service principal via
[`EnvironmentCredential`](https://learn.microsoft.com/en-us/dotnet/api/azure.identity.environmentcredential):

| Secret                | Value                                          |
| --------------------- | ---------------------------------------------- |
| `AZURE_TENANT_ID`     | Microsoft Entra tenant ID                      |
| `AZURE_CLIENT_ID`     | App registration (service principal) client ID |
| `AZURE_CLIENT_SECRET` | Client secret for that app registration        |

The service principal needs the **Trusted Signing Certificate Profile Signer**
role on the Certificate Profile referenced by
`win.azureSignOptions.certificateProfileName`.

When these secrets are absent, the Windows legs still build — the workflow
passes `-c.win.azureSignOptions=null` to force an unsigned build rather than
failing (mirrors the mac `-c.mac.identity=null` unsigned path).

## Configuration values

`electron-builder.yml`'s `win.azureSignOptions` block holds the non-secret
account coordinates (publisher name, endpoint, account name, certificate
profile name) — these aren't credentials, so they're committed directly
rather than passed as secrets:

- `publisherName` — must exactly match the CN on the Trusted Signing
  certificate.
- `endpoint` — the Trusted Signing Account's region-specific endpoint (e.g.
  `https://eus.codesigning.azure.net/`).
- `codeSigningAccountName` — the Trusted Signing Account name.
- `certificateProfileName` — the Certificate Profile name under that account.

## Verifying a signed binary

From an elevated PowerShell prompt on Windows, against a downloaded installer:

```powershell
signtool verify /pa /v .\Overlook-<version>-<arch>.exe
```

or:

```powershell
Get-AuthenticodeSignature .\Overlook-<version>-<arch>.exe
```

Expect `Status: Valid`, a signer subject matching `publisherName`, and an RFC
3161 countersignature timestamp. `NotSigned` or `HashMismatch` means signing
failed or was skipped — check the Package workflow run for the
`AZURE_TENANT_ID`-gated branch it took.
