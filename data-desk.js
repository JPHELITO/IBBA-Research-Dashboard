/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — motor da "mesa de leitura" das abas de dados (M&M e P&P)
   ────────────────────────────────────────────────────────────────────────────
   Plano: IBBA-Dashboard/data-desk/PLANO.md · chave: data_desk (admin vê sempre; ?desk=0 força a tela antiga)

   Três partes, nesta ordem:
     (a) NÚCLEO PURO  (IBBADesk.core)  — eixo de meses, períodos (mês/trimestre/ano), janelas, somas,
         variações. Não toca na tela: é o que os testes exercitam (tests/test_data_desk.html).
     (b) GRÁFICOS     — fábrica Chart.js com a régua nova (PLANO 5.9.1): sem linha pontilhada; o
         período sob o mouse ganha uma FAIXA suave, as outras barras recuam, um anel marca o ponto.
     (c) INTERFACE    — tiles, palco, faixa de período, painel de leitura, "quem", miniaturas.

   A página continua dona dos FILTROS (Product, Granularity, Window, datas): os botões de sempre
   chamam as funções de sempre; a mesa só LÊ esse estado (cfg.state()) e redesenha. Nada de dado
   novo aqui dentro: cada página declara o seu catálogo (IBBADesk.mount).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.IBBADesk) return;

  /* ══ (a) NÚCLEO PURO ═══════════════════════════════════════════════════════ */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WIN_MO = { '5y': 60, '3y': 36, '1y': 12, '6m': 6, '3m': 3 };

  function ymIndex(ym) { return (+ym.slice(0, 4)) * 12 + (+ym.slice(5, 7)) - 1; }
  function ymOf(i) { var y = Math.floor(i / 12), m = i % 12 + 1; return y + '-' + (m < 10 ? '0' : '') + m; }
  /* eixo contínuo de meses 'AAAA-MM' entre dois extremos (inclusive) */
  function axis(from, to) { var a = [], i = ymIndex(from), e = ymIndex(to); for (; i <= e; i++) a.push(ymOf(i)); return a; }
  /* { 'AAAA-MM': valor } → vetor alinhado ao eixo (null onde não há dado) */
  function align(map, ax) { var o = new Array(ax.length); for (var i = 0; i < ax.length; i++) { var v = map ? map[ax[i]] : null; o[i] = (v == null || !isFinite(v)) ? null : +v; } return o; }

  /* períodos da granularidade: só os COMPLETOS (trimestre com 3 meses, ano com 12) — regra de sempre */
  function buildPeriods(ax, gran) {
    var P = [], i;
    if (gran === 'monthly') {
      for (i = 0; i < ax.length; i++) { var y0 = +ax[i].slice(0, 4), m0 = +ax[i].slice(5, 7);
        P.push({ a: i, b: i, y: y0, k: m0 - 1, key: ax[i], label: MON[m0 - 1] + '-' + String(y0).slice(2) }); }
      return P;
    }
    var need = gran === 'quarterly' ? 3 : 12, g = {}, order = [];
    for (i = 0; i < ax.length; i++) {
      var y = +ax[i].slice(0, 4), m = +ax[i].slice(5, 7), q = Math.ceil(m / 3), id = gran === 'quarterly' ? y * 10 + q : y;
      if (!g[id]) { g[id] = { y: y, q: q, idx: [] }; order.push(id); }
      g[id].idx.push(i);
    }
    order.forEach(function (id) { var o = g[id]; if (o.idx.length !== need) return;
      P.push(gran === 'quarterly'
        ? { a: o.idx[0], b: o.idx[2], y: o.y, k: o.q - 1, key: o.y + '-Q' + o.q, label: o.q + 'Q' + String(o.y).slice(2) }
        : { a: o.idx[0], b: o.idx[11], y: o.y, k: 0, key: String(o.y), label: String(o.y) }); });
    return P;
  }
  function perYear(gran) { return gran === 'monthly' ? 12 : gran === 'quarterly' ? 4 : 1; }

  /* janela em MESES do eixo [m0, m1]. `last` = índice do último mês com dado.
     Botões fixos: do último mês para trás, INCLUINDO o mês de corte (3M = 4 pontos, como sempre foi).
     YTD = o ano do ÚLTIMO DADO (antes era o ano do relógio: em janeiro o gráfico ficava vazio). */
  function monthWindow(ax, last, st) {
    var n = ax.length, m0 = 0, m1 = last;
    if (st.win === 'custom') {
      if (st.from) { m0 = 0; while (m0 < n && ax[m0] < st.from) m0++; }
      if (st.to) { m1 = n - 1; while (m1 >= 0 && ax[m1] > st.to) m1--; }
      if (m0 > n - 1) m0 = n - 1; if (m1 < 0) m1 = 0; if (m0 > m1) m0 = m1;
    } else if (st.win === 'ytd') { var y = ax[last].slice(0, 4); m0 = ax.indexOf(y + '-01'); if (m0 < 0) m0 = 0; }
    else if (WIN_MO[st.win]) m0 = Math.max(0, last - WIN_MO[st.win]);
    return [m0, m1];
  }
  /* períodos mostrados: os que TERMINAM dentro da janela de meses */
  function periodWindow(P, m0, m1) {
    var i0 = -1, i1 = -1, i;
    for (i = 0; i < P.length; i++) if (P[i].b >= m0 && P[i].b <= m1) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 < 0) { for (i = P.length - 1; i >= 0; i--) if (P[i].b <= m1) { i0 = i1 = i; break; } if (i0 < 0) i0 = i1 = Math.max(0, P.length - 1); }
    return [i0, i1];
  }

  /* agregadores: recebem um vetor MENSAL e devolvem um vetor por período */
  function aggregators(P, PER) {
    function sum(a) { return P.map(function (p) { var s = 0; for (var i = p.a; i <= p.b; i++) { if (a[i] == null) return null; s += a[i]; } return s; }); }
    function last(a) { return P.map(function (p) { return a[p.b]; }); }
    function roll(v) { return v.map(function (_, i) { if (i < PER - 1) return null; var s = 0; for (var k = i - PER + 1; k <= i; k++) { if (v[k] == null) return null; s += v[k]; } return s; }); }
    function rollAvg(v) { return roll(v).map(function (x) { return x == null ? null : x / PER; }); }
    return {
      level: { sum: sum, last: last, ltm: false },
      /* últimos 12 meses (4 trimestres): soma p/ fluxo; `last` vira a média móvel do período */
      ltm: { sum: function (a) { return roll(sum(a)); }, last: function (a) { return rollAvg(last(a)); }, ltm: true }
    };
  }
  var F = {
    div: function (n, d, k) { k = k == null ? 1 : k; return n.map(function (x, i) { return (x == null || !d[i]) ? null : x / d[i] * k; }); },
    sub: function (a, b) { return a.map(function (x, i) { return (x == null || b[i] == null) ? null : x - b[i]; }); },
    add: function (a, b) { return a.map(function (x, i) { return (x == null || b[i] == null) ? null : x + b[i]; }); },
    mul: function (a, b) { return a.map(function (x, i) { return (x == null || b[i] == null) ? null : x * b[i]; }); }
  };
  function lastIdx(a) { for (var i = a.length - 1; i >= 0; i--) if (a[i] != null) return i; return -1; }
  /* variação entre o período i e i-k: % para níveis; diferença para pp e para spreads */
  function change(v, i, k, M) { var a = v[i], b = v[i - k]; if (a == null || b == null) return null; return (M && (M.pp || M.diff)) ? a - b : (b ? (a / Math.abs(b) - (b < 0 ? -1 : 1)) * 100 : null); }
  function rangeN(a, i, n) {
    if (a[i] == null) return null; var sl = [], k;
    for (k = Math.max(0, i - n + 1); k <= i; k++) if (a[k] != null) sl.push(a[k]);
    var mn = Math.min.apply(null, sl), mx = Math.max.apply(null, sl);
    return { mn: mn, mx: mx, pos: mx > mn ? (a[i] - mn) / (mx - mn) : .5, rank: sl.filter(function (v) { return v > a[i]; }).length + 1, n: sl.length };
  }
  function fmt(v, d) { return (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function pct(v, d) { return (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d) + '%'; }
  function chgTxt(M, v) { if (v == null || !isFinite(v)) return '—'; var s = v > 0 ? '+' : v < 0 ? '−' : ''; return M.pp ? s + Math.abs(v).toFixed(1) + ' pp' : M.diff ? s + fmt(Math.abs(v), M.dec || 0) : pct(v); }
  function cls(v) { return (v == null || !isFinite(v) || v === 0) ? '' : v > 0 ? 'dk-up' : 'dk-dn'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  var core = { MON: MON, ymIndex: ymIndex, ymOf: ymOf, axis: axis, align: align, buildPeriods: buildPeriods, perYear: perYear,
    monthWindow: monthWindow, periodWindow: periodWindow, aggregators: aggregators, F: F, lastIdx: lastIdx, change: change,
    rangeN: rangeN, fmt: fmt, pct: pct, chgTxt: chgTxt };

  /* ══ (b) GRÁFICOS ══════════════════════════════════════════════════════════ */
  var FONT = "'Manrope','Inter','Segoe UI',Helvetica,Arial,sans-serif";
  function isDark() { return document.documentElement.classList.contains('dark'); }
  function theme(stage) {
    var d = isDark();
    if (stage) return { dark: true, surf: d ? '#08090b' : '#0f1012', ink: '#f3f1ec', mut: d ? '#8d929b' : '#9a968e', grid: d ? '#1f2227' : '#24262a', band: '255,255,255', veil: d ? '8,9,11' : '15,16,18' };
    return d ? { dark: true, surf: '#1c2026', ink: '#e8eaed', mut: '#828892', grid: 'rgba(255,255,255,.06)', band: '255,255,255', veil: '28,32,38' }
             : { dark: false, surf: '#FDFCFA', ink: '#111111', mut: '#7b7770', grid: '#ECE8E0', band: '17,17,17', veil: '253,252,250' };
  }
  var ORANGE = '#FF5000';
  var UP = function () { return isDark() ? '#22c55e' : '#1c7c45'; }, DOWN = function () { return isDark() ? '#ef4444' : '#b83227'; };
  /* paleta sóbria do empilhado: uma família (azuis, verde-água, areia, lilás); a cor acompanha a ENTIDADE */
  var PAL_L = ['#22304a', '#3f72b5', '#8fb3de', '#2a9d8f', '#b79a5c', '#8a6fb3', '#5f7d95', '#c98a6b', '#6aa5a0', '#9aa6c4', '#7a8f5a', '#b784a7'];
  var PAL_D = ['#e3e6ec', '#5b8fd6', '#9cc0ea', '#3fb8a8', '#c9b47a', '#a892d6', '#8fa9bf', '#d9a084', '#7fc1bb', '#b4bedb', '#9db57a', '#cf9fc0'];
  function slotColor(slot) { return slot === 'lead' ? ORANGE : slot === 'others' ? (isDark() ? '#474d57' : '#d3cfc7') : (isDark() ? PAL_D : PAL_L)[slot % PAL_L.length]; }

  function rr(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath(); }

  /* Plugin da mesa: faixa suave do período, anéis, recuo das outras barras, total do empilhado e marcadores A/B.
     Lê chart.$dk = {hover, pinA, pinB} (índices LOCAIS do gráfico) — desenhar não refaz layout. */
  var syncPlugin = {
    id: 'ibbaDeskSync',
    _geo: function (chart) {
      var a = chart.chartArea, xs = chart.scales.x, n = chart.data.labels.length; if (!a || !xs || !n) return null;
      var slot = n > 1 ? Math.abs(xs.getPixelForValue(1) - xs.getPixelForValue(0)) : a.width;
      return { a: a, xs: xs, n: n, slot: slot };
    },
    beforeDatasetsDraw: function (chart, _a, o) {
      var s = chart.$dk, g; if (!o || !o.on || !s || s.hover == null || s.hover < 0) return; g = this._geo(chart); if (!g || s.hover >= g.n) return;
      var t = theme(o.stage), x = g.xs.getPixelForValue(s.hover), w = o.bar ? Math.min(g.slot, Math.min(34, g.slot * .72) + 12) : Math.max(22, Math.min(46, g.slot));
      var c = chart.ctx, gr = c.createLinearGradient(0, g.a.top, 0, g.a.bottom);
      gr.addColorStop(0, 'rgba(' + t.band + ',' + (t.dark ? .11 : .075) + ')'); gr.addColorStop(1, 'rgba(' + t.band + ',' + (t.dark ? .02 : .015) + ')');
      c.save(); c.fillStyle = gr; rr(c, x - w / 2, g.a.top - 6, w, g.a.height + 12, 7); c.fill(); c.restore();
    },
    afterDatasetsDraw: function (chart, _a, o) {
      var s = chart.$dk, g; if (!o || !o.on || !s) return; g = this._geo(chart); if (!g) return;
      var t = theme(o.stage), c = chart.ctx, a = g.a, hv = s.hover;
      c.save();
      if (hv != null && hv >= 0 && hv < g.n) {
        var x = g.xs.getPixelForValue(hv);
        if (o.bar) {   // as outras barras recuam: um véu na cor do fundo dos dois lados da coluna
          var half = Math.min(g.slot, Math.min(34, g.slot * .72) + 12) / 2;
          c.fillStyle = 'rgba(' + t.veil + ',' + (t.dark ? .34 : .24) + ')';
          c.fillRect(a.left, a.top - 2, Math.max(0, x - half - a.left), a.height + 3);
          c.fillRect(x + half, a.top - 2, Math.max(0, a.right - x - half), a.height + 3);
          if (o.stack && !o.share) {   // total do período, escrito acima da barra
            var tot = 0; chart.data.datasets.forEach(function (d, k) { if (chart.isDatasetVisible(k)) tot += (+d.data[hv] || 0); });
            var yT = chart.scales.y.getPixelForValue(tot);
            c.font = '700 10px ' + FONT; c.textAlign = 'center'; c.fillStyle = t.ink; c.fillText(fmt(tot, 0), x, yT - 5);
          }
        } else {
          chart.data.datasets.forEach(function (d, k) {
            if (d.$noDot || d.type === 'bar' || !chart.isDatasetVisible(k)) return; var v = d.data[hv]; if (v == null) return;
            var sc = chart.scales[d.yAxisID || 'y'], y = sc.getPixelForValue(v);
            c.beginPath(); c.arc(x, y, 4.5, 0, Math.PI * 2); c.fillStyle = t.surf; c.fill(); c.lineWidth = 2.2; c.strokeStyle = d.$ring || d.borderColor || ORANGE; c.stroke();
          });
        }
      }
      [['pinA', ORANGE, 'A', '#fff'], ['pinB', t.dark ? '#f3f1ec' : '#111111', 'B', t.dark ? '#111' : '#fff']].forEach(function (p) {
        var i = s[p[0]]; if (i == null || i < 0 || i >= g.n) return; var px = g.xs.getPixelForValue(i);
        c.globalAlpha = .85; c.beginPath(); c.moveTo(px, a.top + (o.mini ? 0 : 6)); c.lineTo(px, a.bottom); c.lineWidth = 1.2; c.strokeStyle = p[1]; c.setLineDash([]); c.stroke(); c.globalAlpha = 1;
        if (!o.mini) { c.beginPath(); c.arc(px, a.top, 7, 0, Math.PI * 2); c.fillStyle = p[1]; c.fill(); c.font = '700 8.5px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = p[3]; c.fillText(p[2], px, a.top + .5); c.textBaseline = 'alphabetic'; }
      });
      c.restore();
    }
  };
  var _registered = false;
  function ensurePlugin() { if (_registered || !window.Chart) return; Chart.register(syncPlugin); _registered = true; }

  /* opções-base: um eixo Y, grade horizontal fina, rótulos do X ancorados no ÚLTIMO período, sem dica flutuante */
  function chartOptions(o) {
    var t = theme(o.stage), tick = { color: t.mut, font: { size: 9.5, family: FONT } };
    return {
      responsive: true, maintainAspectRatio: false, events: [], locale: 'en-US',
      animation: o.animate ? { duration: 280 } : false,
      layout: { padding: o.mini ? { top: 6, right: 3, bottom: 3, left: 3 } : { top: o.stack ? 18 : 12, right: 10, bottom: 0, left: 0 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false }, datalabels: { display: false }, ibbaCross: false,
        ibbaDeskSync: { on: true, stage: !!o.stage, bar: !!o.bar, stack: !!o.stack, share: !!o.share, mini: !!o.mini } },
      scales: {
        x: { display: !o.mini, stacked: !!o.stack, offset: !!o.bar, grid: { display: false }, border: { display: false },
          ticks: Object.assign({}, tick, { autoSkip: false, maxRotation: 0, padding: 4,
            callback: function (val, index) { var n = this.chart.data.labels.length, room = Math.max(2, Math.floor((this.chart.width - 60) / 62)), skip = Math.max(1, Math.ceil(n / room));
              return ((n - 1 - index) % skip === 0) ? this.getLabelForValue(val) : null; } }) },
        y: Object.assign({ display: !o.mini, stacked: !!o.stack, border: { display: false }, grid: { color: t.grid, drawTicks: false },
          ticks: Object.assign({}, tick, { maxTicksLimit: 6, padding: 8, callback: function (v) { return fmt(v, (o.dec > 0 && Math.abs(this.max - this.min) < 10) ? 1 : 0); } }) },
          o.share ? { min: 0, max: 100 } : {}, o.mini ? { grace: '8%' } : {})
      }
    };
  }
  function areaFill(c) { var ch = c.chart, a = ch.chartArea; if (!a) return 'rgba(255,80,0,.18)'; var g = ch.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, 'rgba(255,80,0,.30)'); g.addColorStop(1, 'rgba(255,80,0,0)'); return g; }
  function lineSet(data, color, o) { o = o || {}; var li = lastIdx(data);
    return { type: 'line', label: o.label || '', data: data, borderColor: color, borderWidth: o.w || 2, tension: 0, spanGaps: false, borderJoinStyle: 'round', borderCapStyle: 'round',
      borderDash: o.dash || [], fill: o.area ? 'origin' : false, backgroundColor: o.area ? areaFill : 'transparent', $noDot: !!o.noDot, $ring: color,
      pointRadius: function (c) { return (o.end && c.dataIndex === li) ? 3.5 : 0; }, pointBackgroundColor: color, pointBorderColor: o.surf || '#0f1012', pointBorderWidth: 2, pointHoverRadius: 0, order: o.order || 1 }; }
  function barSet(data, color, o) { o = o || {};
    return { type: 'bar', label: o.label || '', data: data, backgroundColor: color, borderWidth: o.gap ? { top: 0, right: 0, bottom: 1.5, left: 0 } : 0, borderColor: o.surf || 'transparent',
      borderRadius: 4, borderSkipped: o.stacked ? false : 'start', maxBarThickness: 34, categoryPercentage: 1, barPercentage: .72, stack: o.stacked ? 's' : undefined }; }

  /* ══ (c) INTERFACE ═════════════════════════════════════════════════════════ */
  function h(tag, cl, html) { var e = document.createElement(tag); if (cl) e.className = cl; if (html != null) e.innerHTML = html; return e; }
  function sparkSVG(v, w, hh) {
    var pts = [], i; for (i = 0; i < v.length; i++) if (v[i] != null) pts.push([i, v[i]]); if (pts.length < 2) return '';
    var mn = Math.min.apply(null, pts.map(function (p) { return p[1]; })), mx = Math.max.apply(null, pts.map(function (p) { return p[1]; })), n = v.length - 1;
    var X = function (i2) { return 2 + i2 / n * (w - 4); }, Y = function (y) { return hh - 2 - (mx > mn ? (y - mn) / (mx - mn) : .5) * (hh - 4); };
    var d = pts.map(function (p, j) { return (j ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(''), lp = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="' + X(lp[0]).toFixed(1) + '" cy="' + Y(lp[1]).toFixed(1) + '" r="2.2" fill="' + ORANGE + '"/></svg>';
  }

  function Desk(cfg) {
    this.cfg = cfg; this.sections = cfg.sections || {}; this.cur = null; this.charts = {}; this.ui = {};   // ui[secId] = {metric, mode, hover, pinA, pinB, who:{...}}
    this.root = typeof cfg.root === 'string' ? document.querySelector(cfg.root) : cfg.root;
    this._cache = {}; this._slots = {}; this._slotN = 0; this._ovr = null; this._raf = 0;
    ensurePlugin();
    var self = this;
    window.addEventListener('ibba:theme', function () { if (self.cur) self.refresh(); });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (self.cur) self._brush(); }, 200); });
  }
  Desk.prototype.has = function (id) { return !!this.sections[id]; };
  Desk.prototype._u = function () { var id = this.cur; return this.ui[id] || (this.ui[id] = { metric: this.sections[id].stage, mode: 'level', hover: null, pinA: null, pinB: null, who: { dim: 0, pill: null, sel: null, mode: 'volume', hi: null } }); };

  /* monta o contexto da seção para o estado atual dos filtros */
  Desk.prototype._ctx = function () {
    var sec = this.sections[this.cur], st = Object.assign({}, this.cfg.state(), this._ovr || {}), u = this._u(), self = this;
    var ck = this.cur + '|' + st.prod, base = this._cache[ck];
    if (!base) {   // componentes mensais alinhados a um eixo único da seção (por produto)
      var maps = {}, lo = null, hi = null;
      sec.metrics.forEach(function (M) { var c = M.comp({ prod: st.prod }) || {}; maps[M.id] = c;
        Object.keys(c).forEach(function (k) { var m = c[k]; if (!m) return; for (var p in m) { if (m[p] == null) continue; if (lo == null || p < lo) lo = p; if (hi == null || p > hi) hi = p; } }); });
      if (lo == null) { lo = hi = '2000-01'; }
      var ax = axis(lo, hi), comp = {};
      sec.metrics.forEach(function (M) { comp[M.id] = {}; Object.keys(maps[M.id]).forEach(function (k) { comp[M.id][k] = align(maps[M.id][k], ax); }); });
      base = this._cache[ck] = { ax: ax, comp: comp };
    }
    var P = buildPeriods(base.ax, st.gran), PER = perYear(st.gran), A = aggregators(P, PER);
    var mw = monthWindow(base.ax, base.ax.length - 1, st), pw = periodWindow(P, mw[0], mw[1]), memo = {};
    var ctx = { sec: sec, st: st, u: u, ax: base.ax, P: P, PER: PER, A: A, i0: pw[0], i1: pw[1], m0: mw[0], m1: mw[1],
      M: function (id) { for (var i = 0; i < sec.metrics.length; i++) if (sec.metrics[i].id === id) return sec.metrics[i]; return null; },
      has: function (id) { var M = this.M(id); return !!M && (!M.available || M.available({ prod: st.prod })); },
      vals: function (id, mode) { mode = mode || 'level'; var key = id + '|' + mode; if (memo[key]) return memo[key];
        var M = this.M(id), c = base.comp[id], v;
        if (mode === 'ltm') v = M.calc(A.ltm, c, { gran: st.gran, prod: st.prod });
        else { v = M.calc(A.level, c, { gran: st.gran, prod: st.prod }); if (mode === 'yoy') { var lv = v; v = lv.map(function (_, i) { return change(lv, i, PER, M); }); } }
        return (memo[key] = v); },
      label: function (i) { return P[i] ? P[i].label : ''; }
    };
    return ctx;
  };

  /* ── esqueleto da seção (uma vez por seção) ── */
  Desk.prototype._build = function () {
    var r = this.root, self = this; r.innerHTML = '';
    var body = h('div', 'dk-body');
    this.el = { tiles: h('div', 'dk-tiles'), cols: h('div', 'dk-cols'), main: h('div', 'dk-main'), side: h('div', 'dk-side') };
    var E = this.el;
    E.stage = h('div', 'dk-stage dk-card chart-card',
      '<div class="dk-sh"><div><div class="dk-st chart-title"></div><div class="dk-sv"></div></div><div class="dk-sd chart-sub"></div><span class="dk-grow"></span><div class="dk-seg dk-modes" role="group" aria-label="View"></div></div>' +
      '<div class="dk-chart dk-stagechart"><canvas id="dk-stage-cv"></canvas></div><div class="dk-brush"></div>' +
      '<div class="dk-hint">Hover: read · Click: pin A, then B · Drag the strip: change period</div>');
    E.who = h('div', 'dk-card dk-who chart-card',
      '<div class="dk-ch"><h3 class="chart-title">Who is behind the number</h3><em class="dk-when"></em></div>' +
      '<div class="dk-whotop"><div class="dk-seg dk-dims" role="group" aria-label="Breakdown by" hidden></div><div class="dk-pills" role="group" aria-label="Sub-product"></div><span class="dk-grow"></span><div class="dk-seg dk-whomodes" role="group" aria-label="Breakdown view"></div>' +
      '<div class="dk-pop"><button type="button" class="dk-pill dk-popbtn" aria-expanded="false"></button><div class="dk-popp" hidden></div></div></div>' +
      '<div class="dk-whogrid"><div class="dk-rank"></div><div class="dk-chart dk-whochart"><canvas id="dk-who-cv"></canvas></div></div>');
    E.minis = h('div', 'dk-minis');
    E.read = h('div', 'dk-card dk-read', '<div class="dk-ch"><h3>Reading</h3><em class="dk-when"></em></div><div class="dk-big"></div><div class="dk-kv"></div><div class="dk-pins"></div>');
    E.main.appendChild(E.stage); E.main.appendChild(E.who); E.main.appendChild(E.minis);
    E.side.appendChild(E.read);
    E.cols.appendChild(E.main); E.cols.appendChild(E.side);
    var sec0 = this.sections[this.cur], vs = (sec0.views || []).filter(function (v) { return !v.visible || v.visible(); });
    if (vs.length > 1) { E.views = h('div', 'dk-seg dk-views', vs.map(function (v, k) { return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === 0) + '">' + esc(v.label) + '</button>'; }).join(''));
      E.views.setAttribute('role', 'group'); E.views.setAttribute('aria-label', 'View');
      E.views.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var v = vs[+b.dataset.k]; if (v && v.onPick) v.onPick(); });
      var vb = h('div', 'dk-viewbar'); vb.appendChild(E.views); body.appendChild(vb); }
    body.appendChild(E.tiles); body.appendChild(E.cols); r.appendChild(body);
    // eventos fixos
    E.tiles.addEventListener('click', function (e) { var b = e.target.closest('.dk-tile[data-k]'); if (!b) return; self._u().metric = b.dataset.k; self.refresh(); });
    E.minis.addEventListener('click', function (e) { if (e.target.closest('.ibba-dl')) return; var b = e.target.closest('.dk-mini[data-k]'); if (!b) return; self._u().metric = b.dataset.k; self.refresh(); });
    E.stage.querySelector('.dk-modes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || b.disabled) return; self._u().mode = b.dataset.k; self.refresh(); });
    E.who.querySelector('.dk-whomodes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; self._u().who.mode = b.dataset.k; self._who(); });
    E.who.querySelector('.dk-dims').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var w = self._u().who; w.dim = +b.dataset.k; w.pill = null; w.sel = null; w.hi = null; self._who(); self._paintMarks(); self._rank(); });
    E.who.querySelector('.dk-pills').addEventListener('click', function (e) { var b = e.target.closest('.dk-pill'); if (!b) return; var w = self._u().who; w.pill = b.dataset.k; w.sel = null; w.hi = null; self._who(); self._rank(); });
    var pb = E.who.querySelector('.dk-popbtn'), pp = E.who.querySelector('.dk-popp');
    pb.addEventListener('click', function (e) { e.stopPropagation(); self._openPop(pp.hidden); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.dk-pop')) self._openPop(false); });
    this._bindHover(E.stage.querySelector('canvas'), 'stage'); this._bindHover(E.who.querySelector('canvas'), 'who');
    this._built = this.cur;
  };
  Desk.prototype._openPop = function (open) { var E = this.el; if (!E) return; var pp = E.who.querySelector('.dk-popp'), pb = E.who.querySelector('.dk-popbtn'); pp.hidden = !open; pb.setAttribute('aria-expanded', open ? 'true' : 'false'); if (open) { this._fillPop(); var q = pp.querySelector('input[type=search]'); if (q) q.focus(); } };

  /* mouse → índice do período; um quadro por movimento */
  Desk.prototype._bindHover = function (cv, id) {
    var self = this;
    var at = function (ev) { var ch = self.charts[id]; if (!ch || !ch.chartArea) return null; var r = cv.getBoundingClientRect(), x = ev.clientX - r.left, xs = ch.scales.x, n = ch.data.labels.length;
      var i = Math.round(xs.getValueForPixel(x)); return Math.max(0, Math.min(n - 1, i)); };
    cv.addEventListener('pointermove', function (ev) { var i = at(ev); if (i == null) return; var ch = self.charts[id]; if (ch.$local) { self._localHover(id, i); return; } self.hover(self.ctx.i0 + i); });
    cv.addEventListener('pointerleave', function () { var ch = self.charts[id]; if (ch && ch.$local) { self._localHover(id, null); return; } self.hover(null); });
    cv.addEventListener('click', function (ev) { var ch = self.charts[id]; if (!ch || ch.$local) return; var i = at(ev); if (i != null) self.pick(self.ctx.i0 + i); });
  };
  Desk.prototype.hover = function (i) {
    var u = this._u(); if (u.hover === i) return; u.hover = i; var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._paintMarks(); self._read(); self._rank(); self._miniHeads(); });
  };
  Desk.prototype._paintMarks = function () {
    var u = this._u(), c = this.ctx, k;
    for (k in this.charts) { var ch = this.charts[k]; if (!ch || ch.$local) continue;
      ch.$dk = { hover: u.hover == null ? null : u.hover - c.i0, pinA: u.pinA == null ? null : u.pinA - c.i0, pinB: u.pinB == null ? null : u.pinB - c.i0 }; ch.draw(); }
  };
  Desk.prototype.pick = function (i) { var u = this._u(); if (u.pinA == null || (u.pinA != null && u.pinB != null)) { u.pinA = i; u.pinB = null; } else if (i === u.pinA) u.pinA = null; else u.pinB = i; this._paintMarks(); this._read(); this._rank(); };
  Desk.prototype._ref = function () { var u = this._u(), c = this.ctx; if (u.hover != null) return u.hover; if (u.pinA != null) return u.pinA; var li = lastIdx(c.vals(u.metric)); return li < 0 ? c.i1 : Math.min(li, c.P.length - 1); };

  /* cria ou atualiza um gráfico Chart.js no canvas */
  Desk.prototype._chart = function (id, cv, type, labels, datasets, o) {
    var ch = this.charts[id], opt = chartOptions(o);
    if (ch && ch.canvas === cv && ch.config.type === type) { ch.data.labels = labels; ch.data.datasets = datasets; ch.options = opt; ch.$local = !!o.local; ch.update('none'); return ch; }
    if (ch) ch.destroy();
    opt.animation = o.animate === false ? false : { duration: 280 };
    ch = this.charts[id] = new Chart(cv.getContext('2d'), { type: type, data: { labels: labels, datasets: datasets }, options: opt });
    ch.$local = !!o.local; ch.options.animation = false;   // nasce crescendo; as trocas de filtro não animam
    return ch;
  };
  Desk.prototype._dropCharts = function (prefix) { for (var k in this.charts) if (k.indexOf(prefix) === 0) { try { this.charts[k].destroy(); } catch (e) {} delete this.charts[k]; } };

  /* ── redesenho ── */
  Desk.prototype.show = function (id) {
    if (!this.sections[id]) return false;
    if (this.cur !== id) { this.cur = id; this._destroyAll(); this._built = null; }
    this.refresh(); return true;
  };
  Desk.prototype.hide = function () { this.cur = null; this._destroyAll(); };
  Desk.prototype._destroyAll = function () { for (var k in this.charts) { try { this.charts[k].destroy(); } catch (e) {} } this.charts = {}; };
  Desk.prototype.invalidate = function () { this._cache = {}; this._who_cache = {}; };
  Desk.prototype.refresh = function (light) {
    if (!this.cur) return;
    if (this._built !== this.cur) this._build();
    var st = this.cfg.state(), u = this._u();
    if (this._lastProd !== st.prod || this._lastGran !== st.gran) { if (this._lastProd !== st.prod) { u.who.pill = null; u.who.sel = null; u.who.hi = null; } u.hover = u.pinA = u.pinB = null; this._lastProd = st.prod; this._lastGran = st.gran; }
    var c = this.ctx = this._ctx();
    if (!c.has(u.metric)) u.metric = this.sections[this.cur].stage;
    if (st.gran === 'annual' && (u.mode === 'ltm' || u.mode === 'seasonal')) u.mode = 'level';
    if (!light) this._tiles();
    this._stage(); if (!light) this._brush();
    this._who(); this._minis(); this._paintMarks(); this._read(); this._rank();
    if (!light && this.cfg.afterRender) { try { this.cfg.afterRender(this); } catch (e) { console.warn('desk afterRender', e); } }
  };

  Desk.prototype._tiles = function () {
    var c = this.ctx, u = this._u(), prev = { monthly: 'MoM', quarterly: 'QoQ', annual: 'YoY' }[c.st.gran];
    this.el.tiles.innerHTML = c.sec.tiles.map(function (id) {
      var M = c.M(id); if (!M) return '';
      if (!c.has(id)) return '<div class="dk-tile dk-off"><div class="dk-tl"><span>' + esc(M.label) + '</span></div><div class="dk-tv">—</div><div class="dk-td">' + esc(M.naText || 'Not available for this selection') + '</div></div>';
      var v = c.vals(id), i = lastIdx(v); if (i < 0) return '';
      var r = rangeN(v, i, 5 * c.PER), mo = change(v, i, 1, M), yy = change(v, i, c.PER, M), sp = v.slice(Math.max(0, i - 2 * c.PER + 1), i + 1), lbl = typeof M.label === 'function' ? M.label({ prod: c.st.prod }) : M.label;
      return '<button type="button" class="dk-tile" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '"><div class="dk-tl"><span>' + esc(lbl) + '</span><span>' + c.label(i) + '</span></div>' +
        '<div class="dk-tv">' + fmt(v[i], M.dec) + '<small>' + esc(M.unit) + '</small></div>' +
        '<div class="dk-td"><span>' + prev + ' <span class="' + cls(mo) + '">' + chgTxt(M, mo) + '</span></span>' + (c.st.gran === 'annual' ? '' : '<span>YoY <span class="' + cls(yy) + '">' + chgTxt(M, yy) + '</span></span>') + '</div>' +
        '<div class="dk-sp">' + sparkSVG(sp, 160, 30) + '</div>' +
        '<div class="dk-rng"><i style="left:' + (r.pos * 100).toFixed(0) + '%"></i></div><div class="dk-rngl"><span>5y low ' + fmt(r.mn, M.dec) + '</span><span>high ' + fmt(r.mx, M.dec) + '</span></div></button>';
    }).join('');
  };
  Desk.prototype._lbl = function (M) { return typeof M.label === 'function' ? M.label({ prod: this.ctx.st.prod }) : M.label; };
  Desk.prototype._stageInfo = function () {
    var c = this.ctx, u = this._u(), M = c.M(u.metric);
    if (u.mode === 'yoy') return { M: M, v: c.vals(u.metric, 'yoy'), unit: M.pp ? 'pp' : M.diff ? M.unit : '%', dec: 1, bars: true, name: 'YoY' };
    if (u.mode === 'ltm') return { M: M, v: c.vals(u.metric, 'ltm'), unit: M.unit, dec: M.dec, name: c.st.gran === 'quarterly' ? 'last 4 quarters' : 'last 12 months' };
    return { M: M, v: c.vals(u.metric), unit: M.unit, dec: M.dec, name: '' };
  };
  Desk.prototype._stage = function () {
    var c = this.ctx, u = this._u(), M = c.M(u.metric), E = this.el, cv = E.stage.querySelector('canvas'), t = theme(true), ann = c.st.gran === 'annual';
    E.stage.querySelector('.dk-modes').innerHTML = [['level', 'Level'], ['yoy', 'YoY'], ['ltm', 'LTM', ann], ['seasonal', 'Seasonal', ann]].map(function (m) {
      return '<button type="button" data-k="' + m[0] + '" aria-pressed="' + (u.mode === m[0]) + '"' + (m[2] ? ' disabled title="Not available in annual view"' : '') + '>' + m[1] + '</button>'; }).join('');
    var title = E.stage.querySelector('.dk-st'), brush = E.stage.querySelector('.dk-brush');
    if (u.mode === 'seasonal') {
      var v = c.vals(u.metric), li = lastIdx(v), yL = c.P[li].y, byY = {}, PER = c.PER;
      v.forEach(function (x, i) { var p = c.P[i]; (byY[p.y] = byY[p.y] || new Array(PER).fill(null))[p.k] = x; });
      var lo = [], hi = [], m, y; for (m = 0; m < PER; m++) { var a = []; for (y = yL - 5; y < yL; y++) if (byY[y] && byY[y][m] != null) a.push(byY[y][m]); lo.push(a.length ? Math.min.apply(null, a) : null); hi.push(a.length ? Math.max.apply(null, a) : null); }
      var labs = PER === 12 ? MON.slice() : ['Q1', 'Q2', 'Q3', 'Q4'], bandC = 'rgba(255,255,255,.07)';
      var ds = [
        { type: 'line', label: (yL - 5) + '–' + (yL - 1) + ' low', data: lo, borderWidth: 0, pointRadius: 0, fill: false, $noDot: true, tension: 0 },
        { type: 'line', label: (yL - 5) + '–' + (yL - 1) + ' high', data: hi, borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: bandC, $noDot: true, tension: 0 },
        lineSet(byY[yL - 1] || [], t.ink, { label: String(yL - 1), w: 1.6, dash: [4, 3], surf: t.surf }),
        lineSet(byY[yL] || [], ORANGE, { label: String(yL), w: 2.6, end: true, surf: t.surf })];
      ds[2].borderColor = 'rgba(243,241,236,.75)';
      this._chart('stage', cv, 'line', labs, ds, { stage: true, dec: M.dec, local: true });
      this._seas = { yL: yL, byY: byY, labs: labs, M: M, base: 'Orange ' + yL + ' · dashed ' + (yL - 1) + ' · band = ' + (yL - 5) + '–' + (yL - 1) + ' range' };
      title.textContent = this._lbl(M) + ' · seasonality';
      E.stage.querySelector('.dk-sv').innerHTML = fmt(v[li], M.dec) + '<small>' + esc(M.unit) + ' · ' + c.label(li) + '</small>';
      E.stage.querySelector('.dk-sd').textContent = this._seas.base; brush.style.visibility = 'hidden';
    } else {
      brush.style.visibility = 'visible';
      var si = this._stageInfo(), sl = function (arr) { return arr.slice(c.i0, c.i1 + 1); }, labels = c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.label; }), sets;
      if (si.bars) sets = [barSet(sl(si.v), sl(si.v).map(function (x) { return x == null ? 'transparent' : x >= 0 ? UP() : DOWN(); }), { label: 'YoY' })];
      else {
        sets = [lineSet(sl(si.v), ORANGE, { label: this._lbl(M), w: 2.4, area: !M.diff, end: true, surf: t.surf })];
        if (u.mode === 'level' && c.st.gran === 'monthly') { var ma = c.vals(u.metric, 'ltm').map(function (x) { return x == null ? null : (M.flow ? x / 12 : x); });
          var s2 = lineSet(sl(ma), 'rgba(243,241,236,.55)', { label: '12-month average', w: 1.3, dash: [4, 3], noDot: true }); s2.order = 2; sets.push(s2); }
        if (M.ref === 'windowAvg') { var w = sl(si.v).filter(function (x) { return x != null; }), avg = w.length ? w.reduce(function (p, q) { return p + q; }, 0) / w.length : null;
          var s3 = lineSet(labels.map(function () { return avg; }), 'rgba(243,241,236,.6)', { label: 'Window average', w: 1.2, dash: [5, 3], noDot: true }); s3.order = 3; sets.push(s3); this._refAvg = avg; } else this._refAvg = null;
      }
      this._chart('stage', cv, si.bars ? 'bar' : 'line', labels, sets, { stage: true, dec: si.dec, bar: !!si.bars });
      title.textContent = this._lbl(M) + (si.name ? ' · ' + si.name : '');
    }
  };
  Desk.prototype._localHover = function (id, i) {   // sazonalidade: lê o mês do ano, sem mexer nos outros gráficos
    var ch = this.charts[id], s = this._seas; if (!ch || !s) return; ch.$dk = { hover: i }; ch.draw();
    this.el.stage.querySelector('.dk-sd').textContent = i == null ? s.base : s.labs[i] + ': ' + s.yL + ' ' + fmt((s.byY[s.yL] || [])[i], s.M.dec) + ' · ' + (s.yL - 1) + ' ' + fmt((s.byY[s.yL - 1] || [])[i], s.M.dec) + ' ' + s.M.unit;
  };

  /* faixa de período: a série inteira em miniatura; arrastar o miolo desloca, as alças redimensionam */
  Desk.prototype._brush = function () {
    var c = this.ctx, self = this, el = this.el.stage.querySelector('.dk-brush'), v = c.vals(this._u().metric), n = c.P.length, W = el.clientWidth || 600, H = 38;
    if (n < 2) { el.innerHTML = ''; return; }
    var x = function (i) { return i / (n - 1) * W; }, i0 = c.i0, i1 = c.i1, yrs = '', seen = {}, stepY = Math.max(1, Math.ceil((c.P[n - 1].y - c.P[0].y + 1) / Math.max(4, Math.floor(W / 46))));
    c.P.forEach(function (p, i) { if (!seen[p.y] && p.k === 0) { seen[p.y] = 1; if ((c.P[n - 1].y - p.y) % stepY) return; yrs += '<text x="' + (x(i) + 3) + '" y="' + (H - 1) + '" font-size="8.5" fill="#8d929b">' + p.y + '</text><line x1="' + x(i) + '" x2="' + x(i) + '" y1="0" y2="' + H + '" stroke="#24262a"/>'; } });
    var pts = [], k; for (k = 0; k < n; k++) if (v[k] != null) pts.push([k, v[k]]);
    var mn = Math.min.apply(null, pts.map(function (p) { return p[1]; })), mx = Math.max.apply(null, pts.map(function (p) { return p[1]; }));
    var d = pts.map(function (p, j) { return (j ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + (H - 11 - (mx > mn ? (p[1] - mn) / (mx - mn) : .5) * (H - 13)).toFixed(1); }).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + yrs + '<path d="' + d + '" fill="none" stroke="#8d929b" stroke-width="1"/>' +
      '<rect class="w" x="' + x(i0) + '" y="0" width="' + Math.max(6, x(i1) - x(i0)) + '" height="' + (H - 10) + '" fill="rgba(255,80,0,.16)" stroke="' + ORANGE + '" rx="3" style="cursor:grab"/>' +
      '<rect class="hl" x="' + (x(i0) - 4) + '" y="0" width="8" height="' + (H - 10) + '" fill="' + ORANGE + '" rx="2" style="cursor:ew-resize"/><rect class="hr" x="' + (x(i1) - 4) + '" y="0" width="8" height="' + (H - 10) + '" fill="' + ORANGE + '" rx="2" style="cursor:ew-resize"/></svg>';
    var svg = el.firstChild, drag = null, minSpan = Math.min(n - 1, c.st.gran === 'monthly' ? 5 : c.st.gran === 'quarterly' ? 3 : 2);
    var at = function (ev) { var r = svg.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (n - 1)); };
    var range = function () { return { win: 'custom', from: c.ax[c.P[i0].a], to: c.ax[c.P[i1].b] }; };
    var commit = function () { var r = range(); self._ovr = null; self.cfg.setRange(r.from, r.to); };
    svg.onpointerdown = function (ev) { var cl = ev.target.getAttribute('class');
      if (!cl) { var span = i1 - i0, a = Math.max(0, Math.min(n - 1 - span, at(ev) - Math.floor(span / 2))); i0 = a; i1 = a + span; commit(); return; }
      drag = { c: cl, i: at(ev), a: i0, b: i1 }; svg.setPointerCapture(ev.pointerId); };
    svg.onpointermove = function (ev) { if (!drag) return; var dl = at(ev) - drag.i, span;
      if (drag.c === 'w') { span = drag.b - drag.a; var a = Math.max(0, Math.min(n - 1 - span, drag.a + dl)); i0 = a; i1 = a + span; }
      if (drag.c === 'hl') i0 = Math.max(0, Math.min(i1 - minSpan, drag.a + dl));
      if (drag.c === 'hr') i1 = Math.min(n - 1, Math.max(i0 + minSpan, drag.b + dl));
      var q = function (s) { return svg.querySelector('.' + s); }; q('w').setAttribute('x', x(i0)); q('w').setAttribute('width', Math.max(6, x(i1) - x(i0))); q('hl').setAttribute('x', x(i0) - 4); q('hr').setAttribute('x', x(i1) - 4);
      self._ovr = range(); self.refresh(true); };
    svg.onpointerup = svg.onpointercancel = function () { if (drag) { drag = null; commit(); } };
  };

  Desk.prototype._read = function () {
    var c = this.ctx, u = this._u(), M = c.M(u.metric), v = c.vals(u.metric), i = this._ref(), x = v[i], r = rangeN(v, i, 5 * c.PER), E = this.el.read, PER = c.PER, self = this;
    var sm = [], k; for (k = 1; k <= 5; k++) if (v[i - PER * k] != null) sm.push(v[i - PER * k]);
    var avg = sm.length ? sm.reduce(function (a, b) { return a + b; }, 0) / sm.length : null, vsAvg = (x == null || avg == null) ? null : ((M.pp || M.diff) ? x - avg : (avg ? (x / avg - 1) * 100 : null));
    var unitW = { monthly: 'month', quarterly: 'quarter', annual: 'year' }[c.st.gran], mo = change(v, i, 1, M), yy = change(v, i, PER, M);
    E.querySelector('.dk-when').textContent = c.label(i) + (u.hover != null ? '' : u.pinA != null ? ' · pinned' : ' · latest');
    E.querySelector('.dk-big').innerHTML = fmt(x, M.dec) + '<small>' + esc(M.unit) + ' · ' + esc(this._lbl(M)) + '</small>';
    var kv = '<span>vs previous ' + unitW + '</span><b class="' + cls(mo) + '">' + chgTxt(M, mo) + '</b>';
    if (c.st.gran !== 'annual') kv += '<span>vs same ' + unitW + ' last year</span><b class="' + cls(yy) + '">' + chgTxt(M, yy) + '</b><span>vs 5-year average for ' + (PER === 12 ? MON[c.P[i].k] : 'Q' + (c.P[i].k + 1)) + '</span><b class="' + cls(vsAvg) + '">' + chgTxt(M, vsAvg) + '</b>';
    kv += '<span>Rank in the last ' + (r ? r.n : 5 * PER) + ' ' + unitW + 's</span><b>' + (r ? '#' + r.rank : '—') + '</b>';
    c.sec.metrics.forEach(function (m2) { if (m2.id === u.metric || !c.has(m2.id) || m2.hideInReading) return; var v2 = c.vals(m2.id); if (lastIdx(v2) < 0) return; kv += '<span>' + esc(self._lbl(m2)) + '</span><b>' + fmt(v2[i], m2.dec) + ' ' + esc(m2.unit) + '</b>'; });
    E.querySelector('.dk-kv').innerHTML = kv;
    var p = '';
    if (u.pinA != null) p += '<span class="dk-pin"><i></i>A ' + c.label(u.pinA) + '</span>';
    if (u.pinB != null) { var a = v[u.pinA], b = v[u.pinB], dd = (a == null || b == null) ? null : ((M.pp || M.diff) ? b - a : (a ? (b / a - 1) * 100 : null)); p += '<span class="dk-pin dk-b"><i></i>B ' + c.label(u.pinB) + '</span><span>A→B <b class="' + cls(dd) + '">' + chgTxt(M, dd) + '</b></span>'; }
    p += u.pinA != null ? '<button type="button" class="dk-lnk dk-clr">Clear</button>' : '<span>Click a chart to pin a period</span>';
    var pe = E.querySelector('.dk-pins'); pe.innerHTML = p; var cl = pe.querySelector('.dk-clr'); if (cl) cl.onclick = function () { u.pinA = u.pinB = null; self._paintMarks(); self._read(); self._rank(); };
    if (u.mode !== 'seasonal') { var si = this._stageInfo(), S = this.el.stage;
      S.querySelector('.dk-sv').innerHTML = fmt(si.v[i], si.dec) + '<small>' + esc(si.unit) + ' · ' + c.label(i) + '</small>';
      S.querySelector('.dk-sd').textContent = u.mode === 'level' ? ((c.st.gran === 'monthly' ? 'Dashed = 12-month average · YoY ' + chgTxt(M, yy) : { quarterly: 'QoQ ', annual: 'YoY ' }[c.st.gran] + chgTxt(M, mo)) + (this._refAvg != null ? ' · window avg ' + fmt(this._refAvg, M.dec) : ''))
        : u.mode === 'yoy' ? 'Change vs the same period a year earlier' : 'Rolling ' + si.name; }
  };

  /* ── quem: dimensão, subproduto, seleção de entidades (todas as da base) ── */
  Desk.prototype._whoData = function () {
    var c = this.ctx, w = this._u().who, dims = (c.sec.who || []).filter(function (x) { return !x.available || x.available({ prod: c.st.prod }); });
    if (w.dim >= dims.length) w.dim = 0; var dim = dims[w.dim]; if (!dim) return null;
    var pills = dim.pills ? dim.pills({ prod: c.st.prod }) : null, pill = pills ? (pills.filter(function (p) { return p.k === w.pill; })[0] || pills[0]) : null;
    var ck = this.cur + '|' + dim.id + '|' + c.st.prod + '|' + (pill ? pill.k : ''), base = (this._who_cache = this._who_cache || {})[ck];
    if (!base) { var raw = dim.entities({ prod: c.st.prod }, pill);   // {names:[], maps:[ {AAAA-MM: v} ]} já em ordem de relevância
      base = this._who_cache[ck] = { names: raw.names, series: raw.maps.map(function (m) { return align(m, c.ax).map(function (x) { return x == null ? 0 : x; }); }) }; }
    var gk = ck + '|' + c.st.gran, agg = (this._whoAgg = this._whoAgg || {})[gk];
    if (!agg || agg.n !== c.P.length) agg = this._whoAgg[gk] = { n: c.P.length, v: base.series.map(function (s) { return c.A.level.sum(s); }) };
    var names = base.names, def;
    if (dim.defaultSel) def = dim.defaultSel(names);
    else { var sc = names.map(function (n, k) { var t = 0, ms = base.series[k]; for (var i = c.m0; i <= c.m1; i++) t += ms[i] || 0; return [n, t]; }).sort(function (a, b) { return b[1] - a[1]; }); def = sc.slice(0, dim.top || 5).map(function (x) { return x[0]; }); }
    var sel = w.sel || def.concat(dim.noOthers ? [] : ['Others']);
    return { dim: dim, dims: dims, pills: pills, pill: pill, names: names, agg: agg.v, sel: sel };
  };
  Desk.prototype._slot = function (name, sel) {   // cor por ENTIDADE; dois marcados nunca dividem a cor enquanto houver cor livre
    if (name === 'Others') return 'others'; var S = this._slots, dim = this._whoDim || {};
    if (dim.lead && name === dim.lead) return 'lead';
    if (S[name] == null) S[name] = this._slotN++ % PAL_L.length;
    var used = {}, i; for (i = 0; i < sel.length; i++) { var o = sel[i]; if (o === name || o === 'Others' || (dim.lead && o === dim.lead) || S[o] == null) continue; used[S[o]] = 1; }
    if (used[S[name]]) { for (i = 0; i < PAL_L.length; i++) if (!used[i]) { S[name] = i; break; } }
    return S[name];
  };
  Desk.prototype._who = function () {
    var c = this.ctx, E = this.el, d = this._whoData(), w = this._u().who, self = this; if (!d) { E.who.hidden = true; return; } E.who.hidden = false; this._whoDim = d.dim;
    var dg = E.who.querySelector('.dk-dims'); dg.hidden = d.dims.length < 2;
    dg.innerHTML = d.dims.map(function (x, k) { return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === w.dim) + '">' + esc(x.tab || x.label) + '</button>'; }).join('');
    E.who.querySelector('.dk-pop').hidden = !!d.dim.noSelect;
    E.who.querySelector('.dk-pills').innerHTML = d.pills ? d.pills.map(function (p) { return '<button type="button" class="dk-pill" data-k="' + esc(p.k) + '" aria-pressed="' + (p.k === d.pill.k) + '">' + esc(p.l) + '</button>'; }).join('') : '';
    var modes = d.dim.modes || [['volume', 'Volume (kt)'], ['share', 'Share (%)']];
    E.who.querySelector('.dk-whomodes').innerHTML = modes.map(function (m) { return '<button type="button" data-k="' + m[0] + '" aria-pressed="' + (w.mode === m[0]) + '">' + m[1] + '</button>'; }).join('');
    E.who.querySelector('.dk-popbtn').innerHTML = esc(d.dim.label) + ' ▾';
    var sl = function (a) { return a.slice(c.i0, c.i1 + 1); }, labels = c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.label; }), t = theme(false), share = w.mode === 'share';
    var tot = c.P.map(function (_, i) { var s = 0; for (var k = 0; k < d.agg.length; k++) s += d.agg[k][i] || 0; return s; });
    var stack = [], selNamed = d.names.filter(function (n) { return d.sel.indexOf(n) >= 0; });
    selNamed.forEach(function (n) { stack.push({ name: n, v: d.agg[d.names.indexOf(n)] }); });
    if (d.sel.indexOf('Others') >= 0) stack.push({ name: 'Others', v: c.P.map(function (_, i) { var s = tot[i]; selNamed.forEach(function (n) { s -= d.agg[d.names.indexOf(n)][i] || 0; }); return Math.max(0, s); }) });
    var sets = stack.map(function (s) { var col = slotColor(self._slot(s.name, d.sel)), data = sl(s.v).map(function (x, k) { var T = tot[c.i0 + k]; return share ? (T ? +(x / T * 100).toFixed(2) : 0) : +(+x || 0).toFixed(1); });
      var b = barSet(data, (w.hi && w.hi !== s.name) ? hexA(col, .16) : col, { label: s.name, stacked: true, gap: true, surf: t.surf }); return b; });
    this._chart('who', E.who.querySelector('canvas'), 'bar', labels, sets, { bar: true, stack: true, share: share, dec: 0 });
    this._whoTitle = d.dim.title || 'Breakdown';
    if (!E.who.querySelector('.dk-popp').hidden) this._fillPop();
  };
  function hexA(hex, a) { var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); return m ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')' : hex; }
  Desk.prototype._fillPop = function () {
    var d = this._whoData(), pp = this.el.who.querySelector('.dk-popp'), self = this, w = this._u().who; if (!d) return;
    if (!pp.querySelector('.dk-plist') || pp.dataset.key !== (d.pill ? d.pill.k : '') + '|' + d.names.length) {
      pp.dataset.key = (d.pill ? d.pill.k : '') + '|' + d.names.length;
      pp.innerHTML = '<div class="dk-ph"><span>' + d.names.length + ' ' + esc((d.dim.noun || 'items')) + ' in the database</span><button type="button" class="dk-lnk dk-reset">Reset</button></div>' +
        '<input type="search" placeholder="Search…" aria-label="Search"><div class="dk-plist"></div><div class="dk-pf">Unticked ' + esc(d.dim.noun || 'items') + ' are counted in "Others".</div>';
      pp.querySelector('input[type=search]').oninput = function () { self._fillPop(); };
      pp.querySelector('.dk-reset').onclick = function () { w.sel = null; self._who(); self._rank(); };
      pp.querySelector('.dk-plist').onchange = function (e) { var n = e.target.getAttribute('data-n'); if (n == null) return; var s = self._whoData().sel.slice(); if (e.target.checked) s.push(n); else s = s.filter(function (x) { return x !== n; }); w.sel = s.length ? s : null; self._who(); self._rank(); };
    }
    var q = (pp.querySelector('input[type=search]').value || '').toLowerCase(), hit = d.names.filter(function (n) { return !q || n.toLowerCase().indexOf(q) >= 0; });
    var list = hit.filter(function (n) { return d.sel.indexOf(n) >= 0; }).concat(hit.filter(function (n) { return d.sel.indexOf(n) < 0; })); if (!q) list.push('Others');
    pp.querySelector('.dk-plist').innerHTML = list.map(function (n) { return '<label><input type="checkbox" data-n="' + esc(n) + '"' + (d.sel.indexOf(n) >= 0 ? ' checked' : '') + '>' + esc(n) + '</label>'; }).join('') || '<p class="dk-note">No match.</p>';
  };
  Desk.prototype._rank = function () {
    var c = this.ctx, d = this._whoData(), E = this.el, w = this._u().who, self = this; if (!d) return;
    var i = this._ref(), PER = c.PER, unit = d.dim.unit || 'kt', tot = 0, all = d.names.map(function (n, k) { var v = d.agg[k][i] || 0; tot += v; return { n: n, v: v, p: d.agg[k][i - PER] || 0 }; });
    E.who.querySelector('.dk-when').textContent = c.label(i);
    var rest = all.filter(function (r) { return d.sel.indexOf(r.n) < 0; }).sort(function (a, b) { return b.v - a.v; }), nSel = d.sel.filter(function (n) { return n !== 'Others'; }).length;
    var rows = all.filter(function (r) { return d.sel.indexOf(r.n) >= 0; }).concat(rest.slice(0, Math.max(0, 10 - nSel))).sort(function (a, b) { return b.v - a.v; });
    if (!d.dim.noOthers) rows.push({ n: 'Others', lab: 'Others (' + rest.length + ' ' + (d.dim.noun || 'items') + ')', v: rest.reduce(function (a, r) { return a + r.v; }, 0), p: rest.reduce(function (a, r) { return a + r.p; }, 0) });
    E.who.querySelector('.dk-rank').innerHTML = rows.map(function (r) { var yy = r.p ? (r.v / r.p - 1) * 100 : null, on = d.sel.indexOf(r.n) >= 0;
      return '<button type="button" class="dk-rk' + (w.hi === r.n ? ' dk-on' : '') + (on ? '' : ' dk-out') + '" data-n="' + esc(r.n) + '" title="Click to show or hide"><i style="background:' + (on ? slotColor(self._slot(r.n, d.sel)) : 'transparent') + '"></i><span class="dk-nm">' + esc(r.lab || r.n) + '</span><span class="dk-shr">' + fmt(r.v, 0) + ' ' + unit + ' · ' + (tot ? fmt(r.v / tot * 100, 0) : '—') + '%</span><span class="dk-yy ' + cls(yy) + '">' + (yy != null && yy > 999 ? '>999%' : pct(yy, 0)) + '</span></button>'; }).join('') +
      (d.dim.noSelect ? '' : '<button type="button" class="dk-lnk dk-more">+ Add any of the ' + d.names.length + ' ' + esc(d.dim.noun || 'items') + '</button>');
    var R = E.who.querySelector('.dk-rank'), mark = function () { R.querySelectorAll('.dk-rk').forEach(function (b) { b.classList.toggle('dk-on', b.getAttribute('data-n') === w.hi); }); };
    R.querySelectorAll('.dk-rk').forEach(function (b) { var n = b.getAttribute('data-n');
      b.onmouseenter = function () { if (d.sel.indexOf(n) >= 0 && w.hi !== n) { w.hi = n; self._who(); self._paintMarks(); mark(); } };
      b.onclick = function () { var s = d.sel.slice(); s = s.indexOf(n) >= 0 ? s.filter(function (x) { return x !== n; }) : s.concat([n]); w.sel = s.length ? s : null; w.hi = null; self._who(); self._paintMarks(); self._rank(); }; });
    R.onmouseleave = function () { if (w.hi) { w.hi = null; self._who(); self._paintMarks(); mark(); } };
    var mb = R.querySelector('.dk-more'); if (mb) mb.onclick = function (e) { e.stopPropagation(); self._openPop(true); };
  };

  Desk.prototype._minis = function () {
    var c = this.ctx, u = this._u(), E = this.el, self = this, t = theme(false);
    var ids = c.sec.metrics.filter(function (M) { return M.id !== u.metric && !M.noMini && c.has(M.id) && lastIdx(c.vals(M.id)) >= 0; }).map(function (M) { return M.id; });
    var sig = ids.join(',');
    if (E.minis.dataset.sig !== sig) { this._dropCharts('mini:'); E.minis.dataset.sig = sig;
      E.minis.innerHTML = ids.map(function (id) { return '<div class="dk-mini dk-card chart-card" data-k="' + id + '" role="button" tabindex="0"><div class="dk-mh"><span class="chart-title"></span><span class="dk-mv"></span></div><div class="dk-chart"><canvas id="dk-mini-' + id + '"></canvas></div></div>'; }).join('');
      ids.forEach(function (id) { self._bindHover(E.minis.querySelector('#dk-mini-' + id), 'mini:' + id); });
    }
    var labels = c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.label; });
    ids.forEach(function (id) { var M = c.M(id), box = E.minis.querySelector('[data-k="' + id + '"]'); box.querySelector('.chart-title').textContent = self._lbl(M);
      self._chart('mini:' + id, box.querySelector('canvas'), 'line', labels, [lineSet(c.vals(id).slice(c.i0, c.i1 + 1), t.ink, { label: self._lbl(M), w: 1.5 })], { mini: true, dec: M.dec }); });
    this._miniIds = ids; this._miniHeads();
  };
  Desk.prototype._miniHeads = function () { var c = this.ctx, i = this._ref(), E = this.el; (this._miniIds || []).forEach(function (id) { var M = c.M(id), e = E.minis.querySelector('[data-k="' + id + '"] .dk-mv'); if (e) e.textContent = fmt(c.vals(id)[i], M.dec) + ' ' + M.unit; }); };

  /* matriz com o histórico INTEIRO (na granularidade escolhida) para o XLS de um gráfico da mesa */
  Desk.prototype.fullAOA = function (id) {
    var c = this.ctx, u = this._u(), self = this; if (!c) return null;
    var cols = [], head = ['Period'];
    if (id === 'stage') { var M = c.M(u.metric); if (u.mode === 'seasonal') return null; cols.push(this._stageInfo().v); head.push(this._lbl(M) + (u.mode === 'level' ? '' : ' — ' + u.mode.toUpperCase()) + ' (' + this._stageInfo().unit + ')'); }
    else if (id === 'who') { var d = this._whoData(); if (!d) return null; d.names.forEach(function (n, k) { cols.push(d.agg[k]); head.push(n); }); }
    else if (id.indexOf('mini:') === 0) { var M2 = c.M(id.slice(5)); cols.push(c.vals(M2.id)); head.push(self._lbl(M2) + ' (' + M2.unit + ')'); }
    else return null;
    var out = [head], i, first = -1; for (i = 0; i < c.P.length && first < 0; i++) if (cols.some(function (v) { return v[i] != null && v[i] !== 0; })) first = i;
    for (i = Math.max(0, first); i < c.P.length; i++) out.push([c.P[i].label].concat(cols.map(function (v) { return v[i]; })));
    return out;
  };
  Desk.prototype.titleOf = function (id) { var c = this.ctx; if (!c) return id; if (id === 'stage') return this.el.stage.querySelector('.dk-st').textContent; if (id === 'who') return (this._whoTitle || 'Breakdown'); if (id.indexOf('mini:') === 0) return this._lbl(c.M(id.slice(5))); return id; };

  /* só para os testes: os números de um indicador no estado pedido, por chave de período */
  Desk.prototype.debugSeries = function (secId, metricId, st, mode) {
    var keepCur = this.cur, keepState = this.cfg.state, self = this, out = {};
    this.cur = secId; this.cfg.state = function () { return st; };
    try { var c = this._ctx(), v = c.vals(metricId, mode || 'level'); for (var i = c.i0; i <= c.i1; i++) out[c.P[i].key] = v[i]; out.__all = {}; c.P.forEach(function (p, i2) { out.__all[p.key] = v[i2]; }); }
    finally { this.cur = keepCur; this.cfg.state = keepState; }
    return out;
  };

  /* só para os testes: as entidades do bloco "quem" (todas, por período) e a seleção padrão da janela */
  Desk.prototype.debugWho = function (secId, st, dimIdx, pillKey, full) {
    var keepCur = this.cur, keepState = this.cfg.state, keepCtx = this.ctx, out;
    this.cur = secId; this.cfg.state = function () { return st; };
    try { var u = this._u(), kw = u.who; u.who = { dim: dimIdx || 0, pill: pillKey || null, sel: null, mode: 'volume', hi: null };
      var c = this.ctx = this._ctx(), d = this._whoData(); out = { names: d.names.length, sel: d.sel, keys: c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.key; }) };
      if (full) { out.all = {}; d.names.forEach(function (n, k) { var o = {}; c.P.forEach(function (p, i) { if (d.agg[k][i]) o[p.key] = d.agg[k][i]; }); out.all[n] = o; }); }
      u.who = kw; }
    finally { this.cur = keepCur; this.cfg.state = keepState; this.ctx = keepCtx; }
    return out;
  };

  window.IBBADesk = {
    core: core, theme: theme, slotColor: slotColor,
    mount: function (cfg) { var d = new Desk(cfg); window.IBBADesk.instance = d; return d; }
  };
})();
