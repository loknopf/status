// Shared helpers for both pages: API access, deriving states from Gatus results and events,
// formatting, and a tiny DOM builder (no innerHTML anywhere: the CSP enforces Trusted Types).

export const REFRESH_MS = 60_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// Failing only these makes a check "degraded" instead of "down": the service still answers
// correctly, it's just slow or its certificate needs renewing soon.
const SOFT_CONDITIONS = ['[RESPONSE_TIME]', '[CERTIFICATE_EXPIRATION]'];
// A finished failure shorter than this counts as "degraded" in the daily bars, longer as downtime.
const BLIP_MS = 5 * MINUTE;

export const RANK = { none: 0, up: 1, deg: 2, down: 3 };
export const STATE_LABEL = { up: 'operational', deg: 'degraded', down: 'down', none: 'pending' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// --- API -------------------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(status, path) {
    super(`${path}: HTTP ${status}`);
    this.status = status;
  }
}

async function request(path) {
  const res = await fetch(path, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new HttpError(res.status, path);
  return res;
}
export const getJSON = async (path) => (await request(path)).json();
export const getText = async (path) => (await request(path)).text();

export const endpointPath = (key) => `/api/v1/endpoints/${encodeURIComponent(key)}`;

// Gatus' endpoint key: "<group>_<name>", sanitised like config/key/key.go.
const sanitize = (s) => (s || '').trim().toLowerCase().replace(/[/_.,# +&]/g, '-');
export const gatusKey = (group, name) => `${sanitize(group)}_${sanitize(name)}`;
export const slug = (name) => name.trim().toLowerCase().replace(/\s+/g, '-');

// Public endpoint metadata generated from config/config.yaml at build time.
let metaPromise;
export function loadMeta() {
  metaPromise ??= getJSON('/endpoints.json')
    .then((list) => new Map(list.map((m, i) => [gatusKey(m.group, m.name), { ...m, order: i }])))
    .catch(() => new Map());
  return metaPromise;
}

// --- results and conditions ------------------------------------------------------------------

export function latestResult(status) {
  const results = status?.results || [];
  let latest = null;
  for (const r of results) if (!latest || Date.parse(r.timestamp) > Date.parse(latest.timestamp)) latest = r;
  return latest;
}

export function resultState(result) {
  if (!result) return 'none';
  if (result.success) return 'up';
  const failed = (result.conditionResults || []).filter((c) => !c.success);
  const softOnly = failed.length > 0 && failed.every((c) => SOFT_CONDITIONS.some((p) => c.condition.startsWith(p)));
  return softOnly ? 'deg' : 'down';
}

export function failedParams(result) {
  return (result?.conditionResults || []).filter((c) => !c.success).map((c) => parseCondition(c.condition).param);
}

// Gatus prints resolved values in parentheses: "[STATUS] (200) == 200".
const OPERATORS = [' == ', ' != ', ' <= ', ' >= ', ' > ', ' < '];
export function parseCondition(text) {
  for (const op of OPERATORS) {
    const i = text.indexOf(op);
    if (i < 0) continue;
    const left = splitResolved(text.slice(0, i));
    const right = splitResolved(text.slice(i + op.length));
    return { param: left.param, value: left.value, expr: `${left.param}${op}${right.param}` };
  }
  return { param: text, value: null, expr: text };
}
function splitResolved(part) {
  const m = /^(.*?) \((.*)\)$/.exec(part);
  return m ? { param: m[1], value: m[2] } : { param: part, value: null };
}

export function formatConditionValue(param, value) {
  if (value == null || value === '') return '';
  if (param === '[RESPONSE_TIME]') return `${value} ms`;
  if (param === '[CERTIFICATE_EXPIRATION]') {
    const ms = parseGoDuration(value);
    return ms == null ? value : ms > 0 ? formatRemaining(ms) : '—';
  }
  return value;
}

// Remaining certificate lifetime from the [CERTIFICATE_EXPIRATION] condition, if present.
// Gatus reports 0s when it got no certificate at all (connection failed), so 0 means unknown.
export function certRemainingMs(result) {
  for (const c of result?.conditionResults || []) {
    const { param, value } = parseCondition(c.condition);
    if (param !== '[CERTIFICATE_EXPIRATION]' || value == null) continue;
    const ms = parseGoDuration(value);
    return ms > 0 ? ms : null;
  }
  return null;
}

// "1608h19m48s", "5m", "60s" -> milliseconds
const UNIT_MS = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: MINUTE, h: HOUR };
export function parseGoDuration(text) {
  if (typeof text !== 'string' || !/^-?(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(text)) return null;
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(m[1]) * UNIT_MS[m[2]];
  return text.startsWith('-') ? -total : total;
}

// --- history from events ---------------------------------------------------------------------

// Gatus records an event whenever an endpoint flips between passing and failing (plus START
// once). That is enough to rebuild failure intervals for as long as the events are kept.
export function buildHistory(events, now, { days = 90, currentState = 'up' } = {}) {
  const list = (events || [])
    .map((e) => ({ type: e.type, t: Date.parse(e.timestamp) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const changes = list.filter((e) => e.type === 'HEALTHY' || e.type === 'UNHEALTHY');
  if (!changes.length) return null;
  const start = list.find((e) => e.type === 'START');
  const from = start ? start.t : changes[0].t;

  const outages = [];
  changes.forEach((e, i) => {
    if (e.type !== 'UNHEALTHY') return;
    const next = changes[i + 1];
    const end = next ? next.t : now;
    const ongoing = !next;
    // An ongoing problem is shown as what it is right now; a finished one by how long it lasted.
    const severity = ongoing && (currentState === 'deg' || currentState === 'down')
      ? currentState
      : end - e.t < BLIP_MS ? 'deg' : 'down';
    outages.push({ start: e.t, end, ongoing, severity });
  });

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const out = [];
  let observed = 0;
  let failing = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const d1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i + 1);
    const s = Math.max(d0.getTime(), from);
    const e = Math.min(d1.getTime(), now);
    if (e <= s) {
      out.push({ date: d0, state: 'none', failMs: 0 });
      continue;
    }
    let fail = 0;
    let state = 'up';
    for (const o of outages) {
      const overlap = Math.min(e, o.end) - Math.max(s, o.start);
      if (overlap <= 0) continue;
      fail += overlap;
      if (RANK[o.severity] > RANK[state]) state = o.severity;
    }
    observed += e - s;
    failing += fail;
    out.push({ date: d0, state, failMs: fail });
  }
  const current = outages.find((o) => o.ongoing);
  return {
    days: out,
    from,
    observedMs: observed,
    uptime: observed > 0 ? 1 - failing / observed : null,
    failingSince: current ? current.start : null,
  };
}

export function emptyDays(now, days = 90) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i)),
    state: 'none',
    failMs: 0,
  }));
}

export function dayLabel(day, extra = '') {
  const date = `${MONTHS[day.date.getMonth()]} ${day.date.getDate()}`;
  const text = {
    none: 'no data',
    up: 'no incidents',
    deg: `degraded · ${formatDuration(day.failMs)}`,
    down: `downtime · ${formatDuration(day.failMs)}`,
  }[day.state];
  return `${date} · ${text}${extra}`;
}

// --- formatting ------------------------------------------------------------------------------

export function formatPercent(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  if (ratio >= 1) return '100%';
  return `${(Math.floor(Math.max(0, ratio) * 10000) / 100).toFixed(2)}%`;
}

export function formatDuration(ms) {
  if (ms < MINUTE) return '<1 min';
  const totalMin = Math.round(ms / MINUTE);
  if (totalMin < 60) return `${totalMin} min`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 48) return totalMin % 60 ? `${totalH} h ${totalMin % 60} min` : `${totalH} h`;
  const d = Math.floor(totalH / 24);
  return totalH % 24 ? `${d} d ${totalH % 24} h` : `${d} d`;
}

export function formatRemaining(ms, long = false) {
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY);
    return long ? `${d} ${d === 1 ? 'day' : 'days'}` : `${d} d`;
  }
  const h = Math.max(1, Math.floor(ms / HOUR));
  return long ? `${h} ${h === 1 ? 'hour' : 'hours'}` : `${h} h`;
}

export function formatInterval(ms) {
  if (ms == null) return '';
  if (ms <= MINUTE) return `${Math.round(ms / 1000)} s`;
  if (ms % HOUR === 0) return `${ms / HOUR} h`;
  return `${Math.round(ms / MINUTE)} min`;
}

export function formatWindow(ms) {
  if (ms >= 89.5 * DAY) return '90 days';
  if (ms >= DAY) {
    const d = Math.round(ms / DAY);
    return `${d} ${d === 1 ? 'day' : 'days'}`;
  }
  const h = Math.max(1, Math.round(ms / HOUR));
  return `${h} h`;
}

export function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

const pad = (n) => String(n).padStart(2, '0');
export const formatClock = (d, seconds = true) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;

export function formatStamp(d) {
  const tz = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${formatClock(d, false)}${tz ? ` ${tz}` : ''}`;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// --- DOM -------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function build(el, attrs, children) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
export const h = (tag, attrs, ...children) => build(document.createElement(tag), attrs, children);
export const svg = (tag, attrs, ...children) => build(document.createElementNS(SVG_NS, tag), attrs, children);
export const $ = (sel) => document.querySelector(sel);

export function chip(state, label) {
  return h('span', { class: `chip ${state}` }, label);
}
