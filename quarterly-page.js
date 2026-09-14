/* ═══════════════════════════════════════════════════════════════════════════════
   quarterly-page.js — a tela da página Quarterly: Season board · Company · Compare.
   As contas (fonte por métrica, LTM, YoY, câmbio, calendário, Excel) moram em quarterly-view.js e têm
   teste próprio; aqui é rota, desenho, Chart.js e download. Tudo que vem do modelo passa por esc().
   ⚠️ O hash é lido ANTES de qualquer await (lição da aba antiga: o gate reescrevia o endereço).
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';
const S = { view: 'board', ccy: 'rep', basis: 'q', win: 12, q: null, season: null, co: null, metric: 'adj_ebitda', fam: null,
  mode: 'lvl', sel: null, cos: [], fx: {}, events: {}, full: {}, metricRes: {}, chartSeries: {}, chartMeta: {} };
const charts = {};
const SEC_LABEL = { steel: 'Steel', iron_ore: 'Iron ore', copper: 'Copper', gold: 'Gold', pulp_paper: 'Pulp & Paper' };
const SEC_ORDER = ['steel', 'iron_ore', 'copper', 'gold', 'pulp_paper'];
const PALETTE = ['#FF5000', '#2563eb', '#16a34a', '#9333ea', '#b45309', '#db2777', '#0891b2', '#65a30d', '#6b7280', '#dc2626', '#0f766e', '#7c3aed', '#a16207', '#0284c7'];
const CCY_SHORT = { BRL: 'R$', USD: 'US$', CLP: 'CLP', MXN: 'MXN' };
const $ = id => document.getElementById(id);
const QV = window.QV;

// ── rota ──────────────────────────────────────────────────────────────────────
function readHash() {
  const h = location.hash.replace(/^#/, ''), i = h.indexOf('?');
  const path = (i < 0 ? h : h.slice(0, i)).split('/'), p = new URLSearchParams(i < 0 ? '' : h.slice(i + 1));
  S.view = ['board', 'co', 'cmp'].includes(path[0]) ? path[0] : 'board';
  if (S.view === 'co' && path[1]) S.co = decodeURIComponent(path[1]).toUpperCase();
  if (S.view === 'cmp' && path[1]) S.metric = decodeURIComponent(path[1]);
  S.ccy = p.get('ccy') === 'usd' ? 'usd' : 'rep';
  S.basis = p.get('basis') === 'ltm' ? 'ltm' : 'q';
  const w = p.get('win'); S.win = w === 'all' ? 'all' : ([8, 12, 20].includes(+w) ? +w : 12);
  if (/^\d{4}Q[1-4]$/.test(p.get('q') || '')) S.q = p.get('q');
  if (p.get('fam')) S.fam = p.get('fam');
  if (['lvl', 'idx', 'yoy'].includes(p.get('mode'))) S.mode = p.get('mode');
  if (p.get('cos')) S.sel = p.get('cos').split(',').filter(Boolean);
}
function writeHash() {
  const p = new URLSearchParams();
  if (S.ccy === 'usd') p.set('ccy', 'usd');
  if (S.basis === 'ltm') p.set('basis', 'ltm');
  if (S.win !== 12) p.set('win', S.win);
  if (S.view === 'board' && S.q && S.q !== S.season) p.set('q', S.q);
  if (S.view === 'cmp') { if (S.fam) p.set('fam', S.fam); if (S.mode !== 'lvl') p.set('mode', S.mode); if (S.sel) p.set('cos', S.sel.join(',')); }
  const path = S.view === 'co' ? 'co/' + encodeURIComponent(S.co || '') : S.view === 'cmp' ? 'cmp/' + encodeURIComponent(S.metric) : 'board';
  const h = '#' + path + (String(p) ? '?' + p : '');
  if (location.hash !== h) history.replaceState(null, '', h);
}

// ── gráficos ──────────────────────────────────────────────────────────────────
const isDark = () => document.documentElement.classList.contains('dark');
const MOBILE = () => window.matchMedia('(max-width:700px)').matches;
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
        callbacks: { label: o.label || (c => ' ' + c.dataset.label + ': ' + QV.fmt(c.parsed.y, o.kind || 'num')) } },
      qnotes: o.notes || []
    },
    scales: {
      x: Object.assign({ ticks: Object.assign({}, t, { maxTicksLimit: MOBILE() ? 6 : 12 }), grid: { display: false }, border: { display: false }, stacked: !!o.stacked }, o.x || {}),
      y: Object.assign({ ticks: Object.assign({}, t, { callback: tick(o.kind), maxTicksLimit: 6 }), grid: grid, border: { display: false }, stacked: !!o.stacked, beginAtZero: o.zero !== false }, o.y || {})
    }
  };
  if (o.y2) base.scales.y2 = Object.assign({ position: 'right', ticks: Object.assign({}, t, { callback: tick(o.y2kind), maxTicksLimit: 6 }), grid: { display: false }, border: { display: false } }, o.y2);
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
function colorOf(ticker) { const i = S.cos.findIndex(c => c.ticker === ticker); return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]; }
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

// ── séries na moeda e base escolhidas ─────────────────────────────────────────
function inCcy(ser) {
  if (!ser || S.ccy !== 'usd') return ser;
  if (ser.kind === 'pct' || ser.kind === 'x' || !ser.ccy || ser.ccy === 'USD') return ser;
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
  const v = (s, k) => s && s.vals[q] != null ? s.vals[q] : '';
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
async function loadCompany(t) {
  if (S.full[t]) return S.full[t];
  const res = await rpc('get_quarterly_company', { p_ticker: t });
  const co = QV.fromCompany(res);
  if (co) { S.full[t] = co; if (res.fx) Object.keys(res.fx).forEach(k => { S.fx[k] = Object.assign({}, S.fx[k] || {}, res.fx[k]); }); }
  return co;
}
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
function chartCard(id, title, sub, big) {
  const d = document.createElement('div');
  d.className = 'card chart-card' + (big ? ' big' : '');
  d.innerHTML = '<div class="card-head"><span class="chart-title">' + esc(title) + '</span><span class="chart-sub">' + esc(sub || '') + '</span></div><div class="cv"><canvas id="' + id + '"></canvas></div>';
  $('c-charts').appendChild(d);
  S.chartMeta[id] = { title: title };
}
function ds(label, vals, qs, color, extra) {
  return Object.assign({ label: label, data: qs.map(q => vals[q] == null ? null : vals[q]), backgroundColor: color, borderColor: color, borderWidth: 1.6, pointRadius: 0, spanGaps: false }, extra || {});
}
function renderCompanyCharts(co, qs) {
  const notes = notesFor(co, qs), labels = qs.map(QV.qShort);
  const grey = isDark() ? 'rgba(170,177,187,.45)' : 'rgba(115,115,115,.45)', ink = isDark() ? '#e6e6e6' : '#1A1A1A';
  const rev = ser(co, 'revenue'), eb = ser(co, 'adj_ebitda'), mg = QV.basis(co, 'margin', S.basis);
  if (Object.keys(eb.vals).length || Object.keys(rev.vals).length) {
    chartCard('c-ch-pl', 'Revenue and adjusted EBITDA', QV.unitLabel(eb.unit || rev.unit) + (S.basis === 'ltm' ? ' · LTM' : '') + ' · margin on the right', true);
    mkChart('c-ch-pl', 'bar', labels, [ds('Net revenue', rev.vals, qs, grey), ds('Adj. EBITDA', eb.vals, qs, '#FF5000'),
      ds('Margin', mg.vals, qs, ink, { type: 'line', yAxisID: 'y2', pointRadius: 2 })],
      { kind: 'money', y2: {}, y2kind: 'pct', notes: notes, label: c => ' ' + c.dataset.label + ': ' + QV.fmt(c.parsed.y, c.dataset.yAxisID === 'y2' ? 'pct' : 'money') });
    S.chartSeries['c-ch-pl'] = [{ label: 'Net revenue', vals: rev.vals, unit: rev.unit }, { label: 'Adj. EBITDA', vals: eb.vals, unit: eb.unit }, { label: 'Adj. EBITDA margin', vals: mg.vals, unit: '%' }];
  }
  const ni = ser(co, 'net_income');
  if (Object.keys(ni.vals).length) {
    const filedAny = Object.values(ni.src || {}).includes('filed');
    chartCard('c-ch-ni', 'Net income', QV.unitLabel(ni.unit) + (filedAny ? ' · as filed (CVM/SEC)' : ' · company model'));
    mkChart('c-ch-ni', 'bar', labels, [ds('Net income', ni.vals, qs, qs.map(q => (ni.vals[q] || 0) < 0 ? '#dc2626' : '#16a34a'))], { kind: 'money', legend: false, notes: notes, zero: true });
    S.chartSeries['c-ch-ni'] = [{ label: 'Net income', vals: ni.vals, unit: ni.unit }];
  }
  group(co, qs, notes, 'c-ch-vol', 'Volumes', s => (s.std === 'sales_volume' || s.std === 'production' || /\.vol(\.|$)|^vol(\.|$)/.test(s.key)) && QV.kindOf(s.unit) === 'volume', false);
  group(co, qs, notes, 'c-ch-px', 'Realized prices', s => s.std === 'realized_price' || (s.calc && /\.px(\.|$)|^px(\.|$)/.test(s.key)), true);
  group(co, qs, notes, 'c-ch-cost', 'Cash costs', s => s.std === 'cash_cost', true);
  const segs = (co.series || []).filter(s => s.std === 'segment_ebitda');
  if (segs.length > 1) {
    chartCard('c-ch-seg', 'EBITDA by segment', QV.unitLabel(segs[0].unit), false);
    const conv = segs.map(s => inCcy(Object.assign({ id: s.key, kind: 'money', agg: 'flow' }, s, { vals: s.vals })));
    mkChart('c-ch-seg', 'bar', labels, conv.map((s, i) => ds(s.label, s.vals, qs, PALETTE[i % PALETTE.length])), { kind: 'money', stacked: true, notes: notes });
    S.chartSeries['c-ch-seg'] = conv.map(s => ({ label: s.label, vals: s.vals, unit: s.unit }));
  }
  const nd = ser(co, 'net_debt'), lev = QV.pick(co, 'leverage');
  if (Object.keys(nd.vals).length) {
    chartCard('c-ch-nd', 'Net debt and leverage', QV.unitLabel(nd.unit) + ' · net debt / LTM adj. EBITDA on the right');
    mkChart('c-ch-nd', 'bar', labels, [ds('Net debt', nd.vals, qs, grey), ds('ND / LTM EBITDA', lev.vals, qs, '#FF5000', { type: 'line', yAxisID: 'y2', pointRadius: 2 })],
      { kind: 'money', y2: {}, y2kind: 'x', notes: notes, label: c => ' ' + c.dataset.label + ': ' + QV.fmt(c.parsed.y, c.dataset.yAxisID === 'y2' ? 'x' : 'money') });
    S.chartSeries['c-ch-nd'] = [{ label: 'Net debt', vals: nd.vals, unit: nd.unit }, { label: 'Net debt / LTM adj. EBITDA', vals: lev.vals, unit: 'x' }];
  }
}
// um gráfico de linhas com as séries que passam no filtro, na unidade da série de manchete
function group(co, qs, notes, id, title, test, money) {
  let list = (co.series || []).filter(test);
  if (!list.length) return;
  const head = list.find(s => s.headline) || list[0];
  list = list.filter(s => s.unit === head.unit).slice(0, 8);
  const conv = list.map(s => { const x = Object.assign({ id: s.key, kind: QV.kindOf(s.unit), agg: s.agg || 'rate' }, s); return money ? inCcy(x) : x; });
  const kind = QV.kindOf(conv[0].unit);
  chartCard(id, title, QV.unitLabel(conv[0].unit));
  mkChart(id, 'line', qs.map(QV.qShort), conv.map((s, i) => ds(s.label, s.vals, qs, PALETTE[i % PALETTE.length], { pointRadius: 1.5 })), { kind: kind, notes: notes, zero: false });
  S.chartSeries[id] = conv.map(s => ({ label: s.label, vals: s.vals, unit: s.unit }));
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
async function metricRes(keys) {
  const k = keys.slice().sort().join(',');
  if (!S.metricRes[k]) S.metricRes[k] = rpc('get_quarterly_metric', { p_keys: keys });
  return S.metricRes[k];
}
async function renderCompare() {
  const mSel = $('m-metric');
  mSel.innerHTML = QV.COMPARE.map(m => '<option value="' + m.id + '"' + (m.id === S.metric ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('');
  mSel.onchange = () => { S.metric = mSel.value; S.fam = null; S.sel = null; render(); };
  const m = QV.COMPARE.find(x => x.id === S.metric) || QV.COMPARE[1]; S.metric = m.id;
  killCharts('m-');
  // Em "Level", R$ e US$ no mesmo eixo enganam: com moedas misturadas a comparação sai em US$ sozinha
  // (Base 100 e YoY são razões e ficam na moeda reportada)
  let rows = [], unitTxt = '', kind = m.kind, famSel = $('m-family'), autoUsd = false;
  if (!m.byDef) {
    const res = await metricRes(['revenue', 'adj_ebitda', 'net_income', 'net_debt']);
    if (S.view !== 'cmp') return;
    famSel.hidden = true;
    const ccys = new Set((res.series || []).filter(s => s.key === 'revenue').map(s => s.ccy).filter(Boolean));
    autoUsd = S.mode === 'lvl' && m.kind === 'money' && S.ccy !== 'usd' && ccys.size > 1 && QV.hasFx(S.fx, 'BRL');
    rows = S.cos.map(c => {
      const co = QV.indexCompany({ ticker: c.ticker, name: c.name, base_ccy: c.base_ccy, series: (res.series || []).filter(s => s.company === c.ticker),
        filed: (res.filed || []).filter(r => r.company === c.ticker), notes: c.notes });
      let s = m.id === 'margin' || m.id === 'leverage' ? QV.basis(co, m.id, S.basis) : ser(co, m.id);
      if (autoUsd && s && s.ccy && s.ccy !== 'USD') s = QV.toUsd(s, S.fx) || s;
      return s && Object.keys(s.vals).length ? { company: c.ticker, name: c.name, vals: s.vals, unit: s.unit, src: s.src } : null;
    }).filter(Boolean);
  } else {
    const res = await metricRes([m.std[0]]);
    if (S.view !== 'cmp') return;
    const groups = QV.compareGroups(res, m.std[0]), fams = Object.keys(groups).sort();
    if (!fams.length) { famSel.hidden = true; $('m-cos').innerHTML = '<div class="muted">No definition is reported by two or more companies yet.</div>'; $('m-table').innerHTML = ''; return; }
    if (!S.fam || !groups[S.fam]) S.fam = fams[0];
    famSel.hidden = false;
    famSel.innerHTML = fams.map(f => '<option value="' + esc(f) + '"' + (f === S.fam ? ' selected' : '') + '>' + esc(QV.familyLabel(f, groups[f][0].label)) + '</option>').join('');
    famSel.onchange = () => { S.fam = famSel.value; S.sel = null; render(); };
    const ccys = new Set(groups[S.fam].map(s => s.ccy).filter(Boolean));
    autoUsd = S.mode === 'lvl' && S.ccy !== 'usd' && ccys.size > 1 && QV.hasFx(S.fx, 'BRL');
    rows = groups[S.fam].map(s => {
      const name = (S.cos.find(c => c.ticker === s.company) || {}).name || s.company;
      const base = { id: s.key, vals: s.vals, unit: s.unit, ccy: s.ccy, agg: s.agg || 'rate', kind: QV.kindOf(s.unit) };
      const x = autoUsd && s.ccy && s.ccy !== 'USD' ? (QV.toUsd(base, S.fx) || base) : inCcy(base);
      return { company: s.company, name: name + (groups[S.fam].filter(g => g.company === s.company).length > 1 ? ' — ' + s.label : ''), vals: x.vals, unit: x.unit };
    });
    kind = QV.kindOf(rows[0] && rows[0].unit);
  }
  const units = [...new Set(rows.map(r => r.unit).filter(Boolean))];
  unitTxt = units.map(QV.unitLabel).join(' / ');
  if (!S.sel) S.sel = rows.map(r => r.company);
  const chosen = rows.filter(r => S.sel.includes(r.company));
  $('m-cos').innerHTML = rows.map(r => '<span class="chip' + (S.sel.includes(r.company) ? ' on' : '') + '" data-t="' + esc(r.company) + '"><span class="sw" style="background:' + colorOf(r.company) + '"></span>' + esc(r.name) + '</span>').join('') +
    (units.length > 1 ? '<span class="muted" style="align-self:center">Mixed units (' + esc(unitTxt) + ')' + (S.ccy !== 'usd' ? ' — switch to US$ to compare prices on one scale' : '') + '</span>' : '');
  $('m-cos').querySelectorAll('.chip').forEach(ch => ch.onclick = () => { const t = ch.dataset.t;
    S.sel = S.sel.includes(t) ? S.sel.filter(x => x !== t) : S.sel.concat([t]); render(); });
  const allQ = chosen.flatMap(r => Object.keys(r.vals)), lastQ = QV.maxQ(allQ);
  const qs = !lastQ ? [] : S.win === 'all' ? QV.qRange(QV.minQ(allQ), lastQ) : windowQs(lastQ);
  const shown = chosen.map(r => {
    let vals = r.vals;
    if (S.mode === 'yoy') { vals = {}; Object.keys(r.vals).forEach(q => { const c = QV.change(r.vals, q, 4); if (c != null) vals[q] = c; }); }
    if (S.mode === 'idx') { const b = qs.map(q => r.vals[q]).find(v => v != null && v > 0); vals = {}; if (b) qs.forEach(q => { if (r.vals[q] != null) vals[q] = r.vals[q] / b * 100; }); }
    return Object.assign({}, r, { vals: vals });
  });
  const vKind = S.mode === 'yoy' ? 'pct' : S.mode === 'idx' ? 'idx' : kind;
  $('m-title').textContent = (m.byDef ? QV.familyLabel(S.fam) : m.label) + (S.mode === 'idx' ? ' · base 100' : S.mode === 'yoy' ? ' · YoY' : '');
  $('m-sub').textContent = (S.mode === 'lvl' ? unitTxt : S.mode === 'idx' ? '100 = first quarter in the window' : 'change vs same quarter a year earlier') + (S.basis === 'ltm' && !m.byDef ? ' · LTM' : '') +
    (autoUsd ? ' · shown in US$ so all companies share one scale (average PTAX; balances at quarter-end)' : '');
  S.chartMeta['m-line'] = { title: $('m-title').textContent };
  mkChart('m-line', 'line', qs.map(QV.qShort), shown.map(r => ds(r.name, r.vals, qs, colorOf(r.company), { pointRadius: 1.5 })), { kind: vKind, zero: false,
    label: c => ' ' + c.dataset.label + ': ' + (vKind === 'idx' ? c.parsed.y.toFixed(1) : QV.fmt(c.parsed.y, vKind === 'pct' ? 'chg' : vKind)) });
  S.chartSeries['m-line'] = shown.map(r => ({ label: r.name, vals: r.vals, unit: S.mode === 'lvl' ? r.unit : '' }));
  // ranking do último trimestre com 2+ empresas
  const rq = QV.sortQ([...new Set(allQ)]).reverse().find(q => shown.filter(r => r.vals[q] != null).length >= 2) || lastQ;
  const rank = shown.filter(r => rq && r.vals[rq] != null).sort((a, b) => b.vals[rq] - a.vals[rq]);
  $('m-rank-sub').textContent = rq ? QV.qShort(rq) + (S.mode === 'lvl' && unitTxt ? ' · ' + unitTxt : '') : '';
  S.chartMeta['m-rank'] = { title: 'Latest quarter — ' + $('m-title').textContent };
  mkChart('m-rank', 'bar', rank.map(r => r.name), [{ label: QV.qShort(rq), data: rank.map(r => r.vals[rq]), backgroundColor: rank.map(r => colorOf(r.company)), borderWidth: 0 }],
    { kind: vKind, legend: false, indexAxis: 'y', x: { ticks: { callback: tick(vKind) }, grid: { display: true, color: isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' } }, y: { ticks: { callback: function (v) { return this.getLabelForValue(v); } }, beginAtZero: false },
      label: c => ' ' + QV.fmt(c.parsed.x, vKind === 'pct' ? 'chg' : vKind === 'idx' ? 'num' : vKind) });
  S.chartSeries['m-rank'] = [{ label: QV.qShort(rq), vals: Object.fromEntries(rank.map(r => [r.name, r.vals[rq]])), unit: '' }];
  // matriz com cor por coluna
  const cols = qs.slice().reverse().slice(0, 12).reverse();
  $('m-table').innerHTML = '<thead><tr><th>Company</th>' + cols.map(q => '<th>' + QV.qShort(q) + '</th>').join('') + '</tr></thead><tbody>' +
    shown.map(r => '<tr><td class="lab"><span class="chip" style="padding:0 6px 0 0;border:none;background:none"><span class="sw" style="background:' + colorOf(r.company) + '"></span></span>' + esc(r.name) + '</td>' +
      cols.map(q => { const v = r.vals[q]; if (v == null) return '<td class="flat">—</td>';
        const col = shown.map(x => x.vals[q]).filter(x => x != null), mn = Math.min.apply(null, col), mx = Math.max.apply(null, col);
        const a = mx === mn ? 0.08 : 0.06 + (v - mn) / (mx - mn) * 0.30;
        return '<td class="hc" style="background:rgba(255,80,0,' + a.toFixed(3) + ')">' + (vKind === 'idx' ? v.toFixed(0) : QV.fmt(v, vKind === 'pct' ? 'chg' : vKind)) + '</td>'; }).join('') + '</tr>').join('') + '</tbody>';
  $('m-foot').innerHTML = '<div class="foot">Only metrics with the same definition are compared. ' + (m.byDef ? 'Definitions follow each company\'s reporting; a product reported in R$ and in US$ is put on one scale with the US$ switch. ' : '') +
    'Adjusted EBITDA as in Itaú BBA\'s company models; net income as filed where in the reporting currency.</div>';
  $('m-xls').onclick = () => download(QV.aoaCompare(chosen.map(r => ({ company: r.company, name: r.name, vals: r.vals })), $('m-title').textContent, units.length === 1 ? units[0] : ''),
    $('m-title').textContent, 'quarterly_compare_' + (S.fam || S.metric));
  attachExports('quarterly_compare');
}

// ════════════════════════════ geral ═══════════════════════════════════════════
function syncControls() {
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  document.querySelectorAll('#ccy button').forEach(b => b.classList.toggle('on', b.dataset.c === S.ccy));
  document.querySelectorAll('#basis button').forEach(b => b.classList.toggle('on', b.dataset.b === S.basis));
  document.querySelectorAll('#win button').forEach(b => b.classList.toggle('on', String(b.dataset.w) === String(S.win)));
  document.querySelectorAll('#m-mode button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  const usdOk = QV.hasFx(S.fx, 'BRL');
  const u = document.querySelector('#ccy button[data-c="usd"]'); if (u) { u.disabled = !usdOk; u.title = usdOk ? '' : 'Exchange rates are not loaded yet'; }
  if (!usdOk && S.ccy === 'usd') S.ccy = 'rep';
  $('win').style.visibility = S.view === 'board' ? 'hidden' : 'visible';
  $('v-board').hidden = S.view !== 'board'; $('v-co').hidden = S.view !== 'co'; $('v-cmp').hidden = S.view !== 'cmp';
}
function render() {
  syncControls(); writeHash();
  const p = S.view === 'co' ? renderCompany() : S.view === 'cmp' ? renderCompare() : Promise.resolve(renderBoard());
  Promise.resolve(p).catch(e => { console.error(e); });
}
function go(view, arg) {
  S.view = view;
  if (view === 'co' && arg) S.co = arg;
  if (view === 'cmp' && arg) { S.metric = arg; S.fam = null; S.sel = null; }
  render(); window.scrollTo({ top: 0 });
}
function bind() {
  document.querySelectorAll('#views button').forEach(b => b.onclick = () => go(b.dataset.v));
  document.querySelectorAll('#ccy button').forEach(b => b.onclick = () => { S.ccy = b.dataset.c; render(); });
  document.querySelectorAll('#basis button').forEach(b => b.onclick = () => { S.basis = b.dataset.b; render(); });
  document.querySelectorAll('#win button').forEach(b => b.onclick = () => { S.win = b.dataset.w === 'all' ? 'all' : +b.dataset.w; render(); });
  document.querySelectorAll('#m-mode button').forEach(b => b.onclick = () => { S.mode = b.dataset.m; render(); });
  $('b-q').onchange = () => { S.q = $('b-q').value; render(); };
  window.addEventListener('ibba:theme', () => { themeChart(); render(); });
  window.addEventListener('hashchange', () => { const v = S.view, c = S.co; readHash(); if (v !== S.view || c !== S.co) render(); });
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
    S.cos = QV.fromBoot(boot); S.fx = boot.fx || {}; S.season = QV.seasonQ(S.cos);
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
