/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   IBBA · CENAS VIVAS (nov/2026) — os três "ambientes" da dashboard, desenhados em traço fino
   ───────────────────────────────────────────────────────────────────────────────────────────────
     mm  Metals & Mining  → mina a céu aberto (bancadas), torre de poço com polias girando, correia
                            levando minério à pilha, caminhões fora-de-estrada e a panela vazando aço.
     pp  Pulp & Paper     → floresta de eucalipto em camadas, fábrica com vapor, bobina jumbo girando,
                            folha correndo nos rolos e o caminhão de toras.
     sg  Stock Guide      → fita de velas correndo e as empresas cobertas em órbita (fichas com o
                            código; quando a página informa a variação do dia, o aro pinta de verde
                            ou vermelho — IBBAScenes.setMoves({VALE3:+1.2,...})).
   COMO É FEITO (para não travar): cada peça que se move é um elemento próprio animado SÓ com
   transform/opacity (quem move é a placa de vídeo, não o JavaScript). Nenhum laço de script, nenhum
   canvas. A cena pausa sozinha quando sai da tela, e fica parada com "reduzir movimento" no sistema.
   A cena é sempre desenhada sobre PRETO (palco), nos dois temas.
   Uso: <div data-scene="mm"></div>  →  IBBAScenes.auto()  (ou IBBAScenes.mount(el,'mm')).
   A cena é desenhada numa prancha de 292px de altura e escalada para a altura do contêiner.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.IBBAScenes) return;
  var H = 292;                       // altura da prancha (px de desenho)
  var OR = '#FF5500', W = '#FFFFFF';

  /* ── estilo (uma vez) ─────────────────────────────────────────────────────────────────────── */
  var CSS = '\
.sc{position:absolute;inset:0;overflow:hidden;background:#000;contain:strict;pointer-events:none;isolation:isolate;}\
.sc-board{position:absolute;left:0;bottom:0;height:' + H + 'px;transform-origin:left bottom;transform:scale(var(--sc-k,1));}\
.sc-strip{position:absolute;left:0;bottom:0;height:' + H + 'px;background-repeat:repeat-x;background-position:left bottom;will-change:transform;}\
.sc-obj{position:absolute;right:0;bottom:0;width:560px;height:' + H + 'px;}\
.sc-obj>svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}\
.sc-ln{fill:none;stroke:' + W + ';stroke-width:calc(1.15px / var(--sc-k,1));stroke-linejoin:round;stroke-linecap:round;}\
.sc-ln.o{stroke:' + OR + ';}\
.sc-ln.d{stroke-opacity:.55;}\
.sc-fl{fill:#060606;}\
.sc-mv{position:absolute;left:0;top:0;will-change:transform;}\
.sc-mv>svg{display:block;overflow:visible;}\
.sc-rw{position:absolute;animation:sc-spin var(--t,2.4s) linear infinite;will-change:transform;}\
.sc-rw.r{animation-direction:reverse;}\
.sc-rw>svg{display:block;width:100%;height:100%;overflow:visible;}\
.sc-whl{position:absolute;width:18px;height:18px;border-radius:50%;border:calc(1.15px / var(--sc-k,1)) solid ' + OR + ';background:#060606;animation:sc-spin 1.1s linear infinite;}\
.sc-whl::before,.sc-whl::after{content:"";position:absolute;left:50%;top:50%;width:14px;height:calc(1.15px / var(--sc-k,1));margin:-.6px 0 0 -7px;background:' + OR + ';}\
.sc-whl::after{transform:rotate(90deg);}\
.sc-glow{position:absolute;border-radius:50%;background:radial-gradient(closest-side,rgba(255,120,20,.55),rgba(255,85,0,.16) 45%,rgba(255,85,0,0) 72%);animation:sc-pulse 2.6s ease-in-out infinite;will-change:opacity,transform;}\
.sc-spk{position:absolute;width:0;height:0;animation:sc-spx var(--t,1.1s) linear var(--d,0s) infinite;will-change:transform;}\
.sc-spk>i{position:absolute;left:-1.5px;top:-1.5px;width:3px;height:3px;border-radius:50%;background:#FFB060;box-shadow:0 0 6px 1px rgba(255,120,20,.9);animation:sc-spy var(--t,1.1s) cubic-bezier(.35,0,.85,.55) var(--d,0s) infinite;will-change:transform,opacity;}\
.sc-emb{position:absolute;width:2px;height:2px;border-radius:50%;background:#FF7A2A;opacity:0;animation:sc-emb var(--t,7s) linear var(--d,0s) infinite;will-change:transform,opacity;}\
.sc-ore{position:absolute;width:5px;height:5px;border-radius:1.5px;background:' + OR + ';animation:sc-ore 3.6s linear var(--d,0s) infinite;will-change:transform,opacity;}\
.sc-steam{position:absolute;width:44px;height:44px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,255,255,.34),rgba(255,255,255,.08) 55%,rgba(255,255,255,0) 75%);opacity:0;animation:sc-steam var(--t,6s) ease-out var(--d,0s) infinite;will-change:transform,opacity;}\
.sc-leaf{position:absolute;width:7px;height:3.4px;border-radius:50%;border:1px solid rgba(255,255,255,.55);opacity:0;animation:sc-leaf var(--t,9s) linear var(--d,0s) infinite;will-change:transform,opacity;}\
.sc-leaf.o{border-color:' + OR + ';}\
.sc-flick{position:absolute;animation:sc-flick .9s steps(5,end) infinite;will-change:opacity;}\
.sc-flick>svg{display:block;overflow:visible;}\
.sc-dash{stroke-dasharray:6 8;}\
.sc-veil{position:absolute;inset:0;pointer-events:none;}\
/* órbita das empresas */\
.sc-orbit{position:absolute;left:0;top:0;width:0;height:0;}\
.sc-rot{position:absolute;left:0;top:0;width:0;height:0;animation:sc-spin var(--t,40s) linear var(--d,0s) infinite;will-change:transform;}\
.sc-arm{position:absolute;left:0;top:0;width:0;height:0;}\
.sc-unrot{position:absolute;left:0;top:0;width:0;height:0;animation:sc-spin var(--t,40s) linear var(--d,0s) infinite reverse;will-change:transform;}\
.sc-unsq{position:absolute;left:0;top:0;width:0;height:0;}\
.sc-tok{position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:#070707;border:1.15px solid rgba(255,255,255,.5);\
  display:flex;align-items:center;justify-content:center;font:600 6.6px/1 "Unbounded","Manrope",system-ui,sans-serif;letter-spacing:.01em;color:#fff;\
  animation:sc-depth var(--t,40s) linear var(--d,0s) infinite;will-change:transform,opacity;box-shadow:0 6px 14px -6px #000;}\
.sc-tok.o{border-color:' + OR + ';}\
.sc-tok.up{border-color:#2fbf71;box-shadow:0 0 0 2px rgba(47,191,113,.16),0 6px 14px -6px #000;}\
.sc-tok.dn{border-color:#ff5d5d;box-shadow:0 0 0 2px rgba(255,93,93,.16),0 6px 14px -6px #000;}\
.sc-tok img{width:70%;height:70%;object-fit:contain;border-radius:50%;}\
.sc-core{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:' + OR + ';box-shadow:0 0 18px 4px rgba(255,85,0,.55);}\
.sc-core::after{content:"";position:absolute;inset:-9px;border-radius:50%;border:1px solid ' + OR + ';animation:sc-ring 2.8s ease-out infinite;}\
.sc.sc-off *,.sc.sc-off *::before,.sc.sc-off *::after{animation-play-state:paused!important;}\
@keyframes sc-spin{to{transform:rotate(360deg);}}\
@keyframes sc-drift{to{transform:translate3d(calc(var(--w)*-1),0,0);}}\
@keyframes sc-run{from{transform:translate3d(var(--x0),var(--y,0),0) scale(var(--s,1));}to{transform:translate3d(var(--x1),var(--y,0),0) scale(var(--s,1));}}\
@keyframes sc-pulse{0%,100%{opacity:.75;transform:scale(1);}50%{opacity:1;transform:scale(1.12);}}\
@keyframes sc-spx{from{transform:translate3d(0,0,0);}to{transform:translate3d(var(--dx,30px),0,0);}}\
@keyframes sc-spy{0%{transform:translate3d(0,0,0) scale(1);opacity:1;}35%{transform:translate3d(0,var(--up,-26px),0) scale(.95);opacity:1;}100%{transform:translate3d(0,var(--dn,22px),0) scale(.4);opacity:0;}}\
@keyframes sc-emb{0%{transform:translate3d(0,0,0);opacity:0;}12%{opacity:.9;}100%{transform:translate3d(var(--dx,24px),var(--dy,-150px),0);opacity:0;}}\
@keyframes sc-ore{0%{transform:translate3d(0,0,0);opacity:0;}8%{opacity:1;}72%{transform:translate3d(72px,-58px,0);opacity:1;}100%{transform:translate3d(90px,-28px,0);opacity:0;}}\
@keyframes sc-steam{0%{transform:translate3d(0,0,0) scale(.35);opacity:0;}15%{opacity:.9;}100%{transform:translate3d(var(--dx,46px),-120px,0) scale(1.9);opacity:0;}}\
@keyframes sc-leaf{0%{transform:translate3d(0,0,0) rotate(0deg);opacity:0;}10%{opacity:.9;}100%{transform:translate3d(var(--dx,-160px),var(--dy,170px),0) rotate(540deg);opacity:0;}}\
@keyframes sc-flick{0%{opacity:.82;}20%{opacity:1;}40%{opacity:.9;}60%{opacity:1;}80%{opacity:.86;}100%{opacity:.97;}}\
@keyframes sc-depth{0%{transform:scale(.96);opacity:.9;}25%{transform:scale(1.14);opacity:1;}50%{transform:scale(.96);opacity:.9;}75%{transform:scale(.74);opacity:.5;}100%{transform:scale(.96);opacity:.9;}}\
@keyframes sc-ring{0%{transform:scale(.5);opacity:.9;}100%{transform:scale(2.6);opacity:0;}}\
@media (prefers-reduced-motion:reduce){.sc *,.sc *::before,.sc *::after{animation:none!important;}.sc-steam,.sc-leaf,.sc-emb{opacity:.5;}}';

  function injectCSS() {
    if (document.getElementById('ibba-scenes-css')) return;
    var st = document.createElement('style'); st.id = 'ibba-scenes-css'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── utilidades ───────────────────────────────────────────────────────────────────────────── */
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function uri(svg) { return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")'; }
  var _sw = 1;                       // multiplicador de espessura das telhas (1/escala), definido na montagem
  function svgTile(w, body) { body = body.replace(/stroke-width="([\d.]+)"/g, function (m, v) { return 'stroke-width="' + (parseFloat(v) * _sw).toFixed(2) + '"'; }); return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + H + '" viewBox="0 0 ' + w + ' ' + H + '" fill="none" stroke-linejoin="round" stroke-linecap="round">' + body + '</svg>'; }
  function el(cls, style, html) { var d = document.createElement('div'); if (cls) d.className = cls; if (style) d.style.cssText = style; if (html) d.innerHTML = html; return d; }
  /* faixa que se repete e desliza (paralaxe): anda exatamente uma telha por ciclo → emenda invisível */
  function strip(board, tileW, body, secs, extra) {
    var d = el('sc-strip', 'width:calc(100% + ' + tileW + 'px);background-image:' + uri(svgTile(tileW, body)) + ';background-size:' + tileW + 'px ' + H + 'px;--w:' + tileW + 'px;animation:sc-drift ' + secs + 's linear infinite;' + (extra || ''));
    board.appendChild(d); return d;
  }
  function svgObj(board, body) {
    var o = el('sc-obj', '', '<svg viewBox="0 0 560 ' + H + '" fill="none">' + body + '</svg>');
    board.appendChild(o); return o;
  }
  /* peça que atravessa a cena (caminhão): x0 → x1 em px da prancha, para sempre */
  function runner(parent, html, x0, x1, y, secs, delay, scale, z) {
    var d = el('sc-mv', '--x0:' + x0 + ';--x1:' + x1 + ';--y:' + y + 'px;--s:' + (scale || 1) + ';transform-origin:left bottom;animation:sc-run ' + secs + 's linear ' + (delay || 0) + 's infinite;' + (z != null ? 'z-index:' + z + ';' : ''), html);
    parent.appendChild(d); return d;
  }

  /* roda/polia/bobina que gira: um elemento só seu (a placa de vídeo gira; o desenho grande não é repintado) */
  function wheel(parent, cx, cy, r, secs, inner, rev) {
    var d = el('sc-rw' + (rev ? ' r' : ''), 'left:' + (cx - r) + 'px;top:' + (cy - r) + 'px;width:' + (2 * r) + 'px;height:' + (2 * r) + 'px;--t:' + secs + 's;',
      '<svg viewBox="' + (-r) + ' ' + (-r) + ' ' + (2 * r) + ' ' + (2 * r) + '" fill="none">' + inner + '</svg>');
    parent.appendChild(d); return d;
  }

  /* ═══ MM · mina + aciaria ══════════════════════════════════════════════════════════════════ */
  var TRUCK = '<svg width="96" height="50" viewBox="0 0 96 50" fill="none">'
    + '<path class="sc-ln o sc-fl" d="M26 6 L88 6 L94 12 L84 30 L30 30 Z"/>'            /* caçamba */
    + '<path class="sc-ln o" d="M34 6 L44 -2 L60 -4 L74 0 L84 6" stroke-opacity=".7"/>' /* carga */
    + '<path class="sc-ln o sc-fl" d="M6 14 L22 14 L26 20 L26 34 L4 34 L4 22 Z"/>'      /* cabine */
    + '<path class="sc-ln o" d="M9 18 L19 18 L19 25 L9 25 Z"/>'                         /* janela */
    + '<path class="sc-ln o" d="M2 34 L90 34 M26 30 L26 34"/>'                          /* chassi */
    + '</svg><i class="sc-whl" style="left:10px;top:30px"></i><i class="sc-whl" style="left:60px;top:30px"></i>';

  function sceneMM(board) {
    // bancadas ao fundo (duas linhas de degraus) — a mina a céu aberto
    strip(board, 640,
      '<path stroke="#fff" stroke-opacity=".10" stroke-width="1.1" d="M0 138 L46 138 L60 122 L132 122 L146 104 L226 104 L240 88 L318 88 L332 104 L398 104 L412 122 L486 122 L500 138 L566 138 L580 150 L640 150"/>'
      + '<path stroke="#fff" stroke-opacity=".10" stroke-width="1.1" d="M0 150 L640 150 M60 122 L60 150 M146 104 L146 122 M240 88 L240 104 M412 122 L412 150 M332 104 L332 122"/>'
      + '<path stroke="#fff" stroke-opacity=".17" stroke-width="1.1" d="M0 196 L70 196 L84 180 L190 180 L204 164 L330 164 L344 180 L452 180 L466 196 L560 196 L574 208 L640 208"/>'
      + '<path stroke="#fff" stroke-opacity=".17" stroke-width="1.1" d="M0 208 L640 208 M84 180 L84 208 M204 164 L204 180 M344 180 L344 208"/>'
      + '<path stroke="#FF5500" stroke-opacity=".30" stroke-width="1.1" stroke-dasharray="2 7" d="M0 222 L640 222"/>', 90);
    // chão próximo com pilhas de estéril
    strip(board, 460,
      '<path stroke="#fff" stroke-opacity=".34" stroke-width="1.15" d="M0 250 L460 250"/>'
      + '<path stroke="#fff" stroke-opacity=".30" stroke-width="1.15" fill="#050505" d="M30 250 L52 228 L66 238 L78 226 L104 250 Z M286 250 L300 238 L316 244 L330 250 Z"/>'
      + '<path stroke="#fff" stroke-opacity=".22" stroke-width="1.1" d="M0 262 L24 262 M60 268 L140 268 M210 262 L300 262 M350 270 L440 270"/>', 46);

    var o = svgObj(board,
      /* torre do poço (headframe) */
      '<g transform="translate(84 0)"><path class="sc-ln sc-fl" d="M150 250 L176 92 L206 92 L232 250 Z" stroke-opacity=".85"/>'
      + '<path class="sc-ln d" d="M158 202 L224 202 M165 158 L217 158 M171 122 L211 122 M158 202 L217 158 M224 202 L165 158 M165 158 L211 122 M217 158 L171 122"/>'
      + '<path class="sc-ln" d="M206 92 L296 250" stroke-opacity=".7"/><path class="sc-ln d" d="M232 250 L270 204"/>'
      + '<path class="sc-ln sc-fl" d="M166 92 L216 92 L216 82 L166 82 Z"/>'
      + '<path class="sc-ln o" d="M196 54 L288 250" stroke-opacity=".65"/><path class="sc-ln o sc-dash" d="M184 83 L184 250" stroke-opacity=".7"/></g>'
      /* correia transportadora + pilha */
      + '<g transform="translate(118 50) scale(.8)"><path class="sc-ln" d="M326 244 L420 168 M332 250 L426 174" stroke-opacity=".8"/>'
      + '<path class="sc-ln d" d="M356 226 L356 250 M388 200 L388 250 M356 250 L388 226 M388 250 L356 226"/>'
      + '<circle class="sc-ln" cx="329" cy="247" r="4"/><circle class="sc-ln" cx="423" cy="171" r="4"/>'
      + '<path class="sc-ln o sc-fl" d="M404 250 L440 190 L476 250 Z"/><path class="sc-ln o d" d="M428 210 L436 222 M444 204 L454 228 M432 232 L440 240"/></g>'
      /* ponte rolante + panela vazando */
      + '<g transform="translate(-10 0)"><path class="sc-ln" d="M452 34 L570 34 M452 40 L570 40" stroke-opacity=".75"/><path class="sc-ln d" d="M468 34 L474 40 L480 34 L486 40 L492 34 L498 40 L504 34 L510 40 L516 34 L522 40 L528 34 L534 40 L540 34 L546 40"/>'
      + '<path class="sc-ln sc-fl" d="M486 40 L522 40 L522 52 L486 52 Z"/><path class="sc-ln" d="M494 52 L494 92 M514 52 L514 92"/>'
      + '<g transform="rotate(24 504 104)"><path class="sc-ln o sc-fl" d="M478 92 L530 92 L522 138 L486 138 Z"/><path class="sc-ln o" d="M478 98 L530 98 M474 92 L534 92"/><circle class="sc-ln o sc-fl" cx="504" cy="112" r="4.5"/></g>'
      + '<path class="sc-ln sc-fl" d="M522 234 L568 234 L562 250 L528 250 Z"/><path class="sc-ln o" d="M528 238 L562 238"/></g>');
    wheel(o, 268, 66, 17, 3.2, '<circle class="sc-ln o sc-fl" r="17"/><path class="sc-ln o" d="M-17 0 L17 0 M0 -17 L0 17 M-12 -12 L12 12 M12 -12 L-12 12"/>');
    wheel(o, 298, 74, 10, 2.3, '<circle class="sc-ln sc-fl" r="10"/><path class="sc-ln" d="M-10 0 L10 0 M0 -10 L0 10"/>', 1);
    // o veio de aço líquido: peça própria, que tremula
    o.appendChild(el('sc-flick', 'left:514px;top:100px;', '<svg width="30" height="140" viewBox="524 100 30 140" fill="none"><defs><linearGradient id="scMolten" x1="0" y1="104" x2="0" y2="232" gradientUnits="userSpaceOnUse">'
      + '<stop offset="0" stop-color="#FFD9A0"/><stop offset=".35" stop-color="#FF8A1F"/><stop offset="1" stop-color="#FF5500"/></linearGradient></defs>'
      + '<path d="M530 104 C541 110 545 138 545 232" stroke="url(#scMolten)" stroke-width="4.4" stroke-linecap="round"/></svg>'));

    // brilho no ponto do vazamento + faíscas + brasas
    o.appendChild(el('sc-glow', 'left:475px;top:176px;width:120px;height:120px;'));
    o.appendChild(el('sc-glow', 'left:490px;top:74px;width:64px;height:64px;animation-duration:3.4s;opacity:.7;'));
    var r = rng(7), i;
    for (i = 0; i < 12; i++) {
      var dx = Math.round((r() - .5) * 110), up = -Math.round(14 + r() * 40), dn = Math.round(6 + r() * 26), t = (0.7 + r() * 0.9).toFixed(2);
      o.appendChild(el('sc-spk', 'left:535px;top:232px;--dx:' + dx + 'px;--up:' + up + 'px;--dn:' + dn + 'px;--t:' + t + 's;--d:-' + (r() * 1.6).toFixed(2) + 's;', '<i></i>'));
    }
    for (i = 0; i < 9; i++) {
      o.appendChild(el('sc-emb', 'left:' + Math.round(430 + r() * 110) + 'px;top:' + Math.round(150 + r() * 90) + 'px;--dx:' + Math.round((r() - .5) * 70) + 'px;--dy:-' + Math.round(90 + r() * 130) + 'px;--t:' + (5 + r() * 6).toFixed(1) + 's;--d:-' + (r() * 9).toFixed(1) + 's;'));
    }
    // minério subindo a correia
    for (i = 0; i < 5; i++) o.appendChild(el('sc-ore', 'left:382px;top:240px;--d:-' + (i * 0.72).toFixed(2) + 's;'));

    // caminhões: um perto (da direita para a esquerda), um longe na bancada (no outro sentido, menor)
    runner(board, TRUCK, 'calc(var(--bw) + 40px)', '-140px', 206, 30, -6, 1, 3);
    runner(board, TRUCK, 'calc(var(--bw) + 40px)', '-140px', 206, 30, -21, 1, 3);
    var far = runner(board, TRUCK, '-90px', 'calc(var(--bw) + 60px)', 185, 54, -12, 0.46, 1);
    far.style.opacity = '.5'; far.firstChild.style.transform = 'scaleX(-1)'; far.firstChild.style.transformOrigin = '48px 0';
  }

  /* ═══ PP · floresta + fábrica + bobina ═════════════════════════════════════════════════════ */
  var LOGTRUCK = '<svg width="120" height="50" viewBox="0 0 120 50" fill="none">'
    + '<path class="sc-ln o sc-fl" d="M94 12 L112 12 L116 20 L116 34 L92 34 L92 14 Z"/><path class="sc-ln o" d="M98 16 L109 16 L111 24 L98 24 Z"/>'
    + '<path class="sc-ln o" d="M2 34 L118 34 M8 8 L8 34 M84 8 L84 34"/>'
    + '<g class="sc-ln" stroke-opacity=".9"><circle class="sc-fl" cx="20" cy="27" r="6.5"/><circle class="sc-fl" cx="34" cy="27" r="6.5"/><circle class="sc-fl" cx="48" cy="27" r="6.5"/><circle class="sc-fl" cx="62" cy="27" r="6.5"/><circle class="sc-fl" cx="76" cy="27" r="6.5"/>'
    + '<circle class="sc-fl" cx="27" cy="15.5" r="6.5"/><circle class="sc-fl" cx="41" cy="15.5" r="6.5"/><circle class="sc-fl" cx="55" cy="15.5" r="6.5"/><circle class="sc-fl" cx="69" cy="15.5" r="6.5"/>'
    + '<circle cx="20" cy="27" r="2.4"/><circle cx="48" cy="27" r="2.4"/><circle cx="76" cy="27" r="2.4"/><circle cx="41" cy="15.5" r="2.4"/><circle cx="69" cy="15.5" r="2.4"/></g>'
    + '</svg><i class="sc-whl" style="left:12px;top:30px"></i><i class="sc-whl" style="left:34px;top:30px"></i><i class="sc-whl" style="left:92px;top:30px"></i>';

  function trees(n, tileW, seed, hMin, hMax, op, fill, sw) {
    var r = rng(seed), s = '', i, step = tileW / n;
    for (i = 0; i < n; i++) {
      var x = Math.round(step * i + step * (0.2 + r() * 0.6)), h = Math.round(hMin + r() * (hMax - hMin)), rx = Math.round(7 + r() * 6), ry = Math.round(h * (0.26 + r() * 0.12));
      var top = 250 - h;
      s += '<path stroke="#fff" stroke-opacity="' + op + '" stroke-width="' + sw + '" d="M' + x + ' 250 L' + x + ' ' + (top + ry) + '"/>'
        + '<ellipse cx="' + x + '" cy="' + (top + ry) + '" rx="' + rx + '" ry="' + ry + '" stroke="#fff" stroke-opacity="' + op + '" stroke-width="' + sw + '" fill="' + (fill || 'none') + '"/>'
        + '<path stroke="#fff" stroke-opacity="' + (op * 0.7).toFixed(2) + '" stroke-width="' + sw + '" d="M' + x + ' ' + (top + ry * 1.5) + ' L' + (x - rx * 0.6).toFixed(1) + ' ' + (top + ry * 1.1).toFixed(1) + ' M' + x + ' ' + (top + ry * 1.2).toFixed(1) + ' L' + (x + rx * 0.6).toFixed(1) + ' ' + (top + ry * 0.8).toFixed(1) + '"/>';
    }
    return s;
  }

  function scenePP(board) {
    strip(board, 520, trees(15, 520, 11, 96, 150, 0.11, 'none', 1.05), 110);
    strip(board, 600, trees(11, 600, 29, 130, 196, 0.2, '#040404', 1.1)
      + '<path stroke="#FF5500" stroke-opacity=".28" stroke-width="1.1" stroke-dasharray="2 7" d="M0 236 L600 236"/>', 64);
    strip(board, 460, '<path stroke="#fff" stroke-opacity=".34" stroke-width="1.15" d="M0 250 L460 250"/>'
      + '<path stroke="#fff" stroke-opacity=".22" stroke-width="1.1" d="M10 262 L70 262 M120 268 L230 268 M270 262 L330 262 M360 270 L450 270"/>'
      + '<g stroke="#fff" stroke-opacity=".3" stroke-width="1.1" fill="#050505"><circle cx="40" cy="244" r="6"/><circle cx="53" cy="244" r="6"/><circle cx="46.5" cy="233" r="6"/></g>', 40);

    var o = svgObj(board,
      /* fábrica: digestor, torre, galpão dente-de-serra, chaminé */
      '<path class="sc-ln sc-fl" d="M330 250 L330 128 Q330 108 346 108 Q362 108 362 128 L362 250 Z" stroke-opacity=".85"/>'
      + '<path class="sc-ln d" d="M330 150 L362 150 M330 186 L362 186 M330 222 L362 222 M338 108 L338 96 L354 96 L354 108"/>'
      + '<path class="sc-ln sc-fl" d="M372 250 L372 150 L396 150 L396 250 Z" stroke-opacity=".8"/><path class="sc-ln d" d="M372 176 L396 176 M372 206 L396 206"/>'
      + '<path class="sc-ln o" d="M362 136 L384 136 L384 150" stroke-opacity=".8"/>'
      + '<path class="sc-ln sc-fl" d="M402 250 L402 196 L422 180 L422 196 L442 180 L442 196 L462 180 L462 196 L482 180 L482 196 L506 196 L506 250 Z" stroke-opacity=".85"/>'
      + '<path class="sc-ln d" d="M412 216 L428 216 L428 232 L412 232 Z M440 216 L456 216 L456 232 L440 232 Z M468 216 L484 216 L484 232 L468 232 Z"/>'
      + '<path class="sc-ln sc-fl" d="M518 250 L521 104 L535 104 L538 250 Z" stroke-opacity=".85"/><path class="sc-ln o" d="M520 116 L536 116 M520 124 L536 124"/>'
      /* máquina de papel: bobina jumbo, rolos e a folha */
      + '<path class="sc-ln o" d="M226 180 L150 197 L124 226 L96 197 L64 226 L20 226" stroke-opacity=".9"/>'
      + '<path class="sc-ln d" d="M150 213 L150 250 M124 226 L124 250 M96 213 L96 250 M64 226 L64 250 M52 250 L162 250"/>'
      + '<path class="sc-ln" d="M196 250 L214 228 M256 250 L238 228 M186 250 L266 250"/>');
    wheel(o, 226, 216, 36, 7, '<circle class="sc-ln sc-fl" r="36"/><circle class="sc-ln d" r="27"/><circle class="sc-ln d" r="18"/><path class="sc-ln d" d="M0 -36 L0 36 M-36 0 L36 0 M-25.5 -25.5 L25.5 25.5 M25.5 -25.5 L-25.5 25.5"/><circle class="sc-ln o sc-fl" r="7"/><path class="sc-ln o" d="M0 -7 L0 7"/>');
    [[150, 205, 1], [124, 218, 0], [96, 205, 1], [64, 218, 0]].forEach(function (w) { wheel(o, w[0], w[1], 8, 1.5, '<circle class="sc-ln sc-fl" r="8"/><path class="sc-ln" d="M-8 0 L8 0"/>', w[2]); });

    var r = rng(5), i;
    for (i = 0; i < 4; i++) o.appendChild(el('sc-steam', 'left:506px;top:62px;--dx:' + Math.round(30 + r() * 40) + 'px;--t:' + (5.5 + r() * 2).toFixed(1) + 's;--d:-' + (i * 1.6).toFixed(1) + 's;'));
    for (i = 0; i < 3; i++) o.appendChild(el('sc-steam', 'left:324px;top:58px;width:32px;height:32px;--dx:' + Math.round(20 + r() * 30) + 'px;--t:' + (6.5 + r() * 2).toFixed(1) + 's;--d:-' + (i * 2.2).toFixed(1) + 's;'));
    for (i = 0; i < 8; i++) {
      board.appendChild(el('sc-leaf' + (i % 3 === 0 ? ' o' : ''), 'right:' + Math.round(r() * 520) + 'px;top:' + Math.round(40 + r() * 70) + 'px;--dx:-' + Math.round(80 + r() * 150) + 'px;--dy:' + Math.round(120 + r() * 90) + 'px;--t:' + (8 + r() * 7).toFixed(1) + 's;--d:-' + (r() * 14).toFixed(1) + 's;'));
    }
    runner(board, LOGTRUCK, '-150px', 'calc(var(--bw) + 40px)', 206, 34, -9, 1, 3);
    var far = runner(board, LOGTRUCK, 'calc(var(--bw) + 40px)', '-150px', 213, 60, -30, 0.5, 1);
    far.style.opacity = '.45'; far.firstChild.style.transform = 'scaleX(-1)'; far.firstChild.style.transformOrigin = '60px 0';
  }

  /* ═══ SG · fita de velas + empresas em órbita ══════════════════════════════════════════════ */
  var SG_NAMES = ['VALE3', 'GGBR4', 'CSNA3', 'USIM5', 'CMIN3', 'SUZB3', 'KLBN11', 'RANI3', 'SCCO', 'AUGO', 'TX', 'CMPC', 'COPEC', 'GMEXICOB'];
  var _toks = {};          // código → elementos (para pintar o aro com a variação do dia)
  var LOGOS = {};          // opcional: {VALE3:'/assets/logos/VALE3.svg'} → a ficha mostra a marca

  function candles(tileW, seed) {
    var r = rng(seed), s = '', n = Math.floor(tileW / 22), y = 170, i, ma = '';
    s += '<path stroke="#fff" stroke-opacity=".07" stroke-width="1" stroke-dasharray="2 8" d="M0 96 L' + tileW + ' 96 M0 148 L' + tileW + ' 148 M0 200 L' + tileW + ' 200"/>';
    var y0 = y;
    for (i = 0; i < n; i++) {
      var x = 11 + i * 22, tgt = 170 + Math.sin((i / n) * Math.PI * 2) * 42 + Math.sin((i / n) * Math.PI * 6) * 14;   // fecha o ciclo: a fita emenda
      var open = y, close = tgt + (r() - .5) * 16, hi = Math.min(open, close) - 5 - r() * 12, lo = Math.max(open, close) + 5 + r() * 12;
      var up = close < open, top = Math.min(open, close), hgt = Math.max(3, Math.abs(close - open));
      s += '<path stroke="' + (up ? '#FF5500' : '#fff') + '" stroke-opacity="' + (up ? '.55' : '.26') + '" stroke-width="1.1" d="M' + x + ' ' + hi.toFixed(1) + ' L' + x + ' ' + lo.toFixed(1) + '"/>'
        + '<rect x="' + (x - 5) + '" y="' + top.toFixed(1) + '" width="10" height="' + hgt.toFixed(1) + '" rx="1.2" stroke="' + (up ? '#FF5500' : '#fff') + '" stroke-opacity="' + (up ? '.6' : '.26') + '" stroke-width="1.1" fill="' + (up ? 'rgba(255,85,0,.22)' : '#050505') + '"/>';
      ma += (i ? ' L' : 'M') + x + ' ' + (tgt - 26).toFixed(1);
      y = close;
    }
    s += '<path stroke="#fff" stroke-opacity=".22" stroke-width="1.1" d="' + ma + '"/>';
    return s;
  }

  function sceneSG(board) {
    strip(board, 528, candles(528, 3), 52);
    strip(board, 460, '<path stroke="#fff" stroke-opacity=".3" stroke-width="1.15" d="M0 250 L460 250"/><path stroke="#fff" stroke-opacity=".3" stroke-width="1.1" d="M20 250 L20 256 M112 250 L112 256 M204 250 L204 256 M296 250 L296 256 M388 250 L388 256"/>', 70);
    var CX = 404, CY = 132;
    var ORB = [{ rx: 148, ry: 56, rot: -17, t: 46, n: 5, o: true }, { rx: 122, ry: 48, rot: 24, t: 38, n: 5, o: false }, { rx: 92, ry: 33, rot: -5, t: 30, n: 4, o: true }];
    var svg = '';
    ORB.forEach(function (b) { svg += '<ellipse class="sc-ln' + (b.o ? ' o' : '') + '" stroke-opacity="' + (b.o ? '.85' : '.5') + '" cx="' + CX + '" cy="' + CY + '" rx="' + b.rx + '" ry="' + b.ry + '" transform="rotate(' + b.rot + ' ' + CX + ' ' + CY + ')"/>'; });
    var o = svgObj(board, svg);
    o.appendChild(el('sc-glow', 'left:' + (CX - 60) + 'px;top:' + (CY - 60) + 'px;width:120px;height:120px;opacity:.5;animation-duration:4s;'));
    var core = el('sc-core', 'left:' + CX + 'px;top:' + CY + 'px;'); o.appendChild(core);
    var k = 0;
    ORB.forEach(function (b, bi) {
      var sq = b.ry / b.rx;
      var orbit = el('sc-orbit', 'left:' + CX + 'px;top:' + CY + 'px;transform:rotate(' + b.rot + 'deg) scaleY(' + sq.toFixed(4) + ');');
      for (var j = 0; j < b.n; j++) {
        var name = SG_NAMES[k % SG_NAMES.length]; k++;
        var d = '-' + (b.t * j / b.n + bi * 2.3).toFixed(2) + 's', v = '--t:' + b.t + 's;--d:' + d + ';';
        var rot = el('sc-rot', v), arm = el('sc-arm', 'transform:translateX(' + b.rx + 'px);'), un = el('sc-unrot', v);
        var unsq = el('sc-unsq', 'transform:scaleY(' + (1 / sq).toFixed(4) + ') rotate(' + (-b.rot) + 'deg);');
        var tok = el('sc-tok' + (b.o ? ' o' : ''), v);
        tok.setAttribute('data-tk', name);
        if (LOGOS[name]) { var im = document.createElement('img'); im.alt = name; im.src = LOGOS[name]; tok.appendChild(im); }
        else tok.textContent = name.replace(/\d+$/, '').slice(0, 4);
        (_toks[name] = _toks[name] || []).push(tok);
        unsq.appendChild(tok); un.appendChild(unsq); arm.appendChild(un); rot.appendChild(arm); orbit.appendChild(rot);
      }
      o.appendChild(orbit);
    });
  }

  /* ── montagem ─────────────────────────────────────────────────────────────────────────────── */
  var BUILD = { mm: sceneMM, pp: scenePP, sg: sceneSG };
  var _io = null, _ro = null;
  function fit(sc) {
    var h = sc.clientHeight || H, fx = parseFloat(sc.getAttribute('data-k')), k = fx > 0 ? fx : h / H, b = sc.firstChild;
    sc.style.setProperty('--sc-k', k.toFixed(4));
    if (b) { var bw = Math.ceil((sc.clientWidth || 600) / k); b.style.width = bw + 'px'; b.style.setProperty('--bw', bw + 'px'); }
  }
  function mount(host, kind) {
    if (!host || !BUILD[kind] || host.__scene) return null;
    injectCSS();
    var sc = el('sc sc-' + kind), board = el('sc-board');
    sc.appendChild(board);
    if (host.getAttribute('data-scene-k')) sc.setAttribute('data-k', host.getAttribute('data-scene-k'));
    host.appendChild(sc); host.__scene = sc;
    fit(sc);
    _sw = 1 / (parseFloat(sc.style.getPropertyValue('--sc-k')) || 1);
    BUILD[kind](board);
    _sw = 1;
    try {
      if (!_ro && window.ResizeObserver) _ro = new ResizeObserver(function (es) { es.forEach(function (e) { fit(e.target); }); });
      if (_ro) _ro.observe(sc);
      if (!_io && window.IntersectionObserver) _io = new IntersectionObserver(function (es) { es.forEach(function (e) { e.target.classList.toggle('sc-off', !e.isIntersecting); }); }, { rootMargin: '80px' });
      if (_io) _io.observe(sc);
    } catch (e) {}
    return sc;
  }
  function auto(root) {
    (root || document).querySelectorAll('[data-scene]').forEach(function (h) { mount(h, h.getAttribute('data-scene')); });
  }
  /* a página informa a variação do dia de cada código → o aro da ficha pinta (verde sobe, vermelho cai) */
  function setMoves(map) {
    try {
      Object.keys(_toks).forEach(function (tk) {
        var v = map && (map[tk] != null ? map[tk] : map[tk + '.SA']);
        _toks[tk].forEach(function (t) { t.classList.toggle('up', v > 0.0001); t.classList.toggle('dn', v < -0.0001); if (v != null && isFinite(v)) t.title = tk + ' ' + (v > 0 ? '+' : '') + (+v).toFixed(2) + '%'; });
      });
    } catch (e) {}
  }
  window.IBBAScenes = { mount: mount, auto: auto, setMoves: setMoves, logos: LOGOS, names: SG_NAMES };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { auto(); });
  else auto();
})();
