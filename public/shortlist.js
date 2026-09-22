/* Public Larkin demo links contain only residence IDs, never prospect information. */
(function (root) {
  'use strict';
  const limit = 5;
  const prefix = '#availability?units=';
  const validId = (id) => typeof id === 'string' && /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(id);
  const published = (units) => units.filter((u) => u.status === 'available' || u.status === 'pending');

  function read(hash, units) {
    const none = { active: false, ids: [], missing: 0, invalid: false };
    if (!hash.startsWith('#availability?')) return none;
    const bad = { ...none, active: true, invalid: true };
    if (!hash.startsWith(prefix) || hash.length > 350) return bad;
    let ids;
    try { ids = decodeURIComponent(hash.slice(prefix.length)).split(',').map((id) => id.toUpperCase()); }
    catch { return bad; }
    if (!ids.length || ids.length > limit || ids.some((id) => !validId(id))) return bad;
    ids = [...new Set(ids)];
    const board = new Set(published(units).map((u) => u.unitId));
    return { active: true, ids: ids.filter((id) => board.has(id)), missing: ids.filter((id) => !board.has(id)).length, invalid: false };
  }

  function link(origin, ids, units) {
    const board = new Set(published(units).map((u) => u.unitId));
    if (!ids.length || ids.length > limit || new Set(ids).size !== ids.length || ids.some((id) => !validId(id) || !board.has(id))) return '';
    const url = new URL('/', origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = ''; url.password = ''; url.search = '';
    url.hash = prefix + encodeURIComponent(ids.join(','));
    return url.href;
  }

  root.AtriumShortlist = Object.freeze({ limit, published, read, link });
})(globalThis);
