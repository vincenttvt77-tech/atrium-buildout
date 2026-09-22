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

This is a single-property public-demo experience. It is not a cross-property
shortlist service and it is not connected to Vapi delivery. Before linking from
staff or voice workflows, configure and verify each property's public website
binding and authoritative inventory feed. Use the existing tenant authority and
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
