# Public residence shortlists

The Larkin demonstration website lets a prospect select up to five published
residences, view them together, and copy a link to reopen or share the selection.
No message, tour reservation, account record, or notification is created.

## Use

1. Open Availability and select **Save residence** on relevant units.
2. Choose **View shortlist** to compare only those residences. Bedroom filters and
   sorting work within the selection. **Browse all residences** resets the filters.
3. Copy the link, or select and copy the visible text if clipboard access is denied.
4. Open that link to review the same IDs against the site's published inventory.
   Use the removal buttons to revise the selection and copy the updated link.
   **Clear selection** also removes the original shortlist from the current URL.

Selections are page state, not an account wishlist. Use the link to reopen them.
Links are public and can be forwarded. They contain only public unit IDs in a URL
fragment, with no contact details, budget, staff information or credentials. The
creator's URL query and path are not copied. Links must use the public website's
origin; staff dashboard URLs must not be passed through as public property URLs.

## Availability and failures

The site uses its bundled, published demo inventory. It is not a live PMS lookup.
Its source date and fictional-demo disclosures remain visible. An available date
is not an open tour slot or a reservation. Pending units remain labeled under
application; leased, off-board or unknown units are omitted with a missing-unit
notice. No missing or malformed link silently expands to unrelated residences.
An invalid link offers a way back to the full published board. A sixth selection
is refused without dropping existing choices.

The format is `/#availability?units=19A%2C21B`. The reader accepts a bounded list
of up to five public IDs, resolves against the local published board, deduplicates
and canonicalizes letter case. Generated links never include arbitrary input or
unknown units. Receiving a link does not prove that all units still match the
prospect's budget, timing or other preferences.

## Integration boundary and remaining work

The bundled page remains a single-property public-demo experience. PostgreSQL
voice availability tools can prepare a property-bound link after an explicit
website binding is published (below). No deployed property has been enabled by
this code change. This is not connected to Vapi delivery or a staff sending UI.
Before enabling a binding, verify the property website and its inventory feed. Use the existing tenant authority and
notification workflow, record permission to send, and distinguish pending/sent/
failed delivery. Do not hard-code the Larkin public origin for other tenants.

## Verification

- `node --test test/portal/public-shortlist.test.mjs` tests bounded link handling,
  malformed links, missing/private selections and public-only output.
- `test/browser/public-shortlist.mjs` exercises actual public JS/HTML/CSS in
  Chromium at 320, 390 and 1280 pixels, including selection limits, clipboard
  refusal, keyboard focus, scroll stability, URL navigation and missing/pending
  units. All requests are intercepted locally; outside traffic is blocked.
  Configure `ATRIUM_PLAYWRIGHT_MODULE`, `ATRIUM_CHROME_EXECUTABLE` and optionally
  `ATRIUM_BROWSER_ARTIFACTS` for the existing browser harness.
- Repository application, isolated database and build gates remain required for
  integration. Local acceptance is not production or phone delivery evidence.


## Property-bound voice preparation

An authorized configuration publisher can include `publicShortlistWebsite` in
`bundle.property`. It has exactly these fields (illustrative values only):

```json
{
  "format": "atrium-shortlist-v1",
  "organizationId": "organization-example",
  "propertyId": "property-example",
  "inventorySource": "approved-property-feed",
  "baseUrl": "https://building.example/leasing/",
  "reviewedAt": "2026-09-22T12:00:00Z",
  "reviewExpiresAt": "2026-10-01T12:00:00Z"
}
```

This records the publisher's review, not automated domain ownership or content
verification. The reviewer must actually open the destination with an example
shortlist, confirm the correct building, inventory identifiers, public-only
content and supported URL format. Another site's homepage is not automatically
compatible. Publication remains subject to the existing property authority.

Organization, property and source must match the exact published configuration.
The URL must be canonical HTTPS, without credentials, query, fragment, custom port,
IP literals or local hostnames. Paths use ordinary letters, digits, slashes, dots,
hyphens and underscores. The review cannot postdate publication, and the review
interval is at most 30 days. Malformed supplied configuration fails validation;
omitting the field leaves the feature disabled. Expiry suppresses links without
preventing ordinary leasing answers. Removal/replacement takes effect through
normal configuration publication. The system never refreshes review dates itself.

Only PostgreSQL voice requests receive the binding from the authorized snapshot.
Legacy mode does not infer a website from the bundled Larkin data or incoming host.
Model arguments cannot choose a website, organization or property. Existing live
inventory freshness and fictional-demo disclosure gates remain in force. Named
lookups, plan results and broad searches can prepare only their actual presented
available units, capped at five. Broad results include explicitly described
price/date/size alternatives; the link is not proof that every option meets the
original criteria. Pending/leased/unknown units do not become voice offers.

`availability_checked.publicShortlist` records `status: prepared`,
`delivery: not_sent`, URL, public IDs, preparation time and review expiration.
The response explicitly prohibits claiming delivery, offering to text/email from
this tool, or reading the URL aloud. It may offer staff follow-up if requested.
This is a historical prepared link, not a durable delivery request, live website
verification, saved consent, or proof of staff action. Never dispatch from this
record later without rechecking current property binding and permission/consent.

The next delivery slice must use a supported native/provider messaging capability,
record exact consent and destination, persist an idempotent intent, and reconcile
provider acceptance/delivery before showing sent/delivered. A tool invocation or
prepared link must not be reported as a successful message. No SMS tool, provider
account, sender number or credentials were created by this implementation.
