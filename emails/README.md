# Email templates

Hand-written HTML emails for The Larkin. One file per message. No build step, no
framework, no partials — the templates are the artifact that gets sent.

| File | Sent when | Sent by |
|---|---|---|
| `tour-confirmation.html` | A tour booking has read back as `confirmed` | `src/email/confirmation.ts` |

## Why these are written the way they are

Email clients are not browsers. Outlook renders through the Word HTML engine, Gmail
strips `<head>` in some contexts and rewrites the rest, and a dozen mobile clients each
have their own opinion. So:

- **Tables for layout, everywhere.** No flexbox, no grid, no absolute positioning,
  no `<div>` scaffolding. Every table carries `role="presentation" border="0"
  cellpadding="0" cellspacing="0"`.
- **Every visual rule is inlined** on the element it affects. The `<style>` block in
  `<head>` is progressive enhancement only — if a client drops it, the email still looks
  right, just without the mobile stacking and dark-mode inversion.
- **600px fixed column**, wrapped in an MSO conditional table so Outlook holds the width.
- **No external stylesheets.** The one external resource is the Google Fonts `<link>`,
  wrapped in `<!--[if !mso]><!-- -->` so Outlook never tries to fetch it. Apple Mail and
  a few iOS clients will load Cormorant Garamond and Jost; everything else falls back to
  Georgia and Arial, which is why every `font-family` declaration carries the full stack.
- **No images.** Nothing to block, nothing to host, nothing to break. The Equal Housing
  Opportunity mark is set as a bordered caps lockup; there is a commented `<img>` in the
  footer if you would rather host the HUD insignia.
- **Square corners on the button**, so it needs no VML fallback — a `bgcolor` table cell
  with a padded `<a>` renders identically in Outlook and everywhere else.

Rendered size with real values is about 33 KB, comfortably under Gmail's 102 KB clipping
threshold.

## Placeholders

Substitution is `{{placeholder}}`, handled by `render()` in `src/email/render.ts`. It is
deliberately not a template engine: no loops, no conditionals, no filters. Every value is
HTML-escaped on the way in, so a prospect named `<script>` cannot inject into an email we
send.

`tour-confirmation.html` uses exactly these eighteen, and every one of them is supplied by
`sendConfirmation()`. There are no missing placeholders and no unused values.

| Placeholder | Example | Notes |
|---|---|---|
| `{{prospectName}}` | `Dana Okonkwo` | As captured on the call. Escaped. |
| `{{buildingName}}` | `The Larkin` | From `ConfirmationContext`. |
| `{{address}}` | `5-08 46th Avenue, Long Island City, NY 11101` | Appears in the detail card and the footer. |
| `{{leasingPhone}}` | `+1 (516) 990-9252` | **Display text only.** See the `tel:` note below. |
| `{{leasingEmail}}` | `leasing@thelarkinlic.com` | Used as display text and inside `mailto:` hrefs. |
| `{{managementCompany}}` | `Halbrook Residential Management` | Footer attribution and copyright line. |
| `{{tourDate}}` | `Saturday, September 12` | Pre-formatted `en-US` long date in `America/New_York`. The template does no date math. |
| `{{tourTime}}` | `2:00 PM` | Pre-formatted, same timezone. The template appends "Eastern". |
| `{{unitId}}` | `26B` | Floor plus line letter. Also used in the preheader and in "What to expect". |
| `{{floorPlanName}}` | `Two Bedroom` | Plan name, not the code. |
| `{{bedrooms}}` | `2` | A bare integer. Rendered as "2 bed". A studio renders "0 bed", which is the NYC convention (`0x1`), not a bug. |
| `{{sqft}}` | `1012` | Bare integer. Rendered as "1012 square feet" — pass a formatted string if you want the thousands comma. |
| `{{monthlyRent}}` | `$7,190` | **Arrives with the dollar sign already on it** (`confirmation.ts` formats it). Do not prefix another `$`. |
| `{{concessionLine}}` | `Net effective. One month free on a 14-month lease.` | Sub-line under the rent. Built by `concessionCopy()` from the residence's own terms. |
| `{{concessionSentence}}` | `The rent we quote you for this residence is net effective and reflects one month free on a 14-month lease. Ask for the gross figure and we will give you both, on the spot.` | The "What to expect" paragraph. Same source. |
| `{{concessionDisclaimer}}` | `The advertised rent for this residence is net effective and reflects one month free on a 14-month lease. Gross rent is higher; ask the leasing office for both figures. Concessions vary by residence.` | Footer disclosure, ahead of the standing listing disclaimer. Same source. |
| `{{confirmationCode}}` | `LK-2026-0912-26B` | The booking's `externalId`. Appears in the preheader, the detail card, the reschedule copy, and the unsubscribe line. |
| `{{rescheduleUrl}}` | `tel:+15169909252` | The primary button href. Today `confirmation.ts` derives a `tel:` link from the leasing phone; swap it for an https booking URL and the button keeps working. |

### Three things that will bite you

**The `tel:` hrefs are hardcoded to `+15169909252`.** `{{leasingPhone}}` is the human
form — `+1 (516) 990-9252` — and putting that in an `href` is sloppy. So the three phone
links use a literal `tel:+15169909252` and show `{{leasingPhone}}` as the text. If the
leasing line ever changes, change both. (`{{rescheduleUrl}}` is the exception: it already
arrives E.164-normalized.)

**The concession is not the same on every residence, so the template states none.**
Four residences are on six weeks free over eighteen months and two carry nothing at all,
so `concessionCopy()` in `confirmation.ts` builds all three concession strings from the
residence's own `concession` field and the template just prints them. Pass it:
`concession: unit.concession` — the string verbatim, `null` when the residence has none.
Omit the key only when you genuinely do not know, and the email says so rather than
guessing. Never put the terms back in the HTML; `src/email/test/confirmation.test.ts`
fails if you do, and the reason it exists is that a $12,980 residence with no concession
was being sent a free month in writing.

**There are no conditionals, so every row always renders.** If a prospect books a general
tour with no residence selected, `unitId`, `floorPlanName`, `bedrooms`, `sqft` and
`monthlyRent` come through empty and you get blank rows in the detail card plus the
sentence "You will see Residence ,". Handle it upstream in `confirmation.ts` by passing a
sentence, not a blank:

```ts
unitId: req.unitId ?? 'to be selected on your visit',
floorPlanName: extras.floorPlanName ?? 'We will match one to what you need',
```

`render()` already reports anything it had to blank out in `RenderResult.missing`, and
`sendConfirmation()` surfaces that on `ConfirmationOutcome.missing`. It is never hidden.
Treat a non-empty `missing` array as a defect, not as noise.

## Rendering it

`sendConfirmation()` takes the template as a string on `ConfirmationContext.template`, so
the caller decides where it comes from — file, bundle, or a database row per property.
Read it once at startup, not per send:

```ts
import { readFileSync } from 'node:fs'
import { sendConfirmation } from './src/email/confirmation.ts'
import { transportFromEnv } from './src/email/render.ts'

const template = readFileSync(new URL('./emails/tour-confirmation.html', import.meta.url), 'utf8')

const outcome = await sendConfirmation(
  booking,
  {
    buildingName: 'The Larkin',
    address: '5-08 46th Avenue, Long Island City, NY 11101',
    leasingPhone: '+1 (516) 990-9252',
    leasingEmail: 'leasing@thelarkinlic.com',
    managementCompany: 'Halbrook Residential Management',
    template,
  },
  transportFromEnv(),
  { floorPlanName: 'Two Bedroom', bedrooms: 2, sqft: 1012, monthlyRent: 7190, concession: unit.concession ?? null },
)

if (outcome.missing.length) console.warn('unfilled placeholders:', outcome.missing)
```

`transportFromEnv()` returns `ResendTransport` when `RESEND_API_KEY` is set and
`NoopTransport` otherwise. The Noop path renders the email, keeps it in an outbox, and
reports `sent: false` with a reason — it never claims to have sent anything.

`sendConfirmation()` refuses outright unless `booking.state.status === 'confirmed'`. A
confirmation email is a written claim that a slot is held; it does not go out for a
booking that only got as far as "arranging".

### A local preview

```bash
node --input-type=module -e "
import {readFileSync,writeFileSync} from 'node:fs'
const t = readFileSync('emails/tour-confirmation.html','utf8')
const v = {prospectName:'Dana Okonkwo', buildingName:'The Larkin',
  address:'5-08 46th Avenue, Long Island City, NY 11101',
  leasingPhone:'+1 (516) 990-9252', leasingEmail:'leasing@thelarkinlic.com',
  managementCompany:'Halbrook Residential Management',
  tourDate:'Saturday, September 12', tourTime:'2:00 PM', unitId:'26B',
  floorPlanName:'Two Bedroom', bedrooms:2, sqft:1012, monthlyRent:'\$7,190',
  concessionLine:'Net effective. One month free on a 14-month lease.',
  concessionSentence:'The rent we quote you for this residence is net effective and reflects one month free on a 14-month lease. Ask for the gross figure and we will give you both, on the spot.',
  concessionDisclaimer:'The advertised rent for this residence is net effective and reflects one month free on a 14-month lease. Gross rent is higher; ask the leasing office for both figures. Concessions vary by residence.',
  confirmationCode:'LK-2026-0912-26B', rescheduleUrl:'tel:+15169909252'}
writeFileSync('/tmp/preview.html', t.replace(/\{\{\s*(\w+)\s*\}\}/g,(_,k)=>String(v[k]??'')))
" && open /tmp/preview.html
```

A browser preview tells you the copy reads right. It tells you nothing about Outlook. For
that, send a real one to a seed address or push it through Litmus or Email on Acid.

## The subject line

Built in `confirmation.ts`, not in this file:

```
Your tour at The Larkin — Saturday, September 12 at 2:00 PM
```

Preview text is a hidden `<div>` at the top of the body:

```
Saturday, September 12 at 2:00 PM · Residence 26B · 5-08 46th Avenue, ground floor,
entrance on 5th Street. Confirmation LK-2026-0912-26B.
```

## Voice

This is the building writing to someone it just spoke to on the phone, not a SaaS product
issuing a receipt. Second person, present tense, short declarative sentences. Homes are
**residences**, never units. Amenity spaces are proper nouns with a floor number attached
— The Works on three, The Terrace on four, The Overlook on thirty-four. Claims are
quantified: 45 minutes, 62-foot pool, two blocks east, nine minutes to Grand Central, $20
per adult.

No exclamation points. No rhetorical questions. Banned: *luxury, world-class, bespoke,
curated, elevated, resort-style, oasis, sanctuary, unparalleled, iconic, nestled.*

Two things in the copy are load-bearing and should survive any edit:

1. **The concession disclosure is volunteered, three times** — under the rent in the
   detail card, in "What to expect", and again in the footer. The leasing team's
   discipline on the phone is to disclose net effective before being asked; the email
   holds the same line, and it holds it per residence rather than assuming the house
   default.
2. **Rescheduling is offered without friction.** "Move it or cancel it any time, and you
   do not owe us a reason." A confirmation email that makes cancelling hard is how a
   building earns a no-show instead of a reschedule.

## Compliance furniture

Present in the footer of every send, and none of it is decoration:

- Management company attribution and the owning entity in the copyright line
  (`5-08 46th Avenue Owner LLC`).
- The full HUD equal-housing pledge with the seven protected classes named, plus the
  Equal Housing Opportunity mark.
- The concession disclosure for the residence being toured, tied to its own lease term
  (or the plain statement that it carries none), and the NYC listing disclaimer.
- An accessibility statement with a real phone number and email for accommodation
  requests — WCAG 2.1 Level AA, matching `legal.accessibility` in `data/property.json`.
- An unsubscribe line that is honest about what it does: it stops marketing email and
  says so, while making clear that messages tied to a booked appointment still come
  through. That distinction is what keeps the template CAN-SPAM-clean without lying.

### If you add a list provider

The unsubscribe link is currently a `mailto:` to the leasing office with the confirmation
code in the subject, which is what a single building with an on-site team actually does.
If you move to a provider with managed suppression lists, add `{{unsubscribeUrl}}` to the
template, supply it in `confirmation.ts`, and add a `List-Unsubscribe` header on the
transport. Adding the placeholder without supplying the value renders an empty `href` —
`render()` will flag it in `missing`, so the tests will tell you.

## Adding another template

Copy `tour-confirmation.html` and keep the skeleton: the MSO conditionals, the 600px
wrapper, the `<style>` block, the class names (`px`, `wrap`, `t-ink`, `t-muted`,
`t-accent`, `rule`, `card`, `bg-paper`, `dt-l`, `dt-v`). Then:

1. Use only placeholders the calling code actually supplies. Assert it in a test with
   `placeholdersIn()` so a rename cannot ship silently.
2. Keep the rendered size under about 100 KB.
3. Re-inline anything you add to the `<style>` block. If a rule only exists there, it does
   not exist in Outlook.

## Palette and type

| Token | Value | Used for |
|---|---|---|
| Ink | `#171A1C` | Masthead ground, headlines, body copy |
| Paper | `#F4F1EA` | Page ground, type on the ink masthead |
| Accent | `#7F5E33` | Rules, small-caps labels, links, the primary button — never a fill behind body copy |
| Muted | `#6E6B64` | Secondary and caption text only |

Three neutrals are derived from paper for structure, not brand color: `#FBF9F3` (detail
card), `#EDE9E0` (footer ground), `#E2DCCE` / `#DCD5C6` (hairlines).

Dark mode inverts to a `#12140F` ground with paper as the type color and the bronze
lightened to `#C79A5E`, per `paletteNotes` in `data/property.json`. The same lightened
bronze is used on the ink masthead in light mode, where `#7F5E33` would not have the
contrast.

Contrast on paper: ink 15.7:1, accent 5.1:1, muted 4.7:1. All clear AA for body text.

Display type is Cormorant Garamond 300/400 (wordmark, headline, the tagline rule),
falling back to Georgia. Body is Jost 300/400/500 falling back to Helvetica Neue and
Arial. Outlook is force-fed Arial with Georgia on `.display` through an MSO-only
`<style>` block, because the Word engine handles webfonts unpredictably and a controlled
fallback beats a surprise.
