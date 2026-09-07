// api/vapi.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// src/inventory/load.ts
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
var isStr = (v) => typeof v === "string" && v.length > 0;
function validFloorPlan(raw, i, problems) {
  const p = raw;
  const where = `floorPlans[${i}]${isStr(p?.id) ? ` (${p.id})` : ""}`;
  if (!isStr(p?.id)) {
    problems.push({ where, problem: "missing id" });
    return null;
  }
  if (!isNum(p.bedrooms) || !isNum(p.bathrooms) || !isNum(p.sqft)) {
    problems.push({ where, problem: "bedrooms, bathrooms and sqft must all be numbers" });
    return null;
  }
  return {
    id: p.id,
    name: isStr(p.name) ? p.name : p.id,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    sqft: p.sqft,
    description: isStr(p.description) ? p.description : "",
    features: Array.isArray(p.features) ? p.features.filter(isStr) : [],
    ...Array.isArray(p.exposures) ? { exposures: p.exposures.filter(isStr) } : {},
    ...isStr(p.svgPath) ? { svgPath: p.svgPath } : {}
  };
}
function validUnit(raw, i, plans, problems) {
  const u = raw;
  const where = `units[${i}]${isStr(u?.unitId) ? ` (${u.unitId})` : ""}`;
  if (!isStr(u?.unitId)) {
    problems.push({ where, problem: "missing unitId" });
    return null;
  }
  if (!isStr(u.floorPlanId) || !plans.has(u.floorPlanId)) {
    problems.push({ where, problem: `floorPlanId "${u.floorPlanId}" does not exist` });
    return null;
  }
  if (!isNum(u.monthlyRent) || u.monthlyRent <= 0) {
    problems.push({ where, problem: "monthlyRent must be a positive number" });
    return null;
  }
  if (!isStr(u.availableFrom) || Number.isNaN(Date.parse(u.availableFrom))) {
    problems.push({ where, problem: "availableFrom must be an ISO date" });
    return null;
  }
  const plan = plans.get(u.floorPlanId);
  const beds = isNum(u.bedrooms) ? u.bedrooms : plan.bedrooms;
  const baths = isNum(u.bathrooms) ? u.bathrooms : plan.bathrooms;
  const sqft = isNum(u.sqft) ? u.sqft : plan.sqft;
  if (beds !== plan.bedrooms) {
    problems.push({ where, problem: `bedrooms ${beds} disagrees with plan ${plan.id} (${plan.bedrooms})` });
  }
  const status = u.status === "pending" || u.status === "leased" || u.status === "off_market" ? u.status : "available";
  return {
    unitId: u.unitId,
    floorPlanId: u.floorPlanId,
    floor: isNum(u.floor) ? u.floor : 0,
    bedrooms: beds,
    bathrooms: baths,
    sqft,
    monthlyRent: u.monthlyRent,
    availableFrom: u.availableFrom,
    status,
    ...isStr(u.exposure) ? { exposure: u.exposure } : {},
    ...isStr(u.view) ? { view: u.view } : {},
    ...isStr(u.concession) ? { concession: u.concession } : {},
    ...Array.isArray(u.features) ? { features: u.features.filter(isStr) } : {}
  };
}
function loadInventory(rawUnits, rawPlans, readAt, source) {
  const problems = [];
  const floorPlans = rawPlans.map((p, i) => validFloorPlan(p, i, problems)).filter((p) => p !== null);
  const planMap = new Map(floorPlans.map((p) => [p.id, p]));
  const units = rawUnits.map((u, i) => validUnit(u, i, planMap, problems)).filter((u) => u !== null);
  return { snapshot: { units, floorPlans, readAt, source }, problems };
}

// src/leasing/captured.ts
function extracted(value, confidence, interactionId2, excerpt, at) {
  return { value, provenance: "ai_extracted", confidence, interactionId: interactionId2, excerpt, at };
}
function reconcile(existing, incoming) {
  if (!existing) return incoming;
  if (existing.provenance === "human_corrected" && incoming.provenance !== "human_corrected") {
    return existing;
  }
  if (incoming.provenance === "human_corrected") return incoming;
  return incoming.at.getTime() >= existing.at.getTime() ? incoming : existing;
}

// src/leasing/qualification.ts
var emptyQualification = () => ({
  amenityPriorities: [],
  desiredFeatures: [],
  objections: []
});
var CORE_SIGNALS = ["moveInTiming", "budget", "bedrooms"];
function mayQuote(state, minimumSignals = 2) {
  const captured = CORE_SIGNALS.filter((s) => state[s] !== void 0);
  if (captured.length >= minimumSignals) return { allowed: true, captured };
  return {
    allowed: false,
    captured,
    missing: CORE_SIGNALS.filter((s) => state[s] === void 0),
    needed: minimumSignals - captured.length
  };
}
function nextSignalToAsk(state) {
  const order = ["moveInTiming", "bedrooms", "budget"];
  return order.find((s) => state[s] === void 0) ?? null;
}
function captureCore(state, key, incoming) {
  return { ...state, [key]: reconcile(state[key], incoming) };
}

// src/inventory/match.ts
var DAY = 864e5;
function offerable(u, now, moveIn) {
  if (u.status !== "available") return false;
  const from = Date.parse(u.availableFrom);
  if (moveIn === null) return true;
  return from <= moveIn.getTime() + 21 * DAY;
}
function findMatches(snapshot, qual, opts) {
  const maxAge = opts.maxSnapshotAgeMs ?? 15 * 6e4;
  const age = opts.now.getTime() - snapshot.readAt.getTime();
  if (age > maxAge) return { kind: "stale", readAt: snapshot.readAt, ageMs: age };
  const moveIn = qual.moveInTiming?.value.earliest ?? null;
  const beds = qual.bedrooms?.value;
  const budgetMax = qual.budget?.value.maxMonthly ?? null;
  let pool = snapshot.units.filter((u) => offerable(u, opts.now, moveIn));
  if (pool.length === 0) return { kind: "no_match", reason: "no_availability" };
  if (beds) {
    const byBeds = pool.filter((u) => u.bedrooms >= beds.min && u.bedrooms <= beds.max);
    if (byBeds.length === 0) return { kind: "no_match", reason: "bedroom_mismatch" };
    pool = byBeds;
  }
  const score = (u) => {
    const reasons = [];
    let s = 0;
    if (budgetMax !== null) {
      const headroom = budgetMax - u.monthlyRent;
      if (headroom >= 0) {
        s += 40;
        if (headroom < 200) reasons.push("right at the top of their range");
      }
    }
    if (beds) {
      s += 25;
      reasons.push(`${u.bedrooms} bedroom`);
    }
    if (u.concession) {
      s += 15;
      reasons.push(u.concession);
    }
    if (u.view) {
      s += 5;
      reasons.push(u.view);
    }
    if (u.floor >= 20) {
      s += 5;
      reasons.push(`high floor \u2014 ${u.floor}`);
    }
    if (moveIn) {
      const diff = Math.abs(Date.parse(u.availableFrom) - moveIn.getTime());
      if (diff < 14 * DAY) {
        s += 15;
        reasons.push("available right when they need it");
      }
    }
    return { unit: u, score: s, reasons };
  };
  const limit = opts.limit ?? 3;
  if (budgetMax === null) {
    const all = pool.map(score).sort((a, b) => b.score - a.score);
    return { kind: "matches", units: all.slice(0, limit), stretch: [] };
  }
  const stretchTo = budgetMax * (1 + (opts.stretchFraction ?? 0.08));
  const within = pool.filter((u) => u.monthlyRent <= budgetMax).map(score);
  const stretch = pool.filter((u) => u.monthlyRent > budgetMax && u.monthlyRent <= stretchTo).map(score);
  if (within.length === 0 && stretch.length === 0) {
    const cheapest = Math.min(...pool.map((u) => u.monthlyRent));
    const nearest = pool.slice().sort((a, b) => a.monthlyRent - b.monthlyRent).slice(0, limit).map(score);
    return {
      kind: "priced_out",
      budgetMax,
      cheapestAvailable: cheapest,
      gap: cheapest - budgetMax,
      nearest
    };
  }
  return {
    kind: "matches",
    units: within.sort((a, b) => b.score - a.score).slice(0, limit),
    stretch: stretch.sort((a, b) => a.unit.monthlyRent - b.unit.monthlyRent).slice(0, 2)
  };
}

// src/knowledge/topics.ts
var VOLATILE = /* @__PURE__ */ new Set([
  "unit_availability",
  "pricing",
  "tour_slot_availability",
  "application_status",
  "account_status",
  "work_order_status"
]);
var RESTRICTED = /* @__PURE__ */ new Set([
  "fair_housing",
  "reasonable_accommodation",
  "eligibility_or_denial",
  "legal_question",
  "dispute",
  "money_movement",
  "protected_class_inquiry"
]);
var isVolatile = (t) => VOLATILE.has(t);
var isRestricted = (t) => RESTRICTED.has(t);
var liveSourceFor = (t) => ({
  unit_availability: "inventory",
  pricing: "inventory",
  tour_slot_availability: "tour_calendar",
  application_status: "application_system",
  account_status: "account_system",
  work_order_status: "work_order_system"
})[t];

// src/knowledge/article.ts
function isServable(article, property, jurisdiction, now) {
  if (article.status !== "published") return false;
  if (article.approvedBy === null) return false;
  if (article.reviewBy.getTime() <= now.getTime()) return false;
  if (article.propertyScope.length > 0 && !article.propertyScope.includes(property)) return false;
  if (article.jurisdictionScope.length > 0 && !article.jurisdictionScope.includes(jurisdiction)) return false;
  return true;
}

// src/knowledge/answer.ts
function decideAnswer(req) {
  if (isRestricted(req.topic)) {
    return { kind: "escalate", trigger: req.topic };
  }
  if (isVolatile(req.topic)) {
    return { kind: "defer_to_live_source", source: liveSourceFor(req.topic), topic: req.topic };
  }
  const servable = req.candidates.filter(
    (a) => isServable(a, req.propertyId, req.jurisdiction, req.now)
  );
  const propose = () => ({
    topic: req.topic,
    question: req.question,
    propertyId: req.propertyId,
    timesAsked: (req.timesAsked ?? 0) + 1,
    status: "proposed"
  });
  if (servable.length === 0) {
    return { kind: "refuse", reason: "no_approved_answer", propose: propose() };
  }
  if (req.confidence < req.confidenceThreshold) {
    return { kind: "refuse", reason: "below_confidence_threshold", propose: propose() };
  }
  const best = servable[0];
  return {
    kind: "answer",
    text: best.answer,
    sources: servable.map((a) => ({ id: a.id, version: a.version })),
    confidence: req.confidence
  };
}

// src/escalation/emergency.ts
var RULES = [
  {
    kind: "gas",
    callEmergencyServices: true,
    patterns: [/\bsmell(?:s|ing)? (?:like )?gas\b/i, /\bgas (?:leak|smell|odou?r)\b/i, /\bsmell of gas\b/i]
  },
  {
    // Bare /fire/ and /smoke in/ are not usable here: "is there a fire pit on the roof" and
    // "can I smoke in my apartment" are ordinary leasing questions, and routing them to an
    // emergency escalation would be both wrong and expensive. Every pattern below requires
    // phrasing that only occurs when something is actually happening.
    kind: "smoke_or_fire",
    callEmergencyServices: true,
    patterns: [
      /\bthere(?:'s| is) a fire\b/i,
      /\bon fire\b/i,
      /\bfire in (?:the|my)\b/i,
      /\bflames?\b/i,
      /\bthere(?:'s| is) smoke\b/i,
      /\bsmoke (?:coming|everywhere|pouring|filling)\b/i,
      /\bi (?:see|smell) smoke\b/i,
      /\bsmell(?:s|ing)? (?:like )?(?:smoke|burning)\b/i,
      /\bsomething(?:'s| is) burning\b/i,
      /\b(?:fire|smoke) (?:alarm|detector)s? (?:is |are )?(?:going off|sounding|blaring)\b/i
    ]
  },
  {
    kind: "carbon_monoxide",
    callEmergencyServices: true,
    patterns: [/\bcarbon monoxide\b/i, /\bco (?:detector|alarm)\b/i, /\bco2? alarm going off\b/i]
  },
  {
    kind: "injury",
    callEmergencyServices: true,
    patterns: [
      /\b(?:someone|somebody|he|she|they|i)(?:'s| is|'ve| have)? (?:been )?(?:hurt|injured|bleeding)\b/i,
      /\bunconscious\b/i,
      /\bnot breathing\b/i,
      /\bheart attack\b/i,
      /\bfell down\b/i,
      /\bthere(?:'s| is) blood\b/i,
      /\bcall an ambulance\b/i
    ]
  },
  {
    kind: "intruder",
    callEmergencyServices: true,
    patterns: [
      /\b(?:break[- ]?in|broke in|breaking in)\b/i,
      /\bintruder\b/i,
      /\bsomeone(?:'s| is) in my (?:apartment|unit|home)\b/i,
      /\bbeing robbed\b/i
    ]
  },
  {
    // Bare /flood/ catches "flooded the market with concessions". Require a physical subject.
    kind: "flooding",
    callEmergencyServices: false,
    patterns: [
      /\b(?:apartment|unit|bathroom|kitchen|basement|hallway|floor|place)\s+(?:is\s+)?flood(?:ing|ed)\b/i,
      /\bflooding in\b/i,
      /\bit(?:'s| is) flooding\b/i,
      /\bwater (?:is )?(?:everywhere|pouring|gushing|coming through|all over)\b/i,
      /\bceiling(?:'s| is)? (?:leaking|coming down)\b/i,
      /\bburst pipe\b/i,
      /\bpipe burst\b/i
    ]
  },
  {
    kind: "no_heat",
    callEmergencyServices: false,
    patterns: [/\bno heat\b/i, /\bheat(?:'s| is)? (?:out|not working|off)\b/i, /\bfreezing in (?:here|my)\b/i]
  },
  {
    kind: "structural",
    callEmergencyServices: false,
    patterns: [/\bceiling (?:collapsed|caved)\b/i, /\bwall(?:'s| is) cracking\b/i, /\bfloor (?:gave way|collapsed)\b/i]
  }
];
function detectEmergency(utterance) {
  const found = [];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const m = pattern.exec(utterance);
      if (m) {
        found.push({ kind: rule.kind, matched: m[0], callEmergencyServices: rule.callEmergencyServices });
        break;
      }
    }
  }
  return found;
}
function primaryEmergency(signals) {
  if (signals.length === 0) return null;
  const lifeSafety = signals.find((s) => s.callEmergencyServices);
  return lifeSafety ?? signals[0];
}
function safetyInstruction(signal) {
  switch (signal.kind) {
    case "gas":
      return "Please stop what you're doing and leave the apartment right now. Don't use any light switches, appliances, or your phone inside. Once you're outside the building, call 911. I'm alerting the building's emergency contact immediately.";
    case "smoke_or_fire":
      return "Please leave the building now using the stairs, not the elevator. Once you're outside, call 911. I'm alerting the building's emergency contact immediately.";
    case "carbon_monoxide":
      return "Please get everyone out into fresh air right now, then call 911 from outside. I'm alerting the building's emergency contact immediately.";
    case "injury":
      return "Please call 911 right now \u2014 they can get help to you faster than I can. I'm alerting the building's emergency contact at the same time.";
    case "intruder":
      return "Please get somewhere safe and call 911 immediately. I'm alerting building security and the emergency contact right now.";
    case "flooding":
      return "If you can do it safely, shut off the water at the valve and move anything electrical away from the water. I'm dispatching emergency maintenance right now and alerting the building's emergency contact.";
    case "no_heat":
      return "I'm treating this as urgent and alerting the building's emergency contact now. If anyone in the apartment is elderly, very young, or unwell, please call 911.";
    case "structural":
      return "Please move away from that area and don't go back in. I'm alerting the building's emergency contact right now.";
  }
}

// src/conversation/tools.ts
var money = (n) => `$${n.toLocaleString("en-US")}`;
function checkEmergency(utterance, ctx) {
  const signals = detectEmergency(utterance);
  const primary = primaryEmergency(signals);
  if (!primary) return null;
  return {
    say: safetyInstruction(primary),
    record: { kind: "emergency", emergencyKind: primary.kind, matched: primary.matched },
    escalate: { trigger: "emergency", detail: `${primary.kind}: "${primary.matched}"` }
  };
}
function captureSignal(args, ctx) {
  const conf = args.confidence ?? 0.85;
  let q = ctx.qualification;
  if (args.signal === "budget") {
    const n = Number(String(args.value).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) {
      q = captureCore(q, "budget", extracted({ maxMonthly: n, stated: true }, conf, ctx.interactionId, args.excerpt, ctx.now));
    }
  } else if (args.signal === "bedrooms") {
    const n = /studio/i.test(args.value) ? 0 : Number(String(args.value).replace(/[^0-9]/g, ""));
    if (Number.isFinite(n)) {
      q = captureCore(q, "bedrooms", extracted({ min: n, max: n }, conf, ctx.interactionId, args.excerpt, ctx.now));
    }
  } else if (args.signal === "moveInTiming") {
    const parsed = Date.parse(args.value);
    if (!Number.isNaN(parsed)) {
      q = captureCore(q, "moveInTiming", extracted({ earliest: new Date(parsed), latest: null }, conf, ctx.interactionId, args.excerpt, ctx.now));
    }
  }
  const gate = mayQuote(q);
  const next = nextSignalToAsk(q);
  return {
    say: gate.allowed ? "Got it." : next ? `Got it. Still need: ${next}.` : "Got it.",
    record: { kind: "signal_captured", signal: args.signal, value: args.value, excerpt: args.excerpt, confidence: conf },
    qualificationPatch: q
  };
}
function checkAvailability(ctx) {
  const gate = mayQuote(ctx.qualification);
  if (!gate.allowed) {
    const next = nextSignalToAsk(ctx.qualification);
    return {
      say: `Before I quote anything I need a little more. Ask about ${next ?? "their needs"} first, then check again. Do NOT state any rent figure yet.`,
      record: { kind: "quote_gate", allowed: false, captured: gate.captured, missing: gate.missing }
    };
  }
  const out = findMatches(ctx.inventory, ctx.qualification, { now: ctx.now });
  switch (out.kind) {
    case "stale":
      return {
        say: "I need to re-check the current availability before I quote anything \u2014 tell the caller you are pulling up the live list.",
        record: { kind: "availability_checked", outcome: "stale", unitsOffered: [] }
      };
    case "no_match":
      return {
        say: out.reason === "bedroom_mismatch" ? "We do not have that bedroom count available. Say so plainly, ask whether a different size would work, and capture the mismatch." : "Nothing is available matching that. Say so plainly and offer to take their details for the waitlist.",
        record: { kind: "availability_checked", outcome: out.reason, unitsOffered: [] }
      };
    case "priced_out": {
      return {
        say: `Nothing is available at or below ${money(out.budgetMax)}. The lowest available right now is ${money(out.cheapestAvailable)} \u2014 ${money(out.gap)} above what they said. Be straight with them about that. Do NOT pitch a more expensive unit as though it met their budget. Ask whether that gap is workable, or whether they would like to hear when something closer opens up.`,
        record: {
          kind: "availability_checked",
          outcome: "priced_out",
          budgetMax: out.budgetMax,
          cheapestAvailable: out.cheapestAvailable,
          gap: out.gap,
          unitsOffered: out.nearest.map((n) => n.unit.unitId)
        }
      };
    }
    case "matches": {
      const lines = out.units.map((m) => {
        const u = m.unit;
        const avail = new Date(u.availableFrom).toLocaleDateString("en-US", { month: "long", day: "numeric" });
        return `Unit ${u.unitId}: ${u.bedrooms === 0 ? "studio" : `${u.bedrooms} bed`}, ${u.bathrooms} bath, ${u.sqft} sq ft, ${money(u.monthlyRent)}/month, available ${avail}${u.concession ? `. Concession: ${u.concession}` : ""}${u.view ? `. ${u.view}` : ""}`;
      });
      const stretchLines = out.stretch.map((m) => `Slightly above their range: Unit ${m.unit.unitId} at ${money(m.unit.monthlyRent)} \u2014 offer this ONLY after acknowledging it is over what they said.`);
      return {
        say: lines.length > 0 ? `Verified availability \u2014 you may quote these exactly and nothing else:
${lines.join("\n")}${stretchLines.length ? `
${stretchLines.join("\n")}` : ""}` : `Nothing within their stated range.${stretchLines.length ? ` ${stretchLines.join(" ")}` : ""}`,
        record: {
          kind: "availability_checked",
          outcome: "matches",
          unitsOffered: out.units.map((m) => m.unit.unitId)
        }
      };
    }
  }
}
function answerQuestion(args, ctx) {
  const decision = decideAnswer({
    question: args.question,
    topic: args.topic,
    propertyId: ctx.propertyId,
    jurisdiction: ctx.jurisdiction,
    candidates: ctx.articles.filter((a) => a.topic === args.topic),
    confidence: 0.9,
    confidenceThreshold: ctx.confidenceThreshold,
    now: ctx.now
  });
  switch (decision.kind) {
    case "answer":
      return {
        say: decision.text,
        record: {
          kind: "question_answered",
          question: args.question,
          topic: args.topic,
          decision: "answer",
          sources: decision.sources.map((s) => `${s.id}@v${s.version}`)
        }
      };
    case "escalate":
      return {
        say: "That is something a member of the team needs to handle directly. Tell the caller you are passing it to the leasing manager who will follow up, take their contact details, and do NOT attempt to answer, characterise, or redirect the question.",
        record: { kind: "question_answered", question: args.question, topic: args.topic, decision: "escalate", sources: [] },
        escalate: { trigger: `restricted:${args.topic}`, detail: args.question }
      };
    case "defer_to_live_source":
      return {
        say: `That is live information \u2014 use the availability tool, not your own knowledge. Do NOT answer from memory.`,
        record: { kind: "question_answered", question: args.question, topic: args.topic, decision: "defer", sources: [] }
      };
    case "refuse":
      return {
        say: "You do not have an approved answer for that. Say honestly that you do not want to guess, offer to have someone from the office follow up with the exact answer, and take their contact details. Do NOT improvise an answer.",
        record: {
          kind: "question_refused",
          question: args.question,
          reason: decision.reason,
          timesAsked: decision.propose.timesAsked
        }
      };
  }
}
function captureLossReason(reason, ctx) {
  return {
    say: "Noted.",
    record: { kind: "loss_reason", reason: { ...reason, at: ctx.now } }
  };
}

// src/booking/book.ts
function idempotencyKey(req) {
  return [req.propertyId, req.prospectPhone, req.slot.slotId].join("|");
}
function recordIntent(req, opts) {
  return {
    intentId: opts.makeIntentId(req),
    idempotencyKey: idempotencyKey(req),
    request: req,
    createdAt: opts.now
  };
}
var sameSlot = (a, b) => a.slotId === b.slotId && a.startsAt.getTime() === b.startsAt.getTime();
async function bookTour(req, calendar, opts) {
  const intent = recordIntent(req, opts);
  const maxAttempts = opts.maxAttempts ?? 3;
  let attempts = 0;
  let lastError = null;
  let externalId = null;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      if (externalId === null) {
        const created = await calendar.createBooking(intent);
        externalId = created.externalId;
      }
      const readBack = await calendar.readBooking(externalId);
      if (readBack === null) {
        lastError = "read-back returned nothing";
        continue;
      }
      if (!sameSlot(readBack.slot, req.slot)) {
        const alternatives = await calendar.listSlots(req.propertyId, req.slot.startsAt, new Date(req.slot.startsAt.getTime() + 7 * 864e5)).catch(() => []);
        return {
          intent,
          state: { status: "slot_taken", alternatives },
          updatedAt: opts.now
        };
      }
      return {
        intent,
        state: {
          status: "confirmed",
          externalId: readBack.externalId,
          verifiedAt: opts.now,
          slot: readBack.slot
        },
        updatedAt: opts.now
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (/taken|conflict|unavailable|already booked/i.test(lastError)) {
        const alternatives = await calendar.listSlots(req.propertyId, req.slot.startsAt, new Date(req.slot.startsAt.getTime() + 7 * 864e5)).catch(() => []);
        return { intent, state: { status: "slot_taken", alternatives }, updatedAt: opts.now };
      }
    }
  }
  const state = externalId !== null ? { status: "arranging", externalId, attempts, lastError } : { status: "failed", attempts, lastError: lastError ?? "unknown", queuedForHuman: true };
  return { intent, state, updatedAt: opts.now };
}
function sayableStatus(booking) {
  const s = booking.state;
  const name = booking.intent.request.prospectName;
  switch (s.status) {
    case "confirmed": {
      const when = s.slot.startsAt;
      return `You're all set, ${name}. I've got you down for ${when.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York"
      })}. You'll get a confirmation by email shortly.`;
    }
    case "arranging":
      return `I'm getting that booked for you now, ${name}. I'll confirm by text and email as soon as it's locked in \u2014 if you don't hear from me within the hour, please call back.`;
    case "slot_taken":
      return s.alternatives.length > 0 ? `That time just went, I'm afraid. I do have ${s.alternatives.slice(0, 3).map((a) => a.startsAt.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })).join(", or ")}. Would any of those work?` : `That time just went, I'm afraid, and I don't have anything else on the calendar right now. Let me have someone call you back with options.`;
    case "failed":
      return `I'm having trouble reaching the calendar right now, ${name}. I've flagged this for the leasing team and someone will call you back shortly to lock in a time \u2014 I don't want to tell you it's booked when I can't see it.`;
  }
}

// src/domain/ids.ts
var propertyId = (v) => v;
var interactionId = (v) => v;

// api/vapi.ts
var DATA = join(process.cwd(), "data");
var cache = null;
async function readJson(name, fallback) {
  try {
    return JSON.parse(await readFile(join(DATA, name), "utf8"));
  } catch {
    return fallback;
  }
}
async function load(now) {
  if (cache && Date.now() - cache.loadedAt < 6e4) return cache;
  const [rawUnits, rawPlans, rawArticles, property] = await Promise.all([
    readJson("inventory.json", []),
    readJson("floorplans.json", []),
    readJson("knowledge.json", []),
    readJson("property.json", {})
  ]);
  const { snapshot, problems } = loadInventory(rawUnits, rawPlans, now, "data/inventory.json");
  if (problems.length > 0) console.warn("[inventory] excluded records:", problems);
  const articles = rawArticles.map((a) => ({
    ...a,
    approvedAt: a.approvedAt ? new Date(a.approvedAt) : null,
    reviewBy: new Date(a.reviewBy)
  }));
  cache = { inventory: snapshot, articles, property, loadedAt: Date.now() };
  return cache;
}
var calls = /* @__PURE__ */ new Map();
function callState(callId) {
  let s = calls.get(callId);
  if (!s) {
    s = { qualification: emptyQualification(), name: null, email: null };
    calls.set(callId, s);
  }
  return s;
}
function demoSlots(now) {
  const slots = [];
  for (let d = 1; d <= 10; d++) {
    const day = new Date(now.getTime() + d * 864e5);
    const dow = day.getUTCDay();
    const hours = dow === 0 ? [15, 17] : dow === 6 ? [14, 15, 16, 18] : [14, 16, 18, 21];
    for (const h of hours) {
      const startsAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, 0, 0));
      slots.push({
        slotId: `slot-${startsAt.toISOString().slice(0, 13)}`,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 6e4)
      });
    }
  }
  return slots;
}
var booked = /* @__PURE__ */ new Map();
function demoCalendar(now) {
  return {
    async listSlots() {
      return demoSlots(now).filter((s) => ![...booked.values()].some((b) => b.slot.slotId === s.slotId));
    },
    async createBooking(intent) {
      const existing = booked.get(intent.idempotencyKey);
      if (existing) return { externalId: existing.externalId };
      const externalId = `demo-${intent.idempotencyKey.replace(/[^a-zA-Z0-9]/g, "").slice(-16)}`;
      booked.set(intent.idempotencyKey, { externalId, slot: intent.request.slot });
      return { externalId };
    },
    async readBooking(externalId) {
      for (const b of booked.values()) if (b.externalId === externalId) return b;
      return null;
    }
  };
}
var fmtSlot = (s) => s.startsAt.toLocaleString("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York"
});
var eventLog = [];
function logEvent(callId, e) {
  eventLog.push({ ...e, callId, at: (/* @__PURE__ */ new Date()).toISOString() });
  if (eventLog.length > 2e3) eventLog.splice(0, eventLog.length - 2e3);
}
async function runTool(name, args, callId, now) {
  const { inventory, articles, property } = await load(now);
  const state = callState(callId);
  const ctx = {
    propertyId: propertyId(String(property.id ?? "prop-demo")),
    interactionId: interactionId(callId),
    inventory,
    articles,
    qualification: state.qualification,
    jurisdiction: "NY",
    confidenceThreshold: 0.7,
    now
  };
  switch (name) {
    case "capture_signal": {
      const r = captureSignal(args, ctx);
      if (r.qualificationPatch) state.qualification = r.qualificationPatch;
      logEvent(callId, r.record);
      return r.say;
    }
    case "check_availability": {
      const r = checkAvailability(ctx);
      logEvent(callId, r.record);
      return r.say;
    }
    case "answer_question": {
      const r = answerQuestion(args, ctx);
      logEvent(callId, r.record);
      if (r.escalate) logEvent(callId, { kind: "escalated", trigger: r.escalate.trigger, detail: r.escalate.detail });
      return r.say;
    }
    case "list_tour_slots": {
      const slots = await demoCalendar(now).listSlots(ctx.propertyId, now, now);
      const next = slots.slice(0, 6);
      logEvent(callId, { kind: "slots_listed", count: next.length });
      return next.length === 0 ? "No tour times are open. Offer to have someone call them back." : `Real open tour times \u2014 offer only these, and use the slotId when booking:
${next.map((s) => `${s.slotId} \u2014 ${fmtSlot(s)}`).join("\n")}`;
    }
    case "book_tour": {
      const slots = await demoCalendar(now).listSlots(ctx.propertyId, now, now);
      const slot = slots.find((s) => s.slotId === args.slotId);
      if (!slot) return "That slot is not on the calendar. Call list_tour_slots again and offer a real time.";
      state.name = String(args.prospectName ?? state.name ?? "");
      state.email = args.prospectEmail ? String(args.prospectEmail) : state.email;
      const booking = await bookTour({
        propertyId: ctx.propertyId,
        interactionId: ctx.interactionId,
        personId: null,
        prospectName: state.name || "there",
        prospectPhone: callId,
        prospectEmail: state.email,
        slot,
        unitId: args.unitId ? String(args.unitId) : null,
        floorPlanId: null
      }, demoCalendar(now), { now, makeIntentId: () => `intent-${callId}-${slot.slotId}` });
      logEvent(callId, {
        kind: "tour_booked",
        status: booking.state.status,
        slot: fmtSlot(slot),
        unitId: args.unitId ?? null,
        prospectName: state.name,
        prospectEmail: state.email
      });
      return sayableStatus(booking);
    }
    case "capture_loss_reason": {
      const r = captureLossReason({
        kind: args.kind,
        detail: String(args.detail ?? ""),
        evidence: String(args.evidence ?? ""),
        confidence: 0.9
      }, ctx);
      logEvent(callId, r.record);
      return r.say;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}
async function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      events: eventLog,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      note: "In-memory, warm-instance scoped. Resets on cold start."
    });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "GET or POST only" });
    return;
  }
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (expected) {
    const provided = req.headers["x-vapi-secret"] ?? req.headers["x-vapi-signature"];
    if (provided !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }
  const now = /* @__PURE__ */ new Date();
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const message = body?.message ?? {};
  const callId = String(message?.call?.id ?? body?.call?.id ?? "unknown-call");
  try {
    if (message.type === "transcript" && message.role === "user" && message.transcript) {
      const { inventory, articles, property } = await load(now);
      const emergency = checkEmergency(String(message.transcript), {
        propertyId: propertyId(String(property.id ?? "prop-demo")),
        interactionId: interactionId(callId),
        inventory,
        articles,
        qualification: callState(callId).qualification,
        jurisdiction: "NY",
        confidenceThreshold: 0.7,
        now
      });
      if (emergency) {
        logEvent(callId, emergency.record);
        logEvent(callId, { kind: "escalated", trigger: "emergency", detail: emergency.escalate?.detail });
      }
      res.status(200).json({});
      return;
    }
    if (message.type === "tool-calls") {
      const list = message.toolCallList ?? message.toolCalls ?? [];
      const results = await Promise.all(list.map(async (tc) => {
        const name = tc.name ?? tc.function?.name;
        const rawArgs = tc.arguments ?? tc.function?.arguments ?? {};
        const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
        const result = await runTool(String(name), args, callId, now);
        return { toolCallId: tc.id ?? tc.toolCallId, result };
      }));
      res.status(200).json({ results });
      return;
    }
    if (message.type === "status-update" || message.type === "end-of-call-report") {
      logEvent(callId, { kind: "call_status", status: message.status ?? message.type });
      if (message.type === "end-of-call-report") calls.delete(callId);
    }
    res.status(200).json({});
  } catch (err) {
    console.error("[vapi] handler error", err);
    logEvent(callId, { kind: "error", message: err instanceof Error ? err.message : String(err) });
    res.status(200).json({
      results: [{
        toolCallId: "error",
        result: "Something went wrong on my end. Apologise, offer to have someone call them back, and take their number."
      }]
    });
  }
}
export {
  handler as default,
  eventLog
};
