---
'overlook': minor
---

Photos imported beside XMP or AAE sidecar files now carry those companions into encrypted custody by default: discovered by basename next to the original, encrypted per photo with the association authenticated in the envelope, imported under the same Copy/Move verified-then-delete transaction, included in backup manifests and restore, exported beside the original under its resolved name, and purged with the owning photo. Companions that match no photo are reported in the import summary, never silently dropped.
