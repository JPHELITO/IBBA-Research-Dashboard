/* ═══════════════════════════════════════════════════════════════════════════════
   quarterly-page.js — a tela da página Quarterly: Season board · Company · Compare · Build a chart.
   As contas (fonte por métrica, LTM, YoY, câmbio, calendário, unit economics, índices, Excel) moram em
   quarterly-view.js e têm teste próprio; aqui é rota, desenho, Chart.js e download. Tudo que vem do
   modelo passa por esc().
   ⚠️ O hash é lido ANTES de qualquer await (lição da aba antiga: o gate reescrevia o endereço).
   ⚠️ get_quarterly_metric aceita 1 a 3 chaves por chamada (QV.metricKeys) — pedir 4 deixava o Compare
      em branco em produção, com o erro engolido no console.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
const S = { view: 'board', ccy: 'rep', basis: 'q', win: 12, q: null, season: null, currentQ: null, co: null,
  metric: 'adj_ebitda', mode: 'lvl', ctype: 'line', sel: null, layers: null,
  cos: [], fx: {}, events: {}, full: {}, fullP: {}, metricRes: {}, bench: null, benchP: null, benchOn: true,
  chartSeries: {}, chartMeta: {}, chartLayers: {}, coType: {}, cmpOpts: null };
const charts = {};
const SEC_LABEL = { steel: 'Steel', iron_ore: 'Iron ore', copper: 'Copper', gold: 'Gold', pulp_paper: 'Pulp & Paper' };
const SEC_ORDER = ['steel', 'iron_ore', 'copper', 'gold', 'pulp_paper'];
// a paleta da casa (M&M / P&P): laranja, preto, azul, verde, roxo, âmbar… — o preto vira branco no escuro
const PALETTE = ['#FF5000', '#1A1A1A', '#4A90D9', '#27AE60', '#8E44AD', '#E67E22', '#16A085', '#C0392B', '#7F8C8D', '#2E86C1', '#D4AC0D', '#A04000', '#48C9B0', '#5D6D7E'];
const CCY_SHORT = { BRL: 'R$', USD: 'US$', CLP: 'CLP', MXN: 'MXN' };
const HEADLINE = [['revenue', 'Net revenue'], ['adj_ebitda', 'Adjusted EBITDA'], ['margin', 'Adj. EBITDA margin'], ['net_income', 'Net income'], ['net_debt', 'Net debt'], ['leverage', 'Net debt / LTM adj. EBITDA']];
const HEADLINE_IDS = HEADLINE.map(h => h[0]);
const TF_LABEL = { lvl: 'Level', yoy: 'YoY', qoq: 'QoQ', idx: 'Base 100', ltm: 'LTM' };
const $ = id => document.getElementById(id);
const QV = window.QV;

// ── rota ──────────────────────────────────────────────────────────────────────
function readHash() {
  const h = location.hash.replace(/^#/, ''), i = h.indexOf('?');
  const path = (i < 0 ? h : h.slice(0, i)).split('/'), p = new URLSearchParams(i < 0 ? '' : h.slice(i + 1));
  S.view = ['board', 'co', 'cmp', 'build'].includes(path[0]) ? path[0] : 'board';
  if (S.view === 'co' && path[1]) S.co = decodeURIComponent(path[1]).toUpperCase();
  if (S.view === 'cmp' && path[1]) S.metric = decodeURIComponent(path[1]);
  S.ccy = p.get('ccy') === 'usd' ? 'usd' : 'rep';
  S.basis = p.get('basis') === 'ltm' ? 'ltm' : 'q';
  const w = p.get('win'); S.win = w === 'all' ? 'all' : ([8, 12, 20].includes(+w) ? +w : 12);
  if (/^\d{4}Q[1-4]$/.test(p.get('q') || '')) S.q = p.get('q');
  if (['lvl', 'yoy', 'qoq', 'idx'].includes(p.get('mode'))) S.mode = p.get('mode');
  if (['line', 'bar'].includes(p.get('ct'))) S.ctype = p.get('ct');
  if (p.get('cos')) S.sel = p.get('cos').split(',').filter(Boolean);
  if (p.get('s')) S.layers = QV.decodeLayers(p.get('s'));
}
function writeHash() {
  const p = new URLSearchParams();
  if (S.ccy === 'usd') p.set('ccy', 'usd');
  if (S.basis === 'ltm') p.set('basis', 'ltm');
  if (S.win !== 12) p.set('win', S.win);
  if (S.view === 'board' && S.q && S.q !== S.season) p.set('q', S.q);
  if (S.view === 'cmp') { if (S.mode !== 'lvl') p.set('mode', S.mode); if (S.ctype !== 'line') p.set('ct', S.ctype); if (S.sel) p.set('cos', S.sel.join(',')); }
  if (S.view === 'build' && S.layers && S.layers.length) p.set('s', QV.encodeLayers(S.layers));
  const path = S.view === 'co' ? 'co/' + encodeURIComponent(S.co || '') : S.view === 'cmp' ? 'cmp/' + encodeURIComponent(S.metric) : S.view;
  const h = '#' + path + (String(p) ? '?' + p : '');
  if (location.hash !== h) history.replaceState(null, '', h);
}

// ── gráficos ──────────────────────────────────────────────────────────────────
const isDark = () => document.documentElement.classList.contains('dark');
const MOBILE = () => window.matchMedia('(max-width:700px)').matches;
function pal(i) { const c = PALETTE[Math.abs(i) % PALETTE.length]; return c === '#1A1A1A' && isDark() ? '#E6E6E6' : c; }
function colorOf(ticker) { const i = S.cos.findIndex(c => c.ticker === ticker); return pal(i < 0 ? 0 : i); }
function themeChart() {
  if (!window.Chart) return;
  Chart.defaults.locale = 'en-US';
  Chart.defaults.color = isDark() ? '#aab1bb' : '#666';
  Chart.defaults.borderColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
  Chart.defaults.font.family = "'Inter','Segoe UI',sans-serif";
}
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
function tick(kind) {
  return v => kind === 'pct' ? (v * 100).toFixed(0) + '%' : kind === 'x' ? v.toFixed(1) + 'x' : kind === 'idx' ? v.toFixed(0) : Math.abs(v) >= 1000 ? compact.format(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtK(v, kind) { return kind === 'idx' ? (v == null ? '—' : v.toFixed(1)) : QV.fmt(v, kind === 'pct' ? 'chg' : kind); }
// anotações do analista (quebra de série, parada) desenhadas no próprio gráfico → saem no PNG
const notesPlugin = {
  id: 'qnotes',
  afterDatasetsDraw(chart) {
    const n = chart.options.plugins && chart.options.plugins.qnotes; if (!n || !n.length) return;
    const { ctx, chartArea: a, scales } = chart, x = scales.x; if (!x) return;
    ctx.save(); ctx.strokeStyle = isDark() ? 'rgba(255,255,255,.4)' : 'rgba(0,0,0,.38)'; ctx.fillStyle = ctx.strokeStyle;
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.font = "600 9px 'Inter',sans-serif";
    n.forEach(p => { const xp = x.getPixelForValue(p.idx); if (!(xp >= a.left && xp <= a.right)) return;
      ctx.beginPath(); ctx.moveTo(xp, a.top); ctx.lineTo(xp, a.bottom); ctx.stroke(); ctx.fillText(p.short, xp + 3, a.top + 10); });
    ctx.restore();
  }
};
function opts(o) {
  o = o || {};
  const grid = { color: isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' };
  const t = { color: isDark() ? '#9aa1ab' : '#8c8c8c', font: { size: MOBILE() ? 8.5 : 9.5 }, maxRotation: 0 };
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: o.legend !== false, position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 10, font: { size: 10 }, padding: 8 } },
      tooltip: { backgroundColor: '#1A1A1A', titleColor: 'rgba(255,255,255,.75)', bodyColor: '#fff', padding: 9, cornerRadius: 8,
        callbacks: { label: o.label || (c => ' ' + c.dataset.label + ': ' + fmtK(c.parsed.y, c.dataset._kind || o.kind || 'num')) } },
      qnotes: o.notes || []
    },
    scales: {
      x: Object.assign({ ticks: Object.assign({}, t, { maxTicksLimit: MOBILE() ? 6 : 12 }), grid: { display: false }, border: { display: false }, stacked: !!o.stacked }, o.x || {}),
      y: Object.assign({ ticks: Object.assign({}, t, { callback: tick(o.kind), maxTicksLimit: 6 }), grid: grid, border: { display: false }, stacked: !!o.stacked, beginAtZero: o.zero !== false }, o.y || {})
    }
  };
  if (o.y2) base.scales.y2 = Object.assign({ position: 'right', ticks: Object.assign({}, t, { callback: tick(o.y2kind), maxTicksLimit: 6 }), grid: { display: false }, border: { display: false }, beginAtZero: o.zero2 !== false }, o.y2);
  if (o.indexAxis) base.indexAxis = o.indexAxis;
  return base;
}
function mkChart(id, type, labels, datasets, o) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  const cv = $(id); if (!cv || !window.Chart) return null;
  charts[id] = new Chart(cv.getContext('2d'), { type: type, data: { labels: labels, datasets: datasets }, options: opts(o), plugins: [notesPlugin] });
  return charts[id];
}
function killCharts(prefix) { Object.keys(charts).forEach(k => { if (k.indexOf(prefix) === 0) { charts[k].destroy(); delete charts[k]; } }); }
function attachExports(prefix) {
  const X = window.IBBAExport; if (!X || !X.attachChartjsExports) return;
  X.attachChartjsExports({ charts: charts, cardSelector: '.chart-card', prefix: prefix, alwaysVisible: true,
    titleOf: id => (S.chartMeta[id] || {}).title, fullAOA: id => fullAOA(id) });
}
// Excel de um gráfico = as mesmas séries, histórico inteiro (não a janela)
function fullAOA(id) {
  const list = S.chartSeries[id]; if (!list || !list.length) return null;
  const qs = QV.qRange(QV.minQ(list.flatMap(s => Object.keys(s.vals))), QV.maxQ(list.flatMap(s => Object.keys(s.vals))));
  const aoa = [['Quarter'].concat(list.map(s => s.label + (s.unit ? ' (' + QV.unitLabel(s.unit) + ')' : '')))];
  qs.forEach(q => aoa.push([QV.qShort(q)].concat(list.map(s => s.vals[q] == null ? '' : s.vals[q]))));
  return aoa;
}
function download(aoa, sheet, file) {
  const X = window.IBBAExport;
  if (!X || !X.xlsxFromAOA) { alert('Download is not available right now.'); return; }
  X.xlsxFromAOA([{ name: sheet.slice(0, 31), aoa: aoa }], file).catch(() => alert('Could not build the Excel file.'));
}
let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }

// ── séries na moeda e base escolhidas ─────────────────────────────────────────
function inCcy(ser) {
  if (!ser || S.ccy !== 'usd') return ser;
  if (ser.kind === 'pct' || ser.kind === 'x' || ser.kind === 'fx' || !ser.ccy || ser.ccy === 'USD') return ser;
  return QV.toUsd(ser, S.fx) || Object.assign({}, ser, { vals: {}, noFx: true });
}
function ser(co, id, basis) { return inCcy(QV.basis(co, id, basis || S.basis)); }
function windowQs(endQ) {
  if (!endQ) return [];
  const all = S.win === 'all' ? null : S.win;
  const first = all ? QV.qAdd(endQ, -(all - 1)) : null;
  return first ? QV.qRange(first, endQ) : null;
}
function chgCell(v, kind) {
  if (v == null) return '<span class="flat">—</span>';
  const cls = Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'up' : 'down';
  return '<span class="' + cls + '">' + QV.fmt(v, kind) + '</span>';
}
// P = número do filed que ocupa o lugar do modelo (receita/dívida depois do corte). No lucro o filed é a
// fonte oficial, não preliminar → quem chama passa prelim=false.
function valCell(s, q, kind, prelim) {
  if (!s || s.vals[q] == null) return '—';
  const p = prelim !== false && s.src && s.src[q] === 'filed' ? '<span class="tag p" title="As filed with the CVM/SEC — preliminary until the company model is updated">P</span>' : '';
  return QV.fmt(s.vals[q], kind) + p;
}
function notesFor(co, qs) {
  return (co.notes || []).map(n => ({ idx: qs.indexOf(n.q_from), short: n.kind === 'break' ? 'break' : n.kind === 'stoppage' ? 'stoppage' : 'note' })).filter(n => n.idx >= 0);
}
// último valor da série dentro da janela + variação YoY (o "stat" do cabeçalho do gráfico)
function statOf(s, qs, kind, dk) {
  if (!s) return '';
  const lq = QV.maxQ(Object.keys(s.vals).filter(q => !qs || qs.includes(q))); if (!lq) return '';
  const v = s.vals[lq]; if (v == null) return '';
  const d = dk === 'pp' ? QV.delta(s.vals, lq, 4) : dk === 'dx' ? QV.delta(s.vals, lq, 4) : QV.change(s.vals, lq, 4);
  return '<span class="chart-stat">' + esc(QV.qShort(lq)) + ' ' + QV.fmt(v, kind) + (kind === 'money' || kind === 'price' || kind === 'volume' ? ' <span class="muted">' + esc(QV.unitLabel(s.unit)) + '</span>' : '') +
    '<span class="yoy">' + chgCell(d, dk || 'chg') + ' <span class="muted">YoY</span></span></span>';
}

// ── dados sob demanda ─────────────────────────────────────────────────────────
async function loadCompany(t) {
  if (S.full[t]) return S.full[t];
  if (!S.fullP[t]) S.fullP[t] = (async () => {
    const res = await rpc('get_quarterly_company', { p_ticker: t });
    const co = QV.fromCompany(res);
    if (co) { S.full[t] = co; if (res.fx) Object.keys(res.fx).forEach(k => { S.fx[k] = Object.assign({}, S.fx[k] || {}, res.fx[k]); }); }
    return co;
  })().finally(() => { delete S.fullP[t]; });
  return S.fullP[t];
}
async function metricRes(keys) {
  keys = (keys || []).slice(0, 3);
  const k = keys.slice().sort().join(',');
  if (!S.metricRes[k]) S.metricRes[k] = rpc('get_quarterly_metric', { p_keys: keys }).catch(e => { delete S.metricRes[k]; throw e; });
  return S.metricRes[k];
}
// índices livres (62% do TE, cobre e ouro do Yahoo) → média trimestral; uma leitura por visita
async function loadBench() {
  if (S.bench) return S.bench;
  if (!S.benchP) S.benchP = (async () => {
    const out = {};
    try {
      const rows = await restGet('commodities?select=code,unit,daily&code=in.(' + QV.BENCH_CODES.join(',') + ')');
      (rows || []).forEach(r => { if (QV.BENCH[r.code]) out[r.code] = { unit: r.unit || QV.BENCH[r.code].unit, q: QV.benchQuarterly(r.daily, S.currentQ) }; });
    } catch (e) { console.warn('benchmarks', e); }
    S.bench = out; return out;
  })();
  return S.benchP;
}

// ════════════════════════════ SEASON BOARD ════════════════════════════════════
function renderBoard() {
  const q = S.q || S.season;
  const sel = $('b-q');
  const opts12 = S.season ? QV.qRange(QV.qAdd(S.season, -11), S.season).reverse() : [];
  sel.innerHTML = opts12.map(x => '<option value="' + x + '"' + (x === q ? ' selected' : '') + '>' + QV.qShort(x) + '</option>').join('');
  $('b-title').textContent = 'Season board · ' + QV.qShort(q);
  const n = S.cos.filter(c => QV.status(c, q).kind === 'model').length, f = S.cos.filter(c => QV.status(c, q).kind === 'filed').length;
  $('b-sub').textContent = n + ' of ' + S.cos.length + ' with the full model' + (f ? ' · ' + f + ' filed, preliminary' : '') + (S.basis === 'ltm' ? ' · LTM' : '') + (S.ccy === 'usd' ? ' · US$' : '');
  const rows = S.cos.map(co => boardRow(co, q));
  const head = '<thead><tr><th>Company</th><th style="text-align:left">Status</th><th>Net revenue</th><th>YoY</th><th>Adj. EBITDA</th><th>YoY</th>' +
    '<th>Margin</th><th>Δ YoY</th><th>Net income</th><th>YoY</th><th title="Net debt / LTM adjusted EBITDA">ND / EBITDA</th><th>Volume</th><th>YoY</th><th>Adj. EBITDA, 8Q</th></tr></thead>';
  let body = '';
  SEC_ORDER.concat([...new Set(S.cos.map(c => c.sector))].filter(s => !SEC_ORDER.includes(s))).forEach(sec => {
    const rs = rows.filter(r => r.co.sector === sec); if (!rs.length) return;
    body += '<tr><td class="sec-h" colspan="14">' + esc(SEC_LABEL[sec] || sec || 'Other') + '</td></tr>';
    rs.forEach(r => {
      body += '<tr class="clk" data-t="' + esc(r.co.ticker) + '"><td class="co"><b>' + esc(r.co.name) + '</b><span class="tk">' + esc(r.co.ticker) + '</span>' +
        '<span class="tag" title="Reporting currency">' + esc(r.ccyTxt) + '</span></td>' +
        '<td style="text-align:left"><span class="st ' + r.st.kind + '"><i></i>' + esc(r.st.text) + '</span></td>' +
        '<td>' + valCell(r.rev, q, 'money') + '</td><td>' + chgCell(r.revY, 'chg') + '</td>' +
        '<td>' + valCell(r.eb, q, 'money') + '</td><td>' + chgCell(r.ebY, 'chg') + '</td>' +
        '<td>' + valCell(r.mg, q, 'pct') + '</td><td>' + chgCell(r.mgD, 'pp') + '</td>' +
        '<td>' + valCell(r.ni, q, 'money', false) + '</td><td>' + chgCell(r.niY, 'chg') + '</td>' +
        '<td>' + (r.lev && r.lev.vals[q] != null ? QV.fmt(r.lev.vals[q], 'x') : '—') + '</td>' +
        '<td title="' + esc(r.volLabel) + '">' + (r.vol && r.vol.vals[q] != null ? QV.fmt(r.vol.vals[q], 'volume') + ' <span class="muted">' + esc(QV.unitLabel(r.vol.unit)) + '</span>' : '—') + '</td>' +
        '<td>' + chgCell(r.volY, 'chg') + '</td><td>' + spark(r.trend) + '</td></tr>';
    });
  });
  $('b-table').innerHTML = head + '<tbody>' + body + '</tbody>';
  $('b-table').querySelectorAll('tr.clk').forEach(tr => tr.onclick = () => go('co', tr.dataset.t));
  // celular: cartões
  $('b-cards').innerHTML = rows.map(r => '<div class="bcard" data-t="' + esc(r.co.ticker) + '"><div class="h"><b>' + esc(r.co.name) + '</b><span class="st ' + r.st.kind + '"><i></i>' + esc(r.st.text) + '</span></div>' +
    '<div class="g"><div><span>Net revenue</span>' + valCell(r.rev, q, 'money') + ' ' + chgCell(r.revY, 'chg') + '</div>' +
    '<div><span>Adj. EBITDA</span>' + valCell(r.eb, q, 'money') + ' ' + chgCell(r.ebY, 'chg') + '</div>' +
    '<div><span>Margin</span>' + valCell(r.mg, q, 'pct') + ' ' + chgCell(r.mgD, 'pp') + '</div>' +
    '<div><span>Net income</span>' + valCell(r.ni, q, 'money', false) + '</div></div></div>').join('');
  $('b-cards').querySelectorAll('.bcard').forEach(c => c.onclick = () => go('co', c.dataset.t));
  $('b-foot').innerHTML = 'Values in each company\'s reporting currency (R$ or US$ mn) unless US$ is selected. Adjusted EBITDA and operating data come from Itaú BBA\'s company models; ' +
    'net income is the figure filed with the CVM/SEC where it is in the reporting currency. <b>P</b> = as filed, preliminary (after the latest model quarter). ' +
    'Margin change in percentage points; ND / EBITDA = net debt over LTM adjusted EBITDA. YoY is not shown when the base is zero or negative.' +
    (S.ccy === 'usd' ? ' US$: flows at the quarter\'s average PTAX, net debt at the quarter-end rate.' : '');
  $('b-xls').onclick = () => download(boardAOA(rows, q), 'Season board ' + QV.qShort(q), 'quarterly_board_' + q);
}
function boardRow(co, q) {
  const rev = ser(co, 'revenue'), eb = ser(co, 'adj_ebitda'), ni = ser(co, 'net_income');
  const mg = QV.basis(co, 'margin', S.basis), lev = QV.pick(co, 'leverage');
  const vk = QV.headlineKey(co, 'sales_volume'), vol = vk ? QV.basis(co, vk, S.basis) : null;
  const t8 = QV.qRange(QV.qAdd(q, -7), q);
  return { co: co, st: QV.status(co, q, S.events[co.ticker]), ccyTxt: S.ccy === 'usd' ? 'US$' : (CCY_SHORT[QV.reportingCcy(co)] || QV.reportingCcy(co)),
    rev: rev, revY: rev && QV.change(rev.vals, q, 4), eb: eb, ebY: eb && QV.change(eb.vals, q, 4), mg: mg, mgD: QV.delta(mg.vals, q, 4),
    ni: ni, niY: ni && QV.change(ni.vals, q, 4), lev: lev, vol: vol, volY: vol && QV.change(vol.vals, q, 4), volLabel: vol ? vol.label : '',
    trend: t8.map(x => eb && eb.vals[x] != null ? eb.vals[x] : null) };
}
function boardAOA(rows, q) {
  const aoa = [['Company', 'Ticker', 'Status', 'Currency', 'Net revenue', 'Revenue YoY', 'Adj. EBITDA', 'Adj. EBITDA YoY', 'Margin', 'Margin Δ YoY (pp)',
    'Net income', 'Net income YoY', 'ND / LTM EBITDA (x)', 'Volume', 'Volume unit', 'Volume YoY']];
  const v = (s) => s && s.vals[q] != null ? s.vals[q] : '';
  rows.forEach(r => aoa.push([r.co.name, r.co.ticker, r.st.text, r.ccyTxt, v(r.rev), r.revY == null ? '' : r.revY, v(r.eb), r.ebY == null ? '' : r.ebY,
    v(r.mg), r.mgD == null ? '' : r.mgD * 100, v(r.ni), r.niY == null ? '' : r.niY, v(r.lev), v(r.vol), r.vol ? QV.unitLabel(r.vol.unit) : '', r.volY == null ? '' : r.volY]));
  aoa.push([]); aoa.push(['Quarter: ' + QV.qShort(q) + (S.basis === 'ltm' ? ' · LTM' : '') + '. Source: Itaú BBA company models; net income as filed (CVM/SEC) where in the reporting currency.']);
  return aoa;
}
function spark(vals) {
  const v = vals.filter(x => x != null); if (v.length < 2) return '';
  const mn = Math.min.apply(null, v), mx = Math.max.apply(null, v), W = 96, H = 22;
  let d = '', pen = false;
  vals.forEach((x, i) => { if (x == null) { pen = false; return; }
    const px = (i / (vals.length - 1) * W).toFixed(1), py = (H - 2 - (mx === mn ? 0.5 : (x - mn) / (mx - mn)) * (H - 4)).toFixed(1);
    d += (pen ? 'L' : 'M') + px + ' ' + py; pen = true; });
  return '<svg class="spark" viewBox="0 0 96 22" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="#FF5000" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
}

// ════════════════════════════ COMPANY ═════════════════════════════════════════
async function renderCompany() {
  if (!S.co || !S.cos.some(c => c.ticker === S.co)) S.co = S.cos[0] && S.cos[0].ticker;
  const pick = $('c-pick');
  pick.innerHTML = SEC_ORDER.map(sec => { const cs = S.cos.filter(c => c.sector === sec); return cs.length ? '<optgroup label="' + esc(SEC_LABEL[sec]) + '">' +
    cs.map(c => '<option value="' + esc(c.ticker) + '"' + (c.ticker === S.co ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</optgroup>' : ''; }).join('');
  pick.onchange = () => go('co', pick.value);
  killCharts('c-');
  $('c-charts').innerHTML = ''; $('c-kpis').innerHTML = '<div class="empty" style="grid-column:1/-1">Loading…</div>'; $('c-table').innerHTML = '';
  const t = S.co, co = await loadCompany(t);
  if (S.view !== 'co' || S.co !== t) return;                       // o usuário já trocou de tela
  if (!co) { $('c-kpis').innerHTML = '<div class="empty" style="grid-column:1/-1">No data for this company yet.</div>'; return; }
  const all = ['revenue', 'adj_ebitda', 'net_income'].flatMap(id => Object.keys(QV.pick(co, id).vals));
  const lastQ = QV.maxQ(all);
  const rc = QV.reportingCcy(co), cut = co.model && co.model.cutoff_q;
  $('c-sub').textContent = (cut ? 'Model through ' + QV.qShort(cut) : 'No model uploaded yet') +
    (co.filedBy && Object.keys(co.filedBy).length ? ' · filed through ' + QV.qShort(QV.maxQ(Object.keys(co.filedBy))) : '') +
    ' · reports in ' + (CCY_SHORT[rc] || rc) + (S.ccy === 'usd' && rc !== 'USD' ? ' · shown in US$' : '');
  renderKpis(co, lastQ);
  const nt = (co.notes || []);
  $('c-notes').hidden = !nt.length;
  $('c-notes').innerHTML = nt.map(n => '<div><b>' + esc(QV.qShort(n.q_from)) + (n.q_to ? '–' + esc(QV.qShort(n.q_to)) : '') + '</b>' + esc(n.text) + '</div>').join('');
  const qs = S.win === 'all' ? QV.qRange(QV.minQ(all), lastQ) : windowQs(lastQ);
  renderCompanyCharts(co, qs);
  renderCompanyTable(co, qs);
  attachExports('quarterly_' + t);
  $('c-xls').onclick = () => download(QV.aoaCompany(co), co.name, 'quarterly_' + t + '_full_history');
}
function renderKpis(co, q) {
  const K = [['Net revenue', 'revenue', 'money', 'chg'], ['Adj. EBITDA', 'adj_ebitda', 'money', 'chg'], ['Adj. EBITDA margin', 'margin', 'pct', 'pp'],
    ['Net income', 'net_income', 'money', 'chg'], ['Net debt', 'net_debt', 'money', 'chg'], ['ND / LTM EBITDA', 'leverage', 'x', 'dx']];
  ['sales_volume', 'realized_price', 'cash_cost'].forEach(std => { const k = QV.headlineKey(co, std); if (k) K.push([null, k, null, 'chg']); });
  $('c-kpis').innerHTML = K.map(([lab, id, kind, dk]) => {
    const s = id === 'leverage' || id === 'margin' ? QV.basis(co, id, S.basis) : ser(co, id);
    if (!s) return '';
    const lq = QV.maxQ(Object.keys(s.vals).filter(x => !q || QV.qIdx(x) <= QV.qIdx(q))) || null;
    const v = lq ? s.vals[lq] : null; if (v == null) return '';
    const k = kind || QV.kindOf(s.unit);
    const d = dk === 'chg' ? QV.change(s.vals, lq, 4) : QV.delta(s.vals, lq, 4);
    const unit = k === 'money' || k === 'price' || k === 'volume' || k === 'num' ? '<span class="u">' + esc(QV.unitLabel(s.unit)) + '</span>' : '';
    return '<div class="kpi" title="' + esc(s.label) + '"><div class="k">' + esc(lab || s.label) + ' · ' + esc(QV.qShort(lq)) + (s.src && s.src[lq] === 'filed' && id !== 'net_income' ? ' <span class="tag p">P</span>' : '') + '</div>' +
      '<div class="v">' + QV.fmt(v, k) + unit + '</div><div class="d">' + chgCell(d, dk) + ' <span class="muted">YoY</span></div></div>';
  }).join('') || '<div class="empty" style="grid-column:1/-1">No data.</div>';
}
// cartão de gráfico: título · stat (último valor + YoY) · ferramentas (＋ Build, Lines/Bars, Benchmark)
function chartCard(id, title, sub, big, x) {
  x = x || {};
  const d = document.createElement('div');
  d.className = 'card chart-card' + (big ? ' big' : '');
  let tools = '';
  (x.tools || []).forEach((tl, i) => {
    if (tl.seg) tools += '<div class="seg sm" data-tool="' + i + '">' + tl.seg.map(o => '<button data-v="' + esc(o.v) + '"' + (o.v === tl.on ? ' class="on"' : '') + '>' + esc(o.label) + '</button>').join('') + '</div>';
    else tools += '<button class="btn ghost xs' + (tl.on ? ' on' : '') + '" data-tool="' + i + '" title="' + esc(tl.title || '') + '">' + esc(tl.label) + '</button>';
  });
  d.innerHTML = '<div class="chart-head"><span class="chart-title">' + esc(title) + '</span><span class="chart-sub">' + esc(sub || '') + '</span>' + (x.stat || '') +
    '<div class="chart-tools">' + tools + '</div></div><div class="cv"><canvas id="' + id + '"></canvas></div>';
  (x.tools || []).forEach((tl, i) => {
    if (tl.seg) d.querySelectorAll('[data-tool="' + i + '"] button').forEach(b => b.onclick = () => tl.cb(b.dataset.v));
    else { const b = d.querySelector('[data-tool="' + i + '"]'); if (b) b.onclick = tl.cb; }
  });
  $('c-charts').appendChild(d);
  S.chartMeta[id] = { title: title };
  return d;
}
function ds(label, vals, qs, color, extra) {
  return Object.assign({ label: label, data: qs.map(q => vals[q] == null ? null : vals[q]), backgroundColor: color, borderColor: color, borderWidth: 1.6, pointRadius: 0, spanGaps: false }, extra || {});
}
function buildTool(id) {
  return { label: '＋ Build', title: 'Open these series in Build a chart, where you can add companies, benchmarks and a second axis',
    cb: () => { const l = S.chartLayers[id]; if (!l || !l.length) return; S.layers = l.map(x => Object.assign({}, x)); go('build'); } };
}
function renderCompanyCharts(co, qs) {
  const notes = notesFor(co, qs), labels = qs.map(QV.qShort), t = co.ticker;
  const grey = isDark() ? 'rgba(170,177,187,.45)' : 'rgba(115,115,115,.45)', ink = isDark() ? '#e6e6e6' : '#1A1A1A';
  const rev = ser(co, 'revenue'), eb = ser(co, 'adj_ebitda'), mg = QV.basis(co, 'margin', S.basis);
  if (Object.keys(eb.vals).length || Object.keys(rev.vals).length) {
    S.chartLayers['c-ch-pl'] = [{ co: t, key: 'revenue', ty: 'bar' }, { co: t, key: 'adj_ebitda', ty: 'bar' }, { co: t, key: 'margin', ax: 'R' }];
    chartCard('c-ch-pl', 'Revenue and adjusted EBITDA', QV.unitLabel(eb.unit || rev.unit) + (S.basis === 'ltm' ? ' · LTM' : '') + ' · margin on the right', true,
      { stat: statOf(eb, qs, 'money'), tools: [buildTool('c-ch-pl')] });
    mkChart('c-ch-pl', 'bar', labels, [ds('Net revenue', rev.vals, qs, grey), ds('Adj. EBITDA', eb.vals, qs, '#FF5000'),
      ds('Margin', mg.vals, qs, ink, { type: 'line', yAxisID: 'y2', pointRadius: 2, _kind: 'pct' })],
      { kind: 'money', y2: {}, y2kind: 'pct', notes: notes });
    S.chartSeries['c-ch-pl'] = [{ label: 'Net revenue', vals: rev.vals, unit: rev.unit }, { label: 'Adj. EBITDA', vals: eb.vals, unit: eb.unit }, { label: 'Adj. EBITDA margin', vals: mg.vals, unit: '%' }];
  }
  const ni = ser(co, 'net_income');
  if (Object.keys(ni.vals).length) {
    const filedAny = Object.values(ni.src || {}).includes('filed');
    S.chartLayers['c-ch-ni'] = [{ co: t, key: 'net_income', ty: 'bar' }];
    chartCard('c-ch-ni', 'Net income', QV.unitLabel(ni.unit) + (filedAny ? ' · as filed (CVM/SEC)' : ' · company model'), false, { stat: statOf(ni, qs, 'money'), tools: [buildTool('c-ch-ni')] });
    mkChart('c-ch-ni', 'bar', labels, [ds('Net income', ni.vals, qs, qs.map(q => (ni.vals[q] || 0) < 0 ? '#C0392B' : '#27AE60'))], { kind: 'money', legend: false, notes: notes, zero: true });
    S.chartSeries['c-ch-ni'] = [{ label: 'Net income', vals: ni.vals, unit: ni.unit }];
  }
  group(co, qs, notes, 'c-ch-vol', 'Volumes', s => (s.std === 'sales_volume' || s.std === 'production' || /\.vol(\.|$)|^vol(\.|$)/.test(s.key)) && QV.kindOf(s.unit) === 'volume', false);
  group(co, qs, notes, 'c-ch-px', 'Realized prices', s => s.std === 'realized_price' || (s.calc && /\.px(\.|$)|^px(\.|$)/.test(s.key)), true);
  group(co, qs, notes, 'c-ch-cost', 'Cash costs', s => s.std === 'cash_cost', true);
  const segs = (co.series || []).filter(s => s.std === 'segment_ebitda');
  if (segs.length > 1) {
    const conv = segs.map(s => inCcy(Object.assign({ id: s.key, kind: 'money', agg: 'flow' }, s, { vals: s.vals })));
    S.chartLayers['c-ch-seg'] = segs.map(s => ({ co: t, key: s.key, ty: 'bar' }));
    chartCard('c-ch-seg', 'EBITDA by segment', QV.unitLabel(conv[0].unit), false, { tools: [buildTool('c-ch-seg')] });
    mkChart('c-ch-seg', 'bar', labels, conv.map((s, i) => ds(s.label, s.vals, qs, pal(i))), { kind: 'money', stacked: true, notes: notes });
    S.chartSeries['c-ch-seg'] = conv.map(s => ({ label: s.label, vals: s.vals, unit: s.unit }));
  }
  const nd = ser(co, 'net_debt'), lev = QV.pick(co, 'leverage');
  if (Object.keys(nd.vals).length) {
    S.chartLayers['c-ch-nd'] = [{ co: t, key: 'net_debt', ty: 'bar' }, { co: t, key: 'leverage', ax: 'R' }];
    chartCard('c-ch-nd', 'Net debt and leverage', QV.unitLabel(nd.unit) + ' · net debt / LTM adj. EBITDA on the right', false, { stat: statOf(lev, qs, 'x', 'dx'), tools: [buildTool('c-ch-nd')] });
    mkChart('c-ch-nd', 'bar', labels, [ds('Net debt', nd.vals, qs, grey), ds('ND / LTM EBITDA', lev.vals, qs, '#FF5000', { type: 'line', yAxisID: 'y2', pointRadius: 2, _kind: 'x' })],
      { kind: 'money', y2: {}, y2kind: 'x', notes: notes });
    S.chartSeries['c-ch-nd'] = [{ label: 'Net debt', vals: nd.vals, unit: nd.unit }, { label: 'Net debt / LTM adj. EBITDA', vals: lev.vals, unit: 'x' }];
  }
}
// um gráfico com as séries que passam no filtro, na unidade da série de manchete. Linhas ou barras
// (Lines/Bars no cartão); nos preços, o índice livre comparável entra tracejado (Benchmark no cartão).
function group(co, qs, notes, id, title, test, money) {
  let list = (co.series || []).filter(test);
  if (!list.length) return;
  const head = list.find(s => s.headline) || list[0];
  list = list.filter(s => s.unit === head.unit).slice(0, 8);
  const conv = list.map(s => { const x = Object.assign({ id: s.key, kind: QV.kindOf(s.unit), agg: s.agg || 'rate' }, s); return money ? inCcy(x) : x; });
  const kind = QV.kindOf(conv[0].unit), type = S.coType[id] || 'line';
  S.chartLayers[id] = list.map(s => ({ co: co.ticker, key: s.key, ty: type }));
  const tools = [{ seg: [{ v: 'line', label: 'Lines' }, { v: 'bar', label: 'Bars' }], on: type, cb: v => { S.coType[id] = v; render(); } }, buildTool(id)];
  // índice livre para o preço realizado (mesma unidade ou conversão exata; R$ pela PTAX média, avisado)
  let bench = null, sub = QV.unitLabel(conv[0].unit);
  if (id === 'c-ch-px') {
    const hit = conv.find(s => QV.BENCH_FOR[QV.family(s.def)]);
    if (hit) {
      const code = QV.BENCH_FOR[QV.family(hit.def)];
      tools.unshift({ label: 'Benchmark', on: S.benchOn, title: QV.BENCH[code].label + ' — quarterly average of daily closes, dashed', cb: () => { S.benchOn = !S.benchOn; render(); } });
      if (S.benchOn) {
        if (!S.bench) { loadBench().then(() => { if (S.view === 'co' && S.co === co.ticker) render(); }); }
        else if (S.bench[code]) {
          bench = QV.benchSeries(code, S.bench[code].q, S.bench[code].unit, hit.unit, S.fx);
          if (bench) {
            // a "realização" só quando índice e preço estão na mesma moeda e base (Vale, Southern Copper,
            // Aura); preço FOB em R$ contra índice CFR em US$ é referência, não razão
            const lq = bench.fxConverted ? null : QV.maxQ(Object.keys(hit.vals).filter(q => qs.includes(q) && bench.vals[q] != null));
            sub += ' · dashed = ' + bench.label + (lq && hit.vals[lq] ? ' · realization ' + QV.fmt(hit.vals[lq] / bench.vals[lq], 'pct') + ' in ' + QV.qShort(lq) : bench.fxConverted ? ' (reference only: FOB price vs CFR index)' : '');
          }
        }
      }
    }
  }
  chartCard(id, title, sub, false, { stat: statOf(conv.find(s => s.headline) || conv[0], qs, kind), tools: tools });
  const data = conv.map((s, i) => ds(s.label, s.vals, qs, pal(i), type === 'line' ? { pointRadius: 1.5 } : {}));
  if (bench) data.push(ds(bench.label, bench.vals, qs, isDark() ? '#9aa1ab' : '#555', { type: 'line', borderDash: [5, 4], borderWidth: 1.4, pointRadius: 0, backgroundColor: 'transparent' }));
  mkChart(id, type, qs.map(QV.qShort), data, { kind: kind, notes: notes, zero: type === 'bar' });
  S.chartSeries[id] = conv.map(s => ({ label: s.label, vals: s.vals, unit: s.unit })).concat(bench ? [{ label: bench.label + ' (benchmark)', vals: bench.vals, unit: bench.unit }] : []);
}
// a tabela vem agrupada: o que o cliente procura primeiro em cima, o câmbio no fim
const GROUPS = ['Headline', 'Operations', 'Prices & costs', 'Segments', 'Financial detail', 'FX'];
function groupOf(s) {
  if (s.std === 'fx_avg' || s.std === 'fx_eop' || /^fx\./.test(s.key)) return 5;
  if (['revenue', 'adj_ebitda', 'net_income', 'net_debt'].includes(s.key)) return 0;
  const k = QV.kindOf(s.unit);
  if (k === 'volume') return 1;
  if (k === 'price') return 2;
  if (s.std === 'segment_revenue' || s.std === 'segment_ebitda' || s.segment) return 3;
  return 4;
}
function renderCompanyTable(co, qs) {
  const list = (co.series || []).slice().sort((a, b) => groupOf(a) - groupOf(b) || (a.ord || 0) - (b.ord || 0));
  const head = '<thead><tr><th>Series</th>' + qs.map(q => '<th>' + QV.qShort(q) + '</th>').join('') + '</tr></thead>';
  const row = (label, unit, vals, tagHtml, flags, kind) => '<tr><td class="lab" title="' + esc(label) + '">' + esc(label) + '<span class="u">' + esc(QV.unitLabel(unit)) + '</span>' + (tagHtml || '') + '</td>' +
    qs.map(q => '<td>' + (vals[q] == null ? '<span class="flat">—</span>' : QV.fmt(vals[q], kind) + (flags && flags[q] === 'analyst_adj' ? '<span class="tag adj" title="Adjusted by the Itaú BBA analyst in the model">adj.</span>' : '')) + '</td>').join('') + '</tr>';
  let body = '', g = -1;
  list.forEach(s => {
    const gi = groupOf(s);
    if (gi !== g) { g = gi; body += '<tr><td class="sec-h" colspan="' + (qs.length + 1) + '">' + GROUPS[gi] + '</td></tr>'; }
    const k = QV.kindOf(s.unit), money = gi !== 5 && (k === 'money' || k === 'price');
    const x = money ? inCcy(Object.assign({ id: s.key, kind: k, agg: s.agg }, s)) : s;
    body += row(s.label || s.key, x.unit, x.vals, s.calc ? '<span class="tag calc" title="Calculated by Itaú BBA from reported figures">IBBA calc</span>' : '', s.flags, k);
  });
  const f = [['rev', 'Net revenue — as filed'], ['ebitda', 'EBITDA — accounting, as filed'], ['ni', 'Net income — as filed']];
  const fccy = (Object.values(co.filedBy || {})[0] || {}).ccy;
  if (fccy) {
    body += '<tr><td class="sec-h" colspan="' + (qs.length + 1) + '">As filed with the CVM/SEC (' + esc(CCY_SHORT[fccy] || fccy) + ' mn)</td></tr>';
    f.forEach(([fld, lab]) => { const vals = {}; Object.keys(co.filedBy).forEach(q => { if (co.filedBy[q][fld] != null) vals[q] = Number(co.filedBy[q][fld]); });
      if (Object.keys(vals).length) body += row(lab, fccy + '_mn', vals, '', null, 'money'); });
  }
  $('c-table').innerHTML = head + '<tbody>' + body + '</tbody>';
  const w = $('c-table').parentElement; w.scrollLeft = w.scrollWidth;
  $('c-foot').innerHTML = '<b>IBBA calc</b> = computed by Itaú BBA from reported figures (e.g. revenue ÷ volume). <b>adj.</b> = figure adjusted by the analyst in the model. ' +
    'Accounting EBITDA from the filing is shown for reference only and never replaces adjusted EBITDA.' + (S.ccy === 'usd' ? ' US$: flows and unit prices at the average PTAX, balances at the quarter-end rate.' : '');
}

// ════════════════════════════ COMPARE ═════════════════════════════════════════
// o catálogo do seletor: métricas de manchete + cada família de volume/preço/custo presente em 2+
// empresas (uma chamada de 3 chaves) + as definições parentes + as unit economics
async function compareCatalog() {
  if (S.cmpOpts) return S.cmpOpts;
  const res = await metricRes(['sales_volume', 'realized_price', 'cash_cost']);
  const tickers = S.cos.map(c => c.ticker), out = [];
  QV.COMPARE.forEach(m => {
    if (m.unitEcon) {
      const fams = QV.unitEconFamilies(m.id, tickers);
      Object.keys(fams).sort().forEach(f => out.push({ v: m.id + '|' + f, group: m.group, label: m.label + ' — ' + (QV.UE_FAMILY_LABEL[f] || f) + ' (' + fams[f].length + ')' }));
    } else if (m.byDef) {
      const g = QV.compareGroups(res, m.keys[0]);
      Object.keys(g).sort((a, b) => new Set(g[b].map(s => s.company)).size - new Set(g[a].map(s => s.company)).size || a.localeCompare(b))
        .forEach(f => out.push({ v: m.id + '|' + f, group: m.group, label: QV.familyLabel(f, g[f][0].label) + ' (' + new Set(g[f].map(s => s.company)).size + ')' }));
      const r = QV.relatedGroups(res, m.keys[0]);
      Object.keys(r).forEach(k => out.push({ v: m.id + '|rel:' + k, group: m.group, label: QV.RELATED[k].label + ' (' + new Set(r[k].map(s => s.company)).size + ') · definitions differ' }));
    } else out.push({ v: m.id, group: m.group, label: m.label });
  });
  S.cmpOpts = out; return out;
}
async function compareRows(sel) {
  const parts = String(sel || '').split('|'), mid = parts[0], fam = parts[1] || null;
  const m = QV.COMPARE.find(x => x.id === mid) || QV.COMPARE[1];
  let rows = [], unitTo = null;
  if (m.unitEcon) {
    const fams = QV.unitEconFamilies(mid, S.cos.map(c => c.ticker)), members = fams[fam] || [];
    const cos = await Promise.all(members.map(loadCompany));
    rows = cos.filter(Boolean).map(co => { const s = QV.unitEcon(co, mid); if (!s) return null; const x = inCcy(s);
      return { company: co.ticker, name: co.name, id: 'ue.' +mid, vals: x.vals, unit: x.unit, ccy: x.ccy, agg: 'rate', kind: 'price', calc: s.calc, def: s.note, label: m.label }; }).filter(Boolean);
  } else if (m.byDef) {
    const res = await metricRes([m.keys[0]]);
    let list;
    if (/^rel:/.test(fam || '')) { const k = fam.slice(4); list = QV.relatedGroups(res, m.keys[0])[k] || []; unitTo = QV.RELATED[k] && QV.RELATED[k].to; }
    else list = QV.compareGroups(res, m.keys[0])[fam] || [];
    rows = list.map(s => {
      const c = S.cos.find(x => x.ticker === s.company) || {}, dup = list.filter(g => g.company === s.company).length > 1;
      let base = { id: s.key, vals: s.vals, unit: s.unit, ccy: s.ccy, agg: s.agg || 'rate', kind: QV.kindOf(s.unit) };
      if (unitTo) base = QV.convert(base, unitTo) || base;
      const x = inCcy(base);
      return { company: s.company, name: (c.name || s.company) + (dup ? ' — ' + s.label : ''), id: s.key, vals: x.vals, unit: x.unit, ccy: x.ccy, agg: base.agg, kind: x.kind || base.kind,
        calc: !!s.calc, def: QV.familyLabel(QV.family(s.def), s.label), label: s.label };
    });
  } else {
    const res = await metricRes(QV.metricKeys(m));
    rows = S.cos.map(c => {
      const co = QV.indexCompany({ ticker: c.ticker, name: c.name, base_ccy: c.base_ccy, series: (res.series || []).filter(s => s.company === c.ticker),
        filed: (res.filed || []).filter(r => r.company === c.ticker), notes: c.notes });
      const s = mid === 'margin' || mid === 'leverage' ? QV.basis(co, mid, S.basis) : ser(co, mid);
      return s && Object.keys(s.vals).length ? { company: c.ticker, name: c.name, id: mid, vals: s.vals, unit: s.unit, ccy: s.ccy, agg: s.agg, src: s.src, kind: m.kind, label: m.label } : null;
    }).filter(Boolean);
  }
  return { m: m, mid: mid, fam: fam, rows: rows };
}
const QUICK = [['all', 'All'], ['steel', 'Steel'], ['iron_ore', 'Iron ore'], ['copper', 'Copper'], ['gold', 'Gold'], ['pulp_paper', 'P&P'], ['none', 'None']];
async function renderCompare() {
  const mSel = $('m-metric');
  let cat;
  try { cat = await compareCatalog(); } catch (e) { $('m-cos').innerHTML = '<span class="muted">Could not load the comparison catalog (' + esc(e.message || e) + ').</span>'; return; }
  if (S.view !== 'cmp') return;
  if (!cat.some(o => o.v === S.metric)) S.metric = cat.some(o => o.v === 'adj_ebitda') ? 'adj_ebitda' : (cat[0] && cat[0].v);
  const groups = [...new Set(cat.map(o => o.group))];
  mSel.innerHTML = groups.map(g => '<optgroup label="' + esc(g) + '">' + cat.filter(o => o.group === g).map(o => '<option value="' + esc(o.v) + '"' + (o.v === S.metric ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</optgroup>').join('');
  mSel.onchange = () => { S.metric = mSel.value; render(); };
  killCharts('m-');
  let R;
  try { R = await compareRows(S.metric); } catch (e) { console.error(e); $('m-cos').innerHTML = '<span class="muted">Could not load this metric (' + esc(e.message || e) + ').</span>'; return; }
  if (S.view !== 'cmp') return;
  const m = R.m, rows = R.rows;
  if (!rows.length) { $('m-cos').innerHTML = '<span class="muted">No company reports this yet.</span>'; $('m-table').innerHTML = ''; $('m-defs').hidden = true; return; }
  // Em "Level", R$ e US$ no mesmo eixo enganam: com moedas misturadas a comparação sai em US$ sozinha
  // (YoY, QoQ e Base 100 são razões e ficam na moeda reportada)
  const money = rows.every(r => r.kind === 'money' || r.kind === 'price');
  const ccys = new Set(rows.map(r => r.ccy).filter(Boolean));
  const autoUsd = S.mode === 'lvl' && money && S.ccy !== 'usd' && ccys.size > 1 && QV.hasFx(S.fx, 'BRL');
  const shownRows = rows.map(r => { if (!autoUsd || !r.ccy || r.ccy === 'USD') return r; const u = QV.toUsd(r, S.fx); return u ? Object.assign({}, r, { vals: u.vals, unit: u.unit, ccy: 'USD' }) : r; });
  const units = [...new Set(shownRows.map(r => r.unit).filter(Boolean))], unitTxt = units.map(QV.unitLabel).join(' / ');
  // seleção de empresas: guarda a anterior quando as empresas continuam na métrica nova
  const avail = rows.map(r => r.company);
  if (!S.sel || !S.sel.some(t => avail.includes(t))) S.sel = avail.slice();
  const chosen = shownRows.filter(r => S.sel.includes(r.company));
  $('m-quick').innerHTML = QUICK.map(([k, l]) => '<button data-k="' + k + '">' + l + '</button>').join('');
  $('m-quick').querySelectorAll('button').forEach(b => b.onclick = () => { const k = b.dataset.k;
    S.sel = k === 'all' ? avail.slice() : k === 'none' ? [] : avail.filter(t => (S.cos.find(c => c.ticker === t) || {}).sector === k); render(); });
  $('m-cos').innerHTML = rows.map(r => '<span class="chip' + (S.sel.includes(r.company) ? ' on' : ' off') + '" data-t="' + esc(r.company) + '"><span class="sw" style="background:' + colorOf(r.company) + '"></span>' + esc(r.name) +
      (r.calc ? '<span class="tag calc" title="Calculated by Itaú BBA from the model (see definitions below)">calc</span>' : '') + '</span>').join('') +
    (units.length > 1 ? '<span class="muted">Mixed units (' + esc(unitTxt) + ')' + (S.ccy !== 'usd' && ccys.size > 1 ? ' — switch to US$ to compare on one scale' : '') + '</span>' : '');
  $('m-cos').querySelectorAll('.chip').forEach(ch => ch.onclick = () => { const t = ch.dataset.t;
    S.sel = S.sel.includes(t) ? S.sel.filter(x => x !== t) : S.sel.concat([t]); render(); });
  const allQ = chosen.flatMap(r => Object.keys(r.vals)), lastQ = QV.maxQ(allQ);
  const qs = !lastQ ? [] : S.win === 'all' ? QV.qRange(QV.minQ(allQ), lastQ) : windowQs(lastQ);
  const shown = chosen.map(r => Object.assign({}, r, { vals: QV.transform(r.vals, S.mode, qs) }));
  const kind = shownRows[0] ? shownRows[0].kind : m.kind;
  const vKind = S.mode === 'yoy' || S.mode === 'qoq' ? 'pct' : S.mode === 'idx' ? 'idx' : kind;
  const title = (m.byDef || m.unitEcon ? (cat.find(o => o.v === S.metric) || {}).label.replace(/ \(\d+\)( · definitions differ)?$/, '') : m.label) +
    (S.mode === 'idx' ? ' · base 100' : S.mode === 'yoy' ? ' · YoY' : S.mode === 'qoq' ? ' · QoQ' : '');
  $('m-title').textContent = title;
  $('m-sub').textContent = (S.mode === 'lvl' ? unitTxt : S.mode === 'idx' ? '100 = first quarter in the window' : S.mode === 'yoy' ? 'change vs same quarter a year earlier' : 'change vs previous quarter') +
    (S.basis === 'ltm' && !m.byDef && !m.unitEcon ? ' · LTM' : '') + (autoUsd ? ' · shown in US$ so all companies share one scale (average PTAX; balances at quarter-end)' : '');
  S.chartMeta['m-line'] = { title: title };
  const bar = S.ctype === 'bar';
  mkChart('m-line', bar ? 'bar' : 'line', qs.map(QV.qShort), shown.map(r => ds(r.name, r.vals, qs, colorOf(r.company), bar ? { borderWidth: 0 } : { pointRadius: 1.5 })),
    { kind: vKind, zero: bar || vKind === 'pct' });
  S.chartSeries['m-line'] = shown.map(r => ({ label: r.name, vals: r.vals, unit: S.mode === 'lvl' ? r.unit : '' }));
  // ranking do último trimestre com 2+ empresas
  const rq = QV.sortQ([...new Set(allQ)]).reverse().find(q => shown.filter(r => r.vals[q] != null).length >= 2) || lastQ;
  const rank = shown.filter(r => rq && r.vals[rq] != null).sort((a, b) => b.vals[rq] - a.vals[rq]);
  $('m-rank-sub').textContent = rq ? QV.qShort(rq) + (S.mode === 'lvl' && unitTxt ? ' · ' + unitTxt : '') : '';
  S.chartMeta['m-rank'] = { title: 'Latest quarter — ' + title };
  mkChart('m-rank', 'bar', rank.map(r => r.name), [{ label: QV.qShort(rq), data: rank.map(r => r.vals[rq]), backgroundColor: rank.map(r => colorOf(r.company)), borderWidth: 0 }],
    { kind: vKind, legend: false, indexAxis: 'y', x: { ticks: { callback: tick(vKind) }, grid: { display: true, color: isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' } }, y: { ticks: { callback: function (v) { return this.getLabelForValue(v); } }, beginAtZero: false },
      label: c => ' ' + fmtK(c.parsed.x, vKind) });
  S.chartSeries['m-rank'] = [{ label: QV.qShort(rq), vals: Object.fromEntries(rank.map(r => [r.name, r.vals[rq]])), unit: '' }];
  // matriz com cor por coluna
  const cols = qs.slice().reverse().slice(0, 12).reverse();
  $('m-mat-sub').textContent = 'Shaded within each quarter' + (S.mode !== 'lvl' ? ' · ' + (S.mode === 'idx' ? 'base 100' : S.mode.toUpperCase()) : '');
  $('m-table').innerHTML = '<thead><tr><th>Company</th>' + cols.map(q => '<th>' + QV.qShort(q) + '</th>').join('') + '</tr></thead><tbody>' +
    shown.map(r => '<tr><td class="lab"><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + colorOf(r.company) + '"></span>' + esc(r.name) + '</td>' +
      cols.map(q => { const v = r.vals[q]; if (v == null) return '<td class="flat">—</td>';
        const col = shown.map(x => x.vals[q]).filter(x => x != null), mn = Math.min.apply(null, col), mx = Math.max.apply(null, col);
        const a = mx === mn ? 0.08 : 0.06 + (v - mn) / (mx - mn) * 0.30;
        return '<td class="hc" style="background:rgba(255,80,0,' + a.toFixed(3) + ')">' + fmtK(v, vKind) + '</td>'; }).join('') + '</tr>').join('') + '</tbody>';
  // o que cada empresa reporta (famílias, parentes e unit economics)
  const defs = m.byDef || m.unitEcon;
  $('m-defs').hidden = !defs;
  if (defs) {
    $('m-defs').open = m.unitEcon || /\|rel:/.test(S.metric);
    $('m-defs-table').innerHTML = '<thead><tr><th>Company</th><th style="text-align:left">Series in the model</th><th style="text-align:left">Unit</th><th style="text-align:left">Definition</th><th style="text-align:left">Source</th></tr></thead><tbody>' +
      rows.map(r => '<tr><td>' + esc(r.name) + '</td><td style="text-align:left">' + esc(r.label || '') + '</td><td style="text-align:left">' + esc(QV.unitLabel(r.unit)) + '</td><td style="text-align:left">' + esc(r.def || '') + '</td>' +
        '<td style="text-align:left">' + (r.calc ? 'Itaú BBA calculation from the model' : 'Company model (Itaú BBA)') + '</td></tr>').join('') + '</tbody>';
  }
  $('m-foot').innerHTML = '<div class="foot">' + (m.unitEcon ? 'Unit economics use each company\'s own segment figures; where the model does not carry the per-unit line, it is the ratio of two model series (marked calc). ' :
    m.byDef ? (/\|rel:/.test(S.metric) ? 'Related definitions: the same quantity reported on different bases — read each company\'s definition above before comparing levels. ' : 'Only series with the same definition are compared; ') + 'a product reported in R$ and in US$ is put on one scale with the US$ switch. ' :
    'Adjusted EBITDA as in Itaú BBA\'s company models; net income as filed where in the reporting currency. ') +
    'YoY / QoQ are not shown when the base is zero or negative. Base 100 = first quarter of the window.</div>';
  $('m-xls').onclick = () => download(QV.aoaSeries(chosen.map(r => ({ label: r.name, vals: r.vals, unit: r.unit, calc: r.calc })), title), title, 'quarterly_compare_' + S.metric.replace(/[^a-z0-9]+/gi, '_'));
  $('m-build').onclick = () => { S.layers = chosen.slice(0, 8).map(r => ({ co: r.company, key: r.id, tf: S.mode === 'lvl' ? (S.basis === 'ltm' && r.agg === 'flow' ? 'ltm' : 'lvl') : S.mode, ax: 'L', ty: S.ctype })); go('build'); };
  attachExports('quarterly_compare');
}

// ════════════════════════════ BUILD A CHART ═══════════════════════════════════
const PRESETS = [
  { id: 'vale_fines', label: 'Vale — iron ore fines realized price vs 62% Fe index', layers: [{ co: 'VALE3', key: 'px.fines' }, { key: '@IRON_ORE_62' }] },
  { id: 'scco_copper', label: 'Southern Copper — realized copper price vs COMEX', layers: [{ co: 'SCCO', key: 'px.copper' }, { key: '@COPPER' }] },
  { id: 'aura_gold', label: 'Aura — realized GEO price vs COMEX gold', layers: [{ co: 'AUGO', key: 'px' }, { key: '@GOLD' }] },
  { id: 'steel_ebitda_t', label: 'Steel — EBITDA per tonne: Gerdau, CSN, Usiminas, Ternium', layers: [{ co: 'GGBR4', key: 'ue.ebitda_per_unit' }, { co: 'CSNA3', key: 'ue.ebitda_per_unit' }, { co: 'USIM5', key: 'ue.ebitda_per_unit' }, { co: 'TX', key: 'ue.ebitda_per_unit' }] },
  { id: 'pulp_margin', label: 'Pulp — cash margin per tonne: Suzano, CMPC, Copec', layers: [{ co: 'SUZB3', key: 'ue.cash_margin' }, { co: 'CMPC', key: 'ue.cash_margin' }, { co: 'COPEC', key: 'ue.cash_margin' }] },
  { id: 'suzano_px_cost', label: 'Suzano — pulp price vs cash cost (R$/t)', layers: [{ co: 'SUZB3', key: 'pulp.px' }, { co: 'SUZB3', key: 'pulp.cash_cost_t' }] },
  { id: 'klabin_seg', label: 'Klabin — EBITDA by segment (pulp vs paper & packaging)', layers: [{ co: 'KLBN11', key: 'pulp.ebitda', ty: 'bar' }, { co: 'KLBN11', key: 'pp.ebitda', ty: 'bar' }] },
  { id: 'pp_leverage', label: 'Leverage — Suzano, Klabin, CMPC', layers: [{ co: 'SUZB3', key: 'leverage' }, { co: 'KLBN11', key: 'leverage' }, { co: 'CMPC', key: 'leverage' }] },
  { id: 'steel_margin', label: 'Steel — adj. EBITDA margin, 4 companies', layers: [{ co: 'GGBR4', key: 'margin' }, { co: 'CSNA3', key: 'margin' }, { co: 'USIM5', key: 'margin' }, { co: 'TX', key: 'margin' }] },
  { id: 'vale_ebitda_px', label: 'Vale — adj. EBITDA (bars) vs fines price (line, right axis)', layers: [{ co: 'VALE3', key: 'adj_ebitda', ty: 'bar' }, { co: 'VALE3', key: 'px.fines', ax: 'R' }] }
];
function fullLayer(l) { return { co: l.co || null, key: l.key, tf: l.tf || 'lvl', ax: l.ax === 'R' ? 'R' : 'L', ty: l.ty === 'bar' ? 'bar' : 'line' }; }
// as séries que uma empresa oferece ao Build, agrupadas como na tabela da empresa
function seriesOptions(co) {
  const groups = [{ label: 'Headline', items: HEADLINE.map(h => ({ v: h[0], label: h[1] })) }];
  const ue = Object.keys(QV.UNIT_ECON).filter(id => QV.unitEcon(co, id)).map(id => ({ v: 'ue.' +id, label: QV.UNIT_ECON[id].label + (QV.unitEcon(co, id).calc ? ' (calc)' : '') }));
  if (ue.length) groups.push({ label: 'Unit economics', items: ue });
  const byG = {};
  (co.series || []).slice().sort((a, b) => groupOf(a) - groupOf(b) || (a.ord || 0) - (b.ord || 0)).forEach(s => { const g = groupOf(s); if (g === 0) return; (byG[g] = byG[g] || []).push({ v: s.key, label: (s.label || s.key) + ' · ' + QV.unitLabel(s.unit) }); });
  Object.keys(byG).sort().forEach(g => groups.push({ label: GROUPS[g], items: byG[g] }));
  return groups;
}
// as transformações que dependem da JANELA (Base 100) ou são razões (YoY, QoQ); o LTM já veio de resolveLayer
function applyTf(s, tf, qs) {
  if (!s) return s;
  if (tf === 'yoy' || tf === 'qoq' || tf === 'idx') return Object.assign({}, s, { vals: QV.transform(s.vals, tf, qs), kind: tf === 'idx' ? 'idx' : 'pct', unit: tf === 'idx' ? 'idx' : '%', label: s.label + ' (' + TF_LABEL[tf] + ')' });
  return s;
}
// camada → série (empresa inteira ou índice), já na moeda escolhida e antes da janela
async function resolveLayer(l) {
  if (!l || !l.key) return null;
  if (l.key.charAt(0) === '@') {
    const code = l.key.slice(1), b = await loadBench();
    if (!b[code]) return null;
    const s = QV.benchSeries(code, b[code].q, b[code].unit); if (!s) return null;
    return Object.assign(s, { label: QV.BENCH[code].short, name: QV.BENCH[code].label });
  }
  const co = await loadCompany(l.co); if (!co) return null;
  const basis = l.tf === 'ltm' ? 'ltm' : 'q';
  let s;
  if (HEADLINE_IDS.includes(l.key)) {
    s = l.key === 'margin' || l.key === 'leverage' ? QV.basis(co, l.key, basis) : ser(co, l.key, basis);
    if (!s) return null;
    s = Object.assign({}, s, { label: co.name + ' — ' + (HEADLINE.find(h => h[0] === l.key) || [])[1] + (basis === 'ltm' && s.agg === 'flow' ? ' (LTM)' : '') });
  } else if (/^ue\./.test(l.key)) {
    const u = QV.unitEcon(co, l.key.slice(3)); if (!u) return null;
    s = Object.assign(inCcy(u), { label: co.name + ' — ' + QV.UNIT_ECON[l.key.slice(3)].label, note: u.note });
  } else {
    const raw = co.byKey[l.key]; if (!raw) return null;
    const k = QV.kindOf(raw.unit);
    s = { id: raw.key, label: co.name + ' — ' + (raw.label || raw.key), vals: raw.vals, unit: raw.unit, ccy: raw.ccy, agg: raw.agg || 'flow', kind: k, calc: !!raw.calc, def: raw.def };
    if ((k === 'money' || k === 'price') && !/^fx/.test(raw.std || '')) s = inCcy(s);
    if (l.tf === 'ltm' && s.agg === 'flow') s = Object.assign({}, s, { vals: QV.ltmSeries(s.vals, 'flow'), label: s.label + ' (LTM)' });
  }
  return s;
}
async function renderBuild() {
  if (!S.layers) S.layers = PRESETS[0].layers.map(fullLayer);          // 1ª visita: um exemplo pronto; lista vazia é escolha do usuário
  S.layers = S.layers.map(fullLayer).slice(0, 8);
  const pre = $('bd-preset');
  const avail = PRESETS.filter(p => p.layers.every(l => !l.co || S.cos.some(c => c.ticker === l.co)));
  pre.innerHTML = '<option value="">Choose a preset…</option>' + avail.map(p => '<option value="' + p.id + '">' + esc(p.label) + '</option>').join('');
  pre.onchange = () => { const p = PRESETS.find(x => x.id === pre.value); if (p) { S.layers = p.layers.map(fullLayer); render(); } };
  $('bd-add').onclick = () => { if (S.layers.length >= 8) { toast('Up to 8 series'); return; } const last = S.layers[S.layers.length - 1]; S.layers.push(fullLayer({ co: last && last.co || (S.cos[0] && S.cos[0].ticker), key: 'adj_ebitda' })); render(); };
  $('bd-link').onclick = () => { writeHash(); const url = location.href; (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Link copied'), () => window.prompt('Copy this link', url)); };
  // as empresas das camadas carregam em paralelo (uma vez por visita); as linhas do editor vêm depois
  const need = [...new Set(S.layers.filter(l => l.co).map(l => l.co))];
  await Promise.all(need.map(t => loadCompany(t).catch(() => null)));
  if (S.view !== 'build') return;
  renderBuildRows();
  killCharts('bd-');
  const list = await Promise.all(S.layers.map(l => resolveLayer(l).catch(e => { console.warn('layer', l, e); return null; })));
  if (S.view !== 'build') return;
  const allQ = list.flatMap(s => s ? Object.keys(s.vals) : []), lastQ = QV.maxQ(allQ);
  const qs = !lastQ ? [] : S.win === 'all' ? QV.qRange(QV.minQ(allQ), lastQ) : windowQs(lastQ);
  const shown = list.map((s, i) => s ? Object.assign({}, applyTf(s, S.layers[i].tf, qs), { _i: i }) : null).filter(Boolean);
  const left = shown.filter(s => S.layers[s._i].ax !== 'R'), right = shown.filter(s => S.layers[s._i].ax === 'R');
  const kindL = left[0] ? left[0].kind : (right[0] ? right[0].kind : 'num'), kindR = right[0] ? right[0].kind : null;
  const unitsL = [...new Set(left.map(s => s.unit).filter(Boolean))], unitsR = [...new Set(right.map(s => s.unit).filter(Boolean))];
  const title = shown.length ? (shown.length === 1 ? shown[0].label : shown.map(s => s.label.split(' — ')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ') + ' — ' + shown.length + ' series') : 'Custom chart';
  $('bd-title').textContent = title;
  $('bd-sub').textContent = (unitsL.length ? 'Left: ' + unitsL.map(QV.unitLabel).join(' / ') : '') + (unitsR.length ? ' · Right: ' + unitsR.map(QV.unitLabel).join(' / ') : '') +
    (unitsL.length > 1 ? ' — mixed units on one axis' : '') + (S.ccy === 'usd' ? ' · US$' : '');
  S.chartMeta['bd-chart'] = { title: title };
  const anyBar = shown.some(s => S.layers[s._i].ty === 'bar');
  mkChart('bd-chart', anyBar ? 'bar' : 'line', qs.map(QV.qShort), shown.map(s => { const l = S.layers[s._i];
    return ds(s.label, s.vals, qs, s.bench ? (isDark() ? '#9aa1ab' : '#555') : pal(s._i), Object.assign({ type: l.ty === 'bar' ? 'bar' : 'line', yAxisID: l.ax === 'R' ? 'y2' : 'y', _kind: s.kind, order: l.ty === 'bar' ? 2 : 1 },
      l.ty === 'bar' ? { borderWidth: 0 } : { pointRadius: 1.5 }, s.bench ? { borderDash: [5, 4], borderWidth: 1.4, backgroundColor: 'transparent' } : {})); }),
    { kind: kindL, y2: right.length ? {} : null, y2kind: kindR, zero: anyBar, zero2: false, notes: [] });
  S.chartSeries['bd-chart'] = shown.map(s => ({ label: s.label, vals: s.vals, unit: s.unit }));
  const cols = qs.slice().reverse().slice(0, 20).reverse();
  $('bd-tsub').textContent = cols.length ? QV.qShort(cols[0]) + ' – ' + QV.qShort(cols[cols.length - 1]) : '';
  $('bd-table').innerHTML = shown.length ? '<thead><tr><th>Series</th>' + cols.map(q => '<th>' + QV.qShort(q) + '</th>').join('') + '</tr></thead><tbody>' +
    shown.map(s => '<tr><td class="lab"><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + (s.bench ? '#888' : pal(s._i)) + '"></span>' + esc(s.label) + '<span class="u">' + esc(QV.unitLabel(s.unit)) + '</span>' +
      (s.calc ? '<span class="tag calc">IBBA calc</span>' : '') + (s.bench ? '<span class="tag bench">benchmark</span>' : '') + '</td>' + cols.map(q => '<td>' + (s.vals[q] == null ? '<span class="flat">—</span>' : fmtK(s.vals[q], s.kind)) + '</td>').join('') + '</tr>').join('') + '</tbody>' :
    '<tbody><tr><td class="empty">Pick a company and a series above, or start from a preset.</td></tr></tbody>';
  const notes = shown.filter(s => s.note).map(s => '<b>' + esc(s.label) + '</b>: ' + esc(s.note));
  $('bd-foot').innerHTML = (notes.length ? notes.join(' · ') + '<br>' : '') + 'Company series come from Itaú BBA\'s models; <b>IBBA calc</b> = ratio of two model series; benchmarks are free indices (Trading Economics / Yahoo Finance), quarterly averages of daily closes. ' +
    'YoY / QoQ are not shown when the base is zero or negative. Base 100 = first quarter of the window.';
  $('bd-xls').onclick = () => download(QV.aoaSeries(shown, title), title, 'quarterly_build');
  attachExports('quarterly_build');
  writeHash();
}
function renderBuildRows() {
  const host = $('bd-rows');
  const coOpts = '<optgroup label="Benchmarks">' + '<option value="@">Free benchmark index</option></optgroup>' +
    SEC_ORDER.map(sec => { const cs = S.cos.filter(c => c.sector === sec); return cs.length ? '<optgroup label="' + esc(SEC_LABEL[sec]) + '">' + cs.map(c => '<option value="' + esc(c.ticker) + '">' + esc(c.name) + '</option>').join('') + '</optgroup>' : ''; }).join('');
  host.innerHTML = S.layers.map((l, i) => {
    const isB = l.key.charAt(0) === '@', co = !isB && S.full[l.co];
    let sOpts;
    if (isB) sOpts = QV.BENCH_CODES.map(c => '<option value="@' + c + '"' + ('@' + c === l.key ? ' selected' : '') + '>' + esc(QV.BENCH[c].label) + '</option>').join('');
    else if (co) sOpts = seriesOptions(co).map(g => '<optgroup label="' + esc(g.label) + '">' + g.items.map(o => '<option value="' + esc(o.v) + '"' + (o.v === l.key ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</optgroup>').join('');
    else sOpts = '<option>Loading…</option>';
    return '<div class="bld-row" data-i="' + i + '"><span class="sw" style="background:' + (isB ? '#888' : pal(i)) + '"></span>' +
      '<select class="sel" data-f="co">' + coOpts.replace('value="' + (isB ? '@' : esc(l.co)) + '"', 'value="' + (isB ? '@' : esc(l.co)) + '" selected') + '</select>' +
      '<select class="sel" data-f="key">' + sOpts + '</select>' +
      '<select class="sel" data-f="tf">' + Object.keys(TF_LABEL).map(k => '<option value="' + k + '"' + (k === l.tf ? ' selected' : '') + '>' + TF_LABEL[k] + '</option>').join('') + '</select>' +
      '<div class="seg sm" data-f="ax"><button data-v="L"' + (l.ax !== 'R' ? ' class="on"' : '') + '>Left</button><button data-v="R"' + (l.ax === 'R' ? ' class="on"' : '') + '>Right</button></div>' +
      '<div class="seg sm" data-f="ty"><button data-v="line"' + (l.ty !== 'bar' ? ' class="on"' : '') + '>Line</button><button data-v="bar"' + (l.ty === 'bar' ? ' class="on"' : '') + '>Bar</button></div>' +
      '<button class="x" data-f="x" title="Remove">×</button></div>';
  }).join('') || '<div class="bld-empty">No series yet — add one or pick a preset.</div>';
  host.querySelectorAll('.bld-row').forEach(row => {
    const i = +row.dataset.i, l = S.layers[i];
    row.querySelector('[data-f="co"]').onchange = e => { const v = e.target.value; if (v === '@') { l.co = null; l.key = '@' + QV.BENCH_CODES[0]; } else { l.co = v; if (l.key.charAt(0) === '@' || !(S.full[v] && (S.full[v].byKey[l.key] || HEADLINE_IDS.includes(l.key) || /^ue\./.test(l.key)))) l.key = 'adj_ebitda'; } render(); };
    row.querySelector('[data-f="key"]').onchange = e => { l.key = e.target.value; render(); };
    row.querySelector('[data-f="tf"]').onchange = e => { l.tf = e.target.value; render(); };
    row.querySelectorAll('[data-f="ax"] button').forEach(b => b.onclick = () => { l.ax = b.dataset.v; render(); });
    row.querySelectorAll('[data-f="ty"] button').forEach(b => b.onclick = () => { l.ty = b.dataset.v; render(); });
    row.querySelector('[data-f="x"]').onclick = () => { S.layers.splice(i, 1); render(); };
  });
}

// ════════════════════════════ geral ═══════════════════════════════════════════
function syncControls() {
  document.querySelectorAll('#views .tab').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  document.querySelectorAll('#ccy button').forEach(b => b.classList.toggle('on', b.dataset.c === S.ccy));
  document.querySelectorAll('#basis button').forEach(b => b.classList.toggle('on', b.dataset.b === S.basis));
  document.querySelectorAll('#win button').forEach(b => b.classList.toggle('on', String(b.dataset.w) === String(S.win)));
  document.querySelectorAll('#m-mode button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  document.querySelectorAll('#m-ctype button').forEach(b => b.classList.toggle('on', b.dataset.t === S.ctype));
  const usdOk = QV.hasFx(S.fx, 'BRL');
  const u = document.querySelector('#ccy button[data-c="usd"]'); if (u) { u.disabled = !usdOk; u.title = usdOk ? '' : 'Exchange rates are not loaded yet'; }
  if (!usdOk && S.ccy === 'usd') S.ccy = 'rep';
  $('win').style.visibility = S.view === 'board' ? 'hidden' : 'visible';
  $('basis').style.visibility = S.view === 'build' ? 'hidden' : 'visible';      // no Build a base é por série
  $('v-board').hidden = S.view !== 'board'; $('v-co').hidden = S.view !== 'co'; $('v-cmp').hidden = S.view !== 'cmp'; $('v-build').hidden = S.view !== 'build';
}
function render() {
  syncControls(); writeHash();
  const p = S.view === 'co' ? renderCompany() : S.view === 'cmp' ? renderCompare() : S.view === 'build' ? renderBuild() : Promise.resolve(renderBoard());
  Promise.resolve(p).catch(e => { console.error(e); });
}
function go(view, arg) {
  S.view = view;
  if (view === 'co' && arg) S.co = arg;
  if (view === 'cmp' && arg) { S.metric = arg; }
  render(); window.scrollTo({ top: 0 });
}
function bind() {
  document.querySelectorAll('#views .tab').forEach(b => b.onclick = () => go(b.dataset.v));
  document.querySelectorAll('#ccy button').forEach(b => b.onclick = () => { S.ccy = b.dataset.c; render(); });
  document.querySelectorAll('#basis button').forEach(b => b.onclick = () => { S.basis = b.dataset.b; render(); });
  document.querySelectorAll('#win button').forEach(b => b.onclick = () => { S.win = b.dataset.w === 'all' ? 'all' : +b.dataset.w; render(); });
  document.querySelectorAll('#m-mode button').forEach(b => b.onclick = () => { S.mode = b.dataset.m; render(); });
  document.querySelectorAll('#m-ctype button').forEach(b => b.onclick = () => { S.ctype = b.dataset.t; render(); });
  $('b-q').onchange = () => { S.q = $('b-q').value; render(); };
  window.addEventListener('ibba:theme', () => { themeChart(); render(); });
  window.addEventListener('hashchange', () => { const v = S.view, c = S.co, m = S.metric; readHash(); if (v !== S.view || c !== S.co || m !== S.metric) render(); });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.view !== 'board') render(); }, 250); });
}

readHash();                                           // antes de qualquer await
;(async () => {
  bind(); themeChart();
  try {
    const { data: { session } } = await sbAuth.auth.getSession();
    if (!session) { window.location.replace('/login.html'); return; }
    _setAuthCookie(session);
    sbAuth.auth.onAuthStateChange((ev, s) => { if (s && s.access_token) _setAuthCookie(s); else if (ev === 'SIGNED_OUT') { document.cookie = 'sb-access-token=; Max-Age=0; Path=/'; window.location.replace('/login.html'); } });
    const boot = await rpc('get_quarterly_boot', { p_last: 20 });
    if (!boot || boot.enabled === false) { $('gate').hidden = true; $('denied').hidden = false; return; }
    try { localStorage.setItem('ibba_quarterly_on', '1'); } catch (e) {}
    S.cos = QV.fromBoot(boot); S.fx = boot.fx || {}; S.season = QV.seasonQ(S.cos); S.currentQ = boot.current_q || null;
    if (!S.q || QV.qIdx(S.q) > QV.qIdx(S.season)) S.q = S.season;
    $('sub').textContent = S.season ? 'Reported results of our coverage · data through ' + QV.qShort(S.season) : 'Reported results of our coverage';
    try {
      const d = new Date(), iso = x => new Date(x).toISOString().slice(0, 10);
      const ev = await rpc('get_exec_calendar_events', { p_from: iso(d), p_to: iso(d.getTime() + 120 * 864e5) });
      S.events = QV.nextResults(ev || [], iso(d));
    } catch (e) { console.warn('calendar', e); }
    $('gate').hidden = true; $('app').hidden = false;
    render();
  } catch (e) {
    console.error(e);
    $('gate').innerHTML = '<div style="font-size:32px">📊</div><div style="font-weight:700;margin:8px 0 4px">Quarterly is unavailable right now</div><div class="muted">' + esc(String(e && e.message || e)) + '</div><a class="hbtn" href="/index.html" style="margin-top:12px">← Back to home</a>';
  }
})();
})();
