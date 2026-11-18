/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   IBBA · A ILHA (nov/2026) — a barra superior vira uma ilha que só se abre quando é chamada
   ───────────────────────────────────────────────────────────────────────────────────────────────
   Pedido do usuário (18/11), sobre a opção "B · Ilha": (1) que ela não fique 100% do tempo à vista,
   para ganhar espaço; (2) analistas, tutorial, tema e sair continuam à vista; (3) uma busca
   "extremamente inteligente", com escopos que levam a partes específicas da dashboard; (4) mesmo
   escondida, tem de ser muito fácil achar a ilha.

   Como ficou (só computador, ≥901px; no celular segue a barra com ☰ de sempre):
     · a faixa preta de 56px vira uma faixa transparente de 44px;
     · no centro, a ILHA RECOLHIDA: "● página atual ▾  |  🔍 Search  Ctrl K" — pequena, sempre no mesmo
       lugar. Passar o mouse (ou Tab, ou clique) ABRE a ilha com o menu inteiro; sair, ela recolhe;
     · à direita, a pílula de utilidades (time, tutorial, tema, sair) — sempre à vista;
     · rolando a página, a ilha fica presa no topo, mas SAI DA FRENTE enquanto se desce (não tapa
       tabela/manchete/barra presa) e deixa só uma LINGUETA laranja no centro do topo; ela volta ao
       subir a página, ao levar o mouse à lingueta, com Tab ou Ctrl K;
     · Ctrl K (ou ⌘K, ou "/") abre a BUSCA de qualquer lugar: páginas e abas, as 20 empresas cobertas
       (com logo e a variação do dia), commodities, notícias, relatórios e eventos, cada uma levando
       para o lugar certo. Escopos: chips no topo, Tab troca, e atalhos @ $ # /.
   NADA do topnav.js muda: os mesmos elementos (com os mesmos ids — tutorial, flags e admin seguem
   funcionando) são só reorganizados dentro da ilha e da pílula.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var root = document.documentElement;
  if (window.__ibbaIsland || !root.getAttribute('data-pg')) return;
  window.__ibbaIsland = true;
  root.classList.add('isl-on');

  var CSS = '\
@media (min-width:901px){\
html.isl-on .gnav{background:transparent!important;height:44px;padding:0 16px;gap:0;box-shadow:none!important;border:0!important;z-index:900;}\
html.isl-on .gnav-rule{height:0!important;box-shadow:none!important;}\
html.isl-on .gn-ind{display:none!important;}\
html.isl-on .gnav-brand{position:relative;z-index:2;}\
html.isl-on .gnav-brand .gnav-mark{width:22px;height:22px;border-radius:6px;}\
html.isl-on .gnav-brand b{font:600 11.5px/1 "Unbounded","Manrope",sans-serif!important;letter-spacing:-.005em;color:#0A0A0B!important;}\
html.isl-on.dark .gnav-brand b,html.isl-on[data-pg="market"] body:not(.theme-light) .gnav-brand b{color:#F4F4F2!important;}\
/* a ILHA */\
.isl{position:absolute;left:50%;top:5px;transform:translateX(-50%);height:34px;display:flex;align-items:center;padding:3px;border-radius:999px;z-index:3;\
  background:rgba(16,16,18,.94);border:1px solid rgba(255,255,255,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 10px 26px -12px rgba(0,0,0,.65);\
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);font-family:"Manrope","Inter",system-ui,sans-serif;white-space:nowrap;}\
html.isl-float .isl{position:fixed;top:8px;transition:transform .4s cubic-bezier(.16,1,.3,1),opacity .25s ease;}\
html.isl-float.isl-away .isl:not(.open):not(.pin){transform:translate(-50%,-64px);opacity:0;pointer-events:none;}\
/* descendo a página a ilha sai da frente do conteúdo; fica só esta LINGUETA laranja no topo, no centro */\
.isl-notch{display:block;position:fixed;left:50%;top:0;z-index:899;width:150px;height:18px;transform:translate(-50%,-100%);opacity:0;cursor:pointer;border:0;padding:0;background:none;\
  transition:transform .35s cubic-bezier(.16,1,.3,1),opacity .2s ease;}\
.isl-notch::before{content:"";position:absolute;left:50%;top:0;width:58px;height:5px;transform:translateX(-50%);border-radius:0 0 6px 6px;background:#FF5500;\
  box-shadow:0 2px 12px rgba(255,85,0,.55);transition:width .25s cubic-bezier(.16,1,.3,1),height .25s;}\
.isl-notch:hover::before{width:84px;height:7px;}\
html.isl-float.isl-away .isl-notch{transform:translate(-50%,0);opacity:1;}\
.isl-notch span{position:absolute;left:50%;top:11px;transform:translate(-50%,-4px);opacity:0;white-space:nowrap;pointer-events:none;font:600 10.5px/1 "Manrope","Inter",sans-serif;\
  color:#EDEDEA;background:rgba(16,16,18,.92);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:5px 10px;box-shadow:0 8px 20px -10px #000;transition:opacity .25s,transform .35s cubic-bezier(.16,1,.3,1);}\
.isl-notch.hint span{opacity:1;transform:translate(-50%,0);}\
.isl-now,.isl-q{display:flex;align-items:center;gap:7px;height:28px;border-radius:999px;background:none;border:0;color:#EDEDEA;cursor:pointer;font:600 12px/1 "Manrope","Inter",sans-serif;\
  overflow:hidden;max-width:340px;transition:max-width .42s cubic-bezier(.16,1,.3,1),opacity .2s ease,padding .42s cubic-bezier(.16,1,.3,1),background .15s;padding:0 12px 0 10px;}\
.isl-now:hover,.isl-q:hover{background:rgba(255,255,255,.07);}\
.isl-now i{width:7px;height:7px;border-radius:50%;background:#FF5500;flex:none;box-shadow:0 0 0 0 rgba(255,85,0,.55);animation:isl-pulso 2.8s ease-out infinite;}\
@keyframes isl-pulso{0%{box-shadow:0 0 0 0 rgba(255,85,0,.55);}70%,100%{box-shadow:0 0 0 7px rgba(255,85,0,0);}}\
.isl-now em{font-style:normal;color:rgba(255,255,255,.45);font-weight:500;}\
.isl-now .cv{font-size:8px;opacity:.6;margin-left:1px;}\
.isl-sep{width:1px;height:16px;background:rgba(255,255,255,.14);flex:none;transition:opacity .2s;}\
.isl-q{color:rgba(255,255,255,.62);font-weight:500;}\
.isl-q svg{width:14px;height:14px;flex:none;}\
.isl-q kbd{font:600 9.5px/1 "Manrope",sans-serif;color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.18);border-radius:5px;padding:3px 5px;margin-left:4px;}\
/* o menu de sempre, DENTRO da ilha: fechado ele tem largura zero */\
html.isl-on .isl .gnav-menu{margin:0;max-width:0;opacity:0;overflow:hidden;gap:1px;transition:max-width .45s cubic-bezier(.16,1,.3,1),opacity .22s ease;}\
html.isl-on .isl.open .gnav-menu{max-width:1200px;opacity:1;}\
html.isl-on .isl.full .gnav-menu{overflow:visible;}\
.isl.open .isl-now{max-width:0;opacity:0;padding:0;}\
.isl.open .isl-sep{opacity:0;}\
.isl.open .isl-q{padding:0 9px;}\
.isl.open .isl-q .isl-ql,.isl.open .isl-q kbd{display:none;}\
html.isl-on .isl .gn-item{position:relative;z-index:1;height:28px;padding:0 13px!important;border-radius:999px;font:600 12px/1 "Manrope","Inter",sans-serif!important;\
  color:rgba(255,255,255,.64)!important;background:none!important;letter-spacing:0!important;transition:color .25s;}\
html.isl-on .isl .gn-item:hover{color:#fff!important;}\
html.isl-on .isl .gn-item::after{display:none!important;}\
html.isl-on .isl .gn-item.k{color:#0A0A0B!important;}\
html.isl-on .isl .gn-admin{color:#FF7A33!important;margin-left:0;}\
html.isl-on .isl .gn-admin.k{color:#C2410C!important;}\
.isl-key{position:absolute;top:0;height:28px;border-radius:999px;background:#F4F4F2;box-shadow:0 2px 8px -2px rgba(0,0,0,.5);z-index:0;opacity:0;\
  transition:left .42s cubic-bezier(.16,1,.3,1),width .42s cubic-bezier(.16,1,.3,1),opacity .2s;}\
.isl.full .isl-key{opacity:1;}\
/* os menus: escuros e sólidos, embaixo da ilha */\
html.isl-on .isl .gn-drop{top:calc(100% + 9px);min-width:230px;padding:7px;background:#141416!important;border:1px solid #29292D!important;border-radius:16px;\
  box-shadow:0 26px 50px -18px #000,0 0 0 1px rgba(0,0,0,.35)!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;}\
html.isl-on .isl .gn-drop::before{top:-12px;height:12px;}\
html.isl-on .isl .gn-cat{font:500 8.5px/1 "Unbounded","Manrope",sans-serif!important;letter-spacing:.12em;text-transform:uppercase;color:#FF7A33!important;padding:8px 11px 7px!important;}\
html.isl-on .isl .gn-drop a{display:block;color:#EDEDEA!important;font:600 12px/1.2 "Manrope",sans-serif!important;padding:9px 11px!important;border-radius:10px;background:none!important;}\
html.isl-on .isl .gn-drop a:hover{background:rgba(255,255,255,.06)!important;color:#FF8A4D!important;}\
html.isl-on .isl .gn-drop a.on{background:rgba(255,85,0,.14)!important;color:#FF8A4D!important;}\
html.isl-on .isl .gn-drop a.gn-item{height:auto;width:100%;justify-content:flex-start;}\
/* a pílula de UTILIDADES (sempre à vista) */\
.isl-util{margin-left:auto;position:relative;z-index:2;display:flex;align-items:center;gap:2px;height:34px;padding:3px 4px 3px 6px;border-radius:999px;\
  background:rgba(16,16,18,.94);border:1px solid rgba(255,255,255,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 10px 26px -12px rgba(0,0,0,.6);}\
html.isl-on .isl-util .gnav-team{margin:0 4px 0 0;gap:0;}\
html.isl-on .isl-util .gnt-name{display:none!important;}\
html.isl-on .isl-util .gnt-stack{padding:0 2px;}\
html.isl-on .isl-util .gnt-av{width:22px;height:22px;}\
html.isl-on .isl-util .gnav-tut,html.isl-on .isl-util .gnav-theme,html.isl-on .isl-util .gnav-out{width:28px!important;height:28px!important;padding:0!important;margin:0!important;border:0!important;\
  border-radius:999px!important;background:none!important;display:inline-flex;align-items:center;justify-content:center;color:rgba(255,255,255,.62)!important;}\
html.isl-on .isl-util .gnav-tut:hover,html.isl-on .isl-util .gnav-theme:hover,html.isl-on .isl-util .gnav-out:hover{background:rgba(255,255,255,.08)!important;color:#fff!important;}\
html.isl-on .isl-util .gnav-tut-l{display:none!important;}\
html.isl-on .isl-util .gnav-tut svg,html.isl-on .isl-util .gnav-out svg{width:15px;height:15px;display:block;}\
html.isl-on .isl-util .gnav-tut[style*="none"]{display:none!important;}\
.isl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}\
/* Home: a tela ganha os pixels que a faixa devolveu */\
html.isl-on[data-pg="home"] #stage{height:calc((100vh - 50px) / var(--app-scale,1));margin-top:6px;}\
}\
@media (max-width:900px){ .isl{display:contents;} .isl-now,.isl-q,.isl-sep,.isl-key,.isl-notch{display:none!important;} .isl-util{display:contents;} }\
/* ═══ a BUSCA ═══ */\
.isp{position:fixed;inset:0;z-index:2600;display:none;align-items:flex-start;justify-content:center;padding-top:9vh;background:rgba(5,5,6,.48);\
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);font-family:"Manrope","Inter",system-ui,sans-serif;}\
.isp.open{display:flex;animation:isp-in .18s ease both;}\
@keyframes isp-in{from{opacity:0;}}\
.isp-box{width:min(680px,calc(100vw - 32px));max-height:min(74vh,640px);display:flex;flex-direction:column;background:#121214;border:1px solid #2A2A2E;border-radius:18px;\
  box-shadow:0 40px 90px -30px #000,0 0 0 1px rgba(0,0,0,.4);overflow:hidden;color:#EDEDEA;animation:isp-sobe .32s cubic-bezier(.16,1,.3,1) both;}\
@keyframes isp-sobe{from{transform:translateY(-10px) scale(.985);}}\
.isp-in{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;}\
.isp-in svg{width:17px;height:17px;color:#7c7c78;flex:none;}\
.isp-in input{flex:1;min-width:0;background:none;border:0;outline:0;color:#fff;font:500 16px/1.2 "Manrope",sans-serif;caret-color:#FF5500;}\
.isp-in input::placeholder{color:#6f6f6b;}\
.isp-x{border:1px solid rgba(255,255,255,.14);background:none;color:#8e8e8a;border-radius:6px;font:600 10px/1 "Manrope",sans-serif;padding:4px 6px;cursor:pointer;}\
.isp-sc{display:flex;gap:4px;padding:0 14px 10px;flex-wrap:wrap;border-bottom:1px solid #26262a;}\
.isp-sc button{border:1px solid rgba(255,255,255,.10);background:none;color:#a5a5a2;border-radius:999px;font:600 11px/1 "Manrope",sans-serif;padding:6px 10px;cursor:pointer;\
  display:inline-flex;align-items:center;gap:5px;transition:background .15s,color .15s,border-color .15s;}\
.isp-sc button b{font-weight:700;color:#6f6f6b;font-size:10px;}\
.isp-sc button:hover{color:#fff;border-color:rgba(255,255,255,.25);}\
.isp-sc button.on{background:#F4F4F2;color:#0A0A0B;border-color:#F4F4F2;}\
.isp-sc button.on b{color:#7a7a76;}\
.isp-r{overflow:auto;padding:6px 8px 8px;}\
.isp-g{font:500 8.5px/1 "Unbounded","Manrope",sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7c7c78;padding:12px 10px 6px;display:flex;justify-content:space-between;}\
.isp-g a{color:#FF7A33;letter-spacing:.04em;text-transform:none;font:600 10.5px/1 "Manrope",sans-serif;text-decoration:none;cursor:pointer;}\
.isp-row{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:10px;cursor:pointer;color:#EDEDEA;text-decoration:none;min-height:40px;}\
.isp-row.sel{background:rgba(255,85,0,.13);}\
.isp-ic{width:26px;height:26px;border-radius:7px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;color:#a5a5a2;flex:none;font:700 10px/1 "Manrope",sans-serif;}\
.isp-ic svg{width:14px;height:14px;}\
.isp-ic img{width:22px;height:20px;object-fit:contain;}\
.isp-ic.logo{background:none;}\
.isp-ic.d{flex-direction:column;gap:1px;font-size:8px;color:#FF8A4D;background:rgba(255,85,0,.10);}\
.isp-ic.d b{font-size:11px;color:#EDEDEA;}\
.isp-t{flex:1;min-width:0;}\
.isp-t b{display:block;font:600 13px/1.25 "Manrope",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\
.isp-t small{display:block;margin-top:2px;font-size:11px;color:#7c7c78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\
.isp-t mark{background:none;color:#FF8A4D;}\
.isp-v{font:700 12px/1 "Manrope",sans-serif;white-space:nowrap;color:#a5a5a2;}\
.isp-v.up{color:#2fbf71;}.isp-v.dn{color:#ff5d5d;}\
.isp-acts{display:none;gap:4px;}\
.isp-row.sel .isp-acts{display:flex;}\
.isp-row.sel .isp-v{display:none;}\
.isp-acts span{font:600 10.5px/1 "Manrope",sans-serif;color:#EDEDEA;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:5px 9px;}\
.isp-acts span:hover{border-color:#FF7A33;color:#FF8A4D;}\
.isp-tk{width:7px;height:7px;border-radius:50%;background:#6f6f6b;}\
.isp-tk.pos{background:#2fbf71;}.isp-tk.neg{background:#ff5d5d;}.isp-tk.neu{background:#a5a5a2;}\
.isp-e{padding:22px 12px;color:#7c7c78;font-size:12.5px;text-align:center;}\
.isp-ft{display:flex;gap:16px;flex-wrap:wrap;padding:9px 16px;border-top:1px solid #26262a;font-size:10.5px;color:#7c7c78;}\
.isp-ft b{color:#a5a5a2;font-weight:700;}\
@media (prefers-reduced-motion:reduce){.isl,.isl *,.isp,.isp *{animation:none!important;transition:none!important;}}';
  (function () { var s = document.createElement('style'); s.id = 'ibba-island-css'; s.textContent = CSS; (document.head || root).appendChild(s); })();

  var SVG_Q = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  var SVG_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';
  var SVG_PG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M7 15l3-4 3 2 4-6"/></svg>';
  var SVG_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
  var SVG_CM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>';
  var NAMES = { 'gnav-mm': 'Metals & Mining', 'gnav-pp': 'Pulp & Paper', 'gnav-sg': 'Stock Guide', 'gnav-market': 'Market' };
  var PAGE_NAMES = { '/market-watch.html': 'Market Watch', '/quarterly.html': 'Quarterly', '/data.html': 'Data', '/agenda.html': 'Calendar' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function txt(el) { return el ? String(el.textContent || '').replace(/▾/g, '').replace(/\s+/g, ' ').trim() : ''; }
  function desktop() { return window.innerWidth > 900; }

  /* ═══ 1. A ILHA ════════════════════════════════════════════════════════════════════════════ */
  var isl, menu, key, now, util;
  function build(g) {
    if (g.querySelector('.isl')) return;
    menu = g.querySelector('.gnav-menu'); if (!menu) return;
    isl = document.createElement('div'); isl.className = 'isl'; isl.setAttribute('role', 'navigation'); isl.setAttribute('aria-label', 'Dashboard');
    now = document.createElement('button'); now.type = 'button'; now.className = 'isl-now'; now.setAttribute('aria-label', 'Open the menu');
    var sep = document.createElement('span'); sep.className = 'isl-sep';
    var q = document.createElement('button'); q.type = 'button'; q.className = 'isl-q'; q.title = 'Search pages, companies, commodities, news… (Ctrl K)';
    q.innerHTML = SVG_Q + '<span class="isl-ql">Search</span><kbd>' + (/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K') + '</kbd>';
    g.insertBefore(isl, menu);
    isl.appendChild(now); isl.appendChild(menu); isl.appendChild(sep); isl.appendChild(q);
    key = document.createElement('span'); key.className = 'isl-key'; menu.insertBefore(key, menu.firstChild);
    // as páginas internas (só admin) num menu só: "Internal ▾"
    var adm = [].slice.call(menu.querySelectorAll('a.gn-admin'));
    if (adm.length) {
      var grp = document.createElement('div'); grp.className = 'gn-group'; grp.id = 'gnav-int';
      grp.innerHTML = '<span class="gn-item gn-admin">Internal ▾</span><div class="gn-drop"><div class="gn-cat">Internal · admin only</div></div>';
      menu.insertBefore(grp, adm[0]); var dd = grp.querySelector('.gn-drop');
      adm.forEach(function (a) { dd.appendChild(a); });
      var syncInt = function () { grp.style.display = adm.some(function (a) { return a.style.display !== 'none'; }) ? '' : 'none'; };
      syncInt(); try { new MutationObserver(syncInt).observe(dd, { attributes: true, subtree: true, attributeFilter: ['style'] }); } catch (e) {}
      grp.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('.gn-drop a')) grp.classList.add('gn-shut'); });
      grp.addEventListener('mouseleave', function () { grp.classList.remove('gn-shut'); });
    }
    // a pílula de utilidades: time, tutorial, tema, sair (os mesmos botões, com os mesmos ids)
    util = document.createElement('div'); util.className = 'isl-util';
    ['#gnav-team', '#gnav-tutorial', '#gnav-theme', '.gnav-out'].forEach(function (s) { var el = g.querySelector(s); if (el) util.appendChild(el); });
    var burger = g.querySelector('#gnav-burger'); g.insertBefore(util, burger || null);
    var out = util.querySelector('.gnav-out'); if (out) { out.innerHTML = SVG_OUT + '<span class="isl-sr">Sign out</span>'; out.title = 'Sign out'; out.setAttribute('aria-label', 'Sign out'); }
    // abrir/fechar
    var tOpen = 0, tClose = 0;
    isl.addEventListener('mouseenter', function () { clearTimeout(tClose); tOpen = setTimeout(function () { open(true); }, 70); });
    isl.addEventListener('mouseleave', function () { clearTimeout(tOpen); tClose = setTimeout(function () { if (!isl.contains(document.activeElement)) open(false); }, 420); });
    isl.addEventListener('focusin', function () { clearTimeout(tClose); open(true); });
    isl.addEventListener('focusout', function () { setTimeout(function () { if (!isl.contains(document.activeElement) && !isl.matches(':hover')) open(false); }, 60); });
    now.addEventListener('click', function () { open(!isl.classList.contains('open')); });
    q.addEventListener('click', function (e) { e.preventDefault(); palette(true); });
    // a "tecla" branca corre até o item sob o mouse e volta para a página atual
    [].slice.call(menu.children).forEach(function (c) {
      var it = c.classList && c.classList.contains('gn-item') ? c : (c.querySelector && c.querySelector(':scope > .gn-item'));
      if (it) c.addEventListener('mouseenter', function () { place(it); });
    });
    menu.addEventListener('mouseleave', function () { place(null); });
    label();
    var mk = window.__gnavMarkCurrent; window.__gnavMarkCurrent = function () { if (mk) mk(); label(); place(null); };
    window.addEventListener('hashchange', function () { setTimeout(function () { label(); place(null); }, 0); });
    // o tutorial aponta para os itens do menu: enquanto ele roda, a ilha fica aberta
    try {
      new MutationObserver(function () { var on = !!document.querySelector('.ibt-root'); isl.classList.toggle('pin', on); if (on) open(true); else if (!isl.matches(':hover')) open(false); })
        .observe(document.body, { childList: true });
    } catch (e) {}
    // Rolando a página: a ilha recolhida fica presa no topo, mas SAI DA FRENTE enquanto se desce (lendo) e
    // VOLTA ao subir, ao levar o mouse à lingueta laranja do topo, com Tab ou Ctrl K. Parada, ela some de
    // novo em 2,5 s (sem o mouse em cima) — assim não tapa tabela, manchete nem barra presa da página.
    var notch = document.createElement('button'); notch.type = 'button'; notch.className = 'isl-notch';
    var kk = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K';
    notch.title = 'Menu & search (or press ' + kk + ')'; notch.setAttribute('aria-label', 'Show the menu');
    notch.innerHTML = '<span>Menu · ' + kk + '</span>';
    document.body.appendChild(notch);
    var ticking = false, lastY = window.scrollY || 0, tAway = 0, tHint = 0, hinted = false;
    function hint() {   // as 3 primeiras vezes (por navegador) a lingueta diz o que é
      if (hinted) return; hinted = true;
      var n = 0; try { n = +localStorage.getItem('ibba_isl_hint') || 0; } catch (e) {}
      if (n >= 3) return;
      try { localStorage.setItem('ibba_isl_hint', String(n + 1)); } catch (e) {}
      notch.classList.add('hint'); clearTimeout(tHint); tHint = setTimeout(function () { notch.classList.remove('hint'); }, 3200);
    }
    function away(on) {
      clearTimeout(tAway);
      if (on && !root.classList.contains('isl-away')) hint();
      root.classList.toggle('isl-away', !!on);
      if (!on && root.classList.contains('isl-float')) tAway = setTimeout(function () {
        if (!isl.matches(':hover') && !isl.contains(document.activeElement) && !isl.classList.contains('open')) root.classList.add('isl-away');
      }, 2500);
    }
    function show() { if (root.classList.contains('isl-away')) away(false); }
    notch.addEventListener('mouseenter', show);
    notch.addEventListener('click', function () { away(false); open(true); });
    isl.addEventListener('focusin', show);
    isl.addEventListener('mouseleave', function () { if (root.classList.contains('isl-float')) away(false); });
    document.addEventListener('mousemove', function (e) {   // mouse encostado no topo, perto do centro
      if (e.clientY < 14 && Math.abs(e.clientX - window.innerWidth / 2) < 240 && root.classList.contains('isl-away')) away(false);
    }, { passive: true });
    window.addEventListener('scroll', function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var y = window.scrollY || 0, dy = y - lastY, fl = desktop() && y > 70;
        root.classList.toggle('isl-float', fl);
        if (!fl) { clearTimeout(tAway); root.classList.remove('isl-away'); }
        else if (dy > 4 && !isl.classList.contains('open')) away(true);
        else if (dy < -4) away(false);
        lastY = y;
      });
    }, { passive: true });
  }
  var tFull = 0;
  function open(on) {
    if (!isl || (!on && isl.classList.contains('pin'))) return;
    clearTimeout(tFull);
    if (on) {
      if (isl.classList.contains('open')) return;
      isl.classList.add('open'); now.setAttribute('aria-expanded', 'true');
      tFull = setTimeout(function () { isl.classList.add('full'); place(null); }, 300);   // o menu terminou de abrir: os ▾ podem descer
    } else {
      isl.classList.remove('full', 'open'); now.setAttribute('aria-expanded', 'false');
      [].slice.call(isl.querySelectorAll('.gn-item.k')).forEach(function (x) { x.classList.remove('k'); });
    }
  }
  function cur() { return menu.querySelector('.gn-group > .gn-item.on') || menu.querySelector('a.gn-item.on'); }
  function place(it) {
    if (!key || !isl.classList.contains('full')) return;
    it = it || cur();
    [].slice.call(menu.querySelectorAll('.gn-item.k')).forEach(function (x) { if (x !== it) x.classList.remove('k'); });
    if (!it) { key.style.opacity = '0'; return; }
    key.style.opacity = '';
    var m = menu.getBoundingClientRect(), r = it.getBoundingClientRect();
    key.style.left = (r.left - m.left + menu.scrollLeft) + 'px'; key.style.width = r.width + 'px';
    it.classList.add('k');
  }
  // "● Metals & Mining · Imports ▾": onde você está, dito na ilha recolhida
  function label() {
    if (!now) return;
    var head = cur(), name = 'Home', sub = '';
    var here = (location.pathname || '/').toLowerCase();
    if (head) {
      var grp = head.parentNode && head.parentNode.classList && head.parentNode.classList.contains('gn-group') ? head.parentNode : null;
      if (grp) {
        name = NAMES[grp.id] || txt(head); var a = grp.querySelector('.gn-drop a.on'); sub = a ? txt(a) : '';
        if (!sub) {   // página própria dentro do grupo, sem #âncora (Quarterly dentro do Stock Guide ▾)
          [].slice.call(grp.querySelectorAll('.gn-drop a')).some(function (l) {
            var u; try { u = new URL(l.href, location.href); } catch (e) { return false; }
            if (u.pathname.toLowerCase() === here && !u.hash && !u.search && txt(l) !== name) { sub = txt(l); return true; }
            return false;
          });
        }
      }
      else name = txt(head);
    } else if (PAGE_NAMES[here]) name = PAGE_NAMES[here];   // página que não está no menu (Market Watch avulsa)
    else if (here !== '/' && here !== '/index.html') name = (document.title || '').split(/[|·—–-]/)[0].trim() || 'Home';
    if (name === 'News Hunter') name = 'News';
    now.innerHTML = '<i></i>' + esc(name) + (sub ? ' <em>· ' + esc(sub) + '</em>' : '') + '<span class="cv">▾</span>';
    now.title = 'You are here: ' + name + (sub ? ' · ' + sub : '') + ' — hover to open the menu';
  }

  /* ═══ 2. A BUSCA ═══════════════════════════════════════════════════════════════════════════ */
  var CO = [   // as 20 cobertas: [chave do logo, nome, código do Market (?t=), códigos/apelidos, setor]
    ['VALE', 'Vale', 'VALE', 'VALE3 VALE iron ore', 'Iron ore'], ['CMIN3', 'CSN Mineração', 'CMIN3.SA', 'CMIN3 CMIN csn mineracao', 'Iron ore'],
    ['CSNA3', 'CSN', 'CSNA3.SA', 'CSNA3 SID companhia siderurgica nacional', 'Steel'], ['GGBR4', 'Gerdau', 'GGBR4.SA', 'GGBR4 GGB GOAU4', 'Steel'],
    ['USIM5', 'Usiminas', 'USIM5.SA', 'USIM5 USIM3', 'Steel'], ['TX', 'Ternium', 'TX', 'TX', 'Steel'],
    ['AUGO', 'Aura Minerals', 'AUGO', 'AUGO AURA33 ORA gold', 'Gold'], ['SCCO', 'Southern Copper', 'SCCO', 'SCCO copper', 'Copper'],
    ['GMEXICOB', 'Grupo México', 'GMEXICOB.MX', 'GMEXICOB GMEX grupo mexico copper', 'Copper'], ['CS', 'Capstone Copper', 'CS.TO', 'CS capstone copper', 'Copper'],
    ['ERO', 'Ero Copper', 'ERO', 'ERO copper', 'Copper'], ['HBM', 'Hudbay Minerals', 'HBM.TO', 'HBM hudbay copper', 'Copper'],
    ['LUN', 'Lundin Mining', 'LUN.TO', 'LUN lundin copper', 'Copper'], ['ARA', 'Aclara Resources', 'ARA.TO', 'ARA aclara rare earths', 'Rare earths'],
    ['VMM', 'Viridis Mining & Minerals', 'VMM.AX', 'VMM viridis rare earths', 'Rare earths'], ['SUZB3', 'Suzano', 'SUZB3.SA', 'SUZB3 SUZ pulp', 'Pulp & paper'],
    ['KLBN11', 'Klabin', 'KLBN11.SA', 'KLBN11 KLBN4 packaging', 'Pulp & paper'], ['RANI3', 'Irani', 'RANI3.SA', 'RANI3 irani papel', 'Pulp & paper'],
    ['CMPC', 'CMPC', 'CMPC.SN', 'CMPC empresas cmpc pulp', 'Pulp & paper'], ['COPEC', 'Empresas Copec', 'COPEC.SN', 'COPEC arauco pulp', 'Pulp & paper']];
  var KW = {   // palavras que levam a cada aba (o que o analista digitaria)
    'steel_sm_dashboard.html#prices': 'iron ore steel hrc rebar coal metals prices preço minério aço',
    'steel_sm_dashboard.html#domestic': 'iabr inda domestic consumption sales consumo aparente vendas mercado interno',
    'steel_sm_dashboard.html#imports': 'secex imports customs china korea importação alfândega',
    'steel_sm_dashboard.html#exports': 'secex exports exportação port porto',
    'pp_dashboard.html#pulp': 'pulp celulose bhkp nbsk exports china prices fastmarkets',
    'pp_dashboard.html#paper': 'paper packaging iba empapel corrugated papel papelão embalagem',
    'stock-guide.html#comp': 'comp table valuation multiples ev ebitda target price rating comps múltiplos',
    'stock-guide.html#sens': 'sensitivity grid scenarios sensibilidade cenários',
    'quarterly.html': 'quarterly results earnings resultados trimestre',
    'news.html': 'news hunter headlines notícias manchetes', 'agenda.html': 'calendar events agenda earnings dates eventos',
    'data.html': 'data sources glossary freshness fontes glossário', 'market.html': 'market stocks chart performance ações',
    'tab=baskets': 'baskets cestas groups', 'tab=commodities': 'commodities prices', 'tab=short': 'short interest aluguel',
    'tab=buybacks': 'buybacks recompras', 'tab=insiders': 'insiders', 'tab=filings': 'filings cvm comunicados fato relevante',
    'scenario-gen.html': 'cenários scenarios', 'clipinator.html': 'clipping blast whatsapp', 'weekly.html': 'weekly recap e-mail',
    'reports.html': 'reports iabr secex html', 'admin.html': 'admin flags uploads users', 'index.html': 'home hub'
  };
  var SCOPES = [['all', 'All', ''], ['pg', 'Pages', '/'], ['co', 'Companies', '@'], ['cm', 'Commodities', '$'], ['nw', 'News', '#'], ['rp', 'Reports', ''], ['ev', 'Calendar', '']];
  var P = null, inp, res, scBox, scope = 'all', sel = 0, rows = [], cache = {}, tQ = 0, seq = 0;
  function sb() { try { if (typeof sbAuth !== 'undefined' && sbAuth && sbAuth.rpc) return sbAuth; } catch (e) {} return (window.sbAuth && window.sbAuth.rpc) ? window.sbAuth : null; }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function score(q, name, extra) {
    if (!q) return 1;
    var n = norm(name), e = norm(extra || ''), w = q.split(/\s+/).filter(Boolean), s = 0;
    for (var i = 0; i < w.length; i++) {
      var t = w[i], k = 0;
      if (n.indexOf(t) === 0) k = 6; else if (new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(n)) k = 4; else if (n.indexOf(t) >= 0) k = 3;
      else if (new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(e)) k = 2; else if (e.indexOf(t) >= 0) k = 1;
      if (!k) return 0; s += k;
    }
    return s;
  }
  function hl(s, q) {
    s = esc(s); if (!q) return s;
    q.split(/\s+/).filter(function (t) { return t.length > 1; }).forEach(function (t) {
      var i = norm(s).indexOf(t); if (i >= 0 && norm(s).length === s.length) s = s.slice(0, i) + '<mark>' + s.slice(i, i + t.length) + '</mark>' + s.slice(i + t.length);
    });
    return s;
  }
  function pages() {   // tudo o que o menu oferece AGORA (respeita flags e admin, porque lê o próprio menu)
    var out = [], seen = {};
    var add = function (a, group) {
      if (!a || !a.href || seen[a.href]) return;
      var vis = a.style.display !== 'none' && (!a.closest('.gn-group') || a.closest('.gn-group').style.display !== 'none');
      if (!vis) return; seen[a.href] = 1;
      var h = a.getAttribute('href') || '', k = '';
      Object.keys(KW).forEach(function (s) { if (h.indexOf(s) >= 0) k += ' ' + KW[s]; });
      out.push({ t: 'pg', name: txt(a) === 'News Hunter' ? 'News Hunter' : txt(a), meta: group || 'Page', href: a.href, kw: k });
    };
    if (!menu) return out;
    [].slice.call(menu.children).forEach(function (c) {
      if (c.matches && c.matches('a.gn-item')) add(c, '');
      else if (c.classList && c.classList.contains('gn-group')) {
        var grpName = NAMES[c.id] || txt(c.querySelector('.gn-item'));
        var head = c.querySelector(':scope > a.gn-item'); if (head) add(head, '');
        [].slice.call(c.querySelectorAll('.gn-drop a')).forEach(function (a) { add(a, grpName); });
      }
    });
    return out;
  }
  function loadLogos() {
    if (window.IBBA_LOGOS || loadLogos.p) return;
    loadLogos.p = true; var s = document.createElement('script'); s.src = '/assets/logos/logos.js'; s.async = true;
    s.onload = function () { if (P && P.classList.contains('open')) render(); }; document.head.appendChild(s);
  }
  function fetchOnce(k, fn) {   // cada fonte é buscada no máximo 1× a cada 2 min (pouco tráfego no banco)
    var c = cache[k]; if (c && (c.p || Date.now() - c.t < 120000)) return;
    cache[k] = { p: true, t: 0, d: c ? c.d : null };
    new Promise(function (ok) { ok(fn()); }).then(function (d) { cache[k] = { p: false, t: Date.now(), d: d }; if (P && P.classList.contains('open')) render(); },
      function () { cache[k] = { p: false, t: Date.now(), d: c ? c.d : null }; });
  }
  function warm() {
    var c = sb(); loadLogos(); if (!c) return;
    fetchOnce('q', function () { return c.from('quotes').select('ticker,change_pct').in('ticker', CO.map(function (x) { return x[2]; })).then(function (r) { if (r.error) throw r.error; var m = {}; (r.data || []).forEach(function (x) { m[x.ticker] = x.change_pct; }); return m; }); });
    fetchOnce('cm', function () { return c.from('commodities').select('code,name,unit,price,change_pct').then(function (r) { if (r.error) throw r.error; return r.data || []; }); });
    fetchOnce('rp', function () { return c.rpc('get_recent_reports_v3', { p_limit: 30 }).then(function (r) { if (r.error) throw r.error; return r.data || []; }); });
    fetchOnce('ev', function () {
      var d = new Date(), a = new Date(d.getTime() - 7 * 864e5), b = new Date(d.getTime() + 120 * 864e5), f = function (x) { return x.toISOString().slice(0, 10); };
      return c.rpc('get_exec_calendar_events', { p_from: f(a), p_to: f(b) }).then(function (r) { if (r.error) throw r.error; return r.data || []; });
    });
  }
  function news(q) {   // notícias: busca de verdade no banco, a partir de 3 letras (6 manchetes, só o necessário)
    var c = sb(); if (!c || q.length < 3) return;
    var k = 'nw:' + q; if (cache[k] && (cache[k].p || cache[k].d)) return;
    var my = ++seq; cache[k] = { p: true };
    try { c.from('news_articles').select('title,url,source_name,found_at,take_llm').eq('include_in_report', true).ilike('title', '%' + q.replace(/[%_]/g, '') + '%')
      .order('found_at', { ascending: false }).limit(6).then(function (r) { cache[k] = { p: false, d: r.error ? [] : (r.data || []) }; render(); }, function () { cache[k] = { p: false, d: [] }; render(); }); }
    catch (e) { cache[k] = { p: false, d: [] }; }
  }
  function ago(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return ''; var m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
  }
  function pct(v) { return v == null || !isFinite(v) ? '' : (v > 0 ? '+' : '') + (+v).toFixed(2) + '%'; }
  function parse(raw) {   // atalhos: @ empresas · $ commodities · # notícias · / páginas
    var s = scope, q = raw.trim(), m = /^([@$#\/])\s*/.exec(q);
    if (m) { s = { '@': 'co', '$': 'cm', '#': 'nw', '/': 'pg' }[m[1]]; q = q.slice(m[0].length); }
    return { s: s, q: norm(q).trim(), raw: q };
  }
  function collect() {
    var p = parse(inp.value), s = p.s, q = p.q, all = s === 'all', lim = function (n) { return all ? n : 40; }, out = [];
    var push = function (list, n) { list.sort(function (a, b) { return b._s - a._s; }); out.push.apply(out, list.slice(0, n)); };
    if (all || s === 'pg') push(pages().map(function (x) { x._s = score(q, x.name + ' ' + x.meta, x.kw); return x; }).filter(function (x) { return x._s > 0; }), lim(q ? 4 : 6));
    if (all || s === 'co') {
      var qm = (cache.q && cache.q.d) || {};
      push(CO.map(function (c) { return { t: 'co', key: c[0], name: c[1], tk: c[2], meta: c[3].split(' ')[0] + ' · ' + c[4], v: qm[c[2]], _s: score(q, c[1] + ' ' + c[3].split(' ')[0], c[3] + ' ' + c[4]) }; })
        .filter(function (x) { return x._s > 0; }), lim(q ? 4 : (s === 'co' ? 20 : 4)));
    }
    if (all || s === 'cm') {
      var cm = (cache.cm && cache.cm.d) || [];
      push(cm.map(function (c) { return { t: 'cm', name: c.name || c.code, meta: (c.price != null ? (+c.price).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + (c.unit || '') : ''), v: c.change_pct, _s: score(q, c.name || '', c.code) }; })
        .filter(function (x) { return x._s > 0; }), lim(q ? 3 : 0));
    }
    if ((all || s === 'nw') && p.raw.length >= 3) {
      news(p.raw);
      var nd = (cache['nw:' + p.raw] && cache['nw:' + p.raw].d) || [];
      nd.forEach(function (n) { out.push({ t: 'nw', name: n.title, meta: (n.source_name || '') + ' · ' + ago(n.found_at), href: n.url, tk: n.take_llm, _q: p.raw }); });
      if (nd.length || s === 'nw') out.push({ t: 'more', name: 'See all "' + p.raw + '" in News Hunter', href: '/news.html?q=' + encodeURIComponent(p.raw) });
    }
    if (all || s === 'rp') {
      var rp = (cache.rp && cache.rp.d) || [];
      push(rp.filter(function (r) { return r && r.name; }).map(function (r) { return { t: 'rp', name: r.name, meta: (r.date || '') + (r.sector ? ' · ' + String(r.sector).replace('PP', 'P&P').replace('SM', 'S&M') : ''), href: r.link, _s: score(q, r.name, (r.companies || []).join(' ')) }; })
        .filter(function (x) { return x._s > 0; }), lim(q ? 3 : 0));
    }
    if (all || s === 'ev') {
      var ev = (cache.ev && cache.ev.d) || [];
      push(ev.map(function (e) { return { t: 'ev', name: e.title || e.name || '', d: e.start_date || e.date || e.starts_on || '', meta: e.category_name || e.category || '', _s: score(q, e.title || e.name || '', e.category_name || '') }; })
        .filter(function (x) { return x.name && x._s > 0; }), lim(q ? 3 : 0));
    }
    return out;
  }
  var GH = { pg: 'Pages & tabs', co: 'Companies', cm: 'Commodities', nw: 'News', more: '', rp: 'Reports', ev: 'Calendar' };
  function rowHtml(x, i, q) {
    var ic = '', right = '', acts = '';
    if (x.t === 'pg') ic = '<span class="isp-ic">' + SVG_PG + '</span>';
    else if (x.t === 'co') {
      var L = window.IBBA_LOGOS && window.IBBA_LOGOS[x.key], src = L ? (L.markDark || L.mark) : '';
      ic = src ? '<span class="isp-ic logo"><img src="' + esc(src) + '" alt=""></span>' : '<span class="isp-ic">' + esc(x.key.slice(0, 2)) + '</span>';
      right = '<span class="isp-v ' + (x.v > 0 ? 'up' : x.v < 0 ? 'dn' : '') + '">' + pct(x.v) + '</span>';
      acts = '<span class="isp-acts"><span data-go="chart">Chart ↵</span><span data-go="news">News</span><span data-go="comps">Comps</span></span>';
    }
    else if (x.t === 'cm') { ic = '<span class="isp-ic">' + SVG_CM + '</span>'; right = '<span class="isp-v ' + (x.v > 0 ? 'up' : x.v < 0 ? 'dn' : '') + '">' + pct(x.v) + '</span>'; }
    else if (x.t === 'nw') ic = '<span class="isp-ic"><span class="isp-tk ' + (x.tk === '+' ? 'pos' : x.tk === '-' ? 'neg' : x.tk === '=' ? 'neu' : '') + '"></span></span>';
    else if (x.t === 'more') ic = '<span class="isp-ic">' + SVG_Q + '</span>';
    else if (x.t === 'rp') ic = '<span class="isp-ic">' + SVG_DOC + '</span>';
    else if (x.t === 'ev') { var d = new Date(String(x.d).slice(0, 10) + 'T12:00:00'); ic = isNaN(d) ? '<span class="isp-ic">·</span>' : '<span class="isp-ic d">' + d.toLocaleDateString('en-US', { month: 'short' }) + '<b>' + d.getDate() + '</b></span>'; }
    return '<div class="isp-row' + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' + ic + '<span class="isp-t"><b>' + hl(x.name, q) + '</b>' + (x.meta ? '<small>' + esc(x.meta) + '</small>' : '') + '</span>' + right + acts + '</div>';
  }
  function render() {
    if (!res) return;
    var p = parse(inp.value); rows = collect(); if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
    [].slice.call(scBox.children).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-s') === p.s); });
    if (!rows.length) {
      var wait = Object.keys(cache).some(function (k) { return cache[k] && cache[k].p; });
      res.innerHTML = '<div class="isp-e">' + (wait ? 'Searching…' : (p.q ? 'Nothing found for "' + esc(p.raw) + '". Try another scope, or a ticker like VALE3.' : 'Type to search')) + '</div>'; return;
    }
    var h = '', last = '';
    rows.forEach(function (x, i) {
      var g = x.t === 'more' ? 'nw' : x.t;
      if (g !== last) { h += '<div class="isp-g"><span>' + GH[g] + '</span>' + (g === 'co' && p.s === 'all' ? '<a data-scope="co">All 20 →</a>' : '') + '</div>'; last = g; }
      h += rowHtml(x, i, p.q);
    });
    res.innerHTML = h;
    var s = res.querySelector('.isp-row.sel'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
  }
  function go(x, how, newTab) {
    if (!x) return;
    var url = x.href;
    if (x.t === 'co') url = how === 'news' ? '/news.html?q=' + encodeURIComponent(x.name.split(' ')[0] === 'Empresas' ? 'Copec' : x.name) : how === 'comps' ? '/stock-guide.html#comp' : '/market.html?t=' + encodeURIComponent(x.tk);
    if (x.t === 'cm') url = '/market.html?tab=commodities';
    if (x.t === 'ev') url = '/agenda.html';
    if (!url) return;
    var ext = /^https?:/i.test(url) && url.indexOf(location.origin) !== 0;
    if (newTab || ext) window.open(url, '_blank', 'noopener'); else { palette(false); location.href = url; }
  }
  function palette(on) {
    if (on && !P) {
      P = document.createElement('div'); P.className = 'isp'; P.setAttribute('role', 'dialog'); P.setAttribute('aria-label', 'Search the dashboard');
      P.innerHTML = '<div class="isp-box"><div class="isp-in">' + SVG_Q + '<input type="text" placeholder="Search pages, companies, commodities, news, reports…" autocomplete="off" spellcheck="false" aria-label="Search">'
        + '<button type="button" class="isp-x">Esc</button></div><div class="isp-sc"></div><div class="isp-r"></div>'
        + '<div class="isp-ft"><span><b>@</b> companies</span><span><b>$</b> commodities</span><span><b>#</b> news</span><span><b>/</b> pages</span><span><b>Tab</b> scope</span><span><b>↑↓</b> move</span><span><b>↵</b> open</span><span><b>Ctrl ↵</b> new tab</span></div></div>';
      document.body.appendChild(P);
      inp = P.querySelector('input'); res = P.querySelector('.isp-r'); scBox = P.querySelector('.isp-sc');
      scBox.innerHTML = SCOPES.map(function (s) { return '<button type="button" data-s="' + s[0] + '">' + s[1] + (s[2] ? ' <b>' + s[2] + '</b>' : '') + '</button>'; }).join('');
      scBox.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; scope = b.getAttribute('data-s'); inp.value = inp.value.replace(/^[@$#\/]\s*/, ''); sel = 0; render(); inp.focus(); });
      P.addEventListener('mousedown', function (e) { if (e.target === P) palette(false); });
      P.querySelector('.isp-x').addEventListener('click', function () { palette(false); });
      inp.addEventListener('input', function () { sel = 0; clearTimeout(tQ); render(); tQ = setTimeout(render, 280); });
      res.addEventListener('mousemove', function (e) { var r = e.target.closest('.isp-row'); if (!r) return; var i = +r.getAttribute('data-i'); if (i !== sel) { sel = i; [].slice.call(res.querySelectorAll('.isp-row')).forEach(function (x) { x.classList.toggle('sel', +x.getAttribute('data-i') === sel); }); } });
      res.addEventListener('click', function (e) {
        var sc = e.target.closest('[data-scope]'); if (sc) { scope = sc.getAttribute('data-scope'); render(); inp.focus(); return; }
        var r = e.target.closest('.isp-row'); if (!r) return; var a = e.target.closest('[data-go]');
        go(rows[+r.getAttribute('data-i')], a ? a.getAttribute('data-go') : 'chart', e.ctrlKey || e.metaKey);
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
        else if (e.key === 'Enter') { e.preventDefault(); go(rows[sel], 'chart', e.ctrlKey || e.metaKey); }
        else if (e.key === 'Tab') { e.preventDefault(); var i = SCOPES.map(function (s) { return s[0]; }).indexOf(parse(inp.value).s); scope = SCOPES[(i + (e.shiftKey ? SCOPES.length - 1 : 1)) % SCOPES.length][0]; inp.value = inp.value.replace(/^[@$#\/]\s*/, ''); sel = 0; render(); }
        else if (e.key === 'Escape') { e.preventDefault(); palette(false); }
      });
    }
    if (!P) return;
    if (on) { open(false); scope = 'all'; inp.value = ''; sel = 0; P.classList.add('open'); warm(); render(); setTimeout(function () { inp.focus(); }, 0); }
    else P.classList.remove('open');
  }
  window.IBBASearch = { open: function () { palette(true); }, close: function () { palette(false); } };
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase(), t = e.target, typing = t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); palette(!(P && P.classList.contains('open'))); return; }
    if (k === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); palette(true); }
  });

  /* ═══ 3. QUANDO ENTRAR: assim que o topnav.js puser a barra (antes do 1º desenho) ════════════ */
  function tryBuild() { var g = document.querySelector('.gnav'); if (g) { build(g); return true; } return false; }
  if (!tryBuild()) {
    try {
      var mo = new MutationObserver(function () { if (tryBuild()) mo.disconnect(); });
      mo.observe(root, { childList: true, subtree: true });
    } catch (e) {}
    document.addEventListener('DOMContentLoaded', tryBuild);
  }
})();
