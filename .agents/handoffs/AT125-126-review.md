# AT125–126 independent review

Reviewed 2026-09-21T11:59:16.646918+00:00. Owner: Codex booking_review_security. Coordination checkout `/Users/evanmavashev/Documents/ChatGPT/Atrium/atrium-buildout`; implementation worktree `/Users/evanmavashev/Documents/ChatGPT/Atrium/atrium-demo-readiness`, branch `codex/at125-demo-readiness`, base/HEAD `1fde58426baf902c9032fc7b453151ef08721b80`. Reviewed the current uncommitted scoped implementation, independently of other reviewer findings. No source edits, provider actions, live probes, commits or publication were performed by this reviewer.

## Result

No remaining actionable findings in the scoped final authored changes. AT125 fixes the previously reproduced Status false-green result. AT126 implements a bounded unauthenticated HTTP observation tool and describes its proof limits accurately. This review does not approve paused AT121–124 booking-resolution source in the coordination checkout, nor establish production deployment or phone acceptance.

## Scope reviewed

- `ops/src/app.js`: summary precedence, render signature, fixed support wording and refresh-success predicate for `bookingReviewsError`.
- `test/portal/status-readiness.test.mjs`: four new failure/recovery regressions, including unchanged higher-priority summary repaint and HTTP200 partial feed errors.
- `scripts/lib/demo-readiness.mjs`: origin and CLI validation, six fixed GET routes, request/body deadlines, byte limits, credential omission, redirect refusal, exact app401 checks, sign-in marker checks, health and source-contract evidence, diagnostic redaction and explicitly unverified capabilities.
- `scripts/demo-readiness.mjs`: local contract import, CLI output, exit meanings and sanitized invalid-input behavior.
- `test/portal/demo-readiness.test.mjs` and `docs/demo-readiness.md`.
- Relevant existing `src/auth/model.ts` confirms the managed-runtime401 body used by the preflight.

Generated dashboard artifacts, complete build/application/database gates and actual live preflight remain coordinator-owned acceptance. This review is authored-source and focused-test evidence only.

## Findings identified and corrected during review

1. **P2, fixed — origin validation accepted normalized paths.** The first implementation used only parsed `URL.pathname`; `https://atrium.example/../`, `/.`, `/%2e/` and `https:atrium.example` became an accepted origin, violating the origin-only contract and allowing network requests after invalid input. The original focused run passed11/12 with the invalid-origin test failing. Final code requires a literal HTTPS authority with only an optional trailing slash before parsing; additional regressions reject the normalization cases before I/O.
2. **P2, fixed — data attributes impersonated a real sign-in form.** Initial word-boundary regexes recognized `data-method`, `data-action` and `data-type`. Independent synthetic execution confirmed that a401 page with an actual GET form targeting another origin and a text input could pass by adding those data attributes. Final code parses exact attributes, rejects duplicates and excludes inert/raw-text regions. Regressions cover data attributes, conflicting duplicates, comments, scripts, textarea and nested template content, while a real head/title/style and generated form remain accepted. The docs correctly call this a conservative marker check, not DOM or authenticated-login acceptance.

## Actual checks

- Node22 `node --test test/portal/status-readiness.test.mjs`:19 passed,0 failed after independent source review.
- Initial Node22 preflight suite:11 passed,1 failed; origin-normalization defect above reported immediately.
- Independent adversarial synthetic check: initial data-attribute impersonation caused `read_only_checks_passed`; reported and corrected.
- Final Node22 `node --test test/portal/demo-readiness.test.mjs test/portal/status-readiness.test.mjs`:32 passed,0 failed. Log `/private/tmp/atrium-final-preflight-independent.log`.
- `git diff --check`: clean.

No paid simulations, actual calls, credentials, production data or hosting configuration were used. Final test fixtures show oversized chunked response cancellation, byte rather than character limits, body stalling after headers, a transport that never returns headers, no redirect following, minimal JSON401 requirements, changed contract/storage semantics, invalid CLI options and sanitized output.

## Required interpretation and next ownership

A passing preflight proves only the enumerated unauthenticated HTTP observations. It cannot establish successful login, current property isolation, browser behavior, saved Vapi assistant configuration, webhook credential equality, provider credit, actual phone audio/latency, booking/read-back, notifications, future uptime or deployed commit identity. Keep those as separate verified evidence. Root may complete isolated full gates and an authorized read-only live smoke; retain the investor demo deployment freeze and keep unfinished booking-resolution files excluded. The next implementation handoff should include exact commit/state, actual checks, source-versus-deployed distinction, owner tasks and agent tasks, plus a reciprocal handoff requirement.
