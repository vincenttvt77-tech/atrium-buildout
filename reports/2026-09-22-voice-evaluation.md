# Voice evaluation foundation — September 22, 2026

## Delivered

An offline, aggregate-only voice evaluation command and strict input contract are implemented in `src/voice-evaluation/metrics.ts` and `scripts/evaluate-voice.mjs`. Run instructions and measurement definitions are in [voice-evaluation.md](../docs/voice-evaluation.md).

The report separates reviewed success from success across all cases; retains unreviewed outcomes; counts successful containment only among eligible cases; records critical failures; reports per-turn P50/P95/max and sample/missing counts; and includes failed-case costs in cost per successful outcome. Costs remain unavailable when evidence is incomplete. Each report declares synthetic/real-call and development/held-out provenance and configuration/dataset fingerprints.

Unknown values never become zero. Duplicate IDs, malformed metrics, ambiguous units, contradictory critical outcomes, unsupported fields and oversized inputs are rejected. Generic CLI errors do not echo file paths or payload content. Only aggregate results are emitted. The command has no network, model, phone, upload or write capability.

This is measurement infrastructure, not an observed voice improvement. It does not grade transcript semantics, prove a dataset's permission/independence, establish 95% live accuracy, measure actual latency, or certify release readiness. It never automatically converts Vapi fields whose timing units or boundaries have not been verified. First meaningful audible content must be distinguished from filler when measuring response delay.

## Evidence

- `npm run check`: 1,653 passed; types and fixture validation clean, including 19 new metric/CLI regressions.
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: 498 passed against disposable local PostgreSQL, 168.41 seconds. No hosted database was accessed.
- `npm run build`: 17 API handlers smoke-checked in both runtime modes. Runtime UI/API source is unchanged by this increment.
- Initial typecheck found an overly broad inferred map type in the new metrics report. An explicit complete metric-key return type corrected it; final full check passed.
- No UI/browser suite was repeated because there are no rendered product changes.
- Two attempts to open the existing Vapi assistant for read-only metric inspection timed out in automatic permission review. This is unavailable evidence, not proof of unsafe behavior or bad provider performance. No further browser retry or provider mutation occurred.

Vapi's official latency methodology and SDK type definitions were checked; references and limitations are in the guide. No vendor was selected, no assistant republished, no paid simulation run, and no live data exported.

## Handoff and next steps

Base: `4827d58`; branch/worktree: `codex/at130-voice-evaluation`, `atrium-voice-evaluation/`. This independent increment does not alter the release awaiting approval at application commit `1f952f2`. Production promotion remains pending the explicit owner response after the earlier automatic review rejection. Do not treat this new commit as permission to bypass that gate.

Owner/team: supply permissioned representative calls and approved building facts/rules, fund a real-phone rehearsal, and answer the separate production deployment approval. The existing incident transcript is a useful failure example, not a representative evaluation corpus.

Codex next: verify actual provider timing units/boundaries and collect a labelled baseline; preserve separate known-unit, search, policy, booking/change and handoff results. Keep failed calls in the cohort, freeze held-out cases before tuning, and pair configuration experiments with quality and cost results. The production deployment still needs its own approval and exact runtime verification.

Fable: review the report methodology and missing-data behavior against the leasing goal. Leave a reciprocal handoff with commit/branch, actual results/failures, local/remote/deployed state, owner tasks and next-agent tasks, and request the same from the next agent. Do not mistake the synthetic parser tests for real-call acceptance.
