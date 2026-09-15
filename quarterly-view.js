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

  const VERSION = '1.1.0';
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
  // Uma entrada por métrica da tela Compare. `keys` = o que pedir ao get_quarterly_metric, que aceita
  // de 1 a 3 chaves por chamada — a tela ficou em BRANCO em produção quando pediu 4 de uma vez
  // (receita, EBITDA, lucro e dívida) para qualquer métrica simples; o erro era engolido.
  // `byDef` = a métrica se abre em famílias (definição sem a moeda); `unitEcon` = calculada aqui a
  // partir das séries do modelo (precisa da empresa inteira, get_quarterly_company).
  const COMPARE = [
    { id: 'revenue',         group: 'Headline',       label: 'Net revenue',                kind: 'money',  keys: ['revenue'] },
    { id: 'adj_ebitda',      group: 'Headline',       label: 'Adjusted EBITDA',            kind: 'money',  keys: ['adj_ebitda'] },
    { id: 'margin',          group: 'Headline',       label: 'Adj. EBITDA margin',         kind: 'pct',    keys: ['adj_ebitda', 'revenue'] },
    { id: 'net_income',      group: 'Headline',       label: 'Net income',                 kind: 'money',  keys: ['net_income'] },
    { id: 'net_debt',        group: 'Headline',       label: 'Net debt',                   kind: 'money',  keys: ['net_debt'] },
    { id: 'leverage',        group: 'Headline',       label: 'Net debt / LTM adj. EBITDA', kind: 'x',      keys: ['net_debt', 'adj_ebitda'] },
    { id: 'ebit',            group: 'Headline',       label: 'EBIT',                       kind: 'money',  keys: ['ebit'] },
    { id: 'sales_volume',    group: 'Volumes',        label: 'Sales volume',               kind: 'volume', keys: ['sales_volume'], byDef: true },
    { id: 'realized_price',  group: 'Prices',         label: 'Realized price',             kind: 'price',  keys: ['realized_price'], byDef: true },
    { id: 'cash_cost',       group: 'Cash costs',     label: 'Cash cost',                  kind: 'price',  keys: ['cash_cost'], byDef: true },
    { id: 'ebitda_per_unit', group: 'Unit economics', label: 'EBITDA per unit',            kind: 'price',  unitEcon: true },
    { id: 'cash_margin',     group: 'Unit economics', label: 'Cash margin per unit',       kind: 'price',  unitEcon: true }
  ];
  function metricKeys(m) { return m && m.keys ? m.keys.slice(0, 3) : []; }
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

  // ── definições "parentes" ─────────────────────────────────────────────────────
  // A mesma grandeza com definição diferente (base FOB × CFR, região, fibra, antes × depois dos
  // subprodutos). Só entram lado a lado quando o cliente liga "related definitions" — e a definição
  // de cada empresa vai escrita ao lado, nunca calada. `to` = unidade comum quando a conversão é
  // EXATA (libra ↔ tonelada); sem conversão exata, cada série fica na unidade em que foi reportada.
  const RELATED = {
    iron_ore_price: { std: 'realized_price', label: 'Iron ore — all realized-price definitions', fams: ['iron_ore', 'iron_ore_fines', 'iron_ore_third', 'iron_ore_pellets'] },
    steel_price:    { std: 'realized_price', label: 'Steel — price per tonne, all regions', fams: ['steel_brazil', 'steel', 'steel_na', 'steel_sa'] },
    pulp_price:     { std: 'realized_price', label: 'Pulp — all fibers', fams: ['pulp_hw', 'pulp_sw', 'pulp_sw_fluff', 'pulp_mix'] },
    copper_price:   { std: 'realized_price', label: 'Copper — per tonne (lb converted)', fams: ['copper_t', 'copper_lb'], to: 'USD/t' },
    gold_price:     { std: 'realized_price', label: 'Gold — per oz (GEO for Aura)', fams: ['gold_oz', 'gold_geo_oz'] },
    pulp_cost:      { std: 'cash_cost', label: 'Pulp cash cost — definitions differ', fams: ['pulp_cash_cost_ex_downtime_t', 'pulp_hw_cash_cost_t', 'pulp_sw_cash_cost_t', 'pulp_cash_opex_t'] },
    copper_cost:    { std: 'cash_cost', label: 'Copper cash cost — before vs net of by-products', fams: ['copper_cash_cost_before_byprod_lb', 'copper_cash_cost_t'], to: 'USD/t' },
    iron_ore_vol:   { std: 'sales_volume', label: 'Iron ore — fines and pellets', fams: ['iron_ore_mt', 'iron_ore_pellets_mt'] }
  };
  // get_quarterly_metric → {parente: [{company, series}]} só com 2+ empresas
  function relatedGroups(metricRes, std) {
    const out = {};
    Object.keys(RELATED).forEach(function (k) {
      const r = RELATED[k]; if (r.std !== std) return;
      const list = ((metricRes && metricRes.series) || []).filter(function (s) { return s.std === std && r.fams.indexOf(family(s.def)) >= 0; });
      if (new Set(list.map(function (s) { return s.company; })).size >= 2) out[k] = list;
    });
    return out;
  }

  // ── unidades: só conversão EXATA ──────────────────────────────────────────────
  const CONV = { 'USD/lb>USD/t': 2204.62262, 'USD/t>USD/lb': 1 / 2204.62262, 'Mt>kt': 1000, 'kt>Mt': 0.001, 'Moz>koz': 1000, 'koz>Moz': 0.001 };
  function convert(series, toUnit) {
    if (!series || !toUnit || series.unit === toUnit) return series;
    const f = CONV[series.unit + '>' + toUnit]; if (!f) return null;
    const vals = {};
    Object.keys(series.vals || {}).forEach(function (q) { vals[q] = series.vals[q] * f; });
    return Object.assign({}, series, { vals: vals, unit: toUnit });
  }

  // ── transformações de uma série ───────────────────────────────────────────────
  // 'lvl' como está · 'yoy'/'qoq' variação (base ≤ 0 não sai) · 'idx' = 100 no 1º trimestre da janela
  function transform(vals, mode, qs) {
    vals = vals || {};
    if (mode === 'yoy' || mode === 'qoq') {
      const lag = mode === 'yoy' ? 4 : 1, o = {};
      Object.keys(vals).forEach(function (q) { const c = change(vals, q, lag); if (c != null) o[q] = c; });
      return o;
    }
    if (mode === 'idx') {
      const list = qs && qs.length ? qs : sortQ(Object.keys(vals));
      const b = list.map(function (q) { return vals[q]; }).find(function (v) { return v != null && v > 0; });
      const o = {};
      if (b) list.forEach(function (q) { if (vals[q] != null) o[q] = vals[q] / b * 100; });
      return o;
    }
    return vals;
  }

  // ── unit economics ────────────────────────────────────────────────────────────
  // Por empresa: onde o MODELO já traz a série (número do analista), é ela; onde não traz, é a razão
  // de duas séries do MESMO segmento, marcada como cálculo do Itaú BBA e com a conta escrita na nota.
  // Nada de EBITDA consolidado ÷ volume de um produto só (CSN, Klabin, Vale…): mistura segmentos.
  const UNIT_ECON = {
    ebitda_per_unit: {
      label: 'EBITDA per unit', kind: 'price',
      cos: {
        CSNA3:  { fam: 'steel',    key: 'steel.ebitda_t', note: 'Steel segment EBITDA per tonne shipped (model)' },
        USIM5:  { fam: 'steel',    key: 'steel.ebitda_t', note: 'Steel segment EBITDA per tonne shipped (model)' },
        TX:     { fam: 'steel',    key: 'steel.ebitda_t', note: 'Steel segment EBITDA per tonne shipped (model)' },
        GGBR4:  { fam: 'steel',    key: 'ebitda_t',       note: 'Consolidated EBITDA per tonne shipped (model)' },
        SUZB3:  { fam: 'pulp',     key: 'pulp.ebitda_t',  note: 'Pulp segment adjusted EBITDA per tonne (model)' },
        KLBN11: { fam: 'pulp',     num: 'pulp.ebitda', den: 'pulp.vol', note: 'Pulp segment EBITDA ÷ pulp sales volume' },
        COPEC:  { fam: 'pulp',     num: 'pulp.ebitda', den: 'pulp.vol', note: 'Arauco pulp EBITDA ÷ pulp sales volume' },
        CMPC:   { fam: 'pulp',     num: 'pf.ebitda',   den: 'pulp.vol', note: 'Celulosa segment EBITDA (pulp + forestry) ÷ pulp sales volume' },
        VALE3:  { fam: 'iron_ore', num: 'fines.ebitda', den: 'ferrous.vol.fines', note: 'Iron ore fines EBITDA ÷ fines sales volume' },
        CMIN3:  { fam: 'iron_ore', num: 'adj_ebitda',  den: 'vol', note: 'Adjusted EBITDA ÷ iron ore sales volume (single-product company)' },
        AUGO:   { fam: 'gold',     key: 'ebitda_oz',    note: 'EBITDA per GEO sold (model)' }
      }
    },
    cash_margin: {
      label: 'Cash margin per unit', kind: 'price',
      cos: {
        SCCO:  { fam: 'copper', px: 'px.copper', cost: 'cash_cost_net', to: 'USD/t', note: 'Realized copper price − operating cash cost net of by-product credits (lb converted to t)' },
        VALE3: { fam: 'copper', px: 'px.copper', cost: 'copper.cash_cost_t', note: 'Realized copper price − copper unit cash cost' },
        AUGO:  { fam: 'gold',   px: 'px', cost: 'cash_cost', note: 'Realized GEO price − cash cost per GEO' },
        SUZB3: { fam: 'pulp',   px: 'pulp.px', cost: 'pulp.cash_cost_t', note: 'Pulp realized price − cash cost ex-downtime' },
        CMPC:  { fam: 'pulp',   px: 'pulp.px.bhkp', cost: 'pulp.cash_cost_t.bhkp', note: 'BHKP realized price − BHKP cash cost' },
        COPEC: { fam: 'pulp',   px: 'pulp.px', cost: 'pulp.cash_opex_t', note: 'Pulp realized price − pulp cash opex per tonne' }
      }
    }
  };
  const UE_FAMILY_LABEL = { steel: 'Steel', pulp: 'Pulp', iron_ore: 'Iron ore', copper: 'Copper', gold: 'Gold' };
  const PER = { kt: [1e3, 't'], Mt: [1e6, 't'], koz: [1e3, 'oz'], Moz: [1e6, 'oz'], k_m3: [1e3, 'm³'] };
  // empresa (indexada, inteira) → série da unit economics, ou null quando o modelo não tem as peças
  function unitEcon(co, id) {
    const spec = UNIT_ECON[id], d = spec && co && spec.cos[co.ticker];
    if (!d) return null;
    const by = co.byKey || {};
    const base = { id: id + ':' + co.ticker, kind: 'price', agg: 'rate', fam: d.fam, note: d.note, calc: false };
    if (d.key) {
      const s = by[d.key]; if (!s || !s.unit) return null;
      return Object.assign(base, { vals: Object.assign({}, s.vals), unit: s.unit, ccy: s.ccy || unitCcyOf(s.unit), calc: !!s.calc, label: spec.label + ' — ' + co.name });
    }
    if (d.num) {
      const n = by[d.num], v = by[d.den];
      const per = v && PER[v.unit]; const m = n && /^([A-Z]{3})_mn$/.exec(n.unit || '');
      if (!n || !v || !per || !m) return null;
      const vals = {};
      Object.keys(n.vals).forEach(function (q) { const a = n.vals[q], b = v.vals[q]; if (a != null && b != null && b > 0) vals[q] = a * 1e6 / (b * per[0]); });
      return Object.assign(base, { vals: vals, unit: m[1] + '/' + per[1], ccy: m[1], calc: true, label: spec.label + ' — ' + co.name });
    }
    if (d.px) {
      const p = by[d.px], c = by[d.cost];
      if (!p || !c) return null;
      const cc = convert(c, p.unit); if (!cc) return null;
      const vals = {};
      Object.keys(p.vals).forEach(function (q) { if (p.vals[q] != null && cc.vals[q] != null) vals[q] = p.vals[q] - cc.vals[q]; });
      let out = Object.assign(base, { vals: vals, unit: p.unit, ccy: p.ccy || unitCcyOf(p.unit), calc: true, label: spec.label + ' — ' + co.name });
      if (d.to) out = convert(out, d.to) || out;
      return out;
    }
    return null;
  }
  function unitCcyOf(u) { const m = /^(BRL|USD|CLP|MXN)(?:_|\/)/.exec(u || ''); return m ? m[1] : null; }
  // as famílias de uma unit economics presentes em 2+ das empresas dadas
  function unitEconFamilies(id, tickers) {
    const spec = UNIT_ECON[id]; if (!spec) return {};
    const out = {};
    Object.keys(spec.cos).forEach(function (t) { if (tickers.indexOf(t) >= 0) (out[spec.cos[t].fam] = out[spec.cos[t].fam] || []).push(t); });
    Object.keys(out).forEach(function (f) { if (out[f].length < 2) delete out[f]; });
    return out;
  }

  // ── índices livres (benchmarks) ───────────────────────────────────────────────
  // Só o que a dashboard já publica em NÚMERO: minério 62% do Trading Economics e cobre/ouro do
  // Yahoo. Platts, Fastmarkets/PIX e LME são pagos e nunca chegam aqui. A média trimestral sai
  // dos fechamentos diários; trimestre corrente (incompleto) fica de fora.
  const BENCH = {
    IRON_ORE_62: { label: 'Iron ore 62% Fe CFR China — Trading Economics', short: '62% Fe index', unit: 'USD/t' },
    COPPER:      { label: 'Copper — COMEX front month (Yahoo Finance)', short: 'COMEX copper', unit: 'USD/lb' },
    GOLD:        { label: 'Gold — COMEX front month (Yahoo Finance)', short: 'COMEX gold', unit: 'USD/oz' }
  };
  const BENCH_CODES = Object.keys(BENCH);
  // família de preço realizado → índice comparável (mesma unidade, ou conversão exata lb ↔ t)
  const BENCH_FOR = { iron_ore_fines: 'IRON_ORE_62', iron_ore: 'IRON_ORE_62', iron_ore_third: 'IRON_ORE_62',
                      copper_lb: 'COPPER', copper_t: 'COPPER', gold_oz: 'GOLD', gold_geo_oz: 'GOLD' };
  function benchQuarterly(daily, currentQ, minPts) {
    const acc = {};
    (daily || []).forEach(function (p) {
      if (!p || p.length < 2 || p[1] == null) return;
      const d = new Date(p[0] * 1000), q = d.getUTCFullYear() + 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
      (acc[q] = acc[q] || []).push(Number(p[1]));
    });
    const out = {}, min = minPts || 40;
    Object.keys(acc).forEach(function (q) {
      if (currentQ && qIdx(q) >= qIdx(currentQ)) return;                   // incompleto
      if (acc[q].length < min) return;                                     // pedaço de trimestre não é média
      out[q] = acc[q].reduce(function (a, b) { return a + b; }, 0) / acc[q].length;
    });
    return out;
  }
  // série de índice pronta para desenhar ao lado de uma série de preço (na unidade dela, se houver conversão)
  function benchSeries(code, quarterly, unit, toUnit, fx) {
    const b = BENCH[code]; if (!b || !quarterly) return null;
    let s = { id: '@' + code, label: b.short, vals: Object.assign({}, quarterly), unit: unit || b.unit, ccy: 'USD', kind: 'price', agg: 'rate', bench: true };
    if (toUnit && toUnit !== s.unit) {
      const conv = convert(s, toUnit);
      if (conv) return conv;
      // US$ → R$ (índice em dólar ao lado de um preço em reais): média do trimestre, e a legenda diz
      const m = /^([A-Z]{3})\//.exec(toUnit), t = m && fx && fx[m[1]];
      if (!t || !/\/t$/.test(s.unit) || !/\/t$/.test(toUnit)) return null;
      const vals = {};
      Object.keys(s.vals).forEach(function (q) { const r = t[q]; if (r && r[0] > 0) vals[q] = s.vals[q] * r[0]; });
      // fxConverted: é referência, não comparação — preço FOB em R$ × índice CFR em US$ não dá "realização"
      return Object.assign({}, s, { vals: vals, unit: toUnit, ccy: m[1], label: b.short + ' (' + m[1] + ' at avg FX)', fxConverted: true });
    }
    return s;
  }

  // ── endereço do Build ─────────────────────────────────────────────────────────
  // camada = {co, key, tf, ax, ty} → 'VALE3:px.fines:lvl:L:line'; índice = ':@IRON_ORE_62:…' (sem empresa)
  const TF = ['lvl', 'yoy', 'qoq', 'idx', 'ltm'];
  function encodeLayers(layers) {
    return (layers || []).map(function (l) { return [l.co || '', l.key || '', l.tf || 'lvl', l.ax === 'R' ? 'R' : 'L', l.ty === 'bar' ? 'bar' : 'line'].join(':'); }).join('~');
  }
  function decodeLayers(s) {
    return String(s || '').split('~').map(function (p) {
      const a = p.split(':'); if (a.length < 2 || !a[1]) return null;
      return { co: a[0] || null, key: a[1], tf: TF.indexOf(a[2]) >= 0 ? a[2] : 'lvl', ax: a[3] === 'R' ? 'R' : 'L', ty: a[4] === 'bar' ? 'bar' : 'line' };
    }).filter(Boolean).slice(0, 8);
  }
  // séries × trimestres (histórico inteiro), para o Excel do Build e do Compare
  function aoaSeries(list, title) {
    const all = [];
    (list || []).forEach(function (s) { Object.keys(s.vals || {}).forEach(function (q) { all.push(q); }); });
    const qs = qRange(minQ(all), maxQ(all));
    const aoa = [[title || 'Series', 'Unit', 'Source'].concat(qs.map(qShort))];
    (list || []).forEach(function (s) { aoa.push([s.label, unitLabel(s.unit), s.bench ? 'Free benchmark (' + s.label + ')' : s.calc ? SRC_TXT.calc : SRC_TXT.model].concat(qs.map(function (q) { return s.vals[q] == null ? '' : s.vals[q]; }))); });
    return aoa;
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
    unitLabel: unitLabel, fmt: fmt, kindOf: kindOf, COMPARE: COMPARE, metricKeys: metricKeys, family: family, familyLabel: familyLabel,
    compareGroups: compareGroups, RELATED: RELATED, relatedGroups: relatedGroups, convert: convert, transform: transform,
    UNIT_ECON: UNIT_ECON, UE_FAMILY_LABEL: UE_FAMILY_LABEL, unitEcon: unitEcon, unitEconFamilies: unitEconFamilies,
    BENCH: BENCH, BENCH_CODES: BENCH_CODES, BENCH_FOR: BENCH_FOR, benchQuarterly: benchQuarterly, benchSeries: benchSeries,
    encodeLayers: encodeLayers, decodeLayers: decodeLayers, aoaSeries: aoaSeries,
    aoaCompany: aoaCompany, aoaCompare: aoaCompare, SRC_TXT: SRC_TXT
  };
});
