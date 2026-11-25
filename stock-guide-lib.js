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
    // ⚠️ SAO DUAS SERIES DIFERENTES e a diferenca e material (61% 99,70 x 62% 95,84 em 31/08/2026):
    // `IRON_ORE` = IO Fines 61% da Platts, que e o eixo que os analistas publicam (Vale e CMIN
    // escrevem "Iron Ore 61%" na propria planilha); `IRON_ORE_62` = 62% CFR China (Trading
    // Economics), que a aba Market usa. A chave dizia 62 e lia 61 — armadilha corrigida.
    { key: 'iron_ore_61',  label: 'Iron ore fines 61% (Platts)', unit: 'USD/t', src: { table: 'commodities', code: 'IRON_ORE' } },
    { key: 'iron_ore_62',  label: 'Iron ore 62% Fe CFR China',   unit: 'USD/t', src: { table: 'commodities', code: 'IRON_ORE_62' } },
    { key: 'hrc_china',    label: 'HRC China (Platts)',       unit: 'USD/t',   src: { table: 'commodities', code: 'HRC_CHINA' } },
    { key: 'rebar_turkey', label: 'Rebar Turkey (Platts)',    unit: 'USD/t',   src: { table: 'commodities', code: 'REBAR_TURKEY' } },
    { key: 'met_coal',     label: 'Met coal (Platts)',        unit: 'USD/t',   src: { table: 'commodities', code: 'MET_COAL' } },
    { key: 'copper',       label: 'Copper (LME proxy)',       unit: 'USD/lb',  src: { table: 'commodities', code: 'COPPER' } },
    { key: 'gold',         label: 'Gold',                     unit: 'USD/oz',  src: { table: 'commodities', code: 'GOLD' } },
    // Celulose (assessment PIX/Fastmarkets, semanal): os indices NET da China, que sao os
    // que conversam com o eixo "Net Price" dos modelos de Suzano/Klabin. Os precos de
    // RESALE e os da Europa ficam de fora do catalogo de propósito: resale e' preco de
    // revenda no mercado domestico chines e a Europa e' preco de LISTA (bruto) — nenhum
    // dos dois e' o preco liquido realizado que o eixo do analista pede.
    { key: 'pulp_bhkp_china', label: 'BHKP China net (PIX)', unit: 'USD/t',   src: { table: 'commodities', code: 'PULP_BHKP_CHINA' } },
    { key: 'pulp_nbsk_china', label: 'NBSK China net (PIX)', unit: 'USD/t',   src: { table: 'commodities', code: 'PULP_NBSK_CHINA' } },
    { key: 'fx_usdbrl',    label: 'USD/BRL',                  unit: 'BRL/USD', src: { table: 'macro',       code: 'USD_BRL' } },
    // 2026-11-11: as tabelas da CMPC e da Copec trouxeram dois eixos novos — "Average FX 2027
    // (CLP/USD)" (peso chileno por dólar, ~890) e "Average Brent Prices 2027 (USD/bbl)". As duas
    // séries já estavam no banco (macro USD_CLP e commodities BRENT); sem elas no catálogo o eixo
    // de Brent ficava sem leitura e o de CLP lia o USD/BRL (5,5) num eixo que nem é de real.
    { key: 'fx_usdclp',    label: 'USD/CLP',                  unit: 'CLP/USD', src: { table: 'macro',       code: 'USD_CLP' } },
    { key: 'brent',        label: 'Brent',                    unit: 'USD/bbl', src: { table: 'commodities', code: 'BRENT' } },
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
  // Contrato: admin/STOCK_GUIDE_UPLOAD_CONTRACT.md. Lê as 20 abas de empresa cobertas (14 + Aclara/Viridis desde 06/11/2026
  // + Capstone/Ero/Hudbay/Lundin — cobre, cobertas desde 23/11/2026, abas no Stock Guide desde a planilha "2027" de 24/11)
  // (CBA/Cement FORA) e devolve linhas prontas p/ admin_bulk_upsert_stock_guide_companies.
  // Detecção DINÂMICA (os 2 anos-estimativa saem do cabeçalho da aba Summary — 26E/27E até nov/2026, 27E/28E na
  // planilha "2027" — e os rótulos são achados por varredura) → imune a inserção de linhas/colunas e à virada de ano.
  // Múltiplos NÃO são lidos — são recalculados ao vivo na página.
  //
  // `base_ccy` = moeda das ESTIMATIVAS (EBITDA, dívida, lucro…). É DECLARADA aqui (é um fato da empresa: a Hudbay
  // reporta em US$) e não deduzida da planilha, porque a dedução dependia da linha "Market Capitalization" da aba,
  // que falhou de dois jeitos: vínculo da Bloomberg em #N/A/#DIV/0! (GMEX/CMPC/Copec em 05/11 → EV/EBITDA de 2.000x
  // no ar; Grupo México/Aclara/Viridis de novo na planilha "2027") e, nas 4 de cobre, o market cap em C$ rotulado
  // "USD" (preço em C$ × ações). A linha da aba agora só é CONFERIDA (aviso no /admin quando não bate).
  // Ordem = a da Summary (Iron Ore · Copper · Gold …) → vira o display_order da comp table.
  const SG_COVERAGE = [
    { tab:'VALE',            ticker:'VALE',     yahoo:'VALE',        name:'Vale',            sector:'iron_ore',   group:'mining',     trade_ccy:'USD', base_ccy:'USD' },  // VALE US (NYSE, US$) — NÃO a VALE3: o TP do analista é o US$/ADR do DCF; a aba traz VALE3 (R$) à esquerda e VALE (US$) à direita
    { tab:'CSN MINERACAO',   ticker:'CMIN3',    yahoo:'CMIN3.SA',    name:'CSN Mineração',   sector:'iron_ore',   group:'mining',     trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'GRUPO MEXICO',    ticker:'GMEXICOB', yahoo:'GMEXICOB.MX', name:'Grupo México',    sector:'copper',     group:'mining',     trade_ccy:'MXN', base_ccy:'USD' },
    { tab:'SOUTHERN COPPER', ticker:'SCCO',     yahoo:'SCCO',        name:'Southern Copper', sector:'copper',     group:'mining',     trade_ccy:'USD', base_ccy:'USD' },
    // Cobre (cobertura formal desde 23/11/2026; abas no Stock Guide desde a planilha "2027"). Linhas = as do heatmap:
    // as quatro por Toronto, preço e alvo em C$ (alvos de início: CS 15, ERO 50, HBM 44, LUN 29); estimativas em US$
    // (as quatro reportam em US$). `alt` = outros nomes aceitos para a aba. `optional`: planilha antiga sem as
    // abas sobe com AVISO em vez de travar as outras.
    { tab:'CAPSTONE COPPER', alt:['CAPSTONE'],         ticker:'CS',  yahoo:'CS.TO',  name:'Capstone Copper', sector:'copper', group:'mining', trade_ccy:'CAD', base_ccy:'USD', optional:true },
    { tab:'ERO COPPER',      alt:['ERO'],              ticker:'ERO', yahoo:'ERO.TO', name:'Ero Copper',      sector:'copper', group:'mining', trade_ccy:'CAD', base_ccy:'USD', optional:true },
    { tab:'HUDBAY',          alt:['HUDBAY MINERALS'],  ticker:'HBM', yahoo:'HBM.TO', name:'Hudbay Minerals', sector:'copper', group:'mining', trade_ccy:'CAD', base_ccy:'USD', optional:true },
    { tab:'LUNDIN MINING',   alt:['LUNDIN'],           ticker:'LUN', yahoo:'LUN.TO', name:'Lundin Mining',   sector:'copper', group:'mining', trade_ccy:'CAD', base_ccy:'USD', optional:true },
    { tab:'AURA',            ticker:'AUGO',     yahoo:'AUGO',        name:'Aura',            sector:'gold',       group:'mining',     trade_ccy:'USD', base_ccy:'USD' },  // AUGO (Nasdaq, US$) é o ticker do Stock Guide — NÃO o BDR AURA33 (negocia em R$): o modelo lista preço/mktcap na linha AUGO
    { tab:'CSN',             ticker:'CSNA3',    yahoo:'CSNA3.SA',    name:'CSN',             sector:'steel',      group:'steel',      trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'GERDAU',          ticker:'GGBR4',    yahoo:'GGBR4.SA',    name:'Gerdau',          sector:'steel',      group:'steel',      trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'TERNIUM',         ticker:'TX',       yahoo:'TX',          name:'Ternium',         sector:'steel',      group:'steel',      trade_ccy:'USD', base_ccy:'USD' },
    { tab:'USIMINAS',        ticker:'USIM5',    yahoo:'USIM5.SA',    name:'Usiminas',        sector:'steel',      group:'steel',      trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'SUZANO',          ticker:'SUZB3',    yahoo:'SUZB3.SA',    name:'Suzano',          sector:'pulp_paper', group:'pulp_paper', trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'KLABIN',          ticker:'KLBN11',   yahoo:'KLBN11.SA',   name:'Klabin',          sector:'pulp_paper', group:'pulp_paper', trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'IRANI',           ticker:'RANI3',    yahoo:'RANI3.SA',    name:'Irani',           sector:'pulp_paper', group:'pulp_paper', trade_ccy:'BRL', base_ccy:'BRL' },
    { tab:'CMPC',            ticker:'CMPC',     yahoo:'CMPC.SN',     name:'CMPC',            sector:'pulp_paper', group:'pulp_paper', trade_ccy:'CLP', base_ccy:'USD' },
    { tab:'COPEC',           ticker:'COPEC',    yahoo:'COPEC.SN',    name:'Copec',           sector:'pulp_paper', group:'pulp_paper', trade_ccy:'CLP', base_ccy:'USD' },
    // Terras raras (cobertura formal desde 23/10/2026; abas novas no Stock Guide em 06/11/2026). Mesmo modelo de
    // aba das outras; o bloco da esquerda traz o ticker com o sufixo da bolsa ("ARA.TO"/"VMM.AX") e preço/alvo em
    // C$/A$, e as estimativas em US$ (base = USD). Chaves ARA/VMM = as do histórico de recomendações.
    { tab:'ACLARA',          ticker:'ARA',      yahoo:'ARA.TO',      name:'Aclara Resources', sector:'rare_earths', group:'rare_earths', trade_ccy:'CAD', base_ccy:'USD', optional:true },
    { tab:'VIRIDIS',         ticker:'VMM',      yahoo:'VMM.AX',      name:'Viridis Mining',   sector:'rare_earths', group:'rare_earths', trade_ccy:'AUD', base_ccy:'USD', optional:true },
  ];
  function _sgFindTab(wb, meta) {
    const want = [meta.tab].concat(meta.alt || []).map(function (t) { return t.toLowerCase(); });
    return wb.SheetNames.find(function (s) { return want.indexOf(s.trim().toLowerCase()) >= 0; });
  }

  // Ticker que mudou de linha (antigo → novo). O ticker é a CHAVE da empresa no banco: sem renomear antes,
  // gravar a planilha criaria uma 2ª Vale. O /admin renomeia sozinho (admin_rename_stock_guide_company,
  // que leva junto sensibilidades e mesh) antes de gravar. AURA33→AUGO já foi feito em SQL.
  const SG_TICKER_RENAMES = { VALE3: 'VALE' };

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
  // célula de DATA → 'YYYY-MM-DD' (ou null). O /admin lê o .xlsm com cellDates:true → vem um Date; sem
  // isso vem o serial do Excel. Texto também vale: 'DD/MM/YYYY' (é o que o rótulo da planilha pede) e
  // 'YYYY-MM-DD'. No Date, +12h antes de ler dia/mês/ano: o SheetJS pode entregar a meia-noite em UTC ou
  // no fuso local, e as duas caem no MESMO dia assim (sem o +12h, a de UTC vira a véspera no Brasil).
  function _sgCellDate(v) {
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const ok = function (y, m, d) {
      if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCMonth() !== m - 1) return null;            // 30/02 não existe
      return y + '-' + pad(m) + '-' + pad(d);
    };
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      const t = new Date(v.getTime() + 12 * 3600 * 1000);
      return ok(t.getFullYear(), t.getMonth() + 1, t.getDate());
    }
    if (typeof v === 'number' && v > 30000 && v < 80000) {      // serial do Excel (1982…2119)
      const t = new Date(Math.round((v - 25569) * 86400000));
      return ok(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    if (typeof v === 'string') {
      const s = v.trim(); let m;
      if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return ok(+m[1], +m[2], +m[3]);
      if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return ok(+m[3], +m[2], +m[1]);
    }
    return null;
  }
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

  // câmbio do modelo (aba "Stock Guide"): rótulos "BRL/USD"/"CLP/USD"/"CAD/USD"/"AUD/USD"... → taxa (unidades por USD).
  // ⚠️ A planilha não segue uma convenção só: "BRL/USD" 5,90 e "CAD/USD" 1,43 são unidades por US$, mas "AUD/USD"
  // 0,66 é US$ por A$ (a cotação de mercado AUDUSD). Todas as moedas desta lista valem MENOS que o dólar, então
  // "unidades por US$" é sempre > 1: um valor < 1 só pode estar ao contrário e é invertido. (Não incluir aqui moeda
  // mais forte que o dólar — EUR, GBP — sem rever essa regra.)
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
        const m = typeof v === 'string' ? v.trim().match(/^(BRL|CLP|MXN|PEN|COP|ARS|CAD|AUD)\s*\/\s*USD$/i) : null;
        if (m) {
          const ccy = m[1].toUpperCase();
          for (let rr = r + 1; rr < aoa.length; rr++) {        // 1º numérico ABAIXO do rótulo, na mesma coluna
            const cand = aoa[rr] && aoa[rr][c];
            if (_isNum(cand) && cand > 0) { rates[ccy] = cand < 1 ? 1 / cand : cand; break; }
          }
        }
      }
    }
    return rates;
  }

  // Os 2 anos-estimativa da comp table = os que a aba Summary mostra (cabeçalho "27E"/"28E" logo abaixo de
  // "EV/EBITDA (x)") → {y1:'2027E', y2:'2028E'}. A planilha "2027" (24/11/2026) rolou os anos de 26E/27E para
  // 27E/28E: a dash segue o arquivo, sem ano fixo no código. Sem a Summary legível → 2026E/2027E (planilhas antigas).
  function _sgYearLabel(v) {
    const s = String(v == null ? '' : v).trim();
    let m = s.match(/^(\d{2})E$/i); if (m) return '20' + m[1] + 'E';
    m = s.match(/^(20\d{2})E$/i); if (m) return m[1] + 'E';
    return null;
  }
  function detectStockGuideYears(wb) {
    const X = root.XLSX;
    const nm = wb && wb.SheetNames && wb.SheetNames.find(function (s) { return s.trim().toLowerCase() === 'summary'; });
    if (X && nm) {
      const aoa = X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: true });
      const f = _sgFindCell(aoa, /^ev\s*\/\s*ebitda/i);
      if (f) {
        const row = aoa[f.r + 1] || [];
        const a = _sgYearLabel(row[f.c]), b = _sgYearLabel(row[f.c + 1]);
        if (a && b && +b.slice(0, 4) === +a.slice(0, 4) + 1) return { y1: a, y2: b, source: 'Summary' };
      }
    }
    return { y1: '2026E', y2: '2027E', source: null };
  }
  // 'US$'/'USD'/'R$'/'BRL'… no parêntese do rótulo ("EBITDA (USD m)") → código da moeda (ou null)
  function _sgUnitCcy(label) {
    const m = String(label || '').match(/\(\s*(US\$|USD|R\$|BRL|MXN|CLP|CAD|C\$|AUD|A\$|PEN|COP|ARS)/i);
    if (!m) return null;
    const u = m[1].toUpperCase();
    return ({ 'US$': 'USD', 'R$': 'BRL', 'C$': 'CAD', 'A$': 'AUD' })[u] || u;
  }

  // parse de UMA aba de empresa (aoa) + meta + fx → linha p/ o bulk RPC (ou {error}).
  function _sgParseCompanyAoa(aoa, meta, fxRates, years) {
    const warnings = [];
    years = years || { y1: '2026E', y2: '2027E' };
    const Y1 = String(years.y1).toUpperCase(), Y2 = String(years.y2).toUpperCase();
    // colunas dos anos-estimativa (os da Summary: 2027E / 2028E na planilha "2027") — mesma linha
    let y1 = -1, y2 = -1;
    for (let r = 0; r < aoa.length && (y1 < 0 || y2 < 0); r++) {
      const row = aoa[r] || []; let i1 = -1, i2 = -1;
      for (let c = 0; c < row.length; c++) {
        const s = (typeof row[c] === 'string') ? row[c].trim().toUpperCase() : '';
        if (s === Y1) i1 = c; if (s === Y2) i2 = c;
      }
      if (i1 >= 0 && i2 >= 0) { y1 = i1; y2 = i2; break; }
    }
    if (y1 < 0 || y2 < 0) return { error: meta.tab + ': não encontrei as colunas ' + years.y1 + '/' + years.y2 };

    // helpers ligados a este aoa
    const hNum = function (re) { const f = _sgFindCell(aoa, re, function (row, c) { return _sgCellNum(row[c + 1]) != null; }); return f ? _sgCellNum(aoa[f.r][f.c + 1]) : null; };  // aceita número-como-texto ("1,110")
    const hTxt = function (re) { const f = _sgFindCell(aoa, re, function (row, c) { return row[c + 1] != null && String(row[c + 1]).trim() !== ''; }); return f ? String(aoa[f.r][f.c + 1]).trim() : null; };
    const est  = function (re) { const f = _sgFindCell(aoa, re); return f ? { y1: _sgCellNum(aoa[f.r][y1]), y2: _sgCellNum(aoa[f.r][y2]), label: aoa[f.r][f.c] } : { y1: null, y2: null, label: null }; };
    // market cap da linha "Market Capitaliz" do bloco-série (numérica na coluna do ano) — só CONFERÊNCIA da moeda
    const mcF = _sgFindCell(aoa, /^market\s+capitaliz/i, function (row) { return _isNum(row[y1]); });
    const mcBase = mcF ? _sgCellNum(aoa[mcF.r][y1]) : null;

    // A aba traz DOIS blocos lado a lado (ex.: Vale = VALE3 em R$ | VALE em US$). Preço e TP
    // saem do bloco cujo "Stock Ticker" é o do Stock Guide; sem bloco casado (GMEX, "CMPC CI"…),
    // o 1º, como sempre. No bloco da direita o valor fica 2 colunas depois do rótulo.
    const blk = (function () {
      for (let r = 0; r < aoa.length; r++) {
        const row = aoa[r] || [];
        for (let c = 0; c < row.length; c++) {
          if (typeof row[c] !== 'string' || !/^stock\s+ticker/i.test(row[c].trim())) continue;
          for (let k = 1; k <= 2; k++) {
            const v = row[c + k];
            if (typeof v === 'string' && v.trim().toUpperCase() === meta.ticker) return { r: r, c: c, vc: c + k };
          }
        }
      }
      return null;
    })();
    const blkNum = function (re) {
      for (let r = blk.r; r < Math.min(aoa.length, blk.r + 8); r++) {
        const row = aoa[r] || [];
        if (typeof row[blk.c] === 'string' && re.test(row[blk.c].trim())) return _sgCellNum(row[blk.vc]);
      }
      return null;
    };
    const shares = hNum(/^shares\s+outstanding/i);
    const priceLocal = blk ? blkNum(/^share\s+price/i) : hNum(/^share\s+price/i);   // 1ª = moeda de negociação
    const target = blk ? blkNum(/^target\s+price/i) : hNum(/^target\s+price/i);
    const rec = (function () { const t = hTxt(/^analyst\s+recommend/i); return /^(OP|MP|UP)$/i.test(t || '') ? t.toUpperCase() : null; })();
    // Data da última atualização do modelo: "Last Model Update Release (DD/MM/YEAR):" em B2, com a data
    // algumas colunas à direita (E2). Vira o `last_update` da empresa — a âncora do "Since last update" da
    // aba Market e a data do evento no histórico de recomendações (gatilho sg_capture_rating no banco).
    // Sem ela o upload segue (aviso abaixo), mas o histórico não ganha evento: data inventada não entra.
    const lastUpdate = (function () {
      const f = _sgFindCell(aoa, /^last\s+model\s+update/i); if (!f) return null;
      const row = aoa[f.r] || [];
      for (let c = f.c + 1; c < Math.min(row.length, f.c + 10); c++) { const d = _sgCellDate(row[c]); if (d) return d; }
      return null;
    })();
    if (!lastUpdate) warnings.push(meta.tab + ': data da última atualização (Last Model Update Release) não lida');

    // EBITDA = o DENOMINADOR DO EV/EBITDA da própria aba: "Adjusted EBITDA" (Vale: "Proforma EBITDA"), linha 20 do
    // bloco-série — o EV/EBITDA (x) da aba é EV Adjusted ÷ essa linha nas 20 abas (conferido nas fórmulas em 24/11/2026).
    // Até a planilha "2027" lia-se a linha "EBITDA (" (25), igual na maioria mas não em Gerdau (−0,5%, minoritários),
    // Capstone e Ero (~2%): o EV/EBITDA da dash saía uma casa decimal diferente da Summary. O Net Debt/EBITDA da aba
    // divide pela linha 25; com a 20 ele muda menos do que a casa decimal exibida nessas três.
    const ebAdj = est(/^(adjusted|proforma)\s+ebitda/i);
    const ebitda = (_isNum(ebAdj.y1) || _isNum(ebAdj.y2)) ? ebAdj : est(/^ebitda\s*\(/i);
    const netDebt = est(/^net\s+debt\s*\(/i);              // exclui "Net Debt/EBITDA (x)"
    const netInc = est(/^net\s+income\s*\(/i);
    const ocf = est(/^ocf\s*\(/i);                          // exclui "OCF Yield (%)"
    const capex = est(/^capex\s*\(/i);
    const netRev = est(/^net\s+revenues\s*\(/i);
    const cashE = est(/^cash\s+earnings/i);
    const divs = est(/^dividend.*int/i);                    // "Dividends/Int. on Capital" (exclui "Dividend Yield")
    const adj = est(/^adjustment/i);
    // EV QUE O ANALISTA FECHOU NA ABA (25/11/2026). A dash monta o EV ao vivo = valor de mercado de agora + Net Debt +
    // Adjustments, e a linha "EV Adjusted" da aba costuma ser exatamente essa soma (linhas 16 a 18 do bloco-série).
    // Quando o analista põe no EV algo que não está em "Adjustments" — a Ero passou a puxar o EV do modelo, que soma o
    // projeto Furnas — o que sobra (EV Adjusted − Market Cap − Net Debt) vira o ajuste: sem isso a comp table ignorava
    // o item (2,9× na dash contra 5,0× na Summary). Diferença de até meio milhão é arredondamento e não conta.
    const evAdj = est(/^ev\s+adjusted/i);
    const mcSerie = mcF ? { y1: _sgCellNum(aoa[mcF.r][y1]), y2: _sgCellNum(aoa[mcF.r][y2]) } : { y1: null, y2: null };
    ['y1', 'y2'].forEach(function (k) {
      if (!_isNum(evAdj[k]) || !_isNum(mcSerie[k]) || !_isNum(netDebt[k])) return;
      const resto = evAdj[k] - mcSerie[k] - netDebt[k];
      const lido = _isNum(adj[k]) ? adj[k] : 0;
      if (Math.abs(resto - lido) <= 0.5) return;
      warnings.push(meta.tab + ': o "EV Adjusted" de ' + years[k] + ' tem ' + (Math.round((resto - lido) * 10) / 10) +
        ' além de valor de mercado + dívida + ajustes — a dash soma isso ao EV (ajuste ' + (Math.round(resto * 10) / 10) + ')');
      adj[k] = resto;
    });
    // dividendo PAGO é sempre ≥ 0 num yield; a aba LUNDIN (planilha "2027") traz o valor do fluxo de caixa com o sinal
    // de saída (−215) e a Summary mostra yield negativo. Usa o valor absoluto e avisa (consertar a aba: "*-1", como a HUDBAY).
    ['y1', 'y2'].forEach(function (k) {
      if (_isNum(divs[k]) && divs[k] < 0) {
        if (!divs.flipped) warnings.push(meta.tab + ': dividendos com sinal negativo na planilha (' + (Math.round(divs[k] * 10) / 10) + ') — usei o valor absoluto; na aba, a linha "Dividends" precisa de "*-1"');
        divs.flipped = true; divs[k] = -divs[k];
      }
    });

    // ── MOEDA (blindada em 24/11/2026) ──
    // base = moeda das estimativas, DECLARADA no SG_COVERAGE. fx_to_base = moeda-base por unidade da moeda de
    // negociação, do câmbio da aba "Stock Guide" (o mesmo que a Summary usa); sem ele, a razão market cap da aba ÷
    // (preço × ações) quando ela de fato converte. A página usa o câmbio AO VIVO (macro_indicators): este número é
    // o reserva e o que o /admin mostra. O market cap da aba vira CONFERÊNCIA: se não bate com o câmbio, avisa —
    // foi assim que apareceram as 4 de cobre (valor de mercado em C$ com rótulo "USD", múltiplos da própria Summary
    // inflados ~1,4×) e Grupo México/Aclara/Viridis (vínculo da Bloomberg em #N/A/#DIV/0!).
    const baseCcy = meta.base_ccy || meta.trade_ccy;
    const unitCcy = _sgUnitCcy(ebitda.label) || _sgUnitCcy(netDebt.label);
    if (unitCcy && unitCcy !== baseCcy)
      warnings.push(meta.tab + ': a aba diz que as estimativas estão em ' + unitCcy + ', o cadastro da dash diz ' + baseCcy + ' — confira antes de gravar');
    const seriesOk = _isNum(mcBase) && _isNum(priceLocal) && _isNum(shares) && priceLocal * shares !== 0;
    const seriesFx = seriesOk ? mcBase / (priceLocal * shares) : null;
    const mcLabel = mcF ? String(aoa[mcF.r][mcF.c]).trim() : 'Market Capitalization';
    let fxBase = null;
    if (baseCcy === meta.trade_ccy) {
      fxBase = 1;
      if (seriesFx != null && Math.abs(seriesFx - 1) > 0.02)
        warnings.push(meta.tab + ': o valor de mercado da aba ("' + mcLabel + '") não está na moeda do preço (razão ' + seriesFx.toFixed(4) + ') — confira a aba');
    } else {
      const rtTrade = meta.trade_ccy === 'USD' ? 1 : fxRates[meta.trade_ccy];   // unidades da negociação por US$
      const rtBase = baseCcy === 'USD' ? 1 : fxRates[baseCcy];                   // unidades da base por US$
      const sheetFx = (rtTrade > 0 && rtBase > 0) ? rtBase / rtTrade : null;
      if (sheetFx != null) {
        fxBase = sheetFx;
        if (seriesFx != null && Math.abs(seriesFx / sheetFx - 1) > 0.05)
          warnings.push(meta.tab + ': o valor de mercado da aba ("' + mcLabel + '") não bate com o câmbio ' + meta.trade_ccy + '/USD da aba Stock Guide (razão ' + seriesFx.toFixed(4) + ' × câmbio ' + sheetFx.toFixed(4) + ') — a dash usa o câmbio; os múltiplos da própria planilha para esta empresa saem distorcidos');
        else if (seriesFx == null)
          warnings.push(meta.tab + ': valor de mercado da aba vazio (vínculo da Bloomberg em #N/A ou #DIV/0!) — a dash usa o câmbio da aba Stock Guide; na Summary da planilha esta empresa fica sem EV/EBITDA');
      } else if (seriesFx != null && Math.abs(seriesFx - 1) > 0.02) {
        fxBase = seriesFx;
      } else {
        warnings.push(meta.tab + ': sem câmbio ' + meta.trade_ccy + '/USD na planilha — a página usa o câmbio ao vivo; a coluna US$ do /admin fica vazia');
      }
    }
    // fx_to_usd p/ a coluna "Mkt cap US$": negociação em US$ = 1; base US$ = o próprio fx_to_base; base local = 1/(taxa por USD)
    let fxUsd;
    if (meta.trade_ccy === 'USD') fxUsd = 1;
    else if (baseCcy === 'USD') fxUsd = fxBase;
    else { const rt = fxRates[meta.trade_ccy]; fxUsd = (rt && rt > 0) ? 1 / rt : null; if (fxUsd == null) warnings.push(meta.tab + ': sem câmbio ' + meta.trade_ccy + '/USD → Mkt cap US$ indisponível'); }

    if (!_isNum(shares)) warnings.push(meta.tab + ': nº de ações ausente');
    if (!_isNum(ebitda.y1)) warnings.push(meta.tab + ': EBITDA ' + years.y1 + ' ausente');

    return {
      row: {
        ticker: meta.ticker, company_name: meta.name, yahoo_symbol: meta.yahoo,
        sector: meta.sector, trade_ccy: meta.trade_ccy, base_ccy: baseCcy,
        shares_outstanding: shares, target_price: target, recommendation: rec, last_update: lastUpdate,
        net_debt_y1: netDebt.y1, net_debt_y2: netDebt.y2,
        ebitda_y1: ebitda.y1, ebitda_y2: ebitda.y2,
        net_income_y1: netInc.y1, net_income_y2: netInc.y2,
        ocf_y1: ocf.y1, ocf_y2: ocf.y2, capex_y1: capex.y1, capex_y2: capex.y2,
        net_revenues_y1: netRev.y1, net_revenues_y2: netRev.y2,
        cash_earnings_y1: cashE.y1, cash_earnings_y2: cashE.y2,
        dividends_y1: divs.y1, dividends_y2: divs.y2,
        ev_adjustment_y1: adj.y1, ev_adjustment_y2: adj.y2,
        fx_to_base: fxBase == null ? null : Math.round(fxBase * 1e8) / 1e8, fx_to_usd: fxUsd == null ? null : Math.round(fxUsd * 1e8) / 1e8,
      },
      warnings: warnings, priceLocal: priceLocal, mcBase: mcBase,
    };
  }

  // workbook inteiro → {rows, perCompany, warnings, errors, fxRates, years}
  function parseStockGuideWorkbook(wb) {
    const X = root.XLSX;
    if (!X) return { rows: [], perCompany: [], warnings: [], errors: ['SheetJS (XLSX) não carregado.'] };
    if (!wb || !wb.SheetNames) return { rows: [], perCompany: [], warnings: [], errors: ['Arquivo inválido.'] };
    const fxRates = parseSGFXRates(wb);
    const years = detectStockGuideYears(wb);
    const rows = [], perCompany = [], warnings = [], errors = [];
    if (!years.source) warnings.push('anos das estimativas não lidos na aba Summary (cabeçalho do EV/EBITDA) — usei ' + years.y1 + '/' + years.y2);
    SG_COVERAGE.forEach(function (meta, i) {
      const nm = _sgFindTab(wb, meta);
      if (!nm) { (meta.optional ? warnings : errors).push('aba ausente: ' + meta.tab + ' (' + meta.ticker + ')'); return; }
      const aoa = X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: true });
      const res = _sgParseCompanyAoa(aoa, meta, fxRates, years);
      if (res.error) { errors.push(res.error); return; }
      res.row.display_order = i + 1;
      rows.push(res.row);
      perCompany.push({ meta: meta, row: res.row, priceLocal: res.priceLocal, mcBase: res.mcBase });
      res.warnings.forEach(function (w) { warnings.push(w); });
    });
    if (!rows.length) errors.push('Nenhuma empresa lida — confira se é o arquivo "Stock Guide ... .xlsm" certo.');
    return { rows: rows, perCompany: perCompany, warnings: warnings, errors: errors, fxRates: fxRates, years: years };
  }

  // ── 9. GLOBAL PEERS das abas "*Peers" (snapshot dos múltiplos; preço fica AO VIVO na página) ──
  // Só peers que TÊM cotação na aba Market e que NÃO são cobertos (cobertos já estão no comps).
  // Planilha "2027" (24/11/2026): a aba "Mining Peers" virou "Iron Ore Peers" + "Copper Peers" (e chegaram Zinc,
  // Aluminum, Cement e Rare Earths Peers, que não entram: nenhum nome delas tem cotação na Market). `alt` = nome
  // antigo aceito (planilha velha continua subindo). Ordem = prioridade quando o mesmo peer aparece em 2 abas
  // (BHP/Rio/Anglo/Glencore estão em Iron Ore e Copper; a Barrick em Copper e Gold): fica a 1ª. Gold antes de
  // Copper para a Barrick seguir vindo da aba do ouro, como antes. `optional`: ausente não gera aviso.
  const SG_PEER_TABS = [
    { tab: 'Steel Peers',        sector: 'steel',      group: 'steel' },
    { tab: 'Iron Ore Peers',     sector: 'mining',     group: 'mining', alt: ['Mining Peers'] },
    { tab: 'Gold Peers',         sector: 'gold',       group: 'mining' },
    { tab: 'Copper Peers',       sector: 'mining',     group: 'mining', optional: true },
    { tab: 'Pulp & Paper Peers', sector: 'pulp_paper', group: 'pulp_paper' },
  ];
  // nome (no arquivo) → yahoo_symbol da Market. SÓ peers não-cobertos com cotação.
  const SG_PEER_SYMBOLS = [
    { re: /nucor/i, sym: 'NUE' }, { re: /steel dynamics/i, sym: 'STLD' }, { re: /commercial metal/i, sym: 'CMC' },
    { re: /arcelormittal/i, sym: 'MT' }, { re: /^cap\b/i, sym: 'CAP.SN' },
    { re: /buenaventura/i, sym: 'BVN' }, { re: /\bbhp\b/i, sym: 'BHP' }, { re: /rio tinto/i, sym: 'RIO' },
    { re: /anglo american/i, sym: 'AAL.L' }, { re: /fortescue/i, sym: 'FMG.AX' },
    { re: /glencore/i, sym: 'GLEN.L' },                     // Iron Ore + Copper Peers (planilha "2027"); GLEN.L já cotada
    { re: /international pa/i, sym: 'IP' }, { re: /smurfit/i, sym: 'SW' }, { re: /^upm/i, sym: 'UPM.HE' }, { re: /stora enso/i, sym: 'STERV.HE' },
    { re: /aris mining/i, sym: 'ARIS' }, { re: /hochschild/i, sym: 'HOC.L' }, { re: /agnico/i, sym: 'AEM' }, { re: /barrick/i, sym: 'B' },
  ];
  function _peerSymbol(name) {
    const s = String(name || '').trim(); if (!s) return null;
    for (const m of SG_PEER_SYMBOLS) if (m.re.test(s)) return m.sym;
    return null;
  }

  // `years` (opcional, de detectStockGuideYears): confere se a aba de peers está nos MESMOS anos da comp table.
  function parseStockGuidePeers(wb, years) {
    const X = root.XLSX;
    if (!X || !wb || !wb.SheetNames) return { rows: [], warnings: ['SheetJS/arquivo inválido.'] };
    const covered = new Set(SG_COVERAGE.map(function (c) { return c.yahoo; }));
    const rows = [], warnings = [], seen = new Set();
    SG_PEER_TABS.forEach(function (meta) {
      const want = [meta.tab].concat(meta.alt || []).map(function (t) { return t.toLowerCase(); });
      const nm = wb.SheetNames.find(function (s) { return want.indexOf(s.trim().toLowerCase()) >= 0; });
      if (!nm) { if (!meta.optional) warnings.push('aba ausente: ' + meta.tab); return; }
      const aoa = X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, blankrows: true });
      // linha-cabeçalho = a que contém "EV/EBITDA"
      const hdr = _sgFindCell(aoa, /^ev\s*\/\s*ebitda/i);
      if (!hdr) { warnings.push(meta.tab + ': cabeçalho EV/EBITDA não encontrado'); return; }
      const hr = hdr.r, yr = hr + 1;                       // rótulos em hr; anos (27E/28E) na linha hr+1
      if (years && years.y1) {
        const got = _sgYearLabel((aoa[yr] || [])[hdr.c]);
        if (got && got !== String(years.y1).toUpperCase()) warnings.push(nm + ': peers em ' + got + ', a comp table em ' + years.y1 + ' — confira a aba');
      }
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
  // "Yield" pode vir DEPOIS de outras palavras: os modelos de cobre (Nov-22-2026) escrevem
  // "FCF Ex-Growth Yield (%) 2027E" — sem isto a tabela de yield virava FCF em valor absoluto
  // (0,12 escrito como "0"), o par FCF ÷ yield sumia e nenhum múltiplo era reescrito no preço de tela.
  function sens2dMetricFromTitle(title) {
    const t = String(title == null ? '' : title).toLowerCase();
    const has = function (s) { return t.indexOf(s) >= 0; };
    if (has('p/nav') || has('p / nav')) return 'p_nav';
    if (has('upside')) return 'upside';
    if (has('dividend yield') || (has('yield') && has('dividend'))) return 'div_yield';
    if (has('fcf yield') || (has('yield') && (has('fcf') || has('free cash')))) return 'fcf_yield';
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
    SG_TICKER_RENAMES: SG_TICKER_RENAMES,
    parseStockGuideWorkbook: parseStockGuideWorkbook,
    parseStockGuidePeers: parseStockGuidePeers,
    parseSGFXRates: parseSGFXRates,
    detectStockGuideYears: detectStockGuideYears,
    cellDate: _sgCellDate,
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
  // ══ COMPS: a conta dos múltiplos, num lugar só ═════════════════════════════
  // Mudou-se para cá em 31/08/2026 porque o Weekly Recap monta a MESMA comp table,
  // só que no FECHAMENTO DA SEXTA em vez do preço ao vivo — e a exigência do
  // analista é que o preço da comp table seja idêntico ao "hoje" da tabela de
  // performance do e-mail. Isso se resolve passando outro `priceByKey`; duplicar a
  // fórmula, não. (Mesma lição do clipping: duas saídas do mesmo conteúdo não se
  // montam em paralelo, uma deriva da outra.)
  //
  // `stock-guide.html` delega para cá; o comportamento ao vivo não mudou.
  // terras raras = grupo PRÓPRIO (como a aba "Rare Earths" do Stock Guide): desenvolvedoras sem receita, com EBITDA
  // negativo — dentro de Mining, entrariam no agregado do grupo (Σ EV ÷ Σ EBITDA) e o distorceriam
  var GROUP_OF = {iron_ore:'mining', copper:'mining', gold:'mining', mining:'mining', rare_earths:'rare_earths',
                  steel:'steel', pulp_paper:'pulp_paper', pp:'pulp_paper'};
  function shortTicker(t){ return String(t||'').replace(/\.(SA|SN|MX|L|HE|AX|F|TO)$/,''); }

  function mapComp(c){ var n=SG.toNumOrNull; return{ticker:c.ticker,company_name:c.company_name,is_visible:c.is_visible,display_order:c.display_order,
    sector:c.sector,yahoo_symbol:c.yahoo_symbol,shares_outstanding:n(c.shares_outstanding),
    last_update:c.last_update,target_price:n(c.target_price),recommendation:c.recommendation,
    net_debt_y1:n(c.net_debt_y1),net_debt_y2:n(c.net_debt_y2),ebitda_y1:n(c.ebitda_y1),ebitda_y2:n(c.ebitda_y2),
    net_income_y1:n(c.net_income_y1),net_income_y2:n(c.net_income_y2),
    dividends_y1:n(c.dividends_y1),dividends_y2:n(c.dividends_y2),
    cash_earnings_y1:n(c.cash_earnings_y1),cash_earnings_y2:n(c.cash_earnings_y2),
    ocf_y1:n(c.ocf_y1),ocf_y2:n(c.ocf_y2),
    ev_adjustment_y1:n(c.ev_adjustment_y1),ev_adjustment_y2:n(c.ev_adjustment_y2),
    fx_to_base:n(c.fx_to_base),fx_to_usd:n(c.fx_to_usd),base_ccy:c.base_ccy,trade_ccy:c.trade_ccy,model_url:c.model_url}}

  function deriveMultiples(r,mc){  // mc = market cap na MOEDA-BASE
    var ev1=mc!=null&&r.net_debt_y1!=null?mc+r.net_debt_y1+(r.ev_adjustment_y1||0):null;
    var ev2=mc!=null&&r.net_debt_y2!=null?mc+r.net_debt_y2+(r.ev_adjustment_y2||0):null;
    return{evEbitdaY1:ev1!=null&&r.ebitda_y1>0?ev1/r.ebitda_y1:null, evEbitdaY2:ev2!=null&&r.ebitda_y2>0?ev2/r.ebitda_y2:null,
      ndEbitdaY1:r.net_debt_y1!=null&&r.ebitda_y1>0?r.net_debt_y1/r.ebitda_y1:null, ndEbitdaY2:r.net_debt_y2!=null&&r.ebitda_y2>0?r.net_debt_y2/r.ebitda_y2:null,
      pceY1:mc!=null&&r.cash_earnings_y1>0?mc/r.cash_earnings_y1:null, pceY2:mc!=null&&r.cash_earnings_y2>0?mc/r.cash_earnings_y2:null,
      peY1:mc!=null&&r.net_income_y1>0?mc/r.net_income_y1:null, peY2:mc!=null&&r.net_income_y2>0?mc/r.net_income_y2:null,
      divYieldY1:r.dividends_y1!=null&&mc>0?r.dividends_y1/mc*100:null, divYieldY2:r.dividends_y2!=null&&mc>0?r.dividends_y2/mc*100:null}}

  // `priceByKey` é o ponto de troca: ao vivo na aba Stock Guide, fechamento da sexta
  // no Weekly Recap. Aceita a chave com e sem sufixo de bolsa ('VALE3' e 'VALE3.SA').
  function deriveComps(comps,priceByKey,fxRates){
    fxRates=fxRates||{};
    var rows=[];
    var lp=function(r){ var cands=[r.yahoo_symbol, r.is_visible?r.ticker:null].filter(Boolean);
      for(var i=0;i<cands.length;i++){ var c=cands[i], tries=[c,shortTicker(c)];
        if(!/\./.test(c))tries.push(c+'.SA');
        for(var j=0;j<tries.length;j++){ if(priceByKey[tries[j]]!=null)return priceByKey[tries[j]]; } }
      return null; };
    comps.map(mapComp).forEach(function(r){
      var live=lp(r);
      // câmbio AO VIVO (USD por unidade da moeda de negociação); snapshot do modelo = fallback
      var trade=r.trade_ccy||'';
      var snapUsdPerTrade=(trade==='USD')?1:(r.fx_to_usd!=null?r.fx_to_usd:null);
      var liveRate=fxRates[trade];                                            // unidades por USD, ao vivo
      var usdPerTrade=(trade==='USD')?1:(liveRate?1/liveRate:snapUsdPerTrade);
      // fator p/ a moeda-BASE do modelo: 1 se base==negociação; senão (base=USD) = usdPerTrade.
      // "base == negociação?" pela MOEDA gravada (base_ccy/trade_ccy, que o upload grava desde 06/2026); sem ela, pelo
      // fx_to_base ≈ 1 (regra antiga). Desde 24/11/2026: um fx_to_base vazio — o banco grava 1 no lugar — não faz
      // mais uma empresa modelada em US$ (as de cobre, que negociam em C$) ser lida como se fosse em moeda local.
      var baseEqTrade=(r.base_ccy&&r.trade_ccy)?(r.base_ccy===r.trade_ccy):(r.fx_to_base!=null?Math.abs(r.fx_to_base-1)<=0.02:true);
      var factorBase=baseEqTrade?1:(usdPerTrade!=null?usdPerTrade:(r.fx_to_base!=null?r.fx_to_base:1));
      var mcBase=r.shares_outstanding!=null&&live!=null?r.shares_outstanding*live*factorBase:null;
      var mcUsd=r.shares_outstanding!=null&&live!=null&&usdPerTrade!=null?r.shares_outstanding*live*usdPerTrade:null;
      var upside=r.target_price!=null&&live!=null&&live>0?r.target_price/live-1:null;
      var toUsd=(usdPerTrade!=null&&factorBase)?usdPerTrade/factorBase:null;   // moeda-base → US$ (p/ agregado)
      var m=deriveMultiples(r,mcBase);
      var eps1=r.net_income_y1!=null&&r.shares_outstanding>0?r.net_income_y1/r.shares_outstanding:null;
      var eps2=r.net_income_y2!=null&&r.shares_outstanding>0?r.net_income_y2/r.shares_outstanding:null;
      var ocfY1=r.ocf_y1!=null&&mcBase>0?r.ocf_y1/mcBase*100:null, ocfY2=r.ocf_y2!=null&&mcBase>0?r.ocf_y2/mcBase*100:null;
      rows.push(Object.assign({},r,{displayName:r.company_name,group:GROUP_OF[r.sector]||'mining',
        livePrice:live,marketCapBrlMn:mcBase,marketCapUsd:mcUsd,toUsd:toUsd,upsidePct:upside,
        epsY1:eps1,epsY2:eps2,ocfYieldY1:ocfY1,ocfYieldY2:ocfY2},m));
    });
    return rows;
  }

  SG.GROUP_OF        = GROUP_OF;
  SG.shortTicker     = shortTicker;
  SG.mapComp         = mapComp;
  SG.deriveMultiples = deriveMultiples;
  SG.deriveComps     = deriveComps;

  if (typeof module !== 'undefined' && module.exports) module.exports = SG;
})(typeof window !== 'undefined' ? window : globalThis);
