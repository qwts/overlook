---
'overlook': minor
---

Encryption keys (Settings ▸ Privacy): the library keeps a keyring — every key it has ever sealed photos under, with its reference, fingerprint, what it still seals, and whether this device holds it. A retired key can be exported to a password-sealed key file and removed; removing a key that still seals photos is an irreversible-tier confirmation that counts them, and those photos stay in the library as locked items (a lock stands in for the thumbnail, the Inspector and lightbox say which key is missing) until the same key file is imported again, which verifies the key against a photo before installing it. Backup manifests move to schema 15 and carry the keyring, so a restore whose recovery bootstrap lacks a key yields locked photos instead of a refusal.
