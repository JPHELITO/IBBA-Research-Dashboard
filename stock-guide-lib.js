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

  // Monta a MESMA malha de interpolateMesh a partir de arrays DENSOS (grade regular comprimida).
  // levels: [ [níveis eixo0 ASC], ..., [níveis eixoN ASC] ]; dense: array achatado em ROW-MAJOR
  // (eixo 0 mais lento, último eixo mais rápido) sobre os níveis ordenados. Valores null = célula vazia.
  function buildGridMeshFromDense(levels, dense) {
    if (!levels || !levels.length || !dense) return null;
    const dim = levels.length;
    const sizes = levels.map(function (l) { return l.length; });
    let total = 1; for (let a = 0; a < dim; a++) total *= sizes[a];
    if (!total || dense.length < total) return null;
    const values = new Map();
    const idx = new Array(dim).fill(0);
    for (let flat = 0; flat < total; flat++) {
      const v = dense[flat];
      if (v != null && Number.isFinite(v)) values.set(idx.join(','), v);
      for (let a = dim - 1; a >= 0; a--) { if (++idx[a] < sizes[a]) break; idx[a] = 0; }
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
  const VALUE_MODE_UNIT = { absolute: '', yield: '%', pe: '×', ev_ebitda: '×', nd_ebitda: '×', upside: '%' };

  function computeSensitivityCellValue(o) {
    const valueMode = o.valueMode, primary = o.primary, secondary = o.secondary;
    const marketCapBrlMn = o.marketCapBrlMn, livePrice = o.livePrice;
    switch (valueMode) {
      case 'absolute':  return primary;
      case 'yield':     return primary != null && marketCapBrlMn != null && marketCapBrlMn > 0 ? (primary / marketCapBrlMn) * 100 : null;
      case 'pe':        return marketCapBrlMn != null && primary != null && primary > 0 ? marketCapBrlMn / primary : null;
      case 'ev_ebitda': return primary != null && primary > 0 && secondary != null && marketCapBrlMn != null ? (marketCapBrlMn + secondary) / primary : null;
      case 'nd_ebitda': return primary != null && primary > 0 && secondary != null ? secondary / primary : null;   // primary=EBITDA, secondary=Net Debt (do próprio ano)
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
    fcf:            { mode: 'absolute',  rawMetric: 'fcf',          secondary: null },
    fcf_yield:      { mode: 'yield',     rawMetric: 'fcf',          secondary: null },        // FCF / market cap
    net_debt:       { mode: 'absolute',  rawMetric: 'net_debt',     secondary: null },
    nd_ebitda:      { mode: 'nd_ebitda', rawMetric: 'ebitda',       secondary: 'net_debt' },  // Net Debt / EBITDA (do próprio ano)
  };
  // bases ordenadas p/ casar a MAIS LONGA/específica primeiro (net_income_abs<net_income; ev_ebitda<ebitda; fcf_yield<fcf; nd_ebitda sem colisão)
  const _SG_BASES = ['target_price', 'net_income_abs', 'net_income', 'ev_ebitda', 'nd_ebitda', 'ebitda', 'fcf_yield', 'fcf', 'fcfe', 'net_debt', 'dividends'];

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
    if (d == null) d = (mode === 'pe' || mode === 'ev_ebitda' || mode === 'nd_ebitda') ? 1 : ((mode === 'yield' || mode === 'upside') ? 1 : 0);
    d = Math.max(0, Math.min(6, d));
    // padrão inglês (1,234.56) — mesma régua do fmt/fmtPct/fmtX da stock-guide.html
    const num = v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    if (mode === 'yield' || mode === 'upside') return num + '%';
    if (mode === 'pe' || mode === 'ev_ebitda' || mode === 'nd_ebitda') return num + '×'; // ×
    return unit ? (num + ' ' + unit) : num;
  }

  // ── 8. INGESTÃO do modelo de equity research (.xlsm) ──────────────────────
  // Contrato: admin/STOCK_GUIDE_UPLOAD_CONTRACT.md. Lê as 14 abas de empresa cobertas
  // (CBA/Cement FORA) e devolve linhas prontas p/ admin_bulk_upsert_stock_guide_companies.
  // Detecção DINÂMICA (acha a coluna 2026E/2027E e os rótulos por varredura) → imune a
  // inserção de linhas/colunas. Múltiplos NÃO são lidos — são recalculados ao vivo na página.
  const SG_COVERAGE = [
    { tab:'VALE',            ticker:'VALE3',    yahoo:'VALE3.SA',    name:'Vale',            sector:'iron_ore',   group:'mining',     trade_ccy:'BRL' },
    { tab:'CSN MINERACAO',   ticker:'CMIN3',    yahoo:'CMIN3.SA',    name:'CSN Mineração',   sector:'iron_ore',   group:'mining',     trade_ccy:'BRL' },
    { tab:'GRUPO MEXICO',    ticker:'GMEXICOB', yahoo:'GMEXICOB.MX', name:'Grupo México',    sector:'copper',     group:'mining',     trade_ccy:'MXN' },
    { tab:'SOUTHERN COPPER', ticker:'SCCO',     yahoo:'SCCO',        name:'Southern Copper', sector:'copper',     group:'mining',     trade_ccy:'USD' },
    { tab:'AURA',            ticker:'AUGO',     yahoo:'AUGO',        name:'Aura',            sector:'gold',       group:'mining',     trade_ccy:'USD' },  // AUGO (Nasdaq, US$) é o ticker do Stock Guide — NÃO o BDR AURA33 (negocia em R$): o modelo lista preço/mktcap na linha AUGO
    { tab:'CSN',             ticker:'CSNA3',    yahoo:'CSNA3.SA',    name:'CSN',             sector:'steel',      group:'steel',      trade_ccy:'BRL' },
    { tab:'GERDAU',          ticker:'GGBR4',    yahoo:'GGBR4.SA',    name:'Gerdau',          sector:'steel',      group:'steel',      trade_ccy:'BRL' },
    { tab:'TERNIUM',         ticker:'TX',       yahoo:'TX',          name:'Ternium',         sector:'steel',      group:'steel',      trade_ccy:'USD' },
    { tab:'USIMINAS',        ticker:'USIM5',    yahoo:'USIM5.SA',    name:'Usiminas',        sector:'steel',      group:'steel',      trade_ccy:'BRL' },
    { tab:'SUZANO',          ticker:'SUZB3',    yahoo:'SUZB3.SA',    name:'Suzano',          sector:'pulp_paper', group:'pulp_paper', trade_ccy:'BRL' },
    { tab:'KLABIN',          ticker:'KLBN11',   yahoo:'KLBN11.SA',   name:'Klabin',          sector:'pulp_paper', group:'pulp_paper', trade_ccy:'BRL' },
    { tab:'IRANI',           ticker:'RANI3',    yahoo:'RANI3.SA',    name:'Irani',           sector:'pulp_paper', group:'pulp_paper', trade_ccy:'BRL' },
    { tab:'CMPC',            ticker:'CMPC',     yahoo:'CMPC.SN',     name:'CMPC',            sector:'pulp_paper', group:'pulp_paper', trade_ccy:'CLP' },
    { tab:'COPEC',           ticker:'COPEC',    yahoo:'COPEC.SN',    name:'Copec',           sector:'pulp_paper', group:'pulp_paper', trade_ccy:'CLP' },
  ];

  // limpa célula → número OU null: trata '#REF!'/'#N/A'/'n.a.'/'-'/vazio e número-como-texto en-US ("7,000"→7000)
  function _sgCellNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v instanceof Date) return null;
    let s = String(v).trim();
    if (s === '' || /^#|^n\.?\s*a\.?$|^-+$/i.test(s)) return null;
    s = s.replace(/\s/g, '').replace(/,/g, '');     // remove espaço + separador de milhar en-US (decimal é '.')
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function _isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  // 1ª célula (string) que casa `re`; predicado opcional sobre a linha. Devolve {r,c} ou null.
  function _sgFindCell(aoa, re, pred) {
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r]; if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (typeof v === 'string' && re.test(v.trim())) {
          if (!pred || pred(row, c)) return { r: r, c: c };
        }
      }
    }
    return null;
  }

  // câmbio do modelo (aba "Stock Guide"): rótulos "BRL/USD"/"CLP/USD"/... → taxa (unidades por USD).
  function parseSGFXRates(wb) {
    const X = root.XLSX; const rates = {};
    if (!X || !wb || !wb.SheetNames) return rates;
    const nm = wb.SheetNames.find(function (s) { return s.trim().toLowerCase() === 'stock guide'; });
    if (!nm) return rates;
    const aoa = X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: true });
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r]; if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        const m = typeof v === 'string' ? v.trim().match(/^(BRL|CLP|MXN|PEN|COP|ARS)\s*\/\s*USD$/i) : null;
        if (m) {
          const ccy = m[1].toUpperCase();
          for (let rr = r + 1; rr < aoa.length; rr++) {        // 1º numérico ABAIXO do rótulo, na mesma coluna
            const cand = aoa[rr] && aoa[rr][c];
            if (_isNum(cand) && cand > 0) { rates[ccy] = cand; break; }
          }
        }
      }
    }
    return rates;
  }

  // parse de UMA aba de empresa (aoa) + meta + fx → linha p/ o bulk RPC (ou {error}).
  function _sgParseCompanyAoa(aoa, meta, fxRates) {
    const warnings = [];
    // colunas dos anos-estimativa (2026E / 2027E) — mesma linha
    let y1 = -1, y2 = -1;
    for (let r = 0; r < aoa.length && (y1 < 0 || y2 < 0); r++) {
      const row = aoa[r] || []; let i1 = -1, i2 = -1;
      for (let c = 0; c < row.length; c++) {
        const s = (typeof row[c] === 'string') ? row[c].trim() : '';
        if (/^2026E$/i.test(s)) i1 = c; if (/^2027E$/i.test(s)) i2 = c;
      }
      if (i1 >= 0 && i2 >= 0) { y1 = i1; y2 = i2; break; }
    }
    if (y1 < 0 || y2 < 0) return { error: meta.tab + ': não encontrei as colunas 2026E/2027E' };

    // helpers ligados a este aoa
    const hNum = function (re) { const f = _sgFindCell(aoa, re, function (row, c) { return _sgCellNum(row[c + 1]) != null; }); return f ? _sgCellNum(aoa[f.r][f.c + 1]) : null; };  // aceita número-como-texto ("1,110")
    const hTxt = function (re) { const f = _sgFindCell(aoa, re, function (row, c) { return row[c + 1] != null && String(row[c + 1]).trim() !== ''; }); return f ? String(aoa[f.r][f.c + 1]).trim() : null; };
    const est  = function (re) { const f = _sgFindCell(aoa, re); return f ? { y1: _sgCellNum(aoa[f.r][y1]), y2: _sgCellNum(aoa[f.r][y2]) } : { y1: null, y2: null }; };
    // market cap na MOEDA-BASE = linha "Market Capitaliz" do bloco-série (numérica na coluna do ano)
    const mcF = _sgFindCell(aoa, /^market\s+capitaliz/i, function (row) { return _isNum(row[y1]); });
    const mcBase = mcF ? _sgCellNum(aoa[mcF.r][y1]) : null;

    const shares = hNum(/^shares\s+outstanding/i);
    const priceLocal = hNum(/^share\s+price/i);            // 1ª = moeda de negociação (col C)
    const target = hNum(/^target\s+price/i);
    const rec = (function () { const t = hTxt(/^analyst\s+recommend/i); return /^(OP|MP|UP)$/i.test(t || '') ? t.toUpperCase() : null; })();

    const ebitda = est(/^ebitda\s*\(/i);
    const netDebt = est(/^net\s+debt\s*\(/i);              // exclui "Net Debt/EBITDA (x)"
    const netInc = est(/^net\s+income\s*\(/i);
    const ocf = est(/^ocf\s*\(/i);                          // exclui "OCF Yield (%)"
    const capex = est(/^capex\s*\(/i);
    const netRev = est(/^net\s+revenues\s*\(/i);
    const cashE = est(/^cash\s+earnings/i);
    const divs = est(/^dividend.*int/i);                    // "Dividends/Int. on Capital" (exclui "Dividend Yield")
    const adj = est(/^adjustment/i);

    // fx_to_base direto do modelo (validado): mktcap_base / (preço × ações). ≈1 quando base==negociação.
    let fxBase = (_isNum(mcBase) && _isNum(priceLocal) && _isNum(shares) && priceLocal * shares !== 0)
      ? mcBase / (priceLocal * shares) : 1;
    if (!Number.isFinite(fxBase) || fxBase <= 0) { fxBase = 1; warnings.push(meta.tab + ': fx_to_base indeterminado → 1'); }
    const baseIsUsd = Math.abs(fxBase - 1) > 0.02;          // único base ≠ negociação observado = USD
    const baseCcy = baseIsUsd ? 'USD' : meta.trade_ccy;
    // fx_to_usd p/ a coluna "Mkt cap US$": USD-base usa fxBase; local-base usa 1/(taxa por USD)
    let fxUsd;
    if (meta.trade_ccy === 'USD') fxUsd = 1;
    else if (baseIsUsd) fxUsd = fxBase;
    else { const rt = fxRates[meta.trade_ccy]; fxUsd = (rt && rt > 0) ? 1 / rt : null; if (fxUsd == null) warnings.push(meta.tab + ': sem câmbio ' + meta.trade_ccy + '/USD → Mkt cap US$ indisponível'); }

    if (!_isNum(shares)) warnings.push(meta.tab + ': nº de ações ausente');
    if (!_isNum(ebitda.y1)) warnings.push(meta.tab + ': EBITDA 2026E ausente');

    return {
      row: {
        ticker: meta.ticker, company_name: meta.name, yahoo_symbol: meta.yahoo,
        sector: meta.sector, trade_ccy: meta.trade_ccy, base_ccy: baseCcy,
        shares_outstanding: shares, target_price: target, recommendation: rec,
        net_debt_y1: netDebt.y1, net_debt_y2: netDebt.y2,
        ebitda_y1: ebitda.y1, ebitda_y2: ebitda.y2,
        net_income_y1: netInc.y1, net_income_y2: netInc.y2,
        ocf_y1: ocf.y1, ocf_y2: ocf.y2, capex_y1: capex.y1, capex_y2: capex.y2,
        net_revenues_y1: netRev.y1, net_revenues_y2: netRev.y2,
        cash_earnings_y1: cashE.y1, cash_earnings_y2: cashE.y2,
        dividends_y1: divs.y1, dividends_y2: divs.y2,
        ev_adjustment_y1: adj.y1, ev_adjustment_y2: adj.y2,
        fx_to_base: Math.round(fxBase * 1e8) / 1e8, fx_to_usd: fxUsd == null ? null : Math.round(fxUsd * 1e8) / 1e8,
      },
      warnings: warnings, priceLocal: priceLocal, mcBase: mcBase,
    };
  }

  // workbook inteiro → {rows, perCompany, warnings, errors}
  function parseStockGuideWorkbook(wb) {
    const X = root.XLSX;
    if (!X) return { rows: [], perCompany: [], warnings: [], errors: ['SheetJS (XLSX) não carregado.'] };
    if (!wb || !wb.SheetNames) return { rows: [], perCompany: [], warnings: [], errors: ['Arquivo inválido.'] };
    const fxRates = parseSGFXRates(wb);
    const rows = [], perCompany = [], warnings = [], errors = [];
    SG_COVERAGE.forEach(function (meta, i) {
      const nm = wb.SheetNames.find(function (s) { return s.trim().toLowerCase() === meta.tab.toLowerCase(); });
      if (!nm) { errors.push('aba ausente: ' + meta.tab + ' (' + meta.ticker + ')'); return; }
      const aoa = X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: true });
      const res = _sgParseCompanyAoa(aoa, meta, fxRates);
      if (res.error) { errors.push(res.error); return; }
      res.row.display_order = i + 1;
      rows.push(res.row);
      perCompany.push({ meta: meta, row: res.row, priceLocal: res.priceLocal, mcBase: res.mcBase });
      res.warnings.forEach(function (w) { warnings.push(w); });
    });
    if (!rows.length) errors.push('Nenhuma empresa lida — confira se é o arquivo "Stock Guide ... .xlsm" certo.');
    return { rows: rows, perCompany: perCompany, warnings: warnings, errors: errors, fxRates: fxRates };
  }

  // ── 9. GLOBAL PEERS das abas "*Peers" (snapshot dos múltiplos; preço fica AO VIVO na página) ──
  // Só peers que TÊM cotação na aba Market e que NÃO são cobertos (cobertos já estão no comps).
  const SG_PEER_TABS = [
    { tab: 'Steel Peers',        sector: 'steel',      group: 'steel' },
    { tab: 'Mining Peers',       sector: 'mining',     group: 'mining' },
    { tab: 'Pulp & Paper Peers', sector: 'pulp_paper', group: 'pulp_paper' },
    { tab: 'Gold Peers',         sector: 'gold',       group: 'mining' },
  ];
  // nome (no arquivo) → yahoo_symbol da Market. SÓ peers não-cobertos com cotação.
  const SG_PEER_SYMBOLS = [
    { re: /nucor/i, sym: 'NUE' }, { re: /steel dynamics/i, sym: 'STLD' }, { re: /commercial metal/i, sym: 'CMC' },
    { re: /arcelormittal/i, sym: 'MT' }, { re: /^cap\b/i, sym: 'CAP.SN' },
    { re: /buenaventura/i, sym: 'BVN' }, { re: /\bbhp\b/i, sym: 'BHP' }, { re: /rio tinto/i, sym: 'RIO' },
    { re: /anglo american/i, sym: 'AAL.L' }, { re: /fortescue/i, sym: 'FMG.AX' },
    { re: /international pa/i, sym: 'IP' }, { re: /smurfit/i, sym: 'SW' }, { re: /^upm/i, sym: 'UPM.HE' }, { re: /stora enso/i, sym: 'STERV.HE' },
    { re: /aris mining/i, sym: 'ARIS' }, { re: /hochschild/i, sym: 'HOC.L' }, { re: /agnico/i, sym: 'AEM' }, { re: /barrick/i, sym: 'B' },
  ];
  function _peerSymbol(name) {
    const s = String(name || '').trim(); if (!s) return null;
    for (const m of SG_PEER_SYMBOLS) if (m.re.test(s)) return m.sym;
    return null;
  }

  function parseStockGuidePeers(wb) {
    const X = root.XLSX;
    if (!X || !wb || !wb.SheetNames) return { rows: [], warnings: ['SheetJS/arquivo inválido.'] };
    const covered = new Set(SG_COVERAGE.map(function (c) { return c.yahoo; }));
    const rows = [], warnings = [], seen = new Set();
    SG_PEER_TABS.forEach(function (meta) {
      const nm = wb.SheetNames.find(function (s) { return s.trim().toLowerCase() === meta.tab.toLowerCase(); });
      if (!nm) { warnings.push('aba ausente: ' + meta.tab); return; }
      const aoa = X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: true });
      // linha-cabeçalho = a que contém "EV/EBITDA"
      const hdr = _sgFindCell(aoa, /^ev\s*\/\s*ebitda/i);
      if (!hdr) { warnings.push(meta.tab + ': cabeçalho EV/EBITDA não encontrado'); return; }
      const hr = hdr.r, yr = hr + 1;                       // rótulos em hr; 26E/27E na linha hr+1
      const colOf = function (re) { const f = _sgFindCell([aoa[hr]], re); return f ? f.c : -1; };
      const cCol = colOf(/^company/i), ctryCol = colOf(/^country/i), pxCol = colOf(/^price/i),
            shCol = colOf(/^shares\s+outstanding/i), mcCol = colOf(/^mkt\s*cap/i);
      const evbCol = hdr.c, ndeCol = colOf(/^net\s+debt\s*\/\s*ebitda/i),
            peCol = colOf(/^p\s*\/\s*e\b/i), pceCol = colOf(/^p\s*\/\s*ce/i), dyCol = colOf(/^dividend\s+yield/i);
      if (cCol < 0) { warnings.push(meta.tab + ': coluna Company não encontrada'); return; }
      const at = function (row, col) { return col >= 0 ? _sgCellNum(row[col]) : null; };
      for (let r = yr + 1; r < aoa.length; r++) {
        const row = aoa[r]; if (!row) continue;
        const name = row[cCol], country = ctryCol >= 0 ? row[ctryCol] : null;
        if (name == null || String(name).trim() === '') continue;
        if (country == null || String(country).trim() === '') continue;   // pula linhas de REGIÃO (sem país)
        const sym = _peerSymbol(name);
        if (!sym || covered.has(sym) || seen.has(sym)) continue;            // só Market, não-coberto, sem duplicar
        seen.add(sym);
        rows.push({
          company: String(name).trim(), country: String(country).trim(),
          sector: meta.sector, group: meta.group, yahoo_symbol: sym,
          mkt_cap_usd: at(row, mcCol), price_snapshot: at(row, pxCol), shares: at(row, shCol),
          ev_ebitda_y1: at(row, evbCol), ev_ebitda_y2: evbCol >= 0 ? _sgCellNum(row[evbCol + 1]) : null,
          net_debt_ebitda_y1: at(row, ndeCol), net_debt_ebitda_y2: ndeCol >= 0 ? _sgCellNum(row[ndeCol + 1]) : null,
          pe_y1: at(row, peCol), pe_y2: peCol >= 0 ? _sgCellNum(row[peCol + 1]) : null,
          pce_y1: at(row, pceCol), pce_y2: pceCol >= 0 ? _sgCellNum(row[pceCol + 1]) : null,
          div_yield_y1: at(row, dyCol), div_yield_y2: dyCol >= 0 ? _sgCellNum(row[dyCol + 1]) : null,
          display_order: rows.length + 1,
        });
      }
    });
    return { rows: rows, warnings: warnings };
  }

  // ══════════ TABELAS PUBLICADAS DO ANALISTA (definition.kind==='sens2d') ══════════
  // São as grades 9×9 que o analista publica no próprio modelo (_Sensitivity.xlsx): dois
  // drivers nos eixos, um indicador por tabela. O cliente NÃO mexe nelas — o que muda é o
  // PREÇO DE TELA. EBITDA e FCF não dependem do preço da ação; múltiplos e yields dependem,
  // e foram calculados com o preço do dia da publicação. Aqui são reescritos no de agora.
  //
  // A chave é separar, em cada célula, valor de mercado de dívida líquida dentro do EV.
  // Isso não está escrito na planilha, mas sai dos próprios números publicados:
  //   mktcapModel = FCF ÷ FCF yield      (constante nas 81 células — conferido nas 7 empresas)
  //   dívida      = EV/EBITDA × EBITDA − mktcapModel
  // Daí EV/EBITDA ao vivo = (mktcapLive + dívida) ÷ EBITDA.
  // Unidades e casas COPIADAS do formato de numero que o analista usa no Excel, p/ a tela
  // sair igual ao arquivo: #,##0 no EBITDA/FCF, #,##0.0"x" no EV/EBITDA, 0.0% nos yields,
  // 0% no upside e #,##0.00"x" no P/NAV. O "x" e a letra minuscula mesmo, como no Excel.
  const SENS2D_METRICS = {
    ebitda:     { live: false, unit: '',  dec: 0 },
    fcf:        { live: false, unit: '',  dec: 0 },
    margin:     { live: false, unit: '%', dec: 1 },
    ev_ebitda:  { live: true,  unit: 'x', dec: 1 },
    fcf_yield:  { live: true,  unit: '%', dec: 1 },
    div_yield:  { live: true,  unit: '%', dec: 1 },
    upside:     { live: true,  unit: '%', dec: 0 },
    p_nav:      { live: true,  unit: 'x', dec: 2 },
  };

  // classifica a tabela pelo TÍTULO que o analista escreveu. A ORDEM importa: "FCF Yield"
  // tem de ser testado antes de "FCF", e "EV/EBITDA" antes de "EBITDA".
  function sens2dMetricFromTitle(title) {
    const t = String(title == null ? '' : title).toLowerCase();
    const has = function (s) { return t.indexOf(s) >= 0; };
    if (has('p/nav') || has('p / nav')) return 'p_nav';
    if (has('upside')) return 'upside';
    if (has('dividend yield')) return 'div_yield';
    if (has('fcf yield')) return 'fcf_yield';
    if (has('ev/ebitda')) return 'ev_ebitda';
    if (has('margin')) return 'margin';
    if (has('fcf') || has('free cash')) return 'fcf';
    if (has('ebitda')) return 'ebitda';
    return null;
  }

  // moeda a partir do título: "(BRL million)" / "(USD million)"
  function sens2dCurrencyFromTitle(title) {
    const t = String(title == null ? '' : title).toUpperCase();
    if (t.indexOf('BRL') >= 0) return 'BRL';
    if (t.indexOf('USD') >= 0) return 'USD';
    return null;
  }

  // valor de UMA célula no preço de tela.
  //   metric      — chave de SENS2D_METRICS
  //   published   — número como está na planilha
  //   ebitda      — EBITDA da MESMA célula (só p/ ev_ebitda)
  //   mktcapModel — valor de mercado embutido no modelo (FCF÷FCFy)
  //   mktcapLive  — valor de mercado agora, na MESMA moeda
  // Sem preço ao vivo devolve o publicado: a tabela nunca fica vazia.
  function sens2dLiveValue(o) {
    o = o || {};
    const m = SENS2D_METRICS[o.metric];
    const pub = toNumOrNull(o.published);
    if (!m || pub == null) return pub;
    if (!m.live) return pub;
    const mcM = toNumOrNull(o.mktcapModel), mcL = toNumOrNull(o.mktcapLive);
    if (mcM == null || mcL == null || mcM <= 0 || mcL <= 0) return pub;
    if (o.metric === 'ev_ebitda') {
      const eb = toNumOrNull(o.ebitda);
      if (eb == null || eb === 0) return null;   // sem o EBITDA pareado não dá p/ separar a dívida
      return (mcL + (pub * eb - mcM)) / eb;
    }
    if (o.metric === 'fcf_yield' || o.metric === 'div_yield') return pub * (mcM / mcL);
    if (o.metric === 'upside') return (1 + pub) * (mcM / mcL) - 1;
    if (o.metric === 'p_nav') return pub * (mcL / mcM);
    return pub;
  }

  // dívida líquida implícita da célula (auditoria)
  function sens2dNetDebt(evEbitda, ebitda, mktcapModel) {
    const v = toNumOrNull(evEbitda), eb = toNumOrNull(ebitda), mc = toNumOrNull(mktcapModel);
    if (v == null || eb == null || mc == null) return null;
    return v * eb - mc;
  }

  function sens2dFormat(v, metric, numLoc) {
    const m = SENS2D_METRICS[metric] || { unit: '', dec: 0 };
    if (v == null || !isFinite(v)) return '–';
    const loc = numLoc || 'en-US';
    const opt = { minimumFractionDigits: m.dec, maximumFractionDigits: m.dec };
    if (m.unit === '%') return (v * 100).toLocaleString(loc, opt) + '%';
    if (m.unit === 'x') return v.toLocaleString(loc, opt) + 'x';
    return v.toLocaleString(loc, opt);
  }

  // Eixos de CRESCIMENTO vêm como fração (-0,085) e têm de aparecer como -8,5%; eixos de
  // PREÇO vêm em nível (87,5 / 8789) e aparecem como número.
  function sens2dAxisIsPct(label, levels) {
    const L = String(label == null ? '' : label).toLowerCase();
    if (L.indexOf('(%)') >= 0 || L.indexOf('growth') >= 0 || L.indexOf('margin') >= 0) return true;
    const ls = (levels || []).filter(function (x) { return typeof x === 'number'; });
    if (!ls.length) return false;
    return ls.every(function (x) { return Math.abs(x) <= 1.5; }) &&
           ls.some(function (x) { return x !== Math.round(x); });
  }
  // Casas decimais do EIXO INTEIRO, nao de cada valor: pela regra por valor um eixo de
  // minerio 87,5..107,5 saia "87.5, 90, 92.5, 95, 97.5, 100, 103, 105, 108" — os niveis
  // grandes perdiam a casa e passavam a MENTIR (102,5 virando 103).
  // O criterio e FIDELIDADE, nao distincao: usa-se o menor numero de casas que ainda
  // representa TODOS os niveis sem arredondar, com teto (o eixo de cambio tem 5.03125 e
  // nao faz sentido mostrar 5 casas).
  function sens2dAxisDecimals(levels, isPct) {
    const ls = (levels || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (!ls.length) return isPct ? 1 : 0;
    const cap = isPct ? 1 : 2;
    let need = 0;
    for (let i = 0; i < ls.length; i++) {
      const v = isPct ? ls[i] * 100 : ls[i];
      const tol = 1e-6 * Math.max(1, Math.abs(v));
      let d = 0;
      for (; d < cap; d++) {
        const p = Math.pow(10, d);
        if (Math.abs(v * p - Math.round(v * p)) < tol * p) break;
      }
      if (d > need) need = d;
    }
    return need;
  }
  function sens2dAxisFormat(v, isPct, numLoc, dec) {
    if (v == null || !isFinite(v)) return '';
    const loc = numLoc || 'en-US';
    let d = dec;
    if (d == null) { const abs = Math.abs(v); d = isPct ? 1 : (abs >= 100 ? 0 : (abs >= 10 ? 1 : 2)); }
    const opt = { minimumFractionDigits: d, maximumFractionDigits: d };
    if (isPct) return (v * 100).toLocaleString(loc, opt) + '%';
    return v.toLocaleString(loc, opt);
  }

  const SG = {
    sens2dMetricFromTitle: sens2dMetricFromTitle,
    sens2dCurrencyFromTitle: sens2dCurrencyFromTitle,
    sens2dLiveValue: sens2dLiveValue,
    sens2dNetDebt: sens2dNetDebt,
    sens2dFormat: sens2dFormat,
    sens2dAxisIsPct: sens2dAxisIsPct,
    sens2dAxisDecimals: sens2dAxisDecimals,
    sens2dAxisFormat: sens2dAxisFormat,
    SENS2D_METRICS: SENS2D_METRICS,
    toNumOrNull: toNumOrNull,
    SG_COVERAGE: SG_COVERAGE,
    parseStockGuideWorkbook: parseStockGuideWorkbook,
    parseStockGuidePeers: parseStockGuidePeers,
    parseSGFXRates: parseSGFXRates,
    MARKET_DRIVER_CATALOG: MARKET_DRIVER_CATALOG,
    MARKET_DRIVER_CATALOG_BY_KEY: MARKET_DRIVER_CATALOG_BY_KEY,
    isDynamicSource: isDynamicSource,
    resolveDriverValue: resolveDriverValue,
    buildGridMesh: buildGridMesh,
    buildGridMeshFromDense: buildGridMeshFromDense,
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
