/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   IBBA · O HUB — comportamento de APRESENTAÇÃO da Home nova (nov/2026). Nada aqui lê ou grava dado.
     1. luz que acompanha o mouse dentro de cada painel (escreve --mx/--my; quem pinta é o CSS);
     2. ENTRAR NO AMBIENTE: o clique num ambiente (ou num atalho dele) faz o ambiente tomar a laje
        inteira e a mesa descer; só então a página troca — e a View Transition do topnav.js leva
        essa laje até a faixa do topo da página de destino. Ctrl/Shift/clique do meio, celular e
        "reduzir movimento" seguem como link comum, na hora;
     3. as fichas das empresas do ambiente Stock Guide recebem a variação do dia que a própria
        Home já baixou para o heatmap (aro verde/vermelho).
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
    card.classList.add('entra'); root.classList.add('hub-entra');
    setTimeout(function () {
      a.__hubVai = true;
      try { a.click(); } catch (err) { location.href = a.href; }   // o clique de verdade: o topnav.js acende o menu e a troca acontece
      setTimeout(function () { if (going) limpa(); }, 4000);     // a página não saiu (erro de rede?): desfaz o palco
    }, ENTRA_MS);
  }, true);
  /* voltou com a página guardada na memória (botão Voltar): desfaz a saída */
  window.addEventListener('pageshow', function (e) { if (e.persisted) limpa(); });

  /* 3 ── variação do dia nas fichas do ambiente Stock Guide (os mesmos números do heatmap) */
  function moves() {
    try {
      if (typeof _quotes === 'undefined' || !window.IBBAScenes || !_quotes || !_quotes.length) return;
      var m = {};
      _quotes.forEach(function (q) { if (q && q.ticker && q.change_pct != null && isFinite(q.change_pct)) m[String(q.ticker).split('.')[0].toUpperCase()] = +q.change_pct; });
      IBBAScenes.setMoves(m);
    } catch (e) {}
  }
  function start() {
    var g = document.getElementById('heatmap-grid');
    if (g && window.MutationObserver) { try { new MutationObserver(moves).observe(g, { childList: true }); } catch (e) {} }
    moves();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
