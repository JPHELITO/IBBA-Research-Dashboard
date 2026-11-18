/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   IBBA · CENAS DOS AMBIENTES (nov/2026, 2ª versão — MINIMALISTA)
   ───────────────────────────────────────────────────────────────────────────────────────────────
   Pedido do usuário (17/11, depois de ver a 1ª versão cheia de caminhões, faíscas e órbitas):
   "muito pouco profissionais… muito cheio de informação… algo mais minimalista… a silhueta de uma
   montanha se transformando em uma linha de ações… a linha da silhueta ficando mais clara como se
   fosse passando uma linha contornando ela". E, para as empresas: "algo mais minimalista, que misture
   as ideias do universo das nossas commodities, mais próximo de performance das ações… seria muito
   legal se tivéssemos os logos de cada ação coberta". Então cada ambiente é UMA ideia, em dois tempos
   (o que ele É  →  como ele ESTÁ), e os três trocam de tempo juntos:

     mm  Metals & Mining → a crista de uma MONTANHA (com as curvas de nível por dentro) que se assenta
                           e vira uma LINHA DE DESEMPENHO; depois volta.
     pp  Pulp & Paper    → uma fileira de ÁRVORES (copas altas, como eucalipto) que se penteia numa
                           linha suave — a mesma ideia, com a mão da floresta.
     sg  Stock Guide     → o MURAL das empresas cobertas (todas, lado a lado) que se desdobra na CURVA
                           DO DIA: da que mais sobe à que mais cai, cruzando a linha do zero. Fichas
                           QUADRADAS de canto arredondado (lingote) para mineração e aço, REDONDAS
                           (bobina/tora) para papel e celulose; aro verde/vermelho = o dia. Onde há
                           espaço (a faixa do topo do Stock Guide) as fichas seguem inteiras na curva;
                           no cartão da Home, apertado, elas viram pontos. Logo da empresa quando houver
                           arquivo (window.IBBA_LOGOS = {VALE:'/assets/logos/VALE.svg', …}); sem ele, o código.

   Uma LUZ percorre a linha de ponta a ponta (a "linha contornando a silhueta"); no mural, o contorno
   das fichas acende em sequência. O desempenho é REAL quando a página informa
   (IBBAScenes.setLine('mm', valores, {label,pct}) e IBBAScenes.setMoves({VALE:+1.2,…}));
   sem dado, a linha é ilustrativa e NÃO leva rótulo nem número, e o mural simplesmente não vira curva.

   COMO É FEITO (para não travar): o que se move sem parar é só transform/opacity (a luz é uma janela
   que corre sobre uma cópia clara da linha — o brilho são três traços sobrepostos, sem filtro de
   desfoque; as fichas balançam de leve). A troca de tempo é disparada por um RELÓGIO, duas vezes por
   ciclo: a montanha vira linha com uma animação do próprio traçado (SMIL) que só trabalha nos ~2 s da
   troca, e as fichas voam com translate/scale. Entre uma troca e outra nada roda na thread principal.
   Nada de laço de JavaScript, nada de canvas. Todos os relógios partem do mesmo instante da página,
   então as três cenas trocam juntas.
   Pausa fora da tela; com "reduzir movimento" fica o primeiro tempo, parado. Sempre sobre PRETO.
   Uso: <div data-scene="mm"></div> (IBBAScenes.auto() monta sozinho).
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.IBBAScenes) return;
  var OR = '#FF5500', VB_W = 1000, VB_H = 300, CYCLE = 16, MORPH = 2.2;   // ciclo (o que é → como está → o que é) e duração da troca, em segundos
  var REDUCED = false; try { REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var T0 = (window.performance && performance.now) ? performance.now() : 0;

  var CSS = '\
/* cada cena na SUA camada (will-change): a troca de forma redesenha só este quadro. Sem isso o redesenho levava junto um\
   pedaço dos painéis vizinhos, com as sombras grandes do tema claro — medido: 56 quadros/s em 1920×1080; com a camada, 60 */\
.sc{position:absolute;inset:0;overflow:hidden;background:#000;pointer-events:none;contain:strict;will-change:transform;}\
.sc-art{position:absolute;left:0;top:0;bottom:0;right:11px;}\
.sc-art svg,.sc-prof svg{position:absolute;left:0;top:0;width:100%;height:100%;display:block;overflow:visible;}\
.sc-ln{fill:none;stroke:#fff;stroke-width:1.5px;stroke-linejoin:round;stroke-linecap:round;}\
.sc-eco{fill:none;stroke:#fff;stroke-width:1px;stroke-linejoin:round;}\
.sc-hot{fill:none;stroke:#FFC08A;stroke-width:2.2px;stroke-linejoin:round;stroke-linecap:round;}\
.sc-hot1,.sc-hot2{fill:none;stroke:#FF6410;stroke-linejoin:round;stroke-linecap:round;}.sc-hot1{stroke-width:5.5px;stroke-opacity:.30;}.sc-hot2{stroke-width:11px;stroke-opacity:.13;}\
/* a LUZ que contorna a linha: uma janela que corre (transform) sobre a cópia clara, parada no lugar */\
.sc-win{position:absolute;top:-12px;bottom:-12px;left:0;width:26%;overflow:hidden;will-change:transform;\
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 62%,#000 78%,transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 62%,#000 78%,transparent 100%);\
  animation:sc-win 8s cubic-bezier(.45,.05,.4,1) infinite;animation-delay:var(--sc-t,0s);}\
.sc-win>div{position:absolute;top:12px;bottom:12px;left:0;width:384.615%;will-change:transform;animation:sc-win-in 8s cubic-bezier(.45,.05,.4,1) infinite;animation-delay:var(--sc-t,0s);}\
@keyframes sc-win{0%{transform:translateX(-100%);}62%,100%{transform:translateX(384.615%);}}\
@keyframes sc-win-in{0%{transform:translateX(26%);}62%,100%{transform:translateX(-100%);}}\
/* o que só existe num dos dois tempos */\
/* (a classe is-b = "como está"; quem troca é o relógio lá embaixo. Transições, não animações contínuas: fora da virada, nada roda) */\
.sc-st-m{opacity:1;transition:opacity .6s ease 1.85s,visibility 0s linear 1.85s;}\
.sc.is-b .sc-st-m{opacity:0;visibility:hidden;transition:opacity .3s ease,visibility 0s linear .3s;}\
.sc-st-c{opacity:0;visibility:hidden;transition:opacity .45s ease,visibility 0s linear .45s;}\
.sc.is-b .sc-st-c{opacity:1;visibility:visible;transition:opacity .8s ease 1.45s,visibility 0s linear 1.45s;}\
/* durante a troca de forma a luz descansa (ela já está fora do quadro nesse trecho do seu ciclo): menos o que redesenhar */\
.sc.sc-morph .sc-win{visibility:hidden;}\
.sc-dot{position:absolute;right:7px;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:' + OR + ';box-shadow:0 0 10px 2px rgba(255,85,0,.7);}\
.sc-dot::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid ' + OR + ';animation:sc-ring 2.6s ease-out infinite;}\
@keyframes sc-ring{0%{transform:scale(.5);opacity:.9;}100%{transform:scale(2.4);opacity:0;}}\
.sc-tag,.sc-ptag{position:absolute;white-space:nowrap;font:700 8.5px/1 "Manrope","Inter",system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.62);}\
.sc-tag{right:22px;transform:translateY(-150%);}\
.sc-tag b,.sc-ptag b{font-weight:800;margin-left:6px;letter-spacing:.02em;}\
.sc-tag b.up,.sc-ptag b.up{color:#2fbf71;}.sc-tag b.dn,.sc-ptag b.dn{color:#ff5d5d;}\
.sc-last{position:absolute;left:0;right:0;height:0;border-top:1px dashed rgba(255,255,255,.16);}\
/* Stock Guide: o MURAL das empresas cobertas, que se desdobra na curva do dia */\
.sc-perf{position:absolute;inset:0;container-type:size;}\
.sc-prof,.sc-wall{position:absolute;inset:0;}\
.sc-perf:not(.on) .sc-prof{display:none;}\
.sc-zero{position:absolute;left:0;right:0;height:0;border-top:1px dashed rgba(255,255,255,.22);}\
.sc-zero::after{content:"0%";position:absolute;right:6px;top:-11px;font:700 7.5px/1 "Manrope","Inter",system-ui,sans-serif;letter-spacing:.06em;color:rgba(255,255,255,.36);}\
.sc-ptag{right:10px;top:5px;}\
.sc-perf.dots .sc-ptag{display:none;}\
.sc-tk{position:absolute;left:0;top:0;width:0;height:0;transform:translate3d(var(--ax,50cqw),var(--ay,50cqh),0);will-change:transform;}\
.sc.is-b .sc-perf.on .sc-tk{transform:translate3d(var(--bx),var(--by),0) scale(var(--kb,1));}\
/* o voo do mural para a curva (e a volta) é uma animação de UMA vez, disparada na virada; depois a ficha fica no lugar */\
.sc.to-b .sc-perf.on .sc-tk{animation:sc-fly-b 2.2s cubic-bezier(.65,0,.35,1) both;animation-delay:calc(var(--j,0) * 22ms);}\
.sc.to-a .sc-perf.on .sc-tk{animation:sc-fly-a 2.2s cubic-bezier(.65,0,.35,1) both;animation-delay:calc(var(--j,0) * 22ms);}\
@keyframes sc-fly-b{from{transform:translate3d(var(--ax),var(--ay),0) scale(1);}to{transform:translate3d(var(--bx),var(--by),0) scale(var(--kb,1));}}\
@keyframes sc-fly-a{from{transform:translate3d(var(--bx),var(--by),0) scale(var(--kb,1));}to{transform:translate3d(var(--ax),var(--ay),0) scale(1);}}\
/* o contorno de cada ficha acende em sequência (a mesma luz que percorre as linhas) */\
.sc-tk::before{content:"";position:absolute;left:calc(var(--s,24px) / -2 - 2.5px);top:calc(var(--s,24px) / -2 - 2.5px);width:calc(var(--s,24px) + 5px);height:calc(var(--s,24px) + 5px);\
  box-sizing:border-box;border:1.5px solid #FFC08A;border-radius:50%;box-shadow:0 0 9px 1px rgba(255,105,20,.7),inset 0 0 6px rgba(255,105,20,.45);opacity:0;\
  animation:sc-glint ' + CYCLE + 's linear infinite both;animation-delay:calc(var(--sc-t,0s) + var(--j,0) * 62ms);}\
.sc-tk.sq::before{border-radius:30%;}\
.sc.is-b .sc-tk::before{visibility:hidden;}\
@keyframes sc-glint{0%,3%{opacity:0;}5.5%{opacity:1;}10%,16.5%{opacity:0;}19%{opacity:1;}23.5%,100%{opacity:0;}}\
.sc-chip{position:absolute;left:calc(var(--s,24px) / -2);top:calc(var(--s,24px) / -2);width:var(--s,24px);height:var(--s,24px);box-sizing:border-box;\
  display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0C0C0E;border:1.5px solid rgba(255,255,255,.38);border-radius:50%;\
  font:800 calc(var(--s,24px) * .262)/1 "Manrope","Inter",system-ui,sans-serif;letter-spacing:-.015em;color:#fff;\
  animation:sc-bob 5.6s ease-in-out infinite;animation-delay:calc(var(--i,0) * -0.43s);will-change:transform;}\
.sc-tk.sq .sc-chip{border-radius:27%;}\
.sc-tk.up{--c:#2fbf71;}.sc-tk.dn{--c:#ff5d5d;}\
.sc-tk.up .sc-chip,.sc-tk.dn .sc-chip{border-color:var(--c);}\
.sc-chip.logo{background:#fff;}\
.sc-chip img{width:76%;height:76%;object-fit:contain;display:block;}\
/* cartão apertado: na curva do dia a ficha vira um PONTO da cor do dia (o logo volta no mural) */\
.sc-chip::after{content:"";position:absolute;inset:0;background:var(--c,#8c8c88);opacity:0;transition:opacity .8s ease 1.3s;}\
.sc.is-b .sc-perf.on.dots .sc-chip::after{opacity:1;transition:opacity 1s ease .85s;}\
@keyframes sc-bob{0%,100%{transform:translateY(-1.2px);}50%{transform:translateY(1.2px);}}\
.sc.sc-off *,.sc.sc-off *::before,.sc.sc-off *::after{animation-play-state:paused!important;}\
@media (prefers-reduced-motion:reduce){.sc *,.sc *::before,.sc *::after{animation:none!important;transition:none!important;}.sc-win{display:none;}.sc-st-c{opacity:0;}}';

  function injectCSS() {
    if (document.getElementById('ibba-scenes-css')) return;
    var st = document.createElement('style'); st.id = 'ibba-scenes-css'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  function el(cls, style, html) { var d = document.createElement('div'); if (cls) d.className = cls; if (style) d.style.cssText = style; if (html) d.innerHTML = html; return d; }
  var _uid = 0;
  /* todos os relógios da cena partem do mesmo instante da página → as três cenas trocam de tempo juntas,
     mesmo quando uma delas é remontada depois (dado novo) */
  function phase(sc) {
    var ph = 0; try { ph = (((performance.now() - T0) / 1000) % CYCLE + CYCLE) % CYCLE; } catch (e) {}
    sc.style.setProperty('--sc-t', '-' + ph.toFixed(2) + 's');
    return ph;
  }

  /* ── as duas silhuetas e as linhas ilustrativas (alturas em unidades de 0 a 300, do chão para cima) ── */
  var RIDGE = [14, 20, 15, 26, 21, 34, 27, 46, 38, 62, 52, 84, 70, 112, 92, 80, 118, 150, 134, 182, 210, 194, 244, 268, 232, 242, 190, 156, 168, 134, 152, 182, 148, 116, 124, 90, 76];
  var LINE_MM = [70, 78, 72, 84, 80, 92, 88, 97, 90, 104, 112, 106, 118, 126, 117, 110, 124, 133, 128, 142, 150, 141, 156, 149, 162, 174, 166, 158, 172, 186, 178, 194, 188, 204, 216, 208, 232];
  var LINE_PP = [84, 92, 86, 98, 108, 100, 114, 124, 116, 132, 126, 140, 152, 144, 160, 172, 186];   // linha ilustrativa (reamostrada para o nº de árvores)
  var N_MM = RIDGE.length, N_STORE = 37;                                                             // a série real é guardada com 37 pontos
  /* nº de árvores conforme o formato do quadro (faixa larga pede mais árvores, senão viram morros) */
  function treeCount(sc) { var w = sc.clientWidth || 400, h = sc.clientHeight || 150; return Math.max(10, Math.min(46, Math.round(w / Math.max(18, h * 0.19)))); }
  function treeTops(n) {   // alturas das copas: aleatório com semente fixa, crescendo da esquerda para a direita
    var s = 20261117, out = [], i;
    for (i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; var t = n > 1 ? i / (n - 1) : 0, e = t * t * (3 - 2 * t); out.push(Math.round(250 * (0.40 + 0.56 * e) * (0.80 + 0.40 * (s / 4294967296)))); }
    return out;
  }
  function resample(h, n) { var out = [], i; for (i = 0; i < n; i++) { var p = i * (h.length - 1) / (n - 1), a = Math.floor(p), b = Math.min(h.length - 1, a + 1); out.push(h[a] + (h[b] - h[a]) * (p - a)); } return out; }

  function f1(v) { return (Math.round(v * 10) / 10).toString(); }
  function f2(v) { return (Math.round(v * 100) / 100).toString(); }
  /* valores reais → N alturas entre 64 e 240 (a forma da série; a escala não aparece) */
  function shape(vals, n) {
    var v = (vals || []).map(Number).filter(function (x) { return isFinite(x); });
    if (v.length < 8) return null;
    var out = [], i, mn = Infinity, mx = -Infinity;
    for (i = 0; i < n; i++) { var p = i * (v.length - 1) / (n - 1), a = Math.floor(p), b = Math.min(v.length - 1, a + 1), y = v[a] + (v[b] - v[a]) * (p - a); out.push(y); mn = Math.min(mn, y); mx = Math.max(mx, y); }
    if (!(mx > mn)) return null;
    return out.map(function (y) { return 64 + (y - mn) / (mx - mn) * 176; });
  }
  /* montanha/linha angulosa: N pontos igualmente espaçados */
  function polyD(h) { var s = '', i, n = h.length; for (i = 0; i < n; i++) s += (i ? ' L' : 'M') + f1(i * VB_W / (n - 1)) + ' ' + f1(VB_H - h[i]); return s; }
  /* floresta: cada copa é uma folha alta e pontuda (cipreste/eucalipto) entre dois pontos do chão */
  function treesD(tops) {
    var n = tops.length, w = VB_W / n, s = 'M0 ' + f1(VB_H - 4), i;
    for (i = 0; i < n; i++) { var x0 = i * w, x1 = x0 + w, cy = VB_H - 4 - (tops[i] - 4) * 1.333; s += ' C' + f1(x0 + w * 0.40) + ' ' + f1(cy) + ' ' + f1(x1 - w * 0.40) + ' ' + f1(cy) + ' ' + f1(x1) + ' ' + f1(VB_H - 4); }
    return s;
  }
  /* linha suave por uma lista de pontos (mesma estrutura de comandos da floresta → uma vira a outra) */
  function smoothP(P, f) {
    var n = P.length, s = 'M' + f(P[0][0]) + ' ' + f(P[0][1]), i;
    for (i = 0; i < n - 1; i++) {
      var p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
      s += ' C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + f(p1[1] + (p2[1] - p0[1]) / 6) + ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + f(p2[1] - (p3[1] - p1[1]) / 6) + ' ' + f(p2[0]) + ' ' + f(p2[1]);
    }
    return s;
  }
  function smoothD(h) { var w = VB_W / (h.length - 1); return smoothP(h.map(function (v, i) { return [i * w, VB_H - v]; }), f1); }
  /* a troca de forma: um <animate> PARADO, que o relógio dispara (beginElement) nas duas viradas do ciclo e que congela no
     fim. Antes era um <animate> infinito: mesmo "parado" entre as trocas ele acordava o navegador a cada quadro — medido com
     a máquina cheia: 30 quadros/s com ele, 56 sem. Agora só há trabalho durante os ~2 s da troca. */
  function animEl(d) {
    if (REDUCED) return '';
    return '<animate attributeName="d" begin="indefinite" dur="' + MORPH + 's" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.65 0 0.35 1" values="' + d + ';' + d + '"/>';
  }

  /* ═══ MM e PP: silhueta ↔ linha ═════════════════════════════════════════════════════════════ */
  function buildLine(sc, kind) {
    var st = sc.__st || (sc.__st = {});
    var line = st.line, real = !!(line && line.h);
    var dA, dB, lastH;
    var nT = 0;
    if (kind === 'mm') { var hB = real ? resample(line.h, N_MM) : LINE_MM; dA = polyD(RIDGE); dB = polyD(hB); lastH = hB[hB.length - 1]; }
    else { nT = treeCount(sc); st.nT = nT; var hP = resample(real ? line.h : LINE_PP, nT + 1); dA = treesD(treeTops(nT)); dB = smoothD(hP); lastH = hP[hP.length - 1]; }
    var id = 'scl' + (++_uid), close = ' L' + VB_W + ' ' + VB_H + ' L0 ' + VB_H + ' Z';
    var b = wantB(), d0 = b ? dB : dA;              // nasce já no tempo certo do ciclo
    phase(sc); sc.__b = b; sc.classList.toggle('is-b', b); sc.classList.remove('to-a', 'to-b', 'sc-morph');
    var eco = kind === 'mm'
      ? '<use href="#' + id + '" class="sc-eco" stroke-opacity=".20" transform="translate(0 20)"/><use href="#' + id + '" class="sc-eco" stroke-opacity=".11" transform="translate(0 44)"/><use href="#' + id + '" class="sc-eco" stroke-opacity=".06" transform="translate(0 72)"/>'
      : '<use href="#' + id + '" class="sc-eco" stroke-opacity=".17" transform="translate(' + f1(VB_W / nT / 2) + ' 78) scale(1 .74)"/>';
    var art = el('sc-art', '',
      '<svg viewBox="0 0 ' + VB_W + ' ' + VB_H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><path id="' + id + '" vector-effect="non-scaling-stroke" d="' + d0 + '">' + animEl(d0) + '</path>'
      + '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".105"/><stop offset=".75" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'
      + '<path fill="url(#' + id + 'g)" d="' + d0 + close + '">' + animEl(d0 + close) + '</path>'
      + '<g class="sc-st-m">' + eco + '</g>'
      + '<use href="#' + id + '" class="sc-ln" stroke-opacity=".86"/></svg>'
      + '<div class="sc-win"><div><svg viewBox="0 0 ' + VB_W + ' ' + VB_H + '" preserveAspectRatio="none" aria-hidden="true"><use href="#' + id + '" class="sc-hot2"/><use href="#' + id + '" class="sc-hot1"/><use href="#' + id + '" class="sc-hot"/></svg></div></div>');
    // tempo "linha": o último ponto pulsa; com dado real, o rótulo e a variação
    var top = (100 - lastH / VB_H * 100).toFixed(2) + '%';
    var live = el('sc-st-c', 'position:absolute;inset:0;', '<i class="sc-last" style="top:' + top + '"></i><i class="sc-dot" style="top:' + top + '"></i>'
      + (real && line.label ? '<span class="sc-tag" style="top:' + top + '">' + String(line.label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + (line.pct != null && isFinite(line.pct) ? '<b class="' + (line.pct > 0 ? 'up' : line.pct < 0 ? 'dn' : '') + '">' + (line.pct > 0 ? '+' : '') + (+line.pct).toFixed(1) + '%</b>' : '') + '</span>' : ''));
    sc.innerHTML = ''; sc.appendChild(art); sc.appendChild(live);
    var an = art.querySelectorAll('animate');
    st.an = an.length === 2 ? [{ el: an[0], a: dA, b: dB }, { el: an[1], a: dA + close, b: dB + close }] : null;
  }

  /* ═══ SG: o mural das empresas cobertas ↔ a curva do dia ════════════════════════════════════ */
  var SG = [['VALE', 'm'], ['CMIN3', 'm'], ['CSNA3', 'm'], ['GGBR4', 'm'], ['USIM5', 'm'], ['TX', 'm'], ['AUGO', 'm'], ['SCCO', 'm'], ['GMEXICOB', 'm'], ['CS', 'm'], ['ERO', 'm'],
            ['HBM', 'm'], ['LUN', 'm'], ['ARA', 'm'], ['VMM', 'm'], ['SUZB3', 'p'], ['KLBN11', 'p'], ['RANI3', 'p'], ['CMPC', 'p'], ['COPEC', 'p']];
  var _moves = null, _sg = [];
  function logos() { return window.IBBA_LOGOS || {}; }
  function mono(t) { return t.replace(/\d+$/, '').slice(0, 4); }
  function known() { var k = 0; if (_moves) SG.forEach(function (c) { var v = _moves[c[0]]; if (v != null && isFinite(v)) k++; }); return k; }
  function token(c, i) {
    var t = el('sc-tk' + (c[1] === 'm' ? ' sq' : ''), '--i:' + i + ';--j:' + i + ';'), chip = el('sc-chip');
    var src = logos()[c[0]];
    if (src) {
      chip.className += ' logo'; var im = document.createElement('img'); im.alt = ''; im.decoding = 'async';
      im.onerror = function () { chip.classList.remove('logo'); chip.textContent = mono(c[0]); };      // arquivo do logo faltando → o código
      im.src = src; chip.appendChild(im);
    } else chip.textContent = mono(c[0]);
    t.appendChild(chip);
    return { t: t };
  }
  function buildSG(sc) {
    var st = sc.__st || (sc.__st = {}), id = 'scp' + (++_uid);
    var box = el('sc-perf'), wall = el('sc-wall');
    var prof = el('sc-st-c sc-prof', '', '<i class="sc-zero"></i>'
      + '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><path id="' + id + '" vector-effect="non-scaling-stroke" d="M0 50 L100 50"/></defs><use href="#' + id + '" class="sc-ln" stroke-opacity=".46" style="stroke-width:1.2px"/></svg>'
      + '<div class="sc-win"><div><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><use href="#' + id + '" class="sc-hot2"/><use href="#' + id + '" class="sc-hot1"/><use href="#' + id + '" class="sc-hot"/></svg></div></div>'
      + '<span class="sc-ptag"></span>');
    st.path = prof.querySelector('path'); st.zero = prof.querySelector('.sc-zero'); st.tag = prof.querySelector('.sc-ptag');
    st.tk = {}; st.box = box;
    SG.forEach(function (c, i) { var o = token(c, i); wall.appendChild(o.t); st.tk[c[0]] = o; });
    box.appendChild(prof); box.appendChild(wall);
    st.on = known() >= 3 && !REDUCED;            // com dado: o mural vira curva; sem dado, fica o mural
    box.classList.toggle('on', st.on);
    phase(sc); sc.__b = wantB(); sc.classList.toggle('is-b', sc.__b); sc.classList.remove('to-a', 'to-b');
    sc.innerHTML = ''; sc.appendChild(box);
    if (_sg.indexOf(sc) < 0) _sg.push(sc);
    layoutSG(sc);
  }
  function pc(x) { return (x * 100).toFixed(2); }
  function layoutSG(sc) {
    var st = sc.__st; if (!st || !st.tk) return;
    var has = known() >= 3;
    if ((has && !REDUCED) !== st.on) { buildSG(sc); return; }          // chegou (ou sumiu) o dado: remonta para os relógios partirem juntos
    var W = sc.clientWidth || 300, Hh = sc.clientHeight || 120, n = SG.length, on = st.on;
    /* mudança pequena de tamanho (o cartão que cresce sob o mouse) NÃO refaz a conta: o mural é um bloco de medida fixa e a
       curva está em fração do quadro — os dois acompanham sozinhos, sem pulo */
    if (st.W && Math.abs(W - st.W) / st.W < 0.3 && Math.abs(Hh - st.H) < 12) { W = st.W; Hh = st.H; } else { st.W = W; st.H = Hh; }
    var rows = SG.map(function (c, i) { var v = _moves ? _moves[c[0]] : null; return { k: c[0], v: (v != null && isFinite(v)) ? +v : null, i: i }; });
    var order = rows.slice();
    if (has) order.sort(function (a, b) { return ((b.v == null ? 0 : b.v) - (a.v == null ? 0 : a.v)) || (a.i - b.i); });   // da que mais sobe à que mais cai
    /* MURAL: a grade que dá a maior ficha (até 30px); empate → menos fileiras; grade completa leva vantagem */
    var g = null, r;
    for (r = 1; r <= 5; r++) {
      var c = Math.ceil(n / r), cell = Math.min((W - 10) / c, (Hh - 8) / r), sr = Math.min(30, Math.floor(cell * 0.8)), score = sr + (n % c === 0 ? 0.6 : 0);
      if (!g || score > g.score + 0.001) g = { r: r, c: c, s: sr, score: score };
    }
    var s = Math.max(12, g.s), row1 = g.r === 1;
    var px = row1 ? Math.min((W - s - 22) / (n - 1), s * 2) : Math.min((W - 10) / g.c, s * 1.5), py = Math.min((Hh - 8) / g.r, s * 1.34);
    var x0 = row1 ? W - s / 2 - 12 - (n - 1) * px : (W - (g.c - 1) * px) / 2, y0 = (Hh - (g.r - 1) * py) / 2;
    /* CURVA DO DIA: uma escala só para altas e baixas (o zero cai onde cair); fileira única → as fichas só sobem/descem */
    var pitchB = row1 ? px : (W - 16) / (n - 1), dots = !row1;
    var d = dots ? Math.max(4.5, Math.min(9, pitchB * 0.62)) : s, kb = d / s;
    var mx = 0.6, mn = -0.6; order.forEach(function (o) { if (o.v != null) { mx = Math.max(mx, o.v); mn = Math.min(mn, o.v); } });
    var yT = d / 2 + 9, yB = Hh - d / 2 - 8, Y = function (v) { return yT + (mx - v) / (mx - mn) * (yB - yT); };
    sc.style.setProperty('--s', s + 'px');
    st.box.classList.toggle('dots', dots);
    var pts = [], up = 0, dn = 0;
    order.forEach(function (o, j) {
      var ax = x0 + (j % g.c) * px, ay = y0 + Math.floor(j / g.c) * py;
      var bx = row1 ? ax : 8 + d / 2 + j * (W - 16 - d) / (n - 1), by = Y(o.v == null ? 0 : o.v);
      var t = st.tk[o.k].t, z = t.style;
      z.setProperty('--j', j); z.setProperty('--kb', kb.toFixed(3));
      /* o MURAL é um bloco de medida fixa (preso ao centro do quadro; a fileira única, à direita): se o quadro alarga —
         mouse em cima, entrada no ambiente — ele vai junto, sem se espalhar. A CURVA, essa sim, ocupa a largura toda. */
      var axv = row1 ? 'calc(100cqw - ' + (W - ax).toFixed(1) + 'px)' : 'calc(50cqw + ' + (ax - W / 2).toFixed(1) + 'px)';
      z.setProperty('--ax', axv); z.setProperty('--ay', pc(ay / Hh) + 'cqh');
      z.setProperty('--bx', row1 ? axv : pc(bx / W) + 'cqw'); z.setProperty('--by', pc(by / Hh) + 'cqh');
      var isUp = o.v != null && o.v > 0.0001, isDn = o.v != null && o.v < -0.0001;
      t.classList.toggle('up', isUp); t.classList.toggle('dn', isDn); if (isUp) up++; if (isDn) dn++;
      pts.push([bx / W * 100, by / Hh * 100]);
    });
    if (on) {
      st.path.setAttribute('d', smoothP(pts, f2)); st.zero.style.top = pc(Y(0) / Hh) + '%';
      st.tag.innerHTML = 'Coverage · today<b class="up">' + up + ' ▲</b><b class="dn">' + dn + ' ▼</b>';
    }
  }

  /* ── o RELÓGIO: duas viradas por ciclo (→ "como está" aos 5 s, → "o que é" aos 13,8 s), contadas a partir do mesmo
        instante da página, para as cenas trocarem JUNTAS. É um setTimeout por virada, não um laço. Chegou atrasado (aba
        em segundo plano), a troca encurta; muito atrasado, só assenta no tempo certo. ─────────────────────────────── */
  var T_B = 5, T_A = 13.8, _timer = 0;
  function phaseNow() { try { return (((performance.now() - T0) / 1000) % CYCLE + CYCLE) % CYCLE; } catch (e) { return 0; } }
  function wantB() { if (REDUCED) return false; var ph = phaseNow(); return ph >= T_B && ph < T_A; }
  function setState(sc, b, dur) {
    sc.__b = b;
    sc.classList.toggle('is-b', b);
    sc.classList.toggle('to-b', b && dur > 0); sc.classList.toggle('to-a', !b && dur > 0);
    var st = sc.__st; if (!st || !st.an) return;
    clearTimeout(st.mt);
    if (dur > 0) { sc.classList.add('sc-morph'); st.mt = setTimeout(function () { sc.classList.remove('sc-morph'); }, dur * 1000 + 90); } else sc.classList.remove('sc-morph');
    st.an.forEach(function (o) {
      try { o.el.setAttribute('dur', Math.max(0.02, dur).toFixed(2) + 's'); o.el.setAttribute('values', b ? o.a + ';' + o.b : o.b + ';' + o.a); o.el.beginElement(); } catch (e) {}
    });
  }
  function tick() {
    clearTimeout(_timer); _timer = 0;
    if (REDUCED || !_all.length) return;
    var ph = phaseNow(), b = ph >= T_B && ph < T_A;
    var since = b ? ph - T_B : (ph >= T_A ? ph - T_A : ph + CYCLE - T_A), dur = since < MORPH - 0.35 ? MORPH - since : 0;
    var hidden = false; try { hidden = document.hidden; } catch (e) {}
    _all.forEach(function (sc) { if (sc.__b !== b) setState(sc, b, (hidden || sc.classList.contains('sc-off')) ? 0 : dur); });
    var next = b ? T_A - ph : (ph < T_B ? T_B - ph : CYCLE - ph + T_B);
    _timer = setTimeout(tick, Math.max(60, next * 1000 + 20));
  }
  try { document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); }); } catch (e) {}

  /* ── montagem ─────────────────────────────────────────────────────────────────────────────── */
  var _io = null, _all = [];
  function stored(kind) { try { var j = JSON.parse(sessionStorage.getItem('ibba_scene_' + kind) || 'null'); if (j && j.h && j.h.length === N_STORE) return j; } catch (e) {} return null; }
  function mount(host, kind) {
    if (!host || host.__scene || ['mm', 'pp', 'sg'].indexOf(kind) < 0) return null;
    injectCSS();
    var sc = el('sc sc-' + kind); sc.__kind = kind; sc.__st = {};
    host.appendChild(sc); host.__scene = sc; _all.push(sc);
    if (kind === 'sg') buildSG(sc); else { sc.__st.line = stored(kind); buildLine(sc, kind); }
    if (!_timer) tick();
    try { if (_ro) _ro.observe(sc); } catch (e) {}
    try {
      if (!_io && window.IntersectionObserver) _io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          e.target.classList.toggle('sc-off', !e.isIntersecting);
        });
      }, { rootMargin: '80px' });
      if (_io) _io.observe(sc);
    } catch (e) {}
    return sc;
  }
  function auto(root) { (root || document).querySelectorAll('[data-scene]').forEach(function (h) { mount(h, h.getAttribute('data-scene')); }); }

  /* a página informa a variação do dia de cada código → o mural ordena, pinta os aros e passa a virar a curva do dia */
  function setMoves(map) {
    try {
      var m = {}; Object.keys(map || {}).forEach(function (k) { var v = +map[k]; if (map[k] != null && isFinite(v)) m[String(k).split('.')[0].toUpperCase()] = v; });
      _moves = m; _sg.forEach(layoutSG);
      try { sessionStorage.setItem('ibba_scene_moves', JSON.stringify(m)); } catch (e) {}
    } catch (e) {}
  }
  /* a página informa a série REAL (ex.: 12 meses das empresas cobertas do setor) → a silhueta passa a virar ESSA linha */
  function setLine(kind, values, opts) {
    try {
      var h = (kind === 'mm' || kind === 'pp') ? shape(values, N_STORE) : null; if (!h) return false;
      var line = { h: h.map(function (v) { return Math.round(v * 10) / 10; }), label: (opts && opts.label) || '', pct: opts && opts.pct != null ? +opts.pct : null };
      var key = JSON.stringify(line);
      try { sessionStorage.setItem('ibba_scene_' + kind, key); } catch (e) {}
      _all.forEach(function (sc) { if (sc.__kind !== kind) return; if (sc.__st.key === key) return; sc.__st.key = key; sc.__st.line = line; buildLine(sc, kind); });
      return true;
    } catch (e) { return false; }
  }
  /* o quadro mudou de tamanho: o mural se reacomoda; a floresta refaz a conta de árvores se o formato mudou muito */
  var _rt = 0, _hold = false;
  /* a página pede para segurar o rearranjo enquanto faz uma transição grande (entrar no ambiente): nada pula no meio */
  function hold(v) { _hold = !!v; if (!_hold) refit(); }
  function refit() {
    clearTimeout(_rt);
    _rt = setTimeout(function () {
      if (_hold) return;
      _sg.forEach(layoutSG);
      _all.forEach(function (sc) { if (sc.__kind === 'pp' && sc.__st && sc.__st.nT && Math.abs(treeCount(sc) - sc.__st.nT) > 3) buildLine(sc, 'pp'); });
    }, 180);
  }
  window.addEventListener('resize', refit);
  var _ro = null; try { if (window.ResizeObserver) _ro = new ResizeObserver(refit); } catch (e) {}

  /* FAIXA DO AMBIENTE: mostra a aba em que você está (Prices, Imports, Comp Table…) e o nome entra a cada troca.
     Só lê a classe da aba ativa que a página já mantém — nenhuma função da página muda. */
  function bandSync() {
    try {
      var into = document.querySelector('.ibba-band-in'); if (!into || into.querySelector('.ibba-band-sec')) return;
      var nav = document.querySelector('.secondary-nav') || document.querySelector('.wrap > .sg-tabs'); if (!nav) return;
      var lab = el('ibba-band-sec'); into.appendChild(lab);
      var set = function () {
        var a = nav.querySelector('.snav-btn.active, .sg-tab.active'), txt = a ? (a.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (!txt || lab.getAttribute('data-t') === txt) return;
        lab.setAttribute('data-t', txt); lab.textContent = txt;
        lab.classList.remove('in'); void lab.offsetWidth; lab.classList.add('in');
      };
      if (window.MutationObserver) new MutationObserver(set).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
      set();
    } catch (e) {}
  }
  function boot() {
    try { var m = JSON.parse(sessionStorage.getItem('ibba_scene_moves') || 'null'); if (m && typeof m === 'object') _moves = m; } catch (e) {}
    auto(); bandSync();
  }
  window.IBBAScenes = { mount: mount, auto: auto, setMoves: setMoves, setLine: setLine, hold: hold, phase: phaseNow, names: SG.map(function (c) { return c[0]; }) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
