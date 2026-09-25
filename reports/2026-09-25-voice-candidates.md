# Voice candidates — September 25, 2026

AT-158, Codex root. Source base `dc687259685e50786f36d11814a83c57da7ac3c5`,
branch `codex/at158-voice-candidates`. Documentation and account catalog research;
no application implementation or completed audio audition is claimed.

## Result

Vapi's signed-in **Voice library → ElevenLabs → Add** search exposes more voices
than its 21-voice default list. Three concrete candidates now have exact IDs:

| Candidate | Exact provider ID | Vapi catalog labels | Verification |
| --- | --- | --- | --- |
| Zoe — Charismatic, Gritty and Engaging | `M6ic45wruJGWAxLFEMNK` | Middle Aged / Female / African American | Exact search result and selection detail inspected. Not imported. |
| Leoni Vergara — Soothing and Eloquent | `pBZVCk298iJlHAcHQwLr` | Middle Aged / Female / Spanish | Exact public selector ID matches Vapi. One import attempted; saved presence unconfirmed. |
| Vega — Warm English Female | `pTX8uGyVgHCWLj6IkcbC` | Middle Aged / Female / Spanish | Exact public selector ID matches Vapi. Not imported. |

The public source for Leoni/Vega is ElevenLabs' [Latino-accent collection](https://elevenlabs.io/text-to-speech/latino-accent).
ElevenLabs' [migration table](https://elevenlabs.io/docs/help-center/product/voices/voice-library/how-are-voices-updated-changed)
separately lists a female Zoe with African American accent. The exact Zoe ID above
comes from the current Vapi search, not an assumption about an older Aria ID.
Advertised accent metadata does not establish the actor's personal ethnicity.

## Import and listening limits

The Leoni **Add voice to library** action was submitted exactly once. Its dialog
closed, but subsequent name search returned no voices and one reload showed the
default list without Leoni or its ID. No explicit error established the cause.
Do not claim it saved, repeat it blindly, or configure the live assistant based on
that button click. Zoe and Vega received no import submission.

Leoni's existing public preview controls were exercised, but browser evidence did
not establish playback. No custom text was submitted, no speech was generated,
and no voice was heard/scored. The [identical audition script](../docs/voice-audition-kit.md)
and listening scorecard remain pending. English pronunciation, numbers/dates,
interruptions, commercial access and phone quality are unverified.

The ElevenLabs own-account integration form in Vapi had an empty API-key input;
only a presence boolean was inspected, and no secret was copied or entered.
Direct ElevenLabs library access redirected to sign-in. Neither observation alone
proves why the Vapi import was unconfirmed. [Vapi documents both its default
integration and connecting an owned account](https://docs.vapi.ai/providers/voice/elevenlabs),
so a separate ElevenLabs subscription is not yet an established requirement.
Confirm access and commercial terms for whichever route is selected. Direct
ElevenLabs free/paid terms alone do not settle Vapi's default-route eligibility.

## Preserved state and actual checks

- Published Atrium v2 remained v23 when inspected; its existing separate draft
  was not edited. No assistant, voice/model setting or phone route was changed.
- Vapi displayed $1.14 credit. No paid call, simulation, speech generation, GPU
  rental, purchase or deployment was run.
- Official Vapi voice and Vast endpoint documentation were rechecked. Model
  hosting and speech synthesis remain separate trials; no latency improvement
  has been measured. See the [hosting comparison](../docs/voice-provider-evaluation.md).
- Exact catalog matches and the unsuccessful saved-presence verification are
  the provider evidence. No application tests were needed for these documentation
  changes. Four documents / 14 local links passed path verification; the diff
  check passed. These are documentation checks, not voice acceptance.
- Previously accepted application source remains `ecbe8d3`: cloud run
  [36141221040](https://github.com/vincenttvt77-tech/atrium-buildout/actions/runs/36141221040)
  was terminal success with 1,831 application / 736 native database tests,
  26-handler build and 17 browser groups. Those results do not test these voices;
  do not poll completed jobs again.

## Owner and next-agent handoff

Owner: choose the preferred sound after listening, decide whether Spanish support
is required, and provide a bounded funded audition/phone trial when ready. Finish
the separately prepared private Preview setup; do not paste credentials into chat.
Representative permissioned calls and approved property rules remain pilot inputs.

Codex/Fable: first resolve the single uncertain Leoni import through saved provider
state or an explicit provider error, without an automatic resend. Verify the
candidate's access/rights, then generate the same short script under the agreed
budget. Establish a successful current phone-to-tool-to-dashboard baseline before
comparing voice-only, Vast-hosting-only and combined configurations. Keep the live
assistant intact until the candidate passes; document an exact rollback.

Preserve unrelated canonical calendar work. Respect the separate AT-129 release
gate and isolated Preview setup. Full leasing/SaaS goal remains active. Finish the
next session with a reciprocal handoff containing accessible commits, actual
checks, limits, owner to-dos and next-agent to-dos.
