/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — US MARKET (M&M › Steel › US market)
   ────────────────────────────────────────────────────────────────────────────
   O aço nos EUA, com três vistas na mesma sub-aba:
     Demand             consumo aparente de aço ACABADO (embarques AISI + importação − exportação), penetração
                        de importados, embarques, importação e exportação de acabados — desde jan/2018
     Production         aço bruto (worldsteel), utilização da capacidade e índice de aço bruto (Fed) — desde 2000
     Imports by origin  importação por país e por produto (Census FT900A), com o filtro de produto da própria
                        seção — desde jan/2018
   Dado: `Steel and Mining/us_steel.json`, mantido TODO DIA pelo robô `Steel and Mining/update_us_steel.py`
   (workflow update_us_steel.yml), como o SECEX. O arquivo só desce quando uma das vistas abre (ou o Builder).

   Chave `us_steel` (admin → Funcionalidades): o admin vê sempre; o cliente só com a chave ligada. Sem a chave
   a sub-aba não aparece, a #âncora cai em Prices e o arquivo nem desce.

   A página liga este arquivo em poucos pontos (procure "IBBAUS" em steel_sm_dashboard.html):
     IBBAUS.applyFlag()   no boot, junto das outras chaves
     IBBAUS.wireNav()     logo depois das constantes de navegação (SUB_ORDER, DESK_ONLY, COM_OF)
     IBBAUS.gate(key)     no começo do _deskRender (sem permissão → Prices; dado descendo → aviso)
     IBBAUS.sections(h)   dentro do catálogo da mesa · IBBAUS.ctx no Context · IBBAUS.secs/presets no Builder
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.IBBAUS) return;

  var SECS = ['us', 'usprod', 'usimp'];
  var NT = 0.90718474;                       // 1 net ton (tonelada curta, como o AISI publica) em toneladas métricas
  var DESDE = '2018-01';                     // comércio país × produto e embarques: completos a partir daqui
  var PRODS = [{ k: 'total', l: 'Total' }, { k: 'fin', l: 'Finished' }, { k: 'semi', l: 'Semi-finished' },
               { k: 'flat', l: 'Flat' }, { k: 'long', l: 'Long' }, { k: 'pipe', l: 'Pipe & tube' }];
  var PLAB = {}; PRODS.forEach(function (p) { PLAB[p.k] = p.l; });

  var hash0 = (location.hash || '').slice(1), pending = SECS.indexOf(hash0) >= 0 ? hash0 : null;
  var ok = null, D = null, P = null, err = null;   // ok: null = a resposta das chaves ainda não chegou

  function has(name) { try { return typeof window[name] === 'function'; } catch (e) { return false; } }
  function inFam(fk, fam) { return fk === 'total' || (fk === 'fin' ? fam !== 'semi' : fam === fk); }
  function add(m, k, v) { m[k] = (m[k] || 0) + v; }

  /* us_steel.json → mapas mensais {'AAAA-MM': valor} nas unidades da mesa (kt, US$ mn, %, índice) */
  function prep(j) {
    var m = j.m || {}, G = j.groups || {}, out = { asof: j.asof || {}, m: {}, imp: {}, cty: {}, grp: {}, gname: {} };
    function series(src, f, from) { var o = {}; Object.keys(src || {}).forEach(function (k) { if (k >= from && src[k] != null) o[k] = f(src[k]); }); return o; }
    var id = function (v) { return v; }, kt = function (v) { return v / 1000; };
    out.m.crude = series(m.crude, id, '2000-01');
    out.m.util = series(m.util, id, '2000-01');
    out.m.ipraw = series(m.ipraw, id, '2000-01');
    out.m.ship = series(m.ship_nt, function (v) { return v * NT / 1000; }, DESDE);
    var ex = series(m.exp_t, kt, DESDE), es = series(m.exp_semi_t, kt, DESDE), ef = {};
    Object.keys(ex).forEach(function (k) { if (es[k] != null) ef[k] = ex[k] - es[k]; });
    out.m.exp = ex; out.m.expfin = ef;
    Object.keys(G).forEach(function (c) { out.gname[c] = G[c][0]; });
    PRODS.forEach(function (p) { out.imp[p.k] = { v: {}, r: {} }; out.cty[p.k] = {}; out.grp[p.k] = {}; });
    Object.keys(j.imp || {}).forEach(function (ym) {
      if (ym < DESDE) return;
      PRODS.forEach(function (p) { out.imp[p.k].v[ym] = 0; out.imp[p.k].r[ym] = 0; });   // mês publicado = zero onde não houve importação
      (j.imp[ym] || []).forEach(function (r) {
        var ctry = r[0], g = r[1], t = (r[2] || 0) / 1000, usd = (r[3] || 0) / 1e6, fam = (G[g] || ['', 'other'])[1];
        PRODS.forEach(function (p) {
          if (!inFam(p.k, fam)) return;
          add(out.imp[p.k].v, ym, t); add(out.imp[p.k].r, ym, usd);
          var c = out.cty[p.k][ctry] || (out.cty[p.k][ctry] = {}); add(c, ym, t);
          var gg = out.grp[p.k][g] || (out.grp[p.k][g] = {}); add(gg, ym, t);
        });
      });
    });
    out.impfin = out.imp.fin.v;
    return out;
  }

  /* entidades do "Who is behind the number": TODAS as da base, em ordem de relevância (últimos 36 meses) */
  var entC = {};
  function rank(by, label) {
    var keys = Object.keys(by), last = '';
    keys.forEach(function (n) { for (var p in by[n]) if (p > last) last = p; });
    var cut = last ? (function () { var y = +last.slice(0, 4), mo = +last.slice(5, 7) - 35; while (mo <= 0) { mo += 12; y--; } return y + '-' + (mo < 10 ? '0' : '') + mo; })() : '';
    var sc = keys.map(function (n) { var rec = 0, tot = 0, m0 = by[n]; for (var p in m0) { tot += m0[p]; if (p >= cut) rec += m0[p]; } return [n, rec, tot]; })
      .filter(function (x) { return x[2] > 0; }).sort(function (a, b) { return b[1] - a[1] || b[2] - a[2]; });
    return { names: sc.map(function (x) { return label ? label(x[0]) : x[0]; }), maps: sc.map(function (x) { return by[x[0]]; }) };
  }
  function countries(fk) { var k = 'c|' + fk; return entC[k] || (entC[k] = D ? rank(D.cty[fk] || {}) : { names: [], maps: [] }); }
  function products(fk) { var k = 'g|' + fk; return entC[k] || (entC[k] = D ? rank(D.grp[fk] || {}, function (c) { return D.gname[c] || c; }) : { names: [], maps: [] }); }
  function M(name) { return (D && D.m[name]) || {}; }

  function load() {
    if (P) return P;
    err = null;
    P = fetch('us_steel.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { D = prep(j); entC = {}; var inst = window.IBBADesk && window.IBBADesk.instance; if (inst) inst.invalidate(); return D; })
      .catch(function (e) { err = e; P = null; console.warn('US market: us_steel.json', e); throw e; });
    return P;
  }

  /* ── navegação: a sub-aba "US market" na linha de Steel (só com a chave ou admin) ── */
  function set(v) {
    ok = !!v; document.documentElement.classList.toggle('us-on', ok);
    try {
      var t = COM_TABS.steel, i = -1; t.forEach(function (x, k) { if (x[0] === 'us') i = k; });
      if (ok && i < 0) t.push(['us', 'US market', ['usprod', 'usimp']]); else if (!ok && i >= 0) t.splice(i, 1);
      var bar = document.getElementById('dk-subnav'); if (bar) bar.dataset.com = '';   // a linha de abas se refaz
      if (typeof _dbReady === 'undefined' || !_dbReady) return;
      if (!ok && SECS.indexOf(currentSub) >= 0) setSub('parity');
      else if (ok && pending && pending !== currentSub) { var h = pending; pending = null; setSub(h); }
      else if (SECS.indexOf(currentSub) >= 0) render();
      else _navMark(currentSub);
    } catch (e) { console.warn('US market: chave', e); }
  }
  function applyFlag() {
    if (!has('_flagsRole')) return;
    try {
      _flagsRole().then(function (res) {
        var fl = res && res[0], role = res && res[1];
        if ((role && role.error) || (fl && fl.error)) return;   // resposta com erro não é um "não" (mesma regra da chave data_desk)
        var isAdmin = !!(role && role.data === 'admin');
        var f = (fl && Array.isArray(fl.data)) ? fl.data.filter(function (x) { return x.key === 'us_steel'; })[0] : null;
        set(isAdmin || !!(f && f.enabled));
      }, function () {});
    } catch (e) {}
  }
  function wireNav() {
    try {
      SECS.forEach(function (s) { if (DESK_ONLY.indexOf(s) < 0) DESK_ONLY.push(s); COM_OF[s] = 'steel'; });
      if (SUB_ORDER.indexOf('us') < 0) { var at = SUB_ORDER.indexOf('oreprices'); SUB_ORDER.splice(at < 0 ? SUB_ORDER.length : at, 0, 'us', 'usprod', 'usimp'); }
    } catch (e) { console.warn('US market: navegação', e); }
  }
  /* chamado no começo do _deskRender: true = esta função cuidou da tela (a página não desenha) */
  function gate(key) {
    if (document.body.classList.contains('mob-picker-active')) return false;
    var ready = typeof _dbReady !== 'undefined' && _dbReady;
    if (pending && ok === true && ready && key !== pending) { var h = pending; pending = null; setTimeout(function () { setSub(h); }, 0); }
    if (key === 'builder' && ok === true && !D && !P) load().then(function () { if (currentSub === 'builder') render(); }, function () {});
    if (SECS.indexOf(key) < 0) return false;
    if (pending === key) pending = null;
    if (ok === false) { setTimeout(function () { setSub('parity'); }, 0); return true; }
    if (D) return false;
    var root = document.getElementById('desk-root'); if (!root) return false;
    var inst = window.IBBADesk && window.IBBADesk.instance; if (inst && inst.cur) inst.hide();
    document.querySelectorAll('.section.active').forEach(function (d) { if (d !== root) d.classList.remove('active'); });
    root.classList.add('active');
    root.innerHTML = '<div class="dk-usload" role="status">' + (err && ok === true
      ? 'The US data could not be loaded right now. <button type="button" class="dk-lnk" onclick="render()">Try again</button>'
      : 'Loading US data…') + '</div>';
    if (ok === true && !P && !(err && P === null && root.dataset.usTried === '1')) {
      root.dataset.usTried = '1';
      load().then(function () { root.dataset.usTried = ''; if (SECS.indexOf(currentSub) >= 0) render(); },
        function () { root.dataset.usTried = ''; if (SECS.indexOf(currentSub) >= 0) render(); });
    }
    return true;
  }

  /* ── catálogo das três vistas (h = {F, sum} da página) ── */
  function sections(h) {
    var F = h.F;
    var go = function (s) { return function () { setSub(s, { anim: 1 }); }; };
    var views = function (cur) {
      return [['us', 'Demand'], ['usprod', 'Production'], ['usimp', 'Imports by origin']].map(function (v) {
        return v[0] === cur ? { label: v[1], current: true } : { label: v[1], onPick: go(v[0]) }; });
    };
    var cons = function () { return { s: M('ship'), i: D ? D.impfin : {}, e: M('expfin') }; };
    var consV = function (A, c) { return F.sub(F.add(A.sum(c.s), A.sum(c.i)), A.sum(c.e)); };
    var avg = function (name) { return function () { var v = M(name), n = {}; Object.keys(v).forEach(function (k) { n[k] = 1; }); return { v: v, n: n }; }; };
    var avgV = function (A, c) { return F.div(A.sum(c.v), A.sum(c.n)); };
    var share = function (pick) { return function (x) { var e = countries(x.prod), k = pick(e); return { l: k >= 0 ? e.maps[k] : {}, t: h.sum(e.maps) }; }; };
    var shareV = function (A, c) { return F.div(A.sum(c.l), A.sum(c.t), 100); };
    return {
      us: {
        label: 'US demand', src: 'AISI · US Census', stage: 'cons', tiles: ['cons', 'pen', 'ship', 'imp', 'exp'], views: views('us'),
        metrics: [
          { id: 'cons', label: 'US apparent consumption — finished steel', short: 'Apparent consumption', unit: 'kt', dec: 0, flow: true,
            note: 'Derived: AISI mill shipments + finished imports − finished exports (US Census). Semi-finished steel is left out on both sides — it is rolled in US mills and is already in the shipments.',
            comp: cons, calc: consV },
          { id: 'pen', label: 'US import penetration — finished steel', short: 'Import penetration', unit: '%', dec: 1, pp: true, ref: 'windowAvg',
            note: 'Finished imports ÷ apparent consumption (the AISI convention) · dashed = average of the window',
            comp: cons, calc: function (A, c) { var i = A.sum(c.i); return F.div(i, F.sub(F.add(A.sum(c.s), i), A.sum(c.e)), 100); } },
          { id: 'ship', label: 'US mill shipments', short: 'Mill shipments', unit: 'kt', dec: 0, flow: true, note: 'AISI · published in net tons, shown in metric tonnes (× 0.907)',
            comp: function () { return { v: M('ship') }; }, calc: function (A, c) { return A.sum(c.v); } },
          { id: 'imp', label: 'US finished steel imports', short: 'Finished imports', unit: 'kt', dec: 0, flow: true, note: 'US Census (FT900A) · every product except semi-finished · by country in "Imports by origin"',
            comp: function () { return { v: D ? D.impfin : {} }; }, calc: function (A, c) { return A.sum(c.v); } },
          { id: 'exp', label: 'US finished steel exports', short: 'Finished exports', unit: 'kt', dec: 0, flow: true, note: 'US Census (International Trade API) · steel products on the AISI list, semi-finished left out',
            comp: function () { return { v: M('expfin') }; }, calc: function (A, c) { return A.sum(c.v); } }
        ]
      },
      usprod: {
        label: 'US production', src: 'worldsteel · Federal Reserve', stage: 'crude', tiles: ['crude', 'util', 'ipraw'], views: views('usprod'),
        metrics: [
          { id: 'crude', label: 'US crude steel production', short: 'Crude steel', unit: 'kt', dec: 0, flow: true, note: 'worldsteel monthly release (its estimate, based on AISI data), published in Mt with one decimal',
            comp: function () { return { v: M('crude') }; }, calc: function (A, c) { return A.sum(c.v); } },
          { id: 'util', label: 'US capacity utilization — iron & steel', short: 'Capacity utilization', unit: '%', dec: 1, pp: true, ref: 'windowAvg',
            note: 'Federal Reserve G.17, iron and steel products, seasonally adjusted · quarter and year = average of the months · dashed = average of the window',
            comp: avg('util'), calc: avgV },
          { id: 'ipraw', label: 'US raw steel production index (2017 = 100)', short: 'Raw steel index', unit: 'index', dec: 1,
            note: 'Federal Reserve G.17, raw steel, seasonally adjusted · quarter and year = average of the months',
            comp: avg('ipraw'), calc: avgV }
        ]
      },
      usimp: {
        label: 'US imports', src: 'US Census (FT900A)', stage: 'vol', tiles: ['vol', 'rev', 'lead', 'bra'], views: views('usimp'), prods: PRODS, bprods: PRODS,
        metrics: [
          { id: 'vol', label: function (x) { return 'US steel imports — ' + PLAB[x.prod].toLowerCase(); }, short: 'Import volume', unit: 'kt', dec: 0, flow: true,
            note: 'US Census, FT900A (imports for consumption) · the split by product is in "By product" below',
            comp: function (x) { return { v: D ? D.imp[x.prod].v : {} }; }, calc: function (A, c) { return A.sum(c.v); } },
          { id: 'rev', label: function (x) { return 'US steel imports, value — ' + PLAB[x.prod].toLowerCase(); }, short: 'Import value', unit: 'US$ mn', dec: 0, flow: true,
            note: 'US Census, FT900A · customs value',
            comp: function (x) { return { r: D ? D.imp[x.prod].r : {} }; }, calc: function (A, c) { return A.sum(c.r); } },
          { id: 'lead', label: function (x) { return (countries(x.prod).names[0] || 'Largest supplier') + ' share'; }, unit: '%', dec: 1, pp: true,
            comp: share(function () { return 0; }), calc: shareV },
          { id: 'bra', label: 'Brazil share', unit: '%', dec: 1, pp: true,
            comp: share(function (e) { return e.names.indexOf('Brazil'); }), calc: shareV }
        ],
        who: [
          { id: 'country', label: 'Countries', tab: 'By country', noun: 'countries', lead: 'Brazil', unit: 'kt', title: 'US steel imports by country', entities: function (x) { return countries(x.prod); },
            /* os 5 maiores dos últimos 3 anos + o Brasil sempre à vista (em laranja), mesmo quando não está entre eles */
            defaultSel: function (names) { var d = names.slice(0, 5); if (d.indexOf('Brazil') < 0 && names.indexOf('Brazil') >= 0) d.push('Brazil'); return d; } },
          { id: 'product', label: 'Products', tab: 'By product', noun: 'products', unit: 'kt', title: 'US steel imports by product', top: 6, noLead: true, entities: function (x) { return products(x.prod); } }
        ]
      }
    };
  }

  /* textos "What it shows / How to read" (regra do usuário: todo gráfico da mesa com explicação à vista) */
  function help() {
    var Hh = window.IBBADeskHelp; if (!Hh || !Hh.mm || Hh.mm.us) return;
    var lead = function (o) { var m = /^(.+?) share$/.exec(String((o && o.label) || '')); return m ? m[1] : 'the largest supplier'; };
    var fam = function (o) { var p = (o && o.prod) || 'total'; return p === 'total' ? 'all steel products' : p === 'fin' ? 'finished steel (everything except semi-finished)' : p === 'semi' ? 'semi-finished steel (slabs, billets, ingots)' : p === 'pipe' ? 'pipe & tube' : p + ' steel'; };
    Hh.mm.us = {
      cons: { what: 'How much finished steel the US market used, in thousand tonnes: what US mills shipped (AISI) plus finished-steel imports minus finished-steel exports (US Census). A derived figure, the same build-up the AISI uses.',
        how: 'Slabs and billets are left out on both sides: they are rolled in US mills and already show up in the shipments, so counting them as imports would count the same steel twice.' },
      pen: { what: 'Share of the finished steel used in the US that was imported: finished imports ÷ apparent consumption (AISI convention; Census and AISI data). Higher = imports taking more of the US market.',
        how: 'Tariffs (Section 232 since March 2018, 50% since June 2025) show up here first.' },
      ship: 'Steel shipped by US mills to their clients, in thousand tonnes (AISI; published in net tons and converted here to metric tonnes). The domestic side of apparent consumption.',
      imp: 'Finished steel imported by the US, in thousand tonnes — every product except slabs, billets and ingots (US Census, FT900A). Where it comes from is in "Imports by origin".',
      exp: 'Finished steel exported by the US, in thousand tonnes — the steel products on the AISI list, semi-finished left out (US Census).'
    };
    Hh.mm.usprod = {
      crude: { what: 'Crude steel made in the US — liquid steel before rolling — in thousand tonnes (worldsteel monthly release, an estimate based on AISI data).',
        how: 'worldsteel publishes this figure in million tonnes with one decimal, so the monthly line moves in steps of 100 kt and small changes (and the % changes) are approximate.' },
      util: { what: 'How much of US iron and steel capacity is in use, in % (Federal Reserve G.17, seasonally adjusted). Above ~80% mills are running hard; below ~70% they are idling furnaces.',
        how: 'Quarters and years show the average of their months.' },
      ipraw: { what: 'Federal Reserve index of US raw steel output (2017 = 100, seasonally adjusted) — the same steel as the crude steel line, without worldsteel\'s rounding.',
        how: 'Quarters and years show the average of their months.' }
    };
    Hh.mm.usimp = {
      vol: function (o) { return 'How much steel the US imported, in thousand tonnes — ' + fam(o) + ' (US Census, FT900A, imports for consumption).'; },
      rev: function (o) { return 'What the US paid for imported steel, in US$ million — ' + fam(o) + ' (US Census, customs value).'; },
      lead: function (o) { return 'Share of US steel import volume that comes from ' + lead(o) + ', the largest supplier over the last three years — ' + fam(o) + ' (US Census).'; },
      bra: function (o) { return 'Share of US steel import volume that comes from Brazil — ' + fam(o) + ' (US Census). Brazil mostly ships slabs to US mills, so the share is highest in semi-finished.'; },
      $who: { country: 'Where US steel imports come from, by country of origin (US Census, FT900A). Brazil is in orange.',
        product: 'Which steel products the US imports, by AISI product group (US Census, FT900A).' }
    };
  }

  /* celular: a entrada "US market" na lista de seções (só aparece com a chave ou admin) */
  function mobile() {
    try {
      var st = document.createElement('style');
      st.textContent = 'html.desk-on:not(.us-on) .mob-sec-item.us-only{display:none;}' +
        '.dk-usload{padding:72px 16px;text-align:center;color:var(--gray-mid,#7b7770);font-size:13px;}' +
        '.dk-usload .dk-lnk{margin-left:6px;}';
      document.head.appendChild(st);
      var list = document.querySelector('.mob-sections-list'); if (!list || list.querySelector('.us-only')) return;
      var ore = [].filter.call(list.querySelectorAll('.mob-sec-group'), function (g) { return /iron ore/i.test(g.textContent); })[0];
      /* uma entrada por vista: no celular a barra Demand · Production · Imports fica atrás da barra de filtros */
      [['us', 'US market — demand', 'US apparent consumption, import penetration, mill shipments'],
       ['usprod', 'US market — production', 'US crude steel output and capacity utilization'],
       ['usimp', 'US imports by origin', 'By country and product, with Brazil\'s share']].forEach(function (e) {
        var b = document.createElement('button'); b.className = 'mob-sec-item dk-only us-only'; b.setAttribute('onclick', "mobSelect('" + e[0] + "')");
        b.innerHTML = '<div class="mob-sec-info"><div class="mob-sec-title">' + e[1] + '</div><div class="mob-sec-desc">' + e[2] + '</div></div><span class="mob-sec-arrow">→</span>';
        list.insertBefore(b, ore || null);
      });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { help(); mobile(); }); else { help(); mobile(); }

  window.IBBAUS = {
    secs: SECS,
    ok: function () { return ok === true; },
    data: function () { return D; },
    load: load, applyFlag: applyFlag, wireNav: wireNav, gate: gate, sections: sections, set: set,
    presets: [{ n: 'US vs Brazil — import penetration', s: ['us.pen.total', 'imports.pen.total'], v: 'level', g: 'monthly', w: '5y', tip: 'Share of imports in the finished steel each market uses (US: AISI build-up; Brazil: IABr)' }],
    ctx: {
      us: { tickers: ['GGBR4.SA', 'TX'], news: { sector: 'steel', topics: ['tariffs', 'demand', 'imports'], q: 'US steel' } },
      usprod: { tickers: ['GGBR4.SA', 'TX'], news: { sector: 'steel', topics: ['production', 'steel_industry'], q: 'US steel' } },
      usimp: { tickers: ['TX', 'GGBR4.SA', 'CSNA3.SA'], bench: ['HRC_CHINA'], news: { sector: 'steel', topics: ['tariffs', 'imports', 'slab'], q: 'US steel imports' } }
    }
  };
})();
