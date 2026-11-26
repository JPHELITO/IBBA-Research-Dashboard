/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — PRICES: seções de preço em frequência DIÁRIA / SEMANAL
   ────────────────────────────────────────────────────────────────────────────
   Carrega DEPOIS do data-desk.js e estende o motor (como o Builder). O motor da mesa trabalha em MESES
   (SECEX, IABr, IBÁ…); preço de mercado é diário/semanal e não cabe naquele eixo — por isso estas seções
   (`hf:{…}` no catálogo da página) têm o seu desenho, com as MESMAS peças: quadros do topo que são botões,
   palco, painel Reading ao lado e a faixa de Context.

   · Dado: tabela `commodities` (coluna `daily`, só dos códigos pedidos) e, para a paridade de importação do
     aço, a função `get_steel_parity()` (insumos semanais desde 2018; admin/supabase_market_prices.sql).
     Busca só quando a seção abre; guarda na sessão do navegador (20 min preços · 3 h paridade).
   · HISTÓRICO LONGO: o `commodities.daily` do robô só começou em jun/2026. O passado vem da tabela `price_history`
     (bases da Platts do analista: minério desde 2008, aço desde 2010), pela função `get_price_history` — pedida SÓ
     para as séries do indicador que está no gráfico (o quadro clicado busca o seu), num formato curto
     ({s: 1º dia, d: dias desde o ponto anterior, v: valores}), guardada 12 h na sessão. A página emenda as duas:
     o robô manda nos dias em que as duas têm valor. Sem a tabela, a seção segue só com o que o robô guarda.
   · Janela: os MESMOS botões da barra da página (YTD · 3M … All) e as datas livres. Granularidade não se
     aplica (o dado é mostrado na frequência em que é publicado).
   · UM gráfico, um eixo. Séries de um mesmo quadro têm sempre a mesma unidade.
   · Preço de agência (Platts) é dado PAGO: estas seções NÃO têm botão de Excel — só a imagem (PNG).
   · USINAS CHINESAS (hf.mills): a pesquisa semanal da Mysteel com 247 usinas (função `get_china_mills()`,
     admin/supabase_china_mills.sql — só responde a admin ou com a chave `china_mills` ligada). Agência paga: sem Excel.
   · SAZONALIDADE SEMANAL (M.season): uma linha por ano, as datas de cada ano postas num ano só (2000, bissexto); as
     cores e traços por ano são os do motor (X.yearStyle: laranja, tinta, e os outros pontilhados, cada um na sua cor) — o
     mesmo desenho da vista Seasonal mensal, com legenda.
     A janela da barra não se aplica (o gráfico mostra todos os anos).
   · SEMANAS SEM NÚMERO (usinas chinesas): levam a MÉDIA da semana anterior e da seguinte (pedido do usuário, 25/11/2026) —
     a linha não tem buraco; o painel Reading e o quadro "o boletim inteiro" marcam o número como estimativa (M.estAt).
     As médias, mínimas e máximas "desde 2021" usam só as leituras de verdade (P.millRaw).
   · FUROS (M.gapDays): onde ainda faltar ponto (série de outra fonte), o trecho entre dois pontos mais distantes que gapDays
     não é desenhado.
   · A conta da paridade é a da planilha do analista (CIF = (FOB + frete) × (1 + seguro); importado = CIF +
     tarifa + AFRMM + porto; prêmio = doméstico em US$ ÷ importado − 1). Conferida semana a semana contra a
     planilha em data-desk/ferramentas/paridade_dados.py.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var D = window.IBBADesk; if (!D || !D.x || D.x.Desk.prototype._hf) return;
  var X = D.x, Desk = X.Desk, esc = X.esc, fmt = X.fmt, h = X.h, ORANGE = X.ORANGE;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WIN_MO = { '3m': 3, '6m': 6, '1y': 12, '3y': 36, '5y': 60 };
  var TTL = { c: 20 * 6e4, p: 3 * 36e5, fx: 20 * 6e4, h: 12 * 36e5 };

  /* ══ (a) CONTAS PURAS (testadas em tests/test_data_desk.html) ═══════════════ */
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function dLabel(iso) { return +iso.slice(8, 10) + ' ' + MON[+iso.slice(5, 7) - 1] + ' ' + iso.slice(2, 4); }
  function mLabel(iso) { return MON[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4); }
  /* a mesma data, N meses antes/depois (31 de março − 1 mês = 28/29 de fevereiro) */
  function shift(iso, months) {
    var y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1 + months, d = +iso.slice(8, 10);
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + p2(m + 1) + '-' + p2(Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));
  }
  function days(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
  /* série do banco ([[unix, valor]…]) → [[aaaa-mm-dd, valor]…]: um ponto por dia (o último), em ordem */
  function fromDaily(daily) {
    var by = {}, out = [];
    (daily || []).forEach(function (p) { if (!p || p[1] == null || !isFinite(p[1])) return; var t = +p[0]; by[new Date(t < 2e10 ? t * 1000 : t).toISOString().slice(0, 10)] = +p[1]; });
    Object.keys(by).sort().forEach(function (k) { out.push([k, by[k]]); }); return out;
  }
  /* conta entre duas séries, só nos dias em que as DUAS têm valor */
  function combine(a, b, f) { var m = {}, out = []; (b || []).forEach(function (p) { m[p[0]] = p[1]; }); (a || []).forEach(function (p) { if (m[p[0]] != null) out.push([p[0], f(p[1], m[p[0]])]); }); return out; }
  /* último ponto em ou antes de uma data (as séries estão em ordem) */
  function at(pts, iso) { var lo = 0, hi = (pts || []).length - 1, r = null; while (lo <= hi) { var mid = (lo + hi) >> 1; if (pts[mid][0] <= iso) { r = pts[mid]; lo = mid + 1; } else hi = mid - 1; } return r; }
  /* várias séries num eixo só: a união das datas; onde uma série não tem valor fica vazio */
  function align(list) {
    var set = {}, dates; list.forEach(function (pts) { (pts || []).forEach(function (p) { set[p[0]] = 1; }); }); dates = Object.keys(set).sort();
    var ix = {}; dates.forEach(function (d, i) { ix[d] = i; });
    return { dates: dates, vals: list.map(function (pts) { var v = new Array(dates.length).fill(null); (pts || []).forEach(function (p) { v[ix[p[0]]] = p[1]; }); return v; }) };
  }
  /* janela [i0, i1] sobre as datas, pelos filtros da página */
  function win(dates, st) {
    var n = dates.length, i0 = 0, i1 = n - 1, from = null, to = null; if (!n) return [0, -1];
    var last = dates[n - 1];
    if (st.win === 'custom') { from = st.from ? st.from + '-01' : null; to = st.to ? st.to + '-31' : null; }
    else if (st.win === 'ytd') from = last.slice(0, 4) + '-01-01';
    else if (WIN_MO[st.win]) from = shift(last, -WIN_MO[st.win]);
    if (from) while (i0 < n - 1 && dates[i0] < from) i0++;
    if (to) while (i1 > 0 && dates[i1] > to) i1--;
    if (i0 > i1) i0 = i1; return [i0, i1];
  }
  function mean(pts) { var s = 0, n = 0; (pts || []).forEach(function (p) { if (p[1] != null) { s += p[1]; n++; } }); return n ? s / n : null; }
  /* histórico no formato curto da get_price_history → [[aaaa-mm-dd, valor]…] */
  function decodeHist(o) {
    var out = [], d = o && o.s ? Date.parse(o.s + 'T00:00:00Z') : NaN, dd = (o && o.d) || [], vv = (o && o.v) || [];
    if (!isFinite(d)) return out;
    for (var i = 0; i < vv.length; i++) { d += (+dd[i] || 0) * 864e5; if (vv[i] != null && isFinite(vv[i])) out.push([new Date(d).toISOString().slice(0, 10), +vv[i]]); }
    return out;
  }
  /* histórico + o que o robô guarda: a união dos dias; no mesmo dia vale o robô (é o dado mais novo) */
  function mergeHist(hist, live) {
    var by = {}, out = []; (hist || []).forEach(function (p) { by[p[0]] = p[1]; }); (live || []).forEach(function (p) { by[p[0]] = p[1]; });
    Object.keys(by).sort().forEach(function (k) { out.push([k, by[k]]); }); return out;
  }
  /* trimestre de uma data: rótulo como nas planilhas (4Q26), 1º e último dia */
  function qInfo(iso) {
    var y = +iso.slice(0, 4), q = Math.floor((+iso.slice(5, 7) - 1) / 3), m = q * 3 + 3;
    return { y: y, q: q, label: (q + 1) + 'Q' + String(y).slice(2), start: y + '-' + p2(q * 3 + 1) + '-01', end: y + '-' + p2(m) + '-' + p2(new Date(Date.UTC(y, m, 0)).getUTCDate()) };
  }
  function qBack(qi, n) { var t = qi.y * 4 + qi.q - n; return qInfo(Math.floor(t / 4) + '-' + p2((t % 4) * 3 + 1) + '-01'); }
  /* média simples dos pontos entre duas datas (inclusive) — a mesma conta da aba Q das bases da Platts */
  function avgIn(pts, a, b) { var s = 0, n = 0; (pts || []).forEach(function (p) { if (p[0] >= a && p[0] <= b && p[1] != null) { s += p[1]; n++; } }); return n ? s / n : null; }
  /* PARIDADE DE IMPORTAÇÃO — a conta da planilha do analista, a partir dos insumos de uma semana */
  function parity(r) {
    var cif = (r.fob + r.freight) * (1 + r.insurance), tv = cif * r.tariff, av = r.freight * r.afrmm, imp = cif + tv + av + r.port;
    var dom = (r.dom_brl != null && r.fx) ? r.dom_brl / r.fx : null;
    return { week: r.week, live: !!r.live, fob: r.fob, freight: r.freight, insurance: r.insurance, insV: cif - r.fob - r.freight, cif: cif, tariff: r.tariff, tariffV: tv, afrmm: r.afrmm, afrmmV: av, port: r.port,
      imported: imp, dom_brl: r.dom_brl, fx: r.fx, domUsd: dom, premium: dom == null ? null : (dom / imp - 1) * 100, premiumZero: dom == null ? null : (dom / (imp - tv) - 1) * 100 };
  }
  function parRow(a) { return { week: a[0], fob: +a[1], freight: +a[2], insurance: +a[3], tariff: +a[4], afrmm: +a[5], port: +a[6], dom_brl: a[7] == null ? null : +a[7], fx: a[8] == null ? null : +a[8] }; }
  /* ponto "ao vivo": a mesma conta com o preço e o câmbio de hoje, enquanto a semana não fecha (frete, tarifa, AFRMM e porto = os da última semana) */
  function liveRow(last, fobPts, domPts, fx) {
    var f = fobPts && fobPts.length ? fobPts[fobPts.length - 1] : null; if (!last || !f || !fx || f[0] <= last.week) return null;
    var d = at(domPts, f[0]);
    return { week: f[0], fob: f[1], freight: last.freight, insurance: last.insurance, tariff: last.tariff, afrmm: last.afrmm, port: last.port, dom_brl: d ? d[1] : last.dom_brl, fx: fx, live: true };
  }

  /* sazonalidade: a data num ano só (2000 é bissexto: 29/02 cabe) e o rótulo sem ano */
  function seasIso(iso) { return '2000' + iso.slice(4); }
  function sLabel(iso) { return +iso.slice(8, 10) + ' ' + MON[+iso.slice(5, 7) - 1]; }
  /* uma série por ano, do mais novo para o mais velho: [{name: '2026', pts: [[2000-mm-dd, v]…], est: {2000-mm-dd: 1}}…]
     (est: as datas que são estimativa — `est` vem com as datas de verdade) */
  function byYear(pts, n, est) {
    var by = {}, be = {}; (pts || []).forEach(function (p) { if (p[1] == null) return; var y = p[0].slice(0, 4); (by[y] = by[y] || []).push([seasIso(p[0]), p[1]]);
      if (est && est[p[0]]) (be[y] = be[y] || {})[seasIso(p[0])] = 1; });
    var ys = Object.keys(by).sort().reverse(); if (n) ys = ys.slice(0, n);
    return ys.map(function (y) { return { name: y, short: y, year: +y, pts: by[y], est: be[y] || {} }; });
  }
  /* o ponto de uma série numa data, aceitando o anterior até `tol` dias (semana sem leitura → null); near = só o valor */
  /* valor de uma série num dia qualquer: interpolado entre a leitura de antes e a de depois (até `tol` dias de cada lado) — a faixa da
     sazonalidade semanal compara anos cujas semanas caem em dias diferentes */
  function interpAt(pts, iso, tol) { var lo = 0, hi = (pts || []).length - 1, i = -1; while (lo <= hi) { var mid = (lo + hi) >> 1; if (pts[mid][0] <= iso) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0) return null; var b = pts[i]; if (b[0] === iso) return b[1]; var nx = pts[i + 1], d0 = days(b[0], iso); if (!nx) return d0 <= tol ? b[1] : null;
    var d1 = days(iso, nx[0]); if (d0 > tol || d1 > tol) return null; return b[1] + (nx[1] - b[1]) * d0 / (d0 + d1); }
  function nearPt(pts, iso, tol) { var b = at(pts, iso); return (b && days(b[0], iso) <= (tol == null ? 10 : tol)) ? b : null; }
  function near(pts, iso, tol) { var b = nearPt(pts, iso, tol); return b ? b[1] : null; }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  /* série SEMANAL sem buraco: cada semana que falta entre duas leituras leva a MÉDIA da leitura anterior e da seguinte (pedido
     do usuário, 25/11/2026: "coloque a média dos dois pontos antes e depois daquele que faltou"). Várias semanas seguidas levam
     a mesma média. Antes da 1ª e depois da última leitura não se inventa nada. → {pts, est: {aaaa-mm-dd: 1}} */
  function fillWeekly(pts) {
    var out = [], est = {}, i, d;
    for (i = 0; i < (pts || []).length; i++) {
      out.push(pts[i]); var b = pts[i + 1]; if (!b) break;
      var v = (pts[i][1] + b[1]) / 2;
      for (d = addDays(pts[i][0], 7); days(d, b[0]) >= 4; d = addDays(d, 7)) { out.push([d, v]); est[d] = 1; }
    }
    return { pts: out, est: est };
  }
  /* linhas da get_china_mills(): [semana, data do boletim, % com lucro, % altos-fornos ligados, % utilização, gusa kt/dia, tipo] */
  var MILL = { obs: 1, profit: 2, bfop: 3, bfutil: 4, hm: 5, kind: 6 };
  function millPts(rows, col) { var ix = MILL[col], out = []; (rows || []).forEach(function (r) { var v = r && r[ix]; if (v != null && v !== '' && isFinite(v)) out.push([String(r[0]).slice(0, 10), +v]); }); return out; }

  /* a série semanal em MESES para o Builder (que é mensal): a SOMA e o NÚMERO de semanas de cada mês — a página divide uma
     pela outra, então o mês é a média das suas semanas e o trimestre/ano/LTM a média das semanas do período. O mês da última
     leitura só entra quando a última sexta-feira dele já saiu (senão seria a média de um mês pela metade). */
  function monthly(pts) {
    var v = {}, n = {}, last = pts && pts.length ? pts[pts.length - 1][0] : null;
    var open = (last && addDays(last, 7).slice(0, 7) === last.slice(0, 7)) ? last.slice(0, 7) : null;
    (pts || []).forEach(function (p) { var m = p[0].slice(0, 7); if (m === open || p[1] == null) return; v[m] = (v[m] || 0) + p[1]; n[m] = (n[m] || 0) + 1; });
    return { v: v, n: n };
  }
  /* preço diário/semanal em MESES para o Builder: soma e número de pontos de cada mês (a página divide = a média do mês, e no
     trimestre/ano/LTM a média de todos os pontos do período). O mês corrente (Brasília) só entra quando termina. */
  function monthlyCal(pts, today) {
    var v = {}, n = {}, cur = (today || new Date(Date.now() - 3 * 36e5).toISOString()).slice(0, 7);
    (pts || []).forEach(function (p) { if (p[1] == null || !isFinite(p[1])) return; var m = p[0].slice(0, 7); if (m >= cur) return; v[m] = (v[m] || 0) + p[1]; n[m] = (n[m] || 0) + 1; });
    return { v: v, n: n };
  }
  /* a coluna das usinas uma vez por versão dos dados: as leituras, a série completa e as semanas estimadas */
  function millC(S, col) {
    if (S._millV !== S.v) { S._mill = {}; S._millV = S.v; }
    var c0 = S._mill[col]; if (c0) return c0;
    var raw = millPts(S.mills, col), f = fillWeekly(raw);
    return (S._mill[col] = { raw: raw, pts: f.pts, est: f.est, mo: monthly(f.pts) });
  }

  /* o que o catálogo da página usa para montar as séries */
  var P = {
    d: function (S, code) {
      var r = S.daily[code], hh = S.hist && S.hist[code];
      if (!hh || !hh.length) return r ? r.pts : [];
      if (!r || !r.pts.length) return hh;
      var m = S._m || (S._m = {}); if (m[code] && m[code].v === S.v) return m[code].p;
      var out = mergeHist(hh, r.pts); m[code] = { v: S.v, p: out }; return out;
    },
    meta: function (S, code) { return S.daily[code] || null; },
    sub: function (a, b) { return combine(a, b, function (x, y) { return x - y; }); },
    combine: combine, at: at, mean: mean, mLabel: mLabel, dLabel: dLabel, sLabel: sLabel, fmt: fmt, byYear: byYear, near: near, days: days, shift: shift,
    /* usinas chinesas: a coluna pedida ('profit' | 'bfop' | 'bfutil' | 'hm') como [[semana, valor]…], SEM buraco (fillWeekly);
       millRaw = só as leituras; millEst = as semanas estimadas; millAt = {v, est} numa semana exata; millRow = a linha da semana */
    mill: function (S, col) { return millC(S, col).pts; },
    millRaw: function (S, col) { return millC(S, col).raw; },
    millEst: function (S, col) { return millC(S, col).est; },
    millMonthly: function (S, col) { return millC(S, col).mo; },   // {v: soma das semanas, n: semanas} por 'AAAA-MM' (Builder)
    millAt: function (S, col, iso) { var c0 = millC(S, col), b = at(c0.pts, iso); return (b && b[0] === iso) ? { v: b[1], est: !!c0.est[iso] } : null; },
    millRow: function (S, iso) { var r = null; (S.mills || []).forEach(function (x) { if (String(x[0]).slice(0, 10) <= iso) r = x; }); return r; },
    /* linhas da paridade de um produto ('hrc' | 'rebar'), já com a conta feita e o ponto ao vivo no fim */
    par: function (S, prod) {
      if (S._parV !== S.v) { S._par = {}; S._parV = S.v; }   // um cache por versão dos dados (a velha sai)
      var k = prod; if (S._par[k]) return S._par[k];
      var raw = (S.parity && S.parity[prod]) || [], rows = raw.map(parRow), c = (S.parCodes || {})[prod] || {};
      var lv = rows.length ? liveRow(rows[rows.length - 1], P.d(S, c.fob), P.d(S, c.dom), S.fx) : null; if (lv) rows.push(lv);
      return (S._par[k] = rows.map(parity));
    },
    col: function (rows, f) { var out = []; rows.forEach(function (r) { if (r[f] != null && isFinite(r[f])) out.push([r.week, r[f]]); }); return out; },
    rowAt: function (rows, iso) { var r = null; for (var i = 0; i < rows.length && rows[i].week <= iso; i++) r = rows[i]; return r; }
  };

  /* ══ (b) DADOS ═════════════════════════════════════════════════════════════ */
  function cGet(k, ttl) { try { var o = JSON.parse(sessionStorage.getItem('ibba_dkhf:' + k) || 'null'); return (o && Date.now() - o.t < ttl) ? o.d : null; } catch (e) { return null; } }
  function cSet(k, d) { try { sessionStorage.setItem('ibba_dkhf:' + k, JSON.stringify({ t: Date.now(), d: d })); } catch (e) {} }
  Desk.prototype._hfStore = function () { return this._hfS || (this._hfS = { daily: {}, hist: {}, parity: null, fx: null, mills: null, v: 0, miss: {}, failed: false }); };
  /* os códigos que um indicador usa (para pedir o histórico só deles): roda a conta dele com um P que anota cada P.d */
  Desk.prototype._hfCodes = function (M) {
    var k = this.cur + '.' + M.id; this._hfCodesC = this._hfCodesC || {}; if (this._hfCodesC[k]) return this._hfCodesC[k];
    var seen = {}, spy = {}, f; for (f in P) spy[f] = P[f];
    spy.d = function (S0, c) { if (c) seen[c] = 1; return P.d(S0, c); };
    try { M.series(this._hfStore(), spy); } catch (e) {}
    return (this._hfCodesC[k] = Object.keys(seen));
  };
  /* devolve uma promessa enquanto falta algo desta seção/indicador; null quando está tudo em mãos (ou marcado como indisponível) */
  Desk.prototype._hfNeed = function (sec, M) {
    var S = this._hfStore(), cx = this.cfg.prices || this.cfg.context, self = this, hf = sec.hf, jobs = [];
    var codes = (hf.codes || []).concat((M && M.codes) || []).filter(function (c, i, a) { return a.indexOf(c) === i && !S.daily[c] && !S.miss[c]; });
    codes = codes.filter(function (c) { var r = cGet('c:' + c, TTL.c); if (!r) return true; S.daily[c] = r; S.v++; return false; });
    /* histórico longo: só das séries do indicador que está no gráfico (o resto pede quando for clicado) */
    var hcodes = (hf.history && M && !M.noHist) ? this._hfCodes(M).filter(function (c) { return S.hist[c] === undefined; }) : [];
    hcodes = hcodes.filter(function (c) { var r = cGet('h:' + c, TTL.h); if (!r) return true; S.hist[c] = decodeHist(r); S.v++; return false; });
    var needP = !!hf.parity && S.parity == null, needF = !!hf.parity && S.fx == null, c0;
    if (needP && (c0 = cGet('p', TTL.p))) { S.parity = c0; S.v++; needP = false; }
    if (needF && (c0 = cGet('fx', TTL.fx)) != null) { S.fx = c0; S.v++; needF = false; }
    var needM = !!hf.mills && S.mills == null;
    if (needM && (c0 = cGet('m', TTL.p))) { S.mills = c0; S.v++; needM = false; }
    if (!codes.length && !hcodes.length && !needP && !needF && !needM) return null;
    if (!cx || !cx.get) { codes.forEach(function (c) { S.miss[c] = 1; }); hcodes.forEach(function (c) { S.hist[c] = []; }); if (needP) S.parity = {}; if (needF) S.fx = 0; if (needM) S.mills = []; S.failed = true; return null; }
    var key = codes.join(',') + '|' + hcodes.join(',') + '|' + (needP ? 'p' : '') + (needF ? 'f' : '') + (needM ? 'm' : ''); this._hfP = this._hfP || {};
    if (this._hfP[key]) return this._hfP[key];
    if (codes.length) jobs.push(Promise.resolve(cx.get('commodities?select=code,name,unit,price,change_pct,assessed_at,updated_at,daily&code=in.(' + codes.join(',') + ')')).then(function (rows) {
      (rows || []).forEach(function (r) { var o = { code: r.code, name: r.name, unit: r.unit, price: r.price, when: r.assessed_at || r.updated_at || null, pts: fromDaily(r.daily) }; if (!o.pts.length) return; S.daily[r.code] = o; cSet('c:' + r.code, o); });
      codes.forEach(function (c) { if (!S.daily[c]) S.miss[c] = 1; }); if (!rows) S.failed = true;
    }, function () { codes.forEach(function (c) { S.miss[c] = 1; }); S.failed = true; }));
    /* sem a tabela (SQL não rodado) ou sem rede: [] = "não tem histórico" nesta sessão — a série segue com o que o robô guarda */
    if (hcodes.length) jobs.push(Promise.resolve(cx.get('rpc/get_price_history?p_codes=' + encodeURIComponent('{' + hcodes.join(',') + '}'))).then(function (d) {
      hcodes.forEach(function (c) { var o = d && d[c]; S.hist[c] = o ? decodeHist(o) : []; if (o) cSet('h:' + c, o); });
    }, function () { hcodes.forEach(function (c) { S.hist[c] = []; }); }));
    /* a tabela da paridade pode ainda não existir (SQL não rodado): a seção segue só com os preços */
    if (needP) jobs.push(Promise.resolve(cx.rpc ? cx.rpc('get_steel_parity') : null).then(function (d) { S.parity = (d && typeof d === 'object') ? d : {}; if (d && (d.hrc || d.rebar)) cSet('p', S.parity); }, function () { S.parity = {}; }));
    /* usinas chinesas: a função só responde a admin ou com a chave china_mills ligada — recusa = [] (a seção diz que não está disponível) */
    if (needM) jobs.push(Promise.resolve(cx.rpc ? cx.rpc('get_china_mills') : null).then(function (d) { S.mills = Array.isArray(d) ? d : []; if (S.mills.length) cSet('m', S.mills); }, function () { S.mills = []; }));
    if (needF) jobs.push(Promise.resolve(cx.get('macro_indicators?select=code,value&code=eq.USD_BRL')).then(function (r) { S.fx = (r && r[0] && +r[0].value) || 0; if (S.fx) cSet('fx', S.fx); }, function () { S.fx = 0; }));
    return (this._hfP[key] = Promise.all(jobs).then(function () { delete self._hfP[key]; S.v++; }));
  };

  /* Builder e outras telas mensais: pede a pesquisa das usinas se ela ainda não chegou (promessa) — null quando já está em mãos
     (ou quando o banco recusou: sem a chave china_mills o cliente recebe [] e nada mais é pedido nesta visita) */
  Desk.prototype.millsNeed = function () { var S = this._hfStore(); return S.mills != null ? null : this._hfNeed({ hf: { mills: true } }, null); };
  Desk.prototype.millsStore = function () { return this._hfStore(); };
  /* Builder: pede SÓ os preços das séries que estão no gráfico — a linha diária (commodities), o histórico longo (price_history)
     e, se for o caso, a paridade semanal. null = tudo em mãos. Mesmo caminho e mesmo cache das seções de preço. */
  Desk.prototype.pricesNeed = function (codes, parity) {
    codes = (codes || []).filter(function (c, i, a) { return c && a.indexOf(c) === i; }); if (!codes.length && !parity) return null;
    var M = { id: 'b:' + codes.join(','), series: function (S0, P0) { codes.forEach(function (c) { P0.d(S0, c); }); return []; } };
    return this._hfNeed({ hf: { codes: codes, history: true, parity: !!parity } }, M);
  };
  Desk.prototype.pricesStore = function () { return this._hfStore(); };

  /* ══ (c) INTERFACE ═════════════════════════════════════════════════════════ */
  /* cores da sazonalidade: o ano mais novo laranja, o anterior cinza cheio, os outros cinza mais claro (tracejados no gráfico) */
  function seasColors(n) { var out = []; for (var k = 0; k < n; k++) out.push(X.yearColor ? X.yearColor(k) : ORANGE); return out; }
  function palette() { return X.isDark() ? [ORANGE, '#e8eaed', '#5b8fd6', '#3fb8a8', '#c9b47a', '#a892d6'] : [ORANGE, '#111111', '#3f72b5', '#2a9d8f', '#b79a5c', '#8a6fb3']; }
  function num(v, dec, signed) { if (v == null || !isFinite(v)) return '—'; return (signed && v > 0 ? '+' : '') + fmt(v, dec).replace(/^-/, '−'); }
  /* % que pode ser negativa (um prêmio) leva sinal; % que não pode (usinas com lucro, utilização) não */
  function sg(M) { return !!M.pp && !M.nosign; }
  function chg(M, a, b) { if (a == null || b == null) return null; return (M.pp || M.diff) ? a - b : (b ? (a / b - 1) * 100 : null); }   // % vira pontos (pp); spread vira diferença; preço vira %
  function chgTxt(M, v) { if (v == null || !isFinite(v)) return '—'; var s = v > 0 ? '+' : v < 0 ? '−' : ''; return M.pp ? s + Math.abs(v).toFixed(1) + ' pp' : M.diff ? s + fmt(Math.abs(v), M.dec || 0) : s + Math.abs(v).toFixed(1) + '%'; }
  function sparkOne(v, w, hh) {
    var pts = [], i; for (i = 0; i < v.length; i++) if (v[i] != null) pts.push([i, v[i]]); if (pts.length < 2) return '';
    var mn = Math.min.apply(null, pts.map(function (p) { return p[1]; })), mx = Math.max.apply(null, pts.map(function (p) { return p[1]; })), n = v.length - 1;
    var fx = function (i2) { return 2 + i2 / n * (w - 4); }, fy = function (y) { return hh - 2 - (mx > mn ? (y - mn) / (mx - mn) : .5) * (hh - 4); };
    var d = pts.map(function (p, j) { return (j ? 'L' : 'M') + fx(p[0]).toFixed(1) + ' ' + fy(p[1]).toFixed(1); }).join(''), lp = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="' + fx(lp[0]).toFixed(1) + '" cy="' + fy(lp[1]).toFixed(1) + '" r="2.2" fill="' + ORANGE + '"/></svg>';
  }
  function sparkMany(list, w, hh) {
    var all = [], n = 0; list.forEach(function (s) { n = Math.max(n, s.v.length - 1); s.v.forEach(function (x) { if (x != null) all.push(x); }); }); if (all.length < 2 || n < 1) return '';
    var mn = Math.min.apply(null, all), mx = Math.max.apply(null, all), fx = function (i) { return 2 + i / n * (w - 4); }, fy = function (y) { return hh - 2 - (mx > mn ? (y - mn) / (mx - mn) : .5) * (hh - 4); };
    return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="none" aria-hidden="true">' + list.map(function (s) { var d = '', on = false;
      s.v.forEach(function (x, i) { if (x == null) return; d += (on ? 'L' : 'M') + fx(i).toFixed(1) + ' ' + fy(x).toFixed(1); on = true; });
      return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>'; }).join('') + '</svg>';
  }
  /* faixa de referência, linha do zero e linhas de referência (média histórica…) — anotações fixas do gráfico, não aparecem com o mouse */
  var refPlugin = {
    id: 'ibbaHfRefs',
    beforeDatasetsDraw: function (chart) {
      var R = chart.$hfRefs, a = chart.chartArea, ys = chart.scales.y; if (!R || !a || !ys) return;
      var t = D.theme(), c = chart.ctx, px = function (v) { return Math.max(a.top, Math.min(a.bottom, ys.getPixelForValue(v))); };
      c.save();
      if (R.band) { var y1 = px(R.band.hi), y2 = px(R.band.lo); if (y2 - y1 > 0.5) { c.fillStyle = 'rgba(' + t.band + ',' + (t.dark ? .09 : .06) + ')'; c.fillRect(a.left, y1, a.width, y2 - y1); } }
      if (R.zero && ys.min < 0 && ys.max > 0) { c.beginPath(); c.moveTo(a.left, px(0)); c.lineTo(a.right, px(0)); c.lineWidth = 1; c.strokeStyle = 'rgba(' + t.band + ',' + (t.dark ? .5 : .42) + ')'; c.stroke(); }
      (R.lines || []).forEach(function (l) { if (l.value == null || l.value < ys.min || l.value > ys.max) return; var y = px(l.value);
        c.beginPath(); c.setLineDash([5, 4]); c.moveTo(a.left, y); c.lineTo(a.right, y); c.lineWidth = 1.2; c.strokeStyle = t.mut; c.stroke(); c.setLineDash([]); });
      c.restore();
    }
  };
  var _reg = false; function ensureRefs() { if (_reg || !window.Chart) return; Chart.register(refPlugin); _reg = true; }

  Desk.prototype._hfM = function (id) { var ms = this.sections[this.cur].hf.metrics || []; for (var i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i]; return null; };
  /* séries de um indicador, calculadas uma vez por versão dos dados: [{name, short, pts}] (a 1ª é a principal) */
  Desk.prototype._hfSeries = function (M) {
    var S = this._hfStore(), k = this.cur + '.' + M.id; if (this._hfCv !== S.v) { this._hfC = {}; this._hfCv = S.v; }   // um cache por versão dos dados
    if (this._hfC[k]) return this._hfC[k];
    var out; try { out = (M.series(S, P) || []).filter(function (s) { return s && s.pts && s.pts.length; }); } catch (e) { console.warn('desk prices', M.id, e); out = []; }
    return (this._hfC[k] = out);
  };
  Desk.prototype._hfBuild = function () {
    var r = this.root, self = this, sec = this.sections[this.cur]; r.innerHTML = '';
    var body = h('div', 'dk-body dk-hf'), E = this.el = { body: body, tiles: h('div', 'dk-tiles'), cols: h('div', 'dk-cols'), ctx: h('div', 'dk-ctx0') };
    var vs = (sec.views || []).filter(function (v) { return !v.visible || v.visible(); });
    if (vs.length > 1) { var vb = h('div', 'dk-viewbar'), seg = h('div', 'dk-seg dk-views', vs.map(function (v, k) { return '<button type="button" data-k="' + k + '" aria-pressed="' + !!v.current + '">' + esc(v.label) + '</button>'; }).join(''));
      seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'View');
      seg.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var v = vs[+b.dataset.k]; if (v && v.onPick) v.onPick(); });
      vb.appendChild(seg); body.appendChild(vb); }
    E.msg = h('div', 'dk-hfmsg'); E.msg.hidden = true;
    E.stage = h('div', 'dk-stage dk-card dk-hfstage',
      '<div class="dk-sh"><div><div class="dk-st"></div><div class="dk-sv"></div></div><div class="dk-sd"></div><span class="dk-grow"></span><div class="dk-styw"></div></div>' +
      '<div class="dk-hfdl"><button type="button" title="Download the chart as an image">PNG</button></div>' +
      '<div class="dk-hfleg"></div><div class="dk-whyrow"><div class="dk-why" hidden></div><div class="dk-corr" hidden></div></div><div class="dk-chart dk-stagechart"><canvas></canvas></div>' +
      '<div class="dk-hintrow"><div class="dk-hint">Hover to read any date · Change the period with the Window buttons or the dates above</div><div class="dk-hint dk-hfsrc"></div></div>');
    E.read = h('div', 'dk-card dk-read dk-hfread', '<div class="dk-ch"><h3>Reading</h3><em class="dk-when"></em></div><div class="dk-big"></div><div class="dk-kv"></div>');
    /* a conta aberta, parcela por parcela, na data lida (paridade: FOB + frete + … = importado; margem: preço − frete) */
    E.build = h('div', 'dk-card dk-hfbuild', '<div class="dk-ch"><h3></h3><em class="dk-when"></em></div><div class="dk-eq"></div>'); E.build.hidden = true;
    E.cols.appendChild(E.stage); E.cols.appendChild(E.read);
    body.appendChild(E.msg); body.appendChild(E.tiles); body.appendChild(E.cols); body.appendChild(E.build); body.appendChild(E.ctx); r.appendChild(body);
    E.tiles.addEventListener('click', function (e) { var b = e.target.closest('.dk-tile[data-k]'); if (!b) return; var u = self._u(); u.metric = b.dataset.k; u.hover = null; self._hf(); });
    E.msg.addEventListener('click', function (e) { if (!e.target.closest('button')) return; var S = self._hfStore(), c; S.miss = {}; S.failed = false; if (S.parity && !S.parity.hrc && !S.parity.rebar) S.parity = null; if (!S.fx) S.fx = null; if (S.mills && !S.mills.length) S.mills = null;
      for (c in S.hist) if (!S.hist[c].length) delete S.hist[c];   // o histórico que não veio também é pedido de novo
      self._hf(); });
    E.stage.querySelector('.dk-hfdl button').addEventListener('click', function () { self._hfPNG(); });
    /* seletor "Chart": troca só o desenho (o dado é o mesmo) */
    E.stage.querySelector('.dk-styw').addEventListener('click', function (e) { var b = e.target.closest('button[data-sty]'); if (!b || b.disabled) return; self._setSty('hf', b.dataset.sty, self._hfOpts()); self._u().hover = null; self._hfStage(); });
    var box = E.stage.querySelector('.dk-chart');
    var move = function (e) { var ch = self.charts.hf, v = self._hfV; if (!ch || !v) return; var pt = e.touches ? e.touches[0] : e, rc = ch.canvas.getBoundingClientRect(), x = pt.clientX - rc.left, a = ch.chartArea;
      if (!a || x < a.left - 6 || x > a.right + 6) return self._hfHover(null);
      var i = Math.round(ch.scales.x.getValueForPixel(x)); self._hfHover(Math.max(0, Math.min(v.n - 1, i))); };
    box.addEventListener('mousemove', move); box.addEventListener('touchstart', move, { passive: true }); box.addEventListener('touchmove', move, { passive: true });
    box.addEventListener('mouseleave', function () { self._hfHover(null); });
  };
  Desk.prototype._hfHover = function (i) { var u = this._u(), self = this; if (u.hover === i) return; u.hover = i; if (this._hfRaf) return; this._hfRaf = requestAnimationFrame(function () { self._hfRaf = 0; self._hfPaint(); }); };

  /* a seção inteira */
  Desk.prototype._hf = function () {
    var id = this.cur, sec = this.sections[id], self = this, S = this._hfStore(); ensureRefs();
    if (sec.hf.parityCodes) S.parCodes = sec.hf.parityCodes;
    if (this._built !== id || !this.el || !this.el.body || !this.root.contains(this.el.body)) { this._destroyAll(); this._hfBuild(); this._built = id; }
    var u = this._u(); if (!this._hfM(u.metric)) u.metric = sec.stage || sec.hf.metrics[0].id;
    var wait = this._hfNeed(sec, this._hfM(u.metric)), E = this.el;
    if (wait) wait.then(function () { if (self.cur === id) self._hf(); });
    var any = (sec.hf.metrics || []).some(function (M) { return self._hfSeries(M).length; });
    if (wait && !any) { E.msg.hidden = false; E.msg.innerHTML = '<b>' + esc(sec.hf.loading || 'Loading prices…') + '</b>'; E.tiles.hidden = E.cols.hidden = E.build.hidden = true; return; }
    if (!any) { E.msg.hidden = false; E.msg.innerHTML = '<b>' + esc(sec.hf.na || 'Prices are not available right now.') + '</b><span>' + esc(sec.hf.naWhy || 'The connection to the price database did not answer.') + '</span><button type="button" class="dk-pill">Try again</button>'; E.tiles.hidden = E.cols.hidden = E.build.hidden = true; return; }
    E.msg.hidden = true; E.msg.innerHTML = ''; E.tiles.hidden = E.cols.hidden = false;
    /* o indicador escolhido ficou sem dado (ex.: paridade ainda sem tabela)? cai no primeiro que tem */
    if (!this._hfSeries(this._hfM(u.metric)).length && !wait) { var ok = (sec.hf.tiles || []).map(function (t) { return self._hfM(t); }).filter(function (M) { return M && self._hfSeries(M).length; })[0];
      if (ok) { u.metric = ok.id; var w2 = this._hfNeed(sec, ok); if (w2) w2.then(function () { if (self.cur === id) self._hf(); }); } }
    this._hfTiles(); this._hfStage(); if (this._context) this._context();
    if (this._uBase) this._uBase();   // ↺ Reset: linha de base da seção (data-desk.js)
  };

  /* quadros do topo: cada um é um BOTÃO que põe o indicador no gráfico principal */
  Desk.prototype._hfTiles = function () {
    var sec = this.sections[this.cur], u = this._u(), self = this, pal = palette();
    var act = '<div class="dk-ta"><i></i><span class="dk-ta0">Show on chart</span><span class="dk-ta1">On the main chart</span></div>';
    var tipOf = function (M0) { var hp = self._help(self.cur, M0.id, {}); return ((hp && hp.what) ? hp.what + '\n\n' : '') + 'Click to show it on the main chart.'; };
    this.el.tiles.innerHTML = (sec.hf.tiles || []).map(function (id) {
      var M = self._hfM(id); if (!M) return ''; var ser = self._hfSeries(M);
      var S0 = self._hfStore(), lazy = !ser.length && (M.codes || []).some(function (c) { return !S0.daily[c] && !S0.miss[c]; });
      if (lazy) return '<button type="button" class="dk-tile dk-tlazy" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '" title="' + esc(tipOf(M)) + '"><div class="dk-tl"><span>' + esc(M.short || M.label) + '</span></div><div class="dk-tv dk-tvs">' + esc(M.lazyText || 'Long history') + '</div><div class="dk-td">' + esc(M.lazyNote || 'Loaded when you open it') + '</div>' + act + '</button>';
      if (!ser.length) { if (M.hideNA) return ''; return '<div class="dk-tile dk-off"><div class="dk-tl"><span>' + esc(M.short || M.label) + '</span></div><div class="dk-tv">—</div><div class="dk-td">' + esc(M.naText || 'Not available yet') + '</div></div>'; }
      var main = ser[0].pts, last = main[main.length - 1], from1y = shift(last[0], -12);
      if (M.season) {   // uma linha por ano: o valor de cada ano na MESMA semana do dado mais novo
        var nw = ser[0].pts, li = nw[nw.length - 1][0], cs = seasColors(ser.length), pv = nw.length > 1 ? nw[nw.length - 2] : null;
        var cW = (pv && days(pv[0], li) <= 10) ? chg(M, nw[nw.length - 1][1], pv[1]) : null, all = align(ser.map(function (s) { return s.pts; }));
        return '<button type="button" class="dk-tile dk-tmulti" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '" title="' + esc(tipOf(M)) + '"><div class="dk-tl"><span>' + esc(M.short || M.label) + ' <small class="dk-tu">' + esc(M.unit) + '</small></span><span>' + sLabel(li) + '</span></div>' +
          ser.slice(0, M.tileN || 3).map(function (s, k) { var x = near(s.pts, li);
            return '<div class="dk-tm"><i style="background:' + cs[k] + '"></i><span>' + esc(s.name) + '</span><b>' + num(x, M.dec, sg(M)) + '</b><span' + (k ? '>' : ' class="' + X.cls(cW) + '" title="Change in one week">' + chgTxt(M, cW)) + '</span></div>'; }).join('') +
          '<div class="dk-sp">' + sparkMany(all.vals.map(function (v, k) { return { v: v, color: cs[k] }; }).reverse(), 160, 30) + '</div>' + act + '</button>';
      }
      if (ser.length > 1 && !M.single) {   // várias séries da mesma unidade: uma linha por série
        var rows = ser.slice(0, M.tileN || 3), a = align(rows.map(function (s) { return s.pts.filter(function (p) { return p[0] >= from1y; }); }));
        return '<button type="button" class="dk-tile dk-tmulti" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '" title="' + esc(tipOf(M)) + '"><div class="dk-tl"><span>' + esc(M.short || M.label) + ' <small class="dk-tu">' + esc(M.unit) + '</small></span><span>' + dLabel(last[0]) + '</span></div>' +
          rows.map(function (s, k) { var l = s.pts[s.pts.length - 1], b = at(s.pts, shift(l[0], -1)), c1 = (b && days(b[0], shift(l[0], -1)) <= 10) ? chg(M, l[1], b[1]) : null;
            return '<div class="dk-tm"><i style="background:' + pal[k % pal.length] + '"></i><span>' + esc(s.short || s.name) + '</span><b>' + num(l[1], M.dec, sg(M)) + '</b><span class="' + X.cls(c1) + '" title="Change in one month">' + chgTxt(M, c1) + '</span></div>'; }).join('') +
          '<div class="dk-sp">' + sparkMany(a.vals.map(function (v, k) { return { v: v, color: pal[k % pal.length] }; }), 160, 30) + '</div>' + act + '</button>';
      }
      var prev = main.length > 1 ? main[main.length - 2] : null, step = prev ? days(prev[0], last[0]) : 1, b1 = at(main, shift(last[0], -1)), okM = b1 && days(b1[0], shift(last[0], -1)) <= 10;
      var c0 = prev ? chg(M, last[1], prev[1]) : null, cM = okM ? chg(M, last[1], b1[1]) : null, mn = Infinity, mx = -Infinity;
      main.forEach(function (p) { if (p[1] < mn) mn = p[1]; if (p[1] > mx) mx = p[1]; });
      var pos = mx > mn ? (last[1] - mn) / (mx - mn) : .5, sp = main.filter(function (p) { return p[0] >= from1y; }).map(function (p) { return p[1]; });
      return '<button type="button" class="dk-tile" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '" title="' + esc(tipOf(M)) + '"><div class="dk-tl"><span>' + esc(M.short || M.label) + '</span><span>' + dLabel(last[0]) + (M.liveOf && M.liveOf(self._hfStore(), P) ? ' · live' : '') + '</span></div>' +
        '<div class="dk-tv">' + num(last[1], M.dec, sg(M)) + '<small>' + esc(M.unit) + '</small></div>' +
        '<div class="dk-td"><span>' + (step >= 5 ? 'WoW' : 'DoD') + ' <span class="' + X.cls(c0) + '">' + chgTxt(M, c0) + '</span></span><span>1M <span class="' + X.cls(cM) + '">' + chgTxt(M, cM) + '</span></span></div>' +
        '<div class="dk-sp">' + sparkOne(sp, 160, 30) + '</div>' +
        '<div class="dk-rng"><i style="left:' + (pos * 100).toFixed(0) + '%"></i></div><div class="dk-rngl"><span>Since ' + MON[+main[0][0].slice(5, 7) - 1] + ' ' + main[0][0].slice(2, 4) + ': low ' + num(mn, M.dec) + '</span><span>high ' + num(mx, M.dec) + '</span></div>' + act + '</button>';
    }).join('');
  };

  /* as visualizações do palco de preços e das usinas (pedido do usuário, 26/11/2026): 2–3 desenhos do MESMO dado; a 1ª é o de sempre.
     Uma série: Line · Monthly avg (média de cada mês, em colunas) · vs year ago (variação contra a mesma data um ano antes).
     Várias: Lines · Index = 100 (cada linha começa em 100 no 1º dia da janela) · Gap (cada linha menos a 1ª).
     Sazonalidade: Lines · Range (o ano atual e o anterior contra a faixa e a média dos anos anteriores). */
  Desk.prototype._hfOpts = function () {
    var u = this._u(), M = this._hfM(u.metric), ser = M ? this._hfSeries(M) : []; if (!M) return [['line', 'Line']];
    if (M.season) return [['lines', 'Lines', 'One line per year', 0, 'year'], ['range', 'Range', 'This year and last year against the range of the years before', ser.length < 3 ? 'Needs at least three years' : 0, 'range']];
    if (ser.length > 1) { var all = [['line', 'Lines', 'One line per series', 0, 'lines'], ['index', 'Index = 100', 'Every line starts at 100 on the first day of the window', 0, 'index'],
      ['gap', 'Gap', 'Each line minus ' + (ser[0].short || ser[0].name), 0, 'gap']];
      /* M.views = as vistas que fazem sentido para o indicador (ex.: a margem é uma CONTA — preço − frete —, a diferença entre as parcelas
         não diz nada); um spread pode ser zero ou negativo, então não tem Index */
      return all.filter(function (o) { return M.views ? M.views.indexOf(o[0]) >= 0 : !(o[0] === 'index' && M.diff); }); }
    return [['line', 'Line'], ['mavg', 'Monthly avg', 'The average of each calendar month, as columns', 0, 'col'], ['yoy', 'vs year ago', 'Change against the same date a year earlier', 0, 'gap']];
  };
  /* médias por mês do calendário (vista "Monthly avg"): todos os meses da série (o de um ano antes também é preciso) e a janela = os meses
     entre as datas da janela; o último mês, se ainda não acabou, sai marcado (coluna mais clara) */
  Desk.prototype._hfMonthly = function (pts, from, to) {
    var by = {}, order = [];
    pts.forEach(function (p) { var k = p[0].slice(0, 7); if (!by[k]) { by[k] = { s: 0, n: 0, lo: Infinity, hi: -Infinity }; order.push(k); } var o = by[k]; o.s += p[1]; o.n++; if (p[1] < o.lo) o.lo = p[1]; if (p[1] > o.hi) o.hi = p[1]; });
    var f = from.slice(0, 7), tt = to.slice(0, 7), keys = order.filter(function (k) { return k >= f && k <= tt; }), now = new Date().toISOString().slice(0, 7), lastK = order[order.length - 1];
    var avg = function (k) { var o = by[k]; return o && o.n ? o.s / o.n : null; };
    return { keys: keys, labels: keys.map(function (k) { return MON[+k.slice(5, 7) - 1] + '-' + k.slice(2, 4); }), vals: keys.map(avg), n: keys.map(function (k) { return by[k].n; }),
      lo: keys.map(function (k) { return by[k].lo; }), hi: keys.map(function (k) { return by[k].hi; }), part: keys.map(function (k) { return k === lastK && k >= now; }), avg: avg };
  };
  /* palco: o indicador escolhido, na janela da barra de filtros */
  Desk.prototype._hfStage = function () {
    var E = this.el, u = this._u(), M = this._hfM(u.metric), S = this._hfStore(), ser = this._hfSeries(M), st = this.cfg.state(), t = D.theme(), pal = palette();
    var opts = this._hfOpts(), sty = this._sty('hf', opts), swh = E.stage.querySelector('.dk-styw'); if (swh) swh.innerHTML = (opts.length > 1 && X.styleSeg) ? X.styleSeg(opts, sty) : '';
    /* o eixo vai do 1º ao último dia da série PRINCIPAL: as outras só entram dentro desse intervalo (senão o gráfico começaria vazio).
       axisAll: o eixo é a união de todas (a margem com a linha do 62%, que vai mais para trás que o índice de 61%) */
    var d0 = ser.length ? ser[0].pts[0][0] : '', d1 = ser.length ? ser[0].pts[ser[0].pts.length - 1][0] : '', seas = !!M.season;
    /* sazonalidade: todos os anos inteiros e a janela da barra não se aplica */
    var a = align(ser.map(function (s, k) { return (k && !M.axisAll && !seas) ? s.pts.filter(function (p) { return p[0] >= d0 && p[0] <= d1; }) : s.pts; })), w = seas ? [0, a.dates.length - 1] : win(a.dates, st), i0 = w[0], i1 = w[1], n = i1 - i0 + 1;
    var refs = null; try { refs = M.refs ? M.refs(S, P) : null; } catch (e) { refs = null; }
    var liveI = -1; if (M.liveOf) { var lw = M.liveOf(S, P); if (lw) liveI = a.dates.indexOf(lw) - i0; }
    /* várias linhas (não a sazonalidade): o R² de cada uma contra a 1ª, na janela, nos dias em que as duas têm valor (o ponto "ao vivo"
       da paridade fica de fora). M.noR2 = linhas que são a mesma conta (o prêmio com e sem a tarifa) */
    var fits = null, cells = null;
    if (!seas && !M.noR2 && ser.length > 1 && X.r2of) {
      var vv = a.vals.map(function (arr) { return arr.map(function (x, i) { return (liveI >= 0 && i === i0 + liveI) ? null : x; }); });
      fits = ser.map(function (s, k) { return k ? X.r2of(vv[0], vv[k], i0, i1) : null; });
      cells = X.corrCells ? X.corrCells(vv, i0, i1) : null; }
    /* o que o gráfico desenha em cada visualização: pv[k] = a linha k como desenhada; pleg = nomes e cores da legenda (e da imagem) */
    var pv = a.vals, pleg = ser.map(function (s, k) { return { name: s.name, color: pal[k % pal.length] }; }), mv = null, tsuf = '', fsn = ser.length ? (ser[0].short || ser[0].name) : '';
    if (!seas && sty === 'index' && ser.length > 1) {
      pv = a.vals.map(function (arr) { var b = null, i; for (i = i0; i <= i1; i++) if (arr[i] != null && arr[i] > 0) { b = arr[i]; break; } return arr.map(function (x) { return (b && x != null) ? x / b * 100 : null; }); });
      tsuf = ' · index';
    } else if (!seas && sty === 'gap' && ser.length > 1) {
      var f0 = a.vals[0]; pv = a.vals.slice(1).map(function (arr) { return arr.map(function (x, i) { return (x == null || f0[i] == null) ? null : x - f0[i]; }); });
      pleg = ser.slice(1).map(function (s0, k) { return { name: (s0.short || s0.name) + ' − ' + fsn, color: pal[(k + 1) % pal.length] }; }); tsuf = ' · gap to ' + fsn;
    } else if (!seas && sty === 'yoy' && ser.length) {
      var main0 = ser[0].pts; pv = [a.vals[0].map(function (x, i) { if (x == null) return null; var tg = shift(a.dates[i], -12), b = at(main0, tg); return (b && days(b[0], tg) <= 10) ? chg(M, x, b[1]) : null; })];
      pleg = [{ name: ser[0].name + ' — vs a year earlier', color: ORANGE }]; tsuf = ' · vs a year earlier';
    } else if (!seas && sty === 'mavg' && ser.length && n > 0) {
      mv = this._hfMonthly(ser[0].pts, a.dates[i0], a.dates[i1]); pleg = [{ name: ser[0].name + ' — monthly average', color: ORANGE }]; tsuf = ' · monthly average';
    }
    this._hfV = { M: M, ser: ser, dates: a.dates, vals: a.vals, i0: i0, i1: i1, n: mv ? mv.keys.length : n, refs: refs, liveI: liveI, fits: fits, sty: sty, pv: pv, pleg: pleg, mv: mv, tsuf: tsuf, rng: null };
    var cv = E.stage.querySelector('canvas'), note = typeof M.note === 'function' ? M.note(S, P) : (M.note || ''), hpf = this._help(this.cur, M.id, {}), wy = E.stage.querySelector('.dk-why');
    E.stage.querySelector('.dk-st').textContent = M.label + tsuf;
    /* a explicação do gráfico (data-desk-help.js): o que mostra + como ler; sem texto lá, a nota do catálogo. Nas outras visualizações o
       "como ler" é o do desenho escolhido */
    var R2H = window.IBBADeskHelp && IBBADeskHelp.view && IBBADeskHelp.view.r2, HV = (window.IBBADeskHelp && IBBADeskHelp.view) || {};
    var styHow = ({ index: HV.hfIndex, gap: HV.hfGap, yoy: M.pp ? HV.hfYoyPP : HV.hfYoy, mavg: HV.hfMavg, range: HV.hfRange })[sty] || '';
    styHow = styHow.replace('{first}', fsn).replace('{unit}', M.unit || '');
    wy.innerHTML = X.whyHTML((hpf && hpf.what) || note, ((styHow || (hpf && hpf.how) || '') + (fits && R2H ? ' ' + R2H : '')).trim()); wy.hidden = !wy.innerHTML;
    /* tabela de correlação ao lado da explicação: o R² de cada par de linhas, na janela */
    var ce = E.stage.querySelector('.dk-corr'); if (ce) { ce.innerHTML = (cells && X.corrTable) ? X.corrTable(ser.map(function (s, k) { return { name: s.name, short: s.short || s.name, color: pal[k % pal.length] }; }), cells, 'readings') : ''; ce.hidden = !ce.innerHTML; }
    E.stage.querySelector('.dk-hfsrc').textContent = M.src || this.sections[this.cur].hf.src || '';
    E.stage.querySelector('.dk-hint').textContent = seas ? 'Hover to read every year · All years are shown (the Window buttons do not apply here)' : mv ? 'Hover a column to read the month · Change the period with the Window buttons or the dates above' : 'Hover to read any date · Change the period with the Window buttons or the dates above';
    if (n < 1 || !ser.length || (mv && !mv.keys.length)) { E.build.hidden = true; this._dropCharts('hf'); E.stage.querySelector('.dk-sv').textContent = '—'; E.stage.querySelector('.dk-sd').textContent = 'No data in this window'; E.stage.querySelector('.dk-hfleg').innerHTML = ''; E.read.querySelector('.dk-kv').innerHTML = ''; E.read.querySelector('.dk-big').textContent = '—'; return; }
    var cs = seas ? seasColors(ser.length) : null, dts = a.dates, ch;
    /* furo: o trecho entre dois pontos mais distantes que gapDays não é desenhado (semana sem leitura fica em branco) */
    var holes = function (d) { d.spanGaps = true; if (M.gapDays) { var bd = d.segment && d.segment.borderDash;
      d.segment = { borderDash: bd, borderColor: function (c) { var x0 = dts[i0 + c.p0DataIndex], x1 = dts[i0 + c.p1DataIndex]; return (x0 && x1 && days(x0, x1) > M.gapDays) ? 'rgba(0,0,0,0)' : undefined; } }; } return d; };
    if (mv) {   // colunas: a média de cada mês do calendário (o mês em andamento mais claro)
      var lp = mv.part.length && mv.part[mv.part.length - 1] ? mv.part.length - 1 : null;
      ch = this._chart('hf', cv, 'bar', mv.labels, [X.barSet(mv.vals, ORANGE, { label: ser[0].name + ' — monthly average', partialAt: lp })], { stage: true, dec: M.dec, bar: true });
    } else {
      var labels = a.dates.slice(i0, i1 + 1).map(seas ? sLabel : dLabel), sets;
      if (seas && sty === 'range' && ser.length >= 3) {   // a faixa (menor–maior) e a média dos anos anteriores + o ano passado + o atual
        var L = i1 - i0 + 1, lo = [], hi = [], av = [], j, k;
        for (j = 0; j < L; j++) { var xs = [], iso0 = a.dates[i0 + j]; for (k = 1; k < ser.length; k++) { var x = interpAt(ser[k].pts, iso0, 8); if (x != null) xs.push(x); }
          lo.push(xs.length ? Math.min.apply(null, xs) : null); hi.push(xs.length ? Math.max.apply(null, xs) : null); av.push(xs.length ? xs.reduce(function (p0, q0) { return p0 + q0; }, 0) / xs.length : null); }
        var rn = ser[ser.length - 1].name + '–' + ser[1].name;
        var dLo = X.lineSet(lo, 'rgba(0,0,0,0)', { label: 'Lowest ' + rn, w: 0, noDot: true }), dHi = X.lineSet(hi, 'rgba(0,0,0,0)', { label: 'Highest ' + rn, w: 0, noDot: true });
        dHi.fill = '-1'; dHi.backgroundColor = 'rgba(' + t.band + ',' + (t.dark ? .17 : .11) + ')'; dLo.order = 8; dHi.order = 8; dLo.spanGaps = dHi.spanGaps = true;
        var dAv = X.lineSet(av, 'rgba(' + t.band + ',.55)', { label: 'Average ' + rn, w: 1.4, dash: [5, 3], noDot: true }); dAv.order = 7; dAv.spanGaps = true;
        sets = [dLo, dHi, dAv, holes(X.lineSet(a.vals[1].slice(i0, i1 + 1), t.ink, { label: ser[1].name, w: 2, surf: t.surf, order: 2 })), holes(X.lineSet(a.vals[0].slice(i0, i1 + 1), ORANGE, { label: ser[0].name, w: 2.6, end: true, surf: t.surf, order: 1 }))];
        this._hfV.rng = { lo: lo, hi: hi, av: av, rn: rn };
      } else if (!seas && (sty === 'index' || sty === 'gap' || sty === 'yoy')) {   // a conta de cada visualização + a linha de referência (100 ou zero)
        sets = pv.map(function (arr, k) { return holes(X.lineSet(arr.slice(i0, i1 + 1), pleg[k].color, { label: pleg[k].name, w: k ? 1.8 : 2.4, end: true, surf: t.surf, partialAt: liveI >= 0 ? liveI : null, order: k ? 2 : 1 })); });
        var bl = X.lineSet(labels.map(function () { return sty === 'index' ? 100 : 0; }), 'rgba(' + t.band + ',.4)', { label: sty === 'index' ? 'Start = 100' : 'Zero', w: 1, noDot: true }); bl.order = 9; sets.push(bl);
      } else {
        sets = ser.map(function (s, k) {
          var ys = seas && X.yearStyle ? X.yearStyle(k) : { w: k ? 1.3 : 2.6, dash: k >= 2 ? [4, 3] : null };
          var d = seas ? X.lineSet(a.vals[k].slice(i0, i1 + 1), cs[k], { label: s.name, w: ys.w, dash: ys.dash, end: k === 0, surf: t.surf, order: k + 1 })
                       : X.lineSet(a.vals[k].slice(i0, i1 + 1), pal[k % pal.length], { label: s.name, w: k ? 1.8 : 2.4, end: true, surf: t.surf, area: !k && ser.length === 1 && !M.pp && !M.diff, partialAt: liveI >= 0 ? liveI : null, order: k ? 2 : 1 });
          return holes(d); });
      }
      ch = this._chart('hf', cv, 'line', labels, sets, { stage: true, dec: M.dec });
    }
    /* as linhas de referência do indicador (médias, tarifa…) estão em unidades de NÍVEL: só nas vistas de nível */
    ch.$hfRefs = (sty === 'line' || sty === 'lines') ? refs : null; ch.options.plugins.ibbaHfRefs = {};
    var sfx = sty === 'yoy' ? (M.pp ? ' pp' : M.diff ? '' : '%') : (M.pp && sty !== 'index') ? '%' : '', d1c = sty === 'index' || sty === 'yoy';
    ch.options.scales.y.ticks.callback = function (v) { return fmt(v, ((M.dec > 0 || d1c) && Math.abs(this.max - this.min) < 10) ? 1 : 0) + sfx; };
    ch.update('none');
    this._hfPaint();
  };

  /* vista "Monthly avg": o mês lido (média), contra o mês anterior e o mesmo mês um ano antes; o menor e o maior dia do mês */
  Desk.prototype._hfPaintMonthly = function (v) {
    var E = this.el, u = this._u(), M = v.M, mv = v.mv, hov = u.hover != null, k = hov ? Math.max(0, Math.min(mv.keys.length - 1, u.hover)) : mv.keys.length - 1, kk = mv.keys[k];
    var ch = this.charts.hf; if (ch) { ch.$dk = { hover: hov ? k : null, pinA: null, pinB: null }; ch.draw(); }
    var val = mv.vals[k], when = mv.labels[k] + (mv.part[k] ? ' · month to date' : '') + (hov ? '' : ' · latest');
    var pm = k > 0 ? mv.vals[k - 1] : mv.avg(shiftKey(kk, -1)), py = mv.avg(shiftKey(kk, -12));
    var c1 = (val != null && pm != null) ? chg(M, val, pm) : null, c12 = (val != null && py != null) ? chg(M, val, py) : null;
    E.stage.querySelector('.dk-sv').innerHTML = num(val, M.dec, sg(M)) + '<small>' + esc(M.unit) + ' · ' + esc(when) + '</small>';
    E.stage.querySelector('.dk-sd').innerHTML = c1 == null ? '' : '<span class="' + X.cls(c1) + '">' + esc(chgTxt(M, c1)) + '</span> vs the month before';
    E.stage.querySelector('.dk-hfleg').innerHTML = '';
    var R = E.read, kv = '', row = function (a0, b0, c0) { kv += '<span>' + esc(a0) + '</span><b' + (c0 ? ' class="' + c0 + '"' : '') + '>' + b0 + '</b>'; }, head = function (t0) { kv += '<span class="dk-kvh">' + esc(t0) + '</span>'; };
    R.querySelector('.dk-when').textContent = when;
    R.querySelector('.dk-big').innerHTML = num(val, M.dec, sg(M)) + '<small>' + esc(M.unit) + ' · ' + esc(M.short || M.label) + ' · monthly average</small>';
    head('Monthly average against'); row('The month before', chgTxt(M, c1), X.cls(c1)); row('The same month a year earlier', chgTxt(M, c12), X.cls(c12));
    head('In ' + mv.labels[k]); row('Readings', String(mv.n[k])); row('Lowest', num(mv.lo[k], M.dec, sg(M))); row('Highest', num(mv.hi[k], M.dec, sg(M)));
    R.querySelector('.dk-kv').innerHTML = kv; E.build.hidden = true;
  };
  function shiftKey(k, n) { var i = (+k.slice(0, 4)) * 12 + (+k.slice(5, 7)) - 1 + n; return Math.floor(i / 12) + '-' + p2(i % 12 + 1); }

  /* o que muda com o mouse: marca no gráfico, número grande, legenda e painel Reading */
  Desk.prototype._hfPaint = function () {
    var E = this.el, u = this._u(), v = this._hfV, S = this._hfStore(), pal = palette(); if (!v || !E || v.n < 1) return;
    if (v.mv) return this._hfPaintMonthly(v);
    var ch = this.charts.hf; if (ch) { ch.$dk = { hover: u.hover, pinA: null, pinB: null }; ch.draw(); }
    var M = v.M, hov = u.hover != null, ref = hov ? v.i0 + u.hover : v.i1, k;
    /* sem o mouse, a referência é o último dia em que a série principal tem valor */
    if (!hov) while (ref > v.i0 && v.vals[0][ref] == null) ref--;
    if (M.season) return this._hfPaintSeason(v, hov, ref);
    var iso = v.dates[ref], main = v.ser[0].pts, cur = at(main, iso), val = cur ? cur[1] : null, live = v.liveI >= 0 && ref === v.i0 + v.liveI;
    var estN = null; try { estN = M.estAt ? M.estAt(this._hfStore(), P, iso) : null; } catch (e) { estN = null; }
    var when = dLabel(iso) + (live ? ' · live' : hov ? '' : ' · latest') + (estN ? ' · estimate' : '');
    var yv = v.sty === 'yoy' && v.pv ? v.pv[0][ref] : null;
    E.stage.querySelector('.dk-sv').innerHTML = v.sty === 'yoy' ? '<span class="' + X.cls(yv) + '">' + esc(chgTxt(M, yv)) + '</span><small>vs a year earlier · ' + esc(when) + ' · ' + num(val, M.dec, sg(M)) + ' ' + esc(M.unit) + '</small>'
      : num(val, M.dec, sg(M)) + '<small>' + esc(M.unit) + ' · ' + esc(when) + '</small>';
    /* legenda com o valor de cada série na data lida (no Index e no Gap, o número desenhado) */
    var drawn = v.sty === 'index' || v.sty === 'gap', lvs = drawn ? v.pv : v.vals;
    E.stage.querySelector('.dk-hfleg').innerHTML = (v.ser.length > 1 || v.sty === 'gap') ? v.pleg.map(function (s, j) { var x = lvs[j] ? lvs[j][ref] : null; if (x == null && !drawn) { var b = at(v.ser[j].pts, iso); x = b ? b[1] : null; }
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + ' <b>' + num(x, v.sty === 'index' ? 1 : M.dec, v.sty === 'gap' || sg(M)) + '</b></span>'; }).join('') : '';   // o R² mora na tabela ao lado da explicação
    if (v.refs && v.refs.legend && (v.sty === 'line' || v.sty === 'lines')) E.stage.querySelector('.dk-hfleg').innerHTML += v.refs.legend.map(function (l) { return '<span><i class="dk-lg-' + (l.kind === 'band' ? 'band' : 'dash') + '"></i>' + esc(l.name) + '</span>'; }).join('');
    /* comparações da série principal */
    var cmp = [['vs previous', null], ['vs 1 month earlier', -1], ['vs 3 months earlier', -3], ['vs 1 year earlier', -12]].map(function (c) {
      var b = null; if (c[1] == null) { for (k = main.length - 1; k >= 0; k--) if (main[k][0] < iso) { b = main[k]; break; } }
      else { var tg = shift(iso, c[1]); b = at(main, tg); if (b && days(b[0], tg) > 10) b = null; }
      return b ? [c[0], chg(M, val, b[1]), b] : null; }).filter(Boolean);
    var sd = cmp.length ? chgTxt(M, cmp[0][1]) + ' vs ' + dLabel(cmp[0][2][0]) : '';
    E.stage.querySelector('.dk-sd').innerHTML = sd ? '<span class="' + X.cls(cmp[0][1]) + '">' + esc(sd.split(' vs ')[0]) + '</span> vs ' + esc(dLabel(cmp[0][2][0])) : '';
    /* Reading */
    var R = E.read; R.querySelector('.dk-when').textContent = when;
    R.querySelector('.dk-big').innerHTML = num(val, M.dec, sg(M)) + '<small>' + esc(M.unit) + ' · ' + esc(M.short || M.label) + '</small>';
    var kv = '', row = function (a0, b0, c0) { kv += '<span>' + esc(a0) + '</span><b' + (c0 ? ' class="' + c0 + '"' : '') + '>' + b0 + '</b>'; }, head = function (t0) { kv += '<span class="dk-kvh">' + esc(t0) + '</span>'; };
    if (estN) { head('Estimate'); kv += '<span class="dk-kvnote">' + esc(estN) + '</span>'; }
    cmp.forEach(function (c) { row(c[0] === 'vs previous' ? 'vs previous (' + dLabel(c[2][0]) + ')' : c[0], chgTxt(M, c[1]), X.cls(c[1])); });
    if (v.ser.length > 1) { head('On this date');
      v.ser.forEach(function (s, j) { var x = v.vals[j][ref]; if (x == null) { var b = at(s.pts, iso); x = b ? b[1] : null; }
        kv += '<span><i style="background:' + pal[j % pal.length] + '"></i>' + esc(s.short || s.name) + '</span><b>' + num(x, M.dec, sg(M)) + '</b>'; }); }
    var lo = Infinity, hi = -Infinity, s0 = 0, n0 = 0; for (k = v.i0; k <= v.i1; k++) { var y = v.vals[0][k]; if (y == null) continue; if (y < lo) lo = y; if (y > hi) hi = y; s0 += y; n0++; }
    if (n0 > 1) { head('In this window · ' + dLabel(v.dates[v.i0]) + ' – ' + dLabel(v.dates[v.i1])); row('Low', num(lo, M.dec, sg(M))); row('High', num(hi, M.dec, sg(M))); row('Average', num(s0 / n0, M.dec, sg(M))); }
    /* médias trimestrais (a conta da aba Q das bases da Platts): o trimestre da data lida até ela, o anterior e o mesmo de um ano antes */
    var qi = qInfo(iso), qtd = avgIn(main, qi.start, iso), qp = qBack(qi, 1), qy = qBack(qi, 4), ap = avgIn(main, qp.start, qp.end), ay = avgIn(main, qy.start, qy.end);
    if (qtd != null && (ap != null || ay != null)) { head('Quarterly average');
      row(qi.label + (iso < qi.end ? ' to date' : ''), num(qtd, M.dec, sg(M))); if (ap != null) row(qp.label, num(ap, M.dec, sg(M))); if (ay != null) row(qy.label + ' (a year earlier)', num(ay, M.dec, sg(M))); }
    if (v.refs && v.refs.read) v.refs.read.forEach(function (x) { if (x.head) head(x.head); else row(x.k, x.v, x.c); });
    R.querySelector('.dk-kv').innerHTML = kv;
    var bd = null; try { bd = M.build ? M.build(S, P, iso) : null; } catch (e) { bd = null; }
    E.build.hidden = !(bd && bd.items && bd.items.length);
    if (!E.build.hidden) { E.build.querySelector('h3').textContent = bd.title || 'How it is built'; E.build.querySelector('.dk-when').textContent = bd.when || when;
      E.build.querySelector('.dk-eq').innerHTML = bd.items.map(function (x) { return (x.brk ? '<span class="dk-eqbr"></span>' : '') + (x.op ? '<i class="dk-eqo">' + esc(x.op) + '</i>' : '') + '<span class="dk-eqi' + (x.sum ? ' dk-eqs' : '') + '"><small>' + esc(x.k) + '</small><b' + (x.c ? ' class="' + x.c + '"' : '') + '>' + x.v + '</b></span>'; }).join(''); }
  };

  /* sazonalidade: cada ano na mesma semana; o mais novo contra o ano anterior e contra a média dos outros */
  Desk.prototype._hfPaintSeason = function (v, hov, ref) {
    var E = this.el, M = v.M, cs = seasColors(v.ser.length), nw = v.ser[0], prevY = v.ser[1], iso = v.dates[ref], N = v.ser.length;
    var pts = v.ser.map(function (s) { return nearPt(s.pts, iso); }), vals = pts.map(function (b) { return b ? b[1] : null; }), val = vals[0], cY = (prevY && val != null && vals[1] != null) ? chg(M, val, vals[1]) : null;
    var isEst = pts.map(function (b, j) { return !!(b && v.ser[j].est && v.ser[j].est[b[0]]); }), anyEst = isEst.some(Boolean), mk = function (j) { return isEst[j] ? '*' : ''; };
    var when = sLabel(iso) + ' ' + nw.name + (hov ? '' : ' · latest') + (isEst[0] ? ' · estimate' : '');
    E.stage.querySelector('.dk-sv').innerHTML = num(val, M.dec, sg(M)) + '<small>' + esc(M.unit) + ' · ' + esc(when) + '</small>';
    var rg = v.sty === 'range' && v.rng, ri = ref - v.i0;
    E.stage.querySelector('.dk-hfleg').innerHTML = rg ? (X.yearChip(0, nw.name, num(vals[0], M.dec, sg(M)) + mk(0)) + X.yearChip(1, prevY.name, num(vals[1], M.dec, sg(M)) + mk(1)) +
        '<span><i class="dk-lg-dash"></i>Average ' + esc(rg.rn) + ' <b>' + num(rg.av[ri], M.dec, sg(M)) + '</b></span><span><i class="dk-lg-band"></i>Range ' + esc(rg.rn) + ' <b>' + num(rg.lo[ri], M.dec, sg(M)) + ' – ' + num(rg.hi[ri], M.dec, sg(M)) + '</b></span>')
      : v.ser.map(function (s, j) { return X.yearChip ? X.yearChip(j, s.name, num(vals[j], M.dec, sg(M)) + mk(j))
      : '<span><i style="background:' + cs[j] + '"></i>' + esc(s.name) + ' <b>' + num(vals[j], M.dec, sg(M)) + '</b></span>'; }).join('');
    E.stage.querySelector('.dk-sd').innerHTML = cY == null ? '' : '<span class="' + X.cls(cY) + '">' + esc(chgTxt(M, cY)) + '</span> vs ' + esc(prevY.name);
    var R = E.read, kv = '', row = function (a0, b0, c0) { kv += '<span>' + esc(a0) + '</span><b' + (c0 ? ' class="' + c0 + '"' : '') + '>' + b0 + '</b>'; }, head = function (t0) { kv += '<span class="dk-kvh">' + esc(t0) + '</span>'; };
    R.querySelector('.dk-when').textContent = 'Week of ' + sLabel(iso);
    R.querySelector('.dk-big').innerHTML = num(val, M.dec, sg(M)) + '<small>' + esc(M.unit) + ' · ' + esc(nw.name) + '</small>';
    head('Same week, every year');
    v.ser.forEach(function (s, j) { kv += '<span><i style="background:' + cs[j] + '"></i>' + esc(s.name) + '</span><b>' + num(vals[j], M.dec, sg(M)) + mk(j) + '</b>'; });
    if (anyEst) kv += '<span class="dk-kvnote">* estimate: no reading that week — average of the week before and the week after</span>';
    var past = vals.slice(1).filter(function (x) { return x != null; });
    if (val != null && past.length) {
      head(nw.name + ' against');
      if (cY != null) row(prevY.name, chgTxt(M, cY), X.cls(cY));
      var avg = past.reduce(function (x, y) { return x + y; }, 0) / past.length, cA = chg(M, val, avg), rk = 1 + past.filter(function (x) { return x > val; }).length, nn = past.length + 1;
      row('Average of ' + v.ser[N - 1].name + '–' + prevY.name + ' (' + num(avg, M.dec, sg(M)) + ')', chgTxt(M, cA), X.cls(cA));
      row('Rank among ' + nn + ' years', rk + ' of ' + nn + (rk === 1 ? ' (highest)' : rk === nn ? ' (lowest)' : ''));
    }
    R.querySelector('.dk-kv').innerHTML = kv; E.build.hidden = true;
  };

  /* imagem do gráfico (título + legenda + gráfico), na cor do tema */
  Desk.prototype._hfPNG = function () {
    var ch = this.charts.hf, v = this._hfV; if (!ch || !v || v.n < 1) return;
    var t = D.theme(), pal = v.M.season ? seasColors(v.ser.length) : palette(), cv = ch.canvas, s = cv.width / cv.clientWidth, pad = 18 * s, lh = 18 * s;
    /* a legenda da imagem segue o desenho: anos (sazonalidade), a faixa (Range) ou as linhas desenhadas (Index, Gap, YoY, média mensal) */
    var legs = v.M.season ? (v.rng ? [{ name: v.ser[0].name, color: ORANGE }, { name: v.ser[1].name, color: t.ink }, { name: 'Average ' + v.rng.rn, color: t.mut }, { name: 'Range ' + v.rng.rn, color: 'rgba(' + t.band + ',.3)' }]
      : v.ser.map(function (r, i) { return { name: r.name, color: pal[i % pal.length] }; })) : (v.pleg || []), head = pad + 24 * s + legs.length * lh + 6 * s;
    var out = document.createElement('canvas'); out.width = cv.width + 2 * pad; out.height = head + cv.height + pad + 16 * s; var g = out.getContext('2d');
    g.fillStyle = t.surf; g.fillRect(0, 0, out.width, out.height); g.textBaseline = 'top';
    var span = v.M.season ? v.ser[v.ser.length - 1].name + '–' + v.ser[0].name : v.mv ? v.mv.labels[0] + ' – ' + v.mv.labels[v.mv.labels.length - 1] : dLabel(v.dates[v.i0]) + ' – ' + dLabel(v.dates[v.i1]);
    g.fillStyle = t.ink; g.font = '700 ' + (14 * s) + 'px ' + X.FONT; g.fillText(v.M.label + (v.tsuf || '') + ' · ' + span, pad, pad);
    var un = v.sty === 'index' ? 'index' : v.sty === 'yoy' ? (v.M.pp ? 'pp' : v.M.diff ? v.M.unit : '%') : v.M.unit;
    legs.forEach(function (r, i) { var y = pad + 24 * s + i * lh; g.fillStyle = r.color; g.fillRect(pad, y + 3 * s, 10 * s, 10 * s); g.fillStyle = t.ink; g.font = '500 ' + (11.5 * s) + 'px ' + X.FONT; g.fillText(r.name + '  (' + un + ')', pad + 16 * s, y); });
    g.drawImage(cv, pad, head);
    g.fillStyle = t.mut; g.font = '500 ' + (10 * s) + 'px ' + X.FONT; g.fillText((v.M.src || this.sections[this.cur].hf.src || '') + ' · Itaú BBA', pad, head + cv.height + 6 * s);
    var nm = (window.IBBAExport && IBBAExport.safeName) ? IBBAExport.safeName((this.cfg.sector || 'desk') + '_' + v.M.id + '_' + IBBAExport.stamp()) : v.M.id;
    out.toBlob(function (bl) { if (!bl) return; var a = document.createElement('a'); a.href = URL.createObjectURL(bl); a.download = nm + '.png'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000); }, 'image/png');
  };

  /* só para os testes: o que está no palco (datas da janela e os valores de cada série) */
  Desk.prototype.pricesDebug = function () { var v = this._hfV; if (!v) return null; return { metric: v.M.id, dates: v.dates.slice(v.i0, v.i1 + 1), liveI: v.liveI, refs: v.refs, fits: v.fits, sty: v.sty, rng: v.rng,
    drawn: v.pv ? v.pv.map(function (arr) { return arr.slice(v.i0, v.i1 + 1); }) : null, mv: v.mv ? { keys: v.mv.keys, vals: v.mv.vals, part: v.mv.part } : null,
    series: v.ser.map(function (s, k) { return { name: s.name, vals: v.vals[k].slice(v.i0, v.i1 + 1) }; }) }; };
  D.prices = { parity: parity, parRow: parRow, liveRow: liveRow, fromDaily: fromDaily, combine: combine, at: at, align: align, win: win, shift: shift, mean: mean, dLabel: dLabel,
    decodeHist: decodeHist, mergeHist: mergeHist, qInfo: qInfo, qBack: qBack, avgIn: avgIn, byYear: byYear, seasIso: seasIso, sLabel: sLabel, near: near, millPts: millPts,
    fillWeekly: fillWeekly, addDays: addDays, monthly: monthly, monthlyCal: monthlyCal, P: P };
})();
