# Isolated hosted preview

Use a separate PostgreSQL database for a working hosted preview of the current
dashboard. This is deployment setup once per environment; staff subsequently use
their saved username/password and passkey. A successful website build or public
health check is not evidence that the dashboard can be signed into.

## Prepare resources

1. Choose the owner's approved Free organization and confirm current capacity and
   pricing in the provider. Use a dedicated preview project. Do not reuse the
   production-intended Supabase project or the production KV store. Free projects
   may pause; verify availability before a presentation. This procedure does not
   purchase resources or keep a project artificially active.
2. Select one stable preview branch and use the exact branch alias returned by
   Vercel as its canonical HTTPS origin. Keep the alias stable for passkeys. A
   per-commit deployment URL is useful for revision evidence but must not replace
   the configured authentication origin on each release. Do not invent an alias.
3. Keep maintenance input and generated credentials private, as described in
   [hosted demo setup](hosted-demo.md#private-operator-input). Use fresh independent
   role passwords, session secret and a preview account credential. Never copy
   production login secrets. The fictional inventory is bundled; do not import
   real caller records into this environment.
4. Atrium uses restricted direct PostgreSQL connections; it does not require the
   Supabase public Data API. Leave that API disabled for this preview project.

## Channel-free provisioning

Use the same private configuration schema and CLI as hosted demo setup, with
`purpose: "preview"` and `bindings: []`. The origin and project reference must be
the actual isolated preview resources. No live Vapi assistant ID is needed.

```sh
node scripts/hosted-demo.mjs --check /private/operator/preview-setup.json /private/operator/preview-runtime.json
node scripts/hosted-demo.mjs --apply /private/operator/preview-setup.json /private/operator/preview-runtime.json
```

These are path examples; use actual private paths. `--check` performs no network
or database operation. `--apply` creates restricted roles, applies the existing
ordered migrations, and atomically seeds a persisted Larkin owner, explicit
property grant and dated fictional catalogue. It creates no channel binding,
call, tour, email, callback configuration or synthetic operational history.

The bootstrap marker records the preview purpose. Reruns preserve credentials,
passkeys and saved operational data. Changing to demo purpose or supplying any
voice binding is refused. A subsequently added channel binding also refuses
preview readiness; the helper does not delete it or silently adopt it. Existing
demo manifests remain unchanged. This is a provisioning safeguard, **not** a
runtime permission system or a way to prohibit all later administrator changes.

The CLI verifies connections using both actual restricted roles and refuses
unscoped data access. Its output reports `purpose: "preview"` and
`voiceBindingsVerified: false`. That false value is expected: no provider channel
was connected or tested. The proposed in-memory content-validation actor is never
stored as a channel and cannot authorize a runtime request. A first real staff
login and passkey enrollment remain separate acceptance steps.

## Vercel configuration

Set the generated five runtime settings for **Preview and the selected branch
only**: `ATRIUM_RUNTIME_MODE`, `ATRIUM_DATABASE_URL`, `ATRIUM_AUTH_DATABASE_URL`,
`OPS_SESSION_SECRET`, `ATRIUM_AUTH_ORIGIN`; add the optional trusted database CA if
required. Never upload maintenance credentials or change Production values as
part of this procedure. Runtime database roles must remain separate and limited.

Review effective inherited settings before enabling the preview. Production KV
credentials, lead webhook destinations, Vapi credentials, sender keys and other
external provider configuration must not be available to the isolated branch.
Do not solve this by copying the production shared passcode. The September 25
[scope correction](../reports/2026-09-25-preview-isolation.md) removed Preview from
the five Upstash connection variables, `GLOBAL_CONFIG`, and `LEAD_WEBHOOK_URL`.
Production and the pre-existing Development targets were retained. The saved
project inventory showed no Preview variables or linked shared variables afterward.
Recheck this inventory before activation; integrations or later edits can change it.
Older deployments retain their original environment settings. They are not isolated
by this scope correction and must not be reused as the accepted Preview. A new build
needs its separate runtime/login settings first. Future legacy Preview builds now
refuse missing durable storage instead of inheriting the live database. Changing
Preview inheritance affects all preview branches; preserve Production's values.

Rebuild the same reviewed revision in Preview after settings are saved. Record
the exact source hash, deployment ID, branch alias and applied migration list.
Do not use Force Promote or change the production branch as part of this setup.
An earlier production-promotion approval remains a separate decision.

## Acceptance and limits

- Run the [public preflight](demo-readiness.md) against the exact new deployment;
  expect PostgreSQL health and a real sign-in page, with unauthenticated APIs
  refused. Missing global call history is expected until a separately reviewed
  test voice channel exists. Inspect each result instead of treating a warning
  or provider error as a pass.
- Verify Larkin username/password sign-in, the owner's real passkey enrollment,
  authenticated desktop/mobile pages and refusal of foreign property requests.
  Check persisted unit blocks, booking/rescheduling and retry behavior using
  explicitly synthetic records. Refresh and re-login to verify persistence.
- Confirm no live calls, recordings, contacts or provider credentials are exposed.
  No voice call or notification can be presented as accepted by this procedure.
  A later voice sandbox needs its own assistant, credentials, routing, bounded
  budget and complete call-to-tool-to-dashboard tests.
- Preserve the prior preview configuration for rollback. Rolling back an
  application is not a database restore, data merge or proof of future uptime.

Provisioning a preview does not activate production, complete the pilot, measure
voice latency or satisfy the held-out routine-call target.
