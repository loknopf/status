import {
  $, h, svg, chip, getJSON, getText, endpointPath, loadMeta, latestResult, resultState, parseCondition,
  formatConditionValue, certRemainingMs, formatPercent, formatRemaining, formatDuration, formatInterval,
  formatClock, parseGoDuration, slug, HttpError, STATE_LABEL, REFRESH_MS, HOUR,
} from './common.js';

const key = new URLSearchParams(location.search).get('key') || '';
const CHART_W = 960;
const CHART_H = 200;

async function refresh() {
  if (!key) return notFound();
  const base = endpointPath(key);
  const [status, meta, u24, u7, u30, rt7, history] = await Promise.allSettled([
    getJSON(`${base}/statuses?pageSize=8`),
    loadMeta(),
    getText(`${base}/uptimes/24h`),
    getText(`${base}/uptimes/7d`),
    getText(`${base}/uptimes/30d`),
    getText(`${base}/response-times/7d`),
    getJSON(`${base}/response-times/24h/history`),
  ]);
  if (status.status === 'rejected') {
    if (status.reason instanceof HttpError && status.reason.status === 404) return notFound();
    $('#target').textContent = 'Status API unreachable, retrying every 60 s';
    return;
  }
  const st = status.value;
  const latest = latestResult(st);
  const value = (r) => (r.status === 'fulfilled' ? r.value : null);
  renderHero(st, latest, value(meta)?.get(st.key));
  renderStats(latest, value(u24), value(u7), value(u30), value(rt7));
  renderChart(value(history));
  renderConditions(latest);
  renderApi(st.key);
  renderChecks(st.results || []);
  $('#detail').hidden = false;
}

function notFound() {
  document.title = 'Not found · loknopf.dev status';
  $('#prompt').textContent = `$ status services/${key}`;
  $('#name').textContent = 'Not found';
  $('#pill').hidden = true;
  $('#target').textContent = key ? `No check has the key "${key}".` : 'No service selected.';
  $('#detail').hidden = true;
}

function renderHero(st, latest, meta) {
  const state = resultState(latest);
  document.title = `${st.name} · loknopf.dev status`;
  $('#prompt').textContent = `$ status services/${slug(st.name)}`;
  $('#name').textContent = st.name;
  const pill = $('#pill');
  pill.className = `chip ${state}`;
  pill.textContent = state === 'down' ? `down for ${formatDuration(Date.now() - failingSince(st, latest))}` : STATE_LABEL[state];
  pill.hidden = false;

  const every = meta ? ` · every ${formatInterval(parseGoDuration(meta.interval))}` : '';
  let target;
  if (!meta?.url) target = `${meta?.method || 'GET'} · hostname hidden`;
  else if (meta.url.startsWith('tls://')) target = `TLS ${meta.url.slice('tls://'.length)}`;
  else target = `${meta.method || 'GET'} ${meta.url}`;
  $('#target').textContent = `${target}${every}`;
}

function failingSince(st, latest) {
  const last = (st.events || []).filter((e) => e.type !== 'START').at(-1);
  if (last?.type === 'UNHEALTHY') return Date.parse(last.timestamp);
  return latest ? Date.parse(latest.timestamp) : Date.now();
}

function renderStats(latest, u24, u7, u30, rt7) {
  const uptime = (text) => (latest && text != null ? formatPercent(Number.parseFloat(text)) : '—');
  const avg = Number.parseInt(rt7, 10);
  const cert = certRemainingMs(latest);
  const stats = [
    ['Uptime 24 h', uptime(u24)],
    ['Uptime 7 d', uptime(u7)],
    ['Uptime 30 d', uptime(u30)],
    ['Avg response 7 d', latest && avg > 0 ? `${avg} ms` : '—'],
    ['Certificate expires', cert == null ? '—' : `in ${formatRemaining(cert)}`],
  ];
  $('#stats').replaceChildren(...stats.map(([label, val]) =>
    h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, val))));
}

// Gatus' history endpoint returns hourly averages; hours without checks come back as 0.
function renderChart(data) {
  const ts = data?.timestamps || [];
  const vals = data?.values || [];
  const now = Date.now();
  const points = ts.map((t, i) => ({ t: t + HOUR / 2, v: vals[i] })).filter((p) => p.v > 0);
  const x0 = ts.length ? ts[0] : now - 24 * HOUR;
  const x1 = Math.max(now, x0 + HOUR);
  const max = Math.max(0, ...points.map((p) => p.v));
  const top = niceTop(max);

  const x = (t) => Math.round(((Math.min(t, x1) - x0) / (x1 - x0)) * CHART_W);
  const y = (v) => Math.round(CHART_H - (v / top) * CHART_H);

  // Split the line where hours have no data.
  const segments = [];
  let seg = [];
  ts.forEach((t, i) => {
    if (vals[i] > 0) seg.push([x(t + HOUR / 2), y(vals[i])]);
    else if (seg.length) { segments.push(seg); seg = []; }
  });
  if (seg.length) segments.push(seg);

  $('#rt-series').replaceChildren(...segments.flatMap((s) => {
    const pts = s.length === 1 ? [[s[0][0] - 6, s[0][1]], [s[0][0] + 6, s[0][1]]] : s;
    const line = pts.map((p) => p.join(',')).join(' ');
    return [
      svg('polygon', { class: 'area', points: `${pts[0][0]},${CHART_H} ${line} ${pts.at(-1)[0]},${CHART_H}` }),
      svg('polyline', { class: 'line', points: line, 'vector-effect': 'non-scaling-stroke' }),
    ];
  }));

  $('#rt-y').replaceChildren(...[4, 3, 2, 1, 0].map((k) => h('span', null, String((top / 4) * k))));
  $('#rt-x').replaceChildren(...[0, 1, 2, 3].map((k) => {
    const d = new Date(x0 + ((x1 - x0) * k) / 4);
    return h('span', null, `${String(d.getHours()).padStart(2, '0')}:00`);
  }), h('span', null, 'now'));

  if (!points.length) {
    $('#rt-meta').textContent = 'last 24 h · no data yet';
    $('#rt-svg').setAttribute('aria-label', 'No response time data for the last 24 hours yet');
    return;
  }
  const mean = Math.round(points.reduce((a, p) => a + p.v, 0) / points.length);
  const min = Math.min(...points.map((p) => p.v));
  $('#rt-meta').textContent = `last 24 h · hourly average · avg ${mean} ms · peak ${max} ms`;
  $('#rt-svg').setAttribute('aria-label',
    `Hourly average response time over the last 24 hours, between ${min} and ${max} milliseconds`);
}

function niceTop(max) {
  const target = Math.max(100, max * 1.15) / 4;
  const mag = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= target);
  return step * 4;
}

function renderConditions(latest) {
  const list = latest?.conditionResults || [];
  const items = list.map((c) => {
    const { param, value, expr } = parseCondition(c.condition);
    const actual = param === '[STATUS]' && value === '0' ? noResponse(latest) : formatConditionValue(param, value);
    return h('div', { class: 'cond' },
      h('span', { class: `cond-tag ${c.success ? 'fg-up' : 'fg-down'}` }, c.success ? '[ OK ]' : '[FAIL]'),
      h('span', { class: 'cond-expr' }, expr),
      h('span', { class: 'cond-actual' }, actual));
  });
  for (const err of latest?.errors || []) {
    items.push(h('div', { class: 'cond' },
      h('span', { class: 'cond-tag fg-down' }, '[ERR ]'),
      h('span', { class: 'cond-expr' }, err)));
  }
  if (!items.length) items.push(h('p', { class: 'muted' }, latest ? 'No condition details are published for this check.' : 'No checks yet.'));
  $('#conditions').replaceChildren(...items);
}

function renderApi(k) {
  $('#api-key').textContent = k;
  $('#api-statuses').textContent = `GET ${endpointPath(k)}/statuses`;
  $('#api-badge').textContent = `GET ${endpointPath(k)}/uptimes/7d/badge.svg`;
}

const RESULT = { up: 'pass', deg: 'warn', down: 'fail', none: '—' };
const noResponse = (r) => ((r?.errors || []).some((e) => /timeout|deadline exceeded/i.test(e)) ? 'timeout' : 'no response');

function renderChecks(results) {
  const rows = [...results]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 8)
    .map((r) => {
      const state = resultState(r);
      const response = !r.status && r.errors?.length ? noResponse(r) : `${Math.round(r.duration / 1e6)} ms`;
      return h('tr', null,
        h('td', null, h('time', { datetime: r.timestamp }, formatClock(new Date(r.timestamp)))),
        h('td', null, r.status ? String(r.status) : '—'),
        h('td', null, response),
        h('td', null, chip(state, RESULT[state])));
    });
  if (!rows.length) rows.push(h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'No checks yet.')));
  $('#checks').replaceChildren(...rows);
}

refresh();
setInterval(refresh, REFRESH_MS);
