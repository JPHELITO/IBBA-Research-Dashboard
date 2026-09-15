/* =============================================================================
 * topnav.js — BARRA DE NAVEGAÇÃO GLOBAL (mesma de todas as páginas).
 * Inclua em qualquer página: <script src="/topnav.js"></script> (depois do supabase-js).
 * Auto-injeta no topo do <body>. Usa window.sbAuth (se existir) p/ revelar a aba Admin.
 * Fonte ÚNICA da nav → editar aqui muda em todo o dashboard. TODAS as páginas usam esta barra,
 * INCLUSIVE a HOME (que ainda tem um .header/.orange-rule próprios, escondidos no desktop pelo
 * CSS abaixo e usados só como fallback no mobile ≤900px).
 * ========================================================================== */
;(function () {
  if (window.__TOPNAV_LOADED__) return; window.__TOPNAV_LOADED__ = true;

  /* ── everyVisible(fn, ms) — RELÓGIO QUE DORME COM A ABA ────────────────────
     Entra no lugar de setInterval nas buscas de REDE. Enquanto a aba está
     escondida (outra aba na frente, janela minimizada) o ciclo PARA: ninguém
     está olhando e cada volta custa egress do Supabase — uma aba esquecida
     aberta a madrugada inteira consumia o mesmo que uma em uso.
     INVARIANTE: o dado na tela NUNCA fica mais velho do que ficaria com
     setInterval puro. Ao voltar para a aba, o ciclo que já venceu roda NA HORA
     (hoje se esperaria até o próximo tique, então na volta fica mais NOVO);
     se ainda não venceu, espera só o que falta — alt-tab curto não vira busca
     nova, senão alternar janelas geraria MAIS tráfego, não menos.
     Navegador sem Page Visibility cai no setInterval de sempre. */
  window.everyVisible = function (fn, ms) {
    if (typeof document.visibilityState !== 'string') { setInterval(fn, ms); return; }
    var timer = null, last = Date.now();                 // `last` = hora da última execução
    function hidden(){ return document.visibilityState === 'hidden'; }
    function clear(){ if (timer) { clearTimeout(timer); timer = null; } }
    function arm(delay){ clear(); timer = setTimeout(tick, Math.max(0, delay)); }
    function tick(){
      timer = null;
      if (hidden()) return;                              // dorme — quem rearma é o visibilitychange
      last = Date.now();
      try { fn(); } catch (e) { console.warn('everyVisible:', e); }
      arm(ms);
    }
    arm(ms);
    document.addEventListener('visibilitychange', function () {
      if (hidden()) { clear(); return; }                 // escondeu → para o relógio
      var due = ms - (Date.now() - last);
      if (due <= 0) tick(); else arm(due);               // venceu → busca AGORA; senão espera o resto
    });
  };

  // ── NIGHT MODE (tema global: mesma chave localStorage 'ibba_theme' + classe html.dark de todas as páginas) ──
  function applyTheme(){ try{ if(localStorage.getItem('ibba_theme')==='dark') document.documentElement.classList.add('dark'); }catch(e){} }
  applyTheme();
  var SVG_MOON='<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  var SVG_SUN='<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  window.__toggleTheme = function(){
    var dark = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dark);
    if(document.body) document.body.classList.toggle('theme-light', !dark);   // a Market usa body.theme-light p/ o claro; inócuo nas demais páginas
    try{ localStorage.setItem('ibba_theme', dark?'dark':'light'); }catch(e){}
    if(window.__syncThemeIcon) window.__syncThemeIcon();
    try{ window.dispatchEvent(new Event('ibba:theme')); }catch(e){}   // páginas com Chart.js (M&M/P&P) re-renderizam os gráficos
  };
  window.__syncThemeIcon = function(){
    var on=document.documentElement.classList.contains('dark');
    var ic=document.getElementById('gnav-theme-ic'); if(ic) ic.innerHTML = on?SVG_SUN:SVG_MOON;
    var b=document.getElementById('gnav-theme'); if(b) b.title = on?'Switch to light':'Switch to dark';
  };

  // Time do cabeçalho: quem MANDA é a tabela do admin (RPC get_team). Esta lista é só
  // reserva anti-flash (1º paint / RPC fora do ar) — analista novo entra pelo /admin, NÃO aqui.
  var TEAM_FALLBACK = [
    { ini:'DS', name:'Daniel Sasson',     photo:'/assets/team-daniel.jpg',  email:'daniel.sasson@itaubba.com',    wa:'5511996741242' },
    { ini:'MF', name:'Marcelo Furlan',    photo:'/assets/team-marcelo.jpg', email:'marcelo.palhares@itaubba.com', wa:'5511974642801' },
    { ini:'JH', name:'João Paulo Helito', photo:'/assets/team-joao.jpg',    email:'joao.helito@itaubba.com',      wa:'5511934527535' },
  ];
  var SVG_EMAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
  var SVG_WA = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.52 3.48A11.94 11.94 0 0 0 12.07.13C5.5.13.18 5.46.18 12.03c0 2.12.55 4.18 1.6 6L0 24l6.18-1.62a11.93 11.93 0 0 0 5.89 1.5h.01c6.57 0 11.9-5.33 11.9-11.89 0-3.18-1.24-6.16-3.46-8.51zM12.07 21.78h-.01a9.84 9.84 0 0 1-5.02-1.38l-.36-.21-3.67.96.98-3.57-.24-.37a9.83 9.83 0 0 1-1.51-5.18c0-5.45 4.43-9.88 9.88-9.88 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.43 9.74-9.93 9.74zm5.42-7.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15s-.77.97-.94 1.17c-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.79.37-.27.3-1.04 1.01-1.04 2.47s1.07 2.87 1.22 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35z"/></svg>';

  var CSS = '\
.gnav{background:#111;display:flex;align-items:center;gap:14px;padding:0 28px;height:54px;flex-shrink:0;\
  font-family:Inter,"Segoe UI",Helvetica,Arial,sans-serif;position:relative;z-index:500;}\
.gnav-brand{display:flex;align-items:center;gap:9px;flex-shrink:0;}\
.gnav-brand b{font-size:13.5px;font-weight:700;color:#fff;letter-spacing:.04em;white-space:nowrap;}\
.gnav-mark{width:26px;height:26px;border-radius:7px;background:#FF5000;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;flex-shrink:0;}\
.gnav-menu{display:flex;align-items:center;gap:2px;margin-left:16px;}\
/* ── ITEM DA NAV: a página atual se marca com UMA barrinha laranja embaixo do nome — nada de\
   tinte de fundo, halo ou brilho. No hover a mesma barrinha aparece apagada (35%), como\
   ensaio do clique. Só a cor do texto e a opacidade mudam. ── */\
.gn-item{position:relative;font-size:11.5px;font-weight:600;letter-spacing:.03em;color:rgba(255,255,255,.62);text-decoration:none;\
  padding:7px 12px 8px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;\
  transition:color .15s ease;}\
.gn-item::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:2px;background:#FF5000;\
  opacity:0;transition:opacity .15s ease;}\
.gn-item:hover{color:#fff;}\
.gn-item:hover::after{opacity:.35;}\
.gn-item.on{color:#fff;}\
.gn-item.on::after{opacity:1;}\
.gn-group{position:relative;}\
.gn-drop{position:absolute;top:calc(100% + 6px);left:0;min-width:214px;background:#fff;border:1px solid #E8E6E1;border-radius:12px;\
  box-shadow:0 10px 26px -10px rgba(17,17,17,.22);padding:7px;display:none;z-index:600;}\
.gn-group:hover .gn-drop{display:block;}\
/* ponte invisível: o vão de 6px entre o item e a lista não pode fechar o menu */\
.gn-drop::before{content:"";position:absolute;left:0;right:0;top:-8px;height:8px;}\
/* escolheu um destino → a lista fecha na hora. Quando o destino é a MESMA página (#âncora do M&M, aba do\
   Market) não há recarga, e o hover seguraria a lista aberta por cima do conteúdo; reabre ao sair e voltar */\
.gn-group.gn-shut .gn-drop{display:none;}\
/* Market ▾: a cabeça segue LINK (leva à Performance, como sempre levou). Sem as abas internas liberadas\
   (flag market_watch ou admin) somem a ▾ e a lista — o cliente vê o "Market" simples de antes */\
.gn-group.gn-solo .gn-drop,.gn-group.gn-solo .gn-caret{display:none!important;}\
/* 901–1100px (ex.: notebook de 1280 com zoom de 125% = 1024): com a ▾ do Market o Sign out do cliente passava\
   8px da borda da tela → os itens apertam 2px de cada lado. Acima de 1100px nada muda (medido: sobra 43px) */\
@media(min-width:901px) and (max-width:1100px){.gn-item{padding-left:10px;padding-right:10px;}.gn-item::after{left:10px;right:10px;}}\
.gn-drop a{display:block;font-size:11.5px;color:#2C2C2C;text-decoration:none;padding:8px 12px;border-radius:9px;font-weight:500;white-space:nowrap;transition:background .15s,color .15s;}\
.gn-drop a:hover{background:#F7F5F1;color:#FF5000;}\
.gn-drop a.on{background:rgba(255,80,0,.09);color:#FF5000;font-weight:600;}\
.gn-cat{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:#8C8C8C;padding:5px 12px 3px;}\
html.dark .gn-drop{background:#1c2026;border-color:#2E343E;box-shadow:0 10px 28px -10px rgba(0,0,0,.6);}\
html.dark .gn-drop a{color:#e8eaed;}\
html.dark .gn-drop a:hover{background:rgba(255,255,255,.06);color:#ff7a45;}\
html.dark .gn-drop a.on{background:rgba(255,80,0,.16);color:#ff7a45;}\
html.dark .gn-cat{color:#828892;}\
/* abas internas (admin): distinguem-se só pela cor do texto — sem moldura, sem selo */\
.gn-admin{color:#ff7a45!important;margin-left:6px;}\
.gn-admin:hover,.gn-admin.on{color:#ff9166!important;}\
.gnav-team{display:flex;align-items:center;gap:13px;margin-left:auto;}\
.gnt{display:flex;align-items:center;gap:5px;}\
.gnt-av{width:23px;height:23px;border-radius:50%;object-fit:cover;background:#FF5000;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}\
.gnt-name{font-size:10px;color:rgba(255,255,255,.78);font-weight:500;white-space:nowrap;}\
.gnav-team.compact .gnt-name{display:none;}\
.gnav-team.tight .gnt-b.wa{display:none;}\
.gnav-team.bare .gnt-b{display:none;}\
.gnt-b{width:19px;height:19px;border-radius:7px;border:1px solid rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.55);text-decoration:none;transition:color .15s,border-color .15s,background .15s;}\
.gnt-b:hover{color:#fff;border-color:rgba(255,255,255,.45);background:rgba(255,255,255,.06);}\
.gnt-b svg{width:11px;height:11px;}\
.gnt-b.wa:hover{color:#25D366;border-color:#25D366;}\
.gnav-out{font:600 11px Inter,sans-serif;color:rgba(255,255,255,.45);background:none;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:6px 13px;cursor:pointer;margin-left:14px;transition:color .15s,border-color .15s,background .15s;}\
.gnav-out:hover{color:#fff;border-color:rgba(255,255,255,.38);background:rgba(255,255,255,.06);}\
.gnav-theme{flex-shrink:0;width:30px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:none;border:1px solid rgba(255,255,255,.14);border-radius:9px;color:rgba(255,255,255,.6);cursor:pointer;margin-left:14px;transition:color .15s,border-color .15s,background .15s;}\
.gnav-theme:hover{color:#fff;border-color:rgba(255,255,255,.42);background:rgba(255,255,255,.06);}\
.gnav-theme svg{width:15px;height:15px;display:block;}\
/* TUTORIAL: botão discreto, no idioma do Sign out. Aperta p/ só o ícone antes de sumir o WhatsApp do time (_fitTeam) */\
.gnav-tut{flex-shrink:0;display:inline-flex;align-items:center;gap:6px;height:28px;font:600 11px Inter,sans-serif;color:rgba(255,255,255,.5);background:none;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:0 11px 0 9px;cursor:pointer;margin-left:14px;white-space:nowrap;transition:color .15s,border-color .15s,background .15s;}\
.gnav-tut:hover{color:#fff;border-color:rgba(255,255,255,.38);background:rgba(255,255,255,.06);}\
.gnav-tut svg{width:14px;height:14px;display:block;flex-shrink:0;}\
@media(min-width:901px){.gnav.tut-ico .gnav-tut{width:28px;padding:0;justify-content:center;margin-left:8px;}.gnav.tut-ico .gnav-theme{margin-left:8px;}.gnav.tut-ico .gnav-out{margin-left:10px;}}\
.gnav.tut-ico .gnav-tut-l{display:none;}\
.gnav-rule{height:2px;background:#FF5000;}\
/* Cabeçalhos PRÓPRIOS das páginas: a barra de verdade é esta (.gnav), em QUALQUER largura.\
   Home/News/Stock Guide só repetiam marca+time+Sign out → somem sempre. O .top-bar de M&M e P&P\
   sobrevive no celular porque carrega o "← Sections" (a página compacta ele por conta própria).\
   ⚠️ Estas regras moram no CSS que o topnav.js injeta: se o arquivo não carregar, cada página\
   volta a mostrar o cabeçalho antigo em vez de ficar sem nenhum. */\
.header,.orange-rule,#app>.sticky-header{display:none!important;}\
@media(min-width:901px){.top-bar{display:none!important;}}\
\
/* ═══ CELULAR (≤900px) — a MESMA barra vira compacta + botão ☰ ═══════════════\
   Antes a .gnav era escondida e NADA entrava no lugar: quem abrisse a dash no\
   telefone não tinha como chegar na Market (só existia no menu do desktop).\
   Agora: barra fixa no topo (marca + tema + ☰) e uma folha que desce com o menu\
   inteiro, o time (nome + e-mail + WhatsApp) e o Sign out. */\
.gnav-burger{display:none;width:36px;height:32px;align-items:center;justify-content:center;\
  background:none;border:1px solid rgba(255,255,255,.22);border-radius:7px;color:#fff;cursor:pointer;\
  margin-left:10px;flex-shrink:0;padding:0;}\
.gnav-burger svg{width:18px;height:18px;display:block;}\
.gnav-mob{display:none;position:fixed;left:0;right:0;top:52px;bottom:0;z-index:1900;\
  background:rgba(0,0,0,.45);}\
.gnav-mob.open{display:block;}\
.gnav-sheet{background:#fff;max-height:100%;overflow-y:auto;-webkit-overflow-scrolling:touch;\
  padding:6px 0 26px;box-shadow:0 18px 44px rgba(0,0,0,.34);\
  font-family:Inter,"Segoe UI",Helvetica,Arial,sans-serif;}\
.gnm-cat{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#8C8C8C;\
  padding:14px 18px 4px;}\
.gnm-cat.on{color:#FF5000;}\
.gnm-a{display:flex;align-items:center;min-height:46px;padding:11px 18px;text-decoration:none;\
  font-size:15px;font-weight:600;color:#2C2C2C;border-bottom:1px solid #EEEDEA;}\
.gnm-a.sub{font-size:14px;font-weight:500;color:#5A5A5A;padding-left:30px;min-height:42px;}\
.gnm-a:active{background:#F4F3F0;}\
/* mesma marca do desktop, no idioma do celular: um traço laranja na borda, sem tinte */\
.gnm-a.on{color:#FF5000;box-shadow:inset 2px 0 0 #FF5000;}\
.gnm-a.adm{color:#FF5000;}\
.gnm-team{padding:2px 18px 0;}\
.gnm-p{display:flex;align-items:center;gap:11px;padding:9px 0;border-bottom:1px solid #EEEDEA;}\
.gnm-av{width:36px;height:36px;border-radius:50%;object-fit:cover;background:#FF5000;color:#fff;\
  font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}\
.gnm-nm{flex:1;min-width:0;font-size:14px;font-weight:600;color:#2C2C2C;\
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\
.gnm-b{width:36px;height:36px;border-radius:8px;border:1px solid #E3E3E3;display:flex;align-items:center;\
  justify-content:center;color:#8C8C8C;text-decoration:none;flex-shrink:0;}\
.gnm-b svg{width:16px;height:16px;}\
.gnm-b.wa{color:#25D366;border-color:rgba(37,211,102,.45);}\
.gnm-out{display:block;width:calc(100% - 36px);margin:18px 18px 0;padding:13px;border-radius:9px;\
  border:1px solid #E3E3E3;background:#F4F3F0;color:#2C2C2C;font:700 14px Inter,sans-serif;cursor:pointer;}\
html.dark .gnav-sheet{background:#1c2026;}\
html.dark .gnm-a{color:#e8eaed;border-bottom-color:#2b3038;}\
html.dark .gnm-a.sub{color:#a9b0ba;}\
html.dark .gnm-a:active{background:#15171b;}\
html.dark .gnm-p{border-bottom-color:#2b3038;}\
html.dark .gnm-nm{color:#e8eaed;}\
html.dark .gnm-b{border-color:#2b3038;}\
html.dark .gnm-out{background:#15171b;border-color:#2b3038;color:#e8eaed;}\
@media(max-width:900px){\
  .gnav{position:sticky;top:0;height:52px;padding:0 12px;gap:8px;z-index:1800;}\
  .gnav-menu,.gnav-team,.gnav-out{display:none!important;}\
  .gnav-theme{margin-left:auto;}\
  .gnav-tut{margin-left:auto;width:30px;padding:0;justify-content:center;}\
  .gnav-tut-l{display:none;}\
  .gnav.has-tut .gnav-theme{margin-left:8px;}\
  .gnav-burger{display:inline-flex;}\
  .gnav-rule{position:sticky;top:52px;z-index:1799;}\
  body.gnav-locked{overflow:hidden;}\
}\
@media(min-width:901px){.gnav-mob{display:none!important;}}';

  var NAV = '\
<div class="gnav">\
  <a class="gnav-brand" href="/index.html" style="text-decoration:none"><span class="gnav-mark"></span><b>M&amp;M | P&amp;P</b></a>\
  <nav class="gnav-menu">\
    <a class="gn-item" href="/index.html">Home</a>\
    <div class="gn-group" id="gnav-mm"><span class="gn-item">M&amp;M ▾</span><div class="gn-drop"><div class="gn-cat">Steel &amp; Mining</div>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#prices">Prices</a>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#domestic">Domestic Market</a>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#imports">Imports</a>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#exports">Exports</a></div></div>\
    <div class="gn-group" id="gnav-pp"><span class="gn-item">P&amp;P ▾</span><div class="gn-drop"><div class="gn-cat">Pulp &amp; Paper</div>\
      <a href="/Pulp and Paper/pp_dashboard.html#pulp">Pulp</a>\
      <a href="/Pulp and Paper/pp_dashboard.html#paper">Paper &amp; Packaging</a></div></div>\
    <a class="gn-item" id="gnav-news" href="/news.html">News Hunter</a>\
    <div class="gn-group" id="gnav-sg"><span class="gn-item">Stock Guide ▾</span><div class="gn-drop"><div class="gn-cat">Stock Guide</div>\
      <a href="/stock-guide.html#comp">Comp Table</a>\
      <a href="/stock-guide.html#sens">Sensitivity</a>\
      <a href="/quarterly.html" class="gn-quarterly" style="display:none">Quarterly</a></div></div>\
    <div class="gn-group gn-solo" id="gnav-market"><a class="gn-item" href="/market.html">Market<span class="gn-caret"> ▾</span></a><div class="gn-drop"><div class="gn-cat">Market</div>\
      <a href="/market.html?tab=performance">Performance</a>\
      <a href="/market.html?tab=commodities">Commodities</a>\
      <a href="/market.html?tab=short">Short Interest</a>\
      <a href="/market.html?tab=buybacks">Buybacks</a>\
      <a href="/market.html?tab=insiders">Insiders</a>\
      <a href="/market.html?tab=filings">Filings</a></div></div>\
    <a class="gn-item" id="gnav-cal" href="/agenda.html">Calendar</a>\
    <a class="gn-item" id="gnav-data" href="/data.html" title="Data sources, freshness and glossary" style="display:none">Data</a>\
    <a class="gn-item gn-admin" id="gnav-scenario" href="/scenario-gen.html" style="display:none">Cenários</a>\
    <a class="gn-item gn-admin" id="gnav-clipinator" href="/clipinator.html" style="display:none">Clipping</a>\
    <a class="gn-item gn-admin" id="gnav-weekly" href="/weekly.html" style="display:none">Weekly</a>\
    <a class="gn-item gn-admin" id="gnav-admin" href="/admin.html" style="display:none">Admin</a>\
  </nav>\
  <div class="gnav-team" id="gnav-team"></div>\
  <button class="gnav-tut" id="gnav-tutorial" onclick="__gnavTour(this)" title="Guided tours of the dashboard" aria-label="Tutorial" style="display:none"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.6-2.4 2.1-2.4 3.5"/><path d="M12 17.2h.01"/></svg><span class="gnav-tut-l">Tutorial</span></button>\
  <button class="gnav-theme" id="gnav-theme" onclick="__toggleTheme()" title="Toggle dark mode" aria-label="Toggle dark mode"><svg id="gnav-theme-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>\
  <button class="gnav-out" onclick="__gnavOut()">Sign out</button>\
  <button class="gnav-burger" id="gnav-burger" onclick="__gnavMob()" aria-label="Menu" aria-expanded="false" aria-controls="gnav-mob">\
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>\
</div><div class="gnav-rule"></div>\
<div class="gnav-mob" id="gnav-mob" onclick="if(event.target===this)__gnavMob(0)">\
  <div class="gnav-sheet">\
    <a class="gnm-a" href="/index.html">Home</a>\
    <div class="gnm-cat" data-tour="m-sectors">Metals &amp; Mining</div>\
    <a class="gnm-a sub" href="/Steel and Mining/steel_sm_dashboard.html#prices">Prices</a>\
    <a class="gnm-a sub" href="/Steel and Mining/steel_sm_dashboard.html#domestic">Domestic Market</a>\
    <a class="gnm-a sub" href="/Steel and Mining/steel_sm_dashboard.html#imports">Imports</a>\
    <a class="gnm-a sub" href="/Steel and Mining/steel_sm_dashboard.html#exports">Exports</a>\
    <div class="gnm-cat" data-tour="m-sectors">Pulp &amp; Paper</div>\
    <a class="gnm-a sub" href="/Pulp and Paper/pp_dashboard.html#pulp">Pulp</a>\
    <a class="gnm-a sub" href="/Pulp and Paper/pp_dashboard.html#paper">Paper &amp; Packaging</a>\
    <div class="gnm-cat" data-tour="m-sg">Stock Guide</div>\
    <a class="gnm-a sub" href="/stock-guide.html#comp">Comp Table</a>\
    <a class="gnm-a sub" href="/stock-guide.html#sens">Sensitivity</a>\
    <a class="gnm-a sub gnm-quarterly" href="/quarterly.html" style="display:none">Quarterly</a>\
    <div class="gnm-cat gnm-mkt" style="display:none">Market</div>\
    <a class="gnm-a sub gnm-mkt" href="/market.html?tab=performance" style="display:none">Performance</a>\
    <a class="gnm-a sub gnm-mkt" href="/market.html?tab=commodities" style="display:none">Commodities</a>\
    <a class="gnm-a sub gnm-mkt" href="/market.html?tab=short" style="display:none">Short Interest</a>\
    <a class="gnm-a sub gnm-mkt" href="/market.html?tab=buybacks" style="display:none">Buybacks</a>\
    <a class="gnm-a sub gnm-mkt" href="/market.html?tab=insiders" style="display:none">Insiders</a>\
    <a class="gnm-a sub gnm-mkt" href="/market.html?tab=filings" style="display:none">Filings</a>\
    <div class="gnm-cat">More</div>\
    <a class="gnm-a" href="/news.html">News Hunter</a>\
    <a class="gnm-a gnm-mkt-solo" href="/market.html">Market</a>\
    <a class="gnm-a" href="/agenda.html">Calendar</a>\
    <a class="gnm-a gnm-tut" role="button" tabindex="0" data-nomark onclick="__gnavTour();return false" style="display:none">Tutorial</a>\
    <a class="gnm-a gnm-data" href="/data.html" style="display:none">Data &amp; Glossary</a>\
    <a class="gnm-a adm gnm-admin" href="/scenario-gen.html" style="display:none">Cenários</a>\
    <a class="gnm-a adm gnm-admin" href="/clipinator.html" style="display:none">Clipping</a>\
    <a class="gnm-a adm gnm-admin" href="/weekly.html" style="display:none">Weekly</a>\
    <a class="gnm-a adm gnm-admin" href="/admin.html" style="display:none">Admin</a>\
    <div class="gnm-cat">Equity Research</div>\
    <div class="gnm-team" id="gnav-mteam"></div>\
    <button class="gnm-out" onclick="__gnavOut()">Sign out</button>\
  </div>\
</div>';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function _ini(n){ return String(n==null?'':n).trim().split(/\s+/).map(function(w){return w[0]||'';})
    .slice(0,2).join('').toUpperCase().replace(/[^A-ZÀ-Ü]/g,'') || '–'; }
  // A foto vem do banco RELATIVA ('assets/team-x.jpg'); as páginas em subpasta ("Steel and Mining/")
  // resolveriam pra pasta errada → 404 e a bolinha virava iniciais. Data URI e URL absoluta passam intactas.
  function _photo(p){ p = String(p==null?'':p); return (!p || /^(data:|https?:|\/)/i.test(p)) ? p : '/'+p; }

  // Assinatura de nomes do cabeçalho MOBILE (a barra global some em ≤900px):
  // news.html usa .brand-team; M&M e P&P usam .top-sub. Mesma fonte de dados → não desencontra.
  function _fillBrandSub(team){
    var txt = team.map(function(p){ return p.name; }).join(' · ');
    ['.brand-team', '.top-sub'].forEach(function(sel){
      var el = document.querySelector(sel); if(el) el.textContent = txt;
    });
  }

  // ── MENU DE CELULAR (☰) ───────────────────────────────────────────────────
  // Sai fechado; abre por cima da página (fixed). Fecha ao clicar num link, no
  // fundo escuro, no Esc, e sozinho se a tela voltar a ser de desktop.
  window.__gnavMob = function(open){
    var m = document.getElementById('gnav-mob'), b = document.getElementById('gnav-burger');
    if(!m) return;
    var on = (open === undefined) ? !m.classList.contains('open') : !!open;
    m.classList.toggle('open', on);
    if(b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
    if(document.body) document.body.classList.toggle('gnav-locked', on);   // trava a rolagem do fundo
  };
  window.__gnavOut = function(){
    try{ var sb=_sb(); if(sb && sb.auth) sb.auth.signOut(); }catch(e){}   // mesmo achador do cliente da página usado pelo revealAdmin
    try{ localStorage.removeItem('ibba_is_admin'); }catch(e){}
    document.cookie = 'sb-access-token=; Max-Age=0; Path=/';
    location.replace('/login.html');
  };

  // Time DENTRO da folha do ☰: aqui cabe o nome inteiro (na barra do desktop ele vira hover).
  function renderMobTeam(team){
    var el = document.getElementById('gnav-mteam'); if(!el) return;
    el.innerHTML = team.map(function(p){
      var ini = esc(p.ini || _ini(p.name)), ph = _photo(p.photo);
      return '<div class="gnm-p">'
        + (ph ? '<img class="gnm-av" src="'+esc(ph)+'" alt="" onerror="this.outerHTML=\'<div class=&quot;gnm-av&quot;>'+ini+'</div>\'">'
              : '<div class="gnm-av">'+ini+'</div>')
        + '<span class="gnm-nm">'+esc(p.name)+'</span>'
        + (p.email ? '<a class="gnm-b" href="mailto:'+esc(p.email)+'" aria-label="E-mail '+esc(p.name)+'">'+SVG_EMAIL+'</a>' : '')
        + (p.wa ? '<a class="gnm-b wa" href="https://wa.me/'+esc(p.wa)+'" target="_blank" rel="noopener" aria-label="WhatsApp '+esc(p.name)+'">'+SVG_WA+'</a>' : '')
        + '</div>';
    }).join('');
  }

  function renderTeam(list){
    var el = document.getElementById('gnav-team'); if(!el) return;
    var team = (list && list.length) ? list : TEAM_FALLBACK;
    renderMobTeam(team);
    el.innerHTML = team.map(function(p){
      var ini = esc(p.ini || _ini(p.name)), ph = _photo(p.photo);
      return '<div class="gnt" title="'+esc(p.name)+'">'
        + (ph ? '<img class="gnt-av" src="'+esc(ph)+'" alt="'+esc(p.name)+'" onerror="this.outerHTML=\'<div class=&quot;gnt-av&quot;>'+ini+'</div>\'">'
              : '<div class="gnt-av">'+ini+'</div>')
        + '<span class="gnt-name">'+esc(p.name)+'</span>'
        + (p.email ? '<a class="gnt-b" href="mailto:'+esc(p.email)+'" title="'+esc(p.email)+'">'+SVG_EMAIL+'</a>' : '')
        + (p.wa ? '<a class="gnt-b wa" href="https://wa.me/'+esc(p.wa)+'" target="_blank" rel="noopener" title="WhatsApp '+esc(p.name)+'">'+SVG_WA+'</a>' : '')
        + '</div>';
    }).join('');
    _fillBrandSub(team); _fitTeam();
  }

  // A barra tem largura fixa e o time cresce: com 4 analistas os nomes já estouram fora de 1920 e
  // empurram o Sign out p/ FORA da tela (a página não rola na horizontal → botão inalcançável).
  // Degrada em degraus, cedendo o menos importante primeiro e sempre mantendo a bolinha:
  //   nome (fica no hover, via title) → WhatsApp → e-mail. Escala p/ N analistas em qualquer tela.
  function _fitTeam(){
    var g = document.querySelector('.gnav'), t = document.getElementById('gnav-team');
    if(!g || !t) return;
    t.className = 'gnav-team';
    g.classList.remove('tut-ico');
    // 2º degrau: o botão Tutorial perde o rótulo (fica o ícone) antes de o time perder o WhatsApp
    ['compact','tut-ico','tight','bare'].forEach(function(step){
      if(g.scrollWidth > g.clientWidth + 1) (step === 'tut-ico' ? g : t).classList.add(step);
    });
  }
  var _fitT = null;
  window.addEventListener('resize', function(){ clearTimeout(_fitT); _fitT = setTimeout(_fitTeam, 120); });

  // Time AO VIVO (mesma RPC da home): quem o admin cadastra aparece em TODAS as páginas.
  // Cache em localStorage p/ o 1º paint já sair certo (mesmo padrão do 'ibba_is_admin').
  function _teamCache(){ try{ var s=localStorage.getItem('ibba_team'); var a=s?JSON.parse(s):null;
    return (a && a.length) ? a : null; }catch(e){ return null; } }
  function loadTeam(tries){
    tries = tries || 0;
    var sb=_sb();
    if(sb){ sb.rpc('get_team').then(function(r){
      if(!r || r.error || !Array.isArray(r.data) || !r.data.length) return;   // fail-safe: mantém o que já está na tela
      var list = r.data.map(function(m){
        var fb = null;
        TEAM_FALLBACK.forEach(function(t){ if(t.name === m.name) fb = t; });   // completa foto/contato de quem já era da casa
        return { ini:_ini(m.name), name:m.name, photo:m.photo || (fb?fb.photo:''),
                 email:m.email || (fb?fb.email:'') || '', wa:m.whatsapp || (fb?fb.wa:'') || '' };
      });
      try{ localStorage.setItem('ibba_team', JSON.stringify(list)); }catch(e){}
      renderTeam(list);
    }).catch(function(){}); return; }
    // o sbAuth da página nasce DEPOIS do topnav → espera aparecer (mesma espera do revealAdmin)
    if(tries < 40) setTimeout(function(){ loadTeam(tries+1); }, 150);
  }
  // acha o cliente Supabase da página: `sbAuth` é um `const/let` de topo (NÃO vai pro window) →
  // referenciar direto (typeof guarda contra ReferenceError/TDZ); window.sbAuth como reserva.
  function _sb(){ try{ if(typeof sbAuth!=='undefined' && sbAuth && sbAuth.rpc) return sbAuth; }catch(e){}
    return (window.sbAuth && window.sbAuth.rpc) ? window.sbAuth : null; }
  function _setAdminLinks(show){
    ['gnav-admin','gnav-clipinator','gnav-scenario','gnav-weekly'].forEach(function(id){ var a=document.getElementById(id); if(a) a.style.display = show ? 'inline-flex' : 'none'; });
    [].slice.call(document.querySelectorAll('.gnm-admin')).forEach(function(a){ a.style.display = show ? 'flex' : 'none'; });
    _fitTeam();   // os 3 botões de admin mudam a largura da barra → re-avalia se os nomes cabem
  }
  // O menu e global e nao consulta o Supabase. A home grava em ibba_data_on quem pode abrir a pagina
  // Data (flag data_page ou admin) - sem isso o cliente veria o item e levaria um 'Unavailable'.
  function _setDataLink(on){
    var d=document.getElementById('gnav-data'); if(d) d.style.display=on?'':'none';
    var m=document.querySelector('.gnm-data'); if(m) m.style.display=on?'':'none';
  }
  // Quarterly virou página própria atrás da flag `quarterly`: a home grava ibba_quarterly_on (mesmo recado
  // do Data) — sem isso o cliente veria o item com a flag desligada e levaria 'Unavailable'.
  function _setQuarterlyLink(on){
    [].slice.call(document.querySelectorAll('.gn-quarterly,.gnm-quarterly')).forEach(function(a){ a.style.display = on ? '' : 'none'; });
  }
  // Abas internas do Market (Commodities, Short Interest, Buybacks, Insiders, Filings) atrás da flag market_watch:
  // sem ela o próprio Market devolve a Performance, então o menu não oferece o que não abre — "Market" volta a ser
  // o link simples de antes, sem ▾. Recado em ibba_mw_on (a home e o Market gravam ao ler as flags); admin vê sempre.
  function _setMarketTabs(on){
    var g = document.getElementById('gnav-market'); if(g) g.classList.toggle('gn-solo', !on);
    [].slice.call(document.querySelectorAll('.gnm-mkt')).forEach(function(a){ a.style.display = on ? '' : 'none'; });
    var solo = document.querySelector('.gnm-mkt-solo'); if(solo) solo.style.display = on ? 'none' : '';
    _fitTeam();   // a ▾ muda a largura da barra → re-avalia se os nomes do time cabem
  }
  window.__gnavMarketTabs = function(on){ _setMarketTabs(!!on); };   // a home e o Market chamam ao ler as flags
  function revealAdmin(tries){
    tries = tries || 0;
    try{ _setDataLink(localStorage.getItem('ibba_data_on')==='1' || localStorage.getItem('ibba_is_admin')==='1'); }catch(e){}
    try{ _setQuarterlyLink(localStorage.getItem('ibba_quarterly_on')==='1' || localStorage.getItem('ibba_is_admin')==='1'); }catch(e){}
    try{ _setMarketTabs(localStorage.getItem('ibba_mw_on')==='1' || localStorage.getItem('ibba_is_admin')==='1'); }catch(e){}
    try{ _setTourBtn(_tourOn()); }catch(e){}
    // Cache: aplica o estado admin NA HORA (sem esperar o RPC) → os botões Admin/Clipinator não
    // "pipocam" depois dos demais. Roda ainda dentro do inject(), antes do 1º paint.
    try{ if(localStorage.getItem('ibba_is_admin')==='1') _setAdminLinks(true); }catch(e){}
    var sb=_sb();
    if(sb){ sb.rpc('get_my_role').then(function(r){
      var isAdmin = !!(r && r.data === 'admin');
      try{ localStorage.setItem('ibba_is_admin', isAdmin?'1':'0'); }catch(e){}
      _setAdminLinks(isAdmin);   // reconcilia com a verdade do servidor (mostra p/ admin, esconde se o cache errou)
      if(isAdmin){ _setDataLink(true); _setQuarterlyLink(true); }
      try{ _setTourBtn(isAdmin || localStorage.getItem('ibba_tour_on')==='1'); }catch(e){}
      try{ _setMarketTabs(isAdmin || localStorage.getItem('ibba_mw_on')==='1'); }catch(e){}   // cache de admin velho não deixa a ▾ p/ cliente
    }).catch(function(){}); return; }
    // o sbAuth da página é criado no script DELA, que roda DEPOIS do topnav → espera aparecer (até ~6s).
    // ERA POR ISSO que o botão Admin só surgia na home (que revela por conta própria, com o próprio sbAuth).
    if(tries < 40) setTimeout(function(){ revealAdmin(tries+1); }, 150);
  }
  // ── TUTORIAL (tours guiados) ─────────────────────────────────────────────
  // Motor (tour-lib.js) e textos (tour-content.js) só descem quando alguém usa: clique em "Tutorial",
  // convite da 1ª visita ou tour em andamento atravessando páginas. O vercel.json serve .js com
  // no-store: carregar em toda página seria download à toa. O botão aparece com a flag `tutorial`
  // (recado ibba_tour_on, gravado pela home ao ler as flags) ou para admin.
  function _tourOn(){ try{ return localStorage.getItem('ibba_tour_on')==='1' || localStorage.getItem('ibba_is_admin')==='1'; }catch(e){ return false; } }
  var _tourP = null;
  function _loadTour(){
    if(window.IBBATour && window.IBBA_TOURS) return Promise.resolve(window.IBBATour);
    if(_tourP) return _tourP;
    _tourP = new Promise(function(res, rej){
      var left = 2;
      ['/tour-content.js', '/tour-lib.js'].forEach(function(src){   // async=false: executam NA ORDEM
        var s = document.createElement('script'); s.src = src; s.async = false;
        s.onload = function(){ if(--left === 0){ if(window.IBBATour){ res(window.IBBATour); } else { _tourP = null; rej(new Error('tour-lib')); } } };
        s.onerror = function(){ _tourP = null; rej(new Error('falha ao carregar ' + src)); };
        document.head.appendChild(s);
      });
    });
    return _tourP;
  }
  window.__gnavTour = function(anchor){
    _loadTour().then(function(T){ T.openPanel(anchor && anchor.nodeType === 1 ? anchor : null); })
      .catch(function(e){ console.warn('tutorial:', e); });
  };
  function _setTourBtn(on){
    var b = document.getElementById('gnav-tutorial'); if(b) b.style.display = on ? '' : 'none';
    var g = document.querySelector('.gnav'); if(g) g.classList.toggle('has-tut', !!on);
    [].slice.call(document.querySelectorAll('.gnm-tut')).forEach(function(a){ a.style.display = on ? '' : 'none'; });
    _fitTeam();   // o botão muda a largura da barra → re-avalia se os nomes do time cabem
  }
  window.__gnavTourOn = function(on){ _setTourBtn(!!on); };   // a home chama ao ler as flags
  function _tourBoot(){
    var running = false; try{ running = !!sessionStorage.getItem('ibba_tour_run'); }catch(e){}
    if(running){ _loadTour().then(function(T){ T.resume(); }).catch(function(e){ console.warn('tutorial:', e); }); return; }
    var seen = true; try{ seen = !!localStorage.getItem('ibba_tour_seen'); }catch(e){}
    var here = _path(location.href); if(here === '/' || here === '') here = '/index.html';
    if(seen || here !== '/index.html') return;
    // convite da 1ª visita: espera a home assentar (dados chegando) e confere a flag de novo
    setTimeout(function(){ if(_tourOn()) _loadTour().then(function(T){ T.maybeInvite(); }).catch(function(){}); }, 2500);
  }
  function inject(){
    if(document.querySelector('.gnav')) return;
    var st=document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
    var orig=document.body.firstChild;
    var wrap=document.createElement('div'); wrap.innerHTML=NAV;
    [].slice.call(wrap.childNodes).forEach(function(n){ document.body.insertBefore(n, orig); });  // barra + régua no topo, em ordem
    renderTeam(_teamCache()); revealAdmin(); loadTeam(); if(window.__syncThemeIcon) window.__syncThemeIcon();
    try{ _tourBoot(); }catch(e){}
    _markCurrent();
    var mob = document.getElementById('gnav-mob');
    if(mob) mob.addEventListener('click', function(e){
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if(a) window.__gnavMob(0);                                   // escolheu um destino → fecha a folha
    });
    window.addEventListener('hashchange', _markCurrent);   // trocou de seção → a luz acompanha
    // menu suspenso: escolheu um destino → a lista fecha (.gn-shut no CSS); reabre quando o mouse sai e volta
    [].slice.call(document.querySelectorAll('.gn-group')).forEach(function(g){
      g.addEventListener('click', function(e){
        if(e.ctrlKey || e.metaKey || e.shiftKey) return;     // abriu em nova aba: quem clicou continua no menu
        if(e.target && e.target.closest && e.target.closest('.gn-drop a')) g.classList.add('gn-shut');
      });
      g.addEventListener('mouseleave', function(){ g.classList.remove('gn-shut'); });
    });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape') window.__gnavMob(0); });
    window.addEventListener('resize', function(){ if(window.innerWidth > 900) window.__gnavMob(0); });
  }
  // ── "LUZ LARANJA" NA ABA ATUAL ────────────────────────────────────────────
  // Acende (classe .on) o item da barra do desktop, o item da folha do celular E, quando a
  // página mora dentro de um menu (M&M / P&P / Stock Guide), o PAI do menu + a linha certa
  // da lista. Compara só o PATHNAME (as âncoras #prices/#pulp são seções da mesma página).
  function _path(url){
    try{ return decodeURIComponent(new URL(url, location.href).pathname).toLowerCase(); }
    catch(e){ try{ return new URL(url, location.href).pathname.toLowerCase(); }catch(_){ return ''; } }
  }
  // aba interna que o endereço abre (?tab= — só o Market usa); '' quando não tem
  function _tab(url){ try{ return (new URL(url, location.href).searchParams.get('tab') || '').toLowerCase(); }catch(e){ return ''; } }
  function _markCurrent(){
    var here = _path(location.href);
    if(here === '/' || here === '') here = '/index.html';    // a raiz É a home
    var hash0 = (location.hash || '').toLowerCase();
    var tab0 = _tab(location.href) || 'performance';         // Market sem ?tab= está na Performance
    // folha do celular: mesma régua do desktop — link de seção acende só com a #âncora igual
    // (senão as 4 linhas do M&M acendiam juntas); o TÍTULO do grupo marca "você está aqui".
    [].slice.call(document.querySelectorAll('.gnm-a')).forEach(function(a){
      if(a.hasAttribute('data-nomark')) return;                // linha que é botão (Tutorial), não destino
      if(_path(a.href) !== here) return;
      var h = ''; try{ h = (new URL(a.href, location.href).hash || '').toLowerCase(); }catch(e){}
      var t = _tab(a.href);                                  // abas do Market: acende só a do ?tab= aberto
      a.classList.toggle('on', t ? t === tab0 : (!h || h === hash0));
      var cat = a.previousElementSibling;                    // sobe até o rótulo do grupo
      while(cat && !cat.classList.contains('gnm-cat')) cat = cat.previousElementSibling;
      if(cat && a.classList.contains('sub')) cat.classList.add('on');
    });
    // barra do desktop: links diretos (Home, News Hunter, Market, Calendar, Admin…)
    [].slice.call(document.querySelectorAll('.gnav-menu a.gn-item')).forEach(function(a){
      if(_path(a.href) === here) a.classList.add('on');
    });
    // menus: o PAI acende se qualquer destino dele for esta página; DENTRO da lista acende só
    // a linha da seção aberta (mesma #âncora) — senão as 4 linhas do M&M acendiam juntas.
    var hash = (location.hash || '').toLowerCase();
    [].slice.call(document.querySelectorAll('.gn-group')).forEach(function(g){
      var hit = false;
      [].slice.call(g.querySelectorAll('.gn-drop a')).forEach(function(a){
        var same = _path(a.href) === here;
        if(same) hit = true;
        var h = '';
        try{ h = (new URL(a.href, location.href).hash || '').toLowerCase(); }catch(e){}
        var t = _tab(a.href);                                // Market ▾: a régua é o ?tab=, não a #âncora
        a.classList.toggle('on', same && (t ? t === tab0 : (!!hash && h === hash)));
      });
      var head = g.querySelector('.gn-item'); if(head) head.classList.toggle('on', hit);
    });
  }
  // o Market troca de aba SEM recarregar (history.replaceState não dispara evento nenhum) → ele chama isto
  window.__gnavMarkCurrent = _markCurrent;
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
