# Voice hosting and audition decision

September 22, 2026. Owner direction: consider Vast.ai to reduce latency and change to a Black American or Latina female voice. Status: documented research and evaluation scope, not a selected model, measured improvement or live change. This supplements the [leasing goal](leasing-goal.md); ownership stays in the shared task board.

## Compatibility and recommendation

Vapi accepts an OpenAI-compatible model endpoint and recommends streaming. Vast documents a vLLM serverless template with compatible endpoints. This makes a model-hosting trial plausible while retaining Vapi call handling and Atrium tools; it does not prove the chosen model can reliably produce streamed tool calls. Validate that protocol before any phone experiment. Sources: [Vapi custom LLM](https://docs.vapi.ai/customization/custom-llm/fine-tuned-openai-models), [Vapi tool calling](https://docs.vapi.ai/customization/tool-calling-integration), [Vast endpoint setup](https://docs.vast.ai/guides/serverless/setting-up-endpoints).

Model hosting and voice synthesis are separate decisions. A Vast-hosted speech model would additionally need the speech provider contract, streaming audio and interruption behavior validated. We have not selected or tested such a model. Keep the first comparison limited to one component at a time.

Vast exposes active-capacity and queue controls. Its documented setup defaults include a 10-second target queue and 30-second maximum queue, which should not be accepted unchanged as conversational latency budgets. Provisioning/loading can take minutes. Evaluate ready capacity, region, load and replacement-worker behavior; measure idle-capacity cost as well as request cost. These are engineering implications of the [Vast setup](https://docs.vast.ai/guides/serverless/setting-up-endpoints) and [scaling parameters](https://docs.vast.ai/guides/serverless/serverless-parameters), not measured Atrium performance.

## Audition leads

| Candidate | Verified public description | Still to verify |
| --- | --- | --- |
| Zoe, ElevenLabs | Official migration table lists the female replacement for Aria with African American accent. | Current exact voice ID, account availability, commercial rights, phone quality and owner preference. |
| Leoni Vergara, ElevenLabs | Official Latino collection lists a conversational voice; library description emphasizes a soothing, friendly delivery. | Current exact voice ID, licensing, female voice presentation and preferred English accent through a listening audition. |

Sources: [ElevenLabs voice migration](https://elevenlabs.io/docs/help-center/product/voices/voice-library/how-are-voices-updated-changed), [Latino collection](https://elevenlabs.io/text-to-speech/latino-accent). These are audition leads, not claims about the voice actors’ personal ethnicity. No samples were listened to, generated or selected in this research. Do not derive API IDs from display names or reuse a deprecated ID by assumption.

Use the same synthetic script for each candidate: AI/recording disclosure, “Residence nineteen A,” a price and date from a marked test fixture, a brief availability answer, clarification after a correction, and a calm recovery when booking cannot be confirmed. Judge intelligibility, warmth, pace, pronunciation and interruption recovery over phone audio. A Latina voice preference does not itself add Spanish support; that needs separate transcription, model and end-to-end language acceptance.

## Controlled comparison

1. Capture a baseline of the actual saved model, speech provider, voice, transcriber, endpointing settings and tool contract. Save a configuration fingerprint and restorable settings without secrets. Do not treat historical chat descriptions as current configuration.
2. Test streaming, tool names/arguments, tool-result continuation, cancellation, errors and timeouts against synthetic property data. Authentication and tenant checks stay in Atrium. A model may not declare a booking complete without backend evidence.
3. Compare baseline, new voice only, Vast model only, and both together on identical scripted cases. Use warm, first-after-idle, interrupted, long-context and concurrent calls. Include unavailable inventory, unit blocks, capacity limits and uncertain booking recovery.
4. Measure caller speech end to first meaningful audio, plus component timings and cost per successful task. Report P50/P95, failures and sample counts using the [existing offline evaluator](voice-evaluation.md). Do not substitute filler speech or tokens per second for caller-perceived response time. Include idle GPU, telephony and speech costs in the comparison.
5. Set numerical latency/cost acceptance budgets from baseline before tuning candidates. Retain the goal’s held-out routine-leasing success target and all critical isolation, duplicate-action and false-confirmation gates. Switch only after a meaningful latency improvement with acceptable quality, full channel checks and a documented rollback. A tiny perfect scripted sample is not pilot validation.

## Next actions and handoff

Owner: choose the preferred voice after listening; provide a bounded hosting/test budget and secure account access if proceeding with paid trials. Permissioned representative call examples remain needed for the held-out evaluation.

Codex/Fable: verify current account-specific voices/configuration, audition the candidates, establish measured baseline, select a compatible model and size the bounded trial. Preserve the current assistant during evaluation and record exact changed settings, evidence and rollback before a release. AT-133 email delivery is now accepted and published as d8a3d47; the subsequent [staff tour confirmation report](../reports/2026-09-22-tour-confirmations.md) describes its actual integration and remaining activation work. AT-129 production promotion remains pending explicit approval; this research is not a workaround.

Checks for this increment: primary documentation and local relative links reviewed; documentation diff checked. No runtime changes, GPU rental, paid call, generated audio, provider configuration or production mutation. Next agent must end with a reciprocal handoff and separate owner/agent to-dos.
