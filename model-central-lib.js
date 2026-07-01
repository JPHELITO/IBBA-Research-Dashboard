/* =============================================================================
 * model-central-lib.js — "Model Central": lê o MODELO OFICIAL (.xlsx via SheetJS),
 * aplica a RECEITA da empresa (label-anchored + células fixadas no manifesto) e gera
 * o MESH de numeradores (ebitda · net_debt · fcf · dividends) que alimenta o motor de
 * sensibilidade EXISTENTE (buildGridMesh/interpolateMesh + computeSensitivityCellValue).
 *
 * Os 3 indicadores são recalculados AO VIVO no navegador:
 *   EV/EBITDA = (mktcap_LIVE + net_debt) / ebitda     (net_debt/ebitda já trazem o ajuste da empresa)
 *   FCF Yield = fcf / mktcap_LIVE * 100
 *   Div Yield = dividends / mktcap_LIVE * 100
 * O modelo dá os numeradores (e como respondem aos drivers); preço da ação e USD/BRL vêm
 * AO VIVO da dashboard. Links externos do modelo = CONGELADOS no valor salvo (decisão do usuário).
 *
 * Fatia 1 = CSN (CSNA3) · Usiminas (USIM5) · Gerdau (GGBR4) — 100% no navegador (sem links
 * externos no caminho do driver). Lógica VALIDADA espelhada em Python contra os modelos reais
 * (base reproduz os indicadores publicados; round-trip pelo interp é exato).
 *
 * Vanilla JS; usa window.XLSX (SheetJS). Expõe window.MC (+ module.exports p/ teste).
 * ========================================================================== */
;(function (root) {
  'use strict';

  // ── numérico (espelho de _sgCellNum): trata #REF!/#N/A/n.a./'-'/vazio e nº-como-texto ──
  function cellNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v instanceof Date) return null;
    var s = String(v).trim();
    if (s === '' || /^#|^n\.?\s*a\.?$|^-+$/i.test(s)) return null;
    s = s.replace(/\s/g, '').replace(/,/g, '');           // milhar en-US; decimal é '.'
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  // ── AOA de uma aba (0-based: aoa[r][c]); mesma base do parser de comps ──
  function aoa(wb, name) {
    var X = root.XLSX; if (!X || !wb || !wb.Sheets || !wb.Sheets[name]) return null;
    return X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: true });
  }
  // letra de coluna → índice 0-based (A=0, W=22, AB=27)
  function colIdx(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n - 1; }
  // valor numérico numa referência A1 fixa ('W21','U60')
  function a1(rows, addr) {
    var m = /^([A-Z]+)(\d+)$/.exec(addr); if (!m || !rows) return null;
    var c = colIdx(m[1]), r = parseInt(m[2], 10) - 1, row = rows[r];
    return cellNum(row ? row[c] : null);
  }
  // coluna do ano-estimativa pelo HEADER (varre o topo) — robusto: a coluna muda por aba.
  // 2 passos: 1º a string exata ('2026E'); 2º (fallback) o ano NUMÉRICO (inteiro 2026 ou '2026'),
  // p/ modelos como a Aura cujo header é o inteiro 2026 (não estraga quem usa '2026E').
  function colForYear(rows, year) {
    if (!rows) return -1;
    var maxR = Math.min(rows.length, 60), r, c, row, v;
    for (r = 0; r < maxR; r++) { row = rows[r]; if (!row) continue;
      for (c = 0; c < Math.min(row.length, 45); c++) { v = row[c]; if (typeof v === 'string' && v.trim() === year) return c; } }
    var yNum = parseInt(year, 10);
    for (r = 0; r < maxR; r++) { row = rows[r]; if (!row) continue;
      for (c = 0; c < Math.min(row.length, 45); c++) { v = row[c];
        if ((typeof v === 'number' && v === yNum) || (typeof v === 'string' && v.trim() === String(yNum))) return c; } }
    return -1;
  }
  // 1ª linha cujo rótulo (em `cols`) casa `re`; 0-based ou -1
  function findRow(rows, re, cols) {
    if (!rows) return -1;
    cols = cols || [0, 1, 2, 4, 5];
    var maxR = Math.min(rows.length, 320);
    for (var r = 0; r < maxR; r++) {
      var row = rows[r]; if (!row) continue;
      for (var k = 0; k < cols.length; k++) { var v = row[cols[k]]; if (typeof v === 'string' && re.test(v.trim())) return r; }
    }
    return -1;
  }
  // valor numérico no cruzamento (linha-por-rótulo) × (coluna-do-ano)
  function valYear(rows, re, yc, cols) {
    var r = findRow(rows, re, cols); if (r < 0 || yc < 0) return null;
    var row = rows[r]; return cellNum(row ? row[yc] : null);
  }

  // ===========================================================================
  // RECEITAS (manifesto) — uma por ticker. Cada uma devolve:
  //   { ticker, currency, year, base:{ebitda,net_debt,fcf,dividends,mktcap,shares,price},
  //     axes:[{id,label,unit,base,min,max,kind,live,source}], fxmodel,
  //     num(pt,fx)->{ebitda,net_debt,fcf,dividends}, published:{ev_ebitda,fcf_yield,div_yield} }
  // num() devolve os NUMERADORES já no "sabor" do múltiplo (ev_ebitda usa net_debt/ebitda ajustados).
  // ===========================================================================
  var RECIPES = {

    // ── CSN (CSNA3) — BRL · só a fatia SIDERÚRGICA move (1 de 8 segmentos) · dividendo 0 ──
    CSNA3: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C'), D = aoa(wb, 'DCF');
      if (!O || !F || !R || !D) return { error: 'CSN: aba do modelo faltando (OUTPUT/FCF/R&C/DCF)' };
      var wc = colForYear(O, '2026E'), fc = colForYear(F, '2026E');
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, wc),
          nd      = valYear(O, /Net Debt Adj/i, wc),
          minor   = valYear(O, /^Minorities/i, wc),
          fcf0    = valYear(F, /FCF Generation/i, fc);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var domg0 = a1(R, 'U60'), expg0 = a1(R, 'U61'), domrev = a1(R, 'U32'), exprev = a1(R, 'U33');
      var sga = Math.abs(a1(R, 'U70') || 0), ctax = Math.abs(a1(D, 'S19') || 0);
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'CSN: numerador-base nulo' };
      var sdom = (1 - sga) * domrev / (1 + domg0), sexp = (1 - sga) * exprev / (1 + expg0);
      var ndm = nd + (minor || 0);
      function num(pt, fx) {
        var dE = sdom * (pt.dom - domg0) + sexp * (pt.exp - expg0);
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * (1 - ctax), dividends: 0 };
      }
      return {
        ticker: 'CSNA3', currency: 'BRL', year: '2026E', fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: 0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'dom', label: 'Domestic steel price growth', unit: '%', base: domg0, min: -0.05, max: 0.15, kind: 'growth', live: false },
          { id: 'exp', label: 'Export steel price growth',   unit: '%', base: expg0, min: -0.05, max: 0.15, kind: 'growth', live: false }
        ],
        num: num,
        published: { ev_ebitda: a1(F, 'C22'), fcf_yield: (a1(F, 'C25') || 0) * 100, div_yield: 0 },
        notes: 'Só a siderurgia move; mineração/cimento/logística constantes. Dividendo = 0 no forecast → Div Yield 0%.'
      };
    },

    // ── Usiminas (USIM5) — BRL · preço de aço doméstico · downside travado em -3% (degrau imposto) ──
    USIM5: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), S = aoa(wb, 'Steel'), M = aoa(wb, 'Model'), D = aoa(wb, 'DCF');
      if (!O || !F || !S || !M || !D) return { error: 'USIM: aba do modelo faltando (OUTPUT/FCF/Steel/Model/DCF)' };
      var tc = colForYear(O, '2026E'), fc = colForYear(F, '2026E');
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, tc),
          nd      = valYear(O, /Net Debt \(incl/i, tc),
          minor   = a1(M, 'U294'),
          fcf0    = valYear(F, /FCF Generation/i, fc);
      var shares = a1(O, 'C11'), price = a1(O, 'C7'), mktcap = a1(O, 'C12');
      var domg0 = a1(S, 'U142'), prior = a1(S, 'T117'), vol = a1(S, 'U95'), ctax = Math.abs(a1(D, 'S19') || 0);
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'USIM: numerador-base nulo' };
      var sdom = prior * vol / 1000, ndm = nd + (minor || 0);
      function num(pt, fx) {
        var dE = sdom * (pt.dom - domg0);
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * (1 - ctax), dividends: 0 };
      }
      return {
        ticker: 'USIM5', currency: 'BRL', year: '2026E', fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: 0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'dom', label: 'Domestic steel price growth', unit: '%', base: domg0, min: -0.03, max: 0.12, kind: 'growth', live: false }
        ],
        num: num,
        published: { ev_ebitda: a1(F, 'C24'), fcf_yield: (a1(F, 'C26') || 0) * 100, div_yield: 0 },
        notes: 'Alta alavancagem operacional. Downside travado em -3% (imposto sem floor). Dividendo 2026E defasado (ano anterior) → Div Yield ~0/insensível.'
      };
    },

    // ── Gerdau (GGBR4) — BRL · 2 margens SINTÉTICAS (US/Brasil) + USD/BRL AO VIVO (segmento NA é USD) ──
    GGBR4: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C'), M = aoa(wb, 'Model');
      if (!O || !F || !R || !M) return { error: 'GGBR: aba do modelo faltando (OUTPUT/FCF/R&C/Model)' };
      var fc = colForYear(F, '2026E');
      var ebcons0 = a1(O, 'W21'), br0 = a1(O, 'W16'), na0 = a1(O, 'W17'),
          sa = a1(O, 'W18'), adj = a1(O, 'W20'), nd = a1(O, 'W62'), m = a1(M, 'U347');
      var fcf0 = valYear(F, /FCF Generation/i, fc), payout = a1(M, 'U220'), ni0 = a1(M, 'U142'), ctax = Math.abs(a1(O, 'W48') || 0);
      var br_rev = a1(R, 'U19'), na_rev = a1(R, 'U22'), br_m0 = a1(R, 'U271'), na_m0 = a1(R, 'U272'), fxm = a1(R, 'U8');
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      if (ebcons0 == null || nd == null || fcf0 == null || mktcap == null || !fxm) return { error: 'GGBR: numerador-base nulo' };
      var saadj = (sa || 0) + (adj || 0), one = 1 + (m || 0);
      function num(pt, fx) {
        var ebcons = pt.br * br_rev + pt.na * na_rev * (fx / fxm) + saadj;   // NA é USD → escala com FX ao vivo
        var dE = ebcons - ebcons0, ni = ni0 + dE * (1 - ctax);
        return { ebitda: ebcons * one, net_debt: nd * one, fcf: fcf0 + dE * (1 - ctax), dividends: payout * ni };
      }
      return {
        ticker: 'GGBR4', currency: 'BRL', year: '2026E', fxmodel: fxm,
        base: { ebitda: ebcons0 * one, net_debt: nd * one, fcf: fcf0, dividends: payout * ni0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'br', label: 'Brazil EBITDA margin',        unit: '%',       base: br_m0, min: 0.08, max: 0.15, kind: 'margin', live: false },
          { id: 'na', label: 'North America EBITDA margin',  unit: '%',       base: na_m0, min: 0.18, max: 0.28, kind: 'margin', live: false },
          { id: 'fx', label: 'USD/BRL',                      unit: 'BRL/USD', base: fxm,   min: 4.5,  max: 6.5,  kind: 'fx',     live: true, source: 'fx_usdbrl' }
        ],
        num: num,
        published: { ev_ebitda: a1(O, 'W79'), fcf_yield: (a1(F, 'C24') || 0) * 100, div_yield: (a1(O, 'W46') || 0) * 100 },
        notes: 'Margens sintéticas (modelo não tem célula de margem) = margem×receita do segmento. NA (≈71% do EBITDA) é USD → USD/BRL ao vivo. Múltiplo "Adj." escala dívida e EBITDA por (1+minoritários).'
      };
    },

    // ── Vale (VALE3) — modelo em USD, ação em BRL (mktcap converte ao vivo). 2 eixos: minério 61% + volume.
    //    Bilinear validado contra a aba Sensitivity da Vale (oracle). Só FERROSOS move.
    VALE3: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), M = aoa(wb, 'Model');
      if (!O || !F) return { error: 'Vale: aba do modelo faltando (OUTPUT/FCF)' };
      var wc = colForYear(O, '2026E');
      var ebitda0 = valYear(O, /^Proforma EBITDA/i, wc),
          nd      = valYear(O, /Expanded Net Debt/i, wc),
          minor   = valYear(O, /^Minorities/i, wc),
          fcf0    = valYear(O, /\(=\) FCFF/i, wc),       // OUTPUT FCFF 2026E (a aba FCF é 2030E)
          div0    = valYear(O, /^Dividends$/i, wc);       // OUTPUT Dividendos 2026E
      var shares = a1(O, 'I11'), price = a1(O, 'I7'), mktcap = a1(O, 'I12');   // bloco USD (base)
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'Vale: numerador-base nulo' };
      var ndm = nd + (minor || 0);
      var P0 = 102.5, V0 = 320.358, dEdP = 270.49, dEdV = 43.70, crossPV = 0.856, fcfK = 1 - 0.196, divK = 0.15;
      function num(pt, fx) {
        var dP = pt.price - P0, dV = pt.vol - V0, dE = dEdP * dP + dEdV * dV + crossPV * dP * dV;
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 + dE * divK };
      }
      return {
        ticker: 'VALE3', currency: 'USD', year: '2026E', fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'price', label: 'Iron ore 61% Fe price', unit: 'USD/t', base: P0, min: 80, max: 130, kind: 'price', live: true, source: 'iron_ore_61' },
          { id: 'vol',   label: 'Iron ore sales volume',  unit: 'Mt',    base: V0, min: 280, max: 360, kind: 'volume', live: false }
        ],
        num: num,
        published: { ev_ebitda: a1(O, 'W119'), fcf_yield: (valYear(O, /^FCFF Yield/i, wc) || 0) * 100, div_yield: (valYear(O, /^Dividend Yield \(incl/i, wc) || 0) * 100 },
        notes: 'Modelo em USD (ação BRL — mktcap converte ao vivo). Só ferrosos move; cascata de preço realizado embutida na inclinação (validada vs a aba Sensitivity da Vale). USD/BRL atua via o market cap ao vivo.'
      };
    },

    // ── CMIN (CSN Mineração) — BRL · minério-puro · minério 61% + USD/BRL ao vivo. (volume com kink >46Mt fica p/ depois.)
    CMIN3: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF');
      if (!O || !F) return { error: 'CMIN: aba do modelo faltando (OUTPUT/FCF)' };
      var oc = colForYear(O, '2026E'), fc = colForYear(F, '2026E');
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, oc),
          nd      = valYear(O, /^Net Debt$/i, oc),
          minor   = valYear(O, /^Minorities/i, oc),
          fcf0    = valYear(F, /FCF Generation/i, fc),
          div0    = Math.abs(valYear(F, /^\(-\) Dividends/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var fx0 = valYear(O, /BRL\/USD - AVG/i, oc) || 5.30;
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'CMIN: numerador-base nulo' };
      var ndm = nd + (minor || 0), P0 = 100, s = 200, fcfK = 1 - 0.30;
      function num(pt, fx) {
        var eb = (ebitda0 + s * (pt.price - P0)) * (fx / fx0), dE = eb - ebitda0;
        return { ebitda: eb, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 };
      }
      return {
        ticker: 'CMIN3', currency: 'BRL', year: '2026E', fxmodel: fx0,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'price', label: 'Iron ore 61% Fe price', unit: 'USD/t',   base: P0,  min: 70, max: 130, kind: 'price', live: true, source: 'iron_ore_61' },
          { id: 'fx',    label: 'USD/BRL',                unit: 'BRL/USD', base: fx0, min: 4.5, max: 6.5, kind: 'fx',    live: true, source: 'fx_usdbrl' }
        ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(F, /^Dividend Yield/i, fc) || 0) * 100 },
        notes: 'Minério-puro (BRL); EBITDA ∝ USD/BRL ao vivo. Inclinação de preço ≈ +R$200mn/US$1t (aprox. Fatia 4). FCF reportado (com pré-pagamentos); volume com prêmio >46Mt fica p/ refino.'
      };
    },

    // ── Suzano (SUZB3) — BRL · celulose-pura · BHKP + USD/BRL ao vivo.
    SUZB3: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF');
      if (!O || !F) return { error: 'Suzano: aba do modelo faltando (OUTPUT/FCF)' };
      var oc = colForYear(O, '2026E'), fc = colForYear(F, '2026E');
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, oc),
          nd      = valYear(O, /^Net Debt$/i, oc),
          minor   = valYear(O, /^Minorities/i, oc),
          fcf0    = valYear(F, /FCF Generation/i, fc),
          div0    = Math.abs(valYear(F, /Dividends\/Buyback/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var fx0 = valYear(O, /BRL\/USD - AVG/i, oc) || 5.30;
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'Suzano: numerador-base nulo' };
      var ndm = nd + (minor || 0), B0 = 590, s = 57, fcfK = 1 - 0.25;
      function num(pt, fx) {
        var eb = (ebitda0 + s * (pt.bhkp - B0)) * (fx / fx0), dE = eb - ebitda0;
        return { ebitda: eb, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 };
      }
      return {
        ticker: 'SUZB3', currency: 'BRL', year: '2026E', fxmodel: fx0,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'bhkp', label: 'BHKP hardwood pulp price', unit: 'USD/t',   base: B0,  min: 450, max: 800, kind: 'price', live: false },
          { id: 'fx',   label: 'USD/BRL',                  unit: 'BRL/USD', base: fx0, min: 4.5, max: 6.5, kind: 'fx',    live: true, source: 'fx_usdbrl' }
        ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(F, /^Dividend Yield/i, fc) || 0) * 100 },
        notes: 'Celulose-pura (BRL); EBITDA ∝ USD/BRL ao vivo. Inclinação ≈ +R$57mn/US$1t BHKP (aprox. Fatia 4). FCF reportado (com efeito Kimberly-Clark); dividendo c/ piso fica p/ refino.'
      };
    },

    // ── Klabin (KLBN11) — BRL · só a fatia de CELULOSE move (papel constante) · BHKP + spread fibra-longa + USD/BRL.
    KLBN11: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C');
      if (!O || !F || !R) return { error: 'Klabin: aba do modelo faltando (OUTPUT/FCF/R&C)' };
      var oc = colForYear(O, '2026E'), fc = colForYear(F, '2026E');
      var ebitda0 = valYear(O, /Adj\. EBITDA\s*\(BRL/i, oc),
          nd      = valYear(O, /^Net Debt$/i, oc),
          minor   = valYear(O, /^Minorities/i, oc),
          fcf0    = valYear(F, /FCF Generation/i, fc),
          div0    = Math.abs(valYear(F, /^\(-\) Dividends/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var fx0 = valYear(O, /BRL\/USD - AVG/i, oc) || 5.30;
      var pulp0 = a1(R, 'U119');                       // EBITDA Adj. da fatia celulose
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null || pulp0 == null) return { error: 'Klabin: numerador-base nulo' };
      var ndm = nd + (minor || 0), paperConst = ebitda0 - pulp0;
      var B0 = 590, SP0 = 80, sB = 6.5, sS = 2.3, fcfK = 1 - 0.25;
      function num(pt, fx) {
        var pulp = (pulp0 + sB * (pt.bhkp - B0) + sS * (pt.spread - SP0)) * (fx / fx0);
        var eb = paperConst + pulp, dE = eb - ebitda0;
        return { ebitda: eb, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 };
      }
      return {
        ticker: 'KLBN11', currency: 'BRL', year: '2026E', fxmodel: fx0,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'bhkp',   label: 'BHKP hardwood pulp price',   unit: 'USD/t',   base: B0,  min: 450, max: 800, kind: 'price', live: false },
          { id: 'spread', label: 'Softwood–hardwood spread',   unit: 'USD/t',   base: SP0, min: 0,   max: 160, kind: 'price', live: false },
          { id: 'fx',     label: 'USD/BRL',                    unit: 'BRL/USD', base: fx0, min: 4.5, max: 6.5, kind: 'fx',    live: true, source: 'fx_usdbrl' }
        ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(O, /^Dividend Yield/i, oc) || 0) * 100 },
        notes: 'Só a CELULOSE move (papel/embalagem constante). BSKP = BHKP + spread (fibra-longa). EBITDA da celulose ∝ USD/BRL ao vivo. Inclinações aprox. (Fatia 4).'
      };
    },

    // ── Aura (AURA33) — modelo em USD (ação BRL) · multi-mina SOTP de OURO · ouro + cobre.
    //    Ouro em termos REAIS (≠ spot) → sliders ESTÁTICOS (não puxam feed). EV usa dívida ex-swap.
    AURA33: function (wb) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), M = aoa(wb, 'Model');
      if (!O || !F || !M) return { error: 'Aura: aba do modelo faltando (OUTPUT/FCF/Model)' };
      var oc = colForYear(O, '2026E'), fc = colForYear(F, '2026E'), mc = colForYear(M, '2026E');
      var ebitda0 = valYear(O, /Adjusted EBITDA/i, oc),
          evadj   = valYear(O, /^EV Adjusted/i, oc),        // EV = mktcap + dívida ex-swap
          fcf0    = valYear(F, /FCF Generation/i, fc),
          div0    = Math.abs(valYear(F, /Dividends\/Buyback/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');   // bloco USD (base)
      var gold0 = valYear(M, /Gold\s*-\s*\(real/i, mc) || 5000,
          copper0 = valYear(M, /Copper\s*-\s*\(real/i, mc) || 5.85;
      if (ebitda0 == null || evadj == null || fcf0 == null || mktcap == null) return { error: 'Aura: numerador-base nulo' };
      var ndm = evadj - mktcap;                              // net_debt "metric" constante (net-of-swap)
      var ozNet = 0.30, sCu = 32.5, fcfK = 1 - 0.25;         // ≈ +US$0,30mn por +US$1/oz ouro ; +32,5 por +US$1/lb cobre
      function num(pt, fx) {
        var dE = ozNet * (pt.gold - gold0) + sCu * (pt.copper - copper0);
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 };
      }
      return {
        ticker: 'AURA33', currency: 'USD', year: '2026E', fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [
          { id: 'gold',   label: 'Gold price (real)',   unit: 'USD/oz', base: gold0,   min: 3500, max: 6000, kind: 'price', live: false },
          { id: 'copper', label: 'Copper price (real)', unit: 'USD/lb', base: copper0, min: 3.5,  max: 7.0,  kind: 'price', live: false }
        ],
        num: num,
        published: { ev_ebitda: valYear(O, /^EV\/EBITDA \(/i, oc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(F, /Dividend.*Yield/i, fc) || 0) * 100 },
        notes: 'Modelo em USD (ação BRL — mktcap converte ao vivo). SOTP multi-mina; só ouro/cobre move. Ouro em termos REAIS (≠ spot) → sliders estáticos. EV usa dívida ex-swap. Hedge/piso de dividendo aprox. (Fatia 5).'
      };
    }

  };

  // ── mesh dos numeradores: avalia num() nos 2^d cantos (multilinear → interp EXATO entre cantos) ──
  function buildMesh(rec) {
    var axes = rec.axes, d = axes.length, METRICS = ['ebitda', 'net_debt', 'fcf', 'dividends'];
    var pts = { ebitda: [], net_debt: [], fcf: [], dividends: [] };
    for (var mask = 0; mask < (1 << d); mask++) {
      var pt = {}, coords = [];
      for (var a = 0; a < d; a++) { var v = (mask & (1 << a)) ? axes[a].max : axes[a].min; pt[axes[a].id] = v; coords.push(v); }
      var fx = ('fx' in pt) ? pt.fx : (rec.fxmodel || 1);
      var nm = rec.num(pt, fx);
      for (var i = 0; i < METRICS.length; i++) pts[METRICS[i]].push({ coords: coords.slice(), value: nm[METRICS[i]] });
    }
    return pts;   // FLAT por métrica: {ebitda:[{coords,value}], net_debt:[…], fcf:[…], dividends:[…]} (eixos vivem em rec.axes)
  }

  // ── gate de validação: o base recomputado bate com o indicador PUBLICADO do modelo? ──
  function validate(rec) {
    var b = rec.base, p = rec.published || {};
    var ev = (b.mktcap + b.net_debt) / b.ebitda;
    var fy = b.fcf / b.mktcap * 100;
    var dy = b.dividends / b.mktcap * 100;
    var diffs = [];
    function chk(name, got, exp, tol) {
      if (exp == null) return;
      if (Math.abs(got - exp) > tol) diffs.push(name + ': recomputo ' + got.toFixed(3) + ' vs modelo ' + exp.toFixed(3));
    }
    chk('EV/EBITDA', ev, p.ev_ebitda, 0.02);
    chk('FCF Yield', fy, p.fcf_yield, 0.10);
    chk('Div Yield', dy, p.div_yield, 0.10);
    return { ok: diffs.length === 0, diffs: diffs, recomputed: { ev_ebitda: ev, fcf_yield: fy, div_yield: dy } };
  }

  // ── entrada: workbook + ticker → receita resolvida + mesh + relatório do gate ──
  function parseModel(wb, ticker) {
    var rf = RECIPES[ticker]; if (!rf) return { error: 'Sem receita Model Central p/ ' + ticker };
    var rec = rf(wb); if (rec.error) return rec;
    rec.mesh = buildMesh(rec);
    rec.gate = validate(rec);
    return rec;
  }

  var MC = {
    cellNum: cellNum, colForYear: colForYear, findRow: findRow, a1: a1, aoa: aoa,
    RECIPES: RECIPES, TICKERS: Object.keys(RECIPES),
    buildMesh: buildMesh, validate: validate, parseModel: parseModel
  };
  root.MC = MC;
  if (typeof module !== 'undefined' && module.exports) module.exports = MC;
})(typeof window !== 'undefined' ? window : globalThis);
