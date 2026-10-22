import {
  $, h, chip, getJSON, endpointPath, loadMeta, latestResult, resultState, failedParams, certRemainingMs,
  buildHistory, emptyDays, dayLabel, formatPercent, formatRemaining, formatWindow, formatAgo, formatStamp,
  formatInterval, parseGoDuration, hostOf, joinList, slug, RANK, STATE_LABEL, REFRESH_MS, MINUTE,
} from './common.js';

const DAYS = 90;
// Events only change when a check flips, so they're re-read when that happens or every 10 min.
const EVENTS_MAX_AGE_MS = 10 * MINUTE;
const GROUP_COLORS = ['c-green', 'c-amber', 'c-blue'];
const GROUP_UNITS = { Infrastructure: ['check', 'checks'] };
// The per-domain TLS checks are shown as a single row inside Infrastructure.
const FOLD = { group: 'Certificates', into: 'Infrastructure', name: 'TLS certificates' };

const HERO = {
  operational: { title: 'All systems operational', tag: '[  OK  ]', cls: 'fg-up' },
  degraded: { title: 'Some systems degraded', tag: '[ WARN ]', cls: 'fg-deg' },
  outage: { title: 'Partial outage', tag: '[ FAIL ]', cls: 'fg-down' },
  major: { title: 'Major outage', tag: '[ FAIL ]', cls: 'fg-down' },
  pending: { title: 'Waiting for the first checks', tag: '[ .... ]', cls: 'fg-none' },
  error: { title: 'Status API unreachable', tag: '[ FAIL ]', cls: 'fg-down' },
};
const ANNOUNCEMENT = {
  outage: ['down', 'outage'],
  warning: ['deg', 'warning'],
  information: ['info', 'info'],
  operational: ['up', 'resolved'],
  none: ['info', 'notice'],
};

const events = new Map(); // key -> { list, at }
let statuses = null;
let announcements = [];
let fetchedAt = 0;
let failed = false;
let model = null;

// --- data ------------------------------------------------------------------------------------

async function refresh() {
  try {
    const [list, config] = await Promise.all([
      getJSON('/api/v1/endpoints/statuses?pageSize=1'),
      getJSON('/api/v1/config').catch(() => null),
    ]);
    await refreshEvents(list);
    statuses = list;
    if (config) announcements = config.announcements || [];
    fetchedAt = Date.now();
    failed = false;
  } catch {
    failed = true;
  }
  await render();
}

async function refreshEvents(list) {
  const now = Date.now();
  const stale = list.filter((st) => {
    const cached = events.get(st.key);
    if (!cached || now - cached.at > EVENTS_MAX_AGE_MS) return true;
    const latest = latestResult(st);
    const last = cached.list.filter((e) => e.type !== 'START').at(-1);
    return latest && last && (last.type === 'UNHEALTHY') === latest.success;
  });
  await Promise.all(stale.map(async (st) => {
    try {
      const full = await getJSON(`${endpointPath(st.key)}/statuses?pageSize=1`);
      events.set(st.key, { list: full.events || [], at: now });
    } catch {
      // keep whatever we had; the bars fall back to "no data" for endpoints never loaded
    }
  }));
}

// --- model -----------------------------------------------------------------------------------

function endpointRow(st, meta, now) {
  const latest = latestResult(st);
  const state = resultState(latest);
  const history = buildHistory(events.get(st.key)?.list, now, { days: DAYS, currentState: state });
  const params = failedParams(latest);
  return {
    key: st.key,
    name: st.name,
    group: st.group || 'Other',
    host: meta?.url ? hostOf(meta.url) : latest?.hostname || 'hostname hidden',
    href: `/service.html?key=${encodeURIComponent(st.key)}`,
    state,
    reason: state === 'down' ? 'is down'
      : state === 'deg' ? (params.includes('[RESPONSE_TIME]') ? 'is responding slowly' : 'has a certificate expiring soon')
      : null,
    ms: latest && state !== 'down' ? Math.round(latest.duration / 1e6) : null,
    lastCheck: latest ? Date.parse(latest.timestamp) : 0,
    failingSince: history?.failingSince ?? (latest && !latest.success ? Date.parse(latest.timestamp) : null),
    interval: meta ? parseGoDuration(meta.interval) : null,
    certMs: certRemainingMs(latest),
    days: history?.days || emptyDays(now, DAYS),
    uptime: history?.uptime ?? null,
    observedMs: history?.observedMs || 0,
  };
}

// Service names keep their own case ("n8n"); only generated phrases get a capital.
const sentence = (text) => text.replace(/^the /, 'The ');
const worst = (states) => states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'none');

function foldRow(members) {
  const state = worst(members.map((m) => m.state));
  const certs = members.map((m) => m.certMs).filter(Number.isFinite);
  const soonest = certs.length ? Math.min(...certs) : null;
  const bad = members.filter((m) => m.state === state && state !== 'up');
  const uptimes = members.map((m) => m.uptime).filter((u) => u != null);
  const domains = `${members.length} ${members.length === 1 ? 'domain' : 'domains'}`;
  const days = members[0].days.map((d, i) => {
    const dayState = worst(members.map((m) => m.days[i].state));
    const hit = members.filter((m) => m.days[i].state === dayState && RANK[dayState] > RANK.up);
    return {
      ...d,
      state: dayState,
      failMs: Math.max(0, ...hit.map((m) => m.days[i].failMs)),
      extra: hit.length ? ` (${hit.map((m) => m.name).join(', ')})` : '',
    };
  });
  return {
    key: 'tls-certificates',
    name: FOLD.name,
    group: FOLD.into,
    host: soonest != null ? `${domains} · next expiry in ${formatRemaining(soonest, true)}` : domains,
    href: null,
    state,
    reason: null,
    phrase: state === 'deg' ? `the certificate for ${bad[0].name} ${bad[0].certMs ? `expires in ${formatRemaining(bad[0].certMs)}` : 'needs renewal'}`
      : state === 'down' ? `the TLS check for ${joinList(bad.map((m) => m.name))} fails`
      : null,
    ms: null,
    lastCheck: Math.max(...members.map((m) => m.lastCheck)),
    failingSince: Math.min(...bad.map((m) => m.failingSince ?? Infinity)),
    interval: Math.min(...members.map((m) => m.interval ?? Infinity)),
    days,
    uptime: uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null,
    observedMs: Math.max(...members.map((m) => m.observedMs)),
  };
}

async function buildModel(now) {
  const meta = await loadMeta();
  const order = (st) => meta.get(st.key)?.order ?? Number.MAX_SAFE_INTEGER;
  const rows = [];
  const folded = [];
  for (const st of [...statuses].sort((a, b) => order(a) - order(b))) {
    const row = endpointRow(st, meta.get(st.key), now);
    (row.group === FOLD.group ? folded : rows).push(row);
  }
  if (folded.length) {
    const tls = foldRow(folded);
    const lastOfGroup = rows.map((r) => r.group).lastIndexOf(FOLD.into);
    rows.splice(lastOfGroup < 0 ? rows.length : lastOfGroup + 1, 0, tls);
  }
  const groups = [];
  for (const row of rows) {
    let g = groups.find((x) => x.name === row.group);
    if (!g) groups.push((g = { name: row.group, rows: [] }));
    g.rows.push(row);
  }
  const intervals = rows.map((r) => r.interval).filter(Number.isFinite);
  return {
    rows,
    groups,
    lastCheck: Math.max(0, ...rows.map((r) => r.lastCheck)),
    interval: intervals.length ? Math.min(...intervals) : null,
  };
}

// --- render ----------------------------------------------------------------------------------

async function render() {
  const now = Date.now();
  if (statuses) model = await buildModel(now);
  renderHero(now);
  if (!model) return;
  renderChips();
  renderIncidents();
  renderGroups();
}

function heroKind() {
  if (!model) return failed ? 'error' : null;
  const counted = model.rows.filter((r) => r.state !== 'none');
  if (!counted.length) return 'pending';
  const down = counted.filter((r) => r.state === 'down').length;
  if (down) return down === counted.length ? 'major' : 'outage';
  return counted.some((r) => r.state === 'deg') ? 'degraded' : 'operational';
}

function heroSummary() {
  const bad = model.rows.filter((r) => r.state === 'down' || r.state === 'deg')
    .sort((a, b) => RANK[b.state] - RANK[a.state]);
  if (!bad.length) return 'Every service passed its last check';
  const byReason = new Map();
  const phrases = [];
  for (const r of bad) {
    if (r.phrase) phrases.push(r.phrase);
    else byReason.set(r.reason, [...(byReason.get(r.reason) || []), r.name]);
  }
  const parts = [...byReason].map(([reason, names]) => {
    const plural = names.length > 1 && reason.startsWith('is ');
    return `${joinList(names)} ${plural ? reason.replace(/^is /, 'are ') : reason}`;
  });
  return sentence(joinList([...parts, ...phrases]));
}

function renderHero(now) {
  const kind = heroKind();
  if (!kind) return;
  const hero = HERO[kind];
  $('#hero-title').textContent = hero.title;
  const tag = $('#hero-tag');
  tag.className = `hero-tag ${hero.cls}`;
  if (kind === 'error') {
    tag.textContent = `${hero.tag} no data`;
    $('#hero-sub').textContent = 'The checks may still be running; retrying every 60 s';
    return;
  }
  const counted = model.rows.filter((r) => r.state !== 'none');
  const passing = counted.filter((r) => r.state === 'up').length;
  tag.textContent = `${hero.tag} ${passing}/${model.rows.length} checks passing`;
  $('#hero-sub').textContent = kind === 'pending' ? 'Gatus has just started' : heroSummary();
  if (failed) $('#hero-sub').textContent += ' · refresh failed, retrying';
  updateAge(now);
}

function updateAge(now = Date.now()) {
  if (!model?.lastCheck) return;
  const every = model.interval ? ` · every ${formatInterval(model.interval)}` : '';
  $('#hero-age').textContent = ` · last check ${formatAgo(now - model.lastCheck)}${every}`;
}

function renderChips() {
  $('#chips').replaceChildren(...model.rows.map((r) =>
    h('li', null, h('span', { class: `chip ${r.state}` }, slug(r.name),
      h('span', { class: 'visually-hidden' }, `: ${STATE_LABEL[r.state]}`)))));
}

function renderIncidents() {
  const active = announcements
    .filter((a) => !a.archived)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const banners = active.map((a) => {
    const [cls, label] = ANNOUNCEMENT[a.type] || ANNOUNCEMENT.none;
    const [title, ...body] = String(a.message).split('\n');
    return incident(cls, label, new Date(a.timestamp), title, body.join('\n').trim());
  });
  const kind = heroKind();
  if (!banners.length && (kind === 'outage' || kind === 'major')) {
    // No written update yet: say what the checks see, nothing more.
    const down = model.rows.filter((r) => r.state === 'down');
    const since = Math.min(...down.map((r) => r.failingSince).filter(Number.isFinite), Date.now());
    const services = down.filter((r) => !r.phrase).map((r) => r.name);
    const parts = [
      services.length ? `${joinList(services)} ${services.length > 1 ? 'are' : 'is'} not responding` : null,
      ...down.filter((r) => r.phrase).map((r) => r.phrase),
    ].filter(Boolean);
    banners.push(incident('down', 'ongoing', new Date(since), sentence(joinList(parts)),
      `Checks failing since ${formatStamp(new Date(since))}. This notice is generated from the checks; a written update will appear here if there is one.`));
  }
  $('#incidents').replaceChildren(...banners);
}

function incident(cls, label, when, title, body) {
  return h('section', { class: `incident ${cls}`, 'aria-label': 'Incident' },
    h('div', { class: 'incident-meta' }, chip(cls, label),
      h('time', { class: 'incident-time', datetime: when.toISOString() }, formatStamp(when))),
    h('h2', null, title),
    body ? h('p', null, body) : null);
}

function renderGroups() {
  let anyNone = false;
  const groups = model.groups.map((g, gi) => {
    const [one, many] = GROUP_UNITS[g.name] || ['service', 'services'];
    const uptimes = g.rows.map((r) => r.uptime).filter((u) => u != null);
    const observed = Math.max(0, ...g.rows.map((r) => r.observedMs));
    const count = `${g.rows.length} ${g.rows.length === 1 ? one : many}`;
    const meta = uptimes.length
      ? `${count} · ${formatPercent(uptimes.reduce((a, b) => a + b, 0) / uptimes.length)} over ${formatWindow(observed)}`
      : `${count} · collecting data`;
    const rows = g.rows.map((r) => {
      if (r.days.some((d) => d.state === 'none')) anyNone = true;
      return renderRow(r);
    });
    return h('div', { class: 'group' },
      h('div', { class: 'group-head' },
        h('h3', { class: GROUP_COLORS[gi % GROUP_COLORS.length] }, g.name),
        h('span', { class: 'group-meta' }, meta)),
      h('div', { class: 'card' }, rows));
  });
  $('#groups').replaceChildren(...groups);
  $('#legend-none').hidden = !anyNone;
}

function renderRow(r) {
  const incidents = r.days.filter((d) => d.state === 'deg' || d.state === 'down').length;
  const noData = r.days.filter((d) => d.state === 'none').length;
  let summary = incidents ? `${incidents} ${incidents === 1 ? 'day' : 'days'} with incidents` : 'no incidents';
  if (noData) summary += `, ${noData} ${noData === 1 ? 'day' : 'days'} without data`;
  return h('div', { class: 'row' },
    h('div', { class: 'row-top' },
      h('div', { class: 'row-id' },
        r.href ? h('a', { class: 'svc', href: r.href }, r.name) : h('span', { class: 'svc' }, r.name),
        h('span', { class: 'host' }, r.host)),
      h('div', { class: 'row-stats' },
        h('span', null, h('span', { class: 'num' }, formatPercent(r.uptime)), ' ', h('span', { class: 'unit' }, 'uptime')),
        h('span', null, h('span', { class: 'num' }, r.ms == null ? '—' : String(r.ms)), ' ', h('span', { class: 'unit' }, 'ms')),
        chip(r.state, STATE_LABEL[r.state]))),
    h('div', { class: 'bars', role: 'img', 'aria-label': `Last ${DAYS} days: ${summary}` },
      r.days.map((d) => h('div', { class: `bar ${d.state}`, title: dayLabel(d, d.extra || '') }))),
    h('div', { class: 'bars-axis' },
      h('span', null, h('span', { class: 'axis-long' }, `${DAYS} days ago`), h('span', { class: 'axis-short' }, '30 days ago')),
      h('span', null, 'today')));
}

// --- loop ------------------------------------------------------------------------------------

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(() => updateAge(), 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - fetchedAt > REFRESH_MS) refresh();
});
