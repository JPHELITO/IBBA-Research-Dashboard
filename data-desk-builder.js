/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — BUILDER (a bancada): cruzar até 4 séries das seções da mesa
   ────────────────────────────────────────────────────────────────────────────
   Plano: IBBA-Dashboard/data-desk/PLANO.md (5.11). Carrega DEPOIS do data-desk.js e estende o motor.

   · O catálogo do Builder NÃO é uma lista à parte: sai do catálogo das seções (todo indicador de toda
     seção, em cada produto) + as entidades das quebras (países, portos, destinos, fornecedores).
     Indicador novo numa seção aparece aqui sozinho.
   · Os números vêm de Desk.seriesAll — o MESMO caminho do palco da seção (mesmo eixo, mesma regra de
     soma/razão/último). O teste data-desk/ferramentas/comparar_builder.py confere isso.
   · UM gráfico: séries da mesma unidade aparecem como são; em unidades diferentes (kt × %, kt × US$/t…) a visão vai
     sozinha para a BASE 100 — cada série começa em 100 no início da janela; nunca um painel por unidade (pedido do usuário,
     19/11/2026). Série que pode ser ≤ 0 (um spread) não tem base 100.
   · R² (pedido do usuário, 25/11/2026: "para todos os gráficos que montarmos, coloque sempre um indicativo do R²"): cada série a
     partir da 2ª mostra o R² contra a 1ª série do gráfico — o quadrado da correlação de Pearson, que é o R² da regressão linear de
     uma na outra —, na JANELA e na CONTA da tela (Level, YoY, LTM ou Index; Index dá o mesmo R² do Level). Só com 6+ períodos em
     comum. "inverse" = andam em sentidos opostos (correlação negativa).
   · EIXO DA DIREITA (pedido do usuário, 25/11/2026: "permitir colocar algum dado em um eixo secundário (RHS), ajustando a
     variação"): cada série pode ir para uma 2ª escala, à direita, na unidade dela — a de pouca variação ganha escala
     própria. Cada lado vale sozinho: lado com uma unidade só = números de verdade; um lado com unidades diferentes leva tudo
     para a base 100 (com as duas escalas). Spread que não cabe na base 100 vai sozinho para a direita quando dá. A esquerda
     nunca fica vazia. O link, as visões salvas e a última visão guardam quem está à direita (v.r).
   · TIPOS DE GRÁFICO E FORMATO (pedido do usuário, 26/11/2026: "várias opções de gráficos… o mais aberto possível para o cliente criar
     o gráfico da maneira que ele quiser, trocar de eixos, mexer nos gráficos… como um Excel melhorado, mais fácil e rápido"): galeria
     Lines · Area · Columns · Combo · Stacked · Stacked area · 100% · Scatter · By year; barra Format (Y a partir do zero, log, inverter
     cada eixo, linha de tendência/regressão, média, rótulos de valor, faixa dos eixos, título próprio; no Scatter, qual série vai no
     eixo X e "Swap X ↔ Y"); e, em cada série (o ● da ficha), tipo, cor, traço, deslocamento no tempo (lead/lag) e eixo. Tudo vai no
     link, nas visões salvas e na última visão (parte 8 do link, só quando há formato). Tipo que não vale para as séries escolhidas
     fica apagado com o motivo; o deslocamento entra na tabela, no Excel e na tabela de correlação.
   · Trimestre/ano: só períodos COMPLETOS (séries de fontes diferentes fecham em meses diferentes).
   · Seção com dado que chega à parte (sec.need(ids) → promessa, ex.: usinas chinesas, preços da Platts): o Builder pede quando
     abre e a cada série posta no gráfico (ids = as séries daquela seção que estão no gráfico) e redesenha quando o dado chega. sec.off() = a seção não vale para esta pessoa agora (sem a chave). sec.paid = fonte paga
     (agência): com uma série dessas no gráfico, sem Excel e sem "Copy table" — só a imagem.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var D = window.IBBADesk; if (!D || !D.x || D.x.Desk.prototype._builder) return;
  var X = D.x, Desk = X.Desk, core = D.core, esc = X.esc, fmt = X.fmt, h = X.h;
  var MAX = 4, MAXU = 2, MAXV = 12;
  var CALCS = [['level', 'Level', 'The figures as published'], ['yoy', 'YoY', 'Change vs the same period a year earlier'],
    ['ltm', 'LTM', 'Last 12 months: sum for volumes, average or ratio for prices and shares'], ['index', 'Index = 100', 'Every series rebased to 100 at the start of the window — compares different units']];
  var GR = { monthly: 'm', quarterly: 'q', annual: 'a' }, GRB = { m: 'monthly', q: 'quarterly', a: 'annual' };
  function palette() { return X.isDark() ? ['#FF5000', '#e8eaed', '#5b8fd6', '#3fb8a8'] : ['#FF5000', '#111111', '#3f72b5', '#2a9d8f']; }
  /* 10 cores para escolher a de cada série (as 4 primeiras = as de sempre); sem o verde e o vermelho, que dizem sobe/cai */
  function paletteX() { return X.isDark() ? ['#FF5000', '#e8eaed', '#5b8fd6', '#3fb8a8', '#c9b47a', '#a892d6', '#8fa9bf', '#d9a084', '#9cc0ea', '#d55181']
                                          : ['#FF5000', '#111111', '#3f72b5', '#2a9d8f', '#b79a5c', '#8a6fb3', '#5f7d95', '#b85c38', '#8fb3de', '#e87ba4']; }
  /* [chave, rótulo, dica, ícone] */
  var TYPES = [['line', 'Lines', 'One line per series', 'lines'], ['area', 'Area', 'Lines with the area filled', 'area'], ['col', 'Columns', 'One column per series in each period', 'col'],
    ['combo', 'Combo', 'The first series as columns, the others as lines', 'combo'], ['stack', 'Stacked', 'Columns stacked: the top is the sum of the series', 'stack'],
    ['stackarea', 'Stacked area', 'Areas stacked: the top edge is the sum of the series', 'stackarea'], ['pct', '100%', 'Each period adds up to 100%: the share of each series', 'pct'],
    ['scatter', 'Scatter', 'One series against another: each dot is a period, with the regression line', 'scatter'], ['year', 'By year', 'One line per year over the months of the year', 'year']];
  var DASH = { dash: [6, 4], dot: [1.5, 3] };
  /* a série andando no tempo: +n = cada valor aparece n períodos DEPOIS (para testar se ela antecede as outras) */
  function shiftArr(a, n) { if (!n || !a) return a; return a.map(function (_, i) { var j = i - n; return (j >= 0 && j < a.length) ? a[j] : null; }); }
  /* reta de mínimos quadrados y = a + b·x: {a, b, n, r, r2} (null com menos de 2 pontos ou x parado) */
  function fitLine(xs, ys) { var n = xs.length, mx = 0, my = 0, sxx = 0, sxy = 0, syy = 0, i; if (n < 2) return null;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
    for (i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    if (!(sxx > 0)) return null; var b0 = sxy / sxx; return { a: my - b0 * mx, b: b0, n: n, r: syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, r2: syy > 0 ? sxy * sxy / (sxx * syy) : null }; }
  function sgn(x, d) { return (x < 0 ? '−' : '+') + fmt(Math.abs(x), d); }
  function parseKey(key) {
    if (typeof key !== 'string') return null;
    if (key.indexOf('~') >= 0) { var p = key.split('~'); return p.length < 4 ? null : { type: 'e', sec: p[0], dim: p[1], prod: p[2], name: p.slice(3).join('~') }; }
    var q = key.split('.'); return q.length === 3 ? { type: 'm', sec: q[0], metric: q[1], prod: q[2] } : null;
  }
  function secProds(sec) { return sec.prods || sec.bprods || [{ k: 'total', l: '' }]; }
  function prodLabel(sec, k) { var l = ''; secProds(sec).forEach(function (p) { if (p.k === k) l = p.l || ''; }); return l; }
  /* a visão num texto curto: séries;séries!conta!granularidade!janela!de!até  ("!" dentro de um nome vira %21, senão partiria o texto) */
  function encKeys(a) { return a.map(function (k) { return encodeURIComponent(k).replace(/!/g, '%21'); }).join(';'); }
  function decKeys(t) { return String(t || '').split(';').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return ''; } }).filter(Boolean); }
  /* a 7ª parte (as séries do eixo da direita) só existe quando há alguma — os links antigos continuam iguais */
  function encodeView(v) { var a = [encKeys(v.s), v.v || 'level', GR[v.g] || '', v.w || '', v.from || '', v.to || ''], hasF = !!(v.f && Object.keys(v.f).length);
    if ((v.r && v.r.length) || hasF) a.push(v.r && v.r.length ? encKeys(v.r) : '');
    if (hasF) a.push(encodeURIComponent(JSON.stringify(v.f)).replace(/!/g, '%21')); return a.join('!'); }
  function decodeView(str) { var a = String(str || '').split('!'); if (!a[0]) return null;
    var o = { s: decKeys(a[0]), v: a[1] || 'level', g: GRB[a[2]] || null, w: a[3] || null, from: a[4] || null, to: a[5] || null }; if (a[6]) o.r = decKeys(a[6]);
    if (a[7]) { try { var f0 = JSON.parse(decodeURIComponent(a[7])); if (f0 && typeof f0 === 'object') o.f = f0; } catch (e) {} } return o; }
  function uniq(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
  /* R² entre duas séries nos períodos i0..i1 em que AS DUAS têm valor: {n, r, r2}; r2 = null com menos de 6 pares ou série parada */
  var R2_MIN = 6;
  function r2of(a, b, i0, i1) {
    if (X.r2of) return X.r2of(a, b, i0, i1);   // a conta mora no motor (data-desk.js); esta cópia só vale com um motor antigo
    var xs = [], ys = [], i, n, mx = 0, my = 0, sxy = 0, sxx = 0, syy = 0;
    for (i = i0; i <= i1; i++) if (a[i] != null && b[i] != null && isFinite(a[i]) && isFinite(b[i])) { xs.push(+a[i]); ys.push(+b[i]); }
    n = xs.length; if (n < R2_MIN) return { n: n, r: null, r2: null };
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
    for (i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (!(sxx > 0) || !(syy > 0)) return { n: n, r: null, r2: null };
    var r = sxy / Math.sqrt(sxx * syy); return { n: n, r: r, r2: r * r };
  }
  function sameSet(a, b) { a = a || []; b = b || []; return a.length === b.length && a.every(function (k) { return b.indexOf(k) >= 0; }); }
  function numTxt(v, dec, signed) { if (v == null || !isFinite(v)) return '—'; return (signed && v > 0 ? '+' : '') + fmt(v, dec).replace(/^-/, '−'); }

  Desk.prototype._bKey = function (what) { return (what === 'last' ? 'ibba_desk_builder_' : 'ibba_desk_views_') + (this.cfg.sector || 'x'); };
  Desk.prototype._bSaved = function () { try { var a = JSON.parse(localStorage.getItem(this._bKey('views')) || '[]'); return Array.isArray(a) ? a.filter(function (v) { return v && v.n && Array.isArray(v.s); }) : []; } catch (e) { return []; } };
  Desk.prototype._bStore = function () { var b = this.bui, o = { s: b.s.map(function (x) { return x.key; }), v: b.calc, r: b.s.filter(function (x) { return x.ax === 'R'; }).map(function (x) { return x.key; }) }, f = this._bPackF();
    if (Object.keys(f).length) o.f = f; try { localStorage.setItem(this._bKey('last'), JSON.stringify(o)); } catch (e) {} };
  /* o formato do gráfico num objeto curto: só o que difere do padrão (+ sx = o que cada série tem de próprio: tipo, cor, traço, deslocamento) */
  Desk.prototype._bPackF = function () { var b = this.bui, f = {}, k, src = b.f || {};
    for (k in src) { var x = src[k]; if (x !== undefined && x !== null && x !== '' && x !== false) f[k] = x; }
    var sx = {}; b.s.forEach(function (y) { var e = {}; if (y.ty) e.t = y.ty; if (y.cc != null) e.c = y.cc; if (y.ds) e.d = y.ds; if (y.lag) e.l = y.lag; if (Object.keys(e).length) sx[y.key] = e; });
    if (Object.keys(sx).length) f.sx = sx; return f; };

  /* ficha de uma série (sem calcular números): nome, unidade, seção. null = não existe / não vale para esse produto */
  Desk.prototype._bItem = function (key) {
    var C = this._bItems = this._bItems || {}; if (key in C) return C[key];
    var p = parseKey(key), sec = p && this.sections[p.sec], it = null, X0;
    if (sec && !sec.overview && !sec.builder && !sec.fixed && !(sec.off && sec.off())) { X0 = { prod: p.prod }; var pl = prodLabel(sec, p.prod), first = secProds(sec)[0].k;
      var suf = function (lab) { return (pl && p.prod !== first && lab.toLowerCase().indexOf(pl.toLowerCase()) < 0) ? lab + ' · ' + pl : lab; };
      try {
        if (p.type === 'm') { var M = null; sec.metrics.forEach(function (m) { if (m.id === p.metric) M = m; });
          /* M.bprods: indicador que só existe em alguns produtos (ex.: consumo aparente de papel = só o total) */
          if (M && !M.multi && (!M.available || M.available(X0)) && (!M.bprods || M.bprods.indexOf(p.prod) >= 0)) { var lab = typeof M.label === 'function' ? M.label(X0) : M.label;
            it = { key: key, type: 'm', sec: p.sec, metric: M.id, prod: p.prod, short: lab, name: suf(lab), unit: M.unit, diff: !!M.diff, where: sec.label + (sec.src ? ' · ' + sec.src : ''), group: M.group || '', paid: !!sec.paid, src: sec.src || '' }; } }
        else { var dim = null; (sec.who || []).forEach(function (d0) { if (d0.id === p.dim) dim = d0; });
          if (dim && !dim.noSelect && (!dim.available || dim.available(X0)) && this._bEntNames(p.sec, dim, p.prod).indexOf(p.name) >= 0)
            it = { key: key, type: 'e', sec: p.sec, dim: dim.id, prod: p.prod, short: p.name, name: suf(p.name + ' — ' + (dim.title || sec.label)), unit: dim.unit || 'kt', diff: false, where: (dim.title || sec.label) + (sec.src ? ' · ' + sec.src : '') }; }
      } catch (e) { it = null; }
    }
    return (C[key] = it);
  };
  Desk.prototype._bEntNames = function (secId, dim, prod) { var C = this._bEnt = this._bEnt || {}, k = secId + '|' + dim.id + '|' + prod; if (!C[k]) { try { C[k] = (dim.entities({ prod: prod }, null) || {}).names || []; } catch (e) { C[k] = []; } } return C[k]; };
  Desk.prototype._bSeries = function (key, gran) {
    var C = this._bData = this._bData || {}, k = key + '|' + gran; if (k in C) return C[k];
    var p = parseKey(key), d = null; try { d = this.seriesAll(p.sec, p.type === 'm' ? { metric: p.metric } : { dim: p.dim, name: p.name }, p.prod, gran); } catch (e) { d = null; }
    return (C[k] = d);
  };
  Desk.prototype._bGroups = function () { var S = this.sections, ord = (S.builder && S.builder.order) || Object.keys(S);
    return ord.filter(function (id) { return S[id] && !S[id].overview && !S[id].builder && !S[id].fixed && !(S[id].off && S[id].off()); }).map(function (id) { return { id: id, sec: S[id], prods: secProds(S[id]) }; }); };
  /* seções com dado à parte: pede o que falta e redesenha o Builder quando chega (uma promessa por seção) */
  Desk.prototype._bNeed = function () { var self = this, W = this._bNeedP = this._bNeedP || {}, on = (this.bui ? this.bui.s : []).map(function (x) { return parseKey(x.key); });
    this._bGroups().forEach(function (g) { if (!g.sec.need || W[g.id]) return; var p = null, ids = on.filter(function (q) { return q && q.type === 'm' && q.sec === g.id; }).map(function (q) { return q.metric; });
      try { p = g.sec.need(ids); } catch (e) { p = null; }
      if (p && p.then) W[g.id] = p.then(function () { delete W[g.id]; self.invalidate(); if (self.cur === 'builder') self._builder(); }, function () { delete W[g.id]; }); }); };
  /* alguma série do gráfico vem de fonte paga (agência)? então sem Excel e sem copiar a tabela */
  Desk.prototype._bPaid = function () { var v = this._bv; return !!(v && v.rows.some(function (r) { return r.it && r.it.paid; })); };
  Desk.prototype._bPaidSrc = function () { var v = this._bv, out = []; (v ? v.rows : []).forEach(function (r) { if (r.it && r.it.paid && r.it.src && out.indexOf(r.it.src) < 0) out.push(r.it.src); }); return out.join(', ') || 'agency'; };
  Desk.prototype._bLoading = function () { return !!(this._bNeedP && Object.keys(this._bNeedP).length); };

  /* estado: 1º a visão que veio no link (?bv=), 2º a última em que a pessoa trabalhou, 3º a 1ª visão pronta — nunca tela vazia */
  Desk.prototype._bState = function () {
    if (this.bui) return this.bui;
    var b = this.bui = { s: [], calc: 'level', hover: null, q: '', prod: {}, open: {}, saving: false, sheet: false, msg: '' }, sec = this.sections.builder, v = null, link = false;
    try { var qs = new URLSearchParams(location.search), bv = qs.get('bv'); if (bv) { v = decodeView(bv); link = !!v; qs.delete('bv'); var rest = qs.toString(); history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } } catch (e) {}
    if (!v) { try { v = JSON.parse(localStorage.getItem(this._bKey('last')) || 'null'); } catch (e) { v = null; } }
    if (!v || !Array.isArray(v.s) || !v.s.length) v = (sec.presets || [])[0] || { s: [] };
    this._bApply(v, link);
    if (!b.s.length && (sec.presets || [])[0]) this._bApply(sec.presets[0], false);
    return b;
  };
  Desk.prototype._bApply = function (v, withFilters) {
    var b = this.bui, self = this; b.s = []; b.hover = null; b.msg = '';
    (v.s || []).forEach(function (key) { if (b.s.length < MAX && !b.s.some(function (x) { return x.key === key; }) && self._bItem(key)) b.s.push({ key: key, col: self._bFree() }); });
    b.s.forEach(function (x) { if ((v.r || []).indexOf(x.key) >= 0) x.ax = 'R'; });
    if (b.s.every(function (x) { return x.ax === 'R'; })) b.s.forEach(function (x) { delete x.ax; });   // a esquerda nunca fica vazia
    b.calc = CALCS.some(function (c0) { return c0[0] === v.v; }) ? v.v : 'level';
    var old = b.f || {}, keep = {}; ['t', 'z', 'lg', 'iL', 'iR', 'tr', 'av', 'lb'].forEach(function (k) { if (old[k] != null) keep[k] = old[k]; });
    b.f = v.f ? JSON.parse(JSON.stringify(v.f)) : keep; var sx = b.f.sx || {}; delete b.f.sx; b.pop = null;
    b.s.forEach(function (x) { var e = sx[x.key]; if (!e) return; if (e.t) x.ty = e.t; if (e.c != null && e.c >= 0 && e.c < 10) x.cc = +e.c; if (e.d) x.ds = e.d; if (e.l) x.lag = Math.max(-24, Math.min(24, +e.l || 0)) || undefined; });
    if (withFilters && this.cfg.setFilters && (v.g || v.w)) { this._bBusy = true; try { this.cfg.setFilters({ gran: v.g || null, win: v.w || null, from: v.from || null, to: v.to || null }); } catch (e) {} this._bBusy = false; }
    this._bStore();
  };
  Desk.prototype._bFree = function () { var used = {}, i; this.bui.s.forEach(function (x) { used[x.col] = 1; }); for (i = 0; i < MAX; i++) if (!used[i]) return i; return 0; };
  Desk.prototype._bUnits = function () { var self = this, u = []; this.bui.s.forEach(function (x) { var it = self._bItem(x.key); if (it && u.indexOf(it.unit) < 0) u.push(it.unit); }); return u; };
  /* uma combinação de séries e eixos vale? Um lado com unidades diferentes leva TUDO para a base 100 — e série que pode ser
     zero ou negativa (um spread) não tem base 100. null = vale; senão, o motivo */
  Desk.prototype._bAxisWhy = function (list) { var self = this, side = { L: [], R: [] };
    list.forEach(function (y) { var it = self._bItem(y.key); if (it) side[y.ax === 'R' ? 'R' : 'L'].push(it); });
    var mixed = ['L', 'R'].some(function (k) { return uniq(side[k].map(function (i) { return i.unit; })).length > 1; }); if (!mixed) return null;
    var d0 = side.L.concat(side.R).filter(function (i) { return i.diff; })[0];
    return d0 ? d0.short + ' can be zero or negative, so it cannot go on base 100 next to other units' : null; };
  /* onde uma série nova entra: à esquerda (o padrão; unidades diferentes → base 100) ou, quando a base 100 não serve (spread na
     conta), sozinha na escala da direita. {ax, why} — why = não dá para entrar agora */
  Desk.prototype._bPlace = function (key) { var b = this.bui, it = this._bItem(key);
    var L = b.s.concat([{ key: key }]), why = this._bAxisWhy(L); if (!why) return { ax: 'L' };
    if (b.s.length && b.s.some(function (x) { return x.ax !== 'R'; })) { var R = b.s.concat([{ key: key, ax: 'R' }]); if (!this._bAxisWhy(R)) return { ax: 'R' }; }
    return { ax: 'L', why: why + (it && it.diff ? ' — compare it with series in ' + it.unit + ' or use the right axis' : ' — remove it, or put the other unit on the right axis') }; };
  /* por que este item não pode entrar agora (null = pode) */
  Desk.prototype._bWhy = function (key) { var b = this.bui, it = this._bItem(key); if (!it) return 'Not available';
    if (b.s.some(function (x) { return x.key === key; })) return null;
    if (b.s.length >= MAX) return 'Up to ' + MAX + ' series at a time: remove one first';
    return this._bPlace(key).why || null; };
  /* leva uma série do gráfico para a escala da direita (ou de volta para a esquerda) */
  Desk.prototype._bAxis = function (key) { var b = this.bui, x = null; b.s.forEach(function (y) { if (y.key === key) x = y; }); if (!x) return; b.msg = '';
    var toR = x.ax !== 'R', trial = b.s.map(function (y) { return y === x ? { key: y.key, ax: toR ? 'R' : 'L' } : y; });
    if (toR && !trial.some(function (y) { return y.ax !== 'R'; })) { b.msg = 'Keep at least one series on the left axis'; this._bStage(); return; }
    var why = this._bAxisWhy(trial); if (why) { b.msg = why; this._bStage(); return; }
    if (toR) x.ax = 'R'; else delete x.ax;
    b.hover = null; this._bStore(); this._bViews(); this._bStage(); };
  Desk.prototype._bToggle = function (key) { var b = this.bui, i = -1; b.s.forEach(function (x, k) { if (x.key === key) i = k; }); b.msg = '';
    if (i >= 0) { b.s.splice(i, 1); if (b.s.length && b.s.every(function (x) { return x.ax === 'R'; })) b.s.forEach(function (x) { delete x.ax; }); }   // a esquerda nunca fica vazia
    else { var why = this._bWhy(key); if (why) { b.msg = why; this._bStage(); return; } var pl = this._bPlace(key), nx = { key: key, col: this._bFree() }; if (pl.ax === 'R') nx.ax = 'R'; b.s.push(nx); }
    b.hover = null; this._bStore(); this._bNeed(); this._bViews(); this._bCat(); this._bStage(); };
  Desk.prototype._bCurrent = function () { var st = this.cfg.state(), b = this.bui, r = b.s.filter(function (x) { return x.ax === 'R'; }).map(function (x) { return x.key; }), o = { s: b.s.map(function (x) { return x.key; }), v: b.calc, g: st.gran, w: st.win, from: st.win === 'custom' ? st.from : null, to: st.win === 'custom' ? st.to : null }; if (r.length) o.r = r;
    var f = this._bPackF(); if (Object.keys(f).length) o.f = f; return o; };
  function sameView(a, b) { return a.v === (b.v || 'level') && a.s.length === (b.s || []).length && a.s.every(function (k) { return b.s.indexOf(k) >= 0; }) && sameSet(a.r, b.r); }
  /* ↺ RESET (26/11/2026; ver resetView em data-desk.js): a visão de abertura — a 1ª visão pronta, do jeito que o Builder abre sem
     histórico (as séries e a conta dela; granularidade e janela ficam as da página, que o Reset também zera) —, busca e produto do
     catálogo limpos, listas fechadas. As visões salvas ficam. */
  Desk.prototype._bReset = function () { var sec = this.sections.builder, b = this._bState();
    b.q = ''; b.prod = {}; b.open = {}; b.saving = false; b.sheet = false; b.hover = null; b.f = {}; b.xo = null; b.pop = null;
    this._bApply((sec.presets || [])[0] || { s: [] }, false);
    if (this.bel && this.bel.bq) this.bel.bq.value = ''; };
  /* o Builder está na visão de abertura? (a série que não existe para esta pessoa sai da conta, como no _bApply) */
  Desk.prototype._bAtDefault = function () { var b = this.bui, self = this, p = (this.sections.builder.presets || [])[0]; if (!b) return true;
    if (b.q || this._bGroups().some(function (g) { var k = b.prod[g.id]; return k && g.prods.length && k !== g.prods[0].k; })) return false;
    if (Object.keys(this._bPackF()).length) return false;   // tipo de gráfico, formato ou ajuste de alguma série
    if (!p) return !b.s.length;
    var want = { v: p.v || 'level', s: (p.s || []).filter(function (k) { return !!self._bItem(k); }).slice(0, MAX), r: p.r },
        cur = { v: b.calc, s: b.s.map(function (x) { return x.key; }), r: b.s.filter(function (x) { return x.ax === 'R'; }).map(function (x) { return x.key; }) };
    return sameView(cur, want); };

  /* do palco de uma seção para o Builder: uma visão nova só com o que está no palco */
  Desk.prototype.builderFrom = function () { var c = this.ctx, u = this._u(), sid = this.cur; if (!c || !this.sections.builder) return;
    var keys = c.subs(u.metric).map(function (M) { return sid + '.' + M.id + '.' + c.st.prod; }); this._bState();
    this._bApply({ s: keys, v: (u.mode === 'yoy' || u.mode === 'ltm') ? u.mode : 'level' }, false);
    if (!this.bui.s.length && (this.sections.builder.presets || [])[0]) this._bApply(this.sections.builder.presets[0], false);
    if (this.cfg.gotoBuilder) this.cfg.gotoBuilder(); };

  /* ── a conta da visão: eixo comum, janela da barra de filtros, valores na conta escolhida, painéis por unidade ── */
  Desk.prototype._bView = function () {
    var st = this.cfg.state(), gran = st.gran, b = this.bui, self = this, pal = palette();
    if (gran === 'annual' && b.calc === 'ltm') b.calc = 'level';
    var PX = paletteX(), rows = []; b.s.forEach(function (s0) { var it = self._bItem(s0.key), d = it && self._bSeries(s0.key, gran);
      if (it && d) rows.push({ key: s0.key, col: s0.cc != null ? PX[s0.cc % PX.length] : pal[s0.col % pal.length], it: it, d: d, ax: s0.ax === 'R' ? 'R' : 'L', ty: s0.ty || '', ds: s0.ds || '', lag: s0.lag || 0 }); });
    /* dois eixos só quando há série dos DOIS lados; tudo de um lado = um eixo */
    var dual = rows.some(function (r) { return r.ax === 'R'; }) && rows.some(function (r) { return r.ax === 'L'; }); if (!dual) rows.forEach(function (r) { r.ax = 'L'; });
    /* contas em unidades diferentes NUM MESMO EIXO não se comparam: a visão vai para a BASE 100 (um gráfico só).
       want = a conta que a pessoa escolheu · calc = a que vale · mixed[conta] = essa conta daria mais de uma unidade num eixo */
    var unitIn = function (d, k) { return k === 'index' ? 'Index' : k === 'yoy' ? (d.pp ? 'pp' : d.diff ? d.unit : '%') : d.unit; };
    /* Scatter: cada eixo tem a sua unidade (a série do X fica fora da conta do eixo vertical); By year: uma série só — nenhum dos dois
       precisa da base 100 automática, os números aparecem de verdade */
    var tW = (b.f && b.f.t) || 'line', exX = null; if (tW === 'scatter' && rows.length >= 2) { exX = rows[0].key; rows.forEach(function (r) { if (r.key === b.f.xk) exX = r.key; }); }
    var unitsOf = function (k, side) { var us = []; rows.forEach(function (r) { if (side && r.ax !== side) return; if (exX && r.key === exX) return; var u0 = unitIn(r.d, k); if (us.indexOf(u0) < 0) us.push(u0); }); return us; };
    var mixedK = function (k) { if (tW === 'year' && gran !== 'annual' && rows.length) return false; return unitsOf(k, 'L').length > 1 || unitsOf(k, 'R').length > 1; };
    var us0 = unitsOf(b.calc), auto = b.calc !== 'index' && mixedK(b.calc), calc = auto ? 'index' : b.calc;
    var out = { rows: rows, P: [], i0: 0, i1: -1, panels: [], gran: gran, calc: calc, want: b.calc, auto: auto, units: us0, dual: dual,
      mixed: { level: mixedK('level'), yoy: mixedK('yoy'), ltm: mixedK('ltm') }, T: 'line', tWant: (b.f && b.f.t) || 'line', tOff: {} };
    /* o tipo de gráfico que vale para estas séries; os outros ficam apagados com o motivo */
    var oneU = unitsOf(calc).length <= 1, stackWhy = dual ? 'Stacking needs one axis: bring every series back to the left axis' : (!oneU || auto) ? 'Stacking adds the series up: they need the same unit'
      : (calc === 'yoy' || calc === 'index') ? 'Stacking adds the series up: use Level or LTM' : null;
    out.tOff = { stack: stackWhy, stackarea: stackWhy, pct: stackWhy, scatter: rows.length < 2 ? 'Needs at least two series' : null, year: gran === 'annual' ? 'Not in the annual view — pick Monthly or Quarterly' : (rows.length ? null : 'Needs a series') };
    out.T = out.tOff[out.tWant] ? 'line' : out.tWant;
    if (!rows.length) return out;
    var lo = null, hi = null; rows.forEach(function (r) { var f = -1, l = -1; r.d.level.forEach(function (x, i) { if (x != null) { if (f < 0) f = i; l = i; } }); if (f < 0) return;
      if (lo == null || r.d.starts[f] < lo) lo = r.d.starts[f]; if (hi == null || r.d.ends[l] > hi) hi = r.d.ends[l]; });
    if (lo == null) return out;
    var ax = core.axis(lo, hi), P = core.buildPeriods(ax, gran, false); if (!P.length) return out;
    var mw = core.monthWindow(ax, ax.length - 1, st), pw = core.periodWindow(P, mw[0], mw[1]); out.P = P; out.i0 = pw[0]; out.i1 = pw[1];
    var gname = { monthly: 'months', quarterly: 'quarters', annual: 'years' }[gran] || 'periods';
    rows.forEach(function (r) { var src = calc === 'yoy' ? r.d.yoy : calc === 'ltm' ? r.d.ltm : r.d.level, map = {}, lm = {}, i;
      r.d.keys.forEach(function (k, j) { if (r.d.partial[j]) return; map[k] = src ? src[j] : null; lm[k] = r.d.level[j]; });   // período em andamento fica de fora
      r.unit = unitIn(r.d, calc); r.dec = (calc === 'index' || calc === 'yoy') ? 1 : r.d.dec; r.note = '';
      r.lev = P.map(function (p) { var x = lm[p.key]; return x == null ? null : x; });   // o nível de verdade (a ficha mostra ao lado do índice)
      if (calc === 'index') { var base = null, bi = -1; for (i = pw[0]; i <= pw[1]; i++) { var x0 = lm[P[i].key]; if (x0 != null && x0 > 0) { base = x0; bi = i; break; } }
        var ok = base != null && !r.d.diff; r.v = P.map(function (p) { var x = lm[p.key]; return (ok && x != null) ? x / base * 100 : null; });
        r.note = !ok ? 'cannot be indexed (it can be zero or negative)' : (bi > pw[0] ? '100 = ' + P[bi].label : ''); }
      else r.v = P.map(function (p) { var x = map[p.key]; return x == null ? null : x; });
      if (r.lag) { r.v = shiftArr(r.v, r.lag); r.lev = shiftArr(r.lev, r.lag); } });   // deslocada no tempo: o gráfico, a tabela, o Excel e o R² usam a série andada
    if (out.T === 'pct' && rows.some(function (r) { for (var i = out.i0; i <= out.i1; i++) if (r.v[i] != null && r.v[i] < 0) return true; return false; })) { out.tOff.pct = '100% needs values that are zero or positive'; out.T = 'line'; }
    /* R² de cada série contra a 1ª (PNG) e de cada PAR (a tabela ao lado da explicação), na janela e na conta da tela */
    rows.forEach(function (r, k) { r.fit = k ? r2of(rows[0].v, r.v, out.i0, out.i1) : null; if (r.fit) r.fit.per = gname; });
    out.per = gname; out.cells = (rows.length > 1 && X.corrCells) ? X.corrCells(rows.map(function (r) { return r.v; }), out.i0, out.i1) : null;
    if (dual) {   // um gráfico com duas escalas: a da esquerda e a da direita, cada uma na sua unidade
      var pl = { dual: true, unit: rows.filter(function (r) { return r.ax === 'L'; })[0].unit, unitR: rows.filter(function (r) { return r.ax === 'R'; })[0].unit, rows: rows, dec: 0, decR: 0 };
      rows.forEach(function (r) { if (r.ax === 'R') pl.decR = Math.max(pl.decR, r.dec); else pl.dec = Math.max(pl.dec, r.dec); }); out.panels = [pl]; return out; }
    rows.forEach(function (r) { var pn = null; out.panels.forEach(function (q) { if (q.unit === r.unit) pn = q; }); if (!pn) out.panels.push(pn = { unit: r.unit, rows: [], dec: 0 }); pn.rows.push(r); pn.dec = Math.max(pn.dec, r.dec); });
    return out;
  };

  /* ── esqueleto (uma vez) ── */
  Desk.prototype._bBuild = function () {
    var r = this.root, self = this, b = this.bui; r.innerHTML = '';
    var body = h('div', 'dk-body dk-bld',
      '<div class="dk-bviews"><span class="dk-plbl">Views</span><div class="dk-bvlist"></div><span class="dk-grow"></span><div class="dk-bsave"></div><button type="button" class="dk-pill dk-blink" title="Copy a link that reopens exactly this view (series, calculation, granularity and window)">Copy link</button></div>' +
      '<div class="dk-bgrid"><aside class="dk-card dk-bcat"><div class="dk-ch"><h3>Series</h3><em class="dk-bcount"></em></div>' +
        '<p class="dk-bhelp">Click a series to add it to the chart; click again to remove it.</p>' +
        '<input type="search" class="dk-bq" placeholder="Search any series, country or port…" aria-label="Search series"><div class="dk-blist"></div>' +
        '<button type="button" class="dk-pill dk-bdone">Done</button></aside>' +
      '<div class="dk-bmain"><div class="dk-card dk-stage dk-bstage">' +
        '<div class="dk-bhead"><div class="dk-btitle"><span class="dk-st">Builder</span><em class="dk-when dk-bwhen"></em></div><span class="dk-grow"></span>' +
          '<div class="dk-seg dk-bcalc" role="group" aria-label="Calculation"></div><div class="dk-bdl"><button type="button" data-dl="png" title="Download the chart as an image">PNG</button><button type="button" data-dl="xls" title="Download the data (Excel) — full history">XLS</button></div></div>' +
        '<div class="dk-btools"><div class="dk-btype"></div><div class="dk-bfmt"></div><div class="dk-bxtra" hidden></div></div>' +
        '<div class="dk-whyrow"><div class="dk-why dk-bwhy" hidden></div><div class="dk-corr dk-bcorr" hidden></div></div><div class="dk-bchips"></div><button type="button" class="dk-pill dk-badd">+ Add series</button><div class="dk-bpop" hidden></div>' +
        '<div class="dk-bpanels"></div><div class="dk-bmsg" hidden></div><div class="dk-hint dk-bhint"></div></div>' +
      '<div class="dk-card dk-bvals"><div class="dk-ch"><h3>Values</h3><em class="dk-when dk-bvw"></em><span class="dk-grow"></span><button type="button" class="dk-lnk dk-bcopy" title="Copy every period of the window, ready to paste into Excel">Copy table</button></div><div class="dk-tblw"><table class="dk-ov dk-bt"></table></div></div>' +
      '</div></div>');
    r.appendChild(body); var E = this.bel = { body: body }; ['bvlist', 'bsave', 'blink', 'bcat', 'bcount', 'bq', 'blist', 'bcalc', 'bchips', 'bpanels', 'bmsg', 'bhint', 'bwhen', 'bvw', 'bt', 'bcopy', 'bdl', 'badd', 'bdone', 'bwhy', 'bcorr', 'btools', 'btype', 'bfmt', 'bxtra', 'bpop'].forEach(function (k) { E[k] = body.querySelector('.dk-' + k); });
    E.bq.value = b.q;
    /* visões */
    E.bvlist.addEventListener('click', function (e) { var del = e.target.closest('[data-del]'), bt = e.target.closest('[data-view]'); if (del) { e.stopPropagation(); var a = self._bSaved(); a.splice(+del.dataset.del, 1); try { localStorage.setItem(self._bKey('views'), JSON.stringify(a)); } catch (er) {} self._bViews(); return; }
      if (!bt) return; var kind = bt.dataset.view.charAt(0), ix = +bt.dataset.view.slice(1), v = kind === 'p' ? (self.sections.builder.presets || [])[ix] : self._bSaved()[ix]; if (!v) return;
      self._bApply(v, true); self._builder(); });
    E.bsave.addEventListener('click', function (e) { var a = e.target.closest('[data-a]'); if (!a) return; if (a.dataset.a === 'open') { b.saving = true; self._bViews(); var inp = E.bsave.querySelector('input'); if (inp) inp.focus(); } else if (a.dataset.a === 'cancel') { b.saving = false; self._bViews(); } else if (a.dataset.a === 'ok') self._bSaveView(); });
    E.bsave.addEventListener('keydown', function (e) { if (e.target.tagName !== 'INPUT') return; if (e.key === 'Enter') self._bSaveView(); if (e.key === 'Escape') { b.saving = false; self._bViews(); } });
    E.blink.addEventListener('click', function () { var url = location.origin + location.pathname + '?bv=' + encodeURIComponent(encodeView(self._bCurrent())) + '#builder';
      copyText(url, function (ok) { E.blink.textContent = ok ? 'Link copied ✓' : 'Could not copy'; setTimeout(function () { E.blink.textContent = 'Copy link'; }, 1800); }); });
    /* catálogo */
    E.bq.addEventListener('input', function () { b.q = E.bq.value; self._bCat(); });
    E.blist.addEventListener('click', function (e) { var row = e.target.closest('.dk-brow'), pp = e.target.closest('[data-bprod]'), en = e.target.closest('[data-bent]');
      if (row) { self._bToggle(row.dataset.key); return; }
      if (pp) { b.prod[pp.dataset.g] = pp.dataset.bprod; self._bCat(); return; }
      if (en) { b.open[en.dataset.bent] = !b.open[en.dataset.bent]; self._bCat(); } });
    E.badd.addEventListener('click', function () { b.sheet = true; body.classList.add('dk-sheet'); });
    E.bdone.addEventListener('click', function () { b.sheet = false; body.classList.remove('dk-sheet'); });
    body.addEventListener('click', function (e) { if (e.target === body && b.sheet) { b.sheet = false; body.classList.remove('dk-sheet'); } });   // celular: tocar fora da folha fecha
    /* palco */
    E.bcalc.addEventListener('click', function (e) { var bt = e.target.closest('button'); if (!bt || bt.disabled) return; b.calc = bt.dataset.k; b.msg = ''; b.hover = null; self._bStore(); self._bViews(); self._bCat(); self._bStage(); });
    /* ferramentas: tipo de gráfico, botões de formato, rótulos, faixa dos eixos, título; no Scatter o eixo X, no By year a série */
    E.btools.addEventListener('click', function (e) { var bt = e.target.closest('button'); if (!bt || bt.disabled) return; var f = b.f || (b.f = {}), v0 = self._bv || {};
      if (bt.dataset.sty) { if (bt.dataset.sty === 'line') delete f.t; else f.t = bt.dataset.sty; }
      else if (bt.dataset.f === 'tr') f.tr = (f.tr === 1 || (f.tr == null && v0.T === 'scatter')) ? 0 : 1;
      else if (bt.dataset.f === 'swap') { var ks = (v0.rows || []).map(function (r) { return r.key; }), cx = ks.indexOf(f.xk) >= 0 ? f.xk : ks[0]; if (ks.length > 1) f.xk = ks[(ks.indexOf(cx) + 1) % ks.length]; }
      else if (bt.dataset.f) { if (f[bt.dataset.f]) delete f[bt.dataset.f]; else f[bt.dataset.f] = 1; }
      else if (bt.dataset.lb != null) { if (bt.dataset.lb) f.lb = bt.dataset.lb; else delete f.lb; }
      else if (bt.dataset.x === 'auto') { delete f.mn; delete f.mx; delete f.mn2; delete f.mx2; }
      else if (bt.dataset.x === 'clrttl') delete f.ti;
      else if (bt.dataset.x) b.xo = b.xo === bt.dataset.x ? null : bt.dataset.x;
      else return;
      b.hover = null; self._bStore(); self._bViews(); self._bStage(); });
    E.btools.addEventListener('change', function (e) { var el = e.target, f = b.f || (b.f = {});
      if (el.dataset.sel) f[el.dataset.sel] = el.value;
      else if (el.dataset.in === 'ti') { var tv = el.value.trim().slice(0, 90); if (tv) f.ti = tv; else delete f.ti; }
      else if (el.dataset.in) { var nv = el.value.trim(); if (nv === '' || !isFinite(+nv)) delete f[el.dataset.in]; else f[el.dataset.in] = +nv; }
      else return;
      self._bStore(); self._bViews(); self._bStage(); });
    E.btools.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.in) e.target.blur(); });
    /* o painel de formato de UMA série (abre pelo ● da ficha): tipo, cor, traço, deslocamento no tempo, eixo */
    E.bpop.addEventListener('click', function (e) { var bt = e.target.closest('[data-pf]'); if (!bt) return; e.stopPropagation(); var pf = bt.dataset.pf;
      if (pf === 'close') { b.pop = null; self._bPop(); return; }
      var s0 = null; b.s.forEach(function (x) { if (x.key === b.pop) s0 = x; }); if (!s0) return; var k = pf.split(':')[0], val = pf.slice(k.length + 1);
      if (k === 't') { if (val) s0.ty = val; else delete s0.ty; }
      else if (k === 'c') s0.cc = +val;
      else if (k === 'd') { if (val) s0.ds = val; else delete s0.ds; }
      else if (k === 'l') { var lg = val === '0' ? 0 : Math.max(-24, Math.min(24, (s0.lag || 0) + (+val))); if (lg) s0.lag = lg; else delete s0.lag; }
      else if (k === 'ax') { if ((s0.ax === 'R') !== (val === 'R')) self._bAxis(s0.key); self._bPop(); return; }
      self._bStore(); self._bViews(); self._bStage(); });
    if (!this._bDocClick) { this._bDocClick = true; document.addEventListener('click', function (e) { var b1 = self.bui; if (!b1 || !b1.pop || e.target.closest('.dk-bpop') || e.target.closest('[data-fmt]')) return; b1.pop = null; self._bPop(); }); }
    E.bchips.addEventListener('click', function (e) { var x = e.target.closest('[data-x]'), go = e.target.closest('[data-go]'), ax = e.target.closest('[data-ax]'), fm = e.target.closest('[data-fmt]');
      if (fm) { b.pop = b.pop === fm.dataset.fmt ? null : fm.dataset.fmt; self._bPop(); return; }
      if (x) { self._bToggle(x.dataset.x); return; }
      if (ax) { self._bAxis(ax.dataset.ax); return; }
      if (go) { var it = self._bItem(go.dataset.go); if (it && self.cfg.goto) self.cfg.goto({ sec: it.sec, metric: it.type === 'm' ? it.metric : self.sections[it.sec].stage, prod: it.prod }); } });
    E.bdl.addEventListener('click', function (e) { var bt = e.target.closest('button'); if (!bt || bt.disabled) return; if (bt.dataset.dl === 'png') self._bPNG(); else self._bXLS(); });
    E.bcopy.addEventListener('click', function () { if (self._bPaid()) return; var t = self._bTable(true); copyText(t, function (ok) { E.bcopy.textContent = ok ? 'Copied ✓' : 'Could not copy'; setTimeout(function () { E.bcopy.textContent = 'Copy table'; }, 1800); }); });
    E.bpanels.addEventListener('pointermove', function (e) { var cv = e.target.closest('canvas'); if (!cv) return; var ch = self.charts['b:' + cv.dataset.p]; if (!ch || !ch.chartArea || ch.$noSync) return;
      var rc = cv.getBoundingClientRect(), n = ch.data.labels.length, i = Math.max(0, Math.min(n - 1, Math.round(ch.scales.x.getValueForPixel(e.clientX - rc.left)))); self._bHover(i); });
    E.bpanels.addEventListener('pointerleave', function () { self._bHover(null); });
    if (b.sheet) body.classList.add('dk-sheet');
  };
  function copyText(t, cb) { var done = function (ok) { try { cb(ok); } catch (e) {} };
    var fallback = function () { try { var ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); done(ok); } catch (e) { done(false); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { done(true); }, fallback); else fallback(); }

  Desk.prototype._bSaveView = function () { var b = this.bui, inp = this.bel.bsave.querySelector('input'), n = inp ? inp.value.trim().slice(0, 40) : ''; if (!n) { if (inp) inp.focus(); return; }
    var a = this._bSaved().filter(function (v) { return v.n !== n; }), cur = this._bCurrent(); cur.n = n; a.push(cur); while (a.length > MAXV) a.shift();
    try { localStorage.setItem(this._bKey('views'), JSON.stringify(a)); } catch (e) {} b.saving = false; this._bViews(); };

  Desk.prototype._bViews = function () {
    var E = this.bel, b = this.bui, cur = this._bCurrent(), pre = this.sections.builder.presets || [], sv = this._bSaved();
    E.bvlist.innerHTML = pre.map(function (v, i) { return '<button type="button" class="dk-pill" data-view="p' + i + '" aria-pressed="' + sameView(cur, v) + '"' + (v.tip ? ' title="' + esc(v.tip) + '"' : '') + '>' + esc(v.n) + '</button>'; }).join('') +
      (sv.length ? '<span class="dk-bsep" aria-hidden="true"></span>' : '') +
      sv.map(function (v, i) { return '<span class="dk-bsaved"><button type="button" class="dk-pill" data-view="s' + i + '" aria-pressed="' + sameView(cur, v) + '" title="Saved in this browser">' + esc(v.n) + '</button><button type="button" class="dk-bdel" data-del="' + i + '" aria-label="Delete the saved view ' + esc(v.n) + '" title="Delete this saved view">×</button></span>'; }).join('');
    E.bsave.innerHTML = b.saving ? '<input type="text" maxlength="40" placeholder="Name this view" aria-label="Name of the view"><button type="button" class="dk-pill dk-bok" data-a="ok">Save</button><button type="button" class="dk-lnk" data-a="cancel">Cancel</button><span class="dk-bnote">Saved in this browser only</span>'
      : '<button type="button" class="dk-pill" data-a="open" title="Keep this combination under a name — it stays in this browser"' + (b.s.length ? '' : ' disabled') + '>+ Save this view</button>';
  };

  /* linha do catálogo */
  Desk.prototype._bRow = function (key, label, sub) { var b = this.bui, it = this._bItem(key); if (!it) return '';
    var on = null; b.s.forEach(function (x) { if (x.key === key) on = x; }); var why = on ? null : this._bWhy(key), pal = palette(), toR = !on && !why && b.s.length < MAX && this._bPlace(key).ax === 'R';
    return '<button type="button" class="dk-brow' + (on ? ' dk-on' : '') + (why ? ' dk-dis' : '') + '" data-key="' + esc(key) + '" aria-pressed="' + !!on + '" title="' + esc(why || (on ? 'On the chart — click to remove' : toR ? 'Click to add — it goes on the right-hand scale (it cannot go on base 100 next to the other units)' : 'Click to add to the chart')) + '">' +
      '<i' + (on ? ' style="background:' + pal[on.col % pal.length] + ';border-color:' + pal[on.col % pal.length] + '"' : '') + '></i><span class="dk-bn">' + esc(label || it.short) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span><span class="dk-bu">' + esc(it.unit) + '</span></button>'; };
  Desk.prototype._bCat = function () {
    var E = this.bel, b = this.bui, self = this, q = (b.q || '').trim().toLowerCase(), groups = this._bGroups(), html = '', top = E.blist.scrollTop;
    E.bcount.textContent = b.s.length + ' of ' + MAX + ' on the chart';
    if (q.length >= 2) {   // busca: todas as seções × todos os produtos × todas as entidades
      var hits = [], seen = {}, add = function (key, sub) { if (seen[key] || hits.length >= 60) return; var it = self._bItem(key); if (it && it.name.toLowerCase().indexOf(q) >= 0) { seen[key] = 1; hits.push([key, sub]); } };
      groups.forEach(function (g) { g.prods.forEach(function (p) { g.sec.metrics.forEach(function (M) { add(g.id + '.' + M.id + '.' + p.k, g.sec.label + (p.l && g.prods.length > 1 ? ' · ' + p.l : '')); }); }); });
      groups.forEach(function (g) { g.prods.forEach(function (p) { (g.sec.who || []).forEach(function (dim) { if (dim.noSelect || (dim.available && !dim.available({ prod: p.k }))) return;
        self._bEntNames(g.id, dim, p.k).forEach(function (n) { if (n.toLowerCase().indexOf(q) >= 0) add(g.id + '~' + dim.id + '~' + p.k + '~' + n, (dim.title || g.sec.label) + (p.l && g.prods.length > 1 ? ' · ' + p.l : '')); }); }); }); });
      html = hits.length ? hits.map(function (x) { var it = self._bItem(x[0]); return self._bRow(x[0], it.type === 'e' ? it.short : it.name, x[1]); }).join('') + (hits.length >= 60 ? '<p class="dk-note">Showing the first 60 matches — type more to narrow it down.</p>' : '')
        : '<p class="dk-note">No series matches “' + esc(b.q) + '”.</p>';
    } else groups.forEach(function (g) {
      var prod = b.prod[g.id]; if (!g.prods.some(function (p) { return p.k === prod; })) prod = b.prod[g.id] = g.prods[0].k;
      html += '<div class="dk-bg"><span>' + esc(g.sec.label) + '</span>' + (g.sec.src ? '<em>' + esc(g.sec.src) + '</em>' : '') + '</div>';
      if (g.prods.length > 1) html += '<div class="dk-bprods" role="group" aria-label="Product">' + g.prods.map(function (p) { return '<button type="button" class="dk-pill" data-g="' + esc(g.id) + '" data-bprod="' + esc(p.k) + '" aria-pressed="' + (p.k === prod) + '">' + esc(p.l || p.k) + '</button>'; }).join('') + '</div>';
      var lastG = '';
      g.sec.metrics.forEach(function (M) { var row = self._bRow(g.id + '.' + M.id + '.' + prod); if (!row) return; var G = M.group || ''; if (G && G !== lastG) { html += '<div class="dk-bsub">' + esc(G) + '</div>'; } lastG = G || lastG; html += row; });
      (g.sec.who || []).forEach(function (dim) { if (dim.noSelect || (dim.available && !dim.available({ prod: prod }))) return;
        var id = g.id + '|' + dim.id, names = self._bEntNames(g.id, dim, prod), open = !!b.open[id]; if (!names.length) return;
        var picked = names.filter(function (n) { return b.s.some(function (x) { return x.key === g.id + '~' + dim.id + '~' + prod + '~' + n; }); });
        html += '<button type="button" class="dk-bent" data-bent="' + esc(id) + '" aria-expanded="' + open + '">' + esc(dim.tab || dim.label) + ' <em>' + names.length + ' ' + esc(dim.noun || 'items') + '</em><span>' + (open ? '−' : '+') + '</span></button>';
        var show = open ? names.slice(0, 10) : []; picked.forEach(function (n) { if (show.indexOf(n) < 0) show.push(n); });
        html += show.map(function (n) { return self._bRow(g.id + '~' + dim.id + '~' + prod + '~' + n); }).join('');
        if (open && names.length > 10) html += '<p class="dk-note dk-bmore">The 10 largest. Use the search box to find any of the ' + names.length + ' ' + esc(dim.noun || 'items') + '.</p>'; });
    });
    E.blist.innerHTML = html; E.blist.scrollTop = q.length >= 2 ? 0 : top;
  };

  /* ── palco: ferramentas, fichas, painéis, dica, tabela ── */
  Desk.prototype._bStage = function () {
    var E = this.bel, b = this.bui, self = this, v = this._bv = this._bView(), t = D.theme(), n = v.i1 - v.i0 + 1, f = b.f || (b.f = {}), T = v.T || 'line';
    var special = T === 'scatter' || T === 'year', stk = T === 'stack' || T === 'stackarea' || T === 'pct', trOn = f.tr === 1 || (f.tr == null && T === 'scatter');
    /* a conta que vale fica marcada; a que daria unidades diferentes fica apagada, com o motivo */
    var mixTip = 'Needs series in the same unit. These are in different units, so they are shown on base 100';
    E.bcalc.innerHTML = CALCS.map(function (c0) { var offA = c0[0] === 'ltm' && v.gran === 'annual', offM = !!(v.mixed && v.mixed[c0[0]]), off = offA || offM;
      return '<button type="button" data-k="' + c0[0] + '" aria-pressed="' + (v.calc === c0[0]) + '" title="' + esc(offM ? mixTip : offA ? 'Not available in the annual view' : c0[2]) + '"' + (off ? ' disabled' : '') + '>' + c0[1] + '</button>'; }).join('');
    this._bTools(v);
    var ttl = E.body.querySelector('.dk-btitle .dk-st'); if (ttl) ttl.textContent = f.ti || 'Builder';
    var info = v.auto ? '<div class="dk-binfo"><b>Shown on base 100.</b> These series are in different units (' + esc(v.units.join(' · ')) + '), so each one starts at 100 at the beginning of the window and you compare how they moved. The cards above and the table below keep the real figures.</div>' : '';
    var xr = null, yr = null; v.rows.forEach(function (r) { if (r.key === f.xk) xr = r; if (r.key === f.yk) yr = r; }); if (!xr) xr = v.rows[0]; if (!yr) yr = v.rows[0];
    var per1 = { monthly: 'month', quarterly: 'quarter', annual: 'year' }[v.gran] || 'period';
    var uName = function (u) { return u === 'Index' ? 'Index — start of the window = 100' : u; };
    var head = function (p) {
      if (T === 'scatter') return '<div class="dk-bpu">Each dot = one ' + per1 + ' · across: ' + esc(xr.it.name) + '</div>';
      if (T === 'year') return '<div class="dk-bpu dk-byleg"></div>';
      return '<div class="dk-bpu' + (p.dual ? ' dk-bpu2' : '') + '">' + (p.dual ? '<span>Left axis · ' + esc(uName(p.unit)) + '</span><span>Right axis · ' + esc(uName(p.unitR)) + '</span>' : esc(T === 'pct' ? '% of the sum of the series' : uName(p.unit))) + '</div>'; };
    var panels = special ? v.panels.slice(0, 1) : v.panels;
    var sig = panels.map(function (p) { return p.unit + (p.dual ? '|R:' + p.unitR : ''); }).join('|') + '#' + (n > 0 ? 1 : 0) + '#' + (v.auto ? v.units.join(',') : '') + '#' + (this._bLoading() ? 'L' : '') + '#' + (special ? T : '');
    if (E.bpanels.dataset.sig !== sig) { this._dropCharts('b:'); E.bpanels.dataset.sig = sig;
      E.bpanels.innerHTML = (panels.length && n > 0) ? info + panels.map(function (p, k) { return '<div class="dk-bpanel">' + head(p) + '<div class="dk-chart" style="height:' + (special ? 340 : panels.length === 1 ? 320 : panels.length === 2 ? 200 : 160) + 'px"><canvas data-p="' + k + '"></canvas></div></div>'; }).join('')
        : '<div class="dk-bempty"><b>' + (b.s.length ? (this._bLoading() ? 'Loading the series…' : 'No complete period in this window yet.') : 'Nothing on the chart yet.') + '</b><span>' + (b.s.length ? (this._bLoading() ? 'Prices and surveys come down only when they are put on the chart.' : 'Pick a longer window or a finer granularity in the bar above.') : 'Pick a series on the left, or one of the ready-made views above.') + '</span></div>'; }
    else if (panels.length && n > 0) E.bpanels.querySelectorAll('.dk-bpanel').forEach(function (el, k) { var hd = el.querySelector('.dk-bpu'); if (hd && panels[k]) hd.outerHTML = head(panels[k]); });   // o cabeçalho acompanha (ex.: o eixo X do Scatter)
    this._bFits = null;
    if (panels.length && n > 0) {
      var labels = v.P.slice(v.i0, v.i1 + 1).map(function (p) { return p.label; }), cv0 = E.bpanels.querySelector('canvas[data-p="0"]');
      if (T === 'scatter') this._bScatter(v, cv0, xr, trOn);
      else if (T === 'year') this._bYear(v, cv0, yr);
      else panels.forEach(function (p, k) { var cv = E.bpanels.querySelector('canvas[data-p="' + k + '"]'), ds = [], bar = false, tot = null;
        if (T === 'pct') tot = labels.map(function (_, j) { var s0 = 0; p.rows.forEach(function (r) { var x = r.v[v.i0 + j]; if (x != null && x > 0) s0 += x; }); return s0; });
        p.rows.forEach(function (r, j) { var vals = r.v.slice(v.i0, v.i1 + 1), d;
          /* o tipo de cada série: o do gráfico, o que ela tem de próprio (Lines/Area/Columns/Combo) ou, no Combo, a 1ª em colunas */
          var ty = T === 'combo' ? (r.ty || (v.rows.indexOf(r) === 0 ? 'col' : 'line')) : (T === 'line' || T === 'area' || T === 'col') ? (r.ty || T) : T;
          if (T === 'pct') vals = vals.map(function (x, q) { return (x == null || !tot[q]) ? null : Math.max(0, x) / tot[q] * 100; });
          if (ty === 'col' || ty === 'stack' || ty === 'pct') { d = X.barSet(vals, r.col, { label: r.it.name, stacked: stk, gap: stk, surf: t.surf }); bar = true; d.order = 5; }
          else { d = X.lineSet(vals, r.col, { label: r.it.name, w: 2.2, end: !stk, surf: t.surf, dash: DASH[r.ds] || null }); d.order = 1;
            if (ty === 'area' || ty === 'stackarea') { d.fill = ty === 'stackarea' ? (j ? '-1' : 'origin') : 'origin'; d.backgroundColor = X.hexA(r.col, ty === 'stackarea' ? .75 : .16); } }
          d.$lab = true; d.$dec = T === 'pct' ? 1 : r.dec; d.$sfx = T === 'pct' ? '%' : ''; if (p.dual) d.yAxisID = r.ax === 'R' ? 'y2' : 'y';
          ds.push(d); });
        /* linhas de apoio de cada série: a tendência (reta de mínimos quadrados na janela) e a média da janela — não nos empilhados */
        if (!stk) p.rows.forEach(function (r) { var vals = r.v.slice(v.i0, v.i1 + 1), xs = [], ys = [], ax = p.dual ? (r.ax === 'R' ? 'y2' : 'y') : null;
          vals.forEach(function (x, q) { if (x != null) { xs.push(q); ys.push(x); } });
          if (trOn && xs.length >= 3) { var L = fitLine(xs, ys); if (L) { var td = X.lineSet(vals.map(function (_, q) { return L.a + L.b * q; }), X.hexA(r.col, .85), { label: 'Trend — ' + r.it.name, w: 1.4, dash: [6, 4], noDot: true }); td.$noTip = true; td.order = 0; if (ax) td.yAxisID = ax; ds.push(td); } }
          if (f.av && ys.length) { var m = ys.reduce(function (a0, b0) { return a0 + b0; }, 0) / ys.length, ad = X.lineSet(vals.map(function () { return m; }), X.hexA(r.col, .8), { label: 'Average — ' + r.it.name, w: 1.3, dash: [1.5, 3], noDot: true }); ad.$noTip = true; ad.order = 0; if (ax) ad.yAxisID = ax; ds.push(ad); } });
        var ch = self._chart('b:' + k, cv, bar ? 'bar' : 'line', labels, ds, { stage: true, dec: p.dec, bar: bar, stack: stk, share: T === 'pct' });
        ch.$noSync = false;
        /* painéis com o MESMO recuo à esquerda e à direita: o tempo alinha de cima a baixo (com ou sem os rótulos do eixo) */
        ch.options.scales.y.afterFit = function (s) { s.width = 58; };
        if (p.dual) {   // a 2ª escala, à direita, só para as séries marcadas "Right axis" (a grade continua a da esquerda)
          var y0 = ch.options.scales.y; ch.options.scales.y2 = Object.assign({}, y0, { position: 'right', grid: { display: false, drawOnChartArea: false },
            ticks: Object.assign({}, y0.ticks, { callback: function (val) { return fmt(val, (p.decR > 0 && Math.abs(this.max - this.min) < 10) ? 1 : 0); } }), afterFit: function (s) { s.width = 58; } }); }
        ch.options.scales.x.afterFit = function (s) { s.paddingLeft = 16; s.paddingRight = 20; };
        if (k < panels.length - 1) ch.options.scales.x.ticks.display = false;
        self._bAxes(ch, v);
        ch.options.plugins.ibbaDeskLabels = { mode: f.lb || '' }; if (f.lb === 'last') ch.options.layout.padding.right = 64;
        /* gráfico novo nasce com a animação de "crescer", calculada ANTES de a série ir para a escala da direita: sem parar a
           animação, ela terminava com a linha da direita no pé do gráfico (medido 25/11/2026). Com duas escalas, sem animação. */
        if (p.dual) ch.stop();
        ch.update('none'); });
    }
    /* fonte paga no gráfico: só a imagem (a planilha da agência não sai daqui) */
    var paid = this._bPaid(), xb = E.bdl.querySelector('[data-dl="xls"]');
    var srcs = paid ? this._bPaidSrc() : '';
    if (xb) { xb.disabled = paid; xb.title = paid ? 'Not available: a series on the chart comes from a paid source (' + srcs + ') — download the image (PNG)' : 'Download the data (Excel) — full history'; }
    E.bcopy.disabled = paid; E.bcopy.title = paid ? 'Not available: a series on the chart comes from a paid source (' + srcs + ')' : 'Copy every period of the window, ready to paste into Excel';
    var msgs = []; if (b.msg) msgs.push(b.msg);
    if (v.rows.length && v.tWant !== T) msgs.push('Shown as lines — ' + (v.tOff[v.tWant] || 'that chart type does not fit these series'));
    E.bmsg.hidden = !msgs.length; E.bmsg.textContent = msgs.join(' · ');
    var hint;
    if (T === 'scatter') hint = (this._bFits || []).map(function (x) { var L = x.L; return x.r.it.name + ': ' + (L ? 'y = ' + fmt(L.a, Math.max(1, x.r.dec)) + ' ' + sgn(L.b, 3).replace('+', '+ ').replace('−', '− ') + '·x · R² ' + (L.r2 == null ? '—' : fmt(L.r2, 2)) : 'not enough points') + ' (' + x.n + ' ' + per1 + 's)'; }).join('   ·   ') || 'Hover a dot to read its period.';
    else if (T === 'year') hint = 'One line per year of ' + yr.it.name + ' · every year is shown (the window buttons do not apply here) · hover to read every year.';
    else { hint = v.panels.length > 1 ? 'Series with the same unit share a panel; each other unit gets its own panel, on the same time axis.' : 'Hover to read every series at the same period.';
      if (v.gran !== 'monthly') hint += ' Complete ' + (v.gran === 'quarterly' ? 'quarters' : 'years') + ' only.';
      if (v.calc === 'ltm') hint += ' LTM = last 12 months: sum for volumes, average or ratio for prices and shares.'; }
    E.bhint.textContent = hint;
    /* explicação: o que é o gráfico e como ler a conta e o DESENHO escolhidos (na base 100 automática o aviso de cima já explica) */
    var HB = window.IBBADeskHelp && IBBADeskHelp.builder;
    if (E.bwhy) { var how = [];
      if (HB && v.rows.length) {
        if (!v.auto && HB.calc[v.calc] && T !== 'pct') how.push(HB.calc[v.calc]);
        var ht = HB.type && HB.type[T]; if (ht) how.push(ht.replace('{x}', xr ? xr.it.name : '').replace('{s}', yr ? yr.it.name : '').replace('{pers}', v.gran === 'quarterly' ? 'quarters' : 'months').replace('{y}', String((this._bYearInfo || {}).yL || '')).replace('{y1}', String(((this._bYearInfo || {}).yL || 1) - 1)));
        if (v.dual && HB.dual && !special) how.push(HB.dual);
        if (trOn && !stk && T !== 'year' && T !== 'scatter' && HB.trend) how.push(HB.trend);
        if (f.av && !stk && !special && HB.avg) how.push(HB.avg);
        if (f.lg && HB.log) how.push(HB.log);
        if ((f.iL || f.iR) && HB.inv) how.push(HB.inv);
        if (v.rows.some(function (r) { return r.lag; }) && HB.shift) how.push(HB.shift);
        if (v.rows.length > 1 && HB.r2) how.push(HB.r2); }
      E.bwhy.innerHTML = (HB && v.rows.length) ? X.whyHTML(HB.what, how.join(' ')) : ''; E.bwhy.hidden = !E.bwhy.innerHTML; }
    if (E.bcorr) { E.bcorr.innerHTML = (v.cells && X.corrTable) ? X.corrTable(v.rows.map(function (r) { return { name: r.it.name, short: r.it.short, color: r.col }; }), v.cells, v.per) : ''; E.bcorr.hidden = !E.bcorr.innerHTML; }
    this._bPaint(); this._bPop();
  };
  /* eixos: a partir do zero, log (só com todos os valores acima de zero), invertido, faixa manual */
  Desk.prototype._bLogOk = function (v) { var T = v.T, stk = T === 'stack' || T === 'stackarea' || T === 'pct';
    var pos = function (side) { return v.rows.every(function (r) { if (v.dual && (r.ax === 'R') !== (side === 'R')) return true; for (var i = v.i0; i <= v.i1; i++) if (r.v[i] != null && !(r.v[i] > 0)) return false; return true; }); };
    return { L: !stk && pos('L'), R: !stk && pos('R') }; };
  Desk.prototype._bAxes = function (ch, v) { var f = this.bui.f || {}, sc = ch.options.scales, ok = this._bLogOk(v);
    var set = function (s0, mn, mx, inv, lg) { if (!s0) return; if (lg) { s0.type = 'logarithmic'; s0.ticks = Object.assign({}, s0.ticks, { maxTicksLimit: 8 }); } else if (f.z) s0.beginAtZero = true;
      s0.reverse = !!inv; if (mn != null) s0.min = mn; if (mx != null) s0.max = mx; };
    set(sc.y, f.mn, f.mx, f.iL, f.lg && ok.L); if (sc.y2) set(sc.y2, f.mn2, f.mx2, f.iR, f.lg && ok.R); };
  /* SCATTER: uma série no eixo X (a 1ª, ou a escolhida), as outras no Y; cada ponto é um período da janela (o mais novo com aro e mais
     escuro); a reta de regressão de cada par, com o R² e a inclinação embaixo do gráfico */
  Desk.prototype._bScatter = function (v, cv, xr, trOn) {
    var f = this.bui.f || {}, t = D.theme(), ys = v.rows.filter(function (r) { return r !== xr; }), ds = [], fits = [];
    var dual = ys.some(function (r) { return r.ax === 'R'; }) && ys.some(function (r) { return r.ax !== 'R'; });
    ys.forEach(function (r) { var pts = [], i;
      for (i = v.i0; i <= v.i1; i++) { var x = xr.v[i], y = r.v[i]; if (x != null && y != null) pts.push({ x: x, y: y, i: i }); }
      var last = pts.length - 1, d = { type: 'scatter', label: r.it.name, data: pts, order: 2, $lab: true, $dec: r.dec, $ring: r.col,
        pointRadius: pts.map(function (_, q) { return q === last ? 5.5 : 3.4; }), pointHoverRadius: 6,
        pointBackgroundColor: pts.map(function (_, q) { return X.hexA(r.col, .22 + .72 * (last > 0 ? q / last : 1)); }),
        pointBorderColor: pts.map(function (_, q) { return q === last ? t.ink : 'rgba(0,0,0,0)'; }), pointBorderWidth: pts.map(function (_, q) { return q === last ? 2 : 0; }) };
      if (dual) d.yAxisID = r.ax === 'R' ? 'y2' : 'y'; ds.push(d);
      var L = fitLine(pts.map(function (q0) { return q0.x; }), pts.map(function (q0) { return q0.y; })); fits.push({ r: r, L: L, n: pts.length });
      if (trOn && L && pts.length >= 3) { var xs0 = pts.map(function (q0) { return q0.x; }), a0 = Math.min.apply(null, xs0), b0 = Math.max.apply(null, xs0);
        var td = { type: 'line', label: 'Regression — ' + r.it.name, data: [{ x: a0, y: L.a + L.b * a0 }, { x: b0, y: L.a + L.b * b0 }], borderColor: X.hexA(r.col, .9), borderWidth: 1.6, borderDash: [6, 4], pointRadius: 0, fill: false, $noTip: true, order: 1 };
        if (dual) td.yAxisID = r.ax === 'R' ? 'y2' : 'y'; ds.push(td); } });
    var ch = this._chart('b:0', cv, 'scatter', [], ds, { stage: true, dec: ys.length ? ys[0].dec : 0, tip: true });
    ch.$noSync = true; ch.options.plugins.ibbaDeskSync = { on: false }; ch.options.interaction = { mode: 'nearest', intersect: false, axis: 'xy' };
    var y0 = ch.options.scales.y, tit = function (txt) { return { display: true, text: txt, color: t.mut, font: { size: 10, weight: '600', family: X.FONT } }; };
    var nm = function (r) { return r.it.name + (r.unit && r.unit !== 'Index' ? ' (' + r.unit + ')' : r.unit === 'Index' ? ' (index)' : ''); };
    ch.options.scales.x = Object.assign({}, y0, { type: 'linear', position: 'bottom', title: tit(nm(xr)), ticks: Object.assign({}, y0.ticks, { callback: function (val) { return fmt(val, (xr.dec > 0 && Math.abs(this.max - this.min) < 10) ? 1 : 0); } }) });
    var yl = ys.filter(function (r) { return !dual || r.ax !== 'R'; }), yr0 = ys.filter(function (r) { return dual && r.ax === 'R'; });
    y0.title = tit(yl.length === 1 ? nm(yl[0]) : (yl[0] ? (yl[0].unit === 'Index' ? 'index' : yl[0].unit) : ''));
    if (dual) ch.options.scales.y2 = Object.assign({}, y0, { position: 'right', grid: { display: false, drawOnChartArea: false }, title: tit(yr0.length === 1 ? nm(yr0[0]) : (yr0[0] ? yr0[0].unit : '')) });
    var tp = ch.options.plugins.tooltip; ch.options.plugins.tooltip = Object.assign({}, tp, { callbacks: Object.assign({}, tp.callbacks, {
      title: function (items) { var r0 = items[0] && items[0].raw; return r0 && v.P[r0.i] ? v.P[r0.i].label : ''; },
      label: function (c) { var r0 = c.raw || {}, rr0 = null; ys.forEach(function (q) { if (q.it.name === c.dataset.label) rr0 = q; });
        return ' ' + c.dataset.label + ': ' + fmt(r0.y, rr0 ? rr0.dec : 0) + '  ·  ' + xr.it.short + ': ' + fmt(r0.x, xr.dec); } }) });
    this._bAxes(ch, v); ch.options.plugins.ibbaDeskLabels = { mode: f.lb || '' }; if (f.lb === 'last') ch.options.layout.padding.right = 64;
    ch.update('none'); this._bFits = fits;
  };
  /* BY YEAR: uma linha por ano de UMA série (a 1ª, ou a escolhida) sobre os meses (trimestres) do ano — as cores e traços da sazonalidade
     da mesa; todos os anos (até 6), a janela não se aplica */
  Desk.prototype._bYear = function (v, cv, r) {
    var f = this.bui.f || {}, t = D.theme(), PER = v.gran === 'quarterly' ? 4 : 12, byY = {}, yL = null, ds = [], E = this.bel, y;
    v.P.forEach(function (p, i) { var x = r.v[i]; if (x == null) return; (byY[p.y] = byY[p.y] || new Array(PER).fill(null))[p.k] = x; if (yL == null || p.y > yL) yL = p.y; });
    var labs = PER === 12 ? core.MON.slice() : ['Q1', 'Q2', 'Q3', 'Q4'], yrs = [];
    for (y = yL - 5; y <= yL; y++) if (byY[y]) yrs.push(y);
    yrs.forEach(function (yy) { var k = yL - yy, st = X.yearStyle(k), d = X.lineSet(byY[yy], st.color, { label: String(yy), w: st.w, dash: st.dash, end: k === 0, surf: t.surf });
      d.order = k; d.$lab = true; d.$dec = r.dec; ds.push(d); });
    var ch = this._chart('b:0', cv, 'line', labs, ds, { stage: true, dec: r.dec, tip: true, local: true, unitTip: r.unit === 'Index' ? '' : r.unit });
    ch.$noSync = true; this._bAxes(ch, v); ch.options.plugins.ibbaDeskLabels = { mode: f.lb || '' }; if (f.lb === 'last') ch.options.layout.padding.right = 64; ch.update('none');
    this._bYearInfo = { r: r, yL: yL, PER: PER };
    var lg = E.bpanels.querySelector('.dk-byleg'); if (lg) lg.innerHTML = '<span class="dk-hfleg">' + yrs.slice().reverse().map(function (yy) { return X.yearChip(yL - yy, yy, null); }).join('') + '</span><span class="dk-bylu">' + esc(r.it.name) + ' · ' + esc(r.unit === 'Index' ? 'index' : r.unit) + '</span>';
  };
  /* as ferramentas: tipo de gráfico (galeria) + a barra Format + a linha extra (faixa dos eixos / título) */
  Desk.prototype._bAutoTitle = function (v) { return v.rows.map(function (r) { return r.it.name; }).join(' vs ') || 'Builder'; };
  Desk.prototype._bTools = function (v) {
    var E = this.bel, b = this.bui, f = b.f || (b.f = {}), T = v.T || 'line'; if (!E.btools) return;
    E.btype.innerHTML = X.styleSeg ? X.styleSeg(TYPES.map(function (x) { return [x[0], x[1], x[2], (v.tOff && v.tOff[x[0]]) || 0, x[3]]; }), T, 'Chart') : '';
    var stk = T === 'stack' || T === 'stackarea' || T === 'pct', ok = this._bLogOk(v), dual = v.dual && T !== 'year', trOn = f.tr === 1 || (f.tr == null && T === 'scatter');
    var tg = function (k, label, on, tip, off) { return '<button type="button" class="dk-pill dk-btg" data-f="' + k + '" aria-pressed="' + !!on + '"' + (off ? ' disabled' : '') + ' title="' + esc(off || tip) + '">' + esc(label) + '</button>'; };
    var h0 = '<span class="dk-plbl">Format</span>' +
      tg('z', 'Y from 0', f.z, 'Start the vertical axis at zero', f.lg ? 'Not with the log scale' : null) +
      tg('lg', 'Log scale', f.lg, 'Logarithmic scale: equal distances mean equal % changes', stk ? 'Not with stacked charts' : (ok.L ? null : 'Needs values above zero')) +
      tg('iL', dual ? 'Invert left' : 'Invert axis', f.iL, 'The axis grows downwards — handy to show series that move in opposite directions') +
      (dual ? tg('iR', 'Invert right', f.iR, 'The right-hand axis grows downwards') : '') +
      tg('tr', T === 'scatter' ? 'Regression line' : 'Trend line', trOn, T === 'scatter' ? 'The straight line that best fits the dots of each pair, with its R² and slope below the chart' : 'The straight-line trend of each series over the window', (stk || T === 'year') ? 'Not with this chart type' : null) +
      tg('av', 'Average', f.av, 'A flat line at the average of each series over the window', (stk || T === 'scatter' || T === 'year') ? 'Not with this chart type' : null) +
      '<span class="dk-bfsep" aria-hidden="true"></span><span class="dk-plbl">Labels</span><div class="dk-seg dk-blab" role="group" aria-label="Value labels">' +
        [['', 'Off'], ['last', 'Last value'], ['all', 'All values']].map(function (o) { return '<button type="button" data-lb="' + o[0] + '" aria-pressed="' + ((f.lb || '') === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div>' +
      '<span class="dk-bfsep" aria-hidden="true"></span>' +
      '<button type="button" class="dk-pill dk-btg" data-x="rng" aria-expanded="' + (b.xo === 'rng') + '" aria-pressed="' + (f.mn != null || f.mx != null || f.mn2 != null || f.mx2 != null) + '" title="Set the lowest and highest value of each axis">Axis range…</button>' +
      '<button type="button" class="dk-pill dk-btg" data-x="ttl" aria-expanded="' + (b.xo === 'ttl') + '" aria-pressed="' + !!f.ti + '" title="Write your own title — it also goes on the image (PNG)">Title…</button>';
    var sel = function (k, lab, cur) { return '<label class="dk-bsel"><span class="dk-plbl">' + lab + '</span><select data-sel="' + k + '">' + v.rows.map(function (r) { return '<option value="' + esc(r.key) + '"' + (r.key === cur ? ' selected' : '') + '>' + esc(r.it.name) + '</option>'; }).join('') + '</select></label>'; };
    if (T === 'scatter' && v.rows.length > 1) { var cx = v.rows.some(function (r) { return r.key === f.xk; }) ? f.xk : v.rows[0].key;
      h0 += '<span class="dk-bfsep" aria-hidden="true"></span>' + sel('xk', 'X axis', cx) + '<button type="button" class="dk-pill dk-btg" data-f="swap" title="Swap the axes: the next series goes across (horizontal axis)">Swap X ↔ Y</button>'; }
    if (T === 'year' && v.rows.length > 1) h0 += '<span class="dk-bfsep" aria-hidden="true"></span>' + sel('yk', 'Series', v.rows.some(function (r) { return r.key === f.yk; }) ? f.yk : v.rows[0].key);
    E.bfmt.innerHTML = h0;
    var num = function (x) { return x == null ? '' : String(x); }, xh = '';
    if (b.xo === 'rng') xh = '<span class="dk-plbl">' + (dual ? 'Left axis' : 'Axis') + '</span><label>Min <input type="number" step="any" data-in="mn" value="' + num(f.mn) + '" placeholder="auto"></label><label>Max <input type="number" step="any" data-in="mx" value="' + num(f.mx) + '" placeholder="auto"></label>' +
      (dual ? '<span class="dk-plbl">Right axis</span><label>Min <input type="number" step="any" data-in="mn2" value="' + num(f.mn2) + '" placeholder="auto"></label><label>Max <input type="number" step="any" data-in="mx2" value="' + num(f.mx2) + '" placeholder="auto"></label>' : '') +
      '<button type="button" class="dk-lnk" data-x="auto">Back to automatic</button>';
    else if (b.xo === 'ttl') xh = '<label class="dk-bttl"><span class="dk-plbl">Title</span><input type="text" maxlength="90" data-in="ti" value="' + esc(f.ti || '') + '" placeholder="' + esc(this._bAutoTitle(v)) + '"></label><button type="button" class="dk-lnk" data-x="clrttl">Clear</button>';
    E.bxtra.innerHTML = xh; E.bxtra.hidden = !xh;
  };
  /* o painel de formato da série aberta (b.pop = a chave), logo abaixo da ficha dela */
  Desk.prototype._bPop = function () {
    var E = this.bel, b = this.bui, v = this._bv, pop = E && E.bpop; if (!pop) return;
    var r = null, s0 = null; (v ? v.rows : []).forEach(function (x) { if (x.key === b.pop) r = x; }); b.s.forEach(function (x) { if (x.key === b.pop) s0 = x; });
    E.bchips.querySelectorAll('[data-fmt]').forEach(function (x) { x.setAttribute('aria-expanded', String(!!r && x.getAttribute('data-fmt') === b.pop)); });
    if (!r || !s0) { pop.hidden = true; pop.innerHTML = ''; b.pop = null; return; }
    var T = v.T || 'line', PX = paletteX(), canType = T === 'line' || T === 'area' || T === 'col' || T === 'combo', per = { monthly: 'month', quarterly: 'quarter', annual: 'year' }[v.gran] || 'period', lag = s0.lag || 0;
    var seg = function (k, list, cur) { return '<div class="dk-seg" role="group">' + list.map(function (o) { return '<button type="button" data-pf="' + k + ':' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + o[1] + '</button>'; }).join('') + '</div>'; };
    var autoT = T === 'combo' ? (v.rows.indexOf(r) === 0 ? 'Columns' : 'Line') : ({ line: 'Line', area: 'Area', col: 'Columns' })[T] || 'Line';
    pop.innerHTML = '<div class="dk-bph"><i style="background:' + r.col + '"></i><b>' + esc(r.it.name) + '</b><button type="button" class="dk-bx" data-pf="close" aria-label="Close">×</button></div>' +
      (canType ? '<div class="dk-bpr"><span class="dk-plbl">Type</span>' + seg('t', [['', 'Auto (' + autoT + ')'], ['line', 'Line'], ['col', 'Columns'], ['area', 'Area']], s0.ty || '') + '</div>' : '') +
      '<div class="dk-bpr"><span class="dk-plbl">Colour</span><div class="dk-bcols">' + PX.map(function (c, i) { return '<button type="button" class="dk-bcol" data-pf="c:' + i + '" aria-pressed="' + (r.col === c) + '" style="background:' + c + '" title="Colour ' + (i + 1) + '" aria-label="Colour ' + (i + 1) + '"></button>'; }).join('') + '</div></div>' +
      '<div class="dk-bpr"><span class="dk-plbl">Line</span>' + seg('d', [['', 'Solid'], ['dash', 'Dashed'], ['dot', 'Dotted']], s0.ds || '') + '</div>' +
      '<div class="dk-bpr"><span class="dk-plbl">Shift</span><div class="dk-bshift"><button type="button" class="dk-pill" data-pf="l:-1" title="Move it one ' + per + ' back">−</button><b>' + (lag ? sgn(lag, 0) + ' ' + per + (Math.abs(lag) > 1 ? 's' : '') : 'No shift') + '</b><button type="button" class="dk-pill" data-pf="l:1" title="Move it one ' + per + ' forward">+</button>' + (lag ? '<button type="button" class="dk-lnk" data-pf="l:0">Undo</button>' : '') + '</div></div>' +
      '<p class="dk-bpn">Shift moves the series in time: +3 shows each value 3 ' + per + 's later — to test whether it leads the others. The table, the Excel and the correlation table use the shifted series.</p>' +
      (v.rows.length > 1 && T !== 'year' ? '<div class="dk-bpr"><span class="dk-plbl">Axis</span>' + seg('ax', [['L', 'Left'], ['R', 'Right']], s0.ax === 'R' ? 'R' : 'L') + '</div>' : '') +
      '<div class="dk-bpf"><button type="button" class="dk-pill dk-bok" data-pf="close">Done</button></div>';
    var chip = null; E.bchips.querySelectorAll('[data-fmt]').forEach(function (x) { if (x.getAttribute('data-fmt') === b.pop) chip = x; });
    pop.hidden = false;
    if (chip) { var host = pop.offsetParent || pop.parentNode, hr = host.getBoundingClientRect(), cr = chip.getBoundingClientRect(), w = pop.offsetWidth || 300;
      pop.style.top = Math.round(cr.bottom - hr.top + 6) + 'px'; pop.style.left = Math.round(Math.max(8, Math.min(hr.width - w - 8, cr.left - hr.left))) + 'px'; }
  };
    Desk.prototype._bHover = function (i) { var b = this.bui, self = this; if (b.hover === i) return; b.hover = i; if (this._braf) return; this._braf = requestAnimationFrame(function () { self._braf = 0; self._bPaint(); }); };
  /* o que muda com o mouse: marca nos painéis, valores das fichas, linha da tabela */
  Desk.prototype._bPaint = function () {
    var E = this.bel, b = this.bui, v = this._bv, k, me = this; if (!v) return;
    for (k in this.charts) if (k.indexOf('b:') === 0 && !this.charts[k].$noSync) { this.charts[k].$dk = { hover: b.hover, pinA: null, pinB: null }; this.charts[k].draw(); }
    var ref = b.hover != null ? v.i0 + b.hover : -1;
    if (ref < 0) { for (var i = v.i1; i >= v.i0 && ref < 0; i--) if (v.rows.some(function (r) { return r.v[i] != null; })) ref = i; }
    E.bwhen.textContent = ref >= 0 && v.P[ref] ? v.P[ref].label + (b.hover != null ? '' : ' · latest') : '';
    E.bchips.innerHTML = v.rows.map(function (r) { var j = ref, own = ''; if (b.hover == null && ref >= 0 && r.v[ref] == null) { for (j = ref; j >= v.i0 && r.v[j] == null; j--); if (j >= v.i0) own = ' (' + v.P[j].label + ')'; }
      var val = (j >= v.i0 && j >= 0) ? r.v[j] : null;
      /* na base 100 a ficha mostra o índice E o número de verdade (senão a unidade real sumiria da tela) */
      var real = (v.calc === 'index' && j >= v.i0 && j >= 0 && r.lev && r.lev[j] != null) ? fmt(r.lev[j], r.d.dec) + ' ' + r.d.unit : '';
      /* R² contra a 1ª série (só da 2ª em diante): o número e, na dica, contra o quê, em quantos períodos e o que significa */
      var f0 = r.fit, ref0 = v.rows[0] ? v.rows[0].it.name : '';
      var r2b = !f0 ? '' : X.r2Badge(f0, ref0, f0.per, ' Two series that both trend can show a high R² in Level without a real link — YoY is the stricter test.');
      /* eixo da direita: botão em cada ficha (com 2+ séries) — diz que é botão e o que faz */
      var axb = v.rows.length > 1 ? '<button type="button" class="dk-bax" data-ax="' + esc(r.key) + '" aria-pressed="' + (r.ax === 'R') + '" title="' + esc(r.ax === 'R' ? 'On the right-hand scale — click to bring it back to the left' : 'Give this series its own scale on the right — for series that move much less (or much more) than the others') + '">Right axis</button>' : '';
      return '<span class="dk-bchip"><button type="button" class="dk-bsw" data-fmt="' + esc(r.key) + '" aria-expanded="' + (b.pop === r.key) + '" title="Format this series — type, colour, line, shift in time, axis"><i style="background:' + r.col + '"></i><svg viewBox="0 0 8 5" aria-hidden="true"><path d="M1 1l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="dk-bcn" data-go="' + esc(r.key) + '" title="' + esc(me._bWhat(r) + r.it.where + ' — click to open it in its section') + '">' + esc(r.it.name) + '</button>' +
        '<b>' + numTxt(val, r.dec, v.calc === 'yoy') + ' <small>' + esc(r.unit === 'Index' ? (real ? '· ' + real : '') : r.unit) + esc(own) + (r.note ? ' · ' + esc(r.note) : '') + (r.lag ? ' · shifted ' + sgn(r.lag, 0) : '') + '</small></b>' +
        axb + '<button type="button" class="dk-bx" data-x="' + esc(r.key) + '" aria-label="Remove ' + esc(r.it.name) + '" title="Remove from the chart">×</button></span>'; }).join('');   // o R² mora na tabela ao lado da explicação
    this._bTable(false, ref);
  };
  /* o que uma série do Builder mede (para a dica do nome): a explicação do indicador ou da quebra (data-desk-help.js) */
  Desk.prototype._bWhat = function (r) {
    var p = parseKey(r.key), H = window.IBBADeskHelp, hp = null; if (!p || !H) return '';
    if (p.type === 'm') hp = this._help(p.sec, p.metric, { prod: p.prod, label: r.it.name });
    else { var w0 = H.who(this.cfg.sector, p.sec, p.dim); if (w0) hp = { what: p.name + ' — ' + w0 }; }
    return (hp && hp.what) ? hp.what + '\n\n' : '';
  };
  /* tabela Values: os 12 períodos mais recentes da janela (mais novo em cima). asText = a janela INTEIRA, para colar no Excel */
  Desk.prototype._bTable = function (asText, ref) {
    var E = this.bel, v = this._bv, lines = [], i, loc = (navigator.language || 'en-US');
    /* na base 100 a tabela leva também o número de verdade de cada série (o índice sozinho esconderia a unidade real) */
    var idx = v.calc === 'index', num = function (x, d) { return x == null ? '' : x.toLocaleString(loc, { useGrouping: false, maximumFractionDigits: d + 2 }); };
    if (asText) { lines.push(['Period'].concat(v.rows.map(function (r) { return colName(r, v.calc); }), idx ? v.rows.map(realName) : []).join('\t'));
      for (i = v.i1; i >= v.i0; i--) lines.push([v.P[i].label].concat(v.rows.map(function (r) { return num(r.v[i], r.dec); }), idx ? v.rows.map(function (r) { return num(r.lev[i], r.d.dec); }) : []).join('\t'));
      return lines.join('\n'); }
    var from = Math.max(v.i0, v.i1 - 11);
    E.bvw.textContent = v.rows.length && v.i1 >= v.i0 ? (v.i1 - from + 1) + ' most recent periods · ' + CALCS.filter(function (c0) { return c0[0] === v.calc; })[0][1] : '';
    if (!v.rows.length || v.i1 < v.i0) { E.bt.innerHTML = ''; E.bt.closest('.dk-bvals').hidden = true; return; } E.bt.closest('.dk-bvals').hidden = false;
    var html = '<thead><tr><th>Period</th>' + v.rows.map(function (r) { return '<th><i class="dk-bdot" style="background:' + r.col + '"></i>' + esc(r.it.name) + ' <span class="dk-src">' + esc((idx ? 'Index · ' + r.d.unit : r.unit) + (v.dual && r.ax === 'R' ? ' · right axis' : '') + (r.lag ? ' · shifted ' + sgn(r.lag, 0) : '')) + '</span></th>'; }).join('') + '</tr></thead><tbody>';
    for (i = v.i1; i >= from; i--) html += '<tr' + (i === ref && this.bui.hover != null ? ' class="dk-bhi"' : '') + '><td>' + v.P[i].label + '</td>' + v.rows.map(function (r) { var x = r.v[i]; return '<td' + (v.calc === 'yoy' && x != null ? ' class="' + X.cls(x) + '"' : '') + '>' + numTxt(x, r.dec, v.calc === 'yoy') + ((idx && r.lev[i] != null) ? ' <span class="dk-src">' + fmt(r.lev[i], r.d.dec) + ' ' + esc(r.d.unit) + '</span>' : '') + '</td>'; }).join('') + '</tr>';
    E.bt.innerHTML = html + '</tbody>';
  };
  function colName(r, calc) { return r.it.name + (calc === 'yoy' ? ' — YoY' : calc === 'ltm' ? ' — LTM' : calc === 'index' ? ' — Index' : '') + (r.unit === 'Index' ? '' : ' (' + r.unit + ')') + (r.lag ? ' [shifted ' + sgn(r.lag, 0) + ']' : ''); }   // cabeçalho de coluna no Excel
  function realName(r) { return r.it.name + ' (' + r.d.unit + ')'; }   // coluna do número de verdade, ao lado do índice
  Desk.prototype._bAOA = function () { var v = this._bv, idx = v.calc === 'index', out = [['Period'].concat(v.rows.map(function (r) { return colName(r, v.calc); }), idx ? v.rows.map(realName) : [])], i, first = -1;
    for (i = 0; i < v.P.length && first < 0; i++) if (v.rows.some(function (r) { return r.v[i] != null; })) first = i;
    for (i = Math.max(0, first); i < v.P.length; i++) out.push([v.P[i].label].concat(v.rows.map(function (r) { return r.v[i]; }), idx ? v.rows.map(function (r) { return r.lev[i]; }) : [])); return out; };
  Desk.prototype._bName = function () { var v = this._bv, c0 = CALCS.filter(function (c) { return c[0] === v.calc; })[0][1]; return 'Builder — ' + v.rows.map(function (r) { return r.it.name; }).join(' vs ') + (v.calc === 'level' ? '' : ' (' + c0 + ')'); };
  Desk.prototype._bXLS = function () { var v = this._bv; if (!v || !v.rows.length || !window.IBBAExport || this._bPaid()) return; var nm = IBBAExport.safeName((this.cfg.sector || 'desk') + '_builder_' + IBBAExport.stamp());
    IBBAExport.xlsxFromAOA([{ name: 'Builder', aoa: this._bAOA() }], nm).catch(function () { alert('Could not build the Excel file.'); }); };
  /* PNG: título + legenda + os painéis empilhados, na cor do tema */
  Desk.prototype._bPNG = function () {
    var v = this._bv, E = this.bel, cvs = [].slice.call(E.bpanels.querySelectorAll('canvas')); if (!v || !v.rows.length || !cvs.length) return;
    var t = D.theme(), s = cvs[0].width / cvs[0].clientWidth, W = cvs[0].width, pad = 18 * s, lh = 18 * s, head = pad + 22 * s + v.rows.length * lh + 8 * s, H = head, k;
    cvs.forEach(function (c) { H += 20 * s + c.height; }); H += pad;
    var out = document.createElement('canvas'); out.width = W + 2 * pad; out.height = H; var g = out.getContext('2d');
    g.fillStyle = t.surf; g.fillRect(0, 0, out.width, out.height); g.textBaseline = 'top';
    var f = this.bui.f || {}, T = v.T || 'line', tN = (TYPES.filter(function (x) { return x[0] === T; })[0] || [])[1];
    g.fillStyle = t.ink; g.font = '700 ' + (14 * s) + 'px ' + X.FONT; g.fillText((f.ti || 'Builder') + (v.calc === 'level' ? '' : ' · ' + CALCS.filter(function (c) { return c[0] === v.calc; })[0][1]) + (T !== 'line' && tN ? ' · ' + tN : '') + ' · ' + (T === 'year' ? 'every year' : v.P[v.i0].label + ' – ' + v.P[v.i1].label), pad, pad);
    v.rows.forEach(function (r, i) { var y = pad + 24 * s + i * lh; g.fillStyle = r.col; g.fillRect(pad, y + 3 * s, 10 * s, 10 * s); g.fillStyle = t.ink; g.font = '500 ' + (11.5 * s) + 'px ' + X.FONT;
      var fx = (r.fit && r.fit.r2 != null) ? '  ·  R² ' + fmt(r.fit.r2, 2) + (r.fit.r < 0 ? ' inverse' : '') + ' vs ' + v.rows[0].it.name : '';
      g.fillText(r.it.name + '  (' + r.unit + ')' + (v.dual && r.ax === 'R' && T !== 'year' ? ' — right axis' : '') + (r.lag ? ' — shifted ' + sgn(r.lag, 0) : '') + fx, pad + 16 * s, y); });
    var y0 = head, sp = T === 'scatter' || T === 'year', bx = this.bel.bpanels.querySelector('.dk-bpu'); cvs.forEach(function (c, i) { var pn = v.panels[i]; g.fillStyle = t.mut; g.font = '700 ' + (10 * s) + 'px ' + X.FONT;
      g.fillText(String(sp ? (bx ? bx.textContent : '') : T === 'pct' ? '% of the sum of the series' : pn.dual ? 'Left axis · ' + pn.unit : pn.unit).toUpperCase().slice(0, 140), pad, y0 + 3 * s);
      if (pn.dual && !sp) { g.textAlign = 'right'; g.fillText(String('Right axis · ' + pn.unitR).toUpperCase(), pad + W, y0 + 3 * s); g.textAlign = 'left'; } y0 += 20 * s; g.drawImage(c, pad, y0); y0 += c.height; });
    out.toBlob(function (bl) { if (!bl) return; var a = document.createElement('a'); a.href = URL.createObjectURL(bl); a.download = ((window.IBBAExport && IBBAExport.safeName) ? IBBAExport.safeName((this.cfg.sector || 'desk') + '_builder_' + IBBAExport.stamp()) : 'builder') + '.png';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000); }.bind(this), 'image/png');
  };

  Desk.prototype._builder = function () {
    if (this._bBusy) return;
    this._bState();
    if (this._built !== 'builder' || !this.bel || !this.root.contains(this.bel.body)) { this._destroyAll(); this._bBuild(); this._built = 'builder'; }
    this.bel.bpanels.dataset.sig = '';   // tema/filtros podem ter mudado: os painéis são refeitos
    this._bNeed();
    this._bViews(); this._bCat(); this._bStage();
  };

  /* só para os testes: a visão calculada (períodos da janela e os valores de cada série) */
  Desk.prototype.builderDebug = function () { var v = this._bView(), self = this; return { calc: v.calc, want: v.want, auto: v.auto, gran: v.gran, T: v.T, tOff: v.tOff, f: JSON.parse(JSON.stringify(this.bui.f || {})),
    fits: (this._bFits || []).map(function (x) { return { key: x.r.key, n: x.n, a: x.L ? x.L.a : null, b: x.L ? x.L.b : null, r2: x.L ? x.L.r2 : null }; }),
    charts: Object.keys(this.charts).filter(function (k) { return k.indexOf('b:') === 0; }).map(function (k) { var c = self.charts[k]; return { id: k, type: c.config.type, sets: c.data.datasets.map(function (d) { return { label: d.label, type: d.type || c.config.type, n: (d.data || []).length, fill: d.fill || false, axis: d.yAxisID || 'y' }; }), y: c.options.scales.y ? { type: c.options.scales.y.type || 'linear', reverse: !!c.options.scales.y.reverse, min: c.options.scales.y.min, max: c.options.scales.y.max, zero: !!c.options.scales.y.beginAtZero, stacked: !!c.options.scales.y.stacked } : null }; }), keys: v.P.slice(v.i0, v.i1 + 1).map(function (p) { return p.key; }), labels: v.P.slice(v.i0, v.i1 + 1).map(function (p) { return p.label; }),
    panels: v.panels.map(function (p) { return p.unit; }), series: v.rows.map(function (r) { return { key: r.key, name: r.it.name, unit: r.unit, vals: r.v.slice(v.i0, v.i1 + 1), r2: r.fit ? r.fit.r2 : null, r: r.fit ? r.fit.r : null, n: r.fit ? r.fit.n : null, lag: r.lag, col: r.col, ty: r.ty, ds: r.ds, ax: r.ax }; }) }; };
  D.builder = { encodeView: encodeView, decodeView: decodeView, parseKey: parseKey, MAX: MAX, MAXU: MAXU, r2of: r2of };
})();
