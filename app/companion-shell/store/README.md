# `app/companion-shell/store/` — what the stores are sent

The text and images a store submission of the Companion pastes and
uploads, kept beside the shell so they change with the build they
describe (companion-24). `scripts/store-submit.sh` walks the owner through
a submission and copies each file to the clipboard at the step that
needs it.

| file | where it goes |
|---|---|
| `app-review-notes.txt` | App Store Connect → the version → App Review Information → Notes |
| `description.txt` | App Store description, and Play's full description |
| `listing.txt` | App Store name, subtitle, keywords, promotional text; Play's short description |
| `play-release-notes.txt` | Play Console → Internal testing → the release → Release notes |
| `play-icon-512.png` | Play Console → Main store listing → App icon (drawn by `scripts/icons.mjs`) |

**Describe the build, not the plan.** Guideline 2.3 rejects metadata that
names what a build cannot do, and a reviewer checks the Demo Workstation
against it. Before each submission, read "What is here, and what is not"
in `app/companion/README.md` and make `description.txt`,
`app-review-notes.txt` and the screenshots name exactly the surfaces it
lists. As of companion-23 that is the workspace list and a board to read.
