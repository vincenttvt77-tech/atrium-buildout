# Reliability release — September 22, 2026

## Published implementation

[Commit 1f952f2](https://github.com/vincenttvt77-tech/atrium-buildout/commit/1f952f20483b8634f64ddb5e6545e62c13f4d9fc) is published on `codex/atrium-quality-pass`, including the reviewed 06eb3f4 and 93cbed2 increments. A normal fast-forward preserved remote history and excluded the older unfinished source in the original checkout.

Includes safe staff reconciliation of uncertain tour bookings, recovery from partial record updates, Status failure/recovery handling, read-only deployment preflight, bounded apartment shortlists and truthful budget/date alternatives. The [revised goal](../docs/leasing-goal.md) is also on GitHub. The shared board and recent task/review records accompany this report so a GitHub-only agent can inspect them.

## Actual acceptance evidence

[GitHub quality run 35769173630](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/35769173630), job 106886225259, completed successfully. Its logs confirm 1,634 application tests, 498 isolated PostgreSQL tests, and 17-handler build smoke checks. TypeScript and fixture validation passed. These match the local release results. Prior synthetic Chromium recovery acceptance covered 24 checks at 320/390/1280 pixels; the subsequent shortlist increment did not modify UI code.

[Vercel preview 2nEk5RChVMnP4ifG8f7KjejYK13F](https://vercel.com/vincenttvt77-9161s-projects/ghost-building/2nEk5RChVMnP4ifG8f7KjejYK13F) built successfully in 44 seconds from exact commit 1f952f2. Its unauthenticated preflight reported persistent storage and matching backend contract, but missing history configuration and 503 responses from protected routes. The preview does not have production's authentication settings and is not a usable staff demo.

## Production remains unchanged

Vercel's signed-in dashboard freshly showed production 5ef64688ddc687fd24d393f91f4b84b15b77078c, deployment HfvECEzbsU4SZYodAsUehQW2ZmdK, Ready. Eight read-only preflight assertions passed at 18:47:55 UTC. Actual staff sign-in succeeded, and Status showed loaded calendar/callers/history with persistent saving and explicitly fictional inventory. These checks are current observations, not future uptime or fresh phone-call proof.

The Vercel connector could not access this team; native signed-in UI was available. Automatic approval review blocked opening **Force Promote to Production** because the preview failed authentication checks. After the first rejection, full CI success and [Vercel's documented production rebuild behavior](https://vercel.com/docs/deployments/promoting-a-deployment) were verified. A second attempt was still rejected. An explicit owner approval question is pending. No workaround, promotion, environment change, schema migration, Vapi publication or customer-data change occurred.

## Owner and next-agent actions

Owner: approve the specified production deployment flow if desired. Provide representative permissioned leasing calls, confirmed property facts/rules and funded phone rehearsal access for the next evaluation phase.

Codex: after approval, inspect the production confirmation, proceed only with the existing production configuration, verify new exact deployment/source and authenticated browser flows, and inspect runtime errors. Keep a known previous deployment for rollback. Do not promote the misconfigured preview artifact by merely changing an alias. Actual phone/audio/tool execution and notification delivery remain separate acceptance work.

Fable: the implementation and revised goal are now GitHub-accessible. Review the published source, source-specific evidence and remaining roadmap without assuming production has advanced. Preserve older partial files locally. End with a reciprocal handoff specifying commits, changed files, actual checks/failures, local/remote/deployed state, owner actions and next-agent actions. Require the following agent to do the same.
