# Acceptance Test: Feed View

Covers the title / image / description Feed view (#516). The Feed is a fourth
view beside Grid, List, and Moodboard and a layout of the same virtualized
engine: only the visible window (plus overscan) mounts, pages arrive through
the same keyset cursor, and selection, favorites, the Inspector, the context
menu, albums, filters, and Smart Albums are the same code paths the grid uses.
The Electron lane proves the card contract, keyboard navigation, the lightbox
round trip, and in-place updates over the seeded library. The unit lane proves
the layout math (one centered column of fixed-height cards, capped at a
reading width). Use a real library with a few titled and described photos,
some offloaded photos, and at least one unreadable file for the steps below.

## Switching and layout

1. Press the **Feed** option in the toolbar's view control (or View → Feed).
   Confirm the photos render as one centered column of cards, the zoom slider
   is hidden, and the View menu shows **Feed** checked.
2. Widen and narrow the window. Confirm the column stays centered and never
   exceeds its reading width, and the card that was at the top stays in view.
3. Scroll to the bottom of a large library. Confirm cards keep arriving
   without a visible seam and scrolling stays smooth; open the developer tools
   and confirm only a handful of cards are mounted at any time.
4. Switch back to **Grid**. Confirm the photo at the top of the feed is still
   in view.

## Cards

5. Confirm a card with a title shows it as the heading with the file name,
   date, place, and camera in the meta line underneath; a card without a title
   shows the file name as the heading in the machine-data style.
6. Confirm a card with a description shows it clamped to two lines, and a
   card without one shows the muted **No description** placeholder.
7. Confirm the image paints the grid's thumb first (softened) and the larger
   preview fades in over it. With **Reduce motion** on in the OS, confirm the
   swap happens without a fade.
8. Confirm an offloaded photo shows dimmed with the offloaded glyph, and a
   photo whose preview cannot be produced shows the preview-unavailable copy
   instead of a broken image. Confirm an audio file shows the music glyph, a
   video still being probed shows the spinner, and a video without a poster
   shows the film glyph, exactly as their grid tiles do.
9. In **Trash**, confirm the meta line shows the retention label instead of
   the date and place.

## Interaction

10. Click the selection circle on a card. Confirm the card is selected and not
    opened; Shift-click another card and confirm the range selects. Press
    **I** and confirm the Inspector opens on the selection.
11. Edit the title and description in the Inspector and save. Confirm the
    visible card updates immediately, without a reload.
12. Click the star on a card. Confirm the favorite state changes in place and
    the Favorites count in the sidebar follows.
13. Right-click a card, or press its more-actions button. Confirm the same
    context menu as the grid appears for that photo.
14. Click a card body, then click the title and the description. Confirm each
    opens the lightbox on that photo, and that right-clicking the title opens
    the context menu; close the lightbox with **Esc** and confirm the feed is
    exactly where it was.
15. With a card focused, press the arrow keys, Page Down, and Page Up.
    Confirm focus moves through the cards and the feed scrolls to keep the
    focused card visible (Home and End stay within the row, as in the grid). Confirm a screen reader announces each card as a
    button named after the photo, with the position in the list.
16. Open an album, a filter, or a Smart Album while in the Feed. Confirm the
    cards show that collection and the view stays on Feed.
