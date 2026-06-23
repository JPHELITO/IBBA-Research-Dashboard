/* =============================================================================
 * stock-guide-lib.js — motor compartilhado do Stock Guide (porta a spec §6 VERBATIM).
 * Usado PELA PÁGINA (stock-guide.html) E pelo PREVIEW do admin → nunca divergem.
 * Vanilla JS; expõe window.SG (e module.exports p/ teste em node). Adaptado p/ S&M+P&P:
 * drivers dinâmicos = spot ao vivo (sem curva forward) lendo commodities/macro.
 * ========================================================================== */
;(function (root) {
  'use strict';

  // ── numéricos ───────────────────────────────────────────────────────────
  // PostgREST serializa numeric como STRING → sempre coagir (senão .toFixed/aritmética quebram).
  function toNumOrNull(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ── 6.1 Catálogo de drivers DINÂMICOS (adaptado: lê dados ao vivo que já coletamos) ──
  // src = onde buscar o valor vivo: tabela `commodities` (por code) ou `macro` (por code).
  // Sem curva forward → o valor do ano = spot (flat).
  const MARKET_DRIVER_CATALOG = [
    { key: 'iron_ore_62',  label: 'Iron ore 62% Fe (Platts)', unit: 'USD/t',   src: { table: 'commodities', code: 'IRON_ORE' } },
    { key: 'hrc_china',    label: 'HRC China (Platts)',       unit: 'USD/t',   src: { table: 'commodities', code: 'HRC_CHINA' } },
    { key: 'rebar_turkey', label: 'Rebar Turkey (Platts)',    unit: 'USD/t',   src: { table: 'commodities', code: 'REBAR_TURKEY' } },
    { key: 'met_coal',     label: 'Met coal (Platts)',        unit: 'USD/t',   src: { table: 'commodities', code: 'MET_COAL' } },
    { key: 'copper',       label: 'Copper (LME proxy)',       unit: 'USD/lb',  src: { table: 'commodities', code: 'COPPER' } },
    { key: 'gold',         label: 'Gold',                     unit: 'USD/oz',  src: { table: 'commodities', code: 'GOLD' } },
    { key: 'fx_usdbrl',    label: 'USD/BRL',                  unit: 'BRL/USD', src: { table: 'macro',       code: 'USD_BRL' } },
  ];
  const MARKET_DRIVER_CATALOG_BY_KEY = MARKET_DRIVER_CATALOG.reduce(function (m, d) { m[d.key] = d; return m; }, {});

  function isDynamicSource(src) {
    return src != null && src !== '' && Object.prototype.hasOwnProperty.call(MARKET_DRIVER_CATALOG_BY_KEY, src);
  }
  // valor efetivo de um driver: vivo p/ dinâmico, current_value p/ estático.
  function resolveDriverValue(driver, marketValues) {
    const src = driver.source;
    if (isDynamicSource(src)) {
      const v = marketValues ? marketValues[src] : null;
      return v != null && Number.isFinite(v) ? v : null;
    }
    const cv = driver.current_value;
    return cv != null && Number.isFinite(cv) ? cv : null;
  }

  // ── 6.3 GridMesh: índice por tupla-de-índices ─────────────────────────────
  // points: [{coords:number[], value:number}]; dim = número de eixos (1..3) de definition.grid.axes.length.
  function buildGridMesh(points, dim) {
    if (!points || !points.length || dim < 1) return null;
    const levelSets = [];
    for (let a = 0; a < dim; a++) levelSets.push(new Set());
    for (const p of points) for (let a = 0; a < dim; a++) levelSets[a].add(p.coords[a] != null ? p.coords[a] : 0);
    const levels = levelSets.map(function (s) { return Array.from(s).sort(function (a, b) { return a - b; }); });
    const values = new Map();
    for (const p of points) {
      const idx = [];
      for (let a = 0; a < dim; a++) {
        const c = p.coords[a] != null ? p.coords[a] : 0;
        idx.push(levels[a].indexOf(c));
      }
      values.set(idx.join(','), p.value);   // último escreve vence
    }
    return { dim: dim, levels: levels, values: values };
  }

  // ── 6.4 interpolação MULTILINEAR (verbatim) ───────────────────────────────
  function bracketAxis(levels, v) {
    const n = levels.length;
    const x = Number.isFinite(v) ? v : levels[0];        // não-finito → clampa ao mínimo
    if (n <= 1 || x <= levels[0]) return { lo: 0, hi: 0, frac: 0 };
    if (x >= levels[n - 1]) return { lo: n - 1, hi: n - 1, frac: 0 };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (levels[mid] <= x) lo = mid; else hi = mid; }
    const span = levels[hi] - levels[lo];
    const frac = span === 0 ? 0 : (x - levels[lo]) / span;
    return { lo: lo, hi: hi, frac: frac };
  }

  function interpolateMesh(mesh, at) {
    if (!mesh) return null;
    const dim = mesh.dim, levels = mesh.levels, values = mesh.values;
    if (dim < 1 || values.size === 0) return null;
    const brackets = [];
    const activeAxes = [];
    for (let a = 0; a < dim; a++) {
      const b = bracketAxis(levels[a], at[a] != null ? at[a] : NaN);
      brackets.push(b);
      if (b.lo !== b.hi && b.frac !== 0) activeAxes.push(a);
    }
    const k = activeAxes.length;
    let acc = 0;
    for (let mask = 0; mask < (1 << k); mask++) {
      const indices = brackets.map(function (b) { return b.lo; });
      let weight = 1;
      for (let bit = 0; bit < k; bit++) {
        const axis = activeAxes[bit];
        const upper = (mask & (1 << bit)) !== 0;
        if (upper) { indices[axis] = brackets[axis].hi; weight *= brackets[axis].frac; }
        else { weight *= 1 - brackets[axis].frac; }
      }
      const v = values.get(indices.join(','));
      if (v == null) return null;                        // canto obrigatório ausente → null, nunca NaN
      acc += weight * v;
    }
    return acc;
  }

  // ── 6.5 derivação por value_mode (ÚNICA fonte da matemática) ──────────────
  const VALUE_MODE_UNIT = { absolute: '', yield: '%', pe: '×', ev_ebitda: '×', upside: '%' };

  function computeSensitivityCellValue(o) {
    const valueMode = o.valueMode, primary = o.primary, secondary = o.secondary;
    const marketCapBrlMn = o.marketCapBrlMn, livePrice = o.livePrice;
    switch (valueMode) {
      case 'absolute':  return primary;
      case 'yield':     return primary != null && marketCapBrlMn != null && marketCapBrlMn > 0 ? (primary / marketCapBrlMn) * 100 : null;
      case 'pe':        return marketCapBrlMn != null && primary != null && primary > 0 ? marketCapBrlMn / primary : null;
      case 'ev_ebitda': return primary != null && primary > 0 && secondary != null && marketCapBrlMn != null ? (marketCapBrlMn + secondary) / primary : null;
      case 'upside':    return primary != null && livePrice != null && livePrice > 0 ? (primary / livePrice - 1) * 100 : null;
      default:          return null;
    }
  }

  // ── catálogo de outputs do grid (base → mode/rawMetric/secondary) (§6.5) ──
  const GRID_OUTPUT_CATALOG = {
    target_price:   { mode: 'upside',    rawMetric: 'target_price', secondary: null },
    fcfe:           { mode: 'yield',     rawMetric: 'fcfe',         secondary: null },
    dividends:      { mode: 'yield',     rawMetric: 'dividends',    secondary: null },
    net_income:     { mode: 'pe',        rawMetric: 'net_income',   secondary: null },
    net_income_abs: { mode: 'absolute',  rawMetric: 'net_income',   secondary: null },   // compartilha o mesh de net_income
    ebitda:         { mode: 'absolute',  rawMetric: 'ebitda',       secondary: null },
    ev_ebitda:      { mode: 'ev_ebitda', rawMetric: 'ebitda',       secondary: 'net_debt' }, // 2º mesh = net_debt
  };
  // bases ordenadas p/ casar a MAIS LONGA primeiro (net_income_abs antes de net_income; ev_ebitda antes de ebitda)
  const _SG_BASES = ['target_price', 'net_income_abs', 'net_income', 'ev_ebitda', 'ebitda', 'fcfe', 'dividends'];

  function _parseColumnKey(key) {
    for (const b of _SG_BASES) {
      if (key === b) return { base: b, year: null };
      if (key.indexOf(b + '_') === 0) return { base: b, year: key.slice(b.length + 1) };
    }
    const i = key.lastIndexOf('_');
    return i > 0 ? { base: key.slice(0, i), year: key.slice(i + 1) } : { base: key, year: null };
  }
  // COLUNA (display id, único): base ou base_ano
  function sgGridOutputKey(o) { return o.year ? (o.base + '_' + o.year) : o.base; }
  // ARMAZENAMENTO (metric do mesh / nome da aba do Excel; PODE ser compartilhado)
  function sgGridStorageKey(o) { const c = GRID_OUTPUT_CATALOG[o.base]; const raw = c ? c.rawMetric : o.base; return o.year ? (raw + '_' + o.year) : raw; }
  function sgGridSecondaryStorageKey(o) { const c = GRID_OUTPUT_CATALOG[o.base]; if (!c || !c.secondary) return null; return o.year ? (c.secondary + '_' + o.year) : c.secondary; }
  function storageKeyForColumnKey(key) { return sgGridStorageKey(_parseColumnKey(key)); }
  function secondaryStorageKeyForColumnKey(key) { return sgGridSecondaryStorageKey(_parseColumnKey(key)); }
  function modeForColumnKey(key) { const c = GRID_OUTPUT_CATALOG[_parseColumnKey(key).base]; return c ? c.mode : 'upside'; }

  // ── formatação ────────────────────────────────────────────────────────────
  function formatSensitivityValue(v, mode, unit, decimals) {
    if (v == null || !Number.isFinite(v)) return '—'; // —
    let d = decimals;
    if (d == null) d = (mode === 'pe' || mode === 'ev_ebitda') ? 1 : ((mode === 'yield' || mode === 'upside') ? 1 : 0);
    d = Math.max(0, Math.min(6, d));
    const num = v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
    if (mode === 'yield' || mode === 'upside') return num + '%';
    if (mode === 'pe' || mode === 'ev_ebitda') return num + '×'; // ×
    return unit ? (num + ' ' + unit) : num;
  }

  const SG = {
    toNumOrNull: toNumOrNull,
    MARKET_DRIVER_CATALOG: MARKET_DRIVER_CATALOG,
    MARKET_DRIVER_CATALOG_BY_KEY: MARKET_DRIVER_CATALOG_BY_KEY,
    isDynamicSource: isDynamicSource,
    resolveDriverValue: resolveDriverValue,
    buildGridMesh: buildGridMesh,
    bracketAxis: bracketAxis,
    interpolateMesh: interpolateMesh,
    VALUE_MODE_UNIT: VALUE_MODE_UNIT,
    computeSensitivityCellValue: computeSensitivityCellValue,
    GRID_OUTPUT_CATALOG: GRID_OUTPUT_CATALOG,
    sgGridOutputKey: sgGridOutputKey,
    sgGridStorageKey: sgGridStorageKey,
    sgGridSecondaryStorageKey: sgGridSecondaryStorageKey,
    storageKeyForColumnKey: storageKeyForColumnKey,
    secondaryStorageKeyForColumnKey: secondaryStorageKeyForColumnKey,
    modeForColumnKey: modeForColumnKey,
    formatSensitivityValue: formatSensitivityValue,
  };

  root.SG = SG;
  if (typeof module !== 'undefined' && module.exports) module.exports = SG;
})(typeof window !== 'undefined' ? window : globalThis);
