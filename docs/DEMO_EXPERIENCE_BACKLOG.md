# Atrium presentation and visual experience

Owner direction, September 9, 2026: make the website, operations dashboard and
Larkin demonstration visually impressive as well as useful. The audience includes
large commercial real-estate owners and property managers with varied technical
experience. Use readable language and screens, confident visual design, interactive
elements and a healthy amount of motion. Presentation quality is a product requirement,
not a substitute for completing the full SOW.

This is a prioritized implementation backlog. Items are not shipped unless their
acceptance evidence is recorded. The Units workspace and all six operations views are implemented locally and browser-reviewed; publication remains separate.

## Research translated into design decisions

- Attractive interfaces can influence perceived usability and product quality;
  that does not establish that a workflow succeeds. Evaluate both first impressions
  and actual task completion. [Nielsen Norman Group](https://www.nngroup.com/articles/aesthetic-usability-effect/).
- Size, contrast, spacing and grouping can direct attention. Put the business outcome
  and next action ahead of secondary detail. [Visual-design principles](https://www.nngroup.com/articles/principles-visual-design/).
- Motion should explain transitions and provide precise feedback, with interaction
  remaining available. [Apple’s motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion).
- Honor reduced-motion preferences, and provide appropriate controls for continuing
  automatic motion. [W3C reduced-motion technique](https://www.w3.org/WAI/WCAG21/Techniques/css/C39.html),
  [pause, stop and hide guidance](https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html).

The proposals below are Atrium-specific design judgments, not measured claims that
a particular effect will increase sales. Validate them with the target audience.

## The demonstration story

1. Show an attractive property experience and select an apartment or floor plan.
2. Make an authorized demonstration call. Show the actual received call and its
   progression when the provider supplies that evidence.
3. Reveal the prospect’s needs, accurate building answer and booking result.
4. Open that unit’s workspace: upcoming tours, viewing restrictions, prospect context
   and feedback appear together.
5. Demonstrate a real manager action, such as a unit blackout or manual reschedule,
   then show its saved result and next step.

Use a controlled fictional demo property with clearly identified sample data.
Live, recorded replay, pending and failed steps must be distinguishable. Preserve
the story when a call or provider fails by offering a labeled recorded demonstration;
never animate a success that did not occur.

## Prioritized work

| Priority | Work | Audience payoff | Acceptance / dependency | Owner |
| --- | --- | --- | --- | --- |
| P0 — locally verified | Units workspace with an interactive catalogue, tour preparation, feedback and viewing holds | “I can understand this apartment and prepare my team in one place.” | AT-041; real scoped records, source/date labels, useful calendar/prospect links, desktop and phone verification | Dashboard designer + Codex integration |
| P0 — dashboard complete, sites pending | Shared visual direction across Atrium marketing, dashboard and the property experience | Consistent, deliberate presentation builds confidence at first sight | Typography/spacing/color/motion tokens; navy/white operations palette; property branding can vary intentionally; inspect desktop, phone and presentation widths | Designer |
| P0 | Presentation view with larger key information and progressive detail | A room can follow the demonstration without reading dense tables | Explicit presenter control; readable at 1280/1440 widths and screen sharing; normal navigation and full data remain reachable; no automatic private-data exposure | Designer + Codex |
| P1 | A live call-to-outcome visual sequence | Make the work Atrium performs visible as it happens | Provider-backed call states, received timestamps, verified booking receipt, pending/error states, no simulated waveform presented as live audio | Codex voice/runtime + designer |
| P1 | Larkin interactive floor-plan explorer | A prospect or owner can explore rather than just read | Reuse the ten existing SVG floor-plan assets after provenance/accuracy review; selection, zoom and unit details; keyboard/touch support; clear illustration labels where applicable | Designer + property content owner |
| P1 | Cinematic property landing-page composition and short transitions | An immediate premium property impression | Review existing imagery rights/facts, load behavior and mobile cropping; preserve booking/contact access; no forced scroll or waiting for animation | Designer |
| P1 | Deliberate motion language for selection, record arrival and confirmed changes | The product feels responsive and technologically sophisticated | Short transition on a meaningful change; never replay on ordinary polling; respect reduced motion; no attention-stealing perpetual animation; benchmark on a midrange phone | Designer + Codex |
| P1 | Calling from prospect/tour context | Fewer steps for leasing staff to follow up | Distinguish device dialer from embedded provider; Aircall requires a real account/integration and verified call-event ownership before claiming in-app calling | Codex integrations + owner |
| P2 | Interactive 3D building/unit or 360-degree experience | A memorable visual centerpiece tied to a real property decision | Suitable licensed/approved model or panorama; accurate property representation or explicit conceptual-demo label; lazy loading, static fallback, touch/keyboard controls and performance evidence | Designer + asset owner |
| P2 | Owner portfolio presentation | Show scale across buildings without overwhelming the audience | Real organization/property permission boundaries and meaningful aggregate data; no invented occupancy, revenue or conversion figures | Codex intelligence + designer |

## Current asset/code evidence

- The public property site already has a photographic hero, scroll reveals, sticky
  navigation and a floor-plan selector. Inspect `public/index.html`, `public/styles.css`
  and `public/app.js` before replacing or duplicating those behaviors.
- `public/floorplans/` contains ten SVG files. Their presence proves available 2D
  assets, not accurate 3D geometry or a licensed 360-degree capture.
- The operations dashboard already has reduced-motion styles, panel/sheet transitions,
  a new-row transition and loading feedback. Extend that system consistently.
- AT-041 uses existing unit, booking, blackout, feedback and prospect data; AT-043–045 extend the same design to Today, Status, Calls, Leads and Calendar. No
  new Aircall account, phone connection or 3D model has been established by this work.

## Evaluation and next actions

**Codex/designer:** retain the verified unit/all-page dashboard design; prototype the presentation view
and one property explorer. Rehearse the complete story with the same code and provider
configuration that will be demonstrated. Measure comprehension, task completion,
visual impression and perceived credibility separately.

**Owner/team:** supply or approve property imagery/models and facts; nominate a few
representative owners/managers for a short demo review; choose whether a connected
staff-calling provider is desired and provide the authorized account when selected.
These inputs do not block improvements based on existing records and assets.

Carry this backlog and its actual implementation status into EOD reports and both
directions of the Codex/Fable handoff. Do not count a researched or designed item as
implemented, tested or deployed.
