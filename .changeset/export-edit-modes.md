---
'overlook': minor
---

Export declares one payload mode for edited photos (ADR-0031 §6): **Bake** renders the saved rotation, flip, and crop into a new JPEG at an explicit quality; **Original + XMP** writes the byte-identical original beside an XMP sidecar naming the edits (`tiff:Orientation`, `crs:Crop*`); **Original only** writes the original and nothing beside it. A preflight names every edit the chosen mode cannot carry and Export waits for the user to continue with that loss or pick another mode.
