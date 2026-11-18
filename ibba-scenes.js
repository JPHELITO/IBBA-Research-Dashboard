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
     pp  Pulp & Paper    → uma FOLHA, com as nervuras (escolha do usuário entre cinco opções de folha):
                           o contorno de cima vira a LINHA DE DESEMPENHO, o de baixo se fecha sobre
                           ela e as nervuras se recolhem; depois a folha volta.
     sg  Stock Guide     → o MURAL das empresas cobertas — o LOGO de cada uma (só o símbolo, sem fundo;
                           /assets/logos/logos.js), todas lado a lado, da que mais sobe à que mais cai —
                           que se desdobra na CURVA DO DIA: cada empresa vira um ponto na altura da sua
                           variação, e a curva leva as cores do heatmap (verde acima do zero, vermelho
                           abaixo). Onde há espaço (a faixa do topo do Stock Guide) os logos seguem ao
                           lado dos seus pontos; no cartão da Home, apertado, ficam só os pontos e os
                           logos voltam no mural. Sem arquivo de logo: uma ficha com o código.

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
/* a FOLHA (Pulp & Paper): o contorno de baixo some quando encosta na linha; as nervuras se recolhem no meio da troca */\
.sc-lf-l{transition:opacity .25s ease;}\
.sc.is-b .sc-lf-l{opacity:0;transition:opacity .4s ease 1.9s;}\
.sc-lf-v{transition:opacity .9s ease 1.1s;}\
.sc.is-b .sc-lf-v{opacity:0;transition:opacity 1s ease .45s;}\
.sc-dot{position:absolute;right:7px;width:7px;height:7px;margin-top:-3.5px;border-radius:50%;background:' + OR + ';box-shadow:0 0 10px 2px rgba(255,85,0,.7);}\
.sc-dot::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:1px solid ' + OR + ';animation:sc-ring 2.6s ease-out infinite;}\
@keyframes sc-ring{0%{transform:scale(.5);opacity:.9;}100%{transform:scale(2.4);opacity:0;}}\
.sc-tag,.sc-ptag{position:absolute;white-space:nowrap;font:700 8.5px/1 "Manrope","Inter",system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.62);}\
.sc-tag{right:22px;transform:translateY(-150%);}\
.sc-tag b,.sc-ptag b{font-weight:800;margin-left:6px;letter-spacing:.02em;}\
.sc-tag b.up,.sc-ptag b.up{color:#2fbf71;}.sc-tag b.dn,.sc-ptag b.dn{color:#ff5d5d;}\
.sc-last{position:absolute;left:0;right:0;height:0;border-top:1px dashed rgba(255,255,255,.16);}\
/* Stock Guide: o MURAL das empresas cobertas (o LOGO de cada uma, só o símbolo, sem fundo), que se desdobra na curva do dia */\
.sc-perf{position:absolute;inset:0;container-type:size;}\
.sc-prof,.sc-wall{position:absolute;inset:0;}\
.sc-perf:not(.on) .sc-prof{display:none;}\
.sc-zero{position:absolute;left:0;right:0;height:0;border-top:1px dashed rgba(255,255,255,.22);}\
.sc-zero::after{content:"0%";position:absolute;right:6px;top:-11px;font:700 7.5px/1 "Manrope","Inter",system-ui,sans-serif;letter-spacing:.06em;color:rgba(255,255,255,.36);}\
.sc-ptag{right:10px;top:5px;}\
.sc-perf.dots .sc-ptag{display:none;}\
/* a curva do dia nas cores do heatmap: verde acima do zero, vermelho abaixo (a luz que percorre é branca) */\
.sc-ln.sc-up{stroke:#2fbf71;}.sc-ln.sc-dn{stroke:#ff5d5d;}\
.sc-hotw{fill:none;stroke:#fff;stroke-width:2.2px;stroke-linejoin:round;stroke-linecap:round;}\
.sc-hotw1{fill:none;stroke:#fff;stroke-opacity:.2;stroke-width:6.5px;stroke-linejoin:round;stroke-linecap:round;}\
.sc-tk{position:absolute;left:0;top:0;width:0;height:0;transform:translate3d(var(--ax,50cqw),var(--ay,50cqh),0);will-change:transform;}\
.sc-tk.up{--c:#2fbf71;}.sc-tk.dn{--c:#ff5d5d;}\
.sc.is-b .sc-perf.on .sc-tk{transform:translate3d(var(--bx),var(--by),0);}\
/* o voo do mural para a curva (e a volta) é uma animação de UMA vez, disparada na virada; depois cada um fica no lugar */\
.sc.to-b .sc-perf.on .sc-tk{animation:sc-fly-b 2.2s cubic-bezier(.65,0,.35,1) both;animation-delay:calc(var(--j,0) * 22ms);}\
.sc.to-a .sc-perf.on .sc-tk{animation:sc-fly-a 2.2s cubic-bezier(.65,0,.35,1) both;animation-delay:calc(var(--j,0) * 22ms);}\
@keyframes sc-fly-b{from{transform:translate3d(var(--ax),var(--ay),0);}to{transform:translate3d(var(--bx),var(--by),0);}}\
@keyframes sc-fly-a{from{transform:translate3d(var(--bx),var(--by),0);}to{transform:translate3d(var(--ax),var(--ay),0);}}\
/* o LOGO. Três camadas: a de fora muda com o tempo da cena, a do meio balança de leve, a de dentro "acende" em sequência */\
.sc-chip{position:absolute;left:calc(var(--lw,32px) / -2);top:calc(var(--s,24px) / -2);width:var(--lw,32px);height:var(--s,24px);\
  transition:opacity .6s ease .45s,transform 1.4s cubic-bezier(.65,0,.35,1) .2s;will-change:transform,opacity;}\
.sc-chip>i{display:block;width:100%;height:100%;animation:sc-bob 5.6s ease-in-out infinite;animation-delay:calc(var(--i,0) * -0.43s);will-change:transform;}\
.sc-chip>i>b{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-weight:inherit;opacity:.9;\
  animation:sc-wave ' + CYCLE + 's linear infinite both;animation-delay:calc(var(--sc-t,0s) + var(--j,0) * 62ms);will-change:transform,opacity;}\
.sc-chip img{display:block;width:100%;height:100%;object-fit:contain;}\
@keyframes sc-wave{0%,3%{transform:scale(1);opacity:.9;}5.5%{transform:scale(1.16);opacity:1;}10%,16.5%{transform:scale(1);opacity:.9;}19%{transform:scale(1.16);opacity:1;}23.5%,100%{transform:scale(1);opacity:.9;}}\
@keyframes sc-bob{0%,100%{transform:translateY(-1.2px);}50%{transform:translateY(1.2px);}}\
/* sem arquivo de logo: uma ficha com o código (quadrada = mineração e aço, redonda = papel e celulose) */\
.sc-chip.txt>i>b{box-sizing:border-box;width:var(--s,24px);margin:0 auto;border:1.5px solid rgba(255,255,255,.4);border-radius:50%;background:#0C0C0E;\
  font:800 calc(var(--s,24px) * .262)/1 "Manrope","Inter",system-ui,sans-serif;letter-spacing:-.015em;color:#fff;}\
.sc-tk.sq .sc-chip.txt>i>b{border-radius:27%;}\
/* o PONTO da empresa na curva (da cor do dia) */\
.sc-pt{position:absolute;left:calc(var(--d,7px) / -2);top:calc(var(--d,7px) / -2);width:var(--d,7px);height:var(--d,7px);border-radius:50%;background:var(--c,#9a9a96);\
  opacity:0;transform:scale(.3);transition:opacity .5s ease .55s,transform .5s ease .55s;will-change:transform,opacity;}\
.sc.is-b .sc-perf.on .sc-pt{opacity:1;transform:none;transition:opacity .5s ease .9s,transform .7s cubic-bezier(.2,.9,.3,1.25) .9s;}\
/* quadro largo (faixa do Stock Guide): na curva o logo fica ao lado do seu ponto — acima de quem sobe, abaixo de quem cai */\
.sc.is-b .sc-perf.on:not(.dots) .sc-chip{transform:translateY(var(--oy,0px)) scale(.82);}\
/* quadro apertado (cartão da Home): na curva ficam só os pontos; os logos voltam no mural */\
.sc.is-b .sc-perf.on.dots .sc-chip{opacity:0;transform:scale(.25);transition:opacity .5s ease 1s,transform 1.5s cubic-bezier(.65,0,.35,1) .1s;}\
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
  var LINE_PP = [84, 92, 86, 98, 108, 100, 114, 124, 116, 132, 126, 140, 152, 144, 160, 172, 186];   // linha ilustrativa de P&P
  var N_MM = RIDGE.length, N_STORE = 37;                                                             // a série real é guardada com 37 pontos
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
  /* linha suave por uma lista de pontos (a curva do dia do Stock Guide) */
  function smoothP(P, f) {
    var n = P.length, s = 'M' + f(P[0][0]) + ' ' + f(P[0][1]), i;
    for (i = 0; i < n - 1; i++) {
      var p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
      s += ' C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + f(p1[1] + (p2[1] - p0[1]) / 6) + ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + f(p2[1] - (p3[1] - p1[1]) / 6) + ' ' + f(p2[0]) + ' ' + f(p2[1]);
    }
    return s;
  }
  /* a troca de forma: um <animate> PARADO, que o relógio dispara (beginElement) nas duas viradas do ciclo e que congela no
     fim. Antes era um <animate> infinito: mesmo "parado" entre as trocas ele acordava o navegador a cada quadro — medido com
     a máquina cheia: 30 quadros/s com ele, 56 sem. Agora só há trabalho durante os ~2 s da troca. */
  function animEl(d) {
    if (REDUCED) return '';
    return '<animate attributeName="d" begin="indefinite" dur="' + MORPH + 's" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.65 0 0.35 1" values="' + d + ';' + d + '"/>';
  }

  /* ═══ MM: a montanha ↔ linha ════════════════════════════════════════════════════════════════ */
  function liveLayer(line, real, lastH) {   // tempo "linha": o último ponto pulsa; com dado real, o rótulo e a variação
    var top = (100 - lastH / VB_H * 100).toFixed(2) + '%';
    return el('sc-st-c', 'position:absolute;inset:0;', '<i class="sc-last" style="top:' + top + '"></i><i class="sc-dot" style="top:' + top + '"></i>'
      + (real && line.label ? '<span class="sc-tag" style="top:' + top + '">' + String(line.label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + (line.pct != null && isFinite(line.pct) ? '<b class="' + (line.pct > 0 ? 'up' : line.pct < 0 ? 'dn' : '') + '">' + (line.pct > 0 ? '+' : '') + (+line.pct).toFixed(1) + '%</b>' : '') + '</span>' : ''));
  }
  function buildLine(sc) {
    var st = sc.__st || (sc.__st = {});
    var line = st.line, real = !!(line && line.h);
    var hB = real ? resample(line.h, N_MM) : LINE_MM, dA = polyD(RIDGE), dB = polyD(hB);
    var id = 'scl' + (++_uid), close = ' L' + VB_W + ' ' + VB_H + ' L0 ' + VB_H + ' Z';
    var b = wantB(), d0 = b ? dB : dA;              // nasce já no tempo certo do ciclo
    phase(sc); sc.__b = b; sc.classList.toggle('is-b', b); sc.classList.remove('to-a', 'to-b', 'sc-morph');
    var art = el('sc-art', '',
      '<svg viewBox="0 0 ' + VB_W + ' ' + VB_H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><path id="' + id + '" vector-effect="non-scaling-stroke" d="' + d0 + '">' + animEl(d0) + '</path>'
      + '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".105"/><stop offset=".75" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'
      + '<path fill="url(#' + id + 'g)" d="' + d0 + close + '">' + animEl(d0 + close) + '</path>'
      + '<g class="sc-st-m"><use href="#' + id + '" class="sc-eco" stroke-opacity=".20" transform="translate(0 20)"/><use href="#' + id + '" class="sc-eco" stroke-opacity=".11" transform="translate(0 44)"/><use href="#' + id + '" class="sc-eco" stroke-opacity=".06" transform="translate(0 72)"/></g>'
      + '<use href="#' + id + '" class="sc-ln" stroke-opacity=".86"/></svg>'
      + '<div class="sc-win"><div><svg viewBox="0 0 ' + VB_W + ' ' + VB_H + '" preserveAspectRatio="none" aria-hidden="true"><use href="#' + id + '" class="sc-hot2"/><use href="#' + id + '" class="sc-hot1"/><use href="#' + id + '" class="sc-hot"/></svg></div></div>');
    sc.innerHTML = ''; sc.appendChild(art); sc.appendChild(liveLayer(line, real, hB[hB.length - 1]));
    var an = art.querySelectorAll('animate');
    st.an = an.length === 2 ? [{ el: an[0], a: dA, b: dB }, { el: an[1], a: dA + close, b: dB + close }] : null;
  }

  /* ═══ PP: a FOLHA com nervuras ↔ linha ══════════════════════════════════════════════════════
     Desenhada num quadro de 360×160 e encaixada SEM deformar no centro do quadro da cena (no cartão da Home ela ocupa quase
     toda a largura; na faixa larga do topo da página fica no meio). Cada parte é uma lista de pontos com a MESMA contagem
     nos dois tempos — o pecíolo e o contorno de cima viram a linha; o contorno de baixo se fecha sobre ela e some; a
     nervura central também; cada nervura lateral se recolhe no seu ponto. `a` = a fração da largura onde o ponto cai na linha. */
  function qb(P0, P1, P2, t) { var u = 1 - t; return [u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0], u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1]]; }
  function qn(P0, P1, P2, t) { var dx = 2 * (1 - t) * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]), dy = 2 * (1 - t) * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1]), l = Math.sqrt(dx * dx + dy * dy) || 1; return [-dy / l, dx / l]; }
  var LEAF = (function () {
    var N = 44, P0 = [86, 130], P1 = [200, 100], P2 = [324, 32], WM = 38, SK = 0.84, A0 = 0.14, up = [], dn = [], mid = [], i, k, s, j;
    for (i = 0; i <= N; i++) {
      var t = i / N, c = qb(P0, P1, P2, t), n = qn(P0, P1, P2, t), w = WM * Math.pow(Math.sin(Math.PI * Math.pow(t, SK)), 0.92);
      up.push([c[0] - n[0] * w, c[1] - n[1] * w]); dn.push([c[0] + n[0] * w, c[1] + n[1] * w]); mid.push(c);
    }
    var a = function (q) { return A0 + (1 - A0) * q / N; }, mk = function () { return { P: [], a: [] }; };
    var main = mk(), low = mk(), rib = mk(), face = mk(), veins = [];
    for (i = 0; i <= 4; i++) { main.P.push([52 + (P0[0] - 52) * i / 4, 142 + (P0[1] - 142) * i / 4]); main.a.push(A0 * i / 4); }      // o pecíolo
    for (i = 1; i <= N; i++) { main.P.push(up[i]); main.a.push(a(i)); }
    for (i = 0; i <= N; i++) { low.P.push(dn[i]); low.a.push(a(i)); rib.P.push(mid[i]); rib.a.push(a(i)); face.P.push(up[i]); face.a.push(a(i)); }
    for (i = N; i >= 0; i--) { face.P.push(dn[i]); face.a.push(a(i)); }
    for (k = 0; k < 6; k++) {
      var tv = 0.13 + 0.118 * k, i0 = Math.round(tv * N), i1 = Math.min(N - 1, Math.round((tv + 0.17) * N));
      for (s = 0; s < 2; s++) {
        var e = (s ? dn : up)[i1], c0 = mid[i0], m = [(c0[0] + e[0]) / 2 + (s ? -2 : 2), (c0[1] + e[1]) / 2 - 4 * (s ? -1 : 1)], V = mk();
        for (j = 0; j <= 6; j++) { V.P.push(qb(c0, m, e, j / 6 * 0.9)); V.a.push(a(i0)); }
        veins.push(V);
      }
    }
    return { main: main, low: low, rib: rib, face: face, veins: veins };
  })();
  /* altura da linha (0 a 300) na fração `a` da largura, suavizada entre os pontos da série */
  function hAt(h, a) {
    var n = h.length - 1, p = Math.max(0, Math.min(1, a)) * n, i = Math.min(n, Math.floor(p)), u = p - i;
    var y0 = h[Math.max(0, i - 1)], y1 = h[i], y2 = h[Math.min(n, i + 1)], y3 = h[Math.min(n, i + 2)];
    return 0.5 * (2 * y1 + (y2 - y0) * u + (2 * y0 - 5 * y1 + 4 * y2 - y3) * u * u + (3 * y1 - y0 - 3 * y2 + y3) * u * u * u);
  }
  function buildLeaf(sc) {
    var st = sc.__st || (sc.__st = {}), line = st.line, real = !!(line && line.h);
    var cw = sc.clientWidth || 300, H = Math.max(40, sc.clientHeight || 130), W = Math.max(60, cw - 11);
    st.W = cw; st.H = H;
    var hs = real ? line.h : resample(LINE_PP, N_STORE), k = Math.min(W / 360, H / 160), ox = (W - 360 * k) / 2, oy = (H - 160 * k) / 2;
    function A(o) { var s = '', i; for (i = 0; i < o.P.length; i++) s += (i ? ' L' : 'M') + f1(ox + o.P[i][0] * k) + ' ' + f1(oy + o.P[i][1] * k); return s; }
    function B(o) { var s = '', i; for (i = 0; i < o.P.length; i++) s += (i ? ' L' : 'M') + f1(o.a[i] * W) + ' ' + f1(H * (1 - hAt(hs, o.a[i]) / 300)); return s; }
    var id = 'scf' + (++_uid), b = wantB(), list = [], vb = '0 0 ' + f1(W) + ' ' + f1(H);
    phase(sc); sc.__b = b; sc.classList.toggle('is-b', b); sc.classList.remove('to-a', 'to-b', 'sc-morph');
    function part(o, tail) { var q = { a: A(o) + (tail || ''), b: B(o) + (tail || '') }; list.push(q); return 'd="' + (b ? q.b : q.a) + '">' + animEl(b ? q.b : q.a); }
    var under = '', i; for (i = 0; i <= 60; i++) under += (i ? ' L' : 'M') + f1(W * i / 60) + ' ' + f1(H * (1 - hAt(hs, i / 60) / 300));
    var html = '<svg viewBox="' + vb + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><path id="' + id + '" vector-effect="non-scaling-stroke" ' + part(LEAF.main) + '</path>'
      + '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".105"/><stop offset=".75" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'
      + '<g class="sc-st-c"><path fill="url(#' + id + 'g)" d="' + under + ' L' + f1(W) + ' ' + f1(H) + ' L0 ' + f1(H) + ' Z"/></g>'
      + '<path fill="#fff" fill-opacity=".06" ' + part(LEAF.face, ' Z') + '</path>'
      + '<path class="sc-eco sc-lf-v" vector-effect="non-scaling-stroke" stroke-opacity=".5" ' + part(LEAF.rib) + '</path>';
    LEAF.veins.forEach(function (v) { html += '<path class="sc-eco sc-lf-v" vector-effect="non-scaling-stroke" stroke-opacity=".42" stroke-linecap="round" ' + part(v) + '</path>'; });
    html += '<path class="sc-ln sc-lf-l" vector-effect="non-scaling-stroke" stroke-opacity=".86" ' + part(LEAF.low) + '</path>'
      + '<use href="#' + id + '" class="sc-ln" stroke-opacity=".86"/></svg>'
      + '<div class="sc-win"><div><svg viewBox="' + vb + '" preserveAspectRatio="none" aria-hidden="true"><use href="#' + id + '" class="sc-hot2"/><use href="#' + id + '" class="sc-hot1"/><use href="#' + id + '" class="sc-hot"/></svg></div></div>';
    var art = el('sc-art', '', html); sc.__lock = false;
    sc.innerHTML = ''; sc.appendChild(art); sc.appendChild(liveLayer(line, real, hAt(hs, 1)));
    var an = art.querySelectorAll('animate');
    st.an = an.length === list.length ? list.map(function (q, n) { return { el: an[n], a: q.a, b: q.b }; }) : null;
  }
  function build(sc, kind) { if (kind === 'sg') buildSG(sc); else if (kind === 'pp') buildLeaf(sc); else buildLine(sc); }

  /* ═══ SG: o mural das empresas cobertas ↔ a curva do dia ════════════════════════════════════ */
  var SG = [['VALE', 'm'], ['CMIN3', 'm'], ['CSNA3', 'm'], ['GGBR4', 'm'], ['USIM5', 'm'], ['TX', 'm'], ['AUGO', 'm'], ['SCCO', 'm'], ['GMEXICOB', 'm'], ['CS', 'm'], ['ERO', 'm'],
            ['HBM', 'm'], ['LUN', 'm'], ['ARA', 'm'], ['VMM', 'm'], ['SUZB3', 'p'], ['KLBN11', 'p'], ['RANI3', 'p'], ['CMPC', 'p'], ['COPEC', 'p']];
  var _moves = null, _sg = [];
  /* o logo de cada empresa: /assets/logos/logos.js (window.IBBA_LOGOS). A cena é sempre preta → a versão para fundo escuro, só o símbolo */
  function logoSrc(code) { var L = (window.IBBA_LOGOS || {})[code]; if (!L) return null; return typeof L === 'string' ? L : (L.markDark || L.mark || null); }
  function mono(t) { return t.replace(/\d+$/, '').slice(0, 4); }
  function known() { var k = 0; if (_moves) SG.forEach(function (c) { var v = _moves[c[0]]; if (v != null && isFinite(v)) k++; }); return k; }
  function token(c, i) {
    var t = el('sc-tk' + (c[1] === 'm' ? ' sq' : ''), '--i:' + i + ';--j:' + i + ';'), chip = el('sc-chip'), a = document.createElement('i'), b = document.createElement('b'), src = logoSrc(c[0]);
    function txt() { chip.classList.add('txt'); b.textContent = mono(c[0]); }
    if (src) {
      var im = document.createElement('img'); im.alt = ''; im.decoding = 'async'; im.draggable = false;
      im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); txt(); };      // arquivo do logo faltando → a ficha com o código
      im.src = src; b.appendChild(im);
    } else txt();
    a.appendChild(b); chip.appendChild(a); t.appendChild(el('sc-pt')); t.appendChild(chip);
    return { t: t };
  }
  function buildSG(sc) {
    var st = sc.__st || (sc.__st = {}), id = 'scp' + (++_uid);
    var box = el('sc-perf'), wall = el('sc-wall');
    var prof = el('sc-st-c sc-prof', '', '<i class="sc-zero"></i>'
      + '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><path id="' + id + '" vector-effect="non-scaling-stroke" d="M0 50 L100 50"/>'
      + '<clipPath id="' + id + 'u"><rect x="-5" y="-5" width="110" height="55"/></clipPath><clipPath id="' + id + 'd"><rect x="-5" y="50" width="110" height="55"/></clipPath>'
      + '<linearGradient id="' + id + 'gu" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="50"><stop offset="0" stop-color="#16a34a" stop-opacity=".5"/><stop offset="1" stop-color="#16a34a" stop-opacity=".03"/></linearGradient>'
      + '<linearGradient id="' + id + 'gd" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="0" y2="100"><stop offset="0" stop-color="#c0392b" stop-opacity=".03"/><stop offset="1" stop-color="#c0392b" stop-opacity=".6"/></linearGradient></defs>'
      + '<path class="sc-ar" fill="url(#' + id + 'gu)" clip-path="url(#' + id + 'u)"/><path class="sc-ar" fill="url(#' + id + 'gd)" clip-path="url(#' + id + 'd)"/>'
      + '<use href="#' + id + '" class="sc-ln sc-up" clip-path="url(#' + id + 'u)"/><use href="#' + id + '" class="sc-ln sc-dn" clip-path="url(#' + id + 'd)"/></svg>'
      + '<div class="sc-win"><div><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><use href="#' + id + '" class="sc-hotw1"/><use href="#' + id + '" class="sc-hotw"/></svg></div></div>'
      + '<span class="sc-ptag"></span>');
    st.path = prof.querySelector('path'); st.zero = prof.querySelector('.sc-zero'); st.tag = prof.querySelector('.sc-ptag');
    st.ar = prof.querySelectorAll('.sc-ar'); st.cu = prof.querySelector('#' + id + 'u rect'); st.cd = prof.querySelector('#' + id + 'd rect');
    st.gu = prof.querySelector('#' + id + 'gu'); st.gd = prof.querySelector('#' + id + 'gd');
    st.tk = {}; st.box = box; st.W = 0;
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
    if ((has && !REDUCED) !== st.on) { buildSG(sc); return; }          // chegou (ou sumiu) o dado: remonta
    var W = sc.clientWidth || 300, Hh = sc.clientHeight || 120, n = SG.length, on = st.on;
    /* mudança pequena de tamanho (o cartão que cresce sob o mouse) NÃO refaz a conta: o mural é um bloco de medida fixa e a
       curva está em fração do quadro — os dois acompanham sozinhos, sem pulo */
    if (st.W && Math.abs(W - st.W) / st.W < 0.3 && Math.abs(Hh - st.H) < 12) { W = st.W; Hh = st.H; } else { st.W = W; st.H = Hh; }
    var rows = SG.map(function (c, i) { var v = _moves ? _moves[c[0]] : null; return { k: c[0], v: (v != null && isFinite(v)) ? +v : null, i: i }; });
    var order = rows.slice();
    if (has) order.sort(function (a, b) { return ((b.v == null ? 0 : b.v) - (a.v == null ? 0 : a.v)) || (a.i - b.i); });   // da que mais sobe à que mais cai
    /* MURAL: a grade que dá o maior logo (até 30px de altura; a caixa do logo é 1,36× mais larga que alta, porque muitos
       símbolos são deitados); empate → menos fileiras; grade completa leva vantagem */
    var g = null, r;
    for (r = 1; r <= 5; r++) {
      var c = Math.ceil(n / r), sr = Math.min(30, Math.floor(Math.min((W - 10) / c / 1.5, (Hh - 8) / r / 1.3))), score = sr + (n % c === 0 ? 0.6 : 0);
      if (!g || score > g.score + 0.001) g = { r: r, c: c, s: sr, score: score };
    }
    var s = Math.max(12, g.s), lw = s * 1.36, row1 = g.r === 1;
    var px = row1 ? Math.min((W - lw - 22) / (n - 1), s * 2) : Math.min((W - 10) / g.c, s * 1.62), py = Math.min((Hh - 8) / g.r, s * 1.36);
    var x0 = row1 ? W - lw / 2 - 12 - (n - 1) * px : (W - (g.c - 1) * px) / 2, y0 = (Hh - (g.r - 1) * py) / 2;
    /* CURVA DO DIA: uma escala só para altas e baixas (o zero cai onde cair) */
    var dots = !row1, d = dots ? Math.max(4.5, Math.min(8, (W - 16) / (n - 1) * 0.6)) : 6.5, sb = s * 0.82;
    var mx = 0.6, mn = -0.6; order.forEach(function (o) { if (o.v != null) { mx = Math.max(mx, o.v); mn = Math.min(mn, o.v); } });
    var yT = dots ? d / 2 + 9 : sb + 13, yB = dots ? Hh - d / 2 - 8 : Hh - sb - 12, Y = function (v) { return yT + (mx - v) / (mx - mn) * (yB - yT); };
    sc.style.setProperty('--s', s + 'px'); sc.style.setProperty('--lw', lw.toFixed(1) + 'px'); sc.style.setProperty('--d', d.toFixed(1) + 'px');
    st.box.classList.toggle('dots', dots);
    var pts = [], up = 0, dn = 0;
    order.forEach(function (o, j) {
      var ax = x0 + (j % g.c) * px, ay = y0 + Math.floor(j / g.c) * py, v = o.v == null ? 0 : o.v;
      var bx = row1 ? ax : 8 + d / 2 + j * (W - 16 - d) / (n - 1), by = Y(v);
      var t = st.tk[o.k].t, z = t.style, isUp = o.v != null && o.v > 0.0001, isDn = o.v != null && o.v < -0.0001;
      /* o MURAL é um bloco de medida fixa (preso ao centro do quadro; a fileira única, à direita): se o quadro alarga —
         mouse em cima, entrada no ambiente — ele vai junto, sem se espalhar. A CURVA, essa sim, ocupa a largura toda. */
      var axv = row1 ? 'calc(100cqw - ' + (W - ax).toFixed(1) + 'px)' : 'calc(50cqw + ' + (ax - W / 2).toFixed(1) + 'px)';
      z.setProperty('--j', j); z.setProperty('--ax', axv); z.setProperty('--ay', pc(ay / Hh) + 'cqh');
      z.setProperty('--bx', row1 ? axv : pc(bx / W) + 'cqw'); z.setProperty('--by', pc(by / Hh) + 'cqh');
      z.setProperty('--oy', ((isDn ? 1 : -1) * (sb / 2 + 8)).toFixed(1) + 'px');      // o logo ao lado do ponto: acima de quem sobe, abaixo de quem cai
      t.classList.toggle('up', isUp); t.classList.toggle('dn', isDn); if (isUp) up++; if (isDn) dn++;
      pts.push([bx / W * 100, by / Hh * 100]);
    });
    if (on) {
      var dd = smoothP(pts, f2), Z = Y(0) / Hh * 100, top = 100, bot = 0;
      pts.forEach(function (q) { top = Math.min(top, q[1]); bot = Math.max(bot, q[1]); });
      st.path.setAttribute('d', dd); st.zero.style.top = Z.toFixed(2) + '%';
      var area = dd + ' L' + f2(pts[pts.length - 1][0]) + ' ' + f2(Z) + ' L' + f2(pts[0][0]) + ' ' + f2(Z) + ' Z';
      st.ar[0].setAttribute('d', area); st.ar[1].setAttribute('d', area);
      st.cu.setAttribute('height', f2(Z + 5)); st.cd.setAttribute('y', f2(Z)); st.cd.setAttribute('height', f2(105 - Z));
      st.gu.setAttribute('y1', f2(Math.min(top, Z - 1))); st.gu.setAttribute('y2', f2(Z)); st.gd.setAttribute('y1', f2(Z)); st.gd.setAttribute('y2', f2(Math.max(bot, Z + 1)));
      st.tag.innerHTML = 'Coverage \u00b7 today<b class="up">' + up + ' \u25b2</b><b class="dn">' + dn + ' \u25bc</b>';
    }
  }

  /* ── o RELÓGIO: duas viradas por ciclo (→ "como está" aos 5 s, → "o que é" aos 13,8 s), contadas a partir do mesmo
        instante da página, para as cenas trocarem JUNTAS. É um setTimeout por virada, não um laço. Chegou atrasado (aba
        em segundo plano), a troca encurta; muito atrasado, só assenta no tempo certo. ─────────────────────────────── */
  var T_B = 5, T_A = 13.8, _timer = 0;
  function phaseNow() { try { return (((performance.now() - T0) / 1000) % CYCLE + CYCLE) % CYCLE; } catch (e) { return 0; } }
  function wantB() { if (REDUCED) return false; var ph = phaseNow(); return ph >= T_B && ph < T_A; }
  function setState(sc, b, dur) {
    sc.__b = b; unlock(sc);
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
    if (kind !== 'sg') sc.__st.line = stored(kind);
    build(sc, kind);
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
      _all.forEach(function (sc) { if (sc.__kind !== kind) return; if (sc.__st.key === key) return; sc.__st.key = key; sc.__st.line = line; build(sc, kind); });
      return true;
    } catch (e) { return false; }
  }
  /* o quadro mudou de tamanho: o mural se reacomoda; a folha é redesenhada só se o formato mudou muito (até 30% ela estica junto) */
  var _rt = 0, _hold = false;
  /* a página pede para segurar o rearranjo enquanto faz uma transição grande (entrar no ambiente): nada pula no meio */
  function hold(v) {
    _hold = !!v;
    /* a FOLHA não estica: enquanto o ambiente se abre (o quadro chega a ficar 3,6× mais largo), o desenho fica preso à
       largura que tinha, no centro do quadro. Só no tempo "o que é" — a linha, essa pode esticar. */
    _all.forEach(function (sc) {
      if (sc.__kind !== 'pp') return;
      var art = sc.querySelector('.sc-art'); if (!art) return;
      if (_hold && !sc.__b) { var w = art.clientWidth; if (w) { art.style.left = '50%'; art.style.right = 'auto'; art.style.width = w + 'px'; art.style.marginLeft = (-w / 2) + 'px'; sc.__lock = true; } }
      else if (!_hold) unlock(sc);
    });
    if (!_hold) refit();
  }
  function unlock(sc) {
    if (!sc.__lock) return; sc.__lock = false;
    var art = sc.querySelector('.sc-art'); if (art) { art.style.left = ''; art.style.right = ''; art.style.width = ''; art.style.marginLeft = ''; }
  }
  function refit() {
    clearTimeout(_rt);
    _rt = setTimeout(function () {
      if (_hold) return;
      _sg.forEach(layoutSG);
      _all.forEach(function (sc) {
        var st = sc.__st; if (sc.__kind !== 'pp' || !st || !st.W) return;
        var w = sc.clientWidth || st.W, h = sc.clientHeight || st.H;
        if (Math.abs(w - st.W) / st.W > 0.3 || Math.abs(h - st.H) > 12) buildLeaf(sc);
      });
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
