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
  function encodeView(v) { var a = [encKeys(v.s), v.v || 'level', GR[v.g] || '', v.w || '', v.from || '', v.to || '']; if (v.r && v.r.length) a.push(encKeys(v.r)); return a.join('!'); }
  function decodeView(str) { var a = String(str || '').split('!'); if (!a[0]) return null;
    var o = { s: decKeys(a[0]), v: a[1] || 'level', g: GRB[a[2]] || null, w: a[3] || null, from: a[4] || null, to: a[5] || null }; if (a[6]) o.r = decKeys(a[6]); return o; }
  function uniq(a) { var o = []; a.forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
  /* R² entre duas séries nos períodos i0..i1 em que AS DUAS têm valor: {n, r, r2}; r2 = null com menos de 6 pares ou série parada */
  var R2_MIN = 6;
  function r2of(a, b, i0, i1) {
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
  Desk.prototype._bStore = function () { var b = this.bui; try { localStorage.setItem(this._bKey('last'), JSON.stringify({ s: b.s.map(function (x) { return x.key; }), v: b.calc, r: b.s.filter(function (x) { return x.ax === 'R'; }).map(function (x) { return x.key; }) })); } catch (e) {} };

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
  Desk.prototype._bCurrent = function () { var st = this.cfg.state(), b = this.bui, r = b.s.filter(function (x) { return x.ax === 'R'; }).map(function (x) { return x.key; }), o = { s: b.s.map(function (x) { return x.key; }), v: b.calc, g: st.gran, w: st.win, from: st.win === 'custom' ? st.from : null, to: st.win === 'custom' ? st.to : null }; if (r.length) o.r = r; return o; };
  function sameView(a, b) { return a.v === (b.v || 'level') && a.s.length === (b.s || []).length && a.s.every(function (k) { return b.s.indexOf(k) >= 0; }) && sameSet(a.r, b.r); }

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
    var rows = []; b.s.forEach(function (s0) { var it = self._bItem(s0.key), d = it && self._bSeries(s0.key, gran); if (it && d) rows.push({ key: s0.key, col: pal[s0.col % pal.length], it: it, d: d, ax: s0.ax === 'R' ? 'R' : 'L' }); });
    /* dois eixos só quando há série dos DOIS lados; tudo de um lado = um eixo */
    var dual = rows.some(function (r) { return r.ax === 'R'; }) && rows.some(function (r) { return r.ax === 'L'; }); if (!dual) rows.forEach(function (r) { r.ax = 'L'; });
    /* contas em unidades diferentes NUM MESMO EIXO não se comparam: a visão vai para a BASE 100 (um gráfico só).
       want = a conta que a pessoa escolheu · calc = a que vale · mixed[conta] = essa conta daria mais de uma unidade num eixo */
    var unitIn = function (d, k) { return k === 'index' ? 'Index' : k === 'yoy' ? (d.pp ? 'pp' : d.diff ? d.unit : '%') : d.unit; };
    var unitsOf = function (k, side) { var us = []; rows.forEach(function (r) { if (side && r.ax !== side) return; var u0 = unitIn(r.d, k); if (us.indexOf(u0) < 0) us.push(u0); }); return us; };
    var mixedK = function (k) { return unitsOf(k, 'L').length > 1 || unitsOf(k, 'R').length > 1; };
    var us0 = unitsOf(b.calc), auto = b.calc !== 'index' && mixedK(b.calc), calc = auto ? 'index' : b.calc;
    var out = { rows: rows, P: [], i0: 0, i1: -1, panels: [], gran: gran, calc: calc, want: b.calc, auto: auto, units: us0, dual: dual,
      mixed: { level: mixedK('level'), yoy: mixedK('yoy'), ltm: mixedK('ltm') } }; if (!rows.length) return out;
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
      else r.v = P.map(function (p) { var x = map[p.key]; return x == null ? null : x; }); });
    /* R² de cada série contra a 1ª, na janela e na conta da tela */
    rows.forEach(function (r, k) { r.fit = k ? r2of(rows[0].v, r.v, out.i0, out.i1) : null; if (r.fit) r.fit.per = gname; });
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
        '<div class="dk-why dk-bwhy" hidden></div><div class="dk-bchips"></div><button type="button" class="dk-pill dk-badd">+ Add series</button>' +
        '<div class="dk-bpanels"></div><div class="dk-bmsg" hidden></div><div class="dk-hint dk-bhint"></div></div>' +
      '<div class="dk-card dk-bvals"><div class="dk-ch"><h3>Values</h3><em class="dk-when dk-bvw"></em><span class="dk-grow"></span><button type="button" class="dk-lnk dk-bcopy" title="Copy every period of the window, ready to paste into Excel">Copy table</button></div><div class="dk-tblw"><table class="dk-ov dk-bt"></table></div></div>' +
      '</div></div>');
    r.appendChild(body); var E = this.bel = { body: body }; ['bvlist', 'bsave', 'blink', 'bcat', 'bcount', 'bq', 'blist', 'bcalc', 'bchips', 'bpanels', 'bmsg', 'bhint', 'bwhen', 'bvw', 'bt', 'bcopy', 'bdl', 'badd', 'bdone', 'bwhy'].forEach(function (k) { E[k] = body.querySelector('.dk-' + k); });
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
    E.bchips.addEventListener('click', function (e) { var x = e.target.closest('[data-x]'), go = e.target.closest('[data-go]'), ax = e.target.closest('[data-ax]');
      if (x) { self._bToggle(x.dataset.x); return; }
      if (ax) { self._bAxis(ax.dataset.ax); return; }
      if (go) { var it = self._bItem(go.dataset.go); if (it && self.cfg.goto) self.cfg.goto({ sec: it.sec, metric: it.type === 'm' ? it.metric : self.sections[it.sec].stage, prod: it.prod }); } });
    E.bdl.addEventListener('click', function (e) { var bt = e.target.closest('button'); if (!bt || bt.disabled) return; if (bt.dataset.dl === 'png') self._bPNG(); else self._bXLS(); });
    E.bcopy.addEventListener('click', function () { if (self._bPaid()) return; var t = self._bTable(true); copyText(t, function (ok) { E.bcopy.textContent = ok ? 'Copied ✓' : 'Could not copy'; setTimeout(function () { E.bcopy.textContent = 'Copy table'; }, 1800); }); });
    E.bpanels.addEventListener('pointermove', function (e) { var cv = e.target.closest('canvas'); if (!cv) return; var ch = self.charts['b:' + cv.dataset.p]; if (!ch || !ch.chartArea) return;
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

  /* ── palco: fichas, painéis (um eixo cada), dica, tabela ── */
  Desk.prototype._bStage = function () {
    var E = this.bel, b = this.bui, self = this, v = this._bv = this._bView(), t = D.theme(), n = v.i1 - v.i0 + 1;
    /* a conta que vale fica marcada; a que daria unidades diferentes fica apagada, com o motivo */
    var mixTip = 'Needs series in the same unit. These are in different units, so they are shown on base 100';
    E.bcalc.innerHTML = CALCS.map(function (c0) { var offA = c0[0] === 'ltm' && v.gran === 'annual', offM = !!(v.mixed && v.mixed[c0[0]]), off = offA || offM;
      return '<button type="button" data-k="' + c0[0] + '" aria-pressed="' + (v.calc === c0[0]) + '" title="' + esc(offM ? mixTip : offA ? 'Not available in the annual view' : c0[2]) + '"' + (off ? ' disabled' : '') + '>' + c0[1] + '</button>'; }).join('');
    var info = v.auto ? '<div class="dk-binfo"><b>Shown on base 100.</b> These series are in different units (' + esc(v.units.join(' · ')) + '), so each one starts at 100 at the beginning of the window and you compare how they moved. The cards above and the table below keep the real figures.</div>' : '';
    var sig = v.panels.map(function (p) { return p.unit + (p.dual ? '|R:' + p.unitR : ''); }).join('|') + '#' + (n > 0 ? 1 : 0) + '#' + (v.auto ? v.units.join(',') : '') + '#' + (this._bLoading() ? 'L' : '');
    var uName = function (u) { return u === 'Index' ? 'Index — start of the window = 100' : u; };
    if (E.bpanels.dataset.sig !== sig) { this._dropCharts('b:'); E.bpanels.dataset.sig = sig;
      E.bpanels.innerHTML = (v.panels.length && n > 0) ? info + v.panels.map(function (p, k) { return '<div class="dk-bpanel"><div class="dk-bpu' + (p.dual ? ' dk-bpu2' : '') + '">' + (p.dual ? '<span>Left axis · ' + esc(uName(p.unit)) + '</span><span>Right axis · ' + esc(uName(p.unitR)) + '</span>' : esc(uName(p.unit))) + '</div><div class="dk-chart" style="height:' + (v.panels.length === 1 ? 320 : v.panels.length === 2 ? 200 : 160) + 'px"><canvas data-p="' + k + '"></canvas></div></div>'; }).join('')
        : '<div class="dk-bempty"><b>' + (b.s.length ? (this._bLoading() ? 'Loading the series…' : 'No complete period in this window yet.') : 'Nothing on the chart yet.') + '</b><span>' + (b.s.length ? (this._bLoading() ? 'Prices and surveys come down only when they are put on the chart.' : 'Pick a longer window or a finer granularity in the bar above.') : 'Pick a series on the left, or one of the ready-made views above.') + '</span></div>'; }
    if (v.panels.length && n > 0) { var labels = v.P.slice(v.i0, v.i1 + 1).map(function (p) { return p.label; });
      v.panels.forEach(function (p, k) { var cv = E.bpanels.querySelector('canvas[data-p="' + k + '"]');
        var sets = p.rows.map(function (r) { return X.lineSet(r.v.slice(v.i0, v.i1 + 1), r.col, { label: r.it.name, w: 2.2, end: true, surf: t.surf }); });
        var ch = self._chart('b:' + k, cv, 'line', labels, sets, { stage: true, dec: p.dec });
        /* painéis com o MESMO recuo à esquerda e à direita: o tempo alinha de cima a baixo (com ou sem os rótulos do eixo) */
        ch.options.scales.y.afterFit = function (s) { s.width = 58; };
        if (p.dual) {   // a 2ª escala, à direita, só para as séries marcadas "Right axis" (a grade continua a da esquerda)
          ch.data.datasets.forEach(function (d0, j) { d0.yAxisID = p.rows[j].ax === 'R' ? 'y2' : 'y'; });
          var y0 = ch.options.scales.y; ch.options.scales.y2 = Object.assign({}, y0, { position: 'right', grid: { display: false, drawOnChartArea: false },
            ticks: Object.assign({}, y0.ticks, { callback: function (val) { return fmt(val, (p.decR > 0 && Math.abs(this.max - this.min) < 10) ? 1 : 0); } }), afterFit: function (s) { s.width = 58; } }); }
        ch.options.scales.x.afterFit = function (s) { s.paddingLeft = 16; s.paddingRight = 20; };
        if (k < v.panels.length - 1) ch.options.scales.x.ticks.display = false;
        /* gráfico novo nasce com a animação de "crescer", calculada ANTES de a série ir para a escala da direita: sem parar a
           animação, ela terminava com a linha da direita no pé do gráfico (medido 25/11/2026). Com duas escalas, sem animação. */
        if (p.dual) ch.stop();
        ch.update('none'); }); }
    /* fonte paga no gráfico: só a imagem (a planilha da agência não sai daqui) */
    var paid = this._bPaid(), xb = E.bdl.querySelector('[data-dl="xls"]');
    var srcs = paid ? this._bPaidSrc() : '';
    if (xb) { xb.disabled = paid; xb.title = paid ? 'Not available: a series on the chart comes from a paid source (' + srcs + ') — download the image (PNG)' : 'Download the data (Excel) — full history'; }
    E.bcopy.disabled = paid; E.bcopy.title = paid ? 'Not available: a series on the chart comes from a paid source (' + srcs + ')' : 'Copy every period of the window, ready to paste into Excel';
    var msgs = []; if (b.msg) msgs.push(b.msg);
    E.bmsg.hidden = !msgs.length; E.bmsg.textContent = msgs.join(' · ');
    var hint = v.panels.length > 1 ? 'Series with the same unit share a panel; each other unit gets its own panel, on the same time axis.' : 'Hover to read every series at the same period.';
    if (v.gran !== 'monthly') hint += ' Complete ' + (v.gran === 'quarterly' ? 'quarters' : 'years') + ' only.';
    if (v.calc === 'ltm') hint += ' LTM = last 12 months: sum for volumes, average or ratio for prices and shares.';
    E.bhint.textContent = hint;
    /* explicação: o que é o gráfico e como ler a conta escolhida (na base 100 automática o aviso de cima já explica) */
    var HB = window.IBBADeskHelp && IBBADeskHelp.builder;
    if (E.bwhy) { E.bwhy.innerHTML = (HB && v.rows.length) ? X.whyHTML(HB.what, ((v.auto ? '' : (HB.calc[v.calc] || '')) + (v.dual && HB.dual ? ' ' + HB.dual : '') + (v.rows.length > 1 && HB.r2 ? ' ' + HB.r2 : '')).trim()) : ''; E.bwhy.hidden = !E.bwhy.innerHTML; }
    this._bPaint();
  };
  Desk.prototype._bHover = function (i) { var b = this.bui, self = this; if (b.hover === i) return; b.hover = i; if (this._braf) return; this._braf = requestAnimationFrame(function () { self._braf = 0; self._bPaint(); }); };
  /* o que muda com o mouse: marca nos painéis, valores das fichas, linha da tabela */
  Desk.prototype._bPaint = function () {
    var E = this.bel, b = this.bui, v = this._bv, k, me = this; if (!v) return;
    for (k in this.charts) if (k.indexOf('b:') === 0) { this.charts[k].$dk = { hover: b.hover, pinA: null, pinB: null }; this.charts[k].draw(); }
    var ref = b.hover != null ? v.i0 + b.hover : -1;
    if (ref < 0) { for (var i = v.i1; i >= v.i0 && ref < 0; i--) if (v.rows.some(function (r) { return r.v[i] != null; })) ref = i; }
    E.bwhen.textContent = ref >= 0 && v.P[ref] ? v.P[ref].label + (b.hover != null ? '' : ' · latest') : '';
    E.bchips.innerHTML = v.rows.map(function (r) { var j = ref, own = ''; if (b.hover == null && ref >= 0 && r.v[ref] == null) { for (j = ref; j >= v.i0 && r.v[j] == null; j--); if (j >= v.i0) own = ' (' + v.P[j].label + ')'; }
      var val = (j >= v.i0 && j >= 0) ? r.v[j] : null;
      /* na base 100 a ficha mostra o índice E o número de verdade (senão a unidade real sumiria da tela) */
      var real = (v.calc === 'index' && j >= v.i0 && j >= 0 && r.lev && r.lev[j] != null) ? fmt(r.lev[j], r.d.dec) + ' ' + r.d.unit : '';
      /* R² contra a 1ª série (só da 2ª em diante): o número e, na dica, contra o quê, em quantos períodos e o que significa */
      var f0 = r.fit, ref0 = v.rows[0] ? v.rows[0].it.name : '';
      var r2b = !f0 ? '' : f0.r2 == null
        ? '<span class="dk-br2 dk-br2na" title="' + esc('R² against ' + ref0 + ': needs at least 6 ' + f0.per + ' with both series in this window (now ' + f0.n + ')') + '">R² —</span>'
        : '<span class="dk-br2" title="' + esc('R² against ' + ref0 + ' = ' + fmt(f0.r2, 2) + ', over ' + f0.n + ' ' + f0.per + ' of this window: how much of this series\' movement lines up with ' + ref0 + ' (0 = none, 1 = all), from a linear regression of one on the other.' + (f0.r < 0 ? ' Inverse: they move in opposite directions.' : '') + ' Two series that both trend can show a high R² in Level without a real link — YoY is the stricter test.') + '">R² ' + fmt(f0.r2, 2) + (f0.r < 0 ? ' <em>inverse</em>' : '') + '</span>';
      /* eixo da direita: botão em cada ficha (com 2+ séries) — diz que é botão e o que faz */
      var axb = v.rows.length > 1 ? '<button type="button" class="dk-bax" data-ax="' + esc(r.key) + '" aria-pressed="' + (r.ax === 'R') + '" title="' + esc(r.ax === 'R' ? 'On the right-hand scale — click to bring it back to the left' : 'Give this series its own scale on the right — for series that move much less (or much more) than the others') + '">Right axis</button>' : '';
      return '<span class="dk-bchip"><i style="background:' + r.col + '"></i><button type="button" class="dk-bcn" data-go="' + esc(r.key) + '" title="' + esc(me._bWhat(r) + r.it.where + ' — click to open it in its section') + '">' + esc(r.it.name) + '</button>' +
        '<b>' + numTxt(val, r.dec, v.calc === 'yoy') + ' <small>' + esc(r.unit === 'Index' ? (real ? '· ' + real : '') : r.unit) + esc(own) + (r.note ? ' · ' + esc(r.note) : '') + '</small></b>' +
        r2b + axb + '<button type="button" class="dk-bx" data-x="' + esc(r.key) + '" aria-label="Remove ' + esc(r.it.name) + '" title="Remove from the chart">×</button></span>'; }).join('');
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
    var html = '<thead><tr><th>Period</th>' + v.rows.map(function (r) { return '<th><i class="dk-bdot" style="background:' + r.col + '"></i>' + esc(r.it.name) + ' <span class="dk-src">' + esc((idx ? 'Index · ' + r.d.unit : r.unit) + (v.dual && r.ax === 'R' ? ' · right axis' : '')) + '</span></th>'; }).join('') + '</tr></thead><tbody>';
    for (i = v.i1; i >= from; i--) html += '<tr' + (i === ref && this.bui.hover != null ? ' class="dk-bhi"' : '') + '><td>' + v.P[i].label + '</td>' + v.rows.map(function (r) { var x = r.v[i]; return '<td' + (v.calc === 'yoy' && x != null ? ' class="' + X.cls(x) + '"' : '') + '>' + numTxt(x, r.dec, v.calc === 'yoy') + ((idx && r.lev[i] != null) ? ' <span class="dk-src">' + fmt(r.lev[i], r.d.dec) + ' ' + esc(r.d.unit) + '</span>' : '') + '</td>'; }).join('') + '</tr>';
    E.bt.innerHTML = html + '</tbody>';
  };
  function colName(r, calc) { return r.it.name + (calc === 'yoy' ? ' — YoY' : calc === 'ltm' ? ' — LTM' : calc === 'index' ? ' — Index' : '') + (r.unit === 'Index' ? '' : ' (' + r.unit + ')'); }   // cabeçalho de coluna no Excel
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
    g.fillStyle = t.ink; g.font = '700 ' + (14 * s) + 'px ' + X.FONT; g.fillText('Builder' + (v.calc === 'level' ? '' : ' · ' + CALCS.filter(function (c) { return c[0] === v.calc; })[0][1]) + ' · ' + v.P[v.i0].label + ' – ' + v.P[v.i1].label, pad, pad);
    v.rows.forEach(function (r, i) { var y = pad + 24 * s + i * lh; g.fillStyle = r.col; g.fillRect(pad, y + 3 * s, 10 * s, 10 * s); g.fillStyle = t.ink; g.font = '500 ' + (11.5 * s) + 'px ' + X.FONT;
      var fx = (r.fit && r.fit.r2 != null) ? '  ·  R² ' + fmt(r.fit.r2, 2) + (r.fit.r < 0 ? ' inverse' : '') + ' vs ' + v.rows[0].it.name : '';
      g.fillText(r.it.name + '  (' + r.unit + ')' + (v.dual && r.ax === 'R' ? ' — right axis' : '') + fx, pad + 16 * s, y); });
    var y0 = head; cvs.forEach(function (c, i) { var pn = v.panels[i]; g.fillStyle = t.mut; g.font = '700 ' + (10 * s) + 'px ' + X.FONT; g.fillText(String(pn.dual ? 'Left axis · ' + pn.unit : pn.unit).toUpperCase(), pad, y0 + 3 * s);
      if (pn.dual) { g.textAlign = 'right'; g.fillText(String('Right axis · ' + pn.unitR).toUpperCase(), pad + W, y0 + 3 * s); g.textAlign = 'left'; } y0 += 20 * s; g.drawImage(c, pad, y0); y0 += c.height; });
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
  Desk.prototype.builderDebug = function () { var v = this._bView(); return { calc: v.calc, want: v.want, auto: v.auto, gran: v.gran, keys: v.P.slice(v.i0, v.i1 + 1).map(function (p) { return p.key; }), labels: v.P.slice(v.i0, v.i1 + 1).map(function (p) { return p.label; }),
    panels: v.panels.map(function (p) { return p.unit; }), series: v.rows.map(function (r) { return { key: r.key, name: r.it.name, unit: r.unit, vals: r.v.slice(v.i0, v.i1 + 1), r2: r.fit ? r.fit.r2 : null, r: r.fit ? r.fit.r : null, n: r.fit ? r.fit.n : null }; }) }; };
  D.builder = { encodeView: encodeView, decodeView: decodeView, parseKey: parseKey, MAX: MAX, MAXU: MAXU, r2of: r2of };
})();
