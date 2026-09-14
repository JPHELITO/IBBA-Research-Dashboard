/* ═══════════════════════════════════════════════════════════════════════════════
   quarterly-view.js — as contas da página Quarterly (window.QV). Sem DOM e sem Supabase: recebe o JSON
   das RPCs (get_quarterly_boot / get_quarterly_company / get_quarterly_metric) e devolve séries prontas
   para desenhar e para o Excel. Testes: tests/test_quarterly_view.html.

   REGRAS QUE MORAM AQUI (plano, seção 3 e 5):
   · FONTE POR MÉTRICA, nunca emenda de definição: EBITDA ajustado só do modelo; lucro líquido do filed
     (CVM/SEC) quando a moeda do filed é a da empresa, senão do modelo; receita e dívida líquida do
     modelo, com o filed só onde o modelo não tem o trimestre (e na mesma moeda) — marcado trimestre a
     trimestre em `src`.
   · LTM de fluxo só com os 4 trimestres; estoque = o último; taxa não tem LTM.
   · Variação % sobre base ≤ 0 não é publicada; margem varia em pp, alavancagem em x.
   · US$: fluxo e preço unitário pela média do trimestre, estoque pelo fim; razões ficam como estão.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';
  const Q_KEY = /^(\d{4})Q([1-4])$/;
  function qIdx(q) { const m = Q_KEY.exec(q || ''); return m ? Number(m[1]) * 4 + Number(m[2]) - 1 : NaN; }
  function qFromIdx(i) { return Math.floor(i / 4) + 'Q' + (i % 4 + 1); }
  function qAdd(q, n) { return qFromIdx(qIdx(q) + n); }
  function qShort(q) { const m = Q_KEY.exec(q || ''); return m ? m[2] + 'Q' + m[1].slice(2) : String(q || ''); }
  function sortQ(list) { return list.filter(function (q) { return Q_KEY.test(q); }).sort(function (a, b) { return qIdx(a) - qIdx(b); }); }
  function maxQ(list) { const s = sortQ(list || []); return s.length ? s[s.length - 1] : null; }
  function minQ(list) { const s = sortQ(list || []); return s.length ? s[0] : null; }
  function qRange(a, b) { const out = []; if (!a || !b) return out; for (let i = qIdx(a); i <= qIdx(b); i++) out.push(qFromIdx(i)); return out; }

  // tickers do calendário/CVM/Yahoo → tickers da página (os do Stock Guide)
  const ALIAS = { VALE: 'VALE3', GMEX: 'GMEXICOB', AURA33: 'AUGO', AURA: 'AUGO' };
  function normTicker(t) {
    if (!t) return null;
    const s = String(t).trim().toUpperCase().replace(/\.(SA|MX|SN|TO|L|AX|NYSE)$/, '');
    return ALIAS[s] || s;
  }

  // ── empresas ──────────────────────────────────────────────────────────────────
  function indexCompany(co) {
    const byKey = {}, filedBy = {};
    (co.series || []).forEach(function (s) { byKey[s.key] = s; });
    (co.filed || []).forEach(function (r) { filedBy[r.q] = r; });
    return Object.assign({}, co, { byKey: byKey, filedBy: filedBy, notes: co.notes || [] });
  }
  // get_quarterly_boot → [empresa indexada] na ordem do Stock Guide
  function fromBoot(boot) {
    const map = {}, order = [];
    ((boot && boot.companies) || []).forEach(function (c) { map[c.ticker] = Object.assign({}, c, { series: [], filed: [], notes: [] }); order.push(c.ticker); });
    ((boot && boot.series) || []).forEach(function (s) { if (map[s.company]) map[s.company].series.push(s); });
    ((boot && boot.filed) || []).forEach(function (r) { if (map[r.company]) map[r.company].filed.push(r); });
    ((boot && boot.notes) || []).forEach(function (n) { if (map[n.company]) map[n.company].notes.push(n); });
    return order.map(function (t) { return indexCompany(map[t]); });
  }
  // get_quarterly_company → empresa indexada (histórico inteiro)
  function fromCompany(res) {
    if (!res || !res.company) return null;
    return indexCompany(Object.assign({}, res.company, { series: res.series || [], filed: res.filed || [], notes: res.notes || [], fx: res.fx || {} }));
  }
  function reportingCcy(co) {
    const r = co.byKey && co.byKey.revenue;
    return (r && r.ccy) || co.base_ccy || 'BRL';
  }

  // ── fonte por métrica ─────────────────────────────────────────────────────────
  const MONEY_UNIT = { BRL: 'BRL_mn', USD: 'USD_mn', CLP: 'CLP_mn', MXN: 'MXN_mn' };
  function filedVals(co, field) {
    const vals = {}; let ccy = null;
    Object.keys(co.filedBy || {}).forEach(function (q) {
      const r = co.filedBy[q];
      if (r && r[field] != null && isFinite(Number(r[field]))) { vals[q] = Number(r[field]); ccy = r.ccy || 'BRL'; }
    });
    return { vals: vals, ccy: ccy };
  }
  function out(id, label, vals, src, unit, ccy, agg, kind, extra) {
    return Object.assign({ id: id, label: label, vals: vals, src: src, unit: unit, ccy: ccy, agg: agg, kind: kind }, extra || {});
  }
  const LABEL = { revenue: 'Net revenue', adj_ebitda: 'Adjusted EBITDA', net_income: 'Net income', net_debt: 'Net debt',
                  margin: 'Adj. EBITDA margin', leverage: 'Net debt / LTM adj. EBITDA' };

  // id: revenue · adj_ebitda · net_income · net_debt · margin · leverage · <series_key do modelo>
  function pick(co, id) {
    const ccy = reportingCcy(co), money = MONEY_UNIT[ccy] || (ccy + '_mn');
    if (id === 'margin') {
      const e = pick(co, 'adj_ebitda'), r = pick(co, 'revenue'), vals = {}, src = {};
      Object.keys(e.vals).forEach(function (q) { const d = r.vals[q]; if (d > 0) { vals[q] = e.vals[q] / d; src[q] = r.src[q] === 'filed' ? 'mixed' : 'model'; } });
      return out(id, LABEL.margin, vals, src, '%', null, 'rate', 'pct');
    }
    if (id === 'leverage') {
      const nd = pick(co, 'net_debt'), e = pick(co, 'adj_ebitda'), vals = {}, src = {};
      Object.keys(nd.vals).forEach(function (q) { const l = ltm(e.vals, q, 'flow'); if (l != null && l > 0) { vals[q] = nd.vals[q] / l; src[q] = nd.src[q]; } });
      return out(id, LABEL.leverage, vals, src, 'x', null, 'rate', 'x');
    }
    if (id === 'adj_ebitda') {
      const m = co.byKey.adj_ebitda, vals = {}, src = {};
      if (m) Object.keys(m.vals).forEach(function (q) { vals[q] = m.vals[q]; src[q] = 'model'; });
      return out(id, LABEL.adj_ebitda, vals, src, (m && m.unit) || money, (m && m.ccy) || ccy, 'flow', 'money', { flags: (m && m.flags) || {} });
    }
    if (id === 'net_income') {
      const f = filedVals(co, 'ni'), m = co.byKey.net_income, vals = {}, src = {};
      const usaFiled = f.ccy === ccy && Object.keys(f.vals).length > 0;
      if (usaFiled) Object.keys(f.vals).forEach(function (q) { vals[q] = f.vals[q]; src[q] = 'filed'; });
      if (m) Object.keys(m.vals).forEach(function (q) { if (vals[q] == null) { vals[q] = m.vals[q]; src[q] = 'model'; } });
      return out(id, LABEL.net_income, vals, src, money, ccy, 'flow', 'money');
    }
    if (id === 'revenue' || id === 'net_debt') {
      const m = co.byKey[id], f = filedVals(co, id === 'revenue' ? 'rev' : 'nd'), vals = {}, src = {};
      if (m) Object.keys(m.vals).forEach(function (q) { vals[q] = m.vals[q]; src[q] = 'model'; });
      const corte = m ? maxQ(Object.keys(m.vals)) : null;
      if (f.ccy === ccy) Object.keys(f.vals).forEach(function (q) {
        if (vals[q] != null) return;
        // receita: o filed só entra DEPOIS do último trimestre do modelo (a borda "preliminary")
        if (id === 'revenue' && corte && qIdx(q) <= qIdx(corte)) return;
        vals[q] = f.vals[q]; src[q] = 'filed';
      });
      return out(id, LABEL[id], vals, src, (m && m.unit) || money, (m && m.ccy) || ccy, id === 'net_debt' ? 'stock' : 'flow', 'money');
    }
    const s = co.byKey[id];
    if (!s) return out(id, id, {}, {}, null, null, 'flow', 'num');
    const src = {}; Object.keys(s.vals).forEach(function (q) { src[q] = s.calc ? 'calc' : 'model'; });
    return out(id, s.label || id, Object.assign({}, s.vals), src, s.unit, s.ccy, s.agg || 'flow', kindOf(s.unit), { std: s.std, def: s.def, flags: s.flags || {} });
  }
  // a série de manchete de um tipo (a 1ª com std = x, preferindo a marcada como headline)
  function headlineKey(co, std) {
    const all = (co.series || []).filter(function (s) { return s.std === std; });
    const h = all.find(function (s) { return s.headline; }) || all[0];
    return h ? h.key : null;
  }
  function kindOf(unit) {
    if (!unit) return 'num';
    if (/_mn$/.test(unit)) return 'money';
    if (/\//.test(unit) && !/USD$/.test(unit)) return 'price';
    if (unit === '%') return 'pct';
    if (unit === 'x') return 'x';
    return 'volume';
  }

  // ── contas ────────────────────────────────────────────────────────────────────
  function ltm(vals, q, agg) {
    if (!vals) return null;
    if (agg === 'stock') return vals[q] != null ? vals[q] : null;
    if (agg === 'rate') return null;
    let s = 0;
    for (let i = 0; i < 4; i++) { const v = vals[qAdd(q, -i)]; if (v == null || !isFinite(v)) return null; s += v; }
    return s;
  }
  function ltmSeries(vals, agg) {
    const o = {};
    Object.keys(vals || {}).forEach(function (q) { const v = ltm(vals, q, agg); if (v != null) o[q] = v; });
    return o;
  }
  function pct(a, b) { return a == null || b == null || !isFinite(a) || !isFinite(b) || !(b > 0) ? null : a / b - 1; }
  function change(vals, q, lag) { return pct(vals[q], vals[qAdd(q, -lag)]); }
  function delta(vals, q, lag) { const a = vals[q], b = vals[qAdd(q, -lag)]; return a == null || b == null ? null : a - b; }

  // série na base pedida: 'q' (trimestre) ou 'ltm'. Margem e alavancagem se refazem das partes.
  function basis(co, id, b) {
    if (b !== 'ltm') return pick(co, id);
    if (id === 'margin') {
      const e = ltmSeries(pick(co, 'adj_ebitda').vals, 'flow'), r = ltmSeries(pick(co, 'revenue').vals, 'flow'), vals = {};
      Object.keys(e).forEach(function (q) { if (r[q] > 0) vals[q] = e[q] / r[q]; });
      return out(id, LABEL.margin + ' (LTM)', vals, {}, '%', null, 'rate', 'pct');
    }
    const p = pick(co, id);
    if (id === 'leverage' || p.agg !== 'flow') return p;
    return Object.assign({}, p, { label: p.label + ' (LTM)', vals: ltmSeries(p.vals, 'flow') });
  }

  // ── câmbio ────────────────────────────────────────────────────────────────────
  // fx = {BRL: {'2026Q2': [média, fim]}} — moeda por 1 US$
  function toUsd(series, fx) {
    const ccy = series.ccy;
    if (!ccy || ccy === 'USD' || series.kind === 'pct' || series.kind === 'x') return series;
    const t = fx && fx[ccy];
    if (!t) return null;
    const vals = {};
    Object.keys(series.vals).forEach(function (q) {
      const r = t[q]; if (!r) return;
      const rate = series.agg === 'stock' ? (r[1] || r[0]) : r[0];
      if (rate > 0) vals[q] = series.vals[q] / rate;
    });
    return Object.assign({}, series, { vals: vals, ccy: 'USD', unit: String(series.unit || '').replace(new RegExp('^' + ccy + '(?=_|/)'), 'USD') });
  }
  function hasFx(fx, ccy) { return ccy === 'USD' || !!(fx && fx[ccy] && Object.keys(fx[ccy]).length); }

  // ── calendário ────────────────────────────────────────────────────────────────
  const RESULT_RE = /earnings|results?|resultado|conference call|conf\.? call|\b[1-4][QT]\d{2}\b/i;
  function nextResults(events, today) {
    const o = {};
    (events || []).forEach(function (e) {
      const t = normTicker(e.company); if (!t) return;
      const title = String(e.title || '');
      if (/production|produ[cç][aã]o|sales report/i.test(title) || !RESULT_RE.test(title)) return;
      const d = String(e.start_date || '').slice(0, 10);
      if (!d || d < today) return;
      if (!o[t] || d < o[t].date) o[t] = { date: d, title: title };
    });
    return o;
  }
  // o trimestre da temporada = o mais recente que alguma empresa já entregou (modelo ou filed)
  function seasonQ(cos) {
    const qs = [];
    (cos || []).forEach(function (c) {
      if (c.model && c.model.cutoff_q) qs.push(c.model.cutoff_q);
      if (c.filed_last) qs.push(c.filed_last);
      Object.keys(c.filedBy || {}).forEach(function (q) { qs.push(q); });
    });
    return maxQ(qs);
  }
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? MON[Number(m[2]) - 1] + ' ' + Number(m[3]) : ''; }
  function status(co, q, next) {
    const cut = co.model && co.model.cutoff_q;
    const filed = co.filed_last || maxQ(Object.keys(co.filedBy || {}));
    if (cut && qIdx(cut) >= qIdx(q)) return { kind: 'model', text: 'Reported' };
    if (filed && qIdx(filed) >= qIdx(q)) return { kind: 'filed', text: 'Filed · preliminary' };
    if (next && next.date) return { kind: 'expected', text: 'Expected ' + fmtDate(next.date) };
    return { kind: 'pending', text: 'Not yet reported' };
  }

  // ── números na tela (en-US) ───────────────────────────────────────────────────
  const UNIT = { BRL_mn: 'R$ mn', USD_mn: 'US$ mn', CLP_mn: 'CLP mn', kt: 'kt', Mt: 'Mt', 'BRL/t': 'R$/t', 'USD/t': 'US$/t',
    'USD/lb': 'US$/lb', 'USD/oz': 'US$/oz', koz: 'koz', Moz: 'Moz', k_m3: 'k m³', mn_units: 'mn units', bn_tkm: 'bn t-km',
    mn_sh: 'mn shares', 'USD/sh': 'US$/share', 'USD/ADS': 'US$/ADS', 'BRL/USD': 'R$/US$', 'CLP/USD': 'CLP/US$', '%': '%', x: 'x' };
  function unitLabel(u) { return UNIT[u] || u || ''; }
  function fmt(v, kind) {
    if (v == null || !isFinite(v)) return '—';
    if (kind === 'pct') return (v * 100).toFixed(1) + '%';
    if (kind === 'pp') return (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + ' pp';
    if (kind === 'x') return (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + 'x';
    if (kind === 'dx') return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + 'x';
    if (kind === 'chg') return (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%';
    const a = Math.abs(v), d = a >= 1000 ? 0 : a >= 100 ? (kind === 'volume' ? 0 : 1) : a >= 10 ? 1 : 2;
    return (v < 0 ? '−' : '') + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // ── comparáveis ───────────────────────────────────────────────────────────────
  const COMPARE = [
    { id: 'revenue', std: ['revenue'], label: 'Net revenue', kind: 'money' },
    { id: 'adj_ebitda', std: ['adj_ebitda'], label: 'Adjusted EBITDA', kind: 'money' },
    { id: 'margin', std: ['adj_ebitda', 'revenue'], label: 'Adj. EBITDA margin', kind: 'pct' },
    { id: 'net_income', std: ['net_income'], label: 'Net income', kind: 'money' },
    { id: 'leverage', std: ['net_debt', 'adj_ebitda'], label: 'Net debt / LTM adj. EBITDA', kind: 'x' },
    { id: 'sales_volume', std: ['sales_volume'], label: 'Sales volume', kind: 'volume', byDef: true },
    { id: 'realized_price', std: ['realized_price'], label: 'Realized price', kind: 'price', byDef: true },
    { id: 'cash_cost', std: ['cash_cost'], label: 'Cash cost', kind: 'price', byDef: true }
  ];
  // família = a definição sem a moeda (pulp_hw_brl e pulp_hw_usd se comparam com o botão US$)
  // só a MOEDA sai: 'copper_usd_t' e 'copper_usd_lb' continuam famílias diferentes (tonelada ≠ libra)
  function family(def) { return String(def || '').replace(/_(brl|usd|clp|mxn)(?=_|$)/g, ''); }
  const FAMILY_LABEL = {
    steel_kt: 'Steel shipments', iron_ore_mt: 'Iron ore sales', iron_ore_pellets_mt: 'Pellet sales', nickel_kt: 'Nickel sales',
    copper_kt: 'Copper sales', gold_koz: 'Gold sales', gold_geo_koz: 'Gold-equivalent sales', pulp_kt: 'Pulp sales',
    paper_kt: 'Paper sales', paperboard_kt: 'Paperboard sales', packaging_kt: 'Packaging sales', tissue_kt: 'Tissue sales',
    steel_brazil: 'Steel price — Brazil', steel: 'Steel revenue per tonne', iron_ore: 'Iron ore realized price',
    iron_ore_fines: 'Iron ore fines price', pulp_hw: 'Hardwood pulp price', pulp_sw_fluff: 'Softwood + fluff pulp price',
    pulp_sw: 'Softwood pulp price', pulp_mix: 'Pulp price (all fibers)', copper_t: 'Copper price (per tonne)',
    copper_lb: 'Copper price (per lb)', gold_oz: 'Gold price', iron_ore_c1_t: 'Iron ore C1 cash cost',
    corrugated_boxes: 'Corrugated boxes price', paperboard: 'Paperboard price', packaging: 'Packaging price'
  };
  function familyLabel(f, fallback) { return FAMILY_LABEL[f] || fallback || f; }
  // get_quarterly_metric → {família: [{company, series}]} só com família em 2+ empresas
  function compareGroups(metricRes, std) {
    const g = {};
    ((metricRes && metricRes.series) || []).forEach(function (s) {
      if (s.std !== std) return;
      const f = family(s.def) || std;
      (g[f] = g[f] || []).push(s);
    });
    Object.keys(g).forEach(function (f) {
      const cos = new Set(g[f].map(function (s) { return s.company; }));
      if (cos.size < 2) delete g[f];
    });
    return g;
  }

  // ── Excel ─────────────────────────────────────────────────────────────────────
  const SRC_TXT = { model: 'Company model (Itaú BBA)', calc: 'Itaú BBA calculation', filed: 'As filed (CVM/SEC)', mixed: 'Model + filed' };
  function aoaCompany(co) {
    const all = [];
    (co.series || []).forEach(function (s) { Object.keys(s.vals || {}).forEach(function (q) { all.push(q); }); });
    Object.keys(co.filedBy || {}).forEach(function (q) { all.push(q); });
    const qs = qRange(minQ(all), maxQ(all));
    const aoa = [['Series', 'Unit', 'Source'].concat(qs.map(qShort))];
    (co.series || []).slice().sort(function (a, b) { return (a.ord || 0) - (b.ord || 0); }).forEach(function (s) {
      aoa.push([s.label || s.key, unitLabel(s.unit), s.calc ? SRC_TXT.calc : SRC_TXT.model].concat(qs.map(function (q) { return s.vals[q] == null ? '' : s.vals[q]; })));
    });
    const ccy = (Object.values(co.filedBy || {})[0] || {}).ccy || 'BRL';
    [['rev', 'Net revenue'], ['ebitda', 'EBITDA (accounting)'], ['ni', 'Net income'], ['nd', 'Net debt']].forEach(function (p) {
      const f = filedVals(co, p[0]);
      if (Object.keys(f.vals).length) aoa.push([p[1] + ' — as filed', unitLabel(MONEY_UNIT[f.ccy || ccy]), SRC_TXT.filed].concat(qs.map(function (q) { return f.vals[q] == null ? '' : f.vals[q]; })));
    });
    if ((co.notes || []).length) {
      aoa.push([]); aoa.push(['Notes']);
      co.notes.forEach(function (n) { aoa.push([qShort(n.q_from) + (n.q_to ? '–' + qShort(n.q_to) : ''), n.kind || '', n.text || '']); });
    }
    return aoa;
  }
  // linhas = empresas; colunas = trimestres (histórico inteiro da série escolhida)
  function aoaCompare(rows, label, unit) {
    const all = [];
    rows.forEach(function (r) { Object.keys(r.vals || {}).forEach(function (q) { all.push(q); }); });
    const qs = qRange(minQ(all), maxQ(all));
    const aoa = [[label + (unit ? ' (' + unitLabel(unit) + ')' : '')].concat(qs.map(qShort))];
    rows.forEach(function (r) { aoa.push([r.name || r.company].concat(qs.map(function (q) { return r.vals[q] == null ? '' : r.vals[q]; }))); });
    return aoa;
  }

  return {
    VERSION: VERSION, qIdx: qIdx, qAdd: qAdd, qShort: qShort, qRange: qRange, maxQ: maxQ, minQ: minQ, sortQ: sortQ,
    normTicker: normTicker, fromBoot: fromBoot, fromCompany: fromCompany, indexCompany: indexCompany, reportingCcy: reportingCcy,
    pick: pick, basis: basis, headlineKey: headlineKey, ltm: ltm, ltmSeries: ltmSeries, pct: pct, change: change, delta: delta,
    toUsd: toUsd, hasFx: hasFx, nextResults: nextResults, seasonQ: seasonQ, status: status, fmtDate: fmtDate,
    unitLabel: unitLabel, fmt: fmt, kindOf: kindOf, COMPARE: COMPARE, family: family, familyLabel: familyLabel,
    compareGroups: compareGroups, aoaCompany: aoaCompany, aoaCompare: aoaCompare, SRC_TXT: SRC_TXT
  };
});
