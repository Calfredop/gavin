# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the label strings used on this repo's gavin cards.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (for example, "apply the AFK-ready triage label"), use the matching label string from this table.

Labels live in the card's `labels:` header field as a comma-separated list. `gavin_set_plan_field` cannot write labels, so edit that header line directly, and keep a card's existing labels (such as `bug` or `memory`) when you add a triage label.
