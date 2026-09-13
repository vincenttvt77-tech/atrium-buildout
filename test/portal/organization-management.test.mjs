import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { renderOrganizationPage } from '../../src/auth/organization-page.ts'

const source = (await readFile(new URL('../../src/auth/organization-client.js', import.meta.url), 'utf8'))
  .replace('export function mountOrganizationClient()', 'function mountOrganizationClient()')
  .replace("root.addEventListener('click', event => {", "window.teamClientTest = { load, review, save, state: () => ({ directory, selected, mode, draft, pending, loading, busy, locked, stale, generation }) }; root.addEventListener('click', event => {")
const plain = value => JSON.parse(JSON.stringify(value))
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const reply = (body, status = 200) => ({ status, json: async () => body })
const person = (overrides = {}) => ({ membershipId: 'member-staff', userId: 'user-staff', username: 'staff.one', displayName: 'Morgan',
  userStatus: 'active', role: 'staff', status: 'active', access: 'properties', propertyIds: ['property-one'], version: 4, canManage: true, ...overrides })
function fixture({ organizations = [{ id: 'org-one', name: 'Lake Group' }], members = [person()], actor = {}, mobile = false, reducedMotion = false, initial } = {}) {
  const nodes = new Map(), anonymous = new Set(), events = new Map(), lifecycle = new Map(), timers = new Map(), requests = []
  const bootstrap = { userId: 'user-owner', sessionId: randomUUID(), formToken: 'DIRECTORY_ONLY_TOKEN', organizations }
  let nextTimer = 0, reloads = 0, transport = initial || (() => reply(directory()))
  const document = { activeElement: null, getElementById: id => node(id), createElement: () => node(`new-${nodes.size}`) }
  const node = id => {
    if (!nodes.has(id)) {
      let html = '', children = []
      const value = { id, hidden: false, disabled: false, checked: false, value: '', dataset: {}, textContent: '', scrollTop: 0, isConnected: true, attributes: {}, owner: null,
        focus() { document.activeElement = value }, scrollIntoView(options) { value.scrolled = options },
        setAttribute(key, entry) { value.attributes[key] = entry }, getAttribute(key) { return value.attributes[key] },
        addEventListener: (type, callback) => events.set(type, callback), after() {}, contains: target => target === value || children.includes(target),
        closest: selector => selector === '#team-editor' && value.owner === 'team-editor' ? node('team-editor') : null,
        querySelectorAll(selector) {
          const candidates = id === 'team-root' ? [...nodes.values(), ...anonymous] : children
          if (selector === 'button, input, select') return candidates.filter(control => control.control)
          if (selector === '[data-property]') return candidates.filter(control => control.dataset.property)
          if (selector === '[data-member]') return candidates.filter(control => control.dataset.member)
          if (selector === '[data-key]') return candidates.filter(control => control.dataset.key)
          return []
        },
        get innerHTML() { return html }, set innerHTML(content) {
          html = content
          for (const child of children) { child.isConnected = false; anonymous.delete(child) }
          children = []
          for (const [, tag, attributes, body] of content.matchAll(/<(input|select|button|h2|p)\b([^>]*)(?:>([\s\S]*?)<\/\1>|\/?\s*>)/g)) {
            const attrs = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, entry]) => [key, entry]))
            const control = attrs.id ? node(attrs.id) : { dataset: {}, attributes: {}, focus() { document.activeElement = control }, setAttribute(key, val) { control.attributes[key] = val }, getAttribute: key => control.attributes[key] }
            control.isConnected = true; control.owner = id; control.control = ['input', 'select', 'button'].includes(tag)
            control.disabled = /\bdisabled\b/.test(attributes); control.checked = /\bchecked\b/.test(attributes)
            control.value = attrs.value || (tag === 'select' ? /<option\b[^>]*value="([^"]*)"[^>]*\bselected\b/.exec(body || '')?.[1] || /<option\b[^>]*value="([^"]*)"/.exec(body || '')?.[1] || '' : '')
            for (const [key, entry] of Object.entries(attrs)) if (key.startsWith('data-')) control.dataset[key.slice(5)] = entry
            control.closest = selector => selector === 'button' && tag === 'button' ? control : selector === '#team-editor' && id === 'team-editor' ? node('team-editor') : null
            children.push(control); if (!attrs.id) anonymous.add(control)
          }
        },
      }
      nodes.set(id, value)
    }
    return nodes.get(id)
  }
  // Existing static HTML controls; the real client attaches listeners before rendering editable forms.
  for (const id of ['team-organization', 'team-refresh', 'team-search', 'team-more']) node(id).control = true
  node('team-more').dataset.action = 'more'
  node('team-root').contains = () => true
  const window = { ATRIUM_TEAM: structuredClone(bootstrap), location: { reload() { reloads++ } }, addEventListener: (event, callback) => lifecycle.set(event, callback) }
  function directory(overrides = {}, organizationId = organizations[0]?.id || 'org-one') {
    return { action: 'directory', userId: bootstrap.userId, sessionId: bootstrap.sessionId, organizationId, formToken: `ORG_TOKEN_${organizationId}`,
      directory: { organization: { id: organizationId, name: organizations.find(org => org.id === organizationId)?.name || 'Group', permissionVersion: 2 },
        actor: { organizationId, userId: bootstrap.userId, membershipId: 'owner-member', credentialVersion: 1, role: 'owner', access: 'organization',
          propertyIds: ['property-one', 'property-two'], permissionVersion: 'a'.repeat(64), ...actor },
        properties: [{ id: 'property-one', name: 'Lake House', status: 'active', permissionVersion: 1 }, { id: 'property-two', name: 'Park House', status: 'active', permissionVersion: 1 }],
        members: structuredClone(members), nextCursor: null, ...overrides } }
  }
  function receipt(request, overrides = {}) {
    const command = request.payload
    return reply({ action: 'replace_member', userId: bootstrap.userId, sessionId: bootstrap.sessionId, organizationId: command.organizationId,
      receipt: { organizationId: command.organizationId, membershipId: command.membershipId, userId: members.find(entry => entry.membershipId === command.membershipId)?.userId,
        version: command.expectedVersion + 1, requestId: command.requestId, duplicate: false, actorAccessChanged: false,
        role: command.role, status: command.status, access: command.access, propertyIds: command.propertyIds, ...overrides } })
  }
  const context = { window, document, Date, AbortController, URLSearchParams, Object, console, crypto: { randomUUID },
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? reducedMotion : mobile }),
    setTimeout(fn, delay) { const timer = ++nextTimer; timers.set(timer, { fn, delay }); return timer }, clearTimeout(timer) { timers.delete(timer) },
    fetch: async (path, options) => { const request = { path, ...options, payload: options.body ? JSON.parse(options.body) : null }; requests.push(request); return transport(request) } }
  runInNewContext(source, context)
  const f = { window, document, nodes, events, lifecycle, requests, node, bootstrap, directory, receipt, context,
    helpers: window.teamClientTest, setTransport(fn) { transport = fn },
    async click(action, extra = {}) { const control = { id: '', disabled: false, dataset: { action }, ...extra }; return events.get('click')({ target: { closest: () => control } }) },
    async change(id, value) { const control = node(id); control.value = value; events.get('change')({ target: control }); await flush() },
    submit() { events.get('submit')({ target: { id: 'team-access-form' }, preventDefault() {} }) },
    async edit(role = 'viewer') { await flush(); await f.click('edit'); await f.change('team-role', role); f.submit() },
    expire() { for (const [id, timer] of timers) if (timer.delay === 15000) { timers.delete(id); timer.fn() } },
    hide() { lifecycle.get('pagehide')() },
    show(persisted) { lifecycle.get('pageshow')({ persisted }) }, reloads: () => reloads,
  }
  return f
}

test('page projects only organization identity, escapes labels and is safe without JavaScript', () => {
  const html = renderOrganizationPage({ principal: { userId: 'user', sessionId: randomUUID(), displayName: '<Owner>', username: 'owner' },
    formToken: 'synthetic', nonce: 'nonce', organizations: [{ id: 'org-one', name: '</script><script>unsafe()</script>', passwordHash: 'NO_CREDENTIAL' }] }, '/* client */')
  assert.match(html, /&lt;Owner&gt;/); assert.doesNotMatch(html, /<script>unsafe|NO_CREDENTIAL/)
  assert.match(html, /id="team-organization" disabled/); assert.match(html, /id="team-refresh"[^>]*disabled/)
  assert.doesNotMatch(html, /name="password"|Invite member|Create account|Reset password/)
  assert.match(html, /min-height:48px/); assert.match(html, /prefers-reduced-motion:reduce/)
})

test('directory has exact user/session binding and its organization token is the only mutation token', async () => {
  const f = fixture(); await f.edit()
  assert.equal(f.helpers.state().mode, 'review')
  assert.equal(f.requests.length, 1, 'Review is local and sends no access change')
  let request
  f.setTransport(entry => { if (entry.method === 'GET') return reply(f.directory({ members: [person({ role: 'viewer', version: 5 })] })); request = entry; return f.receipt(entry) })
  f.window.ATRIUM_TEAM.userId = 'tampered'; f.window.ATRIUM_TEAM.formToken = 'tampered'
  await f.click('save')
  assert.equal(request.headers['x-atrium-user-id'], 'user-owner'); assert.equal(request.headers['x-atrium-session-id'], f.bootstrap.sessionId)
  assert.equal(request.headers['x-atrium-organization-action'], 'replace_member')
  assert.equal(request.headers['x-atrium-csrf'], 'ORG_TOKEN_org-one'); assert.notEqual(request.headers['x-atrium-csrf'], f.bootstrap.formToken)
  assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'same-origin')
  assert.deepEqual(Object.keys(request.payload).sort(), ['action', 'organizationId', 'membershipId', 'expectedVersion', 'status', 'requestId', 'role', 'access', 'propertyIds'].sort())
  assert.equal(request.payload.expectedVersion, 4); assert.equal(request.payload.role, 'viewer')
  assert.deepEqual(request.payload.propertyIds, ['property-one'])
  assert.match(f.node('team-notice').textContent, /latest saved access/)
})

test('limited administrator cannot choose owner/admin or organization-wide access and unmanageable rows stay read only', async () => {
  const f = fixture({ actor: { role: 'admin', access: 'properties', propertyIds: ['property-one'] } }); await flush(); await f.click('edit')
  assert.doesNotMatch(f.node('team-editor').innerHTML, /value="owner"|value="admin"|value="organization"/)
  await f.change('team-role', 'owner'); f.submit()
  assert.equal(f.helpers.state().mode, 'edit'); assert.equal(f.requests.length, 1)
  const readOnly = fixture({ members: [person({ canManage: false })] }); await flush()
  assert.doesNotMatch(readOnly.node('team-editor').innerHTML, /data-action="edit"/)
  await readOnly.click('edit'); assert.equal(readOnly.helpers.state().mode, 'view')
})

test('review describes the complete before/after manifest including an explicit no-property choice', async () => {
  const f = fixture(); await flush(); await f.click('edit')
  for (const input of f.node('team-root').querySelectorAll('[data-property]')) input.checked = false
  await f.change('team-status', 'revoked'); f.submit()
  assert.equal(f.helpers.state().mode, 'review')
  assert.match(f.node('team-editor').innerHTML, /Current access|After this change|No property access|Access revoked/)
  assert.deepEqual(plain(f.helpers.state().draft.propertyIds), [])
  assert.equal(f.requests.length, 1)
})

test('malformed successful response freezes one exact command and explicit retry uses its original token and reference', async () => {
  const f = fixture(); await f.edit()
  f.setTransport(() => reply({ action: 'replace_member', receipt: null }))
  await f.click('save')
  assert.equal(f.helpers.state().locked, true); assert.match(f.node('team-recovery-content').innerHTML, /Access change unconfirmed/)
  const original = f.requests.at(-1); await f.click('edit'); await f.click('save')
  assert.equal(f.requests.length, 2)
  f.setTransport(request => request.method === 'POST' ? f.receipt(request, { duplicate: true }) : reply(f.directory({ members: [person({ role: 'admin', version: 7 })] })))
  await f.click('retry-identical')
  const retry = f.requests.findLast(entry => entry.method === 'POST')
  assert.equal(retry.body, original.body); assert.equal(retry.headers['x-atrium-csrf'], original.headers['x-atrium-csrf'])
  assert.equal(f.helpers.state().directory.members[0].role, 'admin', 'Later directory state must win over an older duplicate receipt')
  assert.equal(f.helpers.state().locked, false)
})

test('wrong member, manifest, version, organization or session receipts never claim saved access', async () => {
  for (const mutate of [body => { body.receipt.membershipId = 'other' }, body => { body.receipt.propertyIds = [] },
    body => { body.receipt.version = 50 }, body => { body.organizationId = 'other' }, body => { body.sessionId = randomUUID() }]) {
    const f = fixture(); await f.edit()
    f.setTransport(async request => { const body = await f.receipt(request).json(); mutate(body); return reply(body) })
    await f.click('save')
    assert.equal(f.helpers.state().locked, true)
    assert.doesNotMatch(f.node('team-notice').textContent, /Access change recorded/)
  }
})

test('a lost response never creates a fresh request and a duplicate click sends only one mutation', async () => {
  const f = fixture(); await f.edit(); const pending = deferred()
  f.setTransport(request => new Promise((resolve, reject) => { pending.promise.then(resolve); request.signal.addEventListener('abort', () => reject(new Error('aborted'))) }))
  const saving = f.click('save'); await f.click('save')
  assert.equal(f.requests.length, 2)
  f.expire(); await saving
  assert.equal(f.helpers.state().locked, true); assert.equal(f.helpers.state().busy, false)
  assert.match(f.node('team-notice').textContent, /No saved result could be confirmed/)
})

test('actor access change retires the directory instead of leaving privileged edit controls', async () => {
  const self = person({ membershipId: 'owner-member', userId: 'user-owner', username: 'owner.one', role: 'owner' })
  const f = fixture({ members: [self] }); await f.edit('staff')
  assert.match(f.node('team-editor').innerHTML, /changes your own access/)
  f.setTransport(request => f.receipt(request, { actorAccessChanged: true })); await f.click('save')
  assert.equal(f.helpers.state().locked, true); assert.equal(f.helpers.state().directory, null)
  assert.match(f.node('team-recovery-content').innerHTML, /own administration access changed/)
  assert.equal(f.requests.length, 2, 'No post-change directory lookup using obsolete authority')
})

test('MFA expiry clears stale member data and gives a direct administrator verification path', async () => {
  const f = fixture(); await f.edit()
  f.setTransport(() => reply({ code: 'mfa_required', error: 'Verify' }, 403)); await f.click('save')
  assert.equal(f.helpers.state().directory, null)
  assert.match(f.node('team-recovery-content').innerHTML, /href="\/api\/mfa"/)
  assert.match(f.node('team-recovery-content').innerHTML, /Verify administrator access/)
  await f.click('retry-identical'); assert.equal(f.requests.length, 2)
})

test('organization changes discard draft and ignore delayed directory/token from the previous selection', async () => {
  const pending = deferred(), f = fixture({ organizations: [{ id: 'org-one', name: 'One' }, { id: 'org-two', name: 'Two' }], initial: () => pending.promise })
  f.setTransport(() => reply(f.directory({ members: [person({ displayName: 'Second org member' })] }, 'org-two')))
  await f.change('team-organization', 'org-two')
  pending.resolve(reply(f.directory({ members: [person({ displayName: 'Wrong late member' })] }, 'org-one'))); await flush()
  assert.equal(f.helpers.state().directory.organization.id, 'org-two')
  assert.equal(f.helpers.state().directory.formToken, 'ORG_TOKEN_org-two')
  assert.doesNotMatch(f.node('team-members').innerHTML, /Wrong late member/)
  await f.click('edit'); await f.change('team-role', 'viewer'); f.submit()
  f.setTransport(request => request.method === 'POST' ? f.receipt(request) : reply(f.directory({}, 'org-two')))
  await f.click('save')
  assert.equal(f.requests.find(entry => entry.method === 'POST').headers['x-atrium-csrf'], 'ORG_TOKEN_org-two')
})

test('paging retains selection/scroll and refuses a mixed authority snapshot', async () => {
  const f = fixture(); await flush()
  f.setTransport(() => reply(f.directory({ nextCursor: 'member-staff' }))); await f.helpers.load()
  f.node('team-members').scrollTop = 280
  f.setTransport(() => reply(f.directory({ members: [person({ membershipId: 'member-two', userId: 'user-two', displayName: 'Second' })] })))
  await f.helpers.load(true)
  assert.equal(f.helpers.state().directory.members.length, 2); assert.equal(f.helpers.state().selected, 'member-staff')
  assert.equal(f.node('team-members').scrollTop, 280)
  assert.match(f.requests.at(-1).path, /beforeMembershipId=member-staff/)
  f.setTransport(() => reply(f.directory({ nextCursor: 'member-staff' }))); await f.helpers.load()
  f.setTransport(() => reply(f.directory({ actor: { ...f.directory().directory.actor, permissionVersion: 'b'.repeat(64) } })))
  await f.helpers.load(true)
  assert.equal(f.helpers.state().stale, true); assert.equal(f.helpers.state().directory.members.length, 1)
})

test('last-owner and stale-version refusals require a refreshed directory and never reuse a new command automatically', async () => {
  for (const code of ['last_owner', 'version_conflict']) {
    const f = fixture(); await f.edit(); f.setTransport(() => reply({ code, error: 'Not accepted' }, 409))
    await f.click('save')
    assert.equal(f.helpers.state().pending, null); assert.equal(f.helpers.state().stale, true)
    assert.match(f.node('team-notice').textContent, /Refresh the directory/)
    await f.click('edit'); assert.equal(f.requests.length, 2)
  }
})

test('mobile selection preserves list position and moves to a readable detail with reduced motion', async () => {
  const f = fixture({ members: [person(), person({ membershipId: 'second', userId: 'second-user', username: 'second.user', displayName: 'Second' })], mobile: true, reducedMotion: true }); await flush()
  f.node('team-members').scrollTop = 210
  await f.click(undefined, { dataset: { member: 'second' } })
  assert.equal(f.node('team-members').scrollTop, 210); assert.equal(f.helpers.state().selected, 'second')
  assert.equal(f.document.activeElement.id, 'team-selected-heading')
  assert.deepEqual(plain(f.document.activeElement.scrolled), { block: 'start', behavior: 'auto' })
})

test('retiring the page aborts the request and never repaints a late reply', async () => {
  const pending = deferred(), f = fixture({ initial: () => pending.promise })
  f.hide(); assert.equal(f.requests[0].signal.aborted, true)
  pending.resolve(reply(f.directory())); await flush()
  assert.equal(f.node('team-members').innerHTML, '')
  assert.equal(f.helpers.state().directory, null)
})

test('no administration organizations yields a genuine empty state and no global directory request', async () => {
  const f = fixture({ organizations: [] }); await flush()
  assert.equal(f.requests.length, 0)
  assert.match(f.node('team-members').innerHTML, /No organization administration access/)
  assert.equal(f.node('team-organization').disabled, true)
})

test('restoring a retired page from browser history requests a fresh server page instead of restoring cached authority', async () => {
  const f = fixture(); await flush(); f.show(false)
  assert.equal(f.reloads(), 0)
  f.hide(); f.show(true)
  assert.equal(f.reloads(), 1)
  assert.equal(f.node('team-members').innerHTML, '')
  await f.click('edit'); await f.click('save')
  assert.equal(f.requests.length, 1, 'The retired instance cannot make a new administration request')
})

test('retained inactive-property metadata keeps a limited owner’s self row readable without granting it', async () => {
  const self = person({ membershipId: 'owner-member', userId: 'user-owner', username: 'owner.one', role: 'owner', propertyIds: ['property-one', 'property-retired'], canManage: false })
  const f = fixture({ members: [self], actor: { access: 'properties', propertyIds: ['property-one'] } })
  f.setTransport(() => reply(f.directory({ properties: [f.directory().directory.properties[0], { id: 'property-retired', name: 'Prior Building', status: 'inactive', permissionVersion: 3 }] })))
  await flush(); await f.helpers.load()
  assert.equal(f.helpers.state().stale, false)
  assert.match(f.node('team-editor').innerHTML, /Prior Building/)
  assert.doesNotMatch(f.node('team-editor').innerHTML, /data-action="edit"/)
  assert.deepEqual(plain(f.helpers.state().directory.actor.propertyIds), ['property-one'])
})

test('account replacement retires stale content and an uncertain prior save remains unconfirmed', async () => {
  const read = fixture(); await flush()
  read.setTransport(() => reply({ code: 'account_changed', error: 'Changed' }, 409)); await read.helpers.load()
  assert.equal(read.helpers.state().directory, null)
  assert.match(read.node('team-recovery-content').innerHTML, /signed-in account changed/)
  const write = fixture(); await write.edit()
  write.setTransport(() => reply({ receipt: null })); await write.click('save')
  write.setTransport(() => reply({ code: 'account_changed', error: 'Changed' }, 409)); await write.click('retry-identical')
  assert.equal(write.helpers.state().pending, null)
  assert.match(write.node('team-recovery-content').innerHTML, /earlier change is still unconfirmed/)
  assert.doesNotMatch(write.node('team-recovery-content').innerHTML, /retry-identical/)
})

test('the final keyboard Load more focuses the last appended member and preserves directory scroll', async () => {
  const f = fixture(); await flush()
  f.setTransport(() => reply(f.directory({ nextCursor: 'member-staff' }))); await f.helpers.load()
  f.node('team-members').scrollTop = 240; f.node('team-more').focus()
  f.setTransport(() => reply(f.directory({ members: [person({ membershipId: 'member-final', userId: 'final-user', username: 'final.user' })] })))
  await f.helpers.load(true)
  assert.equal(f.node('team-more').hidden, true)
  assert.equal(f.document.activeElement.dataset.member, 'member-final')
  assert.equal(f.node('team-members').scrollTop, 240)
})
