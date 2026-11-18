/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   IBBA · O HUB — comportamento de APRESENTAÇÃO da Home nova (nov/2026). Nada aqui lê ou grava dado.
     1. luz que acompanha o mouse dentro de cada painel (escreve --mx/--my; quem pinta é o CSS);
     2. ENTRAR NO AMBIENTE: o clique num ambiente (ou num atalho dele) faz o ambiente tomar a laje
        inteira e a mesa descer; só então a página troca — e a View Transition do topnav.js leva
        essa laje até a faixa do topo da página de destino. Ctrl/Shift/clique do meio, celular e
        "reduzir movimento" seguem como link comum, na hora;
     3. as cenas recebem os dados que a própria Home já baixou para o heatmap: a variação do dia
        das empresas cobertas (o mural que vira a curva do dia) e os 12 meses de cada setor
        (a linha em que a montanha e a floresta se transformam).
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var root = document.documentElement;
  function reduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  /* 1 ── luz do mouse (um cálculo por quadro, no máximo) */
  var raf = 0, last = null;
  document.addEventListener('pointermove', function (e) {
    last = e; if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var t = last && last.target && last.target.closest ? last.target.closest('.sec') : null;
      if (!t) return;
      var r = t.getBoundingClientRect(); if (!r.width || !r.height) return;
      t.style.setProperty('--mx', ((last.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      t.style.setProperty('--my', ((last.clientY - r.top) / r.height * 100).toFixed(1) + '%');
    });
  }, { passive: true });

  /* 2 ── entrar no ambiente */
  var ENTRA_MS = 440, going = false;
  function limpa() {
    going = false; root.classList.remove('hub-entra');
    try { window.IBBAScenes && IBBAScenes.hold && IBBAScenes.hold(false); } catch (e) {}
    [].slice.call(document.querySelectorAll('.sector-card.entra')).forEach(function (c) { c.classList.remove('entra'); });
  }
  document.addEventListener('click', function (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('.sector-card a[href]') : null;
    if (!a) return;
    if (a.__hubVai) { a.__hubVai = false; return; }            // 2º clique (o nosso): segue como link comum
    if (e.defaultPrevented || going || window.innerWidth <= 1024 || reduced()) return;
    var card = a.closest('.sector-card'), u;
    try { u = new URL(a.href, location.href); } catch (err) { return; }
    if (!card || u.origin !== location.origin || (a.target && a.target !== '_self')) return;
    e.preventDefault(); e.stopPropagation();
    going = true;
    try { window.IBBAScenes && IBBAScenes.hold && IBBAScenes.hold(true); } catch (err) {}   // as cenas não se rearranjam no meio da entrada
    card.classList.add('entra'); root.classList.add('hub-entra');
    setTimeout(function () {
      a.__hubVai = true;
      try { a.click(); } catch (err) { location.href = a.href; }   // o clique de verdade: o topnav.js acende o menu e a troca acontece
      setTimeout(function () { if (going) limpa(); }, 4000);     // a página não saiu (erro de rede?): desfaz o palco
    }, ENTRA_MS);
  }, true);
  /* voltou com a página guardada na memória (botão Voltar): desfaz a saída */
  window.addEventListener('pageshow', function (e) { if (e.persisted) limpa(); });

  /* 3 ── os dados que a Home JÁ baixou para o heatmap alimentam as cenas (nenhuma consulta nova):
        · Stock Guide: a variação do dia de cada empresa coberta (a altura de cada ficha);
        · Metals & Mining e Pulp & Paper: a linha em que a silhueta se transforma é a de 12 MESES das empresas
          cobertas do setor — cesta de pesos iguais, cada papel na sua moeda (média de preço ÷ preço de 12 meses
          atrás). Só entra papel com a série cobrindo o período inteiro e ainda viva; com menos de 3 papéis a cena
          fica com a linha ilustrativa, SEM rótulo e SEM número (meio dado é pior que dado nenhum). */
  var PP = { SUZB3: 1, KLBN11: 1, RANI3: 1, CMPC: 1, COPEC: 1 };
  function key(t) { return String(t).split('.')[0].toUpperCase(); }
  function basket(kind, cov, pick, label) {
    var now = Date.now() / 1000, ini = now - 365 * 86400, N = 60, sum = [], cnt = 0, i;
    for (i = 0; i < N; i++) sum.push(0);
    _quotes.forEach(function (q) {
      if (!q || !q.ticker || !cov[q.ticker] || !pick(key(q.ticker)) || !q.daily || q.daily.length < 40) return;
      var ms = q.daily[0][0] > 1e11 ? 1000 : 1;
      var pts = q.daily.filter(function (p) { return p && p[0] / ms >= ini && isFinite(p[1]) && p[1] > 0; });
      if (pts.length < 40 || pts[0][0] / ms > ini + 45 * 86400 || pts[pts.length - 1][0] / ms < now - 12 * 86400) return;
      var t0 = pts[0][0], t1 = pts[pts.length - 1][0], base = pts[0][1], j = 0;
      for (var n = 0; n < N; n++) { var tt = t0 + (t1 - t0) * n / (N - 1); while (j < pts.length - 1 && pts[j + 1][0] <= tt) j++; sum[n] += pts[j][1] / base; }
      cnt++;
    });
    if (cnt < 3) return;
    var avg = sum.map(function (s) { return s / cnt; });
    IBBAScenes.setLine(kind, avg, { label: label, pct: (avg[N - 1] / avg[0] - 1) * 100 });
  }
  function feed() {
    try {
      if (typeof _quotes === 'undefined' || !window.IBBAScenes || !_quotes || !_quotes.length) return;
      var list = (typeof COVERAGE !== 'undefined' && COVERAGE && COVERAGE.length) ? COVERAGE : [], cov = {}, m = {};
      list.forEach(function (t) { cov[t] = 1; });
      _quotes.forEach(function (q) { if (q && q.ticker && cov[q.ticker] && q.change_pct != null && isFinite(q.change_pct)) m[key(q.ticker)] = +q.change_pct; });
      IBBAScenes.setMoves(m);
      basket('mm', cov, function (k) { return !PP[k]; }, 'M&M coverage · 12M');
      basket('pp', cov, function (k) { return !!PP[k]; }, 'P&P coverage · 12M');
    } catch (e) {}
  }
  function start() {
    var g = document.getElementById('heatmap-grid');
    if (g && window.MutationObserver) { try { new MutationObserver(feed).observe(g, { childList: true }); } catch (e) {} }
    feed();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
