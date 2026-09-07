# Atrium

AI leasing and resident operations for multifamily buildings.

## Where this is

Early. This repo currently contains the **knowledge safety core** (what the agent may answer at
all), the **qualification gate** (what it must learn before quoting), and **secret
handling**. The voice adapter, inventory and tour booking are still ahead.

The knowledge safety core was deliberately the first thing built. The difference between a product and a chatbot
that loses you a Fair Housing complaint is whether it will confidently say something it
cannot support, and that property has to be structural rather than a prompt instruction.

## Running it

Requires Node 22.18+. There are **no dependencies** — Node runs the TypeScript directly.

```
npm test          # 45 tests, no install step
npm run typecheck # needs tsc; optional
```

## The one idea worth understanding

Every question is classified into one of three kinds, and the *kind* decides what may
happen — not the retrieved content, not the model's confidence.

| Kind | Examples | What Atrium may do |
|---|---|---|
| **Restricted** | accommodation requests, eligibility, disputes, legal, money | **Never answers.** Escalates to a human with full context. No confidence level unlocks this. |
| **Volatile** | price, availability, tour slots, account status | **Never answers from the knowledge base.** Defers to the owning live system, and the answer is verified by read-back before it is spoken. |
| **Policy** | pet policy, parking, hours, amenities | May answer — but only from an article that is published, human-approved, scoped to this property and jurisdiction, and not past its review date. |

Two consequences that are easy to miss and are covered by tests:

- A restricted topic escalates **even when a perfect, published article exists and
  confidence is 1.0**. Content never overrides classification.
- A price question defers to live inventory **even when an article answers it**. A stale
  quote is worse than no quote — it loses the lease and it is a compliance problem.

When Atrium cannot answer, it does not improvise. It refuses, offers a human, and files
the gap as a proposed article carrying a `timesAsked` count so the questions residents
actually ask rise to the top of the review queue. An AI-generated answer can never become
approved policy: `approvedBy` is a person, and nothing can set it to a machine.

## Working in this repo

Node runs the TypeScript directly in **strip-only mode**, which means no dependencies but
also no TypeScript syntax that requires real transformation: no `enum`, no constructor
parameter properties (`constructor(public readonly x: T)`), no `namespace`, no decorators.
Types, interfaces and `satisfies` are all fine. Write the field out explicitly instead.

## Secrets

Never in the repo, never in chat, never in a screenshot. `src/config/env.ts` is the only
place secrets are read; it holds the credential inventory (SOW 18.2), throws by name when
one is missing, and exposes `redact()` so a key cannot be logged by accident.

Locally: copy `.env.example` to `.env` (gitignored). In production: the host's environment
variable store, never a file.

## Layout

```
src/domain/ids.ts          branded identifiers
src/knowledge/topics.ts    the three-way classification and live-source routing
src/knowledge/article.ts   article governance — approval, scope, versioning, review dates
src/knowledge/answer.ts    the decision engine
src/knowledge/test/        tests, mostly asserting what the agent must refuse to do
src/leasing/captured.ts    evidence provenance — every field knows where it came from
src/leasing/qualification.ts  the quote gate: two of three signals before any price
src/config/env.ts          secret access, credential inventory, redaction
```

## Next

1. ~~Qualification — capture move-in timing, budget, unit need before quoting~~ done
2. Live inventory from CSV/Sheet (no PMS partnership needed for the first building)
3. Tour booking with read-back verification
4. Loss-reason capture with linked conversation evidence and confidence
5. Follow-up sequencing with objection-specific logic and hard stop conditions
6. Escalation routing
7. Voice/SMS adapters — deliberately last, and behind an interface, so the vendor choice
   stays reversible

## Scope note

Traceability to the Scope of Work: knowledge governance is §7.3, the never-guess rule is
§5.2(3)/§6.2/§7.1, restricted-topic escalation is §3.2/§5.2(7)/§10, and configurable
confidence thresholds are §15.3.
