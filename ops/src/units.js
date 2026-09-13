/* Unit workspace. Saved tours and staff observations complement read-only source facts. */
(function () {
'use strict'
const A = window.Atrium
if (!A) return
const esc = A.escapeHtml, arr = value => Array.isArray(value) ? value : []
const SENTIMENTS = [['positive', 'Positive'], ['neutral', 'Neutral'], ['negative', 'Negative']]
const REASONS = [['price', 'Price'], ['layout', 'Layout'], ['light', 'Natural light'], ['noise', 'Noise'], ['condition', 'Condition'], ['amenities', 'Amenities'], ['other', 'Other']]
const label = (list, value) => list.find(([key]) => key === value)?.[1] || 'Not specified'
const ico = name => `<span class="ico">${A.icon(name)}</span>`
const byNewest = (a, b) => String(b.observedDate).localeCompare(String(a.observedDate)) || String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id))
const countsFor = entries => entries.reduce((counts, entry) => {
  if (SENTIMENTS.some(([key]) => key === entry.sentiment)) counts[entry.sentiment]++
  return counts
}, { positive: 0, neutral: 0, negative: 0 })
const unitFacts = unit => [unit.floorPlanName || unit.floorPlanId,
  Number.isFinite(unit.bedrooms) ? unit.bedrooms === 0 ? 'Studio' : `${unit.bedrooms} bed` : '',
  Number.isFinite(unit.sqft) ? `${unit.sqft.toLocaleString('en-US')} sq ft` : ''].filter(Boolean).join(' · ')

function feedbackModel(s, options = {}) {
  const raw = s.leads || {}, catalog = arr(raw.feedbackUnits).filter(u => u && typeof u.unitId === 'string')
  const all = arr(raw.unitFeedback).filter(f => f && typeof f.id === 'string' && typeof f.unitId === 'string')
  const since = options.period === '30' ? A.fmt.addDays(A.fmt.nyNow().ymd, -29) : null
  const entries = all.filter(f => !since || (f.observedDate >= since && f.observedDate <= A.fmt.nyNow().ymd)).sort(byNewest)
  const units = new Map(catalog.map(unit => [unit.unitId, { ...unit, current: true }]))
  // Retain saved feedback when a unit is absent from a newer source snapshot.
  for (const entry of all) if (!units.has(entry.unitId)) units.set(entry.unitId, { unitId: entry.unitId, current: false })
  for (const record of [...arr(s.calendar?.bookings), ...arr(s.calendar?.unitBlocks)]) {
    if (record?.unitId && !units.has(record.unitId)) units.set(record.unitId, { unitId: record.unitId, current: false })
  }
  const unitRows = [...units.values()].map(unit => {
    const feedback = entries.filter(entry => entry.unitId === unit.unitId)
    return { ...unit, feedback, counts: countsFor(feedback) }
  }).sort((a, b) => a.unitId.localeCompare(b.unitId, 'en', { numeric: true }))
  const query = String(options.query || '').trim().toLowerCase()
  const shownUnits = unitRows.filter(unit => !query || [unit.unitId, unit.floorPlanId, unit.floorPlanName].filter(Boolean).join(' ').toLowerCase().includes(query))
  const selected = options.unitId ? unitRows.find(unit => unit.unitId === options.unitId) || null : null
  const selectedMissing = Boolean(options.unitId && !selected)
  const selectedEntries = selectedMissing ? [] : selected ? selected.feedback : entries
  const reasons = REASONS.map(([category, name]) => {
    const matching = selectedEntries.filter(entry => entry.category === category)
    return { category, name, count: matching.length, ...countsFor(matching) }
  }).filter(reason => reason.count).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { available: Boolean(raw.feedbackInventory), inventory: raw.feedbackInventory, truncated: raw.unitFeedbackTruncated === true,
    catalog, shownUnits, selected, selectedMissing, entries: selectedEntries, counts: countsFor(selectedEntries), reasons,
    unitsWithFeedback: new Set(selectedEntries.map(entry => entry.unitId)).size, totalUnits: unitRows.length }
}

function sourceHtml(model) {
  if (!model.available) return A.html.banner('warn', 'Unit feedback is not available from this workspace yet. Refresh after the workspace has been updated.')
  const source = model.inventory, date = source.readAt ? A.fmt.dateTime(source.readAt) : 'date not supplied'
  const demo = source.fictional === true || source.sourceMode === 'demo'
  return `<div class="uf-source small muted">${demo ? A.html.chip('chip-neutral', 'info', 'Fictional demo catalogue') + ' ' : ''}` +
    `Snapshot ${esc(date)} · ${demo ? 'Sample unit facts; not live availability.' : 'Check the source system for current availability.'}` +
    `<details class="uf-source-details"><summary data-key="source-details">Source details</summary><p>${esc(source.source || 'The configured property source')}. Feedback is entered by staff.</p></details></div>`
}
function unitsHtml(model, unitId) {
  let html = `<button type="button" class="uf-unit uw-property" data-unit="" data-key="unit:all" aria-current="${unitId ? 'false' : 'true'}">${ico('home')}<strong>Whole property</strong><span class="small muted">Tours, interest and feedback</span></button>` +
    '<div class="uw-explorer-label"><strong>Apartment explorer</strong><span>Catalogue order · not a floor plan</span></div><div class="uf-unit-list uw-explorer">'
  for (const unit of model.shownUnits) html += `<button type="button" class="uf-unit" data-unit="${esc(unit.unitId)}" data-key="unit:${esc(unit.unitId)}" aria-current="${unit.unitId === unitId ? 'true' : 'false'}">` +
    `<span class="uw-apartment-label">Apartment</span><strong>${esc(unit.unitId)}</strong><span class="small muted">${esc(unit.current ? (Number.isFinite(unit.floor) ? `Floor ${unit.floor}` : unitFacts(unit) || 'Source unit') : 'Prior unit reference')}</span>` +
    (model.workspace?.calendarFresh ? `<span class="uw-tile-tour">${A.text.plural(model.workspace.allTours.filter(t => t.unitId === unit.unitId).length, 'tour')} · next 7 days</span>` : '') +
    `<span class="uf-counts"><span class="uf-up">${unit.counts.positive} positive</span><span class="uf-down">${unit.counts.negative} negative</span><span class="muted">${unit.counts.neutral} neutral</span></span></button>`
  if (!model.shownUnits.length) html += '<p class="uf-unit-empty muted">No units match this search.</p>'
  return html + '</div>'
}
function entryHtml(entry, s) {
  const profile = arr(s.leads?.profiles).find(p => p && p.phone === entry.leadPhone)
  const who = entry.leadPhone ? profile ? `<a href="${esc(A.hashFor('leads', { tab: 'all', phone: entry.leadPhone }))}">${esc(A.derive.displayName(profile))}</a>` : 'Linked prospect no longer in the current list' : 'Staff observation · no prospect linked'
  const sentimentClass = entry.sentiment === 'positive' ? 'chip-ok' : entry.sentiment === 'negative' ? 'chip-danger' : 'chip-neutral'
  const changed = entry.updatedAt && entry.updatedAt !== entry.createdAt
  return `<li class="uf-entry" data-feedback-id="${esc(entry.id)}"><div class="uf-entry-head">` +
    `<a href="${esc(A.hashFor('units', { unit: entry.unitId }))}">Apartment ${esc(entry.unitId)}</a>` +
    A.html.chip(sentimentClass, null, label(SENTIMENTS, entry.sentiment)) + `<span class="small muted">${esc(label(REASONS, entry.category))}</span></div>` +
    (entry.note ? `<p class="uf-entry-note">${esc(entry.note)}</p>` : '') +
    `<div class="small">${who}</div><div class="uf-entry-meta"><span>Observed ${esc(A.fmt.day(entry.observedDate))}</span>` +
    `<span>Added by ${esc(entry.createdBy?.label || 'Staff')} · ${esc(A.fmt.dateTime(entry.createdAt))}</span>` +
    (changed ? `<span>Edited by ${esc(entry.updatedBy?.label || 'Staff')} · ${esc(A.fmt.dateTime(entry.updatedAt))}</span>` : '') +
    (A.can('operate') && arr(s.leads?.feedbackUnits).some(unit => unit?.unitId === entry.unitId)
      ? `<button type="button" class="btn-link" data-edit="${esc(entry.id)}" data-key="feedback-edit:${esc(entry.id)}" data-write="leads">Edit</button>` : '') + '</div></li>'
}
function detailHtml(model, s) {
  if (model.selectedMissing) return A.html.empty({ icon: 'home', title: 'This unit is not in the current workspace.', text: 'Choose a unit from the list to see its feedback.' })
  const title = model.selected ? `Apartment ${model.selected.unitId}` : A.property.name
  const subtitle = model.selected ? model.selected.current ? unitFacts(model.selected) : 'Saved feedback from a prior unit reference' : `Feedback across ${A.text.plural(model.unitsWithFeedback, 'unit')}`
  let html = `<div class="uf-detail-head"><h2>${esc(title)}</h2><p class="muted small">${esc(subtitle)}</p></div>` +
    `<div class="uf-metrics"><div class="card uf-metric"><span>Feedback entries</span><strong>${model.entries.length}</strong><span>${model.counts.neutral} neutral</span></div>` +
    `<div class="card uf-metric"><span>Positive</span><strong class="uf-up">${model.counts.positive}</strong><span>Saved observations</span></div>` +
    `<div class="card uf-metric"><span>Negative</span><strong class="uf-down">${model.counts.negative}</strong><span>Saved observations</span></div></div>`
  html += `<section class="card uf-section"><h3>Recurring reasons</h3><p class="small muted">Counts from the selected feedback period. These are observations, not a property score.</p>`
  if (!model.reasons.length) html += '<p class="muted" style="margin-top:16px">No reasons recorded for this selection.</p>'
  else {
    const maximum = Math.max(...model.reasons.map(reason => reason.count), 1)
    html += '<div class="uf-reasons">' + model.reasons.map(reason => `<div><div class="uf-reason-line"><span>${esc(reason.name)}</span>` +
      `<span class="uf-reason-count">${reason.positive} positive · ${reason.negative} negative${reason.neutral ? ` · ${reason.neutral} neutral` : ''}</span></div>` +
      `<div class="uf-reason-track" aria-hidden="true">${SENTIMENTS.map(([sentiment]) => `<span class="uf-reason-bar ${sentiment}" style="width:${reason[sentiment] / maximum * 100}%"></span>`).join('')}</div></div>`).join('') + '</div>'
  }
  html += '</section><section class="card uf-section"><h3>Feedback and notes</h3><p class="small muted">Prospect comments and staff observations, newest observed date first.</p>'
  html += model.entries.length ? `<ul class="uf-feed">${model.entries.map(entry => entryHtml(entry, s)).join('')}</ul>` :
    '<div class="empty"><p class="empty-title">No feedback recorded yet.</p><p class="empty-text">Add what a prospect liked, what held them back, or a specific staff observation.</p></div>'
  return html + '</section>'
}

const validPhone = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value)
const time = value => Date.parse(value || '')
function resourceFresh(s, key) {
  const checked = time(s.lastGoodAt?.[key])
  return Boolean(s.loaded?.[key] && !s.errors?.[key] && Number.isFinite(checked) && checked <= Date.now() + 5000 && Date.now() - checked <= 60000)
}
function workspaceModel(s, model) {
  const today = A.fmt.nyNow().ymd, through = A.fmt.addDays(today, 6), selected = model.selected?.unitId
  const calendarLoaded = Boolean(s.loaded?.calendar && s.calendar), calendarFresh = resourceFresh(s, 'calendar')
  // Canonical calendar records are authoritative. Profile booking history may be stale after a move.
  const unique = new Map()
  for (const booking of arr(s.calendar?.bookings)) {
    const date = A.fmt.nyDate(booking?.startsAt)
    if (!booking?.externalId || (booking.status && booking.status !== 'confirmed') || !date || date < today || date > through
      || !Number.isFinite(time(booking.endsAt)) || time(booking.endsAt) <= Date.now() || time(booking.endsAt) <= time(booking.startsAt)) continue
    if (!unique.has(booking.externalId)) unique.set(booking.externalId, booking)
  }
  const allTours = [...unique.values()].sort((a, b) => time(a.startsAt) - time(b.startsAt) || a.externalId.localeCompare(b.externalId))
  const tours = model.selectedMissing ? [] : allTours.filter(tour => !selected || tour.unitId === selected)
  const blocks = model.selectedMissing ? [] : arr(s.calendar?.unitBlocks).filter(block => block?.id && !block.removedAt
    && time(block.endsAt) > Date.now() && time(block.endsAt) > time(block.startsAt) && (!selected || block.unitId === selected))
    .sort((a, b) => time(a.startsAt) - time(b.startsAt))
  const linkedPhones = new Set([...tours.map(t => t.prospectPhone), ...model.entries.map(f => f.leadPhone)].filter(validPhone))
  const profiles = arr(s.leads?.profiles).filter(profile => validPhone(profile?.phone) && linkedPhones.has(profile.phone))
  const conflicts = tour => blocks.filter(block => block.unitId === tour.unitId
    && time(block.startsAt) < time(tour.occupiedEndsAt || tour.endsAt) && time(block.endsAt) > time(tour.occupiedStartsAt || tour.startsAt))
  return { today, through, calendarLoaded, calendarFresh, leadsFresh: resourceFresh(s, 'leads'), allTours, tours, blocks, profiles, conflicts }
}
const workspaceLink = (viewName, params, title, primary = false) => `<a class="btn ${primary ? 'btn-primary' : 'btn-quiet'}" href="${esc(A.hashFor(viewName, params))}">${esc(title)}</a>`
function phoneAction(phone, ready) {
  return ready && A.can('operate') && validPhone(phone)
    ? `<a class="btn btn-quiet" href="${esc(A.href.tel(phone))}" title="Opens your device’s configured calling app">${ico('phone')}Call in phone app</a>` : ''
}
function prospectContext(profile) {
  if (!profile) return '<p class="uw-context muted">No linked prospect record yet. Check the booking details before contacting.</p>'
  const signals = profile.signals || {}, facts = []
  const budget = signals.budgetRange || signals.budget
  if (budget) {
    const value = A.derive.budgetText(budget.value)
    if (value) facts.push(['Budget', value, budget])
  }
  if (signals.moveIn) {
    const value = signals.moveIn.excerpt || A.derive.moveInText(signals.moveIn.value)
    if (value) facts.push(['Move-in', value, signals.moveIn])
  }
  const note = arr(profile.notes).filter(value => typeof value === 'string' && value.trim()).at(-1)
  return (facts.length ? `<dl class="uw-prospect-facts">${facts.map(([label_, value, signal]) => `<div><dt>${esc(label_)}${Number(signal.confidence) < .7 ? ' · check with prospect' : ''}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>` : '<p class="uw-context muted">Preferences have not been recorded yet.</p>') +
    (note ? `<p class="uw-staff-note"><strong>Latest staff note</strong><span>${esc(note)}</span></p>` : '')
}
function tourCardHtml(tour, s, workspace) {
  const profile = workspace.profiles.find(p => p.phone === tour.prospectPhone)
  const name = profile ? A.derive.displayName(profile) : tour.prospectName || 'Name not recorded'
  const conflicts = workspace.conflicts(tour), ready = workspace.calendarFresh && workspace.leadsFresh
  const starts = time(tour.startsAt) <= Date.now() ? 'Scheduled now' : 'Tour booked'
  return `<article class="uw-tour" data-key="workspace-tour:${esc(tour.externalId)}"><div class="uw-tour-top"><div><span class="uw-eyebrow">${esc(A.fmt.day(tour.startsAt))}</span><h4>${esc(A.fmt.timeRange(tour.startsAt, tour.endsAt))}</h4></div>` +
    A.html.chip(conflicts.length ? 'chip-warn' : 'chip-neutral', conflicts.length ? 'warning' : 'calendar', conflicts.length ? 'Availability conflict' : workspace.calendarFresh ? starts : 'Last saved tour') + '</div>' +
    `<div class="uw-tour-person"><strong>${esc(name)}</strong>${tour.unitId ? `<a href="${esc(A.hashFor('units', { unit: tour.unitId }))}">Apartment ${esc(tour.unitId)}</a>` : '<span>No apartment selected</span>'}</div>` +
    (conflicts.length ? '<p class="uw-conflict">This tour overlaps a unit hold. The booking is still saved. Review the calendar before contacting the prospect.</p>' : '') +
    prospectContext(profile) + `<div class="uw-actions">${profile ? workspaceLink('leads', { tab: 'all', phone: profile.phone }, 'View prospect') : ''}` +
    workspaceLink('calendar', { date: A.fmt.nyDate(tour.startsAt), slot: tour.slotId }, 'View calendar') + phoneAction(tour.prospectPhone, ready) + '</div></article>'
}
function workspaceHtml(model, s) {
  if (model.selectedMissing) return detailHtml(model, s)
  const w = model.workspace || workspaceModel(s, model), unit = model.selected
  const demo = model.inventory?.fictional === true || model.inventory?.sourceMode === 'demo'
  const rent = unit?.current && Number.isFinite(unit.monthlyRent) && unit.monthlyRent >= 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(unit.monthlyRent) : null
  const canHold = unit?.current && A.can('operate') && w.calendarFresh && w.leadsFresh && !A.busyNow('calendar')
    && arr(s.calendar?.units).some(value => (value.unitId || value.id) === unit.unitId) && typeof A.calendarActions?.openUnitBlocks === 'function'
  let html = `<section class="uw-hero"><div class="uw-hero-copy"><span class="uw-eyebrow">${esc(unit ? A.property.name : 'Leasing workspace')}</span>` +
    `<h2 tabindex="-1" data-key="workspace-heading">${esc(unit ? `Apartment ${unit.unitId}` : 'Prepare for the next tour.')}</h2><p>${esc(unit ? unit.current ? unitFacts(unit) : 'Prior unit reference · saved records retained' : 'Know who is coming, what matters to them, and what needs your attention.')}</p>` +
    (unit?.current ? `<div class="uw-snapshot">${rent ? `<strong>${esc(rent)}<span> / month</span></strong>` : '<strong>Rent not supplied</strong>'}<span>${demo ? 'Sample rent' : 'Rent at source snapshot'}${unit.status ? ` · ${esc(unit.status)} in source` : ''}</span></div>` : '') +
    `<div class="uw-actions">${workspaceLink('calendar', { date: w.today }, 'Open tour calendar', true)}` +
    (canHold ? `<button type="button" class="btn uw-light-button" data-unit-availability="${esc(unit.unitId)}" data-key="unit-availability:${esc(unit.unitId)}" data-write="calendar">Unit availability</button>` : '') + '</div></div>' +
    `<div class="uw-hero-mark" aria-hidden="true"><span>${unit ? 'APARTMENT' : 'NEXT 7 DAYS'}</span><strong>${esc(unit ? unit.unitId : w.calendarFresh ? String(w.tours.length) : '—')}</strong><span>${unit ? 'TOUR BRIEF' : 'SAVED TOURS'}</span></div></section>`
  if (!w.calendarFresh) html += A.html.banner('warn', w.calendarLoaded
    ? 'Calendar needs a refresh. These are the last loaded tours and holds; current availability is unconfirmed.'
    : 'Calendar has not loaded yet. Tour counts and availability are not confirmed.')
  if (!w.leadsFresh) html += A.html.banner('info', 'Prospect details may be out of date. Refresh before contacting someone or changing unit availability.')
  html += `<div class="uw-metrics"><div class="card"><span>Tours · next 7 days</span><strong>${w.calendarFresh ? w.tours.length : '—'}</strong><span>${esc(A.fmt.day(w.today))} – ${esc(A.fmt.day(w.through))}</span></div>` +
    `<div class="card"><span>Linked prospects</span><strong>${w.profiles.length}</strong><span>From these tours and feedback</span></div>` +
    `<div class="card"><span>Concerns recorded</span><strong>${model.counts.negative}</strong><span>${model.truncated ? 'Within loaded feedback only' : 'Negative feedback in selected period'}</span></div></div>`
  html += `<section class="card uf-section uw-tour-section"><div class="uw-section-heading"><div><h3>Tour preparation</h3><p class="muted">Next 7 days · ${esc(A.property.timeZoneLabel)}.</p></div></div>`
  html += w.tours.length ? `<div class="uw-tours">${w.tours.slice(0, 6).map(tour => tourCardHtml(tour, s, w)).join('')}</div>` :
    `<div class="uw-empty">${ico('calendar')}<h4>${w.calendarFresh ? 'No tours booked in the next 7 days.' : 'No tours available in the loaded records.'}</h4><p>Open the calendar to review dates and availability.</p></div>`
  if (w.tours.length > 6) html += `<p class="uw-more">Showing the next 6 of ${w.tours.length} saved tours. ${workspaceLink('calendar', { date: A.fmt.nyDate(w.tours[6].startsAt) }, 'View more on calendar')}</p>`
  html += '</section>'
  if (w.blocks.length) html += `<section class="card uf-section uw-holds"><h3>Unit availability holds</h3><p class="muted">A hold prevents new tours for its apartment during these times. Existing bookings stay saved.</p><ul>${w.blocks.slice(0, 8).map(block => `<li><strong>Apartment ${esc(block.unitId)}</strong><span>${esc(A.fmt.dateTime(block.startsAt))} – ${esc(A.fmt.dateTime(block.endsAt))}</span><span>${esc(block.reason || 'No reason recorded')}</span></li>`).join('')}</ul>${w.blocks.length > 8 ? `<p>Showing 8 of ${w.blocks.length} loaded holds. View the calendar for the rest.</p>` : ''}</section>`
  if (unit && w.profiles.length) html += `<section class="card uf-section"><h3>Connected prospects</h3><p class="muted">Linked through tours and saved feedback.</p><ul class="uw-prospects">${w.profiles.map(profile => `<li><div><strong>${esc(A.derive.displayName(profile))}</strong><span>${esc(A.fmt.phone(profile.phone))}</span></div>${workspaceLink('leads', { tab: 'all', phone: profile.phone }, 'View prospect')}</li>`).join('')}</ul></section>`
  return html + '<div class="uw-feedback-heading"><h2>What prospects are saying</h2><p class="muted">Use recorded feedback to prepare the conversation and improve the next showing.</p></div>' + detailHtml(model, s)
}
function openUnitAvailability(unitId) {
  const s = A.state
  if (!A.can('operate') || !resourceFresh(s, 'calendar') || !resourceFresh(s, 'leads') || A.busyNow('calendar')
    || !arr(s.leads?.feedbackUnits).some(unit => unit?.unitId === unitId)
    || !arr(s.calendar?.units).some(unit => (unit?.unitId || unit?.id) === unitId)) return
  A.calendarActions?.openUnitBlocks({ unitId })
}

function feedbackRequest(values, s, existing, idempotencyKey) {
  const units = arr(s.leads?.feedbackUnits), profiles = arr(s.leads?.profiles)
  const unitId = existing?.unitId || String(values.unitId || '')
  if (!unitId || !units.some(unit => unit?.unitId === unitId)) throw new Error('Choose a unit in this property’s current catalogue.')
  if (!SENTIMENTS.some(([value]) => value === values.sentiment)) throw new Error('Choose positive, neutral or negative feedback.')
  if (!REASONS.some(([value]) => value === values.category)) throw new Error('Choose a reason for this feedback.')
  const observedDate = String(values.observedDate || '')
  const parsed = new Date(observedDate + 'T12:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate) || observedDate < '1900-01-01' || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== observedDate
    || observedDate > A.fmt.nyNow().ymd) throw new Error('Choose a valid observed date up to today in the property’s timezone.')
  const note = String(values.note || '').trim()
  if (note.length > 1000) throw new Error('Keep the note to 1,000 characters or fewer.')
  const leadPhone = values.leadPhone ? String(values.leadPhone) : null
  if (leadPhone && (!/^\+[1-9]\d{7,14}$/.test(leadPhone) || !profiles.some(profile => profile?.phone === leadPhone)))
    throw new Error('Choose a prospect currently listed in this property, or leave the field empty.')
  return { action: existing ? 'unit_feedback_edit' : 'unit_feedback_add', idempotencyKey,
    ...(existing ? { id: existing.id, expectedRevision: existing.revision } : { unitId }),
    sentiment: values.sentiment, category: values.category, note, leadPhone, observedDate }
}

function openFeedback(unitId, existing = null) {
  if (!A.can('operate') || A.busyNow('leads') || !A.state.leads?.feedbackInventory || A.state.errors.leads) return null
  if (!window.crypto?.randomUUID) { A.toast('Reload this secure workspace before adding feedback.', { kind: 'error' }); return null }
  const key = window.crypto.randomUUID(), today = A.fmt.nyNow().ymd
  const units = arr(A.state.leads.feedbackUnits), profiles = arr(A.state.leads.profiles).filter(p => p && /^\+[1-9]\d{7,14}$/.test(p.phone))
  if (unitId && !units.some(unit => unit.unitId === unitId)) return null
  const prospectOptions = profiles.map(profile => [profile.phone, `${A.derive.displayName(profile)} · ${A.fmt.phone(profile.phone)}`])
  if (existing?.leadPhone && !profiles.some(profile => profile.phone === existing.leadPhone)) prospectOptions.unshift([existing.leadPhone, 'Previously linked prospect · no longer available'])
  let form, closed = false, pending = null, conflicted = false
  const options = (list, selected, emptyLabel) => `<option value="">${esc(emptyLabel)}</option>` + list.map(([value, name]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(name)}</option>`).join('')
  const handle = A.dialog({ title: existing ? `Edit feedback · Apartment ${existing.unitId}` : 'Add unit feedback', secondary: { label: 'Cancel' },
    onClose() { closed = true; if (view.form === handle) view.form = null },
    build(body) {
      body.innerHTML = `<p class="uf-form-intro">${esc(A.property.name)} · Enter a specific observation. Unit details remain in the source system.</p>` +
        `<form class="uf-form"><fieldset>` +
        `<label>Apartment<select class="input" name="unitId" required${existing ? ' disabled' : ''}>${options(existing ? [[existing.unitId, `Apartment ${existing.unitId}`]] : units.map(unit => [unit.unitId, `Apartment ${unit.unitId}`]), existing?.unitId || unitId, 'Select a unit')}</select></label>` +
        `<label>Observed date<input class="input" type="date" name="observedDate" required min="1900-01-01" max="${today}" value="${esc(existing?.observedDate || today)}"><span class="field-hint">${esc(A.property.timeZoneLabel)}</span></label>` +
        `<label>Sentiment<select class="input" name="sentiment" required>${options(SENTIMENTS, existing?.sentiment, 'Select sentiment')}</select></label>` +
        `<label>Reason<select class="input" name="category" required>${options(REASONS, existing?.category, 'Select a reason')}</select></label>` +
        `<label class="uf-full">Link a prospect <span class="muted small">Optional</span><select class="input" name="leadPhone">${options(prospectOptions, existing?.leadPhone, 'No prospect · staff observation')}</select></label>` +
        `<label class="uf-full">Note <span class="muted small">Optional · 1,000 characters</span><textarea class="input" name="note" maxlength="1000" rows="4" placeholder="What did they like, or what would need to improve?">${esc(existing?.note || '')}</textarea></label>` +
        '</fieldset></form>'
      form = body.querySelector('form')
      form.addEventListener('submit', event => event.preventDefault())
    },
    primary: { label: 'Save feedback', busyLabel: 'Saving…', async onClick(dialog) {
      if (closed || !A.can('operate')) return
      if (conflicted) { dialog.close(); A.refresh(); return }
      if (!pending) {
        if (!form.reportValidity()) return
        const values = Object.fromEntries(['unitId', 'sentiment', 'category', 'observedDate', 'note', 'leadPhone'].map(name => [name, form.elements.namedItem(name).value]))
        pending = feedbackRequest(values, A.state, existing, key)
      }
      form.querySelector('fieldset').disabled = true
      dialog.setError('')
      try {
        const data = await A.busy('leads', A.api.post('/api/leads', pending, { doing: 'Save unit feedback' }))
        if (!data.unitFeedback || Array.isArray(data.unitFeedback) || !data.unitFeedback.id) throw Object.assign(new Error('Missing saved feedback'), { badJson: true })
        A.apply('leads', data)
        dialog.close(); A.toast(existing ? 'Feedback updated.' : 'Feedback saved.', { kind: 'ok' })
      } catch (error) {
        if (closed || error.signedOut || error.propertyAccess || !A.can('operate')) return
        if (!error.status || error.status >= 500 || error.badJson) {
          dialog.setError('The save could not be confirmed. Retry to check the same entry; your fields are held to prevent duplicates.')
          dialog.setPrimary({ label: 'Retry save' })
        } else if (error.status === 409) {
          conflicted = true
          dialog.setError('This feedback changed or the save conflicts with an earlier request. Close this form, refresh, and review the saved entry before editing again.')
          dialog.setPrimary({ label: 'Close and review' })
          A.refresh()
        } else {
          pending = null; form.querySelector('fieldset').disabled = false
          dialog.setError(error.status === 404 ? 'The unit or prospect is no longer available. Refresh this workspace and choose a current record.' : error.message || 'Check the feedback fields and try again.')
        }
      }
    } },
  })
  view.form = handle
  return handle
}

const view = {
  title: 'Units', icon: A.icons.units, root: null, source: null, list: null, detail: null, add: null,
  query: '', period: 'all', form: null, selectedKey: null, focusSelected: false,
  listMarkup: null, listActivation: null, listUpdateTimer: null,
  mount(root) {
    this.root = root
    root.innerHTML = `<div class="uf-view"><div class="view-head uf-heading"><div><h1 tabindex="-1">Unit workspace</h1>` +
      `<p class="muted">From prospect interest to a prepared showing. Choose an apartment to bring the details together.</p></div>` +
      `<button type="button" class="btn btn-primary" data-add-feedback data-key="feedback-add" data-write="leads">${ico('plus')}Add feedback</button></div>` +
      `<div class="uf-source-region"></div><div class="uf-toolbar"><label class="search">${ico('search')}<span class="vh">Search units or floor plans</span><input type="search" data-feedback-search placeholder="Search units or floor plans" autocomplete="off"></label>` +
      `<label class="uf-period">Observed period<select class="input" data-feedback-period><option value="all">All saved feedback</option><option value="30">Last 30 days</option></select></label></div>` +
      `<div class="uf-layout"><nav class="card uf-units" aria-label="Select a unit"></nav><div class="uf-detail"></div></div></div>`
    this.source = root.querySelector('.uf-source-region'); this.list = root.querySelector('.uf-units'); this.detail = root.querySelector('.uf-detail'); this.add = root.querySelector('[data-add-feedback]')
    root.querySelector('[data-feedback-search]').addEventListener('input', event => { this.query = event.target.value; this.render(A.state) })
    root.querySelector('[data-feedback-period]').addEventListener('change', event => { this.period = event.target.value; this.render(A.state) })
    // A polling update must not remove a native click/keyboard target between press and activation.
    root.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false || !event.target.closest('[data-unit]')) return
      clearTimeout(this.listUpdateTimer); this.listUpdateTimer = null
      this.listActivation = `pointer:${event.pointerId}`
    })
    root.addEventListener('keydown', event => {
      if ((event.key === ' ' || event.key === 'Enter') && event.target.closest('[data-unit]')) {
        clearTimeout(this.listUpdateTimer); this.listUpdateTimer = null
        this.listActivation = `key:${event.key}`
      }
    })
    const finishActivation = event => {
      const key = event.pointerId == null ? `key:${event.key}` : `pointer:${event.pointerId}`
      if (!this.listActivation || (event.type !== 'blur' && this.listActivation !== key)) return
      clearTimeout(this.listUpdateTimer)
      // Native click follows pointerup/keyup. Repaint only after that event has had its turn.
      this.listUpdateTimer = setTimeout(() => {
        this.listActivation = null; this.listUpdateTimer = null
        if (this.root && !this.root.hidden) this.render(A.state)
      }, 0)
    }
    document.addEventListener('pointerup', finishActivation, true)
    document.addEventListener('pointercancel', finishActivation, true)
    document.addEventListener('keyup', finishActivation, true)
    window.addEventListener?.('blur', finishActivation)
    root.addEventListener('click', event => {
      const unit = event.target.closest('[data-unit]')
      if (unit) {
        clearTimeout(this.listUpdateTimer); this.listUpdateTimer = null; this.listActivation = null
        this.focusSelected = matchMedia('(max-width: 760px)').matches
        A.navigate('units', { unit: unit.dataset.unit || undefined }); return
      }
      const availability = event.target.closest('[data-unit-availability]')
      if (availability) { openUnitAvailability(availability.dataset.unitAvailability); return }
      if (event.target.closest('[data-add-feedback]')) { openFeedback(A.route().params.unit || ''); return }
      const edit = event.target.closest('[data-edit]')
      if (edit) {
        const entry = arr(A.state.leads?.unitFeedback).find(item => item.id === edit.dataset.edit)
        if (entry) openFeedback(entry.unitId, entry)
      }
    })
    A.on('data', () => { if (this.root && !this.root.hidden) this.render(A.state) })
    A.on('poll', () => { if (this.root && !this.root.hidden) this.render(A.state) })
    A.on('busy', () => { if (this.root && !this.root.hidden) this.render(A.state) })
    A.on('minute', () => { if (this.root && !this.root.hidden) this.render(A.state) })
    A.on('route', route => {
      if (route.name === 'units') return
      clearTimeout(this.listUpdateTimer); this.listUpdateTimer = null; this.listActivation = null; this.focusSelected = false
      if (this.form && !this.form.isBusy()) this.form.close()
    })
  },
  renderList(html, unitId, force = false) {
    if (this.listMarkup !== html) {
      if (this.listActivation && !force) return
      const scroller = this.list.querySelector?.('.uf-unit-list')
      const top = scroller?.scrollTop || 0, left = scroller?.scrollLeft || 0
      const active = document.activeElement, key = this.list.contains?.(active) ? active?.dataset?.key : null
      this.list.innerHTML = html; this.listMarkup = html
      const nextScroller = this.list.querySelector?.('.uf-unit-list')
      if (nextScroller) { nextScroller.scrollTop = top; nextScroller.scrollLeft = left }
      if (key) [...this.list.querySelectorAll('[data-key]')].find(node => node.dataset.key === key)?.focus({ preventScroll: true })
    }
    for (const node of this.list.querySelectorAll('[data-unit]')) node.setAttribute('aria-current', node.dataset.unit === unitId ? 'true' : 'false')
  },
  render(s) {
    if (!this.root) return
    const unitId = A.route().params.unit || '', model = feedbackModel(s, { unitId, query: this.query, period: this.period })
    model.workspace = workspaceModel(s, model)
    const replace = (element, html) => {
      if (element.innerHTML === html) return
      const active = document.activeElement, key = element.contains?.(active) ? active?.dataset?.key : null
      element.innerHTML = html
      if (key) [...element.querySelectorAll('[data-key]')].find(node => node.dataset.key === key)?.focus({ preventScroll: true })
    }
    this.add.hidden = !A.can('operate')
    this.add.disabled = !model.available || !model.catalog.length || A.busyNow('leads') || Boolean(s.errors.leads) || model.selectedMissing || Boolean(model.selected && !model.selected.current)
    if (!s.loaded.leads) {
      replace(this.source, s.errors.leads ? A.html.banner('warn', 'Unit feedback could not be loaded. Refresh to try again.') : '')
      this.renderList(A.html.skeletonRows(3), '', true); replace(this.detail, A.html.skeletonRows(4)); return
    }
    replace(this.source, (s.errors.leads ? A.html.banner('warn', 'Unit feedback could not be refreshed. Showing the last loaded records; saving is unavailable until the connection returns.') : '') + sourceHtml(model) +
      (model.truncated ? A.html.banner('info', 'Showing the latest 500 saved entries. Counts and recurring reasons cover only these loaded records.') : ''))
    // Selection changes attributes only; the scroll container and pressed buttons keep their identity.
    this.renderList(model.available ? unitsHtml(model, '') : '', unitId, !model.available)
    replace(this.detail, model.available ? workspaceHtml(model, s) : '')
    if (this.selectedKey !== null && this.selectedKey !== unitId && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.detail.animate?.([{ opacity: .75, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' })
    }
    this.selectedKey = unitId
    if (this.focusSelected) {
      this.focusSelected = false
      const heading = this.detail.querySelector('.uw-hero h2')
      heading?.focus({ preventScroll: true })
      heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    }
    A.paintPermissions(this.root)
  },
}
A.register('units', view)
})()
