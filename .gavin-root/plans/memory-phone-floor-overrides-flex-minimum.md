---
kind: note
labels: memory
topics: companion, css, layout
title: The Companion's 44px floor replaces a flex item's own minimum
status: To Do
---
In the Companion, phone.css's `min-width: 44px !important` replaces a flex item's automatic minimum, so a `flex: 1 1 0` button can shrink below its label; give rows of buttons `flex-wrap: wrap` and a content basis (`flex: 1 0 auto`).
Why: at a large text size Git's Fetch/Pull/Push and Changes/Branches ran off a 402px screen while every guard stayed green.
