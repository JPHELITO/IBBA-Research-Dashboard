/* =============================================================================
 * topnav.js — BARRA DE NAVEGAÇÃO GLOBAL (mesma de todas as páginas).
 * Inclua em qualquer página: <script src="/topnav.js"></script> (depois do supabase-js).
 * Auto-injeta no topo do <body>. Usa window.sbAuth (se existir) p/ revelar a aba Admin.
 * Fonte ÚNICA da nav → editar aqui muda em todo o dashboard. (A HOME tem a sua própria
 * barra integrada ao header com escala; as demais páginas usam esta.)
 * ========================================================================== */
;(function () {
  if (window.__TOPNAV_LOADED__) return; window.__TOPNAV_LOADED__ = true;

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
  };
  window.__syncThemeIcon = function(){
    var on=document.documentElement.classList.contains('dark');
    var ic=document.getElementById('gnav-theme-ic'); if(ic) ic.innerHTML = on?SVG_SUN:SVG_MOON;
    var b=document.getElementById('gnav-theme'); if(b) b.title = on?'Switch to light':'Switch to dark';
  };

  var TEAM = [
    { ini:'DS', name:'Daniel Sasson',     photo:'/assets/team-daniel.jpg',  email:'daniel.sasson@itaubba.com',    wa:'5511996741242' },
    { ini:'MF', name:'Marcelo Furlan',    photo:'/assets/team-marcelo.jpg', email:'marcelo.palhares@itaubba.com', wa:'5511974642801' },
    { ini:'JH', name:'João Paulo Helito', photo:'/assets/team-joao.jpg',    email:'joao.helito@itaubba.com',      wa:'5511934527535' },
  ];
  var SVG_EMAIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
  var SVG_WA = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.52 3.48A11.94 11.94 0 0 0 12.07.13C5.5.13.18 5.46.18 12.03c0 2.12.55 4.18 1.6 6L0 24l6.18-1.62a11.93 11.93 0 0 0 5.89 1.5h.01c6.57 0 11.9-5.33 11.9-11.89 0-3.18-1.24-6.16-3.46-8.51zM12.07 21.78h-.01a9.84 9.84 0 0 1-5.02-1.38l-.36-.21-3.67.96.98-3.57-.24-.37a9.83 9.83 0 0 1-1.51-5.18c0-5.45 4.43-9.88 9.88-9.88 2.64 0 5.12 1.03 6.99 2.9a9.82 9.82 0 0 1 2.89 6.99c0 5.45-4.43 9.74-9.93 9.74zm5.42-7.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15s-.77.97-.94 1.17c-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.79.37-.27.3-1.04 1.01-1.04 2.47s1.07 2.87 1.22 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35z"/></svg>';

  var CSS = '\
.gnav{background:#111;display:flex;align-items:center;gap:14px;padding:0 28px;height:54px;\
  font-family:Inter,"Segoe UI",Helvetica,Arial,sans-serif;position:relative;z-index:500;}\
.gnav-brand{display:flex;align-items:center;gap:9px;flex-shrink:0;}\
.gnav-brand b{font-size:13.5px;font-weight:700;color:#fff;letter-spacing:.04em;white-space:nowrap;}\
.gnav-mark{width:26px;height:26px;border-radius:6px;background:#FF5000;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;flex-shrink:0;}\
.gnav-menu{display:flex;align-items:center;gap:1px;margin-left:16px;}\
.gn-item{font-size:11.5px;font-weight:600;letter-spacing:.03em;color:rgba(255,255,255,.72);text-decoration:none;\
  padding:7px 11px;border-radius:6px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:4px;transition:color .15s,background .15s;}\
.gn-item:hover{color:#fff;background:rgba(255,255,255,.08);}\
.gn-group{position:relative;}\
.gn-drop{position:absolute;top:100%;left:0;min-width:210px;background:#fff;border:1px solid #E3E3E3;border-radius:9px;\
  box-shadow:0 12px 34px rgba(0,0,0,.20);padding:6px;display:none;z-index:600;}\
.gn-group:hover .gn-drop{display:block;}\
.gn-drop a{display:block;font-size:11.5px;color:#2C2C2C;text-decoration:none;padding:8px 12px;border-radius:6px;font-weight:500;white-space:nowrap;}\
.gn-drop a:hover{background:#F4F3F0;color:#FF5000;}\
.gn-cat{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:#8C8C8C;padding:5px 12px 3px;}\
.gn-admin{color:#ff7a45!important;border:1px solid rgba(255,80,0,.45);margin-left:4px;}\
.gnav-team{display:flex;align-items:center;gap:13px;margin-left:auto;}\
.gnt{display:flex;align-items:center;gap:5px;}\
.gnt-av{width:23px;height:23px;border-radius:50%;object-fit:cover;background:#FF5000;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}\
.gnt-name{font-size:10px;color:rgba(255,255,255,.78);font-weight:500;white-space:nowrap;}\
.gnt-b{width:19px;height:19px;border-radius:5px;border:1px solid rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.55);text-decoration:none;}\
.gnt-b:hover{color:#fff;border-color:rgba(255,255,255,.45);}\
.gnt-b svg{width:11px;height:11px;}\
.gnt-b.wa:hover{color:#25D366;border-color:#25D366;}\
.gnav-out{font:600 11px Inter,sans-serif;color:rgba(255,255,255,.45);background:none;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:6px 12px;cursor:pointer;margin-left:14px;}\
.gnav-out:hover{color:#fff;border-color:rgba(255,255,255,.4);}\
.gnav-theme{flex-shrink:0;width:30px;height:28px;display:inline-flex;align-items:center;justify-content:center;background:none;border:1px solid rgba(255,255,255,.15);border-radius:6px;color:rgba(255,255,255,.6);cursor:pointer;margin-left:14px;transition:color .15s,border-color .15s;}\
.gnav-theme:hover{color:#fff;border-color:rgba(255,255,255,.42);}\
.gnav-theme svg{width:15px;height:15px;display:block;}\
.gnav-rule{height:2px;background:#FF5000;}\
@media(max-width:900px){.gnav,.gnav-rule{display:none!important;}}\
@media(min-width:901px){.header,.top-bar,.orange-rule,#app>.sticky-header{display:none!important;}}';

  var NAV = '\
<div class="gnav">\
  <a class="gnav-brand" href="/index.html" style="text-decoration:none"><span class="gnav-mark">i</span><b>ITAÚ BBA M&amp;M | P&amp;P</b></a>\
  <nav class="gnav-menu">\
    <a class="gn-item" href="/index.html">Home</a>\
    <div class="gn-group"><span class="gn-item">M&amp;M ▾</span><div class="gn-drop"><div class="gn-cat">Steel &amp; Mining</div>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#prices">Prices</a>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#domestic">Domestic Market</a>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#imports">Imports</a>\
      <a href="/Steel and Mining/steel_sm_dashboard.html#exports">Exports</a></div></div>\
    <div class="gn-group"><span class="gn-item">P&amp;P ▾</span><div class="gn-drop"><div class="gn-cat">Pulp &amp; Paper</div>\
      <a href="/Pulp and Paper/pp_dashboard.html#pulp">Pulp</a>\
      <a href="/Pulp and Paper/pp_dashboard.html#paper">Paper &amp; Packaging</a></div></div>\
    <a class="gn-item" href="/news.html">News Hunter</a>\
    <a class="gn-item" href="/stock-guide.html">Stock Guide</a>\
    <a class="gn-item" href="/market.html">Market</a>\
    <a class="gn-item gn-admin" id="gnav-admin" href="/admin.html" style="display:none">Admin</a>\
  </nav>\
  <div class="gnav-team" id="gnav-team"></div>\
  <button class="gnav-theme" id="gnav-theme" onclick="__toggleTheme()" title="Toggle dark mode" aria-label="Toggle dark mode"><svg id="gnav-theme-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>\
  <button class="gnav-out" onclick="(window.sbAuth?sbAuth.auth.signOut():0); document.cookie=\'sb-access-token=; Max-Age=0; Path=/\'; location.replace(\'/login.html\');">Sign out</button>\
</div><div class="gnav-rule"></div>';

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }

  function renderTeam(){
    var el = document.getElementById('gnav-team'); if(!el) return;
    el.innerHTML = TEAM.map(function(p){ return '\
      <div class="gnt" title="'+esc(p.name)+'">\
        '+(p.photo ? '<img class="gnt-av" src="'+p.photo+'" alt="'+esc(p.name)+'" onerror="this.outerHTML=\'<div class=&quot;gnt-av&quot;>'+p.ini+'</div>\'">' : '<div class="gnt-av">'+p.ini+'</div>')+'\
        <span class="gnt-name">'+esc(p.name)+'</span>\
        <a class="gnt-b" href="mailto:'+p.email+'" title="'+p.email+'">'+SVG_EMAIL+'</a>\
        <a class="gnt-b wa" href="https://wa.me/'+p.wa+'" target="_blank" rel="noopener" title="WhatsApp">'+SVG_WA+'</a>\
      </div>'; }).join('');
  }
  function revealAdmin(){
    try{ if(window.sbAuth && sbAuth.rpc){ sbAuth.rpc('get_my_role').then(function(r){
      if(r && r.data === 'admin'){ var a=document.getElementById('gnav-admin'); if(a) a.style.display='inline-flex'; }
    }).catch(function(){}); } }catch(e){}
  }
  function inject(){
    if(document.querySelector('.gnav')) return;
    var st=document.createElement('style'); st.textContent=CSS; document.head.appendChild(st);
    var orig=document.body.firstChild;
    var wrap=document.createElement('div'); wrap.innerHTML=NAV;
    [].slice.call(wrap.childNodes).forEach(function(n){ document.body.insertBefore(n, orig); });  // barra + régua no topo, em ordem
    renderTeam(); revealAdmin(); if(window.__syncThemeIcon) window.__syncThemeIcon();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
