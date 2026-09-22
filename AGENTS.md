# Atrium agent instructions

Read [AI_WORKFLOW.md](AI_WORKFLOW.md) before claiming work and
[docs/agent-tasks.md](docs/agent-tasks.md) for ownership and status.
These are the shared contract for Codex, Claude Code, and Fable.

## Project conventions

- This directory is the application Git root. Run Git and npm commands here.
- Read README.md, ARCHITECTURE.md, and TENANCY.md for relevant behavior before editing.
- Use Node 22 and npm with package-lock.json. TypeScript is strict ESM with explicit
  `.ts` imports and Node strip-only syntax: no enums, parameter properties,
  namespaces, or decorators. Match nearby style (normally two spaces, single quotes,
  no semicolons); avoid unrelated formatting and unnecessary dependencies.
- Keep domain rules in src/, HTTP boundaries in api/, dashboard source in ops/src/,
  and public website assets in public/. Follow existing build scripts for generated
  dashboard artifacts; do not patch compiled output as the only source of a fix.
- Preserve server-side authorization, property/organization scoping, provenance,
  quote gates, restricted-topic escalation, emergency routing, and booking read-back.
  UI state or model output must not bypass those constraints.
- Keep secrets and real caller data out of source and coordination notes. Use
  synthetic examples. Do not copy environment files into handoffs or worktrees.
- Add focused regression coverage for behavior changes. Record commands and actual
  outcomes; distinguish existing failures from failures introduced by your change.

## Commands

Run from this directory with Node 22:

```sh
npm ci                 # install locked dependencies when needed
npm run check          # TypeScript, fixture validation, unit/API/portal tests
npm run test:database  # isolated PostgreSQL integration tests
npm run build          # site/dashboard and API build with module smoke checks
```

CI runs all three checks after installation. Run relevant checks during development
and the CI suite before calling an implementation ready for integration; explain
any blocked or skipped check. Documentation-only edits require link/path and
instruction verification, not an unrelated application test run. `npm run dev:ops`
starts the local preview; only one process may own its local database.
`npm run simulate` uses paid model calls; it is not a default offline check.

## Roles and scope

Codex defaults to implementation, refactoring, tests, and repo automation.
Claude Code defaults to investigation and independent technical review.
Fable defaults to product/design/UX plans and acceptance review. These are defaults,
not capability guarantees or exclusive permissions; task assignment controls scope.
Do not start other agents solely because these files exist. Use the user's current
authorization for deployment, publishing, external communication, and other actions.
