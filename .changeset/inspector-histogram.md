---
'overlook': minor
---

The Inspector shows a histogram for the focused photo: red, green, blue and luminance bins with clipping indicators, computed in the main process on a worker thread from the photo's own preview (the saved edits already applied), so it follows paging, variants and saved rotations or crops without blocking the lightbox. Missing or undecodable previews say so instead of drawing a chart.
