---
kind: note
title: A Device command needs a desk window open
status: To Do
labels: memory
topics: companion, forwarding
---
Every command a Device sends is run through a desk window's webview (`forwarding::dispatch`), so with no desk window open a phone can do nothing at all; "works with the desk closed" is never a real option for a Companion feature.
Why: the phone's Commit via agent decision was framed as arm-from-the-desk vs. run-without-the-desk, and the second could not exist.
