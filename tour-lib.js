/* =========================================================================
 * tour-lib.js — TUTORIAL (tours guiados) da dashboard.   window.IBBATour
 * Escurece a tela, destaca UM elemento por vez com um cartão curto e vai
 * passando pelas funções. Atravessa páginas (sessionStorage) e respeita as
 * flags (passo de função desligada é pulado; segmento desligado some).
 * Carregado SOB DEMANDA pelo topnav.js — clique em "Tutorial", convite da
 * 1ª visita ou tour já em andamento. Quem nunca usa não baixa nada.
 * Textos e passos moram em tour-content.js (window.IBBA_TOURS).
 * UI em inglês; comentários em PT. Sem dependências.
 * REGRA DE OURO: erro no tour NUNCA quebra a página do cliente — alvo que não
 * aparece é PULADO com console.warn, e tudo que toca a página tem try/catch.
 * ====================================================================== */
;(function () {
  if (window.IBBATour) return;

  var K_RUN = 'ibba_tour_run',       // sessionStorage: corrida em andamento (atravessa páginas na aba)
      K_RESUME = 'ibba_tour_resume', // localStorage: tour completo interrompido ("continue de onde parou")
      K_DONE = 'ibba_tour_done',     // localStorage: {segmento: timestamp} concluídos
      K_SEEN = 'ibba_tour_seen',     // localStorage: convite da 1ª visita já respondido
      K_FLAGS = 'ibba_tour_flags';   // sessionStorage: cache das flags {at, on, admin}
  var MOBILE_Q = '(max-width:900px)';  // mesma régua da barra global (topnav.js)
  var WAIT_MS = 6000, WAIT_NAV_MS = 12000, FLAGS_TTL = 30 * 60 * 1000;
  var EDGE = 12, GAP = 12;             // margem da tela e distância cartão↔alvo

  // ── ambiente (trocável nos testes) ──────────────────────────────────────
  var env = {
    mobile: null,                                   // null = matchMedia; true/false força
    navigate: function (url) { location.href = url; },
    now: function () { return Date.now(); },
    flags: null,                                    // função → {on:{}, admin} (teste); null = Supabase
    warn: function () { try { console.warn.apply(console, ['[tour]'].concat([].slice.call(arguments))); } catch (e) {} }
  };
  function isMobile() {
    if (env.mobile != null) return !!env.mobile;
    try { return window.matchMedia(MOBILE_Q).matches; } catch (e) { return vpW() <= 900; }
  }
  // no painel do navegador embutido o innerWidth às vezes vem 0 (aba escondida) → reserva
  function vpW() { return document.documentElement.clientWidth || window.innerWidth || 1280; }
  function vpH() { return window.innerHeight || document.documentElement.clientHeight || 800; }

  // ── armazenamento (nunca estoura: modo privado/cota cheia só perde o recado) ──
  function sget(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function sset(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lget(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lset(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ── conteúdo ────────────────────────────────────────────────────────────
  function content() { var c = window.IBBA_TOURS; return (c && c.segments) ? c : { order: [], segments: [] }; }
  function seg(id) {
    var s = content().segments;
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
    return null;
  }
  // caminho comparável: sem domínio, decodificado, minúsculo, raiz = /index.html
  function normPath(url) {
    var p;
    try { p = new URL(url, location.href).pathname; } catch (e) { p = String(url || ''); }
    try { p = decodeURIComponent(p); } catch (e) {}
    p = p.toLowerCase();
    return (p === '' || p === '/') ? '/index.html' : p;
  }
  // segmento pode morar em mais de um endereço (ex.: cópia da prévia local) → `page` aceita lista
  function onPage(s) {
    if (!s || !s.page) return true;
    var here = normPath(location.href), pages = [].concat(s.page);
    for (var i = 0; i < pages.length; i++) if (normPath(pages[i]) === here) return true;
    return false;
  }

  // ── flags ───────────────────────────────────────────────────────────────
  // Mesma semântica das páginas, por isso duas chaves:
  //   requires:'exec_calendar' → só com a flag LIGADA (áreas novas nascem fechadas)
  //   unlessOff:'commodities'  → só some com a flag DESLIGADA (painéis da home nascem abertos)
  // Segmento desligado: o admin ainda o vê no painel (selo OFF) e pode abrir em modo prévia.
  function pageSb() {
    try { if (typeof sbAuth !== 'undefined' && sbAuth && sbAuth.rpc) return sbAuth; } catch (e) {}
    return (window.sbAuth && window.sbAuth.rpc) ? window.sbAuth : null;
  }
  // reserva sem rede: os recados que a home já grava p/ o menu (fail-closed nas áreas novas)
  function recadoFlags() {
    function r(k) { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } }
    var on = {};
    if (r('ibba_events_on')) on.exec_calendar = true;
    if (r('ibba_mw_on')) on.market_watch = true;
    if (r('ibba_data_on')) on.data_page = true;
    if (r('ibba_quarterly_on')) on.quarterly = true;
    if (r('ibba_tour_on')) on.tutorial = true;
    return { at: 0, on: on, admin: r('ibba_is_admin') };
  }
  function cachedFlags() {
    var c = sget(K_FLAGS);
    return (c && c.at && (env.now() - c.at) < FLAGS_TTL) ? c : null;
  }
  function readFlags() {
    if (env.flags) {
      return Promise.resolve(env.flags()).then(function (f) { return { at: env.now(), on: (f && f.on) || {}, admin: !!(f && f.admin) }; });
    }
    var c = cachedFlags(); if (c) return Promise.resolve(c);
    var sb = pageSb(); if (!sb) return Promise.resolve(recadoFlags());
    return Promise.all([sb.rpc('get_dashboard_flags'), sb.rpc('get_my_role')]).then(function (rs) {
      var fl = rs[0], role = rs[1];
      if (!fl || fl.error || !Array.isArray(fl.data)) return recadoFlags();
      var on = {}; fl.data.forEach(function (f) { on[f.key] = f.enabled; });
      var out = { at: env.now(), on: on, admin: !!(role && !role.error && role.data === 'admin') };
      sset(K_FLAGS, out);
      return out;
    }).catch(function () { return recadoFlags(); });
  }
  function flagOk(spec, F, preview) {
    if (!spec) return true;
    var on = (F && F.on) || {}, bypass = !!(preview && F && F.admin);
    if (bypass) return true;
    var req = spec.requires ? [].concat(spec.requires) : [];
    for (var i = 0; i < req.length; i++) if (on[req[i]] !== true) return false;
    var uo = spec.unlessOff ? [].concat(spec.unlessOff) : [];
    for (var j = 0; j < uo.length; j++) if (on[uo[j]] === false) return false;
    return true;
  }
  function mediaOk(step) { return !step.media || step.media === (isMobile() ? 'mobile' : 'desktop'); }
  function stepOk(step, F, preview) { return mediaOk(step) && flagOk(step, F, preview); }
  function eligible(s, F, preview) { return (s.steps || []).filter(function (st) { return stepOk(st, F, preview); }); }
  function fullQueue(F) {
    return (content().order || []).filter(function (id) {
      var s = seg(id); return !!s && flagOk(s, F, false) && eligible(s, F, false).length > 0;
    });
  }

  // passo "como vai para a tela": variante do celular + {click}→tap
  function view(step) {
    var m = isMobile(), v = {}, k;
    for (k in step) v[k] = step[k];
    if (m && step.mobile) for (k in step.mobile) v[k] = step.mobile[k];
    ['title', 'body'].forEach(function (f) {
      if (typeof v[f] !== 'string') return;
      v[f] = v[f].replace(/\{(click|Click)\}/g, function (_, w) { return m ? (w === 'Click' ? 'Tap' : 'tap') : w; });
    });
    return v;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function rich(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }   // **negrito** e mais nada

  // ── geometria ───────────────────────────────────────────────────────────
  // Visível = conectado, fora de [hidden], com tamanho e sem opacidade zero no caminho.
  // (o [hidden] tem de ser checado à parte: `.splash{display:flex}` ganha do UA — armadilha do calendário)
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest && el.closest('[hidden]')) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.opacity === '0') return false;
      if (n === el && cs.visibility === 'hidden') return false;
    }
    return true;
  }
  // alvo = seletor ou lista; sem `all` pega o 1º VISÍVEL de cada seletor, com `all` junta todos
  function findTargets(sel, all) {
    var sels = [].concat(sel || []), out = [];
    for (var i = 0; i < sels.length; i++) {
      var list; try { list = document.querySelectorAll(sels[i]); } catch (e) { list = []; }
      for (var j = 0; j < list.length; j++) {
        if (visible(list[j])) { out.push(list[j]); if (!all) break; }
      }
    }
    return out;
  }
  function waitTargets(v, ms) {
    return new Promise(function (res) {
      var t0 = env.now();
      (function tick() {
        var els = findTargets(v.target, v.all);
        if (els.length) return res(els);
        if (env.now() - t0 >= ms) return res([]);
        setTimeout(tick, 120);
      })();
    });
  }
  function unionRect(els) {
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    els.forEach(function (el) {
      var q = el.getBoundingClientRect();
      l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    });
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }
  // recorte = retângulo do alvo + folga, preso na tela (o anel fica visível mesmo com alvo cortado)
  function holeBox(r, pad, vw, vh) {
    vw = vw || vpW(); vh = vh || vpH();
    var l = Math.max(2, r.left - pad), t = Math.max(2, r.top - pad);
    var rr = Math.min(vw - 2, r.right + pad), b = Math.min(vh - 2, r.bottom + pad);
    return { left: l, top: t, right: rr, bottom: b, width: Math.max(0, rr - l), height: Math.max(0, b - t) };
  }
  // Containers que ROLAM de verdade. overflow:hidden fica de fora de propósito: scrollIntoView
  // rolaria o #stage da Home (overflow hidden + transform) e desmontaria o layout.
  function scrollers(el) {
    var out = [], n = el.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      var cs = getComputedStyle(n);
      if ((/auto|scroll/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) ||
          (/auto|scroll/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1)) out.push(n);
      n = n.parentElement;
    }
    return out;
  }
  // Traz o alvo p/ a faixa livre [area.top, area.bottom] da janela. O delta sai em px VISUAIS;
  // dentro de container escalado (Home: transform:scale) vira px de layout pela razão
  // tamanho-na-tela ÷ tamanho-de-layout do próprio container.
  function bringIntoView(els, area) {
    if (!els.length) return;
    scrollers(els[0]).forEach(function (sc) {
      var cr = sc.getBoundingClientRect(), er = unionRect(els);
      var ky = sc.offsetHeight ? cr.height / sc.offsetHeight : 1, kx = sc.offsetWidth ? cr.width / sc.offsetWidth : 1;
      var top = cr.top + sc.clientTop * ky, bot = top + sc.clientHeight * ky;
      if (er.top < top || er.bottom > bot) {
        var dy = (er.height > bot - top) ? er.top - top - 8 * ky : (er.top + er.bottom) / 2 - (top + bot) / 2;
        sc.scrollTop += dy / (ky || 1);
      }
      var lft = cr.left + sc.clientLeft * kx, rgt = lft + sc.clientWidth * kx;
      if (er.left < lft || er.right > rgt) {
        var dx = (er.width > rgt - lft) ? er.left - lft - 8 * kx : (er.left + er.right) / 2 - (lft + rgt) / 2;
        sc.scrollLeft += dx / (kx || 1);
      }
    });
    var r = unionRect(els);
    if (r.top < area.top || r.bottom > area.bottom) {
      var d = (r.height > area.bottom - area.top) ? r.top - area.top - 8 : (r.top + r.bottom) / 2 - (area.top + area.bottom) / 2;
      try { window.scrollBy(0, d); } catch (e) {}   // página que não rola (Home no desktop) = nada acontece
    }
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  // computador: embaixo → em cima → direita → esquerda; alvo gigante → cartão por cima, no canto
  function placeDesktop(w, h, hole, vw, vh, pref) {
    var cx = hole.left + hole.width / 2, cy = hole.top + hole.height / 2;
    var c = {
      bottom: { left: clamp(cx - w / 2, EDGE, vw - w - EDGE), top: hole.bottom + GAP, ok: hole.bottom + GAP + h <= vh - EDGE },
      top:    { left: clamp(cx - w / 2, EDGE, vw - w - EDGE), top: hole.top - GAP - h, ok: hole.top - GAP - h >= EDGE },
      right:  { left: hole.right + GAP, top: clamp(cy - h / 2, EDGE, vh - h - EDGE), ok: hole.right + GAP + w <= vw - EDGE },
      left:   { left: hole.left - GAP - w, top: clamp(cy - h / 2, EDGE, vh - h - EDGE), ok: hole.left - GAP - w >= EDGE }
    };
    var order = [pref, 'bottom', 'top', 'right', 'left'];
    for (var i = 0; i < order.length; i++) {
      var p = c[order[i]];
      if (p && p.ok) return { left: p.left, top: p.top, side: order[i] };
    }
    return { left: clamp(Math.min(hole.right, vw - EDGE) - w - GAP, EDGE, vw - w - EDGE),
             top: clamp(Math.min(hole.bottom, vh - EDGE) - h - GAP, EDGE, vh - h - EDGE), side: 'inside' };
  }
  // celular: cartão na largura da tela, preso embaixo; alvo na metade de baixo → vai p/ cima
  function placeMobile(h, hole, vw, vh) {
    var low = { left: EDGE, top: vh - h - EDGE, side: 'bottom' };
    if (!hole) return low;
    if (hole.bottom > vh - h - EDGE - 4 && hole.top >= h + 2 * EDGE) return { left: EDGE, top: EDGE, side: 'top' };
    return low;
  }
  function inNav(el) { return !!(el && el.closest && el.closest('.gnav,.gnav-mob,.gnav-rule')); }

  // ── visual ──────────────────────────────────────────────────────────────
  // Idioma da casa: MENOS efeito. O destaque é um contorno laranja fino (sem brilho) e o cartão
  // é a mesma chapa dos painéis. Contraste medido ≥4,5:1 nos dois temas (test_tour_lib.html).
  // O botão principal é preto no claro e claro no escuro: o laranja da marca com texto branco
  // rende 3,28:1, então ele fica só no contorno.
  var CSS = [
    '.ibt-ui{--ibt-veil:rgba(10,12,17,.58);--ibt-card:#FDFCFA;--ibt-line:#D6D1C9;--ibt-t:#111111;--ibt-b:#2C2C2C;--ibt-m:#6B6B6B;',
    '--ibt-btn:#111111;--ibt-btn-t:#FFFFFF;--ibt-hover:rgba(0,0,0,.05);--ibt-ok:#15803D;--ibt-ring:#FF5000;',
    'font-family:Inter,"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;text-align:left;}',
    'html.dark .ibt-ui{--ibt-veil:rgba(0,0,0,.66);--ibt-card:#161B23;--ibt-line:#2A313D;--ibt-t:#E9ECF2;--ibt-b:#C4CAD4;--ibt-m:#8A93A2;',
    '--ibt-btn:#E9ECF2;--ibt-btn-t:#0A0C11;--ibt-hover:rgba(255,255,255,.06);--ibt-ok:#22C55E;}',
    '.ibt-ui *,.ibt-ui *::before,.ibt-ui *::after{box-sizing:border-box;}',
    '.ibt-root{position:fixed;left:0;top:0;right:0;bottom:0;z-index:100000;}',
    '.ibt-block{position:fixed;left:0;top:0;right:0;bottom:0;background:transparent;}',
    '.ibt-root.ibt-center .ibt-block{background:var(--ibt-veil);}',
    '.ibt-hole{position:fixed;left:0;top:0;width:0;height:0;border-radius:10px;pointer-events:none;',
    'box-shadow:0 0 0 2px var(--ibt-ring),0 0 0 9999px var(--ibt-veil);',
    'transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease;}',
    '.ibt-root.ibt-center .ibt-hole{visibility:hidden;}',
    '.ibt-card{position:fixed;left:0;top:0;width:340px;background:var(--ibt-card);color:var(--ibt-b);border:1px solid var(--ibt-line);',
    'border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.28);padding:13px 16px 14px;outline:none;transition:left .22s ease,top .22s ease;}',
    '.ibt-root.ibt-wait .ibt-card{visibility:hidden;}',
    '.ibt-head{display:flex;align-items:center;gap:8px;min-height:22px;margin-bottom:4px;}',
    '.ibt-seg{flex:1 1 auto;min-width:0;font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--ibt-m);',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ibt-count{flex:none;font-size:10.5px;font-weight:600;color:var(--ibt-m);white-space:nowrap;font-variant-numeric:tabular-nums;}',
    '.ibt-x{flex:none;width:26px;height:26px;margin:-3px -7px -3px 0;padding:0;border:0;border-radius:7px;background:none;color:var(--ibt-m);',
    'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}',
    '.ibt-x:hover{color:var(--ibt-t);background:var(--ibt-hover);}',
    '.ibt-title{font-size:14.5px;font-weight:700;line-height:1.3;color:var(--ibt-t);margin:0 0 5px;}',
    '.ibt-body{font-size:12.5px;line-height:1.55;color:var(--ibt-b);}',
    '.ibt-body b{font-weight:600;color:var(--ibt-t);}',
    '.ibt-acts{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:13px;}',
    '.ibt-btn{font:600 12px/1 Inter,"Segoe UI",Helvetica,Arial,sans-serif;min-height:32px;padding:0 14px;border-radius:9px;',
    'border:1px solid var(--ibt-line);background:transparent;color:var(--ibt-b);cursor:pointer;white-space:nowrap;}',
    '.ibt-btn:hover{background:var(--ibt-hover);}',
    '.ibt-btn.ibt-next{background:var(--ibt-btn);border-color:var(--ibt-btn);color:var(--ibt-btn-t);}',
    '.ibt-btn.ibt-next:hover{opacity:.88;}',
    '.ibt-ui button:focus-visible{outline:2px solid var(--ibt-ring);outline-offset:2px;}',
    '.ibt-card.ibt-m{border-radius:14px;padding:14px 16px 12px;}',
    '.ibt-card.ibt-m .ibt-title{font-size:15.5px;}',
    '.ibt-card.ibt-m .ibt-body{font-size:13.5px;}',
    '.ibt-card.ibt-m .ibt-btn{min-height:44px;font-size:13.5px;padding:0 18px;}',
    '.ibt-card.ibt-m .ibt-next{flex:1 1 auto;}',
    '.ibt-card.ibt-m .ibt-x{width:40px;height:40px;margin:-10px -12px -10px 0;}',
    '@media (prefers-reduced-motion:reduce){.ibt-hole,.ibt-card{transition:none;}}'
  ].join('\n');
  var SVG_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function injectCSS() {
    if (document.getElementById('ibt-css')) return;
    var st = document.createElement('style'); st.id = 'ibt-css'; st.textContent = CSS + '\n' + CSS_PANEL;
    (document.head || document.documentElement).appendChild(st);
  }
  var ui = null;
  function ensureUI() {
    if (ui && ui.root.isConnected) return ui;
    injectCSS();
    var root = document.createElement('div');
    root.className = 'ibt-ui ibt-root ibt-center';
    root.innerHTML = '<div class="ibt-block"></div><div class="ibt-hole"></div>'
      + '<div class="ibt-card" role="dialog" aria-modal="true" aria-labelledby="ibt-title" aria-describedby="ibt-body" tabindex="-1">'
      + '<div class="ibt-head"><span class="ibt-seg"></span><span class="ibt-count"></span>'
      + '<button type="button" class="ibt-x" aria-label="Close tutorial" title="Close (Esc)">' + SVG_X + '</button></div>'
      + '<div class="ibt-title" id="ibt-title"></div><div class="ibt-body" id="ibt-body"></div>'
      + '<div class="ibt-acts"><button type="button" class="ibt-btn ibt-back">Back</button>'
      + '<button type="button" class="ibt-btn ibt-next">Next</button></div></div>';
    document.body.appendChild(root);   // no <body>, FORA do #stage (transform) — senão o fixed vira relativo a ele
    ui = { root: root, block: root.querySelector('.ibt-block'), hole: root.querySelector('.ibt-hole'), card: root.querySelector('.ibt-card') };
    ui.card.querySelector('.ibt-x').addEventListener('click', function () { stop('close'); });
    ui.card.querySelector('.ibt-back').addEventListener('click', function () { onBackBtn(); });
    ui.card.querySelector('.ibt-next').addEventListener('click', function () { next(); });
    // clique no escuro não faz nada: não chega na página e não fecha o tour sem querer
    ui.block.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    return ui;
  }
  function teardownUI() { if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root); ui = null; }

  // o = {seg, count, title, body, back (rótulo ou null), next}
  function fillCard(o) {
    var c = ui.card;
    c.querySelector('.ibt-seg').textContent = o.seg || '';
    c.querySelector('.ibt-count').textContent = o.count || '';
    c.querySelector('.ibt-title').textContent = o.title || '';
    c.querySelector('.ibt-body').innerHTML = rich(o.body || '');
    var b = c.querySelector('.ibt-back'), n = c.querySelector('.ibt-next');
    b.textContent = o.back || ''; b.style.display = o.back ? '' : 'none';
    n.textContent = o.next || 'Next';
  }
  function setBox(el, box, radius) {
    var key = [box.left, box.top, box.width, box.height, radius].map(Math.round).join(',');
    if (el.getAttribute('data-box') === key) return;   // nada mudou: não escreve (checagem roda a cada 300ms)
    el.setAttribute('data-box', key);
    el.style.left = Math.round(box.left) + 'px'; el.style.top = Math.round(box.top) + 'px';
    el.style.width = Math.round(box.width) + 'px'; el.style.height = Math.round(box.height) + 'px';
    el.style.borderRadius = radius + 'px';
  }
  // posiciona recorte + cartão; scroll=true só na entrada do passo (a checagem periódica não rola)
  function layout(scroll) {
    if (!ui) return null;
    var vw = vpW(), vh = vpH(), m = isMobile(), card = ui.card;
    card.classList.toggle('ibt-m', m);
    var w = m ? vw - 2 * EDGE : Math.min(340, vw - 2 * EDGE);
    card.style.width = w + 'px';
    var h = card.offsetHeight || 170;
    var els = (cur && cur.els) || [], hole = null;
    if (els.length) {
      if (scroll) {
        var top = (m && !inNav(els[0])) ? 64 : 8;   // no celular a barra global é sticky (52px) e cobriria o alvo
        var area = m ? { top: top, bottom: vh - h - 2 * EDGE } : { top: top, bottom: vh - 8 };
        if (area.bottom - area.top < 90) area.bottom = vh - 8;
        bringIntoView(els, area);
      }
      hole = holeBox(unionRect(els), cur.v.pad != null ? cur.v.pad : 6, vw, vh);
      setBox(ui.hole, hole, cur.v.radius != null ? cur.v.radius : 10);
    }
    ui.root.classList.toggle('ibt-center', !hole);
    var pos = !hole
      ? { left: (vw - w) / 2, top: m ? vh - h - EDGE : (vh - h) / 2, side: 'center' }
      : (m ? placeMobile(h, hole, vw, vh) : placeDesktop(w, h, hole, vw, vh, cur.v.placement));
    card.style.left = Math.round(pos.left) + 'px';
    card.style.top = Math.round(Math.max(EDGE, pos.top)) + 'px';
    card.setAttribute('data-side', pos.side);
    return { hole: hole, card: pos };
  }
  var loopT = null;
  function reposition() {
    try {
      if (!ui || !cur) return;
      if (cur.v && cur.v.target) {
        var gone = !cur.els.length || cur.els.some(function (e) { return !visible(e); });
        if (gone) cur.els = findTargets(cur.v.target, cur.v.all);   // re-render trocou o nó: procura de novo
        if (!cur.els.length) { ui.root.classList.add('ibt-center'); return; }
      }
      layout(false);
    } catch (e) {}
  }
  function startLoop() {
    stopLoop();
    loopT = setInterval(reposition, 300);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }
  function stopLoop() {
    if (loopT) { clearInterval(loopT); loopT = null; }
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  }
  // captura no document: roda antes do Esc do menu ☰ (topnav) e da página
  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop('esc'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
  }
  var keysOn = false;
  function bindKeys() { if (!keysOn) { document.addEventListener('keydown', onKey, true); keysOn = true; } }
  function unbindKeys() { if (keysOn) { document.removeEventListener('keydown', onKey, true); keysOn = false; } }
  function focusNext() { try { var n = ui && ui.card.querySelector('.ibt-next'); if (n) n.focus({ preventScroll: true }); } catch (e) {} }

  // ── corrida ─────────────────────────────────────────────────────────────
  // run = {mode:'full'|'seg', queue:[ids], si (segmento), st (passo), dir (+1/-1), preview, shown}
  // cp  = cartão especial na tela (pausa entre segmentos, fim, indisponível): {next, back, secondary}
  var run = null, F = null, active = false, cur = null, cp = null, token = 0;

  // ação antes do passo: ['fn', args…] chama window.fn · [[…],[…]] várias · ou uma função
  function doAction(a) {
    if (!a) return;
    if (typeof a === 'function') return a();
    if (Array.isArray(a) && Array.isArray(a[0])) { a.forEach(doAction); return; }
    if (Array.isArray(a) && typeof a[0] === 'string') {
      var fn = window[a[0]];
      if (typeof fn === 'function') return fn.apply(window, a.slice(1));
      env.warn('action not found:', a[0]);
    }
  }
  function safe(a, what) { try { doAction(a); } catch (e) { env.warn(what, e); } }
  function curSeg() { return run ? seg(run.queue[run.si]) : null; }
  function firstOk(s) { var st = s.steps || []; for (var i = 0; i < st.length; i++) if (stepOk(st[i], F, run.preview)) return i; return -1; }
  function lastOk(s) { var st = s.steps || []; for (var i = st.length - 1; i >= 0; i--) if (stepOk(st[i], F, run.preview)) return i; return -1; }
  function saveRun() { if (run) sset(K_RUN, run); }

  function go(afterNav) {
    var my = ++token;
    cp = null;
    if (!run) return;
    if (run.si >= run.queue.length) return showEnd();
    var s = curSeg();
    if (!s) { run.si++; run.st = 0; run.shown = 0; return go(afterNav); }
    if (!onPage(s)) {   // o segmento mora em outra página: guarda a corrida e vai até lá
      // quem retoma é a PRÓXIMA página, lendo a sessionStorage — a cópia em memória sai já,
      // senão uma navegação que não recarrega (bloqueada, ou simulada no teste) travaria o resume()
      saveRun(); run = null; stopLoop(); unbindKeys(); teardownUI(); active = false; cur = null;
      env.navigate(s.url || [].concat(s.page)[0]);
      return;
    }
    var steps = s.steps || [];
    if (run.st >= steps.length) return segmentEnd(s);
    if (run.st < 0) return segmentBack(s);
    var step = steps[run.st];
    if (!stepOk(step, F, run.preview)) { run.st += run.dir; return go(afterNav); }
    active = true; saveRun(); bindKeys();
    var v = view(step);
    ensureUI();
    safe(v.call, 'call');
    if (!v.target) { cur = { els: [], v: v }; return render(s, v); }
    ui.root.classList.add('ibt-wait'); ui.root.classList.add('ibt-center');
    return waitTargets(v, afterNav ? WAIT_NAV_MS : (v.wait || WAIT_MS)).then(function (els) {
      if (my !== token || !run) return;   // outro passo assumiu durante a espera (clique rápido)
      if (!els.length) {
        env.warn('target not found, step skipped:', s.id + '/' + (step.id || run.st), v.target);
        run.st += run.dir; return go();
      }
      cur = { els: els, v: v };
      render(s, v);
    });
  }
  function render(s, v) {
    if (!ui || !run) return;
    run.shown = (run.shown || 0) + 1;
    var total = eligible(s, F, run.preview).length, idx = 0;
    for (var k = 0; k < run.st; k++) if (stepOk(s.steps[k], F, run.preview)) idx++;
    var last = run.st >= lastOk(s);
    var canBack = run.st > firstOk(s) || (run.mode === 'full' && run.si > 0);
    fillCard({
      seg: (run.preview ? 'Preview · ' : '') + (run.mode === 'full' ? 'Full tour · ' : '') + s.title,
      count: total > 1 ? (idx + 1) + ' of ' + total : '',
      title: v.title, body: v.body,
      back: canBack ? 'Back' : null,
      next: (last && run.mode !== 'full') ? 'Done' : 'Next'
    });
    ui.root.classList.remove('ibt-wait');
    layout(true);
    startLoop();
    focusNext();
  }
  // cartão sem alvo e com botões próprios (pausa entre segmentos, fim, indisponível)
  function showCard(o, handlers) {
    ensureUI(); stopLoop();
    active = true; bindKeys();
    cur = { els: [], v: {} };
    fillCard(o);
    ui.root.classList.remove('ibt-wait');
    layout(false);
    cp = handlers;
    focusNext();
  }
  function markDone(s) { var d = lget(K_DONE) || {}; d[s.id] = env.now(); lset(K_DONE, d); }
  function segmentEnd(s) {
    safe(s.cleanup, 'cleanup');
    if (run.shown > 0) markDone(s);
    if (run.mode !== 'full') {
      if (run.shown > 0) return stop('done');
      return showCard({ seg: s.title, title: "This section isn't available right now",
        body: 'Its features are turned off for your access or still loading. Please try again later.', next: 'Close' },
        { next: function () { stop('unavailable'); } });
    }
    var j, nxt = null;
    for (j = run.si + 1; j < run.queue.length; j++) { nxt = seg(run.queue[j]); if (nxt) break; }
    if (!run.shown || !nxt) { run.si = nxt ? j : run.queue.length; run.st = 0; run.shown = 0; run.dir = 1; return go(); }
    saveRun();
    var here = run.si;
    return showCard({
      seg: 'Full tour · ' + (here + 1) + ' of ' + run.queue.length,
      title: s.title + ' — done',
      body: 'Next up: **' + nxt.title + '**' + (nxt.blurb ? ' — ' + nxt.blurb + '.' : '.'),
      back: 'Stop here', next: 'Continue'
    }, {
      next: function () { run.si = j; run.st = 0; run.shown = 0; run.dir = 1; go(); },
      back: function () { run.si = here; run.st = lastOk(s); run.shown = 0; run.dir = -1; go(); },   // ← volta ao último passo
      secondary: function () { stop('checkpoint', j); }                                              // botão "Stop here"
    });
  }
  function segmentBack(s) {
    if (run.mode === 'full' && run.si > 0) {
      safe(s.cleanup, 'cleanup');
      for (var j = run.si - 1; j >= 0; j--) {
        var p = seg(run.queue[j]);
        if (p && lastOk(p) >= 0) { run.si = j; run.st = lastOk(p); run.shown = 0; run.dir = -1; return go(); }
      }
    }
    var f = firstOk(s);
    if (f < 0) return segmentEnd(s);
    run.dir = 1; run.st = f;
    return go();
  }
  function showEnd() {
    lset(K_RESUME, null);
    return showCard({ seg: 'Full tour', title: "You're all set",
      body: 'Open **Tutorial** in the top bar anytime to replay the full tour or a single section.', next: 'Close' },
      { next: function () { stop('finish'); } });
  }
  function next() { if (!run) return; if (cp) { if (cp.next) cp.next(); return; } run.dir = 1; run.st++; go(); }
  function back() { if (!run) return; if (cp) { if (cp.back) cp.back(); return; } run.dir = -1; run.st--; go(); }
  function onBackBtn() { if (cp && cp.secondary) return cp.secondary(); back(); }

  // resumeAt: índice do segmento onde o "continue" deve recomeçar (pausa entre segmentos)
  function stop(reason, resumeAt) {
    token++;
    var s = curSeg();
    if (run && run.mode === 'full' && reason !== 'finish') {
      var si = resumeAt != null ? resumeAt : run.si;
      lset(K_RESUME, si < run.queue.length
        ? { queue: run.queue, si: si, st: resumeAt != null ? 0 : Math.max(0, run.st), at: env.now() } : null);
    }
    if (s) safe(s.cleanup, 'cleanup');
    run = null; active = false; cur = null; cp = null;
    sset(K_RUN, null);
    stopLoop(); unbindKeys(); teardownUI();
  }
  function start(what, opts) {
    opts = opts || {};
    closePanel(); hideInvite();
    if (run) stop('restart');
    return readFlags().then(function (flags) {
      F = flags;
      if (what === 'full') {
        var q = fullQueue(F);
        if (!q.length) return false;
        lset(K_RESUME, null);
        run = { mode: 'full', queue: q, si: 0, st: 0, dir: 1, preview: false, shown: 0 };
      } else {
        var s = seg(what); if (!s) return false;
        run = { mode: 'seg', queue: [what], si: 0, st: 0, dir: 1, preview: !!opts.preview || !flagOk(s, F, false), shown: 0 };
      }
      go();
      return true;
    });
  }
  function continueTour() {
    var r = lget(K_RESUME);
    if (!r || !r.queue) return start('full');
    closePanel(); hideInvite();
    if (run) stop('restart');
    return readFlags().then(function (flags) {
      F = flags;
      run = { mode: 'full', queue: r.queue, si: r.si || 0, st: r.st || 0, dir: 1, preview: false, shown: 0 };
      lset(K_RESUME, null);
      go();
      return true;
    });
  }
  // chamado pelo topnav.js ao carregar uma página com corrida em andamento
  function resume() {
    var r = sget(K_RUN);
    if (!r || !r.queue || run) return Promise.resolve(false);
    return readFlags().then(function (flags) {
      F = flags; run = r; run.shown = 0;
      var s = curSeg();
      if (s && !onPage(s)) {   // saiu por conta própria (voltar do navegador): não arrasta de volta
        if (run.mode === 'full') lset(K_RESUME, { queue: run.queue, si: run.si, st: Math.max(0, run.st), at: env.now() });
        run = null; sset(K_RUN, null);
        return false;
      }
      go(true);
      return true;
    });
  }

  // ── painel "Tutorial" e convite da 1ª visita ─────────────────────────────
  var CSS_PANEL = [
    '.ibt-panel{position:fixed;z-index:100001;width:320px;max-height:calc(100vh - 80px);overflow:auto;background:var(--ibt-card);',
    'color:var(--ibt-b);border:1px solid var(--ibt-line);border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.24);padding:8px;}',
    '.ibt-panel.ibt-m{left:0!important;right:0;bottom:0;top:auto!important;width:auto;max-height:82vh;border-radius:14px 14px 0 0;',
    'padding:10px 10px calc(14px + env(safe-area-inset-bottom));}',
    '.ibt-shade{position:fixed;left:0;top:0;right:0;bottom:0;z-index:100000;background:rgba(0,0,0,.45);}',
    '.ibt-p-head{display:flex;align-items:center;gap:8px;padding:6px 6px 8px 8px;}',
    '.ibt-p-t{font-size:13px;font-weight:700;color:var(--ibt-t);}',
    '.ibt-p-s{flex:1 1 auto;min-width:0;font-size:11px;color:var(--ibt-m);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ibt-opt{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid var(--ibt-line);',
    'border-radius:10px;padding:9px 11px;margin:0 0 6px;cursor:pointer;}',
    '.ibt-opt:hover{background:var(--ibt-hover);}',
    '.ibt-opt-t{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:var(--ibt-t);}',
    '.ibt-opt-t svg{flex:none;color:var(--ibt-ring);}',
    '.ibt-opt-d{display:block;font-size:11px;color:var(--ibt-m);margin-top:3px;}',
    '.ibt-cat{font-size:9px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--ibt-m);padding:10px 8px 4px;}',
    '.ibt-row{display:grid;grid-template-columns:minmax(0,1fr) auto 18px;column-gap:10px;align-items:center;width:100%;text-align:left;',
    'font:inherit;color:inherit;background:none;border:0;border-radius:9px;padding:8px;cursor:pointer;}',
    '.ibt-row:hover{background:var(--ibt-hover);}',
    '.ibt-row-t{grid-column:1;font-size:12.5px;font-weight:600;color:var(--ibt-t);}',
    '.ibt-row-d{grid-column:1;font-size:11px;color:var(--ibt-m);margin-top:2px;}',
    '.ibt-row-n{grid-column:2;grid-row:1 / span 2;font-size:10.5px;color:var(--ibt-m);white-space:nowrap;}',
    '.ibt-row-k{grid-column:3;grid-row:1 / span 2;display:flex;color:var(--ibt-ok);}',
    '.ibt-off{font-style:normal;font-size:8.5px;font-weight:700;letter-spacing:.03em;color:#fff;background:#FF5000;border-radius:5px;',
    'padding:2px 5px;margin-left:6px;vertical-align:1px;}',
    '.ibt-p-foot{display:flex;justify-content:flex-end;border-top:1px solid var(--ibt-line);margin-top:6px;padding:6px 6px 0;}',
    '.ibt-link{font:inherit;font-size:11px;color:var(--ibt-m);background:none;border:0;padding:4px 2px;cursor:pointer;',
    'text-decoration:underline;text-underline-offset:2px;}',
    '.ibt-link:hover{color:var(--ibt-t);}',
    '.ibt-panel.ibt-m .ibt-row{padding:11px 8px;}',
    '.ibt-panel.ibt-m .ibt-opt{padding:12px;}',
    '.ibt-invite{position:fixed;z-index:100001;right:20px;bottom:20px;width:300px;background:var(--ibt-card);color:var(--ibt-b);',
    'border:1px solid var(--ibt-line);border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.24);padding:14px 16px;}',
    '.ibt-invite.ibt-m{left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));width:auto;}',
    '.ibt-invite.ibt-m .ibt-btn{min-height:44px;font-size:13.5px;flex:1 1 0;}'
  ].join('\n');
  var SVG_PLAY = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>';
  var SVG_OK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var panel = null, shade = null, panelAnchor = null, invite = null;

  function panelHTML(Fl) {
    var done = lget(K_DONE) || {}, res = lget(K_RESUME), total = 0;
    var rows = (content().order || []).map(function (id) {
      var s = seg(id); if (!s) return '';
      var on = flagOk(s, Fl, false);
      if (!on && !Fl.admin) return '';          // cliente: segmento desligado nem aparece
      var n = eligible(s, Fl, !on).length;
      if (!n) return '';
      if (on) total += n;
      return '<button type="button" class="ibt-row" data-seg="' + esc(s.id) + '"' + (on ? '' : ' data-preview="1"') + '>'
        + '<span class="ibt-row-t">' + esc(s.title) + (on ? '' : '<em class="ibt-off">OFF · só admin</em>') + '</span>'
        + '<span class="ibt-row-d">' + esc(s.blurb || '') + '</span>'
        + '<span class="ibt-row-n">' + n + (n === 1 ? ' step' : ' steps') + '</span>'
        + '<span class="ibt-row-k"' + (done[s.id] ? ' title="Completed"' : '') + '>' + (done[s.id] ? SVG_OK : '') + '</span></button>';
    }).join('');
    var h = '<div class="ibt-p-head"><span class="ibt-p-t">Tutorial</span><span class="ibt-p-s">Guided tours of the dashboard</span>'
      + '<button type="button" class="ibt-x" data-a="close" aria-label="Close">' + SVG_X + '</button></div>'
      + '<button type="button" class="ibt-opt" data-a="full"><span class="ibt-opt-t">' + SVG_PLAY + 'Full tour</span>'
      + '<span class="ibt-opt-d">Every section, page by page · ' + total + ' steps</span></button>';
    var rs = res && res.queue && seg(res.queue[res.si]);
    if (rs) h += '<button type="button" class="ibt-opt" data-a="continue"><span class="ibt-opt-t">Continue where you left off</span>'
      + '<span class="ibt-opt-d">' + esc(rs.title) + '</span></button>';
    return h + '<div class="ibt-cat">By section</div>' + rows
      + '<div class="ibt-p-foot"><button type="button" class="ibt-link" data-a="reset">Reset progress</button></div>';
  }
  function openPanel(anchor) {
    hideInvite();
    if (panel) { closePanel(); return Promise.resolve(false); }   // 2º clique no botão fecha
    injectCSS();
    panelAnchor = (anchor && anchor.nodeType === 1) ? anchor : document.getElementById('gnav-tutorial');
    drawPanel(cachedFlags() || recadoFlags());                     // abre NA HORA; as flags frescas redesenham
    return readFlags().then(function (f) { if (panel) drawPanel(f); return true; });
  }
  function drawPanel(Fl) {
    var m = isMobile();
    if (!panel) {
      if (m) { shade = document.createElement('div'); shade.className = 'ibt-ui ibt-shade'; shade.addEventListener('click', closePanel); document.body.appendChild(shade); }
      panel = document.createElement('div');
      panel.className = 'ibt-ui ibt-panel';
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Tutorial');
      panel.addEventListener('click', onPanelClick);
      document.body.appendChild(panel);
      setTimeout(function () {
        document.addEventListener('mousedown', onOutside, true);
        document.addEventListener('keydown', onPanelKey, true);
      }, 0);
      window.addEventListener('resize', placePanel);
    }
    panel.classList.toggle('ibt-m', m);
    panel.innerHTML = panelHTML(Fl);
    placePanel();
  }
  function placePanel() {
    if (!panel) return;
    if (isMobile()) { panel.style.left = ''; panel.style.top = ''; return; }
    var vw = vpW(), w = panel.offsetWidth || 320;
    var r = (panelAnchor && visible(panelAnchor)) ? panelAnchor.getBoundingClientRect() : null;
    panel.style.left = Math.round(clamp(r ? r.right - w : vw - w - 16, EDGE, vw - w - EDGE)) + 'px';
    panel.style.top = Math.round(r ? r.bottom + 8 : 62) + 'px';
  }
  function onPanelClick(e) {
    var t = e.target.closest ? e.target.closest('[data-a],[data-seg]') : null;
    if (!t) return;
    var a = t.getAttribute('data-a');
    if (a === 'close') return closePanel();
    if (a === 'full') return start('full');
    if (a === 'continue') return continueTour();
    if (a === 'reset') {   // zera ✓, "continue" e o convite (o admin usa p/ rever a 1ª visita)
      lset(K_DONE, null); lset(K_RESUME, null); lset(K_SEEN, null);
      return drawPanel(cachedFlags() || recadoFlags());
    }
    var id = t.getAttribute('data-seg');
    if (id) return start(id, { preview: t.getAttribute('data-preview') === '1' });
  }
  function onOutside(e) {
    if (!panel) return;
    var t = e.target;
    if (panel.contains(t) || (panelAnchor && panelAnchor.contains && panelAnchor.contains(t))) return;
    closePanel();
  }
  function onPanelKey(e) { if (e.key === 'Escape' && panel) { e.stopPropagation(); closePanel(); } }
  function closePanel() {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onPanelKey, true);
    window.removeEventListener('resize', placePanel);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    if (shade && shade.parentNode) shade.parentNode.removeChild(shade);
    panel = null; shade = null;
  }
  // convite discreto: só na Home, uma vez por navegador, nunca por cima de um tour
  function maybeInvite() {
    if (invite || active || sget(K_RUN) || lget(K_SEEN)) return false;
    if (normPath(location.href) !== '/index.html') return false;
    injectCSS();
    invite = document.createElement('div');
    invite.className = 'ibt-ui ibt-invite' + (isMobile() ? ' ibt-m' : '');
    invite.setAttribute('role', 'dialog'); invite.setAttribute('aria-label', 'Take a tour');
    invite.innerHTML = '<div class="ibt-title">New here?</div>'
      + '<div class="ibt-body">Take a quick tour of the main features. You can replay it anytime from <b>Tutorial</b> in the top bar.</div>'
      + '<div class="ibt-acts"><button type="button" class="ibt-btn" data-a="later">Not now</button>'
      + '<button type="button" class="ibt-btn ibt-next" data-a="start">Start tour</button></div>';
    invite.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-a]') : null;
      if (!b) return;
      lset(K_SEEN, 1);
      var startIt = b.getAttribute('data-a') === 'start';
      hideInvite();
      if (startIt) start('full');
    });
    document.body.appendChild(invite);
    return true;
  }
  function hideInvite() { if (invite && invite.parentNode) invite.parentNode.removeChild(invite); invite = null; }

  window.IBBATour = {
    version: 1,
    openPanel: openPanel, closePanel: closePanel,
    start: start, continueTour: continueTour, resume: resume,
    stop: function () { if (run) stop('api'); },
    next: next, back: back,
    maybeInvite: maybeInvite, hideInvite: hideInvite,
    isActive: function () { return active; },
    // só p/ tests/test_tour_lib.html — as páginas não usam
    _t: {
      env: env, K: { RUN: K_RUN, RESUME: K_RESUME, DONE: K_DONE, SEEN: K_SEEN, FLAGS: K_FLAGS },
      normPath: normPath, onPage: onPage, visible: visible, findTargets: findTargets, unionRect: unionRect,
      holeBox: holeBox, placeDesktop: placeDesktop, placeMobile: placeMobile, bringIntoView: bringIntoView,
      flagOk: flagOk, eligible: eligible, fullQueue: fullQueue, view: view, rich: rich, recadoFlags: recadoFlags,
      state: function () { return { run: run, active: active, cur: cur, cp: cp, ui: ui, panel: panel, invite: invite }; }
    }
  };
})();
