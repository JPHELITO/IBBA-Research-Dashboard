/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   IBBA · ACABAMENTO DOS GRÁFICOS Chart.js (M&M e P&P) — nov/2026
   ───────────────────────────────────────────────────────────────────────────────────────────────
   Só APARÊNCIA. Nenhum dado, série, eixo, escala, rótulo ou valor de dica muda aqui — o que muda é
   como o mesmo gráfico é desenhado:
     · letra dos gráficos = Inter (a legenda saía na letra padrão da biblioteca);
     · legenda: traço para série de linha (tracejado quando a série é tracejada), quadradinho de
       canto arredondado para barra — no lugar da caixa vazada;
     · dica (tooltip): mesma tinta e mesmo canto das dicas do resto da dashboard, com a cor da
       série numa bolinha cheia;
     · ponto ativo: um anel na cor da série sobre o fundo do cartão + um fio vertical tracejado
       na data sob o mouse (some ao sair);
     · barra: canto de 3px na ponta (em barra empilhada, só na ponta de fora — regra da biblioteca);
     · área: o preenchimento chapado vira um degradê que se desfaz em direção ao eixo.
   Carregado DEPOIS do Chart.js e ANTES do script da página. Se este arquivo faltar, os gráficos
   saem como eram (as páginas testam window.IBBAChart antes de usar).
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!window.Chart) return;
  var FONT = "'Manrope','Inter','Segoe UI',Helvetica,Arial,sans-serif";
  function dark() { return document.documentElement.classList.contains('dark'); }

  function applyDefaults() {
    var d = dark();
    Chart.defaults.font.family = FONT;
    var pt = Chart.defaults.elements.point;
    pt.hoverRadius = 4; pt.hoverBorderWidth = 2;
    pt.hoverBackgroundColor = d ? '#1c2026' : '#FDFCFA';      // o fundo do cartão: o ponto ativo vira um anel
    Chart.defaults.elements.bar.borderRadius = 3;
    var lg = Chart.defaults.plugins.legend.labels;
    lg.usePointStyle = true; lg.boxHeight = 8;
    if (!lg.$ibbaOrig) lg.$ibbaOrig = lg.generateLabels;
    lg.generateLabels = function (chart) {
      var items = lg.$ibbaOrig.call(this, chart);
      try {
        items.forEach(function (it) {
          var ds = (chart.data.datasets || [])[it.datasetIndex] || {};
          var t = ds.type || chart.config.type;
          if (t === 'line') { it.pointStyle = 'line'; it.lineWidth = Math.max(2, +ds.borderWidth || 2); }
          else if (t === 'bar') { it.pointStyle = 'rectRounded'; it.lineWidth = 0; }
        });
      } catch (e) {}
      return items;
    };
  }
  applyDefaults();
  // o tema muda → as cores padrão mudam ANTES de a página redesenhar (este ouvinte foi registrado primeiro)
  window.addEventListener('ibba:theme', applyDefaults);

  // fio vertical na data sob o mouse — atrás das séries, só enquanto a dica está aberta
  Chart.register({
    id: 'ibbaCross',
    beforeDatasetsDraw: function (chart) {
      try {
        var tt = chart.tooltip, act = tt && tt.getActiveElements ? tt.getActiveElements() : [];
        var a = chart.chartArea;
        if (!act.length || !a || !chart.scales || !chart.scales.x) return;
        if ((chart.options || {}).indexAxis === 'y') return;
        var x = act[0].element && act[0].element.x;
        if (!isFinite(x) || x < a.left - 1 || x > a.right + 1) return;
        var c = chart.ctx; x = Math.round(x) + 0.5;
        c.save(); c.beginPath(); c.moveTo(x, a.top); c.lineTo(x, a.bottom);
        c.lineWidth = 1; c.setLineDash([3, 3]);
        c.strokeStyle = dark() ? 'rgba(255,255,255,.22)' : 'rgba(22,25,29,.18)';
        c.stroke(); c.restore();
      } catch (e) {}
    }
  });

  // cor da bolinha da dica: a cor da SÉRIE (da barra, quando cada barra tem a sua), sempre cheia
  function labelColor(ctx) {
    var ds = ctx.dataset || {}, c = ds.borderColor;
    if (typeof c !== 'string' || c === 'transparent' || !ds.borderWidth) {
      var b = ds.backgroundColor;
      b = Array.isArray(b) ? b[ctx.dataIndex] : b;
      if (typeof b === 'string' && b !== 'transparent') c = b;
    }
    if (typeof c !== 'string') c = '#888888';
    // série quase preta sumiria na tinta da dica: ganha um aro claro (a cor de dentro continua a da série)
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c) || /^rgba?\((\d+)\D+(\d+)\D+(\d+)/.exec(c);
    var escuro = false;
    if (m) {
      var hex = c.charAt(0) === '#', r = parseInt(m[1], hex ? 16 : 10), g = parseInt(m[2], hex ? 16 : 10), b2 = parseInt(m[3], hex ? 16 : 10);
      escuro = (0.2126 * r + 0.7152 * g + 0.0722 * b2) < 70;
    }
    return { borderColor: escuro ? 'rgba(255,255,255,.72)' : c, backgroundColor: c, borderWidth: escuro ? 1.5 : 0, borderRadius: 2 };
  }

  window.IBBAChart = {
    /* aparência da dica; a página espalha por cima o que for dela (títulos, valores, filtros) */
    tip: function (mobile) {
      var d = dark();
      return {
        backgroundColor: d ? 'rgba(11,13,17,.96)' : 'rgba(22,25,29,.95)',
        titleColor: 'rgba(255,255,255,.64)', bodyColor: '#fff',
        borderColor: d ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.08)', borderWidth: 1,
        padding: mobile ? { x: 9, y: 7 } : { x: 11, y: 9 }, cornerRadius: 8, caretSize: 5, caretPadding: 7,
        usePointStyle: true, boxWidth: 7, boxHeight: 7, boxPadding: 5, titleMarginBottom: 6, bodySpacing: 4,
        titleFont: { size: mobile ? 9.5 : 10, weight: '600', family: FONT },
        bodyFont: { size: mobile ? 10.5 : 11, weight: '500', family: FONT }
      };
    },
    tipCallbacks: { labelColor: labelColor, labelPointStyle: function () { return { pointStyle: 'circle', rotation: 0 }; } },
    /* preenchimento de área: degradê da cor da série (rgbaFn(alfa) → 'rgba(...)') que se desfaz rumo ao eixo */
    fade: function (rgbaFn, alpha) {
      return function (c) {
        try {
          var ch = c.chart, a = ch.chartArea;
          if (!a) return rgbaFn(alpha);
          var g = ch.ctx.createLinearGradient(0, a.top, 0, a.bottom);
          g.addColorStop(0, rgbaFn(Math.min(1, alpha * 2.2)));
          g.addColorStop(0.6, rgbaFn(alpha * 0.75));
          g.addColorStop(1, rgbaFn(alpha * 0.1));
          return g;
        } catch (e) { return rgbaFn(alpha); }
      };
    }
  };
})();
