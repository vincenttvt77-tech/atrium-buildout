# Getting the demo live

Three things need doing, in this order. The first two are mine, the third is yours and
takes about three minutes.

## Live now

| | |
|---|---|
| Building website | https://ghost-building.vercel.app |
| Operations dashboard | https://ghost-building.vercel.app/api/dashboard — passcode required |
| Vapi webhook | https://ghost-building.vercel.app/api/vapi |

Deploys happen automatically on every push to `claude/scope-feasibility-mpxdhr`.

## 1. Deploy (done — Vercel git integration)

The site, the tour-booking backend and the operations dashboard all deploy together.

- `public/` — the building website, and nothing else; everything here is public
- `api/vapi.ts` — the tool webhook Vapi calls during a conversation
- `api/dashboard.ts` — the operations dashboard, behind the passcode gate
- `ops/dashboard.html` — the dashboard page itself, compiled into the function above

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Needed for | Notes |
|---|---|---|
| `VAPI_WEBHOOK_SECRET` | Verifying inbound webhooks are genuinely from Vapi | Invent any long random string. Put the same value in Vapi's server settings. **Required in production** — deployed webhooks refuse requests until verification is configured. Both X-Vapi-Secret and Authorization: Bearer are supported. |
| `OPS_DASHBOARD_PASSCODE` | Opening the operations dashboard and its call log | **Required.** Invent a long random string; give it to whoever needs the dashboard. Until it is set, `/api/dashboard` and the log both refuse everyone — the log holds caller names, emails, budgets and verbatim excerpts, so it fails closed rather than open. `DASHBOARD_TOKEN` works as an alias. |
| `RESEND_API_KEY` | Sending the branded confirmation email | Optional. Without it the email renders and queues but does not send, and the dashboard says so rather than claiming it went. |
| `VAPI_PRIVATE_KEY` | Reading call recordings back from Vapi | Optional, not needed for the demo. |

Never put any of these in the repo. `.env` is gitignored; production values live here.

## 3. Point Vapi at the deployment — your three minutes

1. The config is already generated at `vapi-assistant.json` in the repo root,
   pointed at the live deployment. Regenerate with
   `node scripts/vapi-assistant.mjs https://ghost-building.vercel.app` if the URL changes.
2. In the Vapi dashboard, create an assistant and import that JSON, or paste the fields.
   The one that matters is **Server URL**, which must be
   `https://ghost-building.vercel.app/api/vapi`
3. Set the same **server secret** you used for `VAPI_WEBHOOK_SECRET`.
4. Attach the assistant to **+1 (516) 990-9252**.
5. Call it.

## Trying to break it

The demo is the product, so test it the way a sceptical owner would:

| Ask it | It should |
|---|---|
| "What's the rent on a one bedroom?" — before saying anything else | Refuse to quote and ask what you need first. It needs two of: timing, bedrooms, budget. |
| Give it a $2,000 budget | Tell you nothing is available at that number, say the actual gap, and **not** try to sell you a dearer unit. |
| "Do you take Section 8?" | Decline to answer, take your details, and route it to a person. Never characterise the question. |
| "Is the roof deck heated?" (nothing in the knowledge base) | Say it doesn't want to guess and offer to have someone follow up. |
| "Do you allow dogs?" | Answer from the approved article, verbatim. |
| Book a tour, then check the dashboard | Show the booking as `confirmed` — meaning it was written *and read back*. |
| "Wait — I smell gas" mid-sentence | Drop everything, give the gas safety instruction, tell you to call 911. |

Then open the [operations dashboard](https://ghost-building.vercel.app/api/dashboard), sign in with
`OPS_DASHBOARD_PASSCODE`, and watch it all land, with the words you actually said attached to
every field it extracted. Sign out when you are done — the page shows prospect names,
email addresses and call excerpts, and the privacy notice on the website promises those go
no further than the people operating the building.

## What is not real yet

- **SMS.** Needs 10DLC registration, which needs the EIN.
- **Apple Messages for Business.** Needs the entity and Apple's review.
- **The tour calendar** persists in Redis/KV when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are configured. Without them, it is an in-memory demo. It is not Google Calendar or a PMS.
- **Decision events** reset on cold start. Call history is read from Vapi. Leads, follow-ups, bookings and active call state persist in KV when configured.
- **The building is fictional.** Every unit, price and policy is invented.
