---
'overlook': patch
---

The library switcher's move checkboxes no longer print "Select {name} to move" beside each row; screen readers still announce it. `Checkbox` gains a `hideLabel` option, and the visually-hidden utility now loads globally, so hidden labels stay hidden in Storybook and detached windows too.
