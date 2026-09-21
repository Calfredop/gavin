# TypeSafe turn verdict: experiment record and question set

Date: 2026-09-21. Model: `jev-1.13.0` (TypeSafe System One), pinned.
Cards: `.gavin-root/plans/typesafe-experiments.md` (results),
`.gavin-root/plans/typesafe-turn-verdict.md` (the proposal this record feeds).

## The question

When an agent session goes quiet, gavin decides the turn ended. It has two
signals: the OSC/BEL notification (which catches permission menus) and a
substring from the profile's `failure_patterns` (only claude-code has one,
`API Error:`). A question asked in prose, a turn the agent gave up on, and
every failure of an agent with no patterns all read as a finished turn. The
experiment asked whether one TypeSafe request over the screen tail can tell
those apart reliably enough to act on.

## Method

- One request per screen. State is `{"agent_cli": <profile id>, "screen":
  <rendered tail>}`; every question below rides the same request, so they
  cost one ~1.4-1.8k-token call (~$0.00007) at ~0.7s p50.
- **Synthetic screens (53)**: five CLIs (claude-code, codex, gemini,
  opencode, cursor) across finished / asking / blocked / failed / working.
  Claude Code error strings came from gavin's measured ones (server.rs,
  agent_setup.rs); the rest are modelled on each TUI's style, not
  captured. Labelled before any run and split dev/test by alternation;
  the confidence policy was frozen on dev before test ran.
- **Real turn endings (70)**: final assistant messages sampled (seeded)
  from this repo's Claude Code transcripts, secret-screened, wrapped in
  Claude Code's screen chrome. Hand-labelled before any run; 16 marked
  ambiguous (mostly "finished, plus an offer").
- **Real failures (16)**: every distinct `isApiErrorMessage` text in the
  same transcripts.
- "Today" = gavin's current rule, credited generously: a permission menu
  counts as caught (the bell path), a spinner as working.

## Results

| | TypeSafe | today |
|---|---|---|
| synthetic, held-out test split (v1) | 25/26 | 14/26 |
| synthetic, all 53 (v2) | 52/53 | 29/53 |
| synthetic, failure cause | 16/16 | 5/16 |
| real turns, clear cases (v2) | 53/54 | 35/54 |
| real questions/approval gates caught (v2) | 15/16 | 0/16 |
| real finished turns flagged as asking (v2) | 3/44 | 0/44 |
| real failures recognised | 16/16 | 11/16 |
| real failures, right cause | 15/16 | 5/16 |

v1 read closing offers ("say the word and I'll commit") as questions: 11 of
44 finished turns. v2 writes the boundary into the `finished`/`asking`
criteria and brings that to 3. v2 was worded after reading v1's misses on
the real set, so its real-set numbers are not a clean holdout; it did not
regress on the synthetic set it was not written against.

Known misses:

- `API Error: Server is temporarily limiting requests (not your usage
  limit) · You have exceeded your usage limit.` reads as usage-limit. That
  is a hold, the safe direction.
- A retry countdown under an error line can read as `failed` at low
  confidence; the `n_active` veto below catches it.
- Mid-plan progress messages ("Task 2's review is running in the
  background") without a spinner on screen read as finished.

Card complexity (a Score over the five levels, 75 cards with a written
level) was also tried and dropped: exact agreement 35/75 against 33/75 for
always answering "moderate".

## Policy (code, not model)

- `n_active >= 0.7` -> working; do not judge the turn.
- `verdict.confidence < 0.75` -> today's answer.
- A `cause` may drive auto-resume only at `confidence >= 0.9`; the
  one-attempt budget is unchanged.
- Any error, timeout or missing key -> today's answer.

On the synthetic set this policy scored 51/53, with both remaining misses
being low-confidence cases that fell back to today's (equally wrong)
answer. It never made a verdict worse than today's.

## Question set (v2)

The synthetic and real-turn runs used `cause` without the `suspend`
option; the real-failure run added it, and it is kept here.

```json
{
  "verdict": {
    "type": "choice",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. What has the agent's current turn come to?",
    "criteria": {
      "finished": {
        "meaning": "The agent completed the task it was working on and reported the result.",
        "still_finished_when": [
          "the message ends by offering optional extra work: 'want me to also...', 'say the word and I'll commit', 'I can file this as a card'",
          "the agent leaves a manual check, a commit, a push or a merge for the human to do whenever they like",
          "the agent gives notes, caveats or recommendations after reporting the result"
        ]
      },
      "asking": {
        "meaning": "The agent stopped before its task is done and cannot continue until the human answers.",
        "examples": [
          "a permission or approval menu on screen",
          "a choice between options the task depends on ('which approach?', 'should I delete it or keep it?')",
          "a design, spec or plan presented for approval before the agent writes the next part ('does that look right?', 'review it before I write the plan')",
          "a request for the human to do something and report back before the agent can go on"
        ],
        "not_asking": "An offer of optional extra work after the task is already done is finished, not asking."
      },
      "blocked": "The agent ended its turn itself without completing the task, and explains in its own words what stopped it (a missing file, a failing build, a denied write, a rule it must follow). It asks the human nothing.",
      "failed": "The agent's turn was cut off by an error from outside the agent: its own API connection dropping, an API error, an overloaded service, a usage or quota limit, an expired login, or the agent process crashing. The agent never got to report on the task.",
      "working": "The agent has not stopped: a spinner, a running command, a 'Working' timer or a retry countdown shows it is still active."
    }
  },
  "cause": {
    "type": "choice",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. If the agent's turn was cut off by an error from outside the agent, what kind of error is shown?",
    "criteria": {
      "suspend": "The computer went to sleep during the response.",
      "network": "The connection to the agent's API failed: dropped, reset, refused, DNS failure, stream disconnected, or an empty or malformed response.",
      "outage": "The API answered with a server-side failure: overloaded, 500/502/503/529, service unavailable.",
      "usage-limit": "The account ran out of budget: usage limit, quota exhausted, rate limit reached, or a message saying when the limit resets.",
      "auth": "The agent needs a login or credentials: expired token, invalid API key, 401 Unauthorized, or an instruction to log in again.",
      "crashed": "The agent process itself died: a fatal error, out of memory, an uncaught exception or stack trace, or the terminal is back at a shell prompt.",
      "none": "No error from outside the agent cut the turn off."
    }
  },
  "n_asks": {
    "type": "noul",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Is the agent waiting for the human to answer a question, pick an option, or approve an action before it continues?"
  },
  "n_broke": {
    "type": "noul",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Was the agent's turn cut off by an error from outside the agent (its API connection, an API error, an overload, a usage limit, an expired login, or a crash) rather than ended by the agent itself?"
  },
  "n_active": {
    "type": "noul",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Does the screen show the agent is still active, such as a spinner, a running timer, or a retry countdown?"
  },
  "n_done": {
    "type": "noul",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Did the agent report that it completed the task it was working on?"
  },
  "n_optional_offer": {
    "type": "noul",
    "instructions": "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. The agent's last message may end with a question or an offer. Is the task it was given already done, so that any closing question or offer is only about OPTIONAL extra work the human is free to ignore?"
  }
}
```
