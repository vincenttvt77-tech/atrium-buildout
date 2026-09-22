# Email delivery increment — September 22, 2026

AT-133 advances permissioned confirmations and shortlist delivery with an actual Resend adapter on the existing durable workflow engine. This is local, synthetic acceptance of the delivery component. Customer-facing admission, hosted activation and real email delivery remain unfinished.

## Changes

- Submission now distinguishes provider acceptance from delivery. The former in-memory “queued” label was removed; a preview explicitly says nothing was queued or sent. Successful HTTP responses require a valid provider message UUID rather than a fabricated fallback.
- Sends carry a stable scoped operation key and content tags. An explicit organization/property/sender binding, exact receipt/content checks and an expiry window prevent mismatched dispatch. Provider URLs are fixed, redirects refused, responses bounded, cancellation propagated, and error bodies kept out of status reasons.
- A reference-dependent connector saves acknowledgement before a separate verification claim. Exact message readback and a provider delivery event are required for success. Revocation and lease/configuration checks still fence the final write.
- Unknown submissions and replay never automatically send another email. Lost acknowledgement can require staff investigation; it is not represented as delivery. Pending events, wrong recipients/content, bounce and missing records remain unconfirmed or need review.
- The owner’s Vast/voice direction was integrated from committed0aa438e without changing the active assistant.

## Verification

Node22.23.2, isolated worktree `atrium-email-delivery`, branch `codex/at133-email-delivery`. Started from9467c65; fast-forwarded the documentation-only0aa438e during verification. Application source was unchanged by that fast-forward.

- Focused email/worker tests:66 passed.
- `npm run check`:1,690 passed; TypeScript and fixture validation clean.
- `npm run build`: passed; all17 API handlers imported and rejected unconfigured requests in both runtime modes.
- Full disposable PostgreSQL suite:508 passed, including8 new actual-adapter email/HTTP cases.
- `git diff --check`: passed.

The first native runs exposed two test-fixture mistakes: a freeform replay reason violated the repository’s machine-code contract; artificial backdating of a lease violated a database constraint. Both fixtures were corrected without weakening application checks. The crash test now waits for the actual lease to expire. The full successful rerun is the acceptance source.

No browser suite was rerun because this increment changes no UI. No real provider requests, emails, paid simulations, phone calls, migration or production/Vapi changes occurred. Current live health and latency were not revalidated by these tests.

## Remaining work / next owners

Codex/Fable: connect trusted permission capture and confirmed-booking/current-shortlist admission to the durable receipt; bind each property’s sender and registry; implement the scoped runner; reconcile provider delivery events; surface email state on the relevant lead/tour; then perform an approved live inbox test. The receipt’s shape alone does not prove consent. Preserve the original uncertain-send identity during recovery. See [delivery contract](../docs/email-delivery.md).

Owner: choose a sending identity/domain and test recipient when activation is prepared, and supply access through secure provider settings. Voice auditions and a bounded Vast evaluation remain separate priorities. AT-129 Force Promote approval is still pending; this feature branch does not bypass it.

Next agent must leave a reciprocal handoff including changes, exact commit/branch, actual verification, deployment boundaries, owner to-dos and next-agent to-dos. The full leasing product goal remains active.
