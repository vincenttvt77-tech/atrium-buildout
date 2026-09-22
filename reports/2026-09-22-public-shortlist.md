# Public apartment shortlist — September 22, 2026

## Delivered

The Larkin public demonstration site now supports selecting up to five residences,
viewing and filtering the selection, removing units, and copying a public link
that reopens those unit IDs. Clipboard denial exposes the selected link for manual
copying. Keyboard focus remains useful after table updates; selecting a residence
keeps its visible position stable at mobile and desktop widths.

Under-application units remain labeled. Removed/unknown units produce a missing
notice. Malformed and oversized links never silently show unrelated units. The
public board excludes leased/off-board units. Links contain only public IDs and
do not inherit a source URL's contacts, credentials, dashboard path or query.
Demo and pricing/freshness disclosures remain visible.

## Evidence

- `npm run check`: 1,662 passed, 0 failed; typecheck and fixture validation passed.
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: 498 passed, 0 failed
  against disposable PostgreSQL instances.
- `npm run build`: site generation and 17 API-handler import/configuration smoke
  checks passed. No generated artifacts changed beyond the authored public assets.
- `node --test test/portal/public-shortlist.test.mjs`: nine new link/failure tests.
- Real Chromium local-asset acceptance: 45 checks, no page errors, at widths 320,
  390 and 1280. Covered exact five-unit round trip, selection cap, sorting and
  filtering, removals, clearing/reload, clipboard denial, pending/missing/invalid
  units, keyboard use, same-document navigation, visible position and overflow.
  Outside requests were blocked. Screenshots inspected locally.
- An initial browser assertion incorrectly required an unchanged document scroll
  offset when the shortlist panel grew. Measured the selected button's viewport
  position instead: it remained within one pixel at all three widths. No runtime
  scroll workaround was warranted. The final harness asserts that visible behavior.
- Source/diff reviewed; `git diff --check` passed. No independent agent review was
  performed for this increment.

## Boundaries

This is a public, single-property demo shortlist, not a live PMS lookup or an
account wishlist. It does not send messages, reserve tours, or automatically
connect Vapi search results to delivery. No production, provider, credential,
phone routing or database migration was changed. Existing AT-129 production
promotion approval is still pending; this feature's branch publication is not a
production promotion or an alternate route around that approval.

## Owner next actions

- Respond to the pending production promotion approval when ready.
- Supply permissioned representative leasing calls and verified pilot property
  information for actual workflow/voice evaluation.
- Confirm service funding before live phone acceptance.

## Codex / Fable next actions

- Review this feature branch and its parent offline voice-evaluation work; retain
  the separate pending release candidate and do not imply this is already live.
- Configure verified public website bindings per property before any dashboard
  or Vapi link integration. Bind matches to authoritative property inventory.
- Implement consented shortlist delivery using durable notification outcomes;
  report sent/pending/failed accurately and verify actual receipt.
- Run production acceptance after an approved deployment; collect measured real
  phone and held-out outcome evidence. Synthetic UI tests cannot establish either.
- Leave a reciprocal handoff with exact commits, deployment state, checks,
  limitations and owner/next-agent to-dos at the end of the next session.
