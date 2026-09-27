---
'overlook': patch
---

Replace hard-coded corner radii and font weights in the app's styles with the design scale: form fields and inputs use the 4px control radius, photo tiles and the moodboard use the tile radius, Interop panels use the card radius, and circles use the full radius. The photo tile's "Original" pill now uses semibold (600) instead of an off-scale bold (700). `lint:tokens` now also fails on a literal `border-radius` or `font-weight` in renderer CSS.
