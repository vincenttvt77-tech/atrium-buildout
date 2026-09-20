# Demo build-out

Work by Luke Brzozowski's side of the project, additive to the branch Evan Mavashev built.
The purpose is a working demonstration of the parts of the Scope of Work that the existing
branch does not yet cover, without editing a file he wrote.

## The rule this plan exists to keep

No file authored on `codex/atrium-quality-pass` is modified. Everything here is a new file.
Where a change would normally hook into an existing file, it is not made; it is recorded in
**Hooks not taken** below, as a request for the author to accept or refuse later.

That constraint is satisfiable because of three properties of the existing build:

| Seam | Why additive work fits |
| --- | --- |
| `api/*.ts` | `scripts/build-api.mjs` globs the directory, so a new endpoint file is bundled with no edit. |
| `supabase/migrations/` | Files are timestamp-ordered with checksums, and applied history must be a prefix of the ordered list. A migration dated later than every applied one is additive by construction. |
| `ops/src/` | The dashboard is composed from `index.html` through `<!-- @include -->` directives. A second page needs its own shell and its own compose script, not a nav entry in his. |

## Where the demo layer lives

```
supabase/migrations/20260917*_demo_*.sql   schema atrium_demo, additive migrations
src/demo/                                  domain logic, mirroring the src/ convention
api/demo-*.ts                              endpoints, bundled by the existing globber
demo-ops/                                  our dashboard shell and assets
scripts/build-demo-ops.mjs                 our compose step, modelled on build-ops.mjs
test/database/demo-*.test.mjs              end-to-end tests on the existing fixture
docs/demo-buildout/                        this plan and the decisions under it
```

## Use what is already here

The first version of this work reimplemented `src/workflows`, which was a waste and a
second account of the same events. It was deleted before anything was shared.

`src/workflows` is a finished durable execution engine: lease-based claim, separate dispatch
and verify phases, read-back required before any success, no blind re-send after an
ambiguous result, bounded attempts, backoff with jitter, revision fencing, and a
`needs_review` settlement for anything a person must look at. `PostgresWorkflowRepository`
implements its storage against the live schema, and the Work queue screen reads it.

What was missing was anything to plug into it. As of 2026-09-17 no `WorkflowConnector` had
ever been implemented and nothing in the repository called `runWorkflowOnce`, which the
README states plainly at line 49. That is why the queue screen shows rows that never move.

So the rule for this layer: check for an existing contract before writing a mechanism, and
implement the contract. Before building anything here, search `src/` for the interface that
already expects it.

## Where this stands, 2026-09-20

Done on this branch:

1. **The first connector, and something to turn the queue.** A stand-in property-management
   system implemented as a `WorkflowConnector`, and a bounded runner that calls
   `runWorkflowOnce`. The stand-in can be armed to fail in the ways that break naive
   integrations, so a demonstration can show a write leaving Atrium, a lost response, the
   queue holding the work, and recovery without a duplicate booking. 17 tests, 8 of them
   against the live engine and PostgreSQL repository. *(Scope of Work 13.1, 13.2, 13.3.)*
2. **Emergency alerts that reach a person.** Detection and the record already existed;
   nothing delivered them. First contact immediately with no queue and no approval step,
   then the chain, with a failed send skipping on rather than consuming the window, and
   running out of contacts stored as its own state. The stand-in transport reports
   `recorded` and never `delivered`. 28 tests. *(8.1.)*

Not yet: persistence and a live call hook for the emergency path, and an operator view for
either piece.

## Everything the Scope of Work still needs

Nothing below is built by anyone, on either branch, unless noted. Sizes are rough.

| # | What | Scope | Size | Blocked on |
| --- | --- | --- | --- | --- |
| 1 | Emergency: persistence, live call hook | 8.1 | small | nothing, in progress |
| 2 | Resident texting, one thread across channels | 5.4, 7.1, 7.2 | large | nothing |
| 3 | Apple Messages for Business | 5.3 | large | Apple approval |
| 4 | Amenity booking | 9 | medium | item 2 |
| 5 | Owner dashboard, ROI, weekly review | 11, 12 | large | nothing |
| 6 | A connector to a live property system | 13.1, 13.2 | medium | client credentials |
| 7 | Callback on a web lead within ~15 seconds | 6.2 | medium | outbound calling |
| 8 | Follow-up sequences and application chasing | 6.2 | medium | item 2 |
| 9 | Launch a building without a developer | 14 | medium | nothing |
| 10 | Automated safety scenarios before each release | 16.1 | medium | nothing |
| 11 | 24 months of history imported per building | 11.5, 14.2 | medium | client data |

Outside the code, and on the critical path because of lead times:

| # | What | Owner |
| --- | --- | --- |
| 12 | Apple business verification, brand and per-building location approval | the owner, start immediately |
| 13 | Phone numbers and messaging sender registration with the carriers | the owner, start immediately |
| 14 | Security review before any live activation | an outside firm |
| 15 | Manuals and recorded training for handover | whoever hands over |
| 16 | The seven failing database tests | the author of that code |

**Order.** Finish 1. Then 2, because it unlocks 4 and half of 5. Then 5, because that is
what an owner is actually buying. Then 4, 7, 8.

Items 3 and 6 wait on other people, so 12 and 13 should start before any of the above or
they become the critical path.

**Largest single risk:** item 5 is entirely unbuilt and it is the part being sold.

## Assumptions

- The Larkin stays fictional and labelled. No fixture is dressed up as a client, a
  resident or a live system of record.
- No external provider account is required to run the demonstration. Transports are
  interfaces with a demo implementation, so a live provider is a later substitution rather
  than a rewrite.
- Nothing here is deployed, and no production credential is introduced.

## Deviations from the surrounding conventions

**Role isolation.** Every feature in the `atrium` schema owns a dedicated Postgres executor
role, created in `scripts/lib/local-database.mjs`, `scripts/lib/foundation-test.mjs` and
`scripts/lib/hosted-demo-database.mjs`, and listed in the guard at
`src/database/connection.ts:81`. Adding a role to that pattern means editing four of his
files. The demo layer therefore uses schema-level isolation in `atrium_demo`, reachable by
`atrium_app`, and accepts weaker separation than the code around it. This is the first item
to revisit if the layer is ever promoted.

## Hooks not taken

Recorded rather than made. Each is a small change to a file we do not edit.

| File | What it would need | Why it is wanted |
| --- | --- | --- |
| *(none yet)* | | |

## Verification

The existing checks must stay green, and ours run inside them: `src/demo/**/*.test.ts` is
already matched by his `npm test` glob, so a regression we introduce fails his suite rather
than hiding in a separate one.

```
npm run check          # types, fixtures, unit and handler tests
npm run test:database  # migrations, authorization and HTTP against real PostgreSQL
```

### Inherited failures, measured 2026-09-17

`npm run test:database` reports 488 passed and 7 failed on this machine. The same seven
fail with our migration moved out of the directory, so they are inherited rather than
introduced:

```
96, 97   inbox rechecks requester_grant / configuration when the change does not update the case
100-102  all inbox items use final database time after policy / vendor_review / availability expiry
276      a ceremony expiring while blocked on the property fence commits neither decision nor update
280      source expiry during the final receipt insert wait rolls back a signed decision and counter
```

They are the same seven, by number and name, that the repository's own CI reported on
2026-09-16. They passed in CI on 2026-09-13 on the identical commit, and they fail
repeatably here, so the cause is more likely the environment the suite runs in than a
change in the code. Treat 488/7 as the baseline for this branch until it is diagnosed, and
do not read a seven-failure result as evidence that demo work broke something.
