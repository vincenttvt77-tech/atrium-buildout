# Property-bound voice shortlist preparation — September 22, 2026

## Delivered

PostgreSQL voice availability requests can prepare a public shortlist link from an
explicit publisher-reviewed website binding for the current organization/property
and inventory source. Missing, expired or mismatched bindings do not emit links.
Malformed configured bindings fail publication/snapshot validation. URLs are
canonical HTTPS with no credentials, query, fragment, custom port, IP literal or
local hostname. Reviews last at most 30 days and are never silently renewed.

Known-unit and plan lookups retain direct behavior. Broader searches link only the
actual presented matches and explicitly qualified alternatives, capped at five.
Existing inventory freshness, demo disclosure, qualification and quote gates
remain. Pending/leased/unknown units cannot become linked voice offers. Existing
`unitsOffered` semantics are retained; a separate shortlist-ID list includes the
presented alternatives. Mixed-case identifiers now round-trip the public reader.

The response and event record say prepared/not_sent. No SMS/email is offered from
this tool, no URL should be read aloud, and no delivery is claimed. The assistant
can offer staff follow-up if the caller asks for a link. Model parameters and
request-body property/destination overrides cannot replace scoped configuration.
No website network lookup occurs during a conversation.

## Verification

- `npm run check`: 1,674 passed, 0 failed; typecheck and fixture validation passed.
  Twelve new application/contract tests cover binding validation, ownership,
  expiry, URL safety, freshness, missing/unknown/nonavailable units, named/plan/
  priced-out/broad results, fictional-demo disclosure and mixed-case round trips.
- `node --test --test-concurrency=2 'test/database/*.test.mjs'`: 500 passed, 0 failed
  in disposable PostgreSQL instances. Two new actual HTTP webhook tests prove
  property-specific website routing despite conflicting model/body input and no
  link from stale inventory. Link preparation made no provider operation.
- `npm run build`: generated site plus 17 API-handler import/configuration checks.
- Repeated public-site Chromium acceptance: 45 checks at 320, 390 and 1280 pixels,
  no page errors. Outside traffic blocked. Prior layout unchanged; rendered
  screenshots retained locally. No real phone/browser session was contacted.
- Source/diff reviewed and whitespace checks passed. One initial URL-validation
  test caught acceptance of an empty query marker (`?`); raw query/fragment markers
  are now rejected. No independent agent review or cloud CI acceptance claimed.

## State and limits

No deployed property binding was enabled. This is optional PostgreSQL behavior;
legacy mode never assumes the shared Larkin website. The public bundled page
remains a single-property demo. Publisher review is an administrative attestation,
not automated domain ownership, availability or content verification.

The prepared record is historical context, not a persisted delivery request,
consent receipt, staff sending UI or proof of staff follow-through. Staff and
voice message delivery still require current binding/authority checks, explicit
consent, approved sender/destination, a durable idempotent intent, and verified
provider outcomes. Existing email rendering and generic workflow primitives do
not establish working delivery. Live phone/end-to-end acceptance remains open.

AT-129 production promotion still needs the specific owner approval requested
after automatic approval review rejected it. This feature branch is independent
of that pending release candidate and does not promote production. No live Vapi,
credential, database migration, routing or provider mutation occurred.

## Owner to-dos

- Answer the existing production promotion approval when ready.
- Provide verified property website/feed information and permissioned call samples.
- Ensure calling/message funding and approved sender capabilities before live tests.

## Next Codex / Fable work

- Review this branch and its public-shortlist/evaluator parents before integration.
- Verify a real compatible website and publish the binding under property authority;
  do not claim the example URL in the guide is an operational destination.
- Connect a supported native/provider delivery capability with saved permission,
  durable operation identity and provider read-back. Do not interpret prepared,
  queued, accepted and delivered as the same status. Add a practical staff path.
- Run phone-to-tool-to-dashboard/delivery acceptance after approved release;
  collect real outcome and latency evidence, not just synthetic check counts.
- Finish each session with a reciprocal handoff containing actual commits,
  deployment state, tests/failures, limits, and owner/next-agent next actions.
