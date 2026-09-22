# Voice hosting and audition decision

September 22, 2026. Owner direction: consider Vast.ai to reduce latency and change to a Black American or Latina female voice. Status: documented research and evaluation scope, not a selected model, measured improvement or live change. This supplements the [leasing goal](leasing-goal.md); ownership stays in the shared task board.

## Compatibility and recommendation

Vapi accepts an OpenAI-compatible model endpoint and recommends streaming. Vast documents a vLLM serverless template with compatible endpoints. This makes a model-hosting trial plausible while retaining Vapi call handling and Atrium tools; it does not prove the chosen model can reliably produce streamed tool calls. Validate that protocol before any phone experiment. Sources: [Vapi custom LLM](https://docs.vapi.ai/customization/custom-llm/fine-tuned-openai-models), [Vapi tool calling](https://docs.vapi.ai/customization/tool-calling-integration), [Vast endpoint setup](https://docs.vast.ai/guides/serverless/setting-up-endpoints).

Model hosting and voice synthesis are separate decisions. A Vast-hosted speech model would additionally need the speech provider contract, streaming audio and interruption behavior validated. We have not selected or tested such a model. Keep the first comparison limited to one component at a time.

Vast exposes active-capacity and queue controls. Its documented setup defaults include a 10-second target queue and 30-second maximum queue, which should not be accepted unchanged as conversational latency budgets. Provisioning/loading can take minutes. Evaluate ready capacity, region, load and replacement-worker behavior; measure idle-capacity cost as well as request cost. These are engineering implications of the [Vast setup](https://docs.vast.ai/guides/serverless/setting-up-endpoints) and [scaling parameters](https://docs.vast.ai/guides/serverless/serverless-parameters), not measured Atrium performance.

## Audition leads

September 22 account inspection: Vapi's ElevenLabs list displayed 21 default voices; searching for Zoe returned no results and Leoni was not in the displayed list. Neither candidate is therefore account-verified yet. This does not establish that the provider cannot supply them. The Vapi v2 library also offered female voices, but the displayed metadata did not verify the requested Black American/Latina presentation. No voice was inferred from a name, auditioned, added or selected.

| Candidate | Verified public description | Still to verify |
| --- | --- | --- |
| Zoe, ElevenLabs | Official migration table lists the female replacement for Aria with African American accent. | Current exact voice ID, account availability, commercial rights, phone quality and owner preference. |
| Leoni Vergara, ElevenLabs | Official Latino collection lists a conversational voice; library description emphasizes a soothing, friendly delivery. | Current exact voice ID, licensing, female voice presentation and preferred English accent through a listening audition. |

Sources: [ElevenLabs voice migration](https://elevenlabs.io/docs/help-center/product/voices/voice-library/how-are-voices-updated-changed), [Latino collection](https://elevenlabs.io/text-to-speech/latino-accent). These are audition leads, not claims about the voice actors’ personal ethnicity. No samples were listened to, generated or selected in this research. Do not derive API IDs from display names or reuse a deprecated ID by assumption.

Use the same synthetic script for each candidate: AI/recording disclosure, “Residence nineteen A,” a price and date from a marked test fixture, a brief availability answer, clarification after a correction, and a calm recovery when booking cannot be confirmed. Judge intelligibility, warmth, pace, pronunciation and interruption recovery over phone audio. A Latina voice preference does not itself add Spanish support; that needs separate transcription, model and end-to-end language acceptance.

## Published configuration observed September 22

Vapi Version History marked **v23** as current for Atrium v2, created September 12 at 22:44:23.497 UTC. Its exported settings contain:

| Component | Published value |
| --- | --- |
| Model | Anthropic `claude-sonnet-5`, temperature 0.4 |
| Voice | Vapi `Nico`, version `2`; no explicit speed in the export |
| Transcriber | Soniox `stt-rt-v5`, English |
| Start-speaking wait | 0.4 seconds |
| Transcription endpointing | Punctuation 0.3 seconds; no punctuation 1.2 seconds; numbers 1 second |
| Interruption settings | `numWords: 0`, `voiceSeconds: 0.2`, `backoffSeconds: 0.8` |
| Greeting | Assistant speaks first; first-message interruptions disabled |
| Tools | Seven inline function tools; no referenced tool IDs |

These are observed saved settings, not a recommendation or a complete restorable configuration. Additional endpointing rules and fallback settings exist; preserve the private export for exact comparison. The inspected number routes inbound calls to Atrium v2 and shows the existing Atrium backend URL. That routing observation does not prove a successful call or webhook authentication.

A separate pre-existing unsaved draft remains untouched. Its component cards estimated about 2,840 ms total, which is not Atrium's measured response time; Vapi describes those cards as component medians excluding endpointing and transport. In the visible 14-day history, the latest call was the September 10 v22 call with the previously reported unauthorized tools; no v23 call appeared in that view. Its historical six-turn average of 3,646 ms is not a current successful baseline. Account credit displayed $1.14; no paid test was run. See [evidence and limits](../reports/2026-09-22-voice-baseline.md) and [Vapi's latency methodology](https://docs.vapi.ai/assistants/model-intelligence/understanding-latency).

The [offline fingerprint comparison](voice-evaluation.md#freeze-and-compare-the-saved-configuration) now identifies unintended prompt/tool/settings changes while evaluating a voice or model candidate, without printing the private export. No measured performance improvement or live switch is claimed.

## Controlled comparison

1. Recheck the published configuration against the captured v23 baseline before starting. Keep restorable exports protected outside Git and share only reviewed comparison evidence. Establish fresh successful phone-to-tool-to-dashboard measurements; the historical failed call is insufficient. Do not treat historical chat descriptions or configuration fingerprints as current performance evidence.
2. Test streaming, tool names/arguments, tool-result continuation, cancellation, errors and timeouts against synthetic property data. Authentication and tenant checks stay in Atrium. A model may not declare a booking complete without backend evidence.
3. Compare baseline, new voice only, Vast model only, and both together on identical scripted cases. Use warm, first-after-idle, interrupted, long-context and concurrent calls. Include unavailable inventory, unit blocks, capacity limits and uncertain booking recovery.
4. Measure caller speech end to first meaningful audio, plus component timings and cost per successful task. Report P50/P95, failures and sample counts using the [existing offline evaluator](voice-evaluation.md). Do not substitute filler speech or tokens per second for caller-perceived response time. Include idle GPU, telephony and speech costs in the comparison.
5. Set numerical latency/cost acceptance budgets from baseline before tuning candidates. Retain the goal’s held-out routine-leasing success target and all critical isolation, duplicate-action and false-confirmation gates. Switch only after a meaningful latency improvement with acceptable quality, full channel checks and a documented rollback. A tiny perfect scripted sample is not pilot validation.

## Next actions and handoff

Owner: choose the preferred voice after listening; provide a bounded hosting/test budget and secure account access if proceeding with paid trials. Permissioned representative call examples remain needed for the held-out evaluation.

Codex/Fable: the published configuration and inbound routing have now been inspected; next resolve exact candidate IDs/account access and commercial rights, then audition and establish a fresh measured baseline with a bounded test budget. Select a compatible model and size the Vast trial only after that. Preserve the current assistant and pre-existing draft during evaluation and record exact changed settings, evidence and rollback before a release. AT-133 email delivery is accepted and published as d8a3d47; the subsequent [staff tour confirmation report](../reports/2026-09-22-tour-confirmations.md) describes its actual integration and remaining activation work. AT-129 production promotion remains pending explicit approval; this research is not a workaround.

Checks and observed baseline evidence are recorded in the [September 22 report](../reports/2026-09-22-voice-baseline.md). No GPU rental, paid call, generated audio, provider configuration or production mutation. Next agent must end with a reciprocal handoff and separate owner/agent to-dos.
