/* =============================================================================
 * model-central-lib.js — "Model Central": lê o MODELO OFICIAL (.xlsx via SheetJS),
 * aplica a RECEITA da empresa (label-anchored) e gera o MESH de numeradores
 * (ebitda · net_debt · fcf · dividends) que alimenta o motor de sensibilidade EXISTENTE.
 *
 * Os 3 indicadores são recalculados AO VIVO no navegador:
 *   EV/EBITDA = (mktcap_LIVE + net_debt) / ebitda
 *   FCF Yield = fcf / mktcap_LIVE * 100
 *   Div Yield = dividends / mktcap_LIVE * 100
 * O modelo dá os numeradores (e como respondem aos drivers); preço da ação e USD/BRL vêm
 * AO VIVO. Links externos do modelo = CONGELADOS no valor salvo (decisão do usuário).
 *
 * GRANULARIDADE 3 ANOS (2026E·2027E·2028E): cada receita é função (wb, year); parseModel
 * roda os 3 anos → per-year meshes/bases/published + gate por ano. Mantém campos legados
 * (2026E) p/ compatibilidade com a UI atual. Base VALIDADA in-browser vs indicador publicado.
 *
 * Vanilla JS; usa window.XLSX (SheetJS). Expõe window.MC (+ module.exports p/ teste).
 * ========================================================================== */
;(function (root) {
  'use strict';

  function cellNum(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (v instanceof Date) return null;
    var s = String(v).trim();
    if (s === '' || /^#|^n\.?\s*a\.?$|^-+$/i.test(s)) return null;
    s = s.replace(/\s/g, '').replace(/,/g, '');
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function aoa(wb, name) {
    var X = root.XLSX; if (!X || !wb || !wb.Sheets || !wb.Sheets[name]) return null;
    return X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: true });
  }
  function colIdx(letters) { var n = 0; for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n - 1; }
  function a1(rows, addr) {
    var m = /^([A-Z]+)(\d+)$/.exec(addr); if (!m || !rows) return null;
    var c = colIdx(m[1]), r = parseInt(m[2], 10) - 1, row = rows[r];
    return cellNum(row ? row[c] : null);
  }
  // valor numérico em (linha 1-based, coluna 0-based) — p/ leitura por linha-fixa × coluna-do-ano
  function atRC(rows, rowNum, col) {
    if (!rows || col < 0 || rowNum == null) return null;
    var row = rows[rowNum - 1]; return cellNum(row ? row[col] : null);
  }
  // coluna do ano-estimativa pelo HEADER; 2 passos: string exata ('2026E'), depois ano numérico (Aura=2026).
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
  function valYear(rows, re, yc, cols) {
    var r = findRow(rows, re, cols); if (r < 0 || yc < 0) return null;
    var row = rows[r]; return cellNum(row ? row[yc] : null);
  }

  // ===========================================================================
  // RECEITAS — uma por ticker, função (wb, year). Devolve p/ AQUELE ano:
  //   { ticker, currency, year, fxmodel, base:{ebitda,net_debt,fcf,dividends,mktcap,shares,price},
  //     axes:[{id,label,unit,base,min,max,kind,live,source}], num(pt,fx)->{...}, published:{...} }
  // base numeradores + published: EXATOS por ano (label × coluna-do-ano). Slopes: exatos p/
  // aços+Vale, aprox. p/ commodities (base sempre bate → gate passa).
  // ===========================================================================
  var RECIPES = {

    CSNA3: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C'), D = aoa(wb, 'DCF');
      if (!O || !F || !R || !D) return { error: 'CSN: aba faltando (OUTPUT/FCF/R&C/DCF)' };
      var oc = colForYear(O, year), fc = colForYear(F, year), rc = colForYear(R, year), dc = colForYear(D, year);
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, oc), nd = valYear(O, /Net Debt Adj/i, oc),
          minor = valYear(O, /^Minorities/i, oc), fcf0 = valYear(F, /FCF Generation/i, fc);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var domg0 = atRC(R, 60, rc), expg0 = atRC(R, 61, rc), domrev = atRC(R, 32, rc), exprev = atRC(R, 33, rc);
      var sga = Math.abs(atRC(R, 70, rc) || 0), ctax = Math.abs(atRC(D, 19, dc) || 0);
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'CSN: numerador-base nulo (' + year + ')' };
      var sdom = (1 - sga) * (domrev || 0) / (1 + (domg0 || 0)), sexp = (1 - sga) * (exprev || 0) / (1 + (expg0 || 0)), ndm = nd + (minor || 0);
      function num(pt, fx) { var dE = sdom * (pt.dom - domg0) + sexp * (pt.exp - expg0);
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * (1 - ctax), dividends: 0 }; }
      return { ticker: 'CSNA3', currency: 'BRL', year: year, fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: 0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'dom', label: 'Domestic steel price growth', unit: '%', base: domg0, min: -0.05, max: 0.15, kind: 'growth', live: false },
                { id: 'exp', label: 'Export steel price growth', unit: '%', base: expg0, min: -0.05, max: 0.15, kind: 'growth', live: false } ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: 0 },
        notes: 'Só a siderurgia move (1 de 8 segmentos). Dividendo 0 no forecast → Div Yield 0%.' };
    },

    USIM5: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), S = aoa(wb, 'Steel'), M = aoa(wb, 'Model'), D = aoa(wb, 'DCF');
      if (!O || !F || !S || !M || !D) return { error: 'USIM: aba faltando' };
      var oc = colForYear(O, year), fc = colForYear(F, year), sc = colForYear(S, year), mc = colForYear(M, year), dc = colForYear(D, year);
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, oc), nd = valYear(O, /Net Debt \(incl/i, oc),
          minor = atRC(M, 294, mc), fcf0 = valYear(F, /FCF Generation/i, fc);
      var shares = a1(O, 'C11'), price = a1(O, 'C7'), mktcap = a1(O, 'C12');
      var domg0 = atRC(S, 142, sc), vol = atRC(S, 95, sc), prior = atRC(S, 117, sc - 1), ctax = Math.abs(atRC(D, 19, dc) || 0);
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'USIM: numerador-base nulo (' + year + ')' };
      var sdom = (prior != null && vol != null) ? prior * vol / 1000 : 0, ndm = nd + (minor || 0);
      function num(pt, fx) { var dE = sdom * (pt.dom - domg0);
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * (1 - ctax), dividends: 0 }; }
      return { ticker: 'USIM5', currency: 'BRL', year: year, fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: 0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'dom', label: 'Domestic steel price growth', unit: '%', base: domg0, min: -0.03, max: 0.12, kind: 'growth', live: false } ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: 0 },
        notes: 'Alta alavancagem. Downside -3% (imposto sem floor). Dividendo defasado (ano anterior) → Div Yield ~0.' };
    },

    GGBR4: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C'), M = aoa(wb, 'Model');
      if (!O || !F || !R || !M) return { error: 'GGBR: aba faltando' };
      var oc = colForYear(O, year), fc = colForYear(F, year), rc = colForYear(R, year), mc = colForYear(M, year);
      var ebcons0 = atRC(O, 21, oc), sa = atRC(O, 18, oc), adj = atRC(O, 20, oc), nd = atRC(O, 62, oc), m = atRC(M, 347, mc);
      var fcf0 = valYear(F, /FCF Generation/i, fc), payout = atRC(M, 220, mc), ni0 = atRC(M, 142, mc), ctax = Math.abs(atRC(O, 48, oc) || 0);
      var br_rev = atRC(R, 19, rc), na_rev = atRC(R, 22, rc), br_m0 = atRC(R, 271, rc), na_m0 = atRC(R, 272, rc), fxm = atRC(R, 8, rc);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      if (ebcons0 == null || nd == null || fcf0 == null || mktcap == null || !fxm) return { error: 'GGBR: numerador-base nulo (' + year + ')' };
      var saadj = (sa || 0) + (adj || 0), one = 1 + (m || 0);
      function num(pt, fx) { var ebcons = pt.br * br_rev + pt.na * na_rev * (fx / fxm) + saadj;
        var dE = ebcons - ebcons0, ni = ni0 + dE * (1 - ctax);
        return { ebitda: ebcons * one, net_debt: nd * one, fcf: fcf0 + dE * (1 - ctax), dividends: payout * ni }; }
      return { ticker: 'GGBR4', currency: 'BRL', year: year, fxmodel: fxm,
        base: { ebitda: ebcons0 * one, net_debt: nd * one, fcf: fcf0, dividends: payout * ni0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'br', label: 'Brazil EBITDA margin', unit: '%', base: br_m0, min: 0.08, max: 0.15, kind: 'margin', live: false },
                { id: 'na', label: 'North America EBITDA margin', unit: '%', base: na_m0, min: 0.18, max: 0.28, kind: 'margin', live: false },
                { id: 'fx', label: 'USD/BRL', unit: 'BRL/USD', base: fxm, min: 4.5, max: 6.5, kind: 'fx', live: true, source: 'fx_usdbrl' } ],
        num: num,
        published: { ev_ebitda: atRC(O, 79, oc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (atRC(O, 46, oc) || 0) * 100 },
        notes: 'Margens sintéticas = margem×receita do segmento. NA (USD) → USD/BRL ao vivo. Múltiplo "Adj." (×(1+minoritários)).' };
    },

    VALE3: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), I = aoa(wb, 'Iron Ore Price Forecast');
      if (!O) return { error: 'Vale: aba OUTPUT faltando' };
      var oc = colForYear(O, year), ic = I ? colForYear(I, year) : -1;
      var ebitda0 = valYear(O, /^Proforma EBITDA/i, oc), nd = valYear(O, /Expanded Net Debt/i, oc),
          minor = valYear(O, /^Minorities/i, oc), fcf0 = valYear(O, /\(=\) FCFF/i, oc), div0 = valYear(O, /^Dividends$/i, oc);
      var shares = a1(O, 'I11'), price = a1(O, 'I7'), mktcap = a1(O, 'I12');
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'Vale: numerador-base nulo (' + year + ')' };
      var ndm = nd + (minor || 0);
      var P0 = valYear(I, /Prices - Spot/i, ic) || 102.5, V0 = 320.358;   // preço 61% por ano (modelo); volume flat (bilinear)
      var dEdP = 270.49, dEdV = 43.70, crossPV = 0.856, fcfK = 1 - 0.196, divK = 0.15;
      function num(pt, fx) { var dP = pt.price - P0, dV = pt.vol - V0, dE = dEdP * dP + dEdV * dV + crossPV * dP * dV;
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: (div0 || 0) + dE * divK }; }
      return { ticker: 'VALE3', currency: 'USD', year: year, fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'price', label: 'Iron ore 61% Fe price', unit: 'USD/t', base: P0, min: 80, max: 130, kind: 'price', live: true, source: 'iron_ore_61' },
                { id: 'vol', label: 'Iron ore sales volume', unit: 'Mt', base: V0, min: 280, max: 360, kind: 'volume', live: false } ],
        num: num,
        published: { ev_ebitda: valYear(O, /^EV\/EBITDA \(x/i, oc), fcf_yield: (valYear(O, /^FCFF Yield/i, oc) || 0) * 100, div_yield: (valYear(O, /^Dividend Yield \(incl/i, oc) || 0) * 100 },
        notes: 'Modelo em USD (ação BRL — mktcap converte ao vivo). Só ferrosos move; bilinear validado vs a aba Sensitivity. USD/BRL via o market cap ao vivo.' };
    },

    CMIN3: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), I = aoa(wb, 'Iron Ore Price Forecast');
      if (!O || !F) return { error: 'CMIN: aba faltando' };
      var oc = colForYear(O, year), fc = colForYear(F, year), ic = I ? colForYear(I, year) : -1;
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, oc), nd = valYear(O, /^Net Debt$/i, oc), minor = valYear(O, /^Minorities/i, oc),
          fcf0 = valYear(F, /FCF Generation/i, fc), div0 = Math.abs(valYear(F, /^\(-\) Dividends/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var fx0 = valYear(O, /BRL\/USD - AVG/i, oc) || 5.30;
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'CMIN: numerador-base nulo (' + year + ')' };
      var ndm = nd + (minor || 0), P0 = valYear(I, /Prices - Spot/i, ic) || 100, s = 200, fcfK = 1 - 0.30;
      function num(pt, fx) { var eb = (ebitda0 + s * (pt.price - P0)) * (fx / fx0), dE = eb - ebitda0;
        return { ebitda: eb, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 }; }
      return { ticker: 'CMIN3', currency: 'BRL', year: year, fxmodel: fx0,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'price', label: 'Iron ore 61% Fe price', unit: 'USD/t', base: P0, min: 70, max: 130, kind: 'price', live: true, source: 'iron_ore_61' },
                { id: 'fx', label: 'USD/BRL', unit: 'BRL/USD', base: fx0, min: 4.5, max: 6.5, kind: 'fx', live: true, source: 'fx_usdbrl' } ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(F, /^Dividend Yield/i, fc) || 0) * 100 },
        notes: 'Minério-puro (BRL); EBITDA ∝ USD/BRL ao vivo. Inclinação ≈ +R$200mn/US$1t (aprox.). FCF reportado.' };
    },

    SUZB3: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C');
      if (!O || !F || !R) return { error: 'Suzano: aba faltando' };
      var oc = colForYear(O, year), fc = colForYear(F, year), rc = colForYear(R, year);
      var ebitda0 = valYear(O, /^EBITDA\s*\(BRL/i, oc), nd = valYear(O, /^Net Debt$/i, oc), minor = valYear(O, /^Minorities/i, oc),
          fcf0 = valYear(F, /FCF Generation/i, fc), div0 = Math.abs(valYear(F, /Dividends\/Buyback/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var fx0 = valYear(O, /BRL\/USD - AVG/i, oc) || 5.30;
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null) return { error: 'Suzano: numerador-base nulo (' + year + ')' };
      var ndm = nd + (minor || 0), B0 = atRC(R, 36, rc) || 590, s = 57, fcfK = 1 - 0.25;
      function num(pt, fx) { var eb = (ebitda0 + s * (pt.bhkp - B0)) * (fx / fx0), dE = eb - ebitda0;
        return { ebitda: eb, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 }; }
      return { ticker: 'SUZB3', currency: 'BRL', year: year, fxmodel: fx0,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'bhkp', label: 'BHKP hardwood pulp price', unit: 'USD/t', base: B0, min: 450, max: 800, kind: 'price', live: false },
                { id: 'fx', label: 'USD/BRL', unit: 'BRL/USD', base: fx0, min: 4.5, max: 6.5, kind: 'fx', live: true, source: 'fx_usdbrl' } ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(F, /^Dividend Yield/i, fc) || 0) * 100 },
        notes: 'Celulose-pura (BRL); EBITDA ∝ USD/BRL ao vivo. Inclinação ≈ +R$57mn/US$1t BHKP (aprox.).' };
    },

    KLBN11: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), R = aoa(wb, 'R&C');
      if (!O || !F || !R) return { error: 'Klabin: aba faltando' };
      var oc = colForYear(O, year), fc = colForYear(F, year), rc = colForYear(R, year);
      var ebitda0 = valYear(O, /Adj\. EBITDA\s*\(BRL/i, oc), nd = valYear(O, /^Net Debt$/i, oc), minor = valYear(O, /^Minorities/i, oc),
          fcf0 = valYear(F, /FCF Generation/i, fc), div0 = Math.abs(valYear(F, /^\(-\) Dividends/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var fx0 = valYear(O, /BRL\/USD - AVG/i, oc) || 5.30, pulp0 = atRC(R, 119, rc);
      if (ebitda0 == null || nd == null || fcf0 == null || mktcap == null || pulp0 == null) return { error: 'Klabin: numerador-base nulo (' + year + ')' };
      var ndm = nd + (minor || 0), paperConst = ebitda0 - pulp0;
      var B0 = atRC(R, 75, rc) || 590, SP0 = atRC(R, 85, rc) || 80, sB = 6.5, sS = 2.3, fcfK = 1 - 0.25;
      function num(pt, fx) { var pulp = (pulp0 + sB * (pt.bhkp - B0) + sS * (pt.spread - SP0)) * (fx / fx0);
        var eb = paperConst + pulp, dE = eb - ebitda0;
        return { ebitda: eb, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 }; }
      return { ticker: 'KLBN11', currency: 'BRL', year: year, fxmodel: fx0,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'bhkp', label: 'BHKP hardwood pulp price', unit: 'USD/t', base: B0, min: 450, max: 800, kind: 'price', live: false },
                { id: 'spread', label: 'Softwood–hardwood spread', unit: 'USD/t', base: SP0, min: 0, max: 160, kind: 'price', live: false },
                { id: 'fx', label: 'USD/BRL', unit: 'BRL/USD', base: fx0, min: 4.5, max: 6.5, kind: 'fx', live: true, source: 'fx_usdbrl' } ],
        num: num,
        published: { ev_ebitda: valYear(F, /^EV\/EBITDA/i, fc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(O, /^Dividend Yield/i, oc) || 0) * 100 },
        notes: 'Só a CELULOSE move (papel constante). BSKP = BHKP + spread. EBITDA da celulose ∝ USD/BRL. Aprox.' };
    },

    AURA33: function (wb, year) {
      var O = aoa(wb, 'OUTPUT'), F = aoa(wb, 'FCF'), M = aoa(wb, 'Model');
      if (!O || !F || !M) return { error: 'Aura: aba faltando' };
      var oc = colForYear(O, year), fc = colForYear(F, year), mc = colForYear(M, year);
      var ebitda0 = valYear(O, /Adjusted EBITDA/i, oc), evadj = valYear(O, /^EV Adjusted/i, oc),
          fcf0 = valYear(F, /FCF Generation/i, fc), div0 = Math.abs(valYear(F, /Dividends\/Buyback/i, fc) || 0);
      var shares = a1(O, 'F11'), price = a1(O, 'F7'), mktcap = a1(O, 'F12');
      var gold0 = valYear(M, /Gold\s*-\s*\(real/i, mc) || 5000, copper0 = valYear(M, /Copper\s*-\s*\(real/i, mc) || 5.85;
      if (ebitda0 == null || evadj == null || fcf0 == null || mktcap == null) return { error: 'Aura: numerador-base nulo (' + year + ')' };
      var ndm = evadj - mktcap, ozNet = 0.30, sCu = 32.5, fcfK = 1 - 0.25;
      function num(pt, fx) { var dE = ozNet * (pt.gold - gold0) + sCu * (pt.copper - copper0);
        return { ebitda: ebitda0 + dE, net_debt: ndm, fcf: fcf0 + dE * fcfK, dividends: div0 }; }
      return { ticker: 'AURA33', currency: 'USD', year: year, fxmodel: null,
        base: { ebitda: ebitda0, net_debt: ndm, fcf: fcf0, dividends: div0, mktcap: mktcap, shares: shares, price: price },
        axes: [ { id: 'gold', label: 'Gold price (real)', unit: 'USD/oz', base: gold0, min: 3500, max: 6000, kind: 'price', live: false },
                { id: 'copper', label: 'Copper price (real)', unit: 'USD/lb', base: copper0, min: 3.5, max: 7.0, kind: 'price', live: false } ],
        num: num,
        published: { ev_ebitda: valYear(O, /^EV\/EBITDA \(/i, oc), fcf_yield: (valYear(F, /^FCF Yield/i, fc) || 0) * 100, div_yield: (valYear(F, /Dividend.*Yield/i, fc) || 0) * 100 },
        notes: 'Modelo em USD (ação BRL — mktcap converte ao vivo). SOTP ouro; ouro em termos REAIS (≠ spot). EV ex-swap. Aprox.' };
    }

  };

  // mesh dos numeradores: 2^d cantos (multilinear → interp EXATO entre cantos) — FLAT por métrica
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
    return pts;
  }

  // gate: o base recomputado bate com o indicador PUBLICADO?
  function validate(rec) {
    var b = rec.base, p = rec.published || {}, diffs = [];
    var ev = (b.mktcap + b.net_debt) / b.ebitda, fy = b.fcf / b.mktcap * 100, dy = b.dividends / b.mktcap * 100;
    function chk(name, got, exp, tol) { if (exp == null) return; if (Math.abs(got - exp) > tol) diffs.push(name + ' ' + (rec.year || '') + ': ' + got.toFixed(3) + ' vs ' + exp.toFixed(3)); }
    chk('EV/EBITDA', ev, p.ev_ebitda, 0.02); chk('FCF Yield', fy, p.fcf_yield, 0.15); chk('Div Yield', dy, p.div_yield, 0.15);
    return { ok: diffs.length === 0, diffs: diffs, recomputed: { ev_ebitda: ev, fcf_yield: fy, div_yield: dy } };
  }

  // entrada: roda os 3 anos → per-year + campos legados (2026E) p/ compat com a UI atual.
  var YEARS = ['2026E', '2027E', '2028E'];
  function parseModel(wb, ticker) {
    var rf = RECIPES[ticker]; if (!rf) return { error: 'Sem receita Model Central p/ ' + ticker };
    var per = [];
    for (var i = 0; i < YEARS.length; i++) {
      var r = rf(wb, YEARS[i]);
      if (r.error) { if (i === 0) return r; else break; }   // 2026E obrigatório; anos seguintes opcionais
      r.mesh = buildMesh(r); r.gate = validate(r);
      per.push(r);
    }
    if (!per.length) return { error: 'Model Central: nada lido p/ ' + ticker };
    var d0 = per[0];
    var drivers = d0.axes.map(function (a, idx) {
      return { id: a.id, label: a.label, unit: a.unit, min: a.min, max: a.max, kind: a.kind, live: a.live, source: a.source,
               baseByYear: per.map(function (p) { return p.axes[idx] ? p.axes[idx].base : a.base; }) };
    });
    var overallOk = per.every(function (p) { return p.gate.ok; });
    return {
      ticker: ticker, currency: d0.currency, fxmodel: d0.fxmodel, notes: d0.notes,
      years: per.map(function (p) { return p.year; }),
      drivers: drivers,
      baseByYear: per.map(function (p) { return p.base; }),
      meshByYear: per.map(function (p) { return p.mesh; }),
      publishedByYear: per.map(function (p) { return p.published; }),
      gateByYear: per.map(function (p) { return { year: p.year, ok: p.gate.ok, diffs: p.gate.diffs, recomputed: p.gate.recomputed }; }),
      // ── legado (2026E) p/ compat com o admin/super-aba atuais ──
      base: d0.base, axes: d0.axes, mesh: d0.mesh, published: d0.published,
      gate: { ok: overallOk, diffs: [].concat.apply([], per.map(function (p) { return p.gate.diffs; })), recomputed: d0.gate.recomputed }
    };
  }

  var MC = {
    cellNum: cellNum, colForYear: colForYear, findRow: findRow, a1: a1, atRC: atRC, aoa: aoa,
    RECIPES: RECIPES, TICKERS: Object.keys(RECIPES), YEARS: YEARS,
    buildMesh: buildMesh, validate: validate, parseModel: parseModel
  };
  root.MC = MC;
  if (typeof module !== 'undefined' && module.exports) module.exports = MC;
})(typeof window !== 'undefined' ? window : globalThis);
