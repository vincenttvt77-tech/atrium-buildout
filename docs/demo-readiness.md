# Read-only deployment preflight

With Node 22, run from this checkout:

```sh
node scripts/demo-readiness.mjs --origin https://your-deployment.example
node scripts/demo-readiness.mjs --origin https://your-deployment.example --json
```

Use the actual deployment origin. Paths, queries, credentials, fragments and plain HTTP are rejected before any request. No environment file or login is required. This command does not install a monitor or change a deployment.

The command makes six parallel GET requests: public home, health, the dashboard sign-in page, and unauthenticated call, calendar and lead endpoints. It does not read browser sessions, send credentials, log in, mutate records, change Vapi or consume calling credit. Redirects are refused, including same-origin redirects, so a hosting-provider login page cannot silently become successful application evidence.

Each request has a 10-second deadline, including reading its body. `--timeout-ms` accepts an integer from 100 to 30000. Bodies are bounded to 1 MiB for HTML and 64 KiB for JSON. Diagnostics contain fixed explanations, paths, HTTP status and observed duration, without raw server content, caller information, headers or arbitrary error messages. Output is written to standard output only; use an explicit destination if retaining evidence.

## What a passing result establishes

- Public HTML was served. JavaScript execution, visual layout, assets and navigation still need browser acceptance.
- Health reported a connected persistent KV or PostgreSQL store.
- The backend tool-contract version and fingerprint matched this checkout. This does not inspect or verify the saved Vapi assistant.
- The protected dashboard returned HTTP401 with recognizable generated sign-in form markup. The marker check is deliberately conservative; a changed template may require review. This is not a browser DOM or login test.
- The three protected APIs each returned HTTP401 with the application's expected minimal JSON refusal. Unexpected HTTP200, HTML errors, provider protection, redirects or extra data fields fail the check. This is one unauthenticated observation, not a full authorization or tenant-isolation audit.
- Global history-key presence, when reported, is configuration evidence only. PostgreSQL's public health response intentionally does not expose property history configuration. An unconfirmed global value is a warning; inspect history using an authorized property session.

Exit code **0** means `read_only_checks_passed`; **1** means a failure or warning needs attention; **2** means invalid input or the check could not run. No result means “the phone works” or “the demo is guaranteed.” Every report lists what is unverified.

## Presentation acceptance remains separate

Verify an actual login and authorized property data, desktop/mobile interaction, unit selection, forward calendar navigation, and the intended booking/rescheduling flow. Check Vapi balance, phone routing and the published assistant, then place an authorized rehearsal call. Confirm correct factual answers, acceptable audio/latency, actual tool results and the resulting dashboard record. Treat a booking as confirmed only with successful persistence/read-back and matching calendar evidence. Do not substitute mocked tools or a healthy storage response for that chain.

When a preflight fails, preserve its report, recheck a transient failure, and inspect the failing layer. Do not automatically reset data, rotate credentials, publish an editor draft or redeploy unfinished work. During an investor demonstration freeze, keep the known-tested release unless an observed blocker requires a separately reviewed fix.

For overnight operation, a local scheduler needs its host and app available. Refresh/sign in shortly before presenting because an open tab's API polling does not extend its eight-hour session. Continuous uptime, provider credit and telephony remain separate operational concerns.
