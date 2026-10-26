---
order: 15360
kind: task
title: [bug] hidden session after decision
status: Done
---
Opening the decision tab on a particular card shows it session, but after answering a decision, or simply going back to that session, it takes to a blank tab. I think it has to do with some kind of ‘hide’ trigger. Check for same behaviour on “Review” tab.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: On a page holding a card's running agent, open Decisions (and then Review) from the page's navigator, select that card so its session shows, then answer a decision / close the section or click the page's tab: the page's tab still shows the live terminal, not a blank box, at the right size.
