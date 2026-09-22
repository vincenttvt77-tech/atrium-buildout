# Leasing shortlist reliability — September 22, 2026

## Product change

The revised [leasing-first goal](../docs/leasing-goal.md) is now in the repository for shared developer context. It preserves the broader scope of work while prioritizing reliable leasing, actual-call evidence, measured voice performance and a controlled property pilot. Meeting suggestions about providers and models remain hypotheses to evaluate.

Broad apartment searches now supply at most five named candidates across matching, above-budget and later options. Primary-match totals disclose the omitted count without placing hundreds of extra unit identifiers in the voice model's context. Guidance tells the assistant to begin with two or three options and narrow the search. Named apartments remain directly accessible.

Two misleading responses are corrected: an in-time but over-budget apartment no longer produces a claim that nothing opens by the requested date; a later apartment that also exceeds the budget explicitly identifies both mismatches. Priced-out searches and smaller-layout alternatives share the same five-candidate cap. Source freshness, quote qualification and existing unitsOffered record meaning are preserved. Tool schemas and saved assistant configuration are unchanged.

This is a backend response improvement. It does not establish faster measured phone latency or create SMS delivery, personalized links, result pagination, outbound callbacks or PMS integration. The five-unit cap is a default shortlist, not a claim that these are the only available apartments.

## Verification

- Before implementation: the initial eight focused tests reproduced six failures; stale-source and qualification guards already passed.
- Final focused suite: 51 passed, including ten new cases covering a 500-unit inventory, mixed alternative categories, exact counts, omitted named-unit lookup, budget/date broadening and unchanged guards.
- `npm run check`: 1,634 passed; TypeScript and data validation clean.
- `npm run build`: all 17 API handlers imported and refused unconfigured requests in both runtime modes.
- Full isolated PostgreSQL suite: 498 passed in 148.98 seconds on the authorized two-worker rerun. The first attempt could not bind localhost (`EPERM`); all 498 cases failed setup rather than exercising database behavior. The rerun used a disposable database; no production database was accessed.
- No browser suite repeated: this change does not modify dashboard/site markup, styles or interaction code. Prior browser evidence applies only to its tested revision.
- No paid simulation, outbound communication, production write, Vapi publication or deployment in this increment. Local tests are not live phone acceptance.

## Ownership and next steps

Worktree: `atrium-leasing-shortlist`; branch: `codex/at128-leasing-shortlist`; base: `93cbed21cbd5d895de4cf701aea31ac5cde1cb5a`, which includes the earlier local booking recovery and release preflight commits. Original paused files in `atrium-buildout` are preserved. Shared coordination remains `atrium-buildout/docs/agent-tasks.md`, AT-128.

Owner/team: obtain approximately 100 permissioned, representative leasing calls or transcripts and approved property facts/rules; identify a pilot property; ensure Vapi funding before a phone rehearsal. No representative real-call accuracy or latency claim is supported yet. The currently supplied failure transcript remains a useful incident example, not a representative corpus.

Codex next: integrate the reviewed local reliability commits through the authorized release process. Verify the actual deployed revision and authenticated workflow, then measure phone behavior. Establish a held-out evaluation and latency/cost baseline before selecting new voice/model providers. Preserve working resident/maintenance foundations while prioritizing leasing.

Fable handoff: review the exact commit and its availability responses, especially count scope and dual budget/date mismatches. Distinguish source tests from actual model speech. Leave a reciprocal handoff with commits, changed paths, actual checks/failures, local/remote/live state, owner actions and next-agent actions. Do not assume local files have reached GitHub.

Remote observation: `git ls-remote --heads origin codex/atrium-quality-pass` on September 22 returned `1fde58426baf902c9032fc7b453151ef08721b80`. This is a branch observation, not production deployment evidence. Initial sandbox DNS failure was followed by the authorized successful read. No remote mutation occurred.
