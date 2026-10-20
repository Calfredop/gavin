---
title: [opts] gavin_find_cards: index in the background, rank more precisely
status: Done
complexity: complex
---
Follow-up to opts-gavin-get-tree-archived-cards.md. The first gavin_find_cards in a workspace waited while every card was embedded (~22 s on this repo's 624 cards), and a paraphrased query could leave the card it meant at #18.

- [x] Embed sorted by length in batches of 32 (cards and memories), writing each batch as it lands
- [x] Index a watched workspace's cards in the background after each scan that changed the tree, coalesced per root, never downloading the model
- [x] Build a labelled query set from this repo's cards and measure ranking variants (recall@5, MRR)
- [x] Ship the variant that measures best, with tests
- [x] Update the tool description and skills for what changed
- [x] Rebuild, check against an isolated daemon with the real model, commit
