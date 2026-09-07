/* =============================================================
   The Larkin — site behaviour
   Vanilla JS, no dependencies, no build step.
   Inventory and floor plan data are inlined from
   /data/inventory.json and /data/floorplans.json so the page
   works as a static file with no fetch.
   ============================================================= */
'use strict';

const PHONE_DISPLAY = '+1 (516) 990-9252';
const PHONE_HREF = 'tel:+15169909252';

/* ── Data ───────────────────────────────────────────────────── */
const FLOORPLANS = [
  {"id":"S1","name":"Studio","bedrooms":0,"bathrooms":1,"sqft":496,"sqftMin":468,"sqftMax":532,"collection":null,"lines":["F","G"],"floorRange":"5-27","startingRent":3255,"description":"One room with the glass on the long wall, so the bed and the sofa both face out. The kitchen runs along one side with a full-size Bosch range and a vented hood, and the washer and dryer sit behind a door off the entry. Ceilings are 9 feet 4 inches.","features":["Floor-to-ceiling windows with solar shades","7-inch white oak plank flooring","Quartz counters and full-height backsplash","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in residence","Custom-fitted closet","Keyless entry and zoned heating and cooling","Ceilings 9 feet 4 inches"]},
  {"id":"S2","name":"Alcove Studio","bedrooms":0,"bathrooms":1,"sqft":578,"sqftMin":560,"sqftMax":605,"collection":null,"lines":["K"],"floorRange":"5-27","startingRent":3165,"description":"The alcove sits off the main room, deep enough for a queen bed and a nightstand and squared off so a curtain or a bookcase actually closes it. The rest reads as one room, kitchen along the wall and living area at the window. You get 80 more square feet than the S1 and a place to put the bed.","features":["Sleeping alcove, 11 by 9 feet","Floor-to-ceiling windows with solar shades","7-inch white oak plank flooring","Two-tone cabinetry with under-cabinet lighting","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in residence","Honed porcelain bath with a niche","Ceilings 9 feet 4 inches"]},
  {"id":"A1","name":"One Bedroom","bedrooms":1,"bathrooms":1,"sqft":688,"sqftMin":640,"sqftMax":735,"collection":null,"lines":["C","E"],"floorRange":"5-27","startingRent":4475,"description":"The bedroom takes its own window wall and closes with a door. The living room keeps its glass, and the kitchen turns into the room with a peninsula that seats two. The C line faces west, which puts the Midtown skyline over Gantry Plaza State Park.","features":["Separate bedroom with a door and a fitted closet","Kitchen peninsula seating two","Floor-to-ceiling windows, blackout shades in the bedroom","7-inch white oak plank flooring","Quartz counters and full-height backsplash","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in residence","Ceilings 9 feet 4 inches"]},
  {"id":"A2","name":"One Bedroom with Balcony","bedrooms":1,"bathrooms":1,"sqft":731,"sqftMin":690,"sqftMax":760,"collection":null,"lines":["H"],"floorRange":"5-27","startingRent":5070,"description":"The A1 layout with a balcony off the living room, 45 to 70 square feet, deep enough for two chairs and a small table. The H line faces north, which puts the Queensboro Bridge and Roosevelt Island in the frame. The balcony door is a full-height slider, not a window.","features":["Private balcony, 45 to 70 square feet","Full-height slider to the balcony","Separate bedroom with a door and a fitted closet","Floor-to-ceiling windows, blackout shades in the bedroom","7-inch white oak plank flooring","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in residence","Ceilings 9 feet 4 inches"]},
  {"id":"A3","name":"One Bedroom and Den","bedrooms":1,"bathrooms":1.5,"sqft":848,"sqftMin":810,"sqftMax":880,"collection":null,"lines":["J"],"floorRange":"5-27","startingRent":4585,"description":"The den sits between the entry and the living room, with a door and a half bath beside it. It works as an office most days and a guest room when someone visits; it has no window, which is why it is a den and not a second bedroom. The bedroom and the living room both take the window wall.","features":["Windowless den with a door, 9 by 8 feet","Half bath off the entry","Separate bedroom with a fitted walk-in closet","Floor-to-ceiling windows, blackout shades in the bedroom","7-inch white oak plank flooring","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in residence","Ceilings 9 feet 4 inches"]},
  {"id":"B1","name":"Two Bedroom","bedrooms":2,"bathrooms":2,"sqft":1012,"sqftMin":940,"sqftMax":1085,"collection":null,"lines":["B","L"],"floorRange":"5-27","startingRent":5875,"description":"Bedrooms at opposite ends of the plan with the living room between them, so no one shares a wall. Both bedrooms have their own bath and a fitted closet, and the kitchen opens to the dining area with an island that seats three. The L line is a corner, north and east, and takes the Queensboro Bridge.","features":["Split bedrooms, no shared wall","Two full baths, both en suite","Kitchen island seating three","Floor-to-ceiling windows, blackout shades in both bedrooms","7-inch white oak plank flooring","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in a dedicated closet","Ceilings 9 feet 4 inches"]},
  {"id":"B2","name":"Two Bedroom with Balcony","bedrooms":2,"bathrooms":2,"sqft":1046,"sqftMin":985,"sqftMax":1120,"collection":null,"lines":["D"],"floorRange":"5-27","startingRent":7140,"description":"The split-bedroom two bedroom with a balcony off the living room, 60 to 95 square feet. The D line is a corner and holds two exposures, west and south, so the living room takes the skyline and the light stays in the room until it goes down. Both baths are en suite and the laundry is its own closet.","features":["Private balcony, 60 to 95 square feet","Corner residence, two exposures","Split bedrooms, both baths en suite","Kitchen island seating three","Floor-to-ceiling windows, blackout shades in both bedrooms","7-inch white oak plank flooring","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in a dedicated closet"]},
  {"id":"B3","name":"Two Bedroom, West Collection","bedrooms":2,"bathrooms":2,"sqft":1148,"sqftMin":1090,"sqftMax":1190,"collection":"West Collection","lines":["B","C","D"],"floorRange":"28-33","startingRent":9580,"description":"The West Collection two bedroom sits on 28 through 33, above the setback. Ceilings are 10 feet 6 inches, the island is quartzite with a waterfall edge, and the kitchen carries Fisher & Paykel panel-ready refrigeration and a wine column. The D line here opens to a private terrace of 90 to 240 square feet.","features":["Ceilings 10 feet 6 inches","Quartzite waterfall island with integrated under-edge lighting","Fisher & Paykel panel-ready refrigeration and a wine column","Private terrace, 90 to 240 square feet, on the D line","West exposure, floor-to-ceiling glass","Split bedrooms, both baths en suite","7-inch white oak plank flooring","Bosch washer and vented dryer in a dedicated closet"]},
  {"id":"C1","name":"Three Bedroom","bedrooms":3,"bathrooms":2,"sqft":1332,"sqftMin":1285,"sqftMax":1410,"collection":null,"lines":["A"],"floorRange":"5-27","startingRent":7150,"description":"Three bedrooms off a single hall, with the living room and the primary bedroom sharing the corner. The A line runs north and west, so the Queensboro Bridge sits on one side and Midtown on the other. The kitchen island seats four and the laundry has its own closet, not a corner of the bath.","features":["Corner residence, north and west","Primary bedroom with an en suite bath and a walk-in closet","Kitchen island seating four","Floor-to-ceiling windows, blackout shades in all three bedrooms","7-inch white oak plank flooring","Bosch appliance suite, gas cooking, vented hood","Bosch washer and vented dryer in a dedicated laundry closet","Ceilings 9 feet 4 inches"]},
  {"id":"C2","name":"Three Bedroom, West Collection","bedrooms":3,"bathrooms":2.5,"sqft":1512,"sqftMin":1455,"sqftMax":1560,"collection":"West Collection","lines":["A","E"],"floorRange":"28-33","startingRent":10405,"description":"The largest plan in the building, on 28 through 33. Two exposures, north and west, ceilings at 10 feet 6 inches, a quartzite island, and a half bath off the entry so guests never walk past a bedroom. The A line on 33 opens to a private terrace one floor under The Overlook.","features":["Corner residence, north and west","Ceilings 10 feet 6 inches","Half bath off the entry, two full baths beyond","Quartzite waterfall island with integrated under-edge lighting","Fisher & Paykel panel-ready refrigeration and a wine column","Private terrace, 140 to 240 square feet, on the A line","7-inch white oak plank flooring","Bosch washer and vented dryer in a dedicated laundry closet"]}
];

const INVENTORY = [
  {"unitId":"06F","floorPlanId":"S1","floor":6,"bedrooms":0,"bathrooms":1,"sqft":496,"monthlyRent":3255,"availableFrom":"2026-11-15","exposure":"South","view":"South over the Hunters Point low-rise rooftops","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"09F","floorPlanId":"S1","floor":9,"bedrooms":0,"bathrooms":1,"sqft":496,"monthlyRent":3350,"availableFrom":"2026-09-07","exposure":"South","view":"South over the Hunters Point low-rise rooftops","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"12G","floorPlanId":"S1","floor":12,"bedrooms":0,"bathrooms":1,"sqft":532,"monthlyRent":3595,"availableFrom":"2026-10-12","exposure":"South and East","view":"Court Square and the Citigroup Building","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"27F","floorPlanId":"S1","floor":27,"bedrooms":0,"bathrooms":1,"sqft":496,"monthlyRent":3930,"availableFrom":"2026-12-05","exposure":"South","view":"South to the Kosciuszko Bridge and Newtown Creek","status":"pending","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"05K","floorPlanId":"S2","floor":5,"bedrooms":0,"bathrooms":1,"sqft":560,"monthlyRent":3165,"availableFrom":"2026-11-05","exposure":"East","view":"East over Vernon Boulevard toward Sunnyside","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"07K","floorPlanId":"S2","floor":7,"bedrooms":0,"bathrooms":1,"sqft":578,"monthlyRent":3330,"availableFrom":"2026-09-07","exposure":"East","view":"East over Vernon Boulevard toward Sunnyside","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"25K","floorPlanId":"S2","floor":25,"bedrooms":0,"bathrooms":1,"sqft":578,"monthlyRent":3920,"availableFrom":"2026-10-18","exposure":"East","view":"Court Square, the Citigroup Building, and the LIRR yards","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"08E","floorPlanId":"A1","floor":8,"bedrooms":1,"bathrooms":1,"sqft":735,"monthlyRent":4475,"availableFrom":"2026-10-24","exposure":"South","view":"South over Hunter's Point South Park","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"09C","floorPlanId":"A1","floor":9,"bedrooms":1,"bathrooms":1,"sqft":688,"monthlyRent":4685,"availableFrom":"2026-11-01","exposure":"West","view":"East River and the Midtown skyline over Gantry Plaza State Park","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"14C","floorPlanId":"A1","floor":14,"bedrooms":1,"bathrooms":1,"sqft":688,"monthlyRent":4910,"availableFrom":"2026-10-01","exposure":"West","view":"East River and the Midtown skyline over Gantry Plaza State Park","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"20E","floorPlanId":"A1","floor":20,"bedrooms":1,"bathrooms":1,"sqft":735,"monthlyRent":4995,"availableFrom":"2026-09-19","exposure":"South","view":"South over Hunter's Point South Park to the Kosciuszko Bridge","status":"pending","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"25C","floorPlanId":"A1","floor":25,"bedrooms":1,"bathrooms":1,"sqft":688,"monthlyRent":5405,"availableFrom":"2026-12-01","exposure":"West","view":"East River, the Midtown skyline, and the ferry landing at LIC Landing","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"17H","floorPlanId":"A2","floor":17,"bedrooms":1,"bathrooms":1,"sqft":731,"monthlyRent":5070,"availableFrom":"2026-11-20","exposure":"North","view":"Queensboro Bridge and Roosevelt Island","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"22H","floorPlanId":"A2","floor":22,"bedrooms":1,"bathrooms":1,"sqft":731,"monthlyRent":5290,"availableFrom":"2026-10-15","exposure":"North","view":"Queensboro Bridge, Roosevelt Island, and the Upper East Side beyond","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"26H","floorPlanId":"A2","floor":26,"bedrooms":1,"bathrooms":1,"sqft":731,"monthlyRent":5490,"availableFrom":"2026-10-30","exposure":"North","view":"Queensboro Bridge, Roosevelt Island, and the Upper East Side beyond","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"10J","floorPlanId":"A3","floor":10,"bedrooms":1,"bathrooms":1.5,"sqft":848,"monthlyRent":4585,"availableFrom":"2026-11-08","exposure":"East","view":"East over Vernon Boulevard toward Sunnyside Yards","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"18J","floorPlanId":"A3","floor":18,"bedrooms":1,"bathrooms":1.5,"sqft":848,"monthlyRent":4935,"availableFrom":"2026-10-05","exposure":"East","view":"Court Square and the Citigroup Building","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"24J","floorPlanId":"A3","floor":24,"bedrooms":1,"bathrooms":1.5,"sqft":848,"monthlyRent":5195,"availableFrom":"2026-12-15","exposure":"East","view":"Court Square, the Citigroup Building, and Sunnyside Yards","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"13L","floorPlanId":"B1","floor":13,"bedrooms":2,"bathrooms":2,"sqft":985,"monthlyRent":5875,"availableFrom":"2026-10-22","exposure":"North and East","view":"Queensboro Bridge to the north, Court Square to the east","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"21B","floorPlanId":"B1","floor":21,"bedrooms":2,"bathrooms":2,"sqft":1012,"monthlyRent":6925,"availableFrom":"2026-09-26","exposure":"West","view":"East River and the Midtown skyline, Empire State Building on the left","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"26B","floorPlanId":"B1","floor":26,"bedrooms":2,"bathrooms":2,"sqft":1012,"monthlyRent":7225,"availableFrom":"2026-11-01","exposure":"West","view":"East River, the Midtown skyline, and the Queensboro Bridge to the north","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"15D","floorPlanId":"B2","floor":15,"bedrooms":2,"bathrooms":2,"sqft":1046,"monthlyRent":7140,"availableFrom":"2026-11-12","exposure":"West and South","view":"East River and the Midtown skyline, Hunter's Point South Park below","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"23D","floorPlanId":"B2","floor":23,"bedrooms":2,"bathrooms":2,"sqft":1046,"monthlyRent":7690,"availableFrom":"2026-10-09","exposure":"West and South","view":"East River, the Midtown skyline, and south to the Kosciuszko Bridge","status":"pending","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"28B","floorPlanId":"B3","floor":28,"bedrooms":2,"bathrooms":2,"sqft":1148,"monthlyRent":9580,"availableFrom":"2026-12-10","exposure":"West","view":"East River and the full Midtown skyline from above the setback","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"31D","floorPlanId":"B3","floor":31,"bedrooms":2,"bathrooms":2,"sqft":1104,"monthlyRent":9820,"availableFrom":"2026-10-20","exposure":"West","view":"East River, the Midtown skyline, and the Queensboro Bridge","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"32C","floorPlanId":"B3","floor":32,"bedrooms":2,"bathrooms":2,"sqft":1190,"monthlyRent":10255,"availableFrom":"2026-11-25","exposure":"West","view":"East River, the full Midtown skyline, and the ferries at LIC Landing","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"12A","floorPlanId":"C1","floor":12,"bedrooms":3,"bathrooms":2,"sqft":1332,"monthlyRent":7150,"availableFrom":"2026-11-03","exposure":"North and West","view":"Queensboro Bridge to the north, the East River and Midtown to the west","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"19A","floorPlanId":"C1","floor":19,"bedrooms":3,"bathrooms":2,"sqft":1332,"monthlyRent":7615,"availableFrom":"2026-12-01","exposure":"North and West","view":"Queensboro Bridge, Roosevelt Island, and the Midtown skyline","status":"available","concession":"One month free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"29E","floorPlanId":"C2","floor":29,"bedrooms":3,"bathrooms":2.5,"sqft":1455,"monthlyRent":10405,"availableFrom":"2026-12-12","exposure":"North and West","view":"The Queensboro Bridge, the East River, and Midtown from above the setback","status":"available","concession":"Two months free on a 14-month lease, signed by December 31, 2026"},
  {"unitId":"33A","floorPlanId":"C2","floor":33,"bedrooms":3,"bathrooms":2.5,"sqft":1512,"monthlyRent":11200,"availableFrom":"2026-11-15","exposure":"North and West","view":"The full arc of it — Queensboro Bridge, Roosevelt Island, the East River, and Midtown, from the highest residential floor","status":"available","concession":"Two months free on a 14-month lease, signed by December 31, 2026"}
];

/* ── Small helpers ──────────────────────────────────────────── */
const $  = (sel, ctx) => (ctx || document).querySelector(sel);
const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const PLAN_IMAGE = {
  S1: 'studio-interior', S2: 'studio-interior',
  A1: 'one-bed-interior', A2: 'one-bed-interior', A3: 'one-bed-interior',
  B1: 'two-bed-interior', B2: 'two-bed-interior', B3: 'two-bed-interior',
  C1: 'two-bed-interior', C2: 'two-bed-interior'
};

const PLAN_ALT = {
  'studio-interior': 'A studio residence at The Larkin, floor-to-ceiling windows along the long wall with the kitchen running down one side',
  'one-bed-interior': 'A one bedroom residence at The Larkin, living room with floor-to-ceiling glass facing west over the East River',
  'two-bed-interior': 'A two bedroom residence at The Larkin, open living and dining room with a kitchen island and floor-to-ceiling glass'
};

const money = (n) => '$' + n.toLocaleString('en-US');

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfToday() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

/** "2026-10-01" -> "Oct 1, 2026", or "Immediate" if it has arrived. */
function availabilityLabel(iso) {
  const d = parseISO(iso);
  if (d <= startOfToday()) return { text: 'Immediate', now: true };
  return { text: MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(), now: false };
}

/** Long concession sentence -> short table-friendly line. */
function shortConcession(text) {
  if (!text) return 'No concession';
  const months = text.match(/^(\w+)\s+(month|months|weeks|week)\s+free\s+on\s+an?\s+(\d+)-month lease/i);
  if (months) {
    const qty = months[1].toLowerCase();
    const map = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' };
    const n = map[qty] || qty;
    const unit = /week/i.test(months[2]) ? (n === '1' ? 'week' : 'weeks') : (n === '1' ? 'month' : 'months');
    return n + ' ' + unit + ' free · ' + months[3]+'-mo lease';
  }
  return text;
}

const bedLabel = (n) => (n === 0 ? 'Studio' : n === 1 ? 'One bedroom' : n === 2 ? 'Two bedroom' : 'Three bedroom');

function bedsBaths(u) {
  if (u.bedrooms === 0) return 'Studio / ' + u.bathrooms;
  return u.bedrooms + ' / ' + u.bathrooms;
}

function sqftRange(plan) {
  if (plan.sqftMin === plan.sqftMax) return plan.sqftMin.toLocaleString('en-US') + ' sf';
  return plan.sqftMin.toLocaleString('en-US') + '–' + plan.sqftMax.toLocaleString('en-US') + ' sf';
}

const planById = (id) => FLOORPLANS.find((p) => p.id === id);

/* ── Masthead: transparent over the hero, solid after it ────── */
(function masthead() {
  const header = $('#masthead');
  const hero = $('.hero');
  if (!header || !hero) return;

  let ticking = false;
  function update() {
    const h = header.offsetHeight;
    const limit = hero.offsetTop + hero.offsetHeight - h - 8;
    header.classList.toggle('is-stuck', window.scrollY >= limit);
    ticking = false;
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  update();
})();

/* ── Mobile navigation ──────────────────────────────────────── */
(function mobileNav() {
  const toggle = $('.menu-toggle');
  const nav = $('#primary-nav');
  if (!toggle || !nav) return;

  function close() {
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    const h = $('#masthead');
    if (h) h.classList.remove('is-solid');
  }

  const header = $('#masthead');

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (header) header.classList.toggle('is-solid', open);
  });

  nav.addEventListener('click', (e) => { if (e.target.tagName === 'A') close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', () => { if (window.innerWidth > 1080) close(); });
})();

/* ── Floor plans: rail + panel (tabs) ───────────────────────── */
const Plans = (function () {
  const rail = $('#plan-rail');
  const panel = $('#plan-panel');
  if (!rail || !panel) return {};

  let current = FLOORPLANS[0].id;

  function availableFor(planId) {
    return INVENTORY.filter((u) => u.floorPlanId === planId && u.status === 'available').length;
  }

  function buildRail() {
    rail.innerHTML = '';
    FLOORPLANS.forEach((plan) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plan-rail__item';
      btn.id = 'plan-tab-' + plan.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(plan.id === current));
      btn.setAttribute('aria-controls', 'plan-panel');
      btn.tabIndex = plan.id === current ? 0 : -1;
      btn.dataset.plan = plan.id;
      btn.innerHTML =
        '<span class="plan-rail__code">' + plan.id + '</span>' +
        '<span class="plan-rail__name">' + plan.name +
          '<span class="plan-rail__meta">' + bedLabel(plan.bedrooms) + ' · ' + sqftRange(plan) + '</span>' +
        '</span>' +
        '<span class="plan-rail__rent">from ' + money(plan.startingRent) + '</span>';
      btn.addEventListener('click', () => select(plan.id, false));
      rail.appendChild(btn);
    });

    rail.addEventListener('keydown', (e) => {
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (keys.indexOf(e.key) === -1) return;
      e.preventDefault();
      const ids = FLOORPLANS.map((p) => p.id);
      let i = ids.indexOf(current);
      if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = ids.length - 1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') i = (i + 1) % ids.length;
      else i = (i - 1 + ids.length) % ids.length;
      select(ids[i], false);
      const el = $('#plan-tab-' + ids[i]);
      if (el) el.focus();
    });
  }

  function renderPanel(plan) {
    const slug = PLAN_IMAGE[plan.id] || 'one-bed-interior';
    const count = availableFor(plan.id);
    const terrace = plan.collection ? '<span class="plan-collection">' + plan.collection + '</span>' : '';

    panel.innerHTML =
      '<figure class="plan-panel__figure">' +
        '<div class="media media--16x10">' +
          '<img src="/images/' + slug + '.jpg" alt="' + PLAN_ALT[slug] + '" loading="lazy" decoding="async">' +
        '</div>' +
      '</figure>' +

      '<div class="plan-panel__head">' +
        '<h3 class="plan-panel__title"><em>Plan ' + plan.id + '</em>' + plan.name + '</h3>' +
        '<p class="plan-panel__price"><b>' + money(plan.startingRent) + '</b><span>starting, net effective</span></p>' +
      '</div>' +
      terrace +

      '<dl class="plan-specs">' +
        '<div><dt>Beds / Baths</dt><dd>' + (plan.bedrooms === 0 ? 'Studio' : plan.bedrooms) + ' / ' + plan.bathrooms + '</dd></div>' +
        '<div><dt>Size</dt><dd>' + sqftRange(plan) + '</dd></div>' +
        '<div><dt>Floors</dt><dd>' + plan.floorRange + '</dd></div>' +
        '<div><dt>Lines</dt><dd>' + plan.lines.join(', ') + '</dd></div>' +
      '</dl>' +

      '<p class="plan-panel__desc">' + plan.description + '</p>' +

      '<ul class="ticked plan-panel__features">' +
        plan.features.map((f) => '<li>' + f + '</li>').join('') +
      '</ul>' +

      '<div class="plan-panel__cta">' +
        (count
          ? '<button type="button" class="btn btn--ghost" data-see-plan="' + plan.id + '">See ' + count + ' available ' + (count === 1 ? 'residence' : 'residences') + '</button>'
          : '<span class="plan-panel__note">Fully leased today. Call and we will tell you what is coming back.</span>') +
        '<a class="btn" href="' + PHONE_HREF + '">Call ' + PHONE_DISPLAY + '</a>' +
        '<span class="plan-panel__note">Dimensions are approximate and not to scale.</span>' +
      '</div>';

    panel.setAttribute('aria-labelledby', 'plan-tab-' + plan.id);

    const seeBtn = $('[data-see-plan]', panel);
    if (seeBtn) {
      seeBtn.addEventListener('click', () => {
        if (Availability && Availability.filterToPlan) Availability.filterToPlan(plan.id);
        const target = $('#availability');
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function select(id, silent) {
    current = id;
    $$('.plan-rail__item', rail).forEach((btn) => {
      const on = btn.dataset.plan === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
      if (on && !silent) {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    });
    renderPanel(planById(id));
  }

  buildRail();
  select(current, true);

  return { select: select };
})();

/* ── Availability table ─────────────────────────────────────── */
const Availability = (function () {
  const body = $('#avail-body');
  const countEl = $('#avail-count');
  const emptyEl = $('#avail-empty');
  const pillWrap = $('#bed-filters');
  const sortSel = $('#sort');
  const chipRow = $('#plan-chip-row');
  const chipLabel = $('#plan-chip-label');
  const chipClear = $('#plan-chip-clear');
  const table = $('#avail-table');
  if (!body) return {};

  const state = { beds: 'all', plan: null, sort: 'rent-asc' };

  const BED_FILTERS = [
    { key: 'all', label: 'All residences' },
    { key: '0', label: 'Studio' },
    { key: '1', label: 'One bedroom' },
    { key: '2', label: 'Two bedroom' },
    { key: '3', label: 'Three bedroom' }
  ];

  function countFor(key) {
    return INVENTORY.filter((u) => key === 'all' || u.bedrooms === Number(key)).length;
  }

  function buildPills() {
    pillWrap.innerHTML = '';
    BED_FILTERS.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill';
      b.dataset.beds = f.key;
      b.setAttribute('aria-pressed', String(state.beds === f.key));
      b.innerHTML = f.label + '<span class="pill__n">' + countFor(f.key) + '</span>';
      b.addEventListener('click', () => {
        state.beds = f.key;
        state.plan = null;
        render();
      });
      pillWrap.appendChild(b);
    });
  }

  function rows() {
    let list = INVENTORY.slice();
    if (state.plan) list = list.filter((u) => u.floorPlanId === state.plan);
    else if (state.beds !== 'all') list = list.filter((u) => u.bedrooms === Number(state.beds));

    const by = {
      'rent-asc':  (a, b) => a.monthlyRent - b.monthlyRent,
      'rent-desc': (a, b) => b.monthlyRent - a.monthlyRent,
      'sqft-desc': (a, b) => b.sqft - a.sqft,
      'date-asc':  (a, b) => parseISO(a.availableFrom) - parseISO(b.availableFrom) || a.monthlyRent - b.monthlyRent,
      'floor-desc': (a, b) => b.floor - a.floor
    };
    return list.sort(by[state.sort] || by['rent-asc']);
  }

  function rowHTML(u) {
    const plan = planById(u.floorPlanId);
    const avail = availabilityLabel(u.availableFrom);
    const pending = u.status === 'pending';
    const west = plan && plan.collection === 'West Collection';

    let tags = '';
    if (west) tags += '<span class="u-tag">West Collection</span> ';
    if (pending) tags += '<span class="u-tag u-tag--pending">Application pending</span>';

    return '<tr>' +
      '<td data-label="Residence">' +
        '<span class="u-res">' + u.unitId + '</span>' +
        '<span class="u-floor">Floor ' + u.floor + ', line ' + u.unitId.slice(-1) + '</span>' +
        (tags ? '<span class="u-tags">' + tags + '</span>' : '') +
      '</td>' +
      '<td data-label="Plan"><span class="u-plan">' + u.floorPlanId + '<span>' + (plan ? plan.name : '') + '</span></span></td>' +
      '<td data-label="Beds / Baths">' + bedsBaths(u) + '</td>' +
      '<td data-label="Sq Ft" class="num">' + u.sqft.toLocaleString('en-US') + '</td>' +
      '<td data-label="Exposure"><span class="u-val">' + u.exposure + '<span class="u-view">' + u.view + '</span></span></td>' +
      '<td data-label="Available"><span class="u-date' + (avail.now ? ' u-date--now' : '') + '">' + avail.text + '</span></td>' +
      '<td data-label="Net effective rent" class="num"><span class="u-val">' +
        '<span class="u-rent">' + money(u.monthlyRent) + ' <small>/mo</small></span>' +
        '<span class="u-conc">' + shortConcession(u.concession) + '</span>' +
      '</span></td>' +
      '<td><a class="u-call" href="' + PHONE_HREF + '">Ask about ' + u.unitId + '</a></td>' +
    '</tr>';
  }

  function render() {
    const list = rows();
    body.innerHTML = list.map(rowHTML).join('');

    $$('.pill', pillWrap).forEach((p) => {
      p.setAttribute('aria-pressed', String(!state.plan && p.dataset.beds === state.beds));
    });

    const totalAvailable = INVENTORY.filter((u) => u.status === 'available').length;
    const shown = list.length;
    const scope = state.plan
      ? 'plan ' + state.plan
      : state.beds === 'all' ? 'the building' : bedLabel(Number(state.beds)).toLowerCase() + ' residences';

    countEl.innerHTML = '<b>' + shown + '</b> ' + (shown === 1 ? 'residence' : 'residences') +
      ' showing in ' + scope + '. ' + totalAvailable +
      ' on the board today, including residences under notice with future move-ins.';

    if (chipRow) {
      chipRow.hidden = !state.plan;
      if (state.plan && chipLabel) {
        const p = planById(state.plan);
        chipLabel.textContent = state.plan + ' · ' + (p ? p.name : '');
      }
    }

    const empty = shown === 0;
    if (emptyEl) emptyEl.hidden = !empty;
    if (table) table.style.display = empty ? 'none' : '';
  }

  function filterToPlan(planId) {
    state.plan = planId;
    render();
  }

  buildPills();
  if (sortSel) sortSel.addEventListener('change', () => { state.sort = sortSel.value; render(); });
  if (chipClear) chipClear.addEventListener('click', () => { state.plan = null; render(); });
  render();

  return { filterToPlan: filterToPlan };
})();

/* ── Reveal on scroll ───────────────────────────────────────── */
(function reveal() {
  const items = $$('.reveal');
  if (!items.length) return;

  if (!('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  items.forEach((el) => io.observe(el));
})();

/* ── Legal dialogs ──────────────────────────────────────────── */
(function dialogs() {
  $$('[data-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dlg = document.getElementById(btn.dataset.dialog);
      if (!dlg) return;
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
  });

  $$('.dlg').forEach((dlg) => {
    const close = () => (typeof dlg.close === 'function' ? dlg.close() : dlg.removeAttribute('open'));
    const btn = $('[data-close]', dlg);
    if (btn) btn.addEventListener('click', close);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  });
})();

/* ── Footer year ────────────────────────────────────────────── */
(function year() {
  const el = $('#year');
  if (el) el.textContent = String(new Date().getFullYear());
})();
