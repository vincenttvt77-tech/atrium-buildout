const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
const version = value => Number.isSafeInteger(value) && value > 0
const label = value => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const ROLES = ['owner', 'admin', 'staff', 'viewer']
const ROLE_LABELS = { owner: 'Owner', admin: 'Administrator', staff: 'Staff', viewer: 'Viewer' }
const ROLE_HELP = {
  owner: 'The highest administration role. Property access still follows the selection below.',
  admin: 'Can manage staff and viewers within their own property access. Cannot assign owner or administrator roles.',
  staff: 'Can operate the workspace within the selected property access.',
  viewer: 'Can read the workspace within the selected property access. Cannot make operational changes.',
}
const ERRORS = {
  mfa_required: 'Verify administrator access with your passkey before managing the team.',
  unauthenticated: 'Your sign-in ended. Sign in again to manage team access.',
  account_changed: 'The signed-in account changed. Reload Team or sign in again before continuing.',
  forbidden: 'Your authority to manage this team has changed. Reload Team to see your current access.',
  invalid_organization_form: 'This security form is no longer current. Reload Team before making a change.',
  invalid_input: 'This access change was not accepted. Refresh the member directory and review the current access.',
  version_conflict: 'This member’s access changed since you opened it. Refresh the directory and review the latest access.',
  last_owner: 'The organization must keep an active owner. Assign another owner before removing or reducing the last owner’s access.',
  administration_unavailable: 'Team management is temporarily unavailable. Try refreshing the directory.',
}
class Unconfirmed extends Error {}
class Rejected extends Error { constructor(code) { super(ERRORS[code] || 'The request was not accepted. Reload Team before continuing.'); this.code = code } }
function ids(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(entry => !id(entry)) || new Set(value).size !== value.length) throw new Unconfirmed()
  return [...value].sort()
}
function manifest(value) {
  if (!record(value) || !ROLES.includes(value.role) || !['active', 'revoked'].includes(value.status) || !['organization', 'properties'].includes(value.access)) throw new Unconfirmed()
  const propertyIds = ids(value.propertyIds)
  if (value.access === 'organization' && propertyIds.length) throw new Unconfirmed()
  return { role: value.role, status: value.status, access: value.access, propertyIds }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function publicDirectory(value, binding, organizationId) {
  if (!record(value) || value.action !== 'directory' || value.userId !== binding.userId || value.sessionId !== binding.sessionId
    || value.organizationId !== organizationId || typeof value.formToken !== 'string' || !value.formToken || value.formToken.length > 2048
    || !record(value.directory)) throw new Unconfirmed()
  const data = value.directory, org = data.organization, actor = data.actor
  if (!record(org) || org.id !== organizationId || !label(org.name) || !version(org.permissionVersion)
    || !record(actor) || actor.organizationId !== organizationId || actor.userId !== binding.userId || !id(actor.membershipId)
    || !version(actor.credentialVersion) || !['owner', 'admin'].includes(actor.role) || !['organization', 'properties'].includes(actor.access)
    || typeof actor.permissionVersion !== 'string' || !/^[a-f0-9]{64}$/.test(actor.permissionVersion)
    || !Array.isArray(data.properties) || data.properties.length > 1000 || !Array.isArray(data.members) || data.members.length > 50
    || !(data.nextCursor === null || id(data.nextCursor))) throw new Unconfirmed()
  const properties = data.properties.map(property => {
    if (!record(property) || !id(property.id) || !label(property.name) || !['active', 'inactive'].includes(property.status) || !version(property.permissionVersion)) throw new Unconfirmed()
    return { id: property.id, name: property.name, status: property.status, permissionVersion: property.permissionVersion }
  })
  if (new Set(properties.map(property => property.id)).size !== properties.length) throw new Unconfirmed()
  const activePropertyIds = new Set(properties.filter(property => property.status === 'active').map(property => property.id))
  const allowedPropertyIds = ids(actor.propertyIds)
  if (allowedPropertyIds.some(propertyId => !activePropertyIds.has(propertyId))) throw new Unconfirmed()
  const members = data.members.map(member => {
    if (!record(member) || !id(member.membershipId) || !id(member.userId) || !label(member.displayName)
      || typeof member.username !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(member.username)
      || !['active', 'inactive'].includes(member.userStatus) || !version(member.version) || typeof member.canManage !== 'boolean') throw new Unconfirmed()
    const access = manifest(member)
    if (access.propertyIds.some(propertyId => !properties.some(property => property.id === propertyId))) throw new Unconfirmed()
    return Object.freeze({ membershipId: member.membershipId, userId: member.userId, username: member.username, displayName: member.displayName,
      userStatus: member.userStatus, version: member.version, canManage: member.canManage, ...access })
  })
  if (new Set(members.map(member => member.membershipId)).size !== members.length || new Set(members.map(member => member.userId)).size !== members.length
    || data.nextCursor !== null && (!members.length || data.nextCursor !== members.at(-1).membershipId)) throw new Unconfirmed()
  return { organization: { id: org.id, name: org.name, permissionVersion: org.permissionVersion },
    formToken: value.formToken, actor: { organizationId, userId: actor.userId, membershipId: actor.membershipId, credentialVersion: actor.credentialVersion,
      role: actor.role, access: actor.access, propertyIds: allowedPropertyIds, permissionVersion: actor.permissionVersion }, properties, members, nextCursor: data.nextCursor }
}
function publicReceipt(value, binding, command, target) {
  if (!record(value) || value.action !== 'replace_member' || value.userId !== binding.userId || value.sessionId !== binding.sessionId
    || value.organizationId !== command.organizationId || !record(value.receipt)) throw new Unconfirmed()
  const receipt = value.receipt, desired = manifest(receipt)
  if (receipt.organizationId !== command.organizationId || receipt.membershipId !== command.membershipId || receipt.userId !== target.userId
    || receipt.requestId !== command.requestId || !version(receipt.version) || receipt.version !== command.expectedVersion + 1
    || typeof receipt.duplicate !== 'boolean' || typeof receipt.actorAccessChanged !== 'boolean'
    || !same(desired, manifest(command))) throw new Unconfirmed()
  return { organizationId: receipt.organizationId, membershipId: receipt.membershipId, userId: receipt.userId, version: receipt.version,
    requestId: receipt.requestId, duplicate: receipt.duplicate, actorAccessChanged: receipt.actorAccessChanged, ...desired }
}

/** Global staff identity, explicit organization selection; never a property cookie or client-issued authority. */
export function mountOrganizationClient() {
  const root = document.getElementById('team-root'), el = name => document.getElementById(name)
  const bootstrap = window.ATRIUM_TEAM
  let binding, organizations, organizationId, directory = null, selected = null, filter = '', mode = 'view', draft = null, pending = null
  let loading = false, busy = false, locked = false, stale = true, retired = false, generation = 0
  const controllers = new Set()
  const tell = (message, error = false) => { el('team-notice').textContent = message; el('team-notice').dataset.error = String(error) }
  function controls() {
    root.querySelectorAll('button, input, select').forEach(control => {
      const recoveryControl = control.dataset.action === 'retry-identical'
      control.disabled = retired || busy || (locked && !recoveryControl) || (loading && control.id !== 'team-organization')
        || (!recoveryControl && stale && (control.closest?.('#team-editor') || control.id === 'team-search'))
        || control.dataset.unavailable === 'true'
    })
    if (!organizations?.length) { el('team-organization').disabled = true; el('team-refresh').disabled = true }
  }
  function closeEditor() { mode = 'view'; draft = null; el('team-editor').innerHTML = '<div class="empty"><h2>Select a member</h2><p>Review current team access before making a change.</p></div>' }
  function retire(message, security = false) {
    locked = true; stale = true; generation++; directory = null; selected = null; closeEditor()
    el('team-members').innerHTML = ''; el('team-member-count').textContent = 'Current access must be checked again.'
    el('team-recovery').hidden = false
    el('team-recovery-content').innerHTML = `<h2>Check your access</h2><p>${esc(message)}</p><div class="actions">${security ? '<a class="back-link" href="/api/mfa">Verify administrator access</a>' : ''}<a class="back-link" href="/api/organizations">Reload Team</a><a class="back-link" href="/api/dashboard?reauthenticate=1">Sign in again</a></div>`
    tell(message, true); controls()
  }
  try {
    if (!record(bootstrap) || !id(bootstrap.userId) || !id(bootstrap.sessionId) || typeof bootstrap.formToken !== 'string' || !bootstrap.formToken
      || !Array.isArray(bootstrap.organizations) || bootstrap.organizations.length > 1000) throw new Unconfirmed()
    organizations = bootstrap.organizations.map(organization => {
      if (!record(organization) || !id(organization.id) || !label(organization.name)) throw new Unconfirmed()
      return Object.freeze({ id: organization.id, name: organization.name })
    })
    if (new Set(organizations.map(organization => organization.id)).size !== organizations.length) throw new Unconfirmed()
    binding = Object.freeze({ userId: bootstrap.userId, sessionId: bootstrap.sessionId, formToken: bootstrap.formToken })
    organizationId = organizations[0]?.id ?? null
  } catch { retire('This team page could not be verified. Reload Team or sign in again.'); return }
  const member = () => directory?.members.find(person => person.membershipId === selected) || null
  const shownProperties = propertyIds => propertyIds.map(propertyId => directory?.properties.find(property => property.id === propertyId)?.name || 'Property unavailable')
  const statusLabel = status => status === 'active' ? 'Active' : 'Access revoked'
  const scopeLabel = value => value.access === 'organization' ? 'All organization properties, including future properties'
    : value.propertyIds.length ? shownProperties(value.propertyIds).join(', ') : 'No property access'
  function summaryHtml(value) {
    return `<dl class="access-summary"><div><dt>Role</dt><dd>${esc(ROLE_LABELS[value.role])}</dd></div><div><dt>Membership</dt><dd>${esc(statusLabel(value.status))}</dd></div>` +
      `<div><dt>Property access</dt><dd>${esc(scopeLabel(value))}</dd></div></dl>`
  }
  function list() {
    if (!directory) return
    const query = filter.toLowerCase(), rows = directory.members.filter(person => [person.displayName, person.username].some(value => value.toLowerCase().includes(query)))
    const html = rows.length ? rows.map(person => `<button type="button" class="member-row" data-member="${esc(person.membershipId)}" data-key="member:${esc(person.membershipId)}" aria-controls="team-editor" aria-current="${person.membershipId === selected}"><strong>${esc(person.displayName)}${person.userId === binding.userId ? ' · You' : ''}</strong>` +
      `<span class="member-meta"><span>${esc(person.username)}</span><span class="badge ${person.status === 'revoked' ? 'revoked' : ''}">${esc(statusLabel(person.status))}</span><span>${esc(ROLE_LABELS[person.role])}</span></span><span class="member-scope">${esc(scopeLabel(person))}</span></button>`).join('')
      : `<div class="empty"><h3>${filter ? 'No members match this search' : 'No members in this directory'}</h3><p>${filter ? 'Search by name or username. Only loaded members are searched.' : 'Only the team members your authority permits you to view appear here.'}</p></div>`
    const host = el('team-members'), focused = host.contains(document.activeElement) ? document.activeElement?.dataset?.key : null
    if (host.innerHTML !== html) {
      const scroll = host.scrollTop; host.innerHTML = html; host.scrollTop = scroll
      if (focused) [...host.querySelectorAll('[data-key]')].find(control => control.dataset.key === focused)?.focus({ preventScroll: true })
    }
    el('team-member-count').textContent = `${directory.members.length} ${directory.members.length === 1 ? 'member' : 'members'} loaded${filter ? ` · ${rows.length} match` : ''}${directory.nextCursor ? ' · more available' : ''}.`
    let more = el('team-more')
    if (!more) {
      more = document.createElement('button'); more.id = 'team-more'; more.type = 'button'; more.className = 'secondary'; more.dataset.action = 'more'
      el('team-members').after(more)
    }
    more.textContent = 'Load more members'; more.hidden = !directory.nextCursor
    controls()
  }
  function editor(focus = false) {
    const person = member(), host = el('team-editor')
    if (!person) { closeEditor(); return }
    const heading = `<div class="editor-head"><span class="eyebrow">${esc(directory.organization.name)}</span><h2 id="team-selected-heading" tabindex="-1">${esc(person.displayName)}</h2><p>${esc(person.username)}${person.userId === binding.userId ? ' · Your membership' : ''}</p></div>`
    if (mode === 'view') {
      host.innerHTML = heading + summaryHtml(person) + `<p class="permission-help">${esc(ROLE_HELP[person.role])}</p>` +
        (person.userStatus === 'inactive' ? '<p class="review-warning">This person’s account is inactive. Organization membership changes cannot reactivate their global account.</p>' : '') +
        (person.canManage ? '<div class="actions form-actions"><button type="button" data-action="edit">Edit access</button></div>'
          : '<p class="hint">Your authority does not permit changes to this membership.</p>')
    } else if (mode === 'edit') {
      const roleOptions = directory.actor.role === 'owner' ? ROLES : ['staff', 'viewer']
      host.innerHTML = heading + `<form id="team-access-form" method="post" action="/api/organizations"><label for="team-role">Role</label><select id="team-role">${roleOptions.map(role => `<option value="${role}"${draft.role === role ? ' selected' : ''}>${ROLE_LABELS[role]}</option>`).join('')}</select>` +
        '<p id="team-role-help" class="permission-help"></p>' +
        `<label for="team-status">Membership status</label><select id="team-status"><option value="active"${draft.status === 'active' ? ' selected' : ''}${person.userStatus !== 'active' ? ' disabled' : ''}>Active</option><option value="revoked"${draft.status === 'revoked' ? ' selected' : ''}>Revoke access to this organization</option></select>` +
        `<label for="team-access">Property access</label><select id="team-access"><option value="properties"${draft.access === 'properties' ? ' selected' : ''}>Selected properties only</option>` +
        (directory.actor.access === 'organization' ? `<option value="organization"${draft.access === 'organization' ? ' selected' : ''}>All organization properties, including future properties</option>` : '') + '</select>' +
        `<fieldset id="team-property-field"><legend>Selected properties</legend><p class="hint">Choose only the properties this person should access. Selecting none removes property access.</p><div class="property-choices">${directory.properties.map(property => {
          const checked = draft.propertyIds.includes(property.id), allowed = property.status === 'active' && directory.actor.propertyIds.includes(property.id)
          return `<label class="check-row"><input type="checkbox" data-property="${esc(property.id)}"${checked ? ' checked' : ''}${!allowed && !checked ? ' disabled data-unavailable="true"' : ''}><span>${esc(property.name)}${!allowed ? ' · unavailable for new access' : ''}</span></label>`
        }).join('') || '<p class="hint">No delegable properties are available.</p>'}</div></fieldset>` +
        (person.userId === binding.userId ? '<p class="self-warning">You are changing your own membership. Reducing your role or access can remove your ability to manage this team or open properties.</p>' : '') +
        '<div class="actions form-actions"><button type="submit">Review access change</button><button type="button" class="secondary" data-action="close-editor">Keep unchanged</button></div></form>'
      renderFieldHelp()
    } else if (mode === 'review') {
      host.innerHTML = heading + '<span class="review-label">REVIEW BEFORE SAVING</span><h3>Confirm the full access change</h3><div class="comparison"><div><h3>Current access</h3>' + summaryHtml(person) + '</div><div><h3>After this change</h3>' + summaryHtml(draft) + '</div></div>' +
        (person.userId === binding.userId ? '<p class="review-warning">This changes your own access. You may need to reload Team or choose a different property afterward.</p>' : '') +
        '<p class="hint">This changes this organization’s membership only. No password, passkey, email invitation or other organization access will change.</p><div class="actions form-actions"><button type="button" data-action="save">Save access change</button><button type="button" class="secondary" data-action="back">Back to editing</button></div>'
    }
    controls()
    if (focus) {
      const title = el('team-selected-heading'); title?.focus({ preventScroll: true })
      if (matchMedia('(max-width: 800px)').matches) title?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
  }
  function renderFieldHelp() {
    el('team-role-help').textContent = ROLE_HELP[draft.role]
    el('team-property-field').hidden = draft.access === 'organization'
  }
  function updateDraft() {
    if (mode !== 'edit' || !draft || busy || locked) return
    draft = { role: el('team-role').value, status: el('team-status').value, access: el('team-access').value,
      propertyIds: [...root.querySelectorAll('[data-property]')].filter(control => control.checked).map(control => control.dataset.property).sort() }
    renderFieldHelp()
  }
  async function api(method, url, body, formToken) {
    const controller = new AbortController(); controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json', 'x-atrium-user-id': binding.userId, 'x-atrium-session-id': binding.sessionId,
          ...(method === 'POST' ? { 'content-type': 'application/json', 'x-atrium-organization-action': 'replace_member', 'x-atrium-csrf': formToken } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
      const value = await response.json()
      if (retired) throw new Unconfirmed()
      if (response.status !== 200) {
        if ([400, 401, 403, 409].includes(response.status) && record(value) && Object.hasOwn(ERRORS, value.code)) throw new Rejected(value.code)
        throw new Unconfirmed()
      }
      return value
    } catch (error) { if (error instanceof Rejected) throw error; throw new Unconfirmed() }
    finally { clearTimeout(timer); controllers.delete(controller) }
  }
  async function load(more = false) {
    if (busy || locked || retired || !organizationId || more && (loading || !directory?.nextCursor)) return
    const turn = ++generation, selectedOrganization = organizationId, cursor = more ? directory.nextCursor : null
    const focusMore = more && document.activeElement?.id === 'team-more'
    const previous = directory, previousSelected = member(), preserveEdit = more && mode !== 'view'
    loading = true; stale = true; tell(more ? 'Loading more members…' : 'Loading current team access…'); controls(); el('team-members').setAttribute('aria-busy', 'true')
    const query = new URLSearchParams({ format: 'json', organizationId: selectedOrganization, limit: '50' })
    if (cursor) query.set('beforeMembershipId', cursor)
    try {
      const next = publicDirectory(await api('GET', `/api/organizations?${query}`), binding, selectedOrganization)
      if (turn !== generation || retired) return
      if (more && (!same(next.organization, previous.organization) || !same(next.actor, previous.actor) || !same(next.properties, previous.properties)
        || next.nextCursor === cursor)) throw new Rejected('version_conflict')
      if (more) {
        const merged = new Map(previous.members.map(person => [person.membershipId, person]))
        for (const person of next.members) merged.set(person.membershipId, person)
        next.members = [...merged.values()]
      }
      directory = next; stale = false
      if (!directory.members.some(person => person.membershipId === selected)) selected = directory.members[0]?.membershipId ?? null
      if (!preserveEdit || previousSelected?.version !== member()?.version) { mode = 'view'; draft = null }
      list(); if (!preserveEdit || mode === 'view') editor()
      tell('Current team access loaded. Changes require a separate review and save.')
    } catch (error) {
      if (turn !== generation || retired) return
      stale = true
      if (error instanceof Rejected && ['mfa_required', 'unauthenticated', 'account_changed', 'forbidden', 'invalid_organization_form'].includes(error.code)) retire(error.message, error.code === 'mfa_required')
      else tell(error instanceof Rejected ? error.message : directory ? 'The directory could not be refreshed. These are the last loaded members; editing is paused until a successful refresh.' : 'The member directory could not be loaded. Refresh Team to try again.', true)
    } finally {
      if (turn === generation) {
        loading = false; el('team-members').setAttribute('aria-busy', 'false'); controls()
        if (focusMore && !directory?.nextCursor && !retired && !locked)
          [...el('team-members').querySelectorAll('[data-member]')].at(-1)?.focus({ preventScroll: true })
      }
    }
  }
  function review() {
    const person = member()
    if (busy || locked || stale || mode !== 'edit' || !person?.canManage) return
    updateDraft()
    try {
      const next = manifest({ ...draft, propertyIds: draft.access === 'organization' ? [] : draft.propertyIds })
      if (directory.actor.role !== 'owner' && !['staff', 'viewer'].includes(next.role)
        || next.access === 'organization' && directory.actor.access !== 'organization'
        || next.propertyIds.some(propertyId => !directory.actor.propertyIds.includes(propertyId))
        || next.status === 'active' && person.userStatus !== 'active') throw new Unconfirmed()
      if (same(next, manifest(person))) { tell('Choose a change before reviewing access.', true); return }
      draft = next; mode = 'review'; tell('Review the role, membership status and complete property access before saving.'); editor(true)
    } catch { tell('Choose a permitted role, membership status and property selection. Remove unavailable properties before saving.', true) }
  }
  function unknown() {
    locked = true; stale = true; mode = 'view'; draft = null; closeEditor()
    el('team-recovery').hidden = false
    el('team-recovery-content').innerHTML = '<h2>Access change unconfirmed</h2><p>The change may have been saved. Check or complete this exact request before making another change. This uses the same request reference and access selection.</p>' +
      `<div class="actions"><button type="button" data-action="retry-identical">Check this saved change</button><a class="back-link" href="/api/organizations">Reload current team access</a></div><p class="hint">Request reference: <code>${esc(pending.command.requestId)}</code></p>`
    tell('No saved result could be confirmed. No other access change will be sent from this page until this request is resolved.', true)
    el('team-recovery').focus(); controls()
  }
  async function save(retry = false) {
    if (busy || retired || (retry ? !locked || !pending : locked || stale || mode !== 'review' || !member()?.canManage)) return
    if (!retry) {
      const target = member()
      pending = Object.freeze({ target, formToken: directory.formToken, command: Object.freeze({ action: 'replace_member', organizationId, membershipId: target.membershipId,
        expectedVersion: target.version, status: draft.status, requestId: crypto.randomUUID(), role: draft.role, access: draft.access,
        propertyIds: Object.freeze([...draft.propertyIds]) }) })
    }
    const operation = pending, turn = generation
    busy = true; tell(retry ? 'Checking the original access change…' : 'Saving the reviewed access change…'); controls()
    try {
      const receipt = publicReceipt(await api('POST', '/api/organizations', operation.command, operation.formToken), binding, operation.command, operation.target)
      if (retired || turn !== generation) return
      pending = null; locked = false; el('team-recovery').hidden = true; mode = 'view'; draft = null
      if (receipt.actorAccessChanged || operation.target.userId === binding.userId) { retire('Your own administration access changed. Reload Team before viewing or changing another membership.'); return }
      // An idempotent receipt proves this request was recorded, not that no later edit exists.
      stale = true; busy = false; closeEditor()
      tell(receipt.duplicate ? 'The original access change was already recorded. Checking the current directory…' : 'Access change recorded. Checking the current directory…')
      await load()
      if (!retired && !locked && !stale) tell('Access change recorded. The member directory now shows the latest saved access.')
    } catch (error) {
      if (retired || turn !== generation) return
      if (error instanceof Rejected) {
        pending = null; locked = false; stale = true; closeEditor(); el('team-recovery').hidden = true
        const message = error.message + (retry ? ' The earlier change is still unconfirmed; check current access after reloading.' : '')
        if (['mfa_required', 'unauthenticated', 'account_changed', 'forbidden', 'invalid_organization_form'].includes(error.code)) retire(message, error.code === 'mfa_required')
        else tell(message + ' Refresh the directory before another change.', true)
      } else unknown()
    } finally { busy = false; controls() }
  }
  root.addEventListener('click', event => {
    const control = event.target.closest('button')
    if (!control || !root.contains(control) || control.disabled || retired || busy) return
    const action = control.dataset.action
    if (action === 'retry-identical') return save(true)
    if (locked) return
    if (control.id === 'team-refresh') return load()
    if (action === 'more') return load(true)
    if (control.dataset.member) {
      if (stale || !directory?.members.some(person => person.membershipId === control.dataset.member)) return
      selected = control.dataset.member; mode = 'view'; draft = null
      for (const button of el('team-members').querySelectorAll('[data-member]')) button.setAttribute('aria-current', String(button.dataset.member === selected))
      editor(true); return
    }
    if (stale) return
    if (action === 'edit' && member()?.canManage) { mode = 'edit'; draft = manifest(member()); editor(true) }
    if (action === 'close-editor') { mode = 'view'; draft = null; editor(true) }
    if (action === 'back') { mode = 'edit'; editor(true) }
    if (action === 'save') return save()
  })
  root.addEventListener('submit', event => { if (event.target.id === 'team-access-form') { event.preventDefault(); review() } })
  root.addEventListener('change', event => {
    if (event.target.id === 'team-organization') {
      if (busy || locked || retired || !organizations.some(organization => organization.id === event.target.value)) return
      organizationId = event.target.value; directory = null; selected = null; filter = ''; el('team-search').value = ''; closeEditor()
      el('team-members').innerHTML = '<div class="empty"><h3>Loading this organization’s team…</h3></div>'; load(); return
    }
    if (mode === 'edit') updateDraft()
  })
  root.addEventListener('input', event => { if (event.target.id === 'team-search' && !locked && !stale && !busy) { filter = event.target.value.slice(0, 200); list() } })
  window.addEventListener('pagehide', () => {
    retired = true; generation++; pending = null
    for (const controller of controllers) controller.abort()
    closeEditor(); el('team-members').innerHTML = ''; el('team-recovery-content').innerHTML = ''; controls()
  })
  // A browser history snapshot cannot reauthorize a retired administration page.
  window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload() })
  el('team-organization').innerHTML = organizations.map(organization => `<option value="${esc(organization.id)}">${esc(organization.name)}</option>`).join('')
  if (!organizations.length) {
    el('team-organization').innerHTML = '<option>No organizations to manage</option>'
    el('team-members').innerHTML = '<div class="empty"><h3>No organization administration access</h3><p>You can still manage your own account security.</p></div>'
    el('team-member-count').textContent = 'No organization directory was requested.'; el('team-members').setAttribute('aria-busy', 'false')
    tell('Only organizations where your current role permits team administration appear here.'); controls()
  } else load()
}
if (typeof window !== 'undefined' && window.ATRIUM_TEAM) mountOrganizationClient()
