# Atrium

AI leasing and resident operations for multifamily buildings.

## Where this is

A working voice leasing agent with the safety machinery built first, plus a demo property
(**The Larkin**, a fictional 318-residence tower in Long Island City) to exercise it against.

**149 tests, no dependencies.** Node 22 runs the TypeScript directly.

```
npm test              # unit + handler integration tests
npm run build         # bundle the API function for deploy
node scripts/validate-data.mjs   # check property data against the runtime contracts
```

See `SETUP.md` for getting the phone line live.

## The one idea worth understanding

Every rule that matters is enforced in **code the model cannot argue with** — not in the
system prompt. A prompt instruction is a request. A tool that refuses is a constraint.

A caller who talks the agent into wanting to quote a price still gets a refusal, because
the quote gate lives in the tool implementation, not the prompt.

### Three kinds of question

The *classification* decides what may happen — not the retrieved content, not the model's
confidence.

| Kind | Examples | What the agent may do |
|---|---|---|
| **Restricted** | vouchers, accommodation, eligibility, disputes, legal, money | **Never answers.** Escalates with full context. No confidence level unlocks this. |
| **Volatile** | rent, availability, tour slots, account status | **Never answers from the knowledge base.** Defers to the live source, verified by read-back. |
| **Policy** | pets, parking, hours, amenities | May answer — but only from an article that is published, human-approved, in scope for the property and jurisdiction, and not past its review date. |

Two consequences that are easy to miss, both covered by tests:

- A restricted topic escalates **even with a perfect published article at confidence 1.0**.
- A rent question defers to live inventory **even when an article answers it**. A stale
  quote loses the lease *and* is a compliance problem.

### Three more guards

**The quote gate.** No rent is stated until at least two of move-in timing, bedroom need
and budget are captured. Quoting blind is how a $4,200 residence gets shown to someone with
a $2,500 ceiling, and how the loss reason becomes "went quiet" instead of the truth.

**Priced out is a first-class outcome.** When nothing fits the stated budget, the agent
says so and records the gap **as a number**. It does not quietly offer something dearer.
That number is the countable loss reason the whole product exists to produce.

**Read-back before "confirmed."** A booking is written, then re-read from the calendar and
compared. Only a match may be called confirmed; an unverified write says "being arranged"
and a failure says a person will call back. What the agent may say is derived from booking
state, so no conversational pressure produces a false confirmation.

### Emergencies

Detection runs ahead of intent classification, qualification, knowledge and authority — and
uses fixed approved instructions rather than generated text.

It is keyword-driven on purpose. A model having a bad day can misclassify "I smell gas"; a
keyword list cannot. Probing the first draft found seven false positives — *"can I smoke in
my apartment"* and *"is there a fire pit on the roof"* both routed to a fire emergency. A
leasing line takes far more amenity questions than emergencies, and a detector that cries
wolf trains staff to ignore it. All 20 benign probes and 21 emergency phrasings are now
locked in as tests.

## Evidence, everywhere

Every captured value carries its provenance, confidence, source interaction, and **the words
that justified it**. The dashboard cannot say "budget: $4,200" — it says
*"budget: $4,200, from 'up to about forty-two hundred', call #1, 87% confident."*

Human corrections outrank the model permanently, at any confidence. Between two AI
extractions the later one wins, because people revise mid-call.

This was built in from the first commit deliberately. Retrofitting provenance means going
back through every field and guessing where values came from.

## Layout

```
src/knowledge/      the three-way classification, article governance, decision engine
src/leasing/        the quote gate and evidence provenance
src/inventory/      validating loader, matching, the priced-out branch
src/booking/        read-back verification and idempotency
src/escalation/     emergency detection and escalation context
src/conversation/   the tools, where the guards actually live
src/record/         the shared operational record
src/email/          template rendering with escaping
src/vapi/           system prompt and assistant config
src/ops/            the session gate in front of the dashboard and its log
api/vapi.ts         the webhook Vapi calls; GET serves the dashboard log, gated
api/dashboard.ts    serves the operations dashboard, behind the same gate
data/               the demo property, inventory, knowledge and policies
ops/dashboard.html  the dashboard page, compiled into api/dashboard.ts
public/             the building website — and only what is safe to serve openly
scripts/            build, deploy manifest, assistant config, data validation
```

## Who can read the call log

The event log behind the dashboard is the most sensitive thing this service holds: prospect
names, email addresses, budget ceilings, and verbatim excerpts of what a caller said. It
shipped as a page in `public/` polling an open endpoint, which meant anyone who guessed the
URL read the whole leasing pipeline — a NY SHIELD Act reasonable-safeguards failure, and the
opposite of what the site's privacy notice promises.

Both halves are now gated by `OPS_DASHBOARD_PASSCODE` (`src/ops/session.ts`):

- the page is not a static file any more, it is served by `api/dashboard.ts` after sign-in
- `GET /api/vapi` returns 401 without a session, and no partial answer — there is
  deliberately no redacted public shape for someone to add a field to later
- with no passcode configured, both refuse everyone rather than falling open
- `public/robots.txt` disallows the routes as well, which is a note to crawlers, not a control

## Working in this repo

Node runs the TypeScript in **strip-only mode** — no runtime dependencies, but also no
TypeScript syntax needing real transformation: no `enum`, no constructor parameter
properties, no `namespace`, no decorators. Types, interfaces and `satisfies` are fine.

The only dependencies are dev-only: `typescript` and `@types/node`, so that
`npm run typecheck` runs here and Vercel's build log stays clean. Run `npm install` once.

Secrets are read in exactly one place, `src/config/env.ts`. It holds the credential
inventory, throws by name when one is missing, and exposes `redact()` so a key cannot be
logged by accident. Never in the repo, never in chat, never in a screenshot.

## What is not real yet

- **SMS** — needs 10DLC, which needs the EIN.
- **Apple Messages for Business** — needs the entity and Apple's review.
- **The tour calendar** is an in-memory demo, not Google Calendar or a PMS.
- **The dashboard log** lives in the function's memory and resets on cold start. The
  `RecordStore` interface in `src/record/store.ts` is waiting for a KV implementation.
- **The building is fictional.** Every residence, rent and policy is invented.

## Traceability

Dashboard access control and the credential inventory are SOW §15.2 and §18.2.

Knowledge governance is SOW §7.3; the never-guess rule §5.2(3), §6.2 and §7.1;
restricted-topic escalation §3.2, §5.2(7) and §10; the quote gate §5.2(4); evidence-linked
prospect records §6.3; loss-reason capture §6.2; read-back verification and truthful
messaging §13.3; emergency routing §8.1; escalation context §10; secrets and credential
inventory §15.2 and §18.2.
