# Preview isolation checkpoint — September 25, 2026

AT142 follow-up, Codex root. Previous goal turn completed exact-source cloud
acceptance; this turn changed the saved hosting configuration. Application source
remains `ecbe8d30dc373f38f9fcf8637412971cbaaee689`. No application code, production
deployment, database schema, voice setting or paid service trial changed.

## Saved changes and verification

The signed-in Vercel dashboard for `ghost-building` confirmed that new Preview
deployments inherited the live storage connection and lead destination. The
following changes were saved and their targets read back from the dashboard:

| Setting | Before | After |
| --- | --- | --- |
| Upstash connection: `KV_REST_API_TOKEN`, `REDIS_URL`, `KV_REST_API_URL`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL` | Production, Preview, Development | Production, Development |
| `GLOBAL_CONFIG` | Production, Preview, Development | Production, Development |
| `LEAD_WEBHOOK_URL` | Production, Preview | Production |

Only environment targets were edited. No value was typed, copied, rotated or
included in this report. Upstash's existing project connection was updated rather
than disconnected. The current Production-only login and Vapi settings were left
in place. The final Preview filter showed **No Environment Variables Added**; the
Shared tab showed **No shared variables linked**. This is saved configuration
evidence, not an inspection of a rebuilt runtime. Source searches found no use of
`GLOBAL_CONFIG` in the current application; it was still excluded because it is a
live configuration connection available to deployed code.

Vercel applies environment changes to new deployments, not existing deployments:
[official environment documentation](https://vercel.com/docs/environment-variables).
Older Preview deployments therefore retain their prior settings. Do not use one as
the isolated acceptance environment. Future legacy Preview builds will lack durable
storage and refuse storage operations until the separate managed runtime is set up.
Production and pre-existing Development targets remain available.

## Public production check

After the scope change, bounded unauthenticated reads returned:

- `/api/health`: HTTP 200, `ok: true`, `store: kv`, `durable: true`,
  `callHistory: true`.
- `/api/dashboard`: HTTP 401 with the sign-in page and password/passcode input.
- The public deployed tool hash remains
  `fea94b5f3600f6764a1b803b05fc86757e91c85e9cf7a86b98abf0ca6f606c6d`.

The initial sandbox transport could not reach either route. The authorized
network check succeeded; the first helper classified the expected 401 as a generic
HTTP error, so a follow-up inspected its status and confirmed the sign-in page.
These observations do not verify a successful login, data isolation, phone tool
authentication, notification delivery or future uptime.

## What remains

The prepared Supabase Preview creation form still awaits the private owner step.
No new project, role, credential or migration was created in this checkpoint.
After provisioning, install the five separate runtime/login settings for one stable
Preview branch, rebuild the reviewed source, and verify real login/passkey,
tenant boundaries, persistence and the leasing flows. Follow
[hosted Preview](../docs/hosted-preview.md). Do not copy the production passcode or
enable a live provider in that channel-free Preview.

A later isolated phone trial needs its own reviewed assistant/channel, matched
webhook credentials, service funding and actual phone-to-tool-to-dashboard evidence.
Vast.ai and Black American/Latina female voices remain evaluation candidates; no
hosting switch, generated audition or measured speedup occurred. AT129's production
promotion boundary remains separate. The full leasing goal is active.

## Reciprocal handoff

Owner: finish the private Preview-project creation already requested; supply
approved building rules, representative permissioned calls and a bounded voice trial
budget; select a licensed voice after listening. Keep credentials out of reports.

Codex/Fable: recheck saved scopes before any new build, complete isolated hosted
acceptance when inputs arrive, then establish the actual successful phone baseline
and compare voice-only, hosting-only and combined trials. Preserve unrelated calendar
work. Do not restore Preview inheritance merely to make a legacy health check green.
Rollback, if deliberately needed, consists of restoring the recorded target sets;
it requires another deployment to affect runtime and reintroduces live-resource
access. End the next session with exact changes, tests, deployments, limitations,
owner to-dos and next-agent to-dos.
