/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — motor da "mesa de leitura" das abas de dados (M&M e P&P)
   ────────────────────────────────────────────────────────────────────────────
   Plano: IBBA-Dashboard/data-desk/PLANO.md · chave: data_desk (admin vê sempre; ?desk=0 força a tela antiga)

   Três partes, nesta ordem:
     (a) NÚCLEO PURO  (IBBADesk.core)  — eixo de meses, períodos (mês/trimestre/ano), janelas, somas,
         variações. Não toca na tela: é o que os testes exercitam (tests/test_data_desk.html).
     (b) GRÁFICOS     — fábrica Chart.js com a régua nova (PLANO 5.9.1): sem linha pontilhada; o
         período sob o mouse ganha uma FAIXA suave, as outras barras recuam, um anel marca o ponto.
     (c) INTERFACE    — tiles, palco, faixa de período, painel de leitura, "quem", miniaturas.

   A página continua dona dos FILTROS (Product, Granularity, Window, datas): os botões de sempre
   chamam as funções de sempre; a mesa só LÊ esse estado (cfg.state()) e redesenha. Nada de dado
   novo aqui dentro: cada página declara o seu catálogo (IBBADesk.mount).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.IBBADesk) return;

  /* ══ (a) NÚCLEO PURO ═══════════════════════════════════════════════════════ */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WIN_MO = { '5y': 60, '3y': 36, '1y': 12, '6m': 6, '3m': 3 };

  function ymIndex(ym) { return (+ym.slice(0, 4)) * 12 + (+ym.slice(5, 7)) - 1; }
  function ymOf(i) { var y = Math.floor(i / 12), m = i % 12 + 1; return y + '-' + (m < 10 ? '0' : '') + m; }
  /* eixo contínuo de meses 'AAAA-MM' entre dois extremos (inclusive) */
  function axis(from, to) { var a = [], i = ymIndex(from), e = ymIndex(to); for (; i <= e; i++) a.push(ymOf(i)); return a; }
  /* { 'AAAA-MM': valor } → vetor alinhado ao eixo (null onde não há dado) */
  function align(map, ax) { var o = new Array(ax.length); for (var i = 0; i < ax.length; i++) { var v = map ? map[ax[i]] : null; o[i] = (v == null || !isFinite(v)) ? null : +v; } return o; }

  /* períodos da granularidade: só os COMPLETOS (trimestre com 3 meses, ano com 12) — regra de sempre */
  function buildPeriods(ax, gran, withPartial) {
    var P = [], i;
    if (gran === 'monthly') {
      for (i = 0; i < ax.length; i++) { var y0 = +ax[i].slice(0, 4), m0 = +ax[i].slice(5, 7);
        P.push({ a: i, b: i, y: y0, k: m0 - 1, key: ax[i], label: MON[m0 - 1] + '-' + String(y0).slice(2) }); }
      return P;
    }
    var need = gran === 'quarterly' ? 3 : 12, g = {}, order = [];
    for (i = 0; i < ax.length; i++) {
      var y = +ax[i].slice(0, 4), m = +ax[i].slice(5, 7), q = Math.ceil(m / 3), id = gran === 'quarterly' ? y * 10 + q : y;
      if (!g[id]) { g[id] = { y: y, q: q, idx: [] }; order.push(id); }
      g[id].idx.push(i);
    }
    order.forEach(function (id, oi) { var o = g[id], part = o.idx.length !== need;
      /* o período EM ANDAMENTO (último, incompleto) só entra a pedido, marcado como parcial */
      if (part && !(withPartial && oi === order.length - 1 && oi > 0)) return;
      var pr = gran === 'quarterly'
        ? { a: o.idx[0], b: o.idx[o.idx.length - 1], y: o.y, k: o.q - 1, key: o.y + '-Q' + o.q, label: o.q + 'Q' + String(o.y).slice(2) }
        : { a: o.idx[0], b: o.idx[o.idx.length - 1], y: o.y, k: 0, key: String(o.y), label: String(o.y) };
      if (part) { pr.partial = true; pr.months = o.idx.length; pr.label += gran === 'quarterly' ? ' QTD' : ' YTD'; }
      P.push(pr); });
    return P;
  }
  function perYear(gran) { return gran === 'monthly' ? 12 : gran === 'quarterly' ? 4 : 1; }

  /* janela em MESES do eixo [m0, m1]. `last` = índice do último mês com dado.
     Botões fixos: do último mês para trás, INCLUINDO o mês de corte (3M = 4 pontos, como sempre foi).
     YTD = o ano do ÚLTIMO DADO (antes era o ano do relógio: em janeiro o gráfico ficava vazio). */
  function monthWindow(ax, last, st) {
    var n = ax.length, m0 = 0, m1 = last;
    if (st.win === 'custom') {
      if (st.from) { m0 = 0; while (m0 < n && ax[m0] < st.from) m0++; }
      if (st.to) { m1 = n - 1; while (m1 >= 0 && ax[m1] > st.to) m1--; }
      if (m0 > n - 1) m0 = n - 1; if (m1 < 0) m1 = 0; if (m0 > m1) m0 = m1;
    } else if (st.win === 'ytd') { var y = ax[last].slice(0, 4); m0 = ax.indexOf(y + '-01'); if (m0 < 0) m0 = 0; }
    else if (WIN_MO[st.win]) m0 = Math.max(0, last - WIN_MO[st.win]);
    return [m0, m1];
  }
  /* períodos mostrados: os que TERMINAM dentro da janela de meses */
  function periodWindow(P, m0, m1) {
    var i0 = -1, i1 = -1, i;
    for (i = 0; i < P.length; i++) if (P[i].b >= m0 && P[i].b <= m1) { if (i0 < 0) i0 = i; i1 = i; }
    if (i0 < 0) { for (i = P.length - 1; i >= 0; i--) if (P[i].b <= m1) { i0 = i1 = i; break; } if (i0 < 0) i0 = i1 = Math.max(0, P.length - 1); }
    return [i0, i1];
  }

  /* agregadores: recebem um vetor MENSAL e devolvem um vetor por período */
  function aggregators(P, PER) {
    function sum(a) { return P.map(function (p) { var s = 0; for (var i = p.a; i <= p.b; i++) { if (a[i] == null) return null; s += a[i]; } return s; }); }
    function last(a) { return P.map(function (p) { return a[p.b]; }); }
    function roll(v) { return v.map(function (_, i) { if (i < PER - 1 || P[i].partial) return null; var s = 0; for (var k = i - PER + 1; k <= i; k++) { if (v[k] == null) return null; s += v[k]; } return s; }); }
    function rollAvg(v) { return roll(v).map(function (x) { return x == null ? null : x / PER; }); }
    return {
      level: { sum: sum, last: last, ltm: false },
      /* últimos 12 meses (4 trimestres): soma p/ fluxo; `last` vira a média móvel do período */
      ltm: { sum: function (a) { return roll(sum(a)); }, last: function (a) { return rollAvg(last(a)); }, ltm: true }
    };
  }
  var F = {
    div: function (n, d, k) { k = k == null ? 1 : k; return n.map(function (x, i) { return (x == null || !d[i]) ? null : x / d[i] * k; }); },
    sub: function (a, b) { return a.map(function (x, i) { return (x == null || b[i] == null) ? null : x - b[i]; }); },
    add: function (a, b) { return a.map(function (x, i) { return (x == null || b[i] == null) ? null : x + b[i]; }); },
    mul: function (a, b) { return a.map(function (x, i) { return (x == null || b[i] == null) ? null : x * b[i]; }); }
  };
  function lastIdx(a) { for (var i = a.length - 1; i >= 0; i--) if (a[i] != null) return i; return -1; }
  /* variação entre o período i e i-k: % para níveis; diferença para pp e para spreads */
  function change(v, i, k, M) { var a = v[i], b = v[i - k]; if (a == null || b == null) return null; return (M && (M.pp || M.diff)) ? a - b : (b ? (a / Math.abs(b) - (b < 0 ? -1 : 1)) * 100 : null); }
  function rangeN(a, i, n) {
    if (a[i] == null) return null; var sl = [], k;
    for (k = Math.max(0, i - n + 1); k <= i; k++) if (a[k] != null) sl.push(a[k]);
    var mn = Math.min.apply(null, sl), mx = Math.max.apply(null, sl);
    return { mn: mn, mx: mx, pos: mx > mn ? (a[i] - mn) / (mx - mn) : .5, rank: sl.filter(function (v) { return v > a[i]; }).length + 1, n: sl.length };
  }
  function fmt(v, d) { return (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function pct(v, d) { return (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d) + '%'; }
  function chgTxt(M, v) { if (v == null || !isFinite(v)) return '—'; var s = v > 0 ? '+' : v < 0 ? '−' : ''; return M.pp ? s + Math.abs(v).toFixed(1) + ' pp' : M.diff ? s + fmt(Math.abs(v), M.dec || 0) : pct(v); }
  function cls(v) { return (v == null || !isFinite(v) || v === 0) ? '' : v > 0 ? 'dk-up' : 'dk-dn'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

  var COUNTRY_EN = {"Aland, Ilhas": "Åland Islands", "Albânia": "Albania", "Alemanha": "Germany", "Andorra": "Andorra", "Antígua e Barbuda": "Antigua and Barbuda", "Argentina": "Argentina", "Argélia": "Algeria", "Armênia": "Armenia", "Aruba": "Aruba", "Arábia Saudita": "Saudi Arabia", "Austrália": "Australia", "Azerbaijão": "Azerbaijan", "Bahamas": "Bahamas", "Bahrein": "Bahrain", "Bangladesh": "Bangladesh", "Barbados": "Barbados", "Barein": "Bahrain", "Belarus": "Belarus", "Bermudas": "Bermuda", "Bielorrússia": "Belarus", "Bolívia": "Bolivia", "Brasil": "Brazil", "Brunei": "Brunei", "Bulgária": "Bulgaria", "Butão": "Bhutan", "Bélgica": "Belgium", "Bósnia-Herzegovina": "Bosnia and Herzegovina", "Cabo Verde": "Cabo Verde", "Camarões": "Cameroon", "Camboja": "Cambodia", "Canadá": "Canada", "Catar": "Qatar", "Cazaquistão": "Kazakhstan", "Chile": "Chile", "China": "China", "Chipre": "Cyprus", "Christmas (Navidad), Ilha": "Christmas Island", "Cingapura": "Singapore", "Colômbia": "Colombia", "Congo, República Democrática": "DR Congo", "Coreia do Norte": "North Korea", "Coreia do Sul": "South Korea", "Costa Rica": "Costa Rica", "Costa do Marfim": "Côte d'Ivoire", "Coveite": "Kuwait", "Coveite (Kuweit)": "Kuwait", "Croácia": "Croatia", "Cuba": "Cuba", "Curaçao": "Curaçao", "Dinamarca": "Denmark", "Egito": "Egypt", "El Salvador": "El Salvador", "Emirados Árabes Unidos": "UAE", "Equador": "Ecuador", "Eslováquia": "Slovakia", "Eslovênia": "Slovenia", "Espanha": "Spain", "Estados Unidos": "United States", "Estônia": "Estonia", "Etiópia": "Ethiopia", "Filipinas": "Philippines", "Finlândia": "Finland", "França": "France", "Gabão": "Gabon", "Gana": "Ghana", "Geórgia": "Georgia", "Grécia": "Greece", "Guatemala": "Guatemala", "Guiana": "Guyana", "Guiné": "Guinea", "Haiti": "Haiti", "Honduras": "Honduras", "Hong Kong": "Hong Kong", "Hungria": "Hungary", "Ilha de Man": "Isle of Man", "Indonésia": "Indonesia", "Iraque": "Iraq", "Irlanda": "Ireland", "Irã": "Iran", "Islândia": "Iceland", "Itália": "Italy", "Iêmen": "Yemen", "Jamaica": "Jamaica", "Japão": "Japan", "Jordânia": "Jordan", "Laos": "Laos", "Letônia": "Latvia", "Liechtenstein": "Liechtenstein", "Lituânia": "Lithuania", "Luxemburgo": "Luxembourg", "Líbano": "Lebanon", "Líbia": "Libya", "Macau": "Macau", "Macedônia": "North Macedonia", "Malta": "Malta", "Malásia": "Malaysia", "Marrocos": "Morocco", "Marshall, Ilhas": "Marshall Islands", "Mauritânia": "Mauritania", "Maurício": "Mauritius", "Mianmar (Birmânia)": "Myanmar", "Moldávia": "Moldova", "Mongólia": "Mongolia", "Moçambique": "Mozambique", "México": "Mexico", "Mônaco": "Monaco", "Namíbia": "Namibia", "Nepal": "Nepal", "Nicarágua": "Nicaragua", "Nigéria": "Nigeria", "Noruega": "Norway", "Nova Zelândia": "New Zealand", "Não Definido": "Not declared", "Omã": "Oman", "Outros": "Others", "Panamá": "Panama", "Paquistão": "Pakistan", "Paraguai": "Paraguay", "Países Baixos (Holanda)": "Netherlands", "Peru": "Peru", "Polônia": "Poland", "Porto Rico": "Puerto Rico", "Portugal": "Portugal", "Quirguistão": "Kyrgyzstan", "Quênia": "Kenya", "Reino Unido": "United Kingdom", "República Dominicana": "Dominican Republic", "República Tcheca": "Czech Republic", "Reunião": "Réunion", "Romênia": "Romania", "Rússia": "Russia", "Rússia, Federação da": "Russia", "San Marino": "San Marino", "Seicheles": "Seychelles", "Senegal": "Senegal", "Serra Leoa": "Sierra Leone", "Singapura": "Singapore", "Sri Lanka": "Sri Lanka", "Suazilândia": "Eswatini", "Suriname": "Suriname", "Suécia": "Sweden", "Suíça": "Switzerland", "Sérvia": "Serbia", "Síria": "Syria", "Tailândia": "Thailand", "Taiwan (Formosa)": "Taiwan", "Tanzânia": "Tanzania", "Tcheca, República": "Czech Republic", "Trinidad e Tobago": "Trinidad & Tobago", "Tunísia": "Tunisia", "Turcas e Caicos, Ilhas": "Turks and Caicos", "Turquia": "Turkey", "Ucrânia": "Ukraine", "Uruguai": "Uruguay", "Uzbequistão": "Uzbekistan", "Venezuela": "Venezuela", "Vietnã": "Vietnam", "Virgens, Ilhas (Britânicas)": "British Virgin Islands", "Zimbábue": "Zimbabwe", "África do Sul": "South Africa", "Áustria": "Austria", "Índia": "India"};
  function country(n) { return COUNTRY_EN[n] || n; }
  var core = { country: country, MON: MON, ymIndex: ymIndex, ymOf: ymOf, axis: axis, align: align, buildPeriods: buildPeriods, perYear: perYear,
    monthWindow: monthWindow, periodWindow: periodWindow, aggregators: aggregators, F: F, lastIdx: lastIdx, change: change,
    rangeN: rangeN, fmt: fmt, pct: pct, chgTxt: chgTxt };

  /* ══ (b) GRÁFICOS ══════════════════════════════════════════════════════════ */
  var FONT = "'Manrope','Inter','Segoe UI',Helvetica,Arial,sans-serif";
  function isDark() { return document.documentElement.classList.contains('dark'); }
  function theme(stage) {
    var d = isDark();
    return d ? { dark: true, surf: '#1c2026', ink: '#e8eaed', mut: '#828892', grid: 'rgba(255,255,255,.06)', band: '255,255,255', veil: '28,32,38' }
             : { dark: false, surf: '#FDFCFA', ink: '#111111', mut: '#7b7770', grid: '#ECE8E0', band: '17,17,17', veil: '253,252,250' };
  }
  var ORANGE = '#FF5000';
  var UP = function () { return isDark() ? '#22c55e' : '#1c7c45'; }, DOWN = function () { return isDark() ? '#ef4444' : '#b83227'; };
  /* paleta sóbria do empilhado: uma família (azuis, verde-água, areia, lilás); a cor acompanha a ENTIDADE */
  var PAL_L = ['#22304a', '#3f72b5', '#8fb3de', '#2a9d8f', '#b79a5c', '#8a6fb3', '#5f7d95', '#c98a6b', '#6aa5a0', '#9aa6c4', '#7a8f5a', '#b784a7'];
  var PAL_D = ['#e3e6ec', '#5b8fd6', '#9cc0ea', '#3fb8a8', '#c9b47a', '#a892d6', '#8fa9bf', '#d9a084', '#7fc1bb', '#b4bedb', '#9db57a', '#cf9fc0'];
  /* R² (pedido do usuário, 25/11/2026: "para todos os gráficos que montarmos, coloque sempre um indicativo do R²" — e depois "Sim,
     ponha" nos gráficos fixos que cruzam séries): quadrado da correlação de Pearson entre duas séries nos pontos em que AS DUAS têm
     valor = o R² da regressão linear de uma na outra. null com menos de R2_MIN pares ou com uma série parada. A MESMA conta e o
     MESMO selo no Builder, nos gráficos mensais das seções e nas seções de preço/usinas. */
  var R2_MIN = 6;
  function r2of(a, b, i0, i1) {
    var xs = [], ys = [], i, n, mx = 0, my = 0, sxy = 0, sxx = 0, syy = 0;
    for (i = i0; i <= i1; i++) if (a[i] != null && b[i] != null && isFinite(a[i]) && isFinite(b[i])) { xs.push(+a[i]); ys.push(+b[i]); }
    n = xs.length; if (n < R2_MIN) return { n: n, r: null, r2: null };
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
    for (i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (!(sxx > 0) || !(syy > 0)) return { n: n, r: null, r2: null };
    var r = sxy / Math.sqrt(sxx * syy); return { n: n, r: r, r2: r * r };
  }
  /* o selo: "R² 0.72" (+ "inverse" quando a correlação é negativa); na dica, contra quem, em quantos períodos e o que significa */
  function r2Badge(fit, ref, per, extra) {
    if (!fit) return '';
    if (fit.r2 == null) return '<span class="dk-br2 dk-br2na" title="' + esc('R² against ' + ref + ': needs at least ' + R2_MIN + ' ' + per + ' with both series in this window (now ' + fit.n + ')') + '">R² —</span>';
    return '<span class="dk-br2" title="' + esc('R² against ' + ref + ' = ' + fmt(fit.r2, 2) + ', over ' + fit.n + ' ' + per + ' of this window: how much of this line\'s movement lines up with ' + ref + ' (0 = none, 1 = all), from a linear regression of one on the other.' + (fit.r < 0 ? ' Inverse: they move in opposite directions.' : '') + (extra || ' Lines that both trend can show a high R² without a real link.')) + '">R² ' + fmt(fit.r2, 2) + (fit.r < 0 ? ' <em>inverse</em>' : '') + '</span>';
  }
  /* TABELA DE CORRELAÇÃO (pedido do usuário, 25/11/2026: "deixe essa correlação em uma tabelinha ao lado da explicação, onde ele
     coloca a correlação de cada uma das variáveis escolhidas entre si, de forma visual e facilmente entendível"): o R² de cada PAR
     de séries do gráfico (só a metade de baixo da matriz — cada par uma vez). A cor diz o SENTIDO — azul = andam juntas, vermelho
     com "−" = sentidos opostos (o par divergente do guia de gráficos, cinza neutro quando quase não há relação) — e a FORÇA (4
     degraus: 0,1 · 0,3 · 0,5 · 0,7). Na dica de cada célula: os dois nomes, R², r e em quantos períodos. */
  function corrCells(vals, i0, i1) { var n = vals.length, out = [], i, j; for (i = 0; i < n; i++) { out.push([]); for (j = 0; j < i; j++) out[i].push(r2of(vals[j], vals[i], i0, i1)); } return out; }
  function corrTable(ser, cells, per) {   // ser: [{name, short, color}] · cells[i][j] (j < i) = {n, r, r2}
    if (!ser || ser.length < 2 || !cells) return '';
    var dk = isDark(), pos = dk ? '57,135,229' : '42,120,214', neg = dk ? '230,103,103' : '227,73,72';
    var tint = function (r2) { return r2 == null ? 0 : r2 >= .7 ? .62 : r2 >= .5 ? .44 : r2 >= .3 ? .28 : r2 >= .1 ? .14 : 0; };
    var lab = function (s) { return '<span class="dk-ccl"><i style="background:' + s.color + '"></i><span>' + esc(s.short || s.name) + '</span></span>'; };
    var h = '<div class="dk-ch2"><b>Correlation (R²)</b><em>each pair · this window</em></div><table class="dk-ct"><thead><tr><th></th>' +
      ser.slice(0, -1).map(function (s) { return '<th title="' + esc(s.name) + '">' + lab(s) + '</th>'; }).join('') + '</tr></thead><tbody>', i, j;
    for (i = 1; i < ser.length; i++) {
      h += '<tr><th title="' + esc(ser[i].name) + '">' + lab(ser[i]) + '</th>';
      for (j = 0; j < ser.length - 1; j++) {
        if (j >= i) { h += '<td class="dk-cx"></td>'; continue; }
        var f = cells[i] && cells[i][j], ok = f && f.r2 != null, a = ok ? tint(f.r2) : 0;
        var tip = ok ? ser[i].name + ' × ' + ser[j].name + ': R² ' + fmt(f.r2, 2) + ' (r = ' + (f.r < 0 ? '−' : '') + fmt(Math.abs(f.r), 2) + ' — ' + (f.r < 0 ? 'they move in opposite directions' : 'they move together') + '), over ' + f.n + ' ' + per + ' of this window'
          : ser[i].name + ' × ' + ser[j].name + ': needs at least ' + R2_MIN + ' ' + per + ' with both series in this window (now ' + (f ? f.n : 0) + ')';
        h += '<td' + (a ? ' style="background:rgba(' + (f.r < 0 ? neg : pos) + ',' + a + ')"' : '') + ' title="' + esc(tip) + '">' + (ok ? (f.r < 0 ? '−' : '') + fmt(f.r2, 2) : '—') + '</td>';
      }
      h += '</tr>';
    }
    return h + '</tbody></table><div class="dk-ckey"><span><i style="background:rgba(' + pos + ',.5)"></i>move together</span><span><i style="background:rgba(' + neg + ',.5)"></i>− opposite</span><span>darker = stronger</span></div>';
  }
  /* SAZONALIDADE — uma cor por ano (pedido do usuário, 25/11/2026: "deixe todos os anos com indicações de cores diferentes"):
     k = 0 o ano mais novo (laranja, cheio, grosso), k = 1 o anterior (cor da tinta, cheio), k ≥ 2 os outros PONTILHADOS, cada um
     com a sua cor. As quatro cores são as da paleta de referência do guia de gráficos e passaram no validador nos dois temas
     (separação para daltonismo e para visão normal, ordem azul → verde-água → violeta → rosa). Do 7º ano em diante, cinza. */
  var YEAR_L = ['#2a78d6', '#1baf7a', '#6250d6', '#e87ba4'], YEAR_D = ['#3987e5', '#199e70', '#9085e9', '#d55181'];
  function yearColor(k) { var t = theme(); return k === 0 ? ORANGE : k === 1 ? t.ink : ((isDark() ? YEAR_D : YEAR_L)[k - 2] || 'rgba(' + t.band + ',.35)'); }
  function yearStyle(k) { return { color: yearColor(k), w: k === 0 ? 2.6 : k === 1 ? 2 : 1.9, dash: k >= 2 ? [1, 3.4] : null }; }
  /* um item da legenda: traço cheio (k 0 e 1) ou pontilhado (k ≥ 2) na cor do ano + o ano + o valor (texto na cor de texto) */
  function yearChip(k, name, val) { return '<span><i class="dk-lg-' + (k >= 2 ? 'dot' : 'line') + '" style="color:' + yearColor(k) + '"></i>' + esc(String(name)) + (val != null ? ' <b>' + val + '</b>' : '') + '</span>'; }
  function slotColor(slot) { return slot === 'lead' ? ORANGE : slot === 'others' ? (isDark() ? '#474d57' : '#d3cfc7') : (isDark() ? PAL_D : PAL_L)[slot % PAL_L.length]; }

  function rr(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath(); }

  /* Plugin da mesa: faixa suave do período, anéis, recuo das outras barras, total do empilhado e marcadores A/B.
     Lê chart.$dk = {hover, pinA, pinB} (índices LOCAIS do gráfico) — desenhar não refaz layout. */
  var syncPlugin = {
    id: 'ibbaDeskSync',
    /* O gráfico nasce com animação e logo muda de tamanho (o painel Reading ao lado se preenche e a linha da grade cresce).
       Com a animação desligada depois do nascimento, o Chart.js grava as posições novas por cima SEM parar a animação de
       nascimento, que continuava e terminava nas posições do tamanho ANTIGO — as linhas ficavam fora do lugar até o próximo
       redesenho (o "Margin proxy" na 1ª abertura, 23/11/2026). Parar a animação antes do redimensionamento resolve. Só nos
       gráficos da mesa (o plugin é global; os gráficos da tela antiga não têm `on`). */
    resize: function (chart, _a, o) { if (o && o.on) chart.stop(); },
    _geo: function (chart) {
      var a = chart.chartArea, xs = chart.scales.x, n = chart.data.labels.length; if (!a || !xs || !n) return null;
      var slot = n > 1 ? Math.abs(xs.getPixelForValue(1) - xs.getPixelForValue(0)) : a.width;
      return { a: a, xs: xs, n: n, slot: slot };
    },
    beforeDatasetsDraw: function (chart, _a, o) {
      var s = chart.$dk, g; if (!o || !o.on || (o.tip && o.bar) || !s || s.hover == null || s.hover < 0) return; g = this._geo(chart); if (!g || s.hover >= g.n) return;
      var t = theme(o.stage), x = g.xs.getPixelForValue(s.hover), w = o.bar ? Math.min(g.slot, Math.min(34, g.slot * .72) + 12) : Math.max(22, Math.min(46, g.slot));
      var c = chart.ctx, gr = c.createLinearGradient(0, g.a.top, 0, g.a.bottom);
      gr.addColorStop(0, 'rgba(' + t.band + ',' + (t.dark ? .11 : .075) + ')'); gr.addColorStop(1, 'rgba(' + t.band + ',' + (t.dark ? .02 : .015) + ')');
      c.save(); c.fillStyle = gr; rr(c, x - w / 2, g.a.top - 6, w, g.a.height + 12, 7); c.fill(); c.restore();
    },
    afterDatasetsDraw: function (chart, _a, o) {
      var s = chart.$dk, g; if (!o || !o.on || !s) return; g = this._geo(chart); if (!g) return;
      var t = theme(o.stage), c = chart.ctx, a = g.a, hv = s.hover;
      c.save();
      if (!(o.tip && o.bar) && hv != null && hv >= 0 && hv < g.n) {   // barras com dica = só a dica clássica; linhas = faixa + anéis (com ou sem dica)
        var x = g.xs.getPixelForValue(hv);
        if (o.bar) {   // as outras barras recuam: um véu na cor do fundo dos dois lados da coluna
          var half = Math.min(g.slot, Math.min(34, g.slot * .72) + 12) / 2;
          c.fillStyle = 'rgba(' + t.veil + ',' + (t.dark ? .34 : .24) + ')';
          c.fillRect(a.left, a.top - 2, Math.max(0, x - half - a.left), a.height + 3);
          c.fillRect(x + half, a.top - 2, Math.max(0, a.right - x - half), a.height + 3);
          if (o.stack && !o.share) {   // total do período, escrito acima da barra
            var tot = 0; chart.data.datasets.forEach(function (d, k) { if (chart.isDatasetVisible(k)) tot += (+d.data[hv] || 0); });
            var yT = chart.scales.y.getPixelForValue(tot);
            c.font = '700 10px ' + FONT; c.textAlign = 'center'; c.fillStyle = t.ink; c.fillText(fmt(tot, 0), x, yT - 5);
          }
        } else {
          chart.data.datasets.forEach(function (d, k) {
            if (d.$noDot || d.type === 'bar' || !chart.isDatasetVisible(k)) return; var v = d.data[hv]; if (v == null) return;
            /* o anel vai no ponto DESENHADO (o elemento do gráfico): fica em cima da linha mesmo no meio de uma animação */
            var el = (chart.getDatasetMeta(k).data || [])[hv], px = (el && isFinite(el.x)) ? el.x : x, y = (el && isFinite(el.y)) ? el.y : chart.scales[d.yAxisID || 'y'].getPixelForValue(v);
            c.beginPath(); c.arc(px, y, 4.5, 0, Math.PI * 2); c.fillStyle = t.surf; c.fill(); c.lineWidth = 2.2; c.strokeStyle = d.$ring || d.borderColor || ORANGE; c.stroke();
          });
        }
      }
      if (o.pins) [['pinA', ORANGE, 'A', '#fff'], ['pinB', t.dark ? '#f3f1ec' : '#111111', 'B', t.dark ? '#111' : '#fff']].forEach(function (p) {
        var i = s[p[0]]; if (i == null || i < 0 || i >= g.n) return; var px = g.xs.getPixelForValue(i);
        c.globalAlpha = .85; c.beginPath(); c.moveTo(px, a.top + (o.mini ? 0 : 6)); c.lineTo(px, a.bottom); c.lineWidth = 1.2; c.strokeStyle = p[1]; c.setLineDash([]); c.stroke(); c.globalAlpha = 1;
        if (!o.mini) { c.beginPath(); c.arc(px, a.top, 7, 0, Math.PI * 2); c.fillStyle = p[1]; c.fill(); c.font = '700 8.5px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = p[3]; c.fillText(p[2], px, a.top + .5); c.textBaseline = 'alphabetic'; }
      });
      c.restore();
    }
  };
  /* RÓTULOS DE VALOR (Builder, "Labels: Last value | All values" — 26/11/2026): o valor de cada série no último ponto (caixinha na cor da
     série, logo à direita, sem sobrepor) ou em todos os pontos (texto pequeno acima; com muitos pontos, um a cada N). Só nas séries
     marcadas $lab (as de apoio ficam de fora); casas e sufixo da própria série ($dec, $sfx). Lê options.plugins.ibbaDeskLabels.mode. */
  function lum(c) { var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '') || /^rgba?\((\d+)\D+(\d+)\D+(\d+)/.exec(c || ''); if (!m) return 0; var hx = c.charAt(0) === '#';
    return .2126 * parseInt(m[1], hx ? 16 : 10) + .7152 * parseInt(m[2], hx ? 16 : 10) + .0722 * parseInt(m[3], hx ? 16 : 10); }
  var labelPlugin = {
    id: 'ibbaDeskLabels',
    afterDatasetsDraw: function (chart, _a, o) {
      if (!o || !o.mode || !chart.chartArea) return; var c = chart.ctx, t = theme(true), A = chart.chartArea, boxes = [];
      var yOf = function (p0) { return (p0 && typeof p0 === 'object') ? p0.y : p0; };
      chart.data.datasets.forEach(function (d, k) { if (!d.$lab || !chart.isDatasetVisible(k)) return; var els = chart.getDatasetMeta(k).data || [], data = d.data || [];
        var tx = function (v) { return fmt(v, d.$dec || 0) + (d.$sfx || ''); }, isBar = d.type === 'bar' || (!d.type && chart.config.type === 'bar');
        if (o.mode === 'last') { var li = -1, i; for (i = data.length - 1; i >= 0; i--) if (yOf(data[i]) != null) { li = i; break; } if (li < 0 || !els[li]) return;
          var bg = Array.isArray(d.backgroundColor) ? d.backgroundColor[li] : d.backgroundColor;   // coluna: a cor é o preenchimento (a borda é a cor do fundo)
          var col = d.$ring || (isBar && typeof bg === 'string' ? bg : null) || (typeof d.borderColor === 'string' && !/^rgba\(0,0,0,0\)$|transparent/.test(d.borderColor) ? d.borderColor : null) || (typeof bg === 'string' ? bg : null) || ORANGE, e0 = els[li];
          boxes.push({ x: e0.x, y: isBar && e0.base != null ? Math.min(e0.y, e0.base) : e0.y, s: tx(yOf(data[li])), col: col }); return; }
        var n = data.length, room = Math.max(4, Math.floor(A.width / 44)), step = Math.max(1, Math.ceil(n / room));
        c.save(); c.font = '600 9.5px ' + FONT; c.textAlign = 'center'; c.fillStyle = t.ink;
        for (var j = 0; j < n; j++) { if ((n - 1 - j) % step) continue; var v = yOf(data[j]); if (v == null || !els[j]) continue; var e = els[j];
          var ty = (isBar && e.base != null) ? (v >= 0 ? Math.min(e.y, e.base) - 4 : Math.max(e.y, e.base) + 11) : e.y - 7; c.fillText(tx(v), e.x, Math.max(A.top + 8, Math.min(A.bottom + 10, ty))); }
        c.restore(); });
      if (!boxes.length) return;
      boxes.sort(function (a, b) { return a.y - b.y; }); for (var q = 1; q < boxes.length; q++) if (boxes[q].y - boxes[q - 1].y < 17) boxes[q].y = boxes[q - 1].y + 17;
      c.save(); c.font = '700 10px ' + FONT; c.textBaseline = 'middle'; c.textAlign = 'left';
      boxes.forEach(function (b0) { var w = c.measureText(b0.s).width + 10, x = b0.x + 7; if (x + w > chart.width - 2) x = chart.width - 2 - w;
        rr(c, x, b0.y - 8, w, 16, 4); c.fillStyle = b0.col; c.fill(); c.fillStyle = lum(b0.col) > 150 ? '#111111' : '#ffffff'; c.fillText(b0.s, x + 5, b0.y + .5); });
      c.restore();
    }
  };
  var _registered = false;
  function ensurePlugin() { if (_registered || !window.Chart) return; Chart.register(syncPlugin, labelPlugin); _registered = true; }

  /* opções-base: um eixo Y, grade horizontal fina, rótulos do X ancorados no ÚLTIMO período, sem dica flutuante */
  function chartOptions(o) {
    var t = theme(o.stage), tick = { color: t.mut, font: { size: 9.5, family: FONT } };
    var opt = {
      responsive: true, maintainAspectRatio: false, events: o.tip ? ['mousemove', 'mouseout', 'touchstart', 'touchmove'] : [], locale: 'en-US',
      interaction: { mode: 'index', intersect: false },
      animation: o.animate ? { duration: 280 } : false,
      layout: { padding: o.mini ? { top: 6, right: 3, bottom: 3, left: 3 } : { top: o.stack ? 18 : 12, right: 10, bottom: 0, left: 0 } },
      plugins: { legend: { display: false }, tooltip: o.tip ? tipOptions(o) : { enabled: false }, datalabels: { display: false }, ibbaCross: false,
        ibbaDeskSync: { on: true, stage: !!o.stage, bar: !!o.bar, stack: !!o.stack, share: !!o.share, mini: !!o.mini, tip: !!o.tip, pins: !!o.pins } },
      scales: {
        x: { display: !o.mini, stacked: !!o.stack, offset: !!o.bar, grid: { display: false }, border: { display: false },
          ticks: Object.assign({}, tick, { autoSkip: false, maxRotation: 0, padding: 4,
            callback: function (val, index) { var n = this.chart.data.labels.length, room = Math.max(2, Math.floor((this.chart.width - 60) / 62)), skip = Math.max(1, Math.ceil(n / room));
              return ((n - 1 - index) % skip === 0) ? this.getLabelForValue(val) : null; } }) },
        y: Object.assign({ display: !o.mini, stacked: !!o.stack, border: { display: false }, grid: { color: t.grid, drawTicks: false },
          ticks: Object.assign({}, tick, { maxTicksLimit: 6, padding: 8, callback: function (v) { return fmt(v, (o.dec > 0 && Math.abs(this.max - this.min) < 10) ? 1 : 0); } }) },
          o.share ? { min: 0, max: 100 } : {}, o.mini ? { grace: '8%' } : {})
      }
    };
    /* 2ª escala, à direita (ex.: colunas do número + linha da variação anual) — sem grade própria */
    if (o.y2) opt.scales.y2 = { position: 'right', display: !o.mini, border: { display: false }, grid: { display: false, drawOnChartArea: false },
      ticks: Object.assign({}, tick, { maxTicksLimit: 6, padding: 8, callback: function (v) { return fmt(v, o.y2.dec || 0) + (o.y2.suffix || ''); } }) };
    return opt;
  }
  /* dica clássica (a mesma tinta das outras dicas da dashboard): um item por série, com o valor; total no pé do empilhado */
  function tipOptions(o) {
    var base = window.IBBAChart ? IBBAChart.tip(window.innerWidth <= 768) : {}, cb = window.IBBAChart ? IBBAChart.tipCallbacks : {};
    return Object.assign({ enabled: true }, base, {
      filter: function (it) { return !(it.dataset && it.dataset.$noTip) && it.parsed && it.parsed.y != null && it.parsed.y !== 0; },
      itemSort: function (a, b) { return b.datasetIndex - a.datasetIndex; },
      callbacks: Object.assign({}, cb, {
        /* a bolinha da dica leva a cor DA SÉRIE: nas barras é o preenchimento; nas LINHAS é o traço (o preenchimento
           de uma linha é transparente ou um degradê — era o que deixava a bolinha em branco) */
        labelColor: function (c) { var ds = c.dataset || {}, pick = function (v) { v = Array.isArray(v) ? v[c.dataIndex] : v; return (typeof v === 'string' && v !== 'transparent') ? v : null; };
          var b = ((ds.type || c.chart.config.type) === 'line' ? pick(ds.borderColor) || pick(ds.$ring) : pick(ds.backgroundColor)) || pick(ds.borderColor) || pick(ds.$ring) || pick(ds.backgroundColor) || ORANGE;
          /* série quase preta (ou cinza translúcido) sumiria na tinta escura da dica: ganha um aro claro, a cor de dentro continua a da série */
          var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(b) || /^rgba?\((\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/.exec(b), dim = false;
          if (m) { var hx = b.charAt(0) === '#', a0 = (!hx && m[4] != null) ? +m[4] : 1; dim = (0.2126 * parseInt(m[1], hx ? 16 : 10) + 0.7152 * parseInt(m[2], hx ? 16 : 10) + 0.0722 * parseInt(m[3], hx ? 16 : 10)) * a0 < 90; }
          return { borderColor: dim ? 'rgba(255,255,255,.78)' : b, backgroundColor: b, borderWidth: dim ? 1.5 : 0, borderRadius: 2 }; },
        label: function (c) { var ds = c.dataset || {};
          if (ds.$unit != null) return ' ' + (ds.label || '') + ': ' + fmt(c.parsed.y, ds.$dec != null ? ds.$dec : (o.dec || 0)) + (ds.$unit === '%' ? '%' : ds.$unit ? ' ' + ds.$unit : '');
          return ' ' + (ds.label || '') + ': ' + fmt(c.parsed.y, o.share ? 1 : (o.dec || 0)) + (o.unitTip ? ' ' + o.unitTip : o.share ? '%' : ''); },
        footer: function (items) { if (!o.stack || o.share || items.length < 2) return ''; var t = 0; items.forEach(function (i) { t += i.parsed.y || 0; }); return 'Total: ' + fmt(t, o.dec || 0); } }) });
  }
  function areaFill(c) { var ch = c.chart, a = ch.chartArea; if (!a) return 'rgba(255,80,0,.18)'; var g = ch.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, 'rgba(255,80,0,.30)'); g.addColorStop(1, 'rgba(255,80,0,0)'); return g; }
  function lineSet(data, color, o) { o = o || {}; var li = lastIdx(data), pa = o.partialAt == null ? -1 : o.partialAt, endPart = li === pa;
    return { type: 'line', segment: { borderDash: function (c) { return c.p1DataIndex === pa ? [3, 3] : undefined; } }, label: o.label || '', data: data, borderColor: color, borderWidth: o.w || 2, tension: 0, spanGaps: false, borderJoinStyle: 'round', borderCapStyle: 'round',
      borderDash: o.dash || [], fill: o.area ? 'origin' : false, backgroundColor: o.area ? areaFill : 'transparent', $noDot: !!o.noDot, $ring: color,
      pointRadius: function (c) { return (o.end && c.dataIndex === li) ? 3.5 : 0; }, pointBackgroundColor: endPart ? (o.surf || '#fff') : color, pointBorderColor: endPart ? color : (o.surf || '#fff'), pointBorderWidth: 2, pointHoverRadius: 0, order: o.order || 1 }; }
  function barSet(data, color, o) { o = o || {};
    if (o.partialAt != null && o.partialAt >= 0) color = data.map(function (_, k) { var c0 = Array.isArray(color) ? color[k] : color; return k === o.partialAt ? hexA(c0, .45) : c0; });
    return { type: 'bar', label: o.label || '', data: data, backgroundColor: color, borderWidth: o.gap ? { top: 0, right: 0, bottom: 1.5, left: 0 } : 0, borderColor: o.surf || 'transparent',
      borderRadius: 4, borderSkipped: o.stacked ? false : 'start', maxBarThickness: 34, categoryPercentage: 1, barPercentage: .72, stack: o.stacked ? 's' : undefined }; }

  /* ══ (c) INTERFACE ═════════════════════════════════════════════════════════ */
  function h(tag, cl, html) { var e = document.createElement(tag); if (cl) e.className = cl; if (html != null) e.innerHTML = html; return e; }
  /* o quadro de explicação de um gráfico: o que ele mostra + como ler */
  function whyHTML(what, how) { return (what ? '<p><b>What it shows</b>' + esc(what) + '</p>' : '') + (how ? '<p><b>How to read</b>' + esc(how) + '</p>' : ''); }
  /* VISUALIZAÇÕES (pedido do usuário, 26/11/2026: "nos outros gráficos que não estão no builder, coloque 2 ou 3 opções de gráficos para
     visualizar aquela mesma informação"): cada gráfico ganha o seletor "Chart" com 2–3 desenhos do MESMO dado — o ícone desenha o tipo
     e a palavra ao lado diz o nome (controle novo sempre com rótulo claro). A 1ª opção é o desenho de sempre. Os ícones também servem
     à galeria do Builder. */
  var ICO = {
    line: '<path d="M1.5 11.5l4-4.5 3 3 5-6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    lines: '<path d="M1.5 9.5l4-3.5 3 2 5-5M1.5 13l4-2.5 3 1.5 5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    area: '<path d="M1.5 13.5v-4l4-4.5 3 3 5-6v11.5z" fill="currentColor" opacity=".32"/><path d="M1.5 9.5l4-4.5 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>',
    col: '<path d="M2.5 13.5v-5M6 13.5v-9M9.5 13.5v-6M13 13.5v-11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    colyoy: '<path d="M2.5 13.5v-4M7.5 13.5v-6M12.5 13.5v-5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".45"/><path d="M1.5 5.5l5-3 5 3 2.5-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    stack: '<path d="M3 13.5v-4M7.5 13.5v-3M12 13.5v-5" stroke="currentColor" stroke-width="3" opacity=".42"/><path d="M3 9.5v-4M7.5 10.5v-7M12 8.5v-3" stroke="currentColor" stroke-width="3"/>',
    stackarea: '<path d="M1.5 13.5v-3l4-2 3 1 5-3v7z" fill="currentColor" opacity=".38"/><path d="M1.5 10.5v-4l4-3 3 2 5-4v5l-5 3-3-1-4 2z" fill="currentColor" opacity=".8"/>',
    pct: '<path d="M3 1.5v12M7.5 1.5v12M12 1.5v12" stroke="currentColor" stroke-width="3" opacity=".3"/><path d="M3 7.5v6M7.5 4.5v9M12 9.5v4" stroke="currentColor" stroke-width="3"/>',
    scatter: '<path d="M1.5 13.5l12-11" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 2"/><circle cx="3" cy="10.5" r="1.4" fill="currentColor"/><circle cx="5.5" cy="11.5" r="1.4" fill="currentColor"/><circle cx="7" cy="7.5" r="1.4" fill="currentColor"/><circle cx="10" cy="6.5" r="1.4" fill="currentColor"/><circle cx="12" cy="3" r="1.4" fill="currentColor"/>',
    year: '<path d="M1.5 10c3-6 6 2 12-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M1.5 13c3-5 6 1 12-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="1.5 2" opacity=".7"/>',
    range: '<path d="M1.5 5.5c4-3 8 1 12-2.5v7c-4 3-8-.5-12 2z" fill="currentColor" opacity=".25"/><path d="M1.5 9c4-3 8 1 12-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    grid: '<rect x="1.5" y="1.5" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".35"/><rect x="5.8" y="1.5" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".8"/><rect x="10.1" y="1.5" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".55"/><rect x="1.5" y="5.8" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".9"/><rect x="5.8" y="5.8" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".4"/><rect x="10.1" y="5.8" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".7"/><rect x="1.5" y="10.1" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".5"/><rect x="5.8" y="10.1" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".95"/><rect x="10.1" y="10.1" width="3.4" height="3.4" rx=".6" fill="currentColor" opacity=".3"/>',
    gap: '<path d="M1 7.5h13" stroke="currentColor" stroke-width="1" opacity=".55"/><path d="M3 7.5V3M6.5 7.5V4.5M10 7.5v4M13 7.5v2.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    index: '<path d="M1.5 8l12-5.5M1.5 8l12 1.5M1.5 8l12 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="2" cy="8" r="1.6" fill="currentColor"/>',
    combo: '<path d="M2.5 13.5v-4M7.5 13.5v-6M12.5 13.5v-5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" opacity=".45"/><path d="M1.5 5.5l5-3 5 3 2.5-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  function icon(k) { return '<svg class="dk-ico" viewBox="0 0 15 15" aria-hidden="true">' + (ICO[k] || ICO.line) + '</svg>'; }
  /* opts: [[chave, rótulo, dica, desligado, ícone]] → o seletor, com o rótulo "Chart" na frente */
  function styleSeg(opts, cur, lbl) {
    return '<span class="dk-plbl dk-stylbl">' + esc(lbl || 'Chart') + '</span><div class="dk-seg dk-sty" role="group" aria-label="' + esc(lbl || 'Chart') + ' type">' + opts.map(function (o) {
      return '<button type="button" data-sty="' + o[0] + '" aria-pressed="' + (o[0] === cur) + '"' + (o[3] ? ' disabled' : '') + ' title="' + esc((o[3] && typeof o[3] === 'string') ? o[3] : (o[2] || o[1])) + '">' + icon(o[4] || o[0]) + '<span>' + esc(o[1]) + '</span></button>'; }).join('') + '</div>';
  }
  function sparkSVG(v, w, hh) {
    var pts = [], i; for (i = 0; i < v.length; i++) if (v[i] != null) pts.push([i, v[i]]); if (pts.length < 2) return '';
    var mn = Math.min.apply(null, pts.map(function (p) { return p[1]; })), mx = Math.max.apply(null, pts.map(function (p) { return p[1]; })), n = v.length - 1;
    var X = function (i2) { return 2 + i2 / n * (w - 4); }, Y = function (y) { return hh - 2 - (mx > mn ? (y - mn) / (mx - mn) : .5) * (hh - 4); };
    var d = pts.map(function (p, j) { return (j ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(''), lp = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="' + X(lp[0]).toFixed(1) + '" cy="' + Y(lp[1]).toFixed(1) + '" r="2.2" fill="' + ORANGE + '"/></svg>';
  }

  /* mini-gráfico com DUAS (ou mais) séries na mesma escala — quadro de indicador composto */
  function sparkMulti(list, w, hh) {
    var all = [], n = 0; list.forEach(function (s) { n = Math.max(n, s.v.length - 1); s.v.forEach(function (x) { if (x != null) all.push(x); }); }); if (all.length < 2 || n < 1) return '';
    var mn = Math.min.apply(null, all), mx = Math.max.apply(null, all);
    var X = function (i) { return 2 + i / n * (w - 4); }, Y = function (y) { return hh - 2 - (mx > mn ? (y - mn) / (mx - mn) : .5) * (hh - 4); };
    return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="none" aria-hidden="true">' + list.map(function (s) { var d = '', on = false;
      s.v.forEach(function (x, i) { if (x == null) { on = false; return; } d += (on ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1); on = true; });
      return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>'; }).join('') + '</svg>';
  }

  function Desk(cfg) {
    this.cfg = cfg; this.sections = cfg.sections || {}; this.cur = null; this.charts = {}; this.ui = {};   // ui[secId] = {metric, mode, hover, pinA, pinB, who:{...}}
    this.root = typeof cfg.root === 'string' ? document.querySelector(cfg.root) : cfg.root;
    this._cache = {}; this._slots = {}; this._slotN = 0; this._ovr = null; this._raf = 0;
    ensurePlugin();
    var self = this;
    /* RESET: o 1º toque da pessoa numa seção congela a linha de base dela (ver atDefault) */
    this._touch = {}; this._u0 = {};
    if (this.root) ['pointerdown', 'keydown'].forEach(function (ev) { self.root.addEventListener(ev, function () { if (self.cur) self._touch[self.cur] = true; }, true); });
    window.addEventListener('ibba:theme', function () { if (self.cur) self.refresh(); });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { var S0 = self.cur && self.sections[self.cur]; if (S0 && !S0.overview && !S0.builder && !S0.hf && !S0.noBrush && self.el && self.ctx) self._brush(); }, 200); });
  }
  Desk.prototype.has = function (id) { return !!this.sections[id]; };
  Desk.prototype._u = function () { var id = this.cur; return this.ui[id] || (this.ui[id] = { metric: this.sections[id].stage, mode: 'level', hover: null, pinA: null, pinB: null, who: { dim: 0, pill: null, sel: null, mode: 'volume', hi: null } }); };
  /* RESET (pedido do usuário, 26/11/2026: "deixe um botão de reset acima das opções de filtro"). O botão mora na página (ao lado
     do ⤓ Data, na linha logo acima dos filtros) e ela zera os filtros dela (cfg.resetFilters → Total · Monthly · YTD, sem datas);
     aqui volta o que é da seção aberta: o quadro no gráfico, a conta (Level/YoY/LTM/…), o produto próprio da seção, o "Who is
     behind the number" e os pontos A→B — no Builder, a visão de abertura (data-desk-builder.js). Não muda de lugar (aba, seção e
     sub-aba ficam) e não apaga as visões salvas.
     "Já está como abre?" (o botão fica apagado): a linha de base de cada seção é o estado em que ela se ajeitou SOZINHA (o motor
     acerta quadro, conta e modo do "Who" conforme o dado), tirada ao fim de cada desenho enquanto a pessoa não tocou na seção;
     o 1º toque (pointerdown/keydown na mesa) congela a base. */
  function uSnap(u, sec) { var w = u.who || {}, sy = u.sty || {}; return JSON.stringify([u.metric, u.mode, u.pinA, u.pinB, u.prod || (sec.prods ? sec.prods[0].k : null), w.dim || 0, w.pill || null, w.sub || null, w.sel || null, w.mode || null,
    Object.keys(sy).sort().map(function (k) { return k + '=' + sy[k]; }).join(',')]); }
  /* a visualização escolhida de um gráfico (u.sty[gráfico]) — vale enquanto existir entre as opções da vista; a 1ª opção é o padrão e
     não fica guardada (assim o Reset sabe que é a de abertura) */
  Desk.prototype._sty = function (chart, opts) { var s = (this._u().sty || {})[chart]; return opts.some(function (o) { return o[0] === s && !o[3]; }) ? s : opts[0][0]; };
  Desk.prototype._setSty = function (chart, k, opts) { var u = this._u(); u.sty = u.sty || {}; if (!opts.length || k === opts[0][0]) delete u.sty[chart]; else u.sty[chart] = k; };
  Desk.prototype._uBase = function () { var id = this.cur, u = id && this.ui[id]; if (u && !this._touch[id]) this._u0[id] = uSnap(u, this.sections[id]); };
  Desk.prototype.atDefault = function () { var id = this.cur, sec = id && this.sections[id]; if (!sec || sec.overview) return true;
    if (sec.builder) return this._bAtDefault ? this._bAtDefault() : true;
    var u = this.ui[id]; return !u || !this._touch[id] || this._u0[id] === uSnap(u, sec); };
  Desk.prototype.resetView = function () { var id = this.cur, sec = id && this.sections[id]; if (!sec) return;
    delete this.ui[id]; delete this._u0[id]; this._touch[id] = false; this._ovr = null;
    if (sec.builder && this._bReset) this._bReset();
    if (this.cfg.resetFilters) this.cfg.resetFilters(); else this.refresh(); };

  /* monta o contexto da seção para o estado atual dos filtros */
  Desk.prototype._ctx = function () {
    var sec = this.sections[this.cur], st = Object.assign({}, this.cfg.state(), this._ovr || {}), u = this._u(), self = this;
    if (!this._dbg) { if (sec.prods) st.prod = u.prod || sec.prods[0].k;        // filtro de produto próprio da seção (ex.: minério)
      if (sec.prodKey) st.prod = sec.prodKey(); }                              // estado que mora na página (ex.: produto + lag do modelo preditivo)
    if (sec.fixed) st = Object.assign(st, sec.fixed);                         // seção com granularidade/janela fixas
    var ck = this.cur + '|' + st.prod, base = this._cache[ck];
    if (!base) {   // componentes mensais alinhados a um eixo único da seção (por produto)
      var maps = {}, lo = null, hi = null;
      sec.metrics.forEach(function (M) { var c = (M.comp && (!M.available || M.available({ prod: st.prod }))) ? (M.comp({ prod: st.prod }) || {}) : {}; maps[M.id] = c;
        Object.keys(c).forEach(function (k) { var m = c[k]; if (!m) return; for (var p in m) { if (m[p] == null) continue; if (lo == null || p < lo) lo = p; if (hi == null || p > hi) hi = p; } }); });
      if (lo == null) { lo = hi = '2000-01'; }
      var ax = axis(lo, hi), comp = {};
      sec.metrics.forEach(function (M) { comp[M.id] = {}; Object.keys(maps[M.id]).forEach(function (k) { comp[M.id][k] = align(maps[M.id][k], ax); }); });
      base = this._cache[ck] = { ax: ax, comp: comp };
    }
    var P = buildPeriods(base.ax, st.gran, true), PER = perYear(st.gran), A = aggregators(P, PER);
    var mw = monthWindow(base.ax, base.ax.length - 1, st), pw = periodWindow(P, mw[0], mw[1]), memo = {};
    var ctx = { sec: sec, st: st, u: u, ax: base.ax, P: P, PER: PER, A: A, i0: pw[0], i1: pw[1], m0: mw[0], m1: mw[1],
      M: function (id) { for (var i = 0; i < sec.metrics.length; i++) if (sec.metrics[i].id === id) return sec.metrics[i]; return null; },
      has: function (id) { var M = this.M(id), self2 = this; if (!M) return false; if (M.multi) return M.multi.every(function (x) { return self2.has(x); }); return !M.available || M.available({ prod: st.prod }); },
      subs: function (id) { var M = this.M(id), self2 = this; return M.multi ? M.multi.map(function (x) { return self2.M(x); }) : [M]; },
      vals: function (id, mode) { mode = mode || 'level'; var key = id + '|' + mode; if (memo[key]) return memo[key];
        var M = this.M(id), c = base.comp[id], v;
        if (M.multi) return (memo[key] = this.vals(M.multi[0], mode));   // composto: o 1º indicador responde pelos números de referência
        if (mode === 'ltm') v = M.calc(A.ltm, c, { gran: st.gran, prod: st.prod });
        else { v = M.calc(A.level, c, { gran: st.gran, prod: st.prod });
          if (mode === 'yoy') { var lv = v; v = lv.map(function (_, i) {
            if (!P[i].partial) return change(lv, i, PER, M);
            if (P[i].a - 12 < 0) return null;   // parcial: compara com os MESMOS meses do ano anterior
            var b0 = M.calc(aggregators([{ a: P[i].a - 12, b: P[i].b - 12 }], PER).level, c, { gran: st.gran, prod: st.prod })[0];
            return change([b0, lv[i]], 1, 1, M); }); } }
        return (memo[key] = v); },
      monthly: function (id) { var key = id + '|m'; if (memo[key]) return memo[key]; var M = this.M(id), PM = buildPeriods(base.ax, 'monthly');
        return (memo[key] = { P: PM, v: M.calc(aggregators(PM, 12).level, base.comp[id], { gran: 'monthly', prod: st.prod }) }); },
      lastFull: function (v) { for (var i = v.length - 1; i >= 0; i--) if (v[i] != null && !P[i].partial) return i; return -1; },
      partialAt: function () { var n = P.length - 1; return (n >= 0 && P[n].partial && n >= pw[0] && n <= pw[1]) ? n - pw[0] : null; },
      label: function (i) { return P[i] ? P[i].label : ''; }
    };
    return ctx;
  };

  /* ── esqueleto da seção (uma vez por seção) ── */
  Desk.prototype._build = function () {
    var r = this.root, self = this; r.innerHTML = '';
    var body = h('div', 'dk-body');
    this.el = { tiles: h('div', 'dk-tiles'), cols: h('div', 'dk-cols'), main: h('div', 'dk-main'), side: h('div', 'dk-side') };
    var E = this.el;
    E.stage = h('div', 'dk-stage dk-card chart-card',
      '<div class="dk-sh"><div><div class="dk-st chart-title"></div><div class="dk-sv"></div></div><div class="dk-sd chart-sub"></div><span class="dk-grow"></span><div class="dk-styw"></div><div class="dk-seg dk-modes" role="group" aria-label="View"></div></div>' +
      '<div class="dk-hfleg dk-sleg"></div><div class="dk-whyrow"><div class="dk-why" hidden></div><div class="dk-corr" hidden></div></div><div class="dk-chart dk-stagechart"><canvas id="dk-stage-cv"></canvas></div><div class="dk-sgrid" hidden></div><div class="dk-brush"></div>' +
      '<div class="dk-hintrow"><div class="dk-hint">Hover to read · Click two periods to compare them (A → B) · Drag the strip to change the period</div>' +
      '<button type="button" class="dk-lnk dk-tob" title="Open this series in the Builder, where you can put up to 4 series side by side" hidden>Compare with other series in Builder →</button></div>');
    E.who = h('div', 'dk-card dk-who chart-card',
      '<div class="dk-ch"><h3 class="chart-title">Who is behind the number</h3><em class="dk-when"></em></div><div class="dk-why dk-whowhy" hidden></div>' +
      '<div class="dk-whotop"><div class="dk-seg dk-dims" role="group" aria-label="Breakdown by" hidden></div><div class="dk-pills" role="group" aria-label="Sub-product"></div><span class="dk-grow"></span><div class="dk-styw dk-whosty"></div><div class="dk-seg dk-whomodes" role="group" aria-label="Breakdown view"></div>' +
      '<div class="dk-pop"><button type="button" class="dk-pill dk-popbtn" aria-expanded="false"></button><div class="dk-popp" hidden></div></div></div>' +
      '<div class="dk-pills dk-subpills" role="group" aria-label="Sub-product" hidden></div><div class="dk-whogrid"><div class="dk-rank"></div><div class="dk-chart dk-whochart"><canvas id="dk-who-cv"></canvas></div></div>');
    E.minis = h('div', 'dk-minis');
    E.ctx = h('div', 'dk-ctx0');   // Context: o que está em volta do número (data-desk-context.js)
    E.read = h('div', 'dk-card dk-read', '<div class="dk-ch"><h3>Reading</h3><em class="dk-when"></em></div><div class="dk-big"></div><div class="dk-kv"></div><div class="dk-pins"></div>');
    E.cols.appendChild(E.stage); E.cols.appendChild(E.read);
    var sec0 = this.sections[this.cur], vs = (sec0.views || []).filter(function (v) { return !v.visible || v.visible(); }), vb = h('div', 'dk-viewbar'), anyCur = vs.some(function (v) { return v.current; });
    if (vs.length > 1) { E.views = h('div', 'dk-seg dk-views', vs.map(function (v, k) { return '<button type="button" data-k="' + k + '" aria-pressed="' + (anyCur ? !!v.current : k === 0) + '">' + esc(v.label) + '</button>'; }).join(''));
      E.views.setAttribute('role', 'group'); E.views.setAttribute('aria-label', 'View');
      E.views.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var v = vs[+b.dataset.k]; if (v && v.onPick) v.onPick(); });
      vb.appendChild(E.views); }
    if (sec0.prods) { vb.appendChild(h('span', 'dk-plbl', 'Product')); E.prods = h('div', 'dk-seg dk-prods'); E.prods.setAttribute('role', 'group'); E.prods.setAttribute('aria-label', 'Product');
      E.prods.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var u = self._u(); u.prod = b.dataset.k; u.hover = u.pinA = u.pinB = null; u.who.pill = u.who.sub = u.who.sel = u.who.hi = null; self.refresh(); });
      vb.appendChild(E.prods); }
    if (vb.childNodes.length) body.appendChild(vb);
    body.appendChild(E.tiles); body.appendChild(E.cols); body.appendChild(E.ctx); body.appendChild(E.who); body.appendChild(E.minis); r.appendChild(body);
    // eventos fixos
    E.tiles.addEventListener('click', function (e) { var b = e.target.closest('.dk-tile[data-k]'); if (!b) return; self._u().metric = b.dataset.k; self.refresh(); });
    E.minis.addEventListener('click', function (e) { if (e.target.closest('.ibba-dl')) return; var b = e.target.closest('.dk-mini[data-k]'); if (!b) return; self._u().metric = b.dataset.k; self.refresh(); });
    E.stage.querySelector('.dk-modes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || b.disabled) return; self._u().mode = b.dataset.k; self.refresh(); });
    E.who.querySelector('.dk-whomodes').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; self._u().who.mode = b.dataset.k; self._who(); });
    /* seletor "Chart" do palco e do "Who": troca só o desenho (o dado é o mesmo) */
    E.stage.querySelector('.dk-styw').addEventListener('click', function (e) { var b = e.target.closest('button[data-sty]'); if (!b || b.disabled) return; self._setSty('stage', b.dataset.sty, self._stageOpts()); self.refresh(); });
    E.who.querySelector('.dk-whosty').addEventListener('click', function (e) { var b = e.target.closest('button[data-sty]'); if (!b || b.disabled) return; self._setSty('who', b.dataset.sty, self._whoOpts(self._u().who.mode)); self._who(); self._paintMarks(); });
    E.who.querySelector('.dk-dims').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var w = self._u().who; w.dim = +b.dataset.k; w.pill = null; w.sub = null; w.sel = null; w.hi = null; self._who(); self._paintMarks(); self._rank(); });
    E.who.querySelector('.dk-pills').addEventListener('click', function (e) { var b = e.target.closest('.dk-pill'); if (!b) return; var w = self._u().who; w.pill = b.dataset.k; w.sub = null; w.sel = null; w.hi = null; self._who(); self._rank(); });
    E.who.querySelector('.dk-subpills').addEventListener('click', function (e) { var b = e.target.closest('.dk-pill'); if (!b) return; var w = self._u().who; w.sub = b.dataset.k || null; w.sel = null; w.hi = null; self._who(); self._rank(); });
    var pb = E.who.querySelector('.dk-popbtn'), pp = E.who.querySelector('.dk-popp');
    pb.addEventListener('click', function (e) { e.stopPropagation(); self._openPop(pp.hidden); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.dk-pop')) self._openPop(false); });
    this._bindHover(E.stage.querySelector('canvas'), 'stage'); this._bindHover(E.who.querySelector('canvas'), 'who');
    var tob = E.stage.querySelector('.dk-tob'); tob.hidden = !(this.sections.builder && this._builder && this.builderFrom && !sec0.fixed);
    tob.addEventListener('click', function () { self.builderFrom(); });
    this._built = this.cur;
  };
  Desk.prototype._openPop = function (open) { if (!this.el || !this.el.who) return;   /* seções sem o bloco 'Who' (preços, Builder): o clique fora não tem janela para fechar */ var E = this.el; if (!E) return; var pp = E.who.querySelector('.dk-popp'), pb = E.who.querySelector('.dk-popbtn'); pp.hidden = !open; pb.setAttribute('aria-expanded', open ? 'true' : 'false'); if (open) { this._fillPop(); var q = pp.querySelector('input[type=search]'); if (q) q.focus(); } };

  /* mouse → índice do período; um quadro por movimento */
  Desk.prototype._bindHover = function (cv, id) {
    var self = this;
    var at = function (ev) { var ch = self.charts[id]; if (!ch || !ch.chartArea) return null; var r = cv.getBoundingClientRect(), x = ev.clientX - r.left, xs = ch.scales.x, n = ch.data.labels.length;
      var i = Math.round(xs.getValueForPixel(x)); return Math.max(0, Math.min(n - 1, i)); };
    cv.addEventListener('pointermove', function (ev) { var i = at(ev); if (i == null) return; var ch = self.charts[id]; if (ch.$local) { self._localHover(id, i); return; } self.hover(self.ctx.i0 + i); });
    cv.addEventListener('pointerleave', function () { var ch = self.charts[id]; if (ch && ch.$local) { self._localHover(id, null); return; } self.hover(null); });
    if (id === 'stage') cv.addEventListener('click', function (ev) { var ch = self.charts[id]; if (!ch || ch.$local) return; var sp = ch.options.plugins && ch.options.plugins.ibbaDeskSync;
      if (ch.config.type === 'bar' && !(sp && sp.pins)) return; var i = at(ev); if (i != null) self.pick(self.ctx.i0 + i); });
  };
  Desk.prototype.hover = function (i) {
    var u = this._u(); if (u.hover === i) return; u.hover = i; var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._paintMarks(); self._read(); self._rank(); self._miniHeads(); });
  };
  Desk.prototype._paintMarks = function () {
    var u = this._u(), c = this.ctx, k;
    for (k in this.charts) { var ch = this.charts[k]; if (!ch || ch.$local) continue;
      ch.$dk = { hover: u.hover == null ? null : u.hover - c.i0, pinA: u.pinA == null ? null : u.pinA - c.i0, pinB: u.pinB == null ? null : u.pinB - c.i0 }; ch.draw(); }
  };
  Desk.prototype.pick = function (i) { var u = this._u(); if (u.pinA == null || (u.pinA != null && u.pinB != null)) { u.pinA = i; u.pinB = null; } else if (i === u.pinA) u.pinA = null; else u.pinB = i; this._paintMarks(); this._read(); this._rank(); };
  Desk.prototype._ref = function () { var u = this._u(), c = this.ctx; if (u.hover != null) return u.hover; if (u.pinA != null) return u.pinA; var li = c.lastFull(c.vals(u.metric)); return li < 0 ? c.i1 : Math.min(li, c.P.length - 1); };

  /* cria ou atualiza um gráfico Chart.js no canvas */
  Desk.prototype._chart = function (id, cv, type, labels, datasets, o) {
    var ch = this.charts[id], opt = chartOptions(o);
    if (ch && ch.canvas === cv && ch.config.type === type) { ch.stop(); ch.data.labels = labels; ch.data.datasets = datasets; ch.options = opt; ch.$local = !!o.local; ch.update('none'); return ch; }
    if (ch) ch.destroy();
    opt.animation = o.animate === false ? false : { duration: 280 };
    ch = this.charts[id] = new Chart(cv.getContext('2d'), { type: type, data: { labels: labels, datasets: datasets }, options: opt });
    ch.$local = !!o.local; ch.options.animation = false;   // nasce crescendo; as trocas de filtro não animam
    return ch;
  };
  Desk.prototype._dropCharts = function (prefix) { for (var k in this.charts) if (k.indexOf(prefix) === 0) { try { this.charts[k].destroy(); } catch (e) {} delete this.charts[k]; } };

  /* ── redesenho ── */
  Desk.prototype.show = function (id) {
    if (!this.sections[id]) return false;
    if (this.cur !== id) { this.cur = id; this._destroyAll(); this._built = null; }
    this.refresh(); return true;
  };
  Desk.prototype.hide = function () { this.cur = null; this._destroyAll(); };
  Desk.prototype._destroyAll = function () { for (var k in this.charts) { try { this.charts[k].destroy(); } catch (e) {} } this.charts = {}; };
  Desk.prototype.invalidate = function () { this._cache = {}; this._who_cache = {}; this._bData = {}; this._bItems = {}; this._bEnt = {}; this._hfC = {}; };
  Desk.prototype.refresh = function (light) {
    if (!this.cur) return;
    if (this.sections[this.cur].overview) return this._overview();
    if (this.sections[this.cur].builder) return this._builder ? this._builder() : null;   // a bancada (data-desk-builder.js)
    if (this.sections[this.cur].hf) return this._hf ? this._hf() : null;   // preços em frequência diária/semanal (data-desk-prices.js)
    if (this._built !== this.cur) this._build();
    var st = this.cfg.state(), u = this._u();
    if (!this.sections[this.cur].prods && (this._lastProd !== st.prod || this._lastGran !== st.gran)) { if (this._lastProd !== st.prod) { u.who.pill = null; u.who.sub = null; u.who.sel = null; u.who.hi = null; } u.hover = u.pinA = u.pinB = null; this._lastProd = st.prod; this._lastGran = st.gran; }
    var c = this.ctx = this._ctx(), sec = c.sec;
    if (this.el.prods) this.el.prods.innerHTML = sec.prods.map(function (p0) { return '<button type="button" data-k="' + esc(p0.k) + '" aria-pressed="' + (p0.k === c.st.prod) + '">' + esc(p0.l) + '</button>'; }).join('');
    if (sec.modes && sec.modes.indexOf(u.mode) < 0) u.mode = sec.modes[0];
    if (!c.has(u.metric)) u.metric = this.sections[this.cur].stage;
    if (st.gran === 'annual' && (u.mode === 'ltm' || u.mode === 'seasonal')) u.mode = 'level';
    if (!light) this._tiles();
    this._stage(); if (!light && !sec.noBrush) this._brush(); this.el.stage.querySelector('.dk-brush').hidden = !!sec.noBrush;
    this._who(); this._minis(); this._paintMarks(); this._read(); this._rank();
    if (!light && this._context) { try { this._context(); } catch (e) { console.warn('desk context', e); } }
    this._uBase();
    if (!light && this.cfg.afterRender) { try { this.cfg.afterRender(this); } catch (e) { console.warn('desk afterRender', e); } }
  };

  /* os indicadores que têm quadro no topo (o sufixo antigo ":ytd" é ignorado: o acumulado do ano mora no painel Reading) */
  Desk.prototype._tileIds = function () { var c = this.ctx, seen = {}; return (c.sec.tiles || []).filter(function (t) { return t.indexOf(':') < 0; }).filter(function (id) { if (seen[id] || !c.M(id)) return false; seen[id] = 1; return true; }); };
  Desk.prototype._tiles = function () {
    var c = this.ctx, u = this._u(), self = this, t = theme(), prev = { monthly: 'MoM', quarterly: 'QoQ', annual: 'YoY' }[c.st.gran];
    /* rodapé de cada quadro: deixa escrito que ele é um BOTÃO que troca o gráfico principal */
    var act = '<div class="dk-ta"><i></i><span class="dk-ta0">Show on chart</span><span class="dk-ta1">On the main chart</span></div>';
    var tipOf = function (M0) { var hp = self._help(self.cur, M0.id, { prod: c.st.prod, label: self._lbl(M0), gran: c.st.gran }); return ((hp && hp.what) ? hp.what + '\n\n' : '') + 'Click to show it on the main chart.'; };
    this.el.tiles.innerHTML = this._tileIds().map(function (id) {
      var M = c.M(id), lbl = M.tileLabel ? (typeof M.tileLabel === 'function' ? M.tileLabel({ prod: c.st.prod }) : M.tileLabel) : self._lbl(M);   // M.tileLabel: rótulo curto só no quadro (o gráfico leva o nome inteiro)
      if (!c.has(id) && M.hideNA) return '';
      if (!c.has(id)) return '<div class="dk-tile dk-off"><div class="dk-tl"><span>' + esc(lbl) + '</span></div><div class="dk-tv">—</div><div class="dk-td">' + esc(M.naText || 'Not available for this selection') + '</div></div>';
      if (M.multi) {   // composto (ex.: preço de importação × referência doméstica): as duas séries no mesmo quadro
        var subs = c.subs(id), i0 = c.lastFull(c.vals(subs[0].id)); if (i0 < 0) return '';
        var cols = subs.map(function (_, k) { var nm = (M.multiColors || ['orange', 'ink'])[k]; return nm === 'ink' ? t.ink : nm === 'orange' ? ORANGE : nm == null ? slotColor(k) : nm; }), from = Math.max(0, i0 - 2 * c.PER + 1);
        return '<button type="button" class="dk-tile dk-tmulti" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '" title="' + esc(tipOf(M)) + '"><div class="dk-tl"><span>' + esc(lbl) + '</span><span>' + c.label(i0) + '</span></div>' +
          subs.map(function (S2, k) { var v2 = c.vals(S2.id), y2 = change(v2, i0, c.PER, S2);
            return '<div class="dk-tm"><i style="background:' + cols[k] + '"></i><span>' + esc(self._short(S2)) + '</span><b>' + fmt(v2[i0], S2.dec) + '<small>' + esc(S2.unit) + '</small></b><span class="' + cls(y2) + '">' + chgTxt(S2, y2) + '</span></div>'; }).join('') +
          '<div class="dk-sp">' + sparkMulti(subs.map(function (S2, k) { return { v: c.vals(S2.id).slice(from, i0 + 1), color: cols[k] }; }), 160, 30) + '</div>' + act + '</button>';
      }
      var v = c.vals(id), i = c.lastFull(v); if (i < 0) return '';
      var r = rangeN(v, i, 5 * c.PER), mo = change(v, i, 1, M), yy = change(v, i, c.PER, M), sp = v.slice(Math.max(0, i - 2 * c.PER + 1), i + 1);
      return '<button type="button" class="dk-tile" data-k="' + id + '" aria-pressed="' + (u.metric === id) + '" title="' + esc(tipOf(M)) + '"><div class="dk-tl"><span>' + esc(lbl) + '</span><span>' + c.label(i) + '</span></div>' +
        '<div class="dk-tv">' + fmt(v[i], M.dec) + '<small>' + esc(M.unit) + '</small></div>' +
        '<div class="dk-td"><span>' + prev + ' <span class="' + cls(mo) + '">' + chgTxt(M, mo) + '</span></span>' + (c.st.gran === 'annual' ? '' : '<span>YoY <span class="' + cls(yy) + '">' + chgTxt(M, yy) + '</span></span>') + '</div>' +
        '<div class="dk-sp">' + sparkSVG(sp, 160, 30) + '</div>' +
        '<div class="dk-rng"><i style="left:' + (r.pos * 100).toFixed(0) + '%"></i></div><div class="dk-rngl"><span>5y low ' + fmt(r.mn, M.dec) + '</span><span>high ' + fmt(r.mx, M.dec) + '</span></div>' + act + '</button>';
    }).join('');
    this.el.tiles.hidden = !this.el.tiles.innerHTML;
  };
  Desk.prototype._lbl = function (M) { return typeof M.label === 'function' ? M.label({ prod: this.ctx.st.prod }) : M.label; };
  Desk.prototype._short = function (M) { return typeof M.short === 'function' ? M.short({ prod: this.ctx.st.prod }) : (M.short || this._lbl(M)); };
  Desk.prototype._stageInfo = function () {
    var c = this.ctx, u = this._u(), M = c.subs(u.metric)[0];
    if (u.mode === 'yoy') return { M: M, v: c.vals(u.metric, 'yoy'), unit: M.pp ? 'pp' : M.diff ? M.unit : '%', dec: 1, bars: true, name: 'YoY' };
    if (u.mode === 'ltm') return { M: M, v: c.vals(u.metric, 'ltm'), unit: M.unit, dec: M.dec, name: c.st.gran === 'quarterly' ? 'last 4 quarters' : 'last 12 months' };
    return { M: M, v: c.vals(u.metric), unit: M.unit, dec: M.dec, name: '' };
  };
  /* as visualizações do palco: 2–3 desenhos do MESMO dado conforme a vista. [chave, rótulo, dica, desligado, ícone] */
  Desk.prototype._stageOpts = function () {
    var c = this.ctx, u = this._u(), M = c.M(u.metric), multi = c.subs(u.metric).length > 1, mode = u.mode, per = c.PER === 4 ? 'quarter' : 'month';
    if (mode === 'seasonal') return [['lines', 'Lines', 'One line per year', 0, 'year'], ['range', 'Range', 'This year and last year against the range of the years before', 0, 'range'], ['grid', 'Grid', 'Every year and every ' + per + ' in a table, shaded by size', 0, 'grid']];
    if (multi) { var gap = ['gap', 'Gap', 'The difference between the two series in each period', 0, 'gap'];
      if (mode !== 'level') return [['line', 'Lines', 'One line per series', 0, 'lines'], ['col', 'Columns', 'Side-by-side columns']];
      return M.multiBars ? [['col', 'Columns', 'Side-by-side columns'], ['line', 'Lines', 'One line per series', 0, 'lines'], gap] : [['line', 'Lines', 'One line per series', 0, 'lines'], ['col', 'Columns', 'Side-by-side columns'], gap]; }
    if (mode === 'yoy') return [['col', 'Columns', 'Green = higher than a year earlier, red = lower', 0, 'gap'], ['line', 'Line', 'The change as a line']];
    if (mode === 'ltm') return [['line', 'Line'], ['col', 'Columns']];
    if (M.signBars) return [['col', 'Columns', 'Green = above zero, red = below', 0, 'gap'], ['line', 'Line']];
    return [['line', 'Line'], ['col', 'Columns'], ['colyoy', 'Columns + YoY', 'Columns for the figure and a line for the change against a year earlier (right-hand scale)', 0, 'colyoy']];
  };
  Desk.prototype._stage = function () {
    var c = this.ctx, u = this._u(), M = c.M(u.metric), E = this.el, cv = E.stage.querySelector('canvas'), t = theme(), ann = c.st.gran === 'annual', self = this;
    var subs = c.subs(u.metric), multi = subs.length > 1;
    E.stage.querySelector('.dk-modes').innerHTML = [['level', 'Level'], ['yoy', 'YoY'], ['ltm', 'LTM', ann], ['seasonal', 'Seasonal', ann || multi]].map(function (m) {
      var off = m[2] || (c.sec.modes && c.sec.modes.indexOf(m[0]) < 0); return '<button type="button" data-k="' + m[0] + '" aria-pressed="' + (u.mode === m[0]) + '"' + (off ? ' disabled title="Not available here"' : '') + '>' + m[1] + '</button>'; }).join('');
    E.stage.querySelector('.dk-modes').hidden = !!(c.sec.modes && c.sec.modes.length < 2);
    if (multi && u.mode === 'seasonal') u.mode = 'level';
    /* a visualização escolhida (seletor "Chart"; a 1ª opção é o desenho de sempre) */
    var opts = this._stageOpts(), sty = this._sty('stage', opts), sw = E.stage.querySelector('.dk-styw');
    if (sw) sw.innerHTML = opts.length > 1 ? styleSeg(opts, sty) : '';
    var gridEl = E.stage.querySelector('.dk-sgrid'), box = E.stage.querySelector('.dk-stagechart');
    if (gridEl) { gridEl.hidden = true; gridEl.innerHTML = ''; } if (box) box.hidden = false; E.stage.classList.remove('dk-isgrid');
    var title = E.stage.querySelector('.dk-st'), brush = E.stage.querySelector('.dk-brush');
    /* a explicação do gráfico (textos em data-desk-help.js); sem texto lá, a nota antiga do catálogo */
    var note = typeof M.note === 'function' ? M.note({ prod: c.st.prod }) : (M.note || ''), hp = this._help(this.cur, M.id, { prod: c.st.prod, label: this._lbl(M), gran: c.st.gran });
    var colOf = function (k) { var name = (M.multiColors || ['orange', 'ink'])[k]; return name === 'ink' ? t.ink : name === 'orange' ? ORANGE : name == null ? slotColor(k) : name; };
    this._refAvg = null;
    var sleg = E.stage.querySelector('.dk-sleg'); if (sleg) sleg.innerHTML = '';   // a legenda dos anos só existe na vista Seasonal
    var corr = E.stage.querySelector('.dk-corr'); if (corr) { corr.innerHTML = ''; corr.hidden = true; }   // a tabela de correlação só com 2+ séries
    if (u.mode === 'seasonal') {
      /* sazonalidade: UMA LINHA POR ANO (os 4 anteriores + o atual), como na tela de sempre; a dica lista todos os anos.
         Range = o ano atual e o anterior contra a faixa (menor–maior) e a média dos anos anteriores; Grid = tabela ano × mês. */
      var v = c.vals(u.metric), li = c.lastFull(v), yL = c.P[li].y, byY = {}, PER = c.PER;
      v.forEach(function (x, i) { var p = c.P[i]; if (p.partial) return; (byY[p.y] = byY[p.y] || new Array(PER).fill(null))[p.k] = x; });
      var labs = PER === 12 ? MON.slice() : ['Q1', 'Q2', 'Q3', 'Q4'], ds = [], yrs = [], y;
      for (y = yL - 4; y < yL; y++) if (byY[y]) yrs.push(y);
      this._seas = { yL: yL, byY: byY, labs: labs, M: M, base: '', yrs: [yL].concat(yrs.slice().reverse()), k0: c.P[li].k, sty: sty, rng: null };
      if (sty === 'grid') {
        this._dropCharts('stage'); if (box) box.hidden = true; E.stage.classList.add('dk-isgrid');
        if (gridEl) { gridEl.innerHTML = this._seasGrid(byY, labs, M, yL); gridEl.hidden = false; }
      } else {
        if (sty === 'range' && yrs.length) {
          var lo = [], hi = [], av = [], k;
          for (k = 0; k < PER; k++) { var xs = yrs.map(function (yy) { return (byY[yy] || [])[k]; }).filter(function (x) { return x != null; });
            lo.push(xs.length ? Math.min.apply(null, xs) : null); hi.push(xs.length ? Math.max.apply(null, xs) : null); av.push(xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null); }
          var rn = yrs[0] + (yrs.length > 1 ? '–' + yrs[yrs.length - 1] : '');
          var dLo = lineSet(lo, 'rgba(0,0,0,0)', { label: 'Lowest ' + rn, w: 0, noDot: true }), dHi = lineSet(hi, 'rgba(0,0,0,0)', { label: 'Highest ' + rn, w: 0, noDot: true });
          dHi.fill = '-1'; dHi.backgroundColor = 'rgba(' + t.band + ',' + (t.dark ? .17 : .11) + ')'; dLo.order = 8; dHi.order = 8;
          var dAv = lineSet(av, 'rgba(' + t.band + ',.55)', { label: 'Average ' + rn, w: 1.4, dash: [5, 3], noDot: true }); dAv.order = 7;
          var yP = yL - 1, dP = byY[yP] ? lineSet(byY[yP], t.ink, { label: String(yP), w: 2, surf: t.surf }) : null; if (dP) dP.order = 2;
          var dC = lineSet(byY[yL] || [], ORANGE, { label: String(yL), w: 2.6, end: true, surf: t.surf }); dC.order = 0;
          ds = [dLo, dHi, dAv].concat(dP ? [dP] : [], [dC]);
          this._seas.rng = { lo: lo, hi: hi, av: av, rn: rn };
        } else {
          yrs.forEach(function (yy) { var k1 = yL - yy, st = yearStyle(k1);   // uma cor por ano; os anteriores ao último, pontilhados
            var d0 = lineSet(byY[yy], st.color, { label: String(yy), w: st.w, dash: st.dash, surf: t.surf }); d0.order = k1 + 1; ds.push(d0); });
          var cur = lineSet(byY[yL] || [], ORANGE, { label: String(yL), w: 2.6, end: true, surf: t.surf }); cur.order = 0; ds.push(cur);
        }
        this._chart('stage', cv, 'line', labs, ds, { stage: true, dec: M.dec, local: true, tip: true, unitTip: M.unit });
        this._seasLeg(null);
      }
      title.textContent = this._lbl(M) + ' · seasonality';
      E.stage.querySelector('.dk-sv').innerHTML = fmt(v[li], M.dec) + '<small>' + esc(M.unit) + ' · ' + c.label(li) + '</small>';
      E.stage.querySelector('.dk-sd').textContent = this._seas.base; brush.style.visibility = 'hidden';
      E.stage.querySelector('.dk-hint').textContent = sty === 'grid' ? 'Each row is a year · darker cells = higher values' : 'Hover to read every year';
      this._whyStage(M, hp, note, { mode: 'seasonal', yL: yL, PER: PER, sty: sty, y0: yrs[0], y1: yrs[yrs.length - 1] });
      return;
    }
    brush.style.visibility = 'visible';
    var si = this._stageInfo(), sl = function (arr) { return arr.slice(c.i0, c.i1 + 1); }, labels = c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.label; }), sets, pa = c.partialAt();
    var sign = function (arr) { return arr.map(function (x) { return x == null ? 'transparent' : x >= 0 ? UP() : DOWN(); }); };
    var winAvg = function (arr, label) { var w = arr.filter(function (x) { return x != null; }), avg = w.length ? w.reduce(function (a, b) { return a + b; }, 0) / w.length : null;
      var s3 = lineSet(labels.map(function () { return avg; }), 'rgba(' + t.band + ',.5)', { label: label || 'Window average', w: 1.2, dash: [5, 3], noDot: true }); s3.order = 0; self._refAvg = avg; return s3; };
    var zero = function () { var z = lineSet(labels.map(function () { return 0; }), 'rgba(' + t.band + ',.35)', { label: 'Zero', w: 1, noDot: true }); z.$noTip = true; z.order = 9; return z; };
    var ink = t.dark ? '#e8eaed' : '#111111', kind = 'line', tip = false, y2 = null, gapT = '';
    if (!multi && u.mode === 'yoy') {
      if (sty === 'line') { tip = true; sets = [lineSet(sl(si.v), ORANGE, { label: this._lbl(M) + ' — YoY', w: 2.2, end: true, surf: t.surf, partialAt: pa }), zero()]; }
      else { kind = 'bar'; tip = true; sets = [barSet(sl(si.v), sign(sl(si.v)), { label: this._lbl(M) + ' — YoY', partialAt: pa })]; }
    }
    else if (!multi && u.mode === 'level' && M.signBars) {   // prêmio: barras verdes/vermelhas + média da janela (como na tela de sempre) — ou a mesma conta em linha
      var d1 = sl(si.v);
      if (sty === 'line') { tip = true; sets = [lineSet(d1, ORANGE, { label: this._lbl(M), w: 2.2, end: true, surf: t.surf, partialAt: pa }), winAvg(d1, 'Window average'), zero()]; }
      else { kind = 'bar'; tip = true; sets = [barSet(d1, sign(d1), { label: this._lbl(M), partialAt: pa }), winAvg(d1, 'Window average')]; }
    } else if (multi && u.mode === 'level' && sty === 'gap') {   // a diferença entre as duas séries, período a período
      var g0 = sl(c.vals(subs[0].id)), g1 = sl(c.vals(subs[1].id)), gd = g0.map(function (x, i) { return (x == null || g1[i] == null) ? null : x - g1[i]; });
      kind = 'bar'; tip = true; gapT = this._short(subs[0]) + ' − ' + this._short(subs[1]); sets = [barSet(gd, sign(gd), { label: gapT, partialAt: pa })];
    } else if (multi && sty === 'col') {   // as duas séries lado a lado (ex.: compras × vendas)
      kind = 'bar'; tip = true; sets = subs.map(function (S2, k) { return barSet(sl(c.vals(S2.id, u.mode)), k ? hexA(ink, .78) : ORANGE, { label: self._lbl(S2), partialAt: pa }); });
    } else if (multi) {   // duas linhas no mesmo eixo (mesma unidade) — a dica mostra as duas
      tip = true; sets = subs.map(function (S2, k) { var col = M.multiBars ? (k ? ink : ORANGE) : colOf(k);
        return lineSet(sl(c.vals(S2.id, u.mode)), col, { label: self._lbl(S2), w: 2.2, end: true, surf: t.surf, partialAt: pa }); });
    } else {
      var lv = sl(si.v), over = [];
      if (u.mode === 'level' && c.st.gran === 'monthly' && !M.noAvg) { var ma = c.vals(u.metric, 'ltm').map(function (x) { return x == null ? null : (M.flow ? x / 12 : x); });
        var s2 = lineSet(sl(ma), 'rgba(' + t.band + ',.45)', { label: '12-month average', w: 1.3, dash: [4, 3], noDot: true }); s2.order = 2; over.push(s2); }
      if (M.ref === 'windowAvg' && u.mode === 'level') { var s3b = winAvg(lv); s3b.order = 3; over.push(s3b); }
      if (M.ma3 && u.mode === 'level' && c.st.gran === 'monthly') { var fv = si.v, m3 = fv.map(function (_, i) { return (i >= 2 && fv[i] != null && fv[i - 1] != null && fv[i - 2] != null) ? (fv[i] + fv[i - 1] + fv[i - 2]) / 3 : null; });
        var s4 = lineSet(sl(m3), 'rgba(' + t.band + ',.6)', { label: '3-month moving average', w: 1.5, dash: [5, 3], noDot: true }); s4.order = 2; over.push(s4); }
      if (sty === 'col' || sty === 'colyoy') {   // colunas (o número de cada período) — e, em "Columns + YoY", a variação anual em linha na escala da direita
        kind = 'bar'; var b0 = barSet(lv, ORANGE, { label: this._lbl(M), partialAt: pa }); sets = [b0].concat(over);
        if (sty === 'colyoy') { tip = true; var yu = M.pp ? 'pp' : M.diff ? M.unit : '%', yy = lineSet(sl(c.vals(u.metric, 'yoy')), ink, { label: 'YoY', w: 2, end: true, surf: t.surf, partialAt: pa });
          yy.yAxisID = 'y2'; yy.$unit = yu; yy.$dec = 1; yy.order = 0; b0.$unit = M.unit; b0.$dec = M.dec || 0; over.forEach(function (s0) { s0.$unit = M.unit; s0.$dec = M.dec || 0; });
          sets.push(yy); y2 = { dec: 0, suffix: yu === '%' ? '%' : '' }; }
      } else sets = [lineSet(lv, ORANGE, { label: this._lbl(M), w: 2.4, area: !M.diff, end: true, surf: t.surf, partialAt: pa })].concat(over);
    }
    this._chart('stage', cv, kind, labels, sets, { stage: true, dec: si.dec, bar: kind === 'bar', tip: tip, pins: !tip, y2: y2, unitTip: u.mode === 'yoy' ? si.unit : (multi || tip ? M.unit || subs[0].unit : '') });
    /* duas séries no mesmo gráfico: o R² da 2ª contra a 1ª, na janela e na vista da tela (período em andamento fica de fora) */
    var fits = null;
    if (multi) { var mv = subs.map(function (S2) { return c.vals(S2.id, u.mode).map(function (x, i) { return c.P[i].partial ? null : x; }); });
      fits = mv.map(function (arr, k) { return k ? r2of(mv[0], arr, c.i0, c.i1) : null; });
      var perW = { monthly: 'months', quarterly: 'quarters', annual: 'years' }[c.st.gran] || 'periods';
      if (corr) { corr.innerHTML = corrTable(subs.map(function (S2, k) { return { name: self._lbl(S2), short: self._short(S2), color: M.multiBars ? (k ? ink : ORANGE) : colOf(k) }; }), corrCells(mv, c.i0, c.i1), perW); corr.hidden = !corr.innerHTML; } }
    this._stageFits = fits;
    title.textContent = this._lbl(M) + (si.name ? ' · ' + si.name : '') + (gapT ? ' · gap' : '');
    E.stage.querySelector('.dk-hint').textContent = (tip ? 'Hover to read the values' : 'Hover to read · Click two periods to compare them (A → B)') + (c.sec.noBrush ? '' : ' · Drag the strip to change the period');
    var lvl = u.mode === 'level' && !multi && (kind === 'line' || sty === 'col' || sty === 'colyoy'), mon = c.st.gran === 'monthly';
    this._whyStage(M, hp, note, { mode: u.mode, kind: kind, multi: multi, subs: subs, sty: sty, avg12: lvl && mon && !M.noAvg && !M.signBars, winAvg: lvl && M.ref === 'windowAvg', ma3: lvl && mon && !!M.ma3, partial: pa != null && pa >= 0, r2: !!fits });
  };
  /* o quadro "What it shows / How to read" do palco: o "how" é montado a partir do que está desenhado */
  Desk.prototype._whyStage = function (M, hp, note, o) {
    var el = this.el && this.el.stage && this.el.stage.querySelector('.dk-why'); if (!el) return;
    var H = window.IBBADeskHelp, V = (H && H.view) || {}, fill = (H && H.fill) || function (x) { return x || ''; }, gran = this.ctx.st.gran, self = this;
    var per = gran === 'quarterly' ? 'quarter' : gran === 'annual' ? 'year' : 'month', how = [], sty = o.sty || '';
    if (o.mode === 'seasonal') {
      var per1 = o.PER === 12 ? 'month' : 'quarter';
      if (sty === 'range' && V.seasRange && o.y0) how.push(fill(V.seasRange, { per1: per1, y0: o.y0, y1: o.y1, y: o.yL, yp: o.yL - 1 }));
      else if (sty === 'grid' && V.seasGrid) how.push(fill(V.seasGrid, { per1: per1, tot: M.flow ? 'total' : 'average', y: o.yL }));
      else how.push(fill(V.seasonal, { pers: o.PER === 12 ? 'months' : 'quarters', y: o.yL, y1: o.yL - 1 }));
    }
    else if (o.mode === 'yoy' && !o.multi) how.push(fill(sty === 'line' && V.yoyLine ? V.yoyLine : M.pp ? V.yoyPP : M.diff ? V.yoyDiff : V.yoy, { per: per, unit: M.pp ? 'percentage points' : M.diff ? M.unit : '%' }));
    else if (o.mode === 'ltm' && !o.multi) how.push(fill(M.flow ? V.ltmFlow : V.ltmOther, { n: gran === 'quarterly' ? '4 quarters' : '12 months' }) + (sty === 'col' && V.asCols ? ' ' + V.asCols : ''));
    else {
      if (o.multi && sty === 'gap' && V.gap) how.push(fill(V.gap, { a: self._lbl(o.subs[0]), b: self._lbl(o.subs[1]), per: per }));
      else if (o.multi) {   // duas séries: diz qual cor é qual
        var nm = function (k) { var n0 = (M.multiColors || ['orange', 'ink'])[k]; return n0 === 'orange' ? 'orange' : n0 === 'ink' ? (isDark() ? 'white' : 'black') : (k ? 'second' : 'first'); }, cap = function (x) { return x.charAt(0).toUpperCase() + x.slice(1); };
        how.push(fill(o.kind === 'bar' ? V.twoBars : V.twoLines, { c0: o.kind === 'bar' ? 'Orange' : cap(nm(0)), c1: o.kind === 'bar' ? (isDark() ? 'light' : 'dark') : nm(1), a: self._lbl(o.subs[0]), b: self._lbl(o.subs[1]) }));
        if (o.mode === 'yoy') how.push(fill(V.yoy, { per: per }).replace(/^Bars show/, 'Each line shows').replace(/: green = higher, red = lower\.$/, '.'));
        if (o.mode === 'ltm') how.push(fill(V.ltmOther, { n: gran === 'quarterly' ? '4 quarters' : '12 months' }));
      } else if (M.signBars) how.push((hp && hp.how) || V.signBars);
      else how.push(fill(sty === 'colyoy' && V.colYoy ? V.colYoy : sty === 'col' && V.levelCol ? V.levelCol : V.level, { per: per }));
      if (hp && hp.how && !M.signBars) how.push(hp.how);
      if (o.avg12 && o.winAvg) how.push(V.avgBoth); else { if (o.avg12) how.push(V.avg12); if (o.winAvg) how.push(V.winAvg); }
      if (o.ma3) how.push(V.ma3);
    }
    if (o.partial && o.mode !== 'seasonal') how.push(fill(V.partial, { per: per }));
    if (o.r2 && V.r2) how.push(V.r2);
    el.innerHTML = whyHTML((hp && hp.what) || note || '', how.filter(Boolean).join(' ')); el.hidden = !el.innerHTML;
  };
  /* a entrada de explicação de um indicador (data-desk-help.js) — {what, how} ou null */
  Desk.prototype._help = function (secId, id, o) { var H = window.IBBADeskHelp; try { return (H && H.get) ? H.get(this.cfg.sector, secId, id, o) : null; } catch (e) { return null; } };
  /* legenda da vista Seasonal: um item por ano, na cor e no traço do gráfico, com o valor do mês lido */
  Desk.prototype._seasLeg = function (i) {
    var s = this._seas, el = this.el && this.el.stage && this.el.stage.querySelector('.dk-sleg'); if (!s || !el) return;
    var k = i == null ? s.k0 : i;
    if (s.sty === 'grid') { el.innerHTML = ''; return; }
    if (s.sty === 'range' && s.rng) { var r = s.rng, f = function (x) { return x == null ? '—' : fmt(x, s.M.dec); };
      el.innerHTML = '<span class="dk-sleg0">' + esc(s.labs[k] || '') + '</span>' + yearChip(0, s.yL, f((s.byY[s.yL] || [])[k])) + (s.byY[s.yL - 1] ? yearChip(1, s.yL - 1, f(s.byY[s.yL - 1][k])) : '') +
        '<span><i class="dk-lg-dash"></i>Average ' + esc(r.rn) + ' <b>' + f(r.av[k]) + '</b></span><span><i class="dk-lg-band"></i>Range ' + esc(r.rn) + ' <b>' + f(r.lo[k]) + ' – ' + f(r.hi[k]) + '</b></span>';
      return; }
    el.innerHTML = '<span class="dk-sleg0">' + esc(s.labs[k] || '') + '</span>' + s.yrs.map(function (yy) { var v = (s.byY[yy] || [])[k];
      return yearChip(s.yrs[0] - yy, yy, v == null ? '—' : fmt(v, s.M.dec)); }).join('');
  };
  /* sazonalidade em TABELA: um ano por linha (o mais novo em cima), um mês (trimestre) por coluna; a cor diz o tamanho dentro da tabela
     (uma cor só, mais forte = maior); a última coluna é o total do ano (a média, para preços e participações). Só períodos completos. */
  Desk.prototype._seasGrid = function (byY, labs, M, yL) {
    var yrs = Object.keys(byY).map(Number).sort(function (a, b) { return b - a; }).slice(0, 12), all = [], flow = !!M.flow, PER = labs.length;
    yrs.forEach(function (y) { (byY[y] || []).forEach(function (x) { if (x != null) all.push(x); }); });
    var mn = all.length ? Math.min.apply(null, all) : 0, mx = all.length ? Math.max.apply(null, all) : 0;
    var tint = function (x) { if (x == null || !(mx > mn)) return ''; return ' style="background:rgba(255,80,0,' + (.05 + .5 * (x - mn) / (mx - mn)).toFixed(3) + ')"'; };
    var h0 = '<table class="dk-sgt"><thead><tr><th></th>' + labs.map(function (l) { return '<th>' + esc(l) + '</th>'; }).join('') + '<th class="dk-sgtt">' + (flow ? 'Total' : 'Average') + '</th></tr></thead><tbody>';
    yrs.forEach(function (y) { var row = byY[y] || [], have = row.filter(function (x) { return x != null; }), full = have.length === PER;
      var sum = have.reduce(function (a, b) { return a + b; }, 0), tot = have.length ? (flow ? sum : sum / have.length) : null;
      h0 += '<tr' + (y === yL ? ' class="dk-sgcur"' : '') + '><th>' + y + '</th>' + labs.map(function (_, k) { var x = row[k]; return '<td' + tint(x) + ' title="' + esc(labs[k] + ' ' + y + (x == null ? '' : ': ' + fmt(x, M.dec) + ' ' + M.unit)) + '">' + (x == null ? '' : fmt(x, M.dec)) + '</td>'; }).join('') +
        '<td class="dk-sgtt">' + (tot == null ? '' : fmt(tot, M.dec)) + (full || tot == null ? '' : ' <small>' + (flow ? 'YTD' : 'so far') + '</small>') + '</td></tr>'; });
    return h0 + '</tbody></table>';
  };
  Desk.prototype._localHover = function (id, i) {   // sazonalidade: lê o mês do ano, sem mexer nos outros gráficos
    var ch = this.charts[id], s = this._seas; if (!ch || !s) return;
    this._seasLeg(i);
    this.el.stage.querySelector('.dk-sd').textContent = i == null ? s.base : s.labs[i] + ': ' + s.yL + ' ' + fmt((s.byY[s.yL] || [])[i], s.M.dec) + ' · ' + (s.yL - 1) + ' ' + fmt((s.byY[s.yL - 1] || [])[i], s.M.dec) + ' ' + s.M.unit;
    ch.$dk = { hover: i, pinA: null, pinB: null }; ch.draw();   // o cursor da mesa também aqui (antes só a dica)
  };

  /* faixa de período: a série inteira em miniatura; arrastar o miolo desloca, as alças redimensionam */
  Desk.prototype._brush = function () {
    var c = this.ctx, self = this, el = this.el.stage.querySelector('.dk-brush'), v = c.vals(this._u().metric), n = c.P.length, W = el.clientWidth || 600, H = 38;
    if (n < 2) { el.innerHTML = ''; return; }
    var tb = theme(), x = function (i) { return i / (n - 1) * W; }, i0 = c.i0, i1 = c.i1, yrs = '', seen = {}, stepY = Math.max(1, Math.ceil((c.P[n - 1].y - c.P[0].y + 1) / Math.max(4, Math.floor(W / 46))));
    c.P.forEach(function (p, i) { if (!seen[p.y] && p.k === 0) { seen[p.y] = 1; if ((c.P[n - 1].y - p.y) % stepY) return; yrs += '<text x="' + (x(i) + 3) + '" y="' + (H - 1) + '" font-size="8.5" fill="' + tb.mut + '">' + p.y + '</text><line x1="' + x(i) + '" x2="' + x(i) + '" y1="0" y2="' + H + '" stroke="' + tb.grid + '"/>'; } });
    var pts = [], k; for (k = 0; k < n; k++) if (v[k] != null) pts.push([k, v[k]]);
    var mn = Math.min.apply(null, pts.map(function (p) { return p[1]; })), mx = Math.max.apply(null, pts.map(function (p) { return p[1]; }));
    var d = pts.map(function (p, j) { return (j ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + (H - 11 - (mx > mn ? (p[1] - mn) / (mx - mn) : .5) * (H - 13)).toFixed(1); }).join('');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + yrs + '<path d="' + d + '" fill="none" stroke="' + tb.mut + '" stroke-width="1"/>' +
      '<rect class="w" x="' + x(i0) + '" y="0" width="' + Math.max(6, x(i1) - x(i0)) + '" height="' + (H - 10) + '" fill="rgba(255,80,0,.16)" stroke="' + ORANGE + '" rx="3" style="cursor:grab"/>' +
      '<rect class="hl" x="' + (x(i0) - 4) + '" y="0" width="8" height="' + (H - 10) + '" fill="' + ORANGE + '" rx="2" style="cursor:ew-resize"/><rect class="hr" x="' + (x(i1) - 4) + '" y="0" width="8" height="' + (H - 10) + '" fill="' + ORANGE + '" rx="2" style="cursor:ew-resize"/></svg>';
    var svg = el.firstChild, drag = null, minSpan = Math.min(n - 1, c.st.gran === 'monthly' ? 5 : c.st.gran === 'quarterly' ? 3 : 2);
    var at = function (ev) { var r = svg.getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (n - 1)); };
    var range = function () { return { win: 'custom', from: c.ax[c.P[i0].a], to: c.ax[c.P[i1].b] }; };
    var commit = function () { var r = range(); self._ovr = null; self.cfg.setRange(r.from, r.to); };
    svg.onpointerdown = function (ev) { var cl = ev.target.getAttribute('class');
      if (!cl) { var span = i1 - i0, a = Math.max(0, Math.min(n - 1 - span, at(ev) - Math.floor(span / 2))); i0 = a; i1 = a + span; commit(); return; }
      drag = { c: cl, i: at(ev), a: i0, b: i1 }; svg.setPointerCapture(ev.pointerId); };
    svg.onpointermove = function (ev) { if (!drag) return; var dl = at(ev) - drag.i, span;
      if (drag.c === 'w') { span = drag.b - drag.a; var a = Math.max(0, Math.min(n - 1 - span, drag.a + dl)); i0 = a; i1 = a + span; }
      if (drag.c === 'hl') i0 = Math.max(0, Math.min(i1 - minSpan, drag.a + dl));
      if (drag.c === 'hr') i1 = Math.min(n - 1, Math.max(i0 + minSpan, drag.b + dl));
      var q = function (s) { return svg.querySelector('.' + s); }; q('w').setAttribute('x', x(i0)); q('w').setAttribute('width', Math.max(6, x(i1) - x(i0))); q('hl').setAttribute('x', x(i0) - 4); q('hr').setAttribute('x', x(i1) - 4);
      self._ovr = range(); self.refresh(true); };
    svg.onpointerup = svg.onpointercancel = function () { if (drag) { drag = null; commit(); } };
  };

  Desk.prototype._read = function () {
    var c = this.ctx, u = this._u(), M0 = c.M(u.metric), M = c.subs(u.metric)[0], v = c.vals(u.metric), i = this._ref(), x = v[i], r = rangeN(v, i, 5 * c.PER), E = this.el.read, PER = c.PER, self = this;
    M = Object.assign({}, M, { multi: M0.multi });
    var sm = [], k; for (k = 1; k <= 5; k++) if (v[i - PER * k] != null) sm.push(v[i - PER * k]);
    var avg = sm.length ? sm.reduce(function (a, b) { return a + b; }, 0) / sm.length : null, vsAvg = (x == null || avg == null) ? null : ((M.pp || M.diff) ? x - avg : (avg ? (x / avg - 1) * 100 : null));
    var part = !!c.P[i].partial, unitW = { monthly: 'month', quarterly: 'quarter', annual: 'year' }[c.st.gran], mo = part ? null : change(v, i, 1, M), yy = part ? c.vals(u.metric, 'yoy')[i] : change(v, i, PER, M);
    E.querySelector('.dk-when').textContent = c.label(i) + (part ? ' · in progress' : u.hover != null ? '' : u.pinA != null ? ' · pinned' : ' · latest');
    E.querySelector('.dk-big').innerHTML = fmt(x, M.dec) + '<small>' + esc(M.unit) + ' · ' + esc(this._lbl(M)) + '</small>';
    var kv = part ? '<span>' + c.P[i].months + ' month' + (c.P[i].months > 1 ? 's' : '') + ' so far, vs the same months last year</span><b class="' + cls(yy) + '">' + chgTxt(M, yy) + '</b>'
      : '<span>vs previous ' + unitW + '</span><b class="' + cls(mo) + '">' + chgTxt(M, mo) + '</b>';
    if (c.st.gran !== 'annual' && !part) kv += '<span>vs same ' + unitW + ' last year</span><b class="' + cls(yy) + '">' + chgTxt(M, yy) + '</b><span>vs 5-year average for ' + (PER === 12 ? MON[c.P[i].k] : 'Q' + (c.P[i].k + 1)) + '</span><b class="' + cls(vsAvg) + '">' + chgTxt(M, vsAvg) + '</b>';
    if (!part) kv += '<span>Rank in the last ' + (r ? r.n : 5 * PER) + ' ' + unitW + 's</span><b>' + (r ? '#' + r.rank : '—') + '</b>';
    if (M.flow && !M.multi && !part && c.st.gran !== 'annual') {   // acumulado do ano até o período lido, contra os mesmos meses do ano anterior
      var mmY = c.monthly(M.id).v, eY = c.P[i].b, mN = +c.ax[eY].slice(5, 7), yN = +c.ax[eY].slice(0, 4), aY = 0, bY = 0, okA = true, okB = true, qY;
      for (qY = 0; qY < mN; qY++) { if (mmY[eY - qY] == null) okA = false; else aY += mmY[eY - qY]; if (eY - qY - 12 < 0 || mmY[eY - qY - 12] == null) okB = false; else bY += mmY[eY - qY - 12]; }
      var span = mN > 1 ? 'Jan–' + MON[mN - 1] : 'Jan', dY = (okA && okB && bY) ? (aY / bY - 1) * 100 : null;
      if (okA) kv += '<span>' + yN + ' year to date (' + span + ')</span><b>' + fmt(aY, M.dec) + ' ' + esc(M.unit) + '</b><span>vs ' + span + ' ' + (yN - 1) + '</span><b class="' + cls(dY) + '">' + pct(dY) + '</b>';
    }
    c.sec.metrics.forEach(function (m2) { if (m2.id === u.metric || m2.id === M.id || m2.multi || !c.has(m2.id) || m2.hideInReading) return; var v2 = c.vals(m2.id); if (lastIdx(v2) < 0) return; kv += '<span>' + esc(self._lbl(m2)) + '</span><b>' + fmt(v2[i], m2.dec) + ' ' + esc(m2.unit) + '</b>'; });
    E.querySelector('.dk-kv').innerHTML = kv;
    var p = '';
    if (u.pinA != null) p += '<span class="dk-pin"><i></i>A ' + c.label(u.pinA) + '</span>';
    if (u.pinB != null) { var a = v[u.pinA], b = v[u.pinB], dd = (a == null || b == null) ? null : ((M.pp || M.diff) ? b - a : (a ? (b / a - 1) * 100 : null)); p += '<span class="dk-pin dk-b"><i></i>B ' + c.label(u.pinB) + '</span><span>A→B <b class="' + cls(dd) + '">' + chgTxt(M, dd) + '</b></span>'; }
    p += u.pinA != null ? '<button type="button" class="dk-lnk dk-clr">Clear</button>' : '<span>To compare two periods, click one on the main chart, then another.</span>';
    var pe = E.querySelector('.dk-pins'); pe.innerHTML = p; var cl = pe.querySelector('.dk-clr'); if (cl) cl.onclick = function () { u.pinA = u.pinB = null; self._paintMarks(); self._read(); self._rank(); };
    if (u.mode !== 'seasonal' && M.multi) { var si0 = this._stageInfo(), S0 = this.el.stage, md = u.mode;
      S0.querySelector('.dk-sv').innerHTML = fmt(si0.v[i], si0.dec) + '<small>' + esc(si0.unit) + ' · ' + c.label(i) + '</small>';
      S0.querySelector('.dk-sd').textContent = c.subs(u.metric).map(function (S2) { return self._short(S2) + ' ' + fmt(c.vals(S2.id, md)[i], md === 'yoy' ? 1 : S2.dec); }).join(' · ') + ' ' + si0.unit; }
    else if (u.mode !== 'seasonal') { var si = this._stageInfo(), S = this.el.stage;
      S.querySelector('.dk-sv').innerHTML = fmt(si.v[i], si.dec) + '<small>' + esc(si.unit) + ' · ' + c.label(i) + '</small>';
      /* o que cada linha/barra quer dizer mora no "How to read" (quadro de explicação): aqui só os números */
      S.querySelector('.dk-sd').textContent = u.mode === 'level' ? ((c.st.gran === 'monthly' ? 'YoY ' + chgTxt(M, yy) : { quarterly: 'QoQ ', annual: 'YoY ' }[c.st.gran] + chgTxt(M, mo)) + (this._refAvg != null ? ' · window avg ' + fmt(this._refAvg, M.dec) : ''))
        : ''; }
  };

  /* ── quem: dimensão, subproduto, seleção de entidades (todas as da base) ── */
  Desk.prototype._whoData = function () {
    var c = this.ctx, w = this._u().who, dims = (c.sec.who || []).filter(function (x) { return !x.available || x.available({ prod: c.st.prod }); });
    if (w.dim >= dims.length) w.dim = 0; var dim = dims[w.dim]; if (!dim) return null;
    var pills = dim.pills ? dim.pills({ prod: c.st.prod }) : null, top = pills ? (pills.filter(function (p) { return p.k === w.pill; })[0] || pills[0]) : null;
    var subs = top && top.sub ? top.sub : null, sub = subs ? (subs.filter(function (p) { return p.k === w.sub; })[0] || null) : null, pill = sub || top;   // pill = o recorte que vale
    var ck = this.cur + '|' + dim.id + '|' + c.st.prod + '|' + (pill ? pill.k : ''), base = (this._who_cache = this._who_cache || {})[ck];
    var z = function (m) { return align(m, c.ax).map(function (x) { return x == null ? 0 : x; }); };
    if (!base) { var raw = dim.entities({ prod: c.st.prod }, pill);   // {names, maps (medida 1), maps2 (medida 2, ex.: receita), total/total2 (quando a fonte publica o total)}
      base = this._who_cache[ck] = { names: raw.names, series: raw.maps.map(z), series2: raw.maps2 ? raw.maps2.map(z) : null, tot: raw.total ? z(raw.total) : null, tot2: raw.total2 ? z(raw.total2) : null }; }
    var gk = ck + '|' + c.st.gran, agg = (this._whoAgg = this._whoAgg || {})[gk], S = c.A.level.sum;
    var sumAll = function (arrs) { return c.P.map(function (_, i) { var t0 = 0; for (var k = 0; k < arrs.length; k++) t0 += arrs[k][i] || 0; return t0; }); };
    if (!agg || agg.n !== c.P.length) { var v0 = base.series.map(S), r0 = base.series2 ? base.series2.map(S) : null;
      agg = this._whoAgg[gk] = { n: c.P.length, v: v0, r: r0, tv: base.tot ? S(base.tot) : sumAll(v0), tr: r0 ? (base.tot2 ? S(base.tot2) : sumAll(r0)) : null }; }
    var modes = typeof dim.modes === 'function' ? dim.modes({ prod: c.st.prod }) : (dim.modes || [['volume', 'Volume (kt)'], ['share', 'Share (%)']]);
    if (!modes.some(function (m) { return m[0] === w.mode; })) w.mode = modes[0][0];
    var names = base.names, def, rs = (w.mode === 'revenue' && dim.rankByMode && base.series2) ? base.series2 : base.series;
    if (dim.defaultSel) def = dim.defaultSel(names);
    else { var sc = names.map(function (n, k) { var t = 0, ms = rs[k]; for (var i = c.m0; i <= c.m1; i++) t += ms[i] || 0; return [n, t]; }).filter(function (x) { return x[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }); def = sc.slice(0, dim.top || 5).map(function (x) { return x[0]; }); }
    var sel = w.sel || def.concat(dim.noOthers ? [] : ['Others']); this._whoLead = names[0];
    return { dim: dim, dims: dims, pills: pills, top: top, subs: subs, sub: sub, pill: pill, names: names, agg: agg.v, agg2: agg.r, tot: agg.tv, tot2: agg.tr,
      ser: base.series, ser2: base.series2, serTot: base.tot, serTot2: base.tot2, sel: sel, modes: modes };
  };
  Desk.prototype._slot = function (name, sel) {   // cor por ENTIDADE; dois marcados nunca dividem a cor enquanto houver cor livre
    if (name === 'Others') return 'others'; var S = this._slots, dim = this._whoDim || {};
    var lead = dim.lead || (dim.noLead ? null : this._whoLead);   // sem líder declarado, o laranja vai para a entidade mais relevante da quebra
    if (lead && name === lead) return 'lead';
    if (S[name] == null) S[name] = this._slotN++ % PAL_L.length;
    var used = {}, i; for (i = 0; i < sel.length; i++) { var o = sel[i]; if (o === name || o === 'Others' || (lead && o === lead) || S[o] == null) continue; used[S[o]] = 1; }
    if (used[S[name]]) { for (i = 0; i < PAL_L.length; i++) if (!used[i]) { S[name] = i; break; } }
    return S[name];
  };
  Desk.prototype._whoOpts = function (mode) {
    if (mode === 'price') return [['lines', 'Lines', 'One line per name', 0, 'lines'], ['col', 'Columns', 'Side-by-side columns']];
    return [['stack', 'Stacked', mode === 'share' ? 'The columns add up to 100%' : 'The columns add up to the total', 0, 'stack'], ['stackarea', 'Stacked area', mode === 'share' ? 'The areas add up to 100%' : 'The areas add up to the total', 0, 'stackarea'], ['lines', 'Lines', 'Each one on its own line — not added up', 0, 'lines']];
  };
  Desk.prototype._who = function () {
    var c = this.ctx, E = this.el, d = this._whoData(), w = this._u().who, self = this; if (!d) { E.who.hidden = true; return; } E.who.hidden = false; this._whoDim = d.dim;
    var dg = E.who.querySelector('.dk-dims'); dg.hidden = d.dims.length < 2;
    dg.innerHTML = d.dims.map(function (x, k) { return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === w.dim) + '">' + esc(x.tab || x.label) + '</button>'; }).join('');
    E.who.querySelector('.dk-pop').hidden = !!d.dim.noSelect;
    E.who.querySelector('.dk-pills').innerHTML = d.pills ? '<span class="dk-plbl">' + esc(d.dim.pillLabel || 'Product') + '</span>' + d.pills.map(function (p) { return '<button type="button" class="dk-pill" data-k="' + esc(p.k) + '" aria-pressed="' + (p.k === d.top.k) + '">' + esc(p.l) + (p.sub ? ' ▾' : '') + '</button>'; }).join('') : '';
    var sp = E.who.querySelector('.dk-subpills'); sp.hidden = !d.subs;
    sp.innerHTML = d.subs ? '<span class="dk-plbl">Within ' + esc(d.top.l) + '</span><button type="button" class="dk-pill" data-k="" aria-pressed="' + (!d.sub) + '">All ' + esc(d.top.l.toLowerCase()) + '</button>' +
      d.subs.map(function (p) { return '<button type="button" class="dk-pill" data-k="' + esc(p.k) + '" aria-pressed="' + (!!d.sub && p.k === d.sub.k) + '">' + esc(p.l) + '</button>'; }).join('') : '';
    E.who.querySelector('.dk-whomodes').innerHTML = d.modes.map(function (m) { return '<button type="button" data-k="' + m[0] + '" aria-pressed="' + (w.mode === m[0]) + '">' + m[1] + '</button>'; }).join('');
    E.who.querySelector('.dk-whomodes').hidden = d.modes.length < 2;
    var wopts = this._whoOpts(w.mode), wsty = this._sty('who', wopts), wsw = E.who.querySelector('.dk-whosty'); if (wsw) wsw.innerHTML = styleSeg(wopts, wsty);
    E.who.querySelector('.dk-popbtn').innerHTML = esc(d.dim.label) + ' ▾';
    E.who.querySelector('h3').textContent = d.dim.heading || 'Who is behind the number';
    var HW = window.IBBADeskHelp, wwhat = (HW && HW.who) ? HW.who(this.cfg.sector, this.cur, d.dim.id) : null, WH = (HW && HW.whoHow) || {}, sh0 = w.mode === 'share';
    var lead0 = wsty === 'stackarea' ? (sh0 ? WH.areaShare : WH.area) : (wsty === 'lines' && w.mode !== 'price') ? (sh0 ? WH.linesShare : WH.lines) : (w.mode === 'price' && wsty === 'col') ? WH.priceCol : null, wparts = [lead0 || WH[w.mode] || WH.volume];
    if (!d.dim.noOthers) wparts.push(w.mode === 'price' ? WH.othersPrice : w.mode === 'share' ? '' : WH.others);   // a quebra tem "Others"?
    wparts.push(WH.list); if (!d.dim.noSelect) wparts.push(WH.click);   // dá para escolher quem aparece?
    var whow = HW ? HW.fill(wparts.filter(Boolean).join(' '), { noun1: HW.noun1(d.dim.noun) }) : '', wwEl = E.who.querySelector('.dk-whowhy');
    if (wwEl) { wwEl.innerHTML = whyHTML(wwhat, whow); wwEl.hidden = !wwEl.innerHTML; }
    var sl = function (a) { return a.slice(c.i0, c.i1 + 1); }, labels = c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.label; }), t = theme(), mode = w.mode, share = mode === 'share', pa = c.partialAt();
    var idx = function (n) { return d.names.indexOf(n); }, selNamed = d.names.filter(function (n) { return d.sel.indexOf(n) >= 0; }), hasO = d.sel.indexOf('Others') >= 0;
    var rest = function (T, A) { return c.P.map(function (_, i) { var s0 = T[i] || 0; selNamed.forEach(function (n) { s0 -= A[idx(n)][i] || 0; }); return Math.max(0, s0); }); };
    var dec = d.dim.dec || 0, cv = E.who.querySelector('canvas');
    if (mode === 'price') {   // preço de cada entidade = medida 2 ÷ medida 1 (ex.: receita ÷ volume) + a linha de todos + o resto
      var K = d.dim.priceK || 1, mx = d.dim.priceMax || Infinity, pr = function (R, V) { return c.P.map(function (_, i) { var x = (V[i] > 0 && R[i] != null) ? R[i] / V[i] * K : null; return (x != null && x <= mx) ? x : null; }); };
      var sets = [lineSet(sl(pr(d.tot2, d.tot)), 'rgba(' + t.band + ',.85)', { label: d.dim.allLabel || 'All', w: 2, dash: [6, 4], surf: t.surf, partialAt: pa, noDot: wsty === 'col' })];
      if (wsty === 'col') {   // colunas lado a lado (o preço de cada um) + a linha de todos
        selNamed.forEach(function (n) { sets.push(barSet(sl(pr(d.agg2[idx(n)], d.agg[idx(n)])), slotColor(self._slot(n, d.sel)), { label: n, partialAt: pa })); });
        if (hasO && !d.dim.noOthers) sets.push(barSet(sl(pr(rest(d.tot2, d.agg2), rest(d.tot, d.agg))), slotColor('others'), { label: 'Others', partialAt: pa }));
        this._chart('who', cv, 'bar', labels, sets, { bar: true, dec: d.dim.priceDec || 0, tip: true, unitTip: d.dim.priceUnit || '' });
      } else {
        selNamed.forEach(function (n) { sets.push(lineSet(sl(pr(d.agg2[idx(n)], d.agg[idx(n)])), slotColor(self._slot(n, d.sel)), { label: n, w: 2, surf: t.surf, partialAt: pa })); });
        if (hasO && !d.dim.noOthers) sets.push(lineSet(sl(pr(rest(d.tot2, d.agg2), rest(d.tot, d.agg))), slotColor('others'), { label: 'Others', w: 1.5, dash: [4, 3], surf: t.surf, partialAt: pa }));
        this._chart('who', cv, 'line', labels, sets, { dec: d.dim.priceDec || 0, tip: true, unitTip: d.dim.priceUnit || '' });
      }
    } else {
      var A = mode === 'revenue' ? d.agg2 : d.agg, T = mode === 'revenue' ? d.tot2 : d.tot, stack = selNamed.map(function (n) { return { name: n, v: A[idx(n)] }; });
      if (hasO && !d.dim.noOthers) stack.push({ name: 'Others', v: rest(T, A) });
      var valsOf = function (s0) { return sl(s0.v).map(function (x, k) { var TT = T[c.i0 + k]; return share ? (TT ? +(x / TT * 100).toFixed(2) : 0) : +(+x || 0).toFixed(dec + 2); }); }, dc = mode === 'revenue' ? (d.dim.dec2 || 0) : dec;
      if (wsty === 'stackarea') {   // áreas empilhadas: a borda de cima é o total (ou 100%)
        var asets = stack.map(function (s0, k) { var col = slotColor(self._slot(s0.name, d.sel)), dim = !!(w.hi && w.hi !== s0.name), a0 = lineSet(valsOf(s0), dim ? hexA(col, .35) : col, { label: s0.name, w: 1.2, surf: t.surf, partialAt: pa });
          a0.fill = k ? '-1' : 'origin'; a0.backgroundColor = hexA(col, dim ? .14 : .78); return a0; });
        this._chart('who', cv, 'line', labels, asets, { stack: true, share: share, dec: dc, tip: true });
      } else if (wsty === 'lines') {   // cada um na sua linha, sem somar
        var lsets = stack.map(function (s0) { var col = slotColor(self._slot(s0.name, d.sel)), dim = !!(w.hi && w.hi !== s0.name), oth = s0.name === 'Others';
          return lineSet(valsOf(s0), dim ? hexA(col, .25) : col, { label: s0.name, w: oth ? 1.5 : 2, dash: oth ? [4, 3] : null, end: true, surf: t.surf, partialAt: pa }); });
        this._chart('who', cv, 'line', labels, lsets, { dec: share ? 1 : dc, tip: true, unitTip: share ? '%' : '' });
      } else {
        var bsets = stack.map(function (s0) { var col = slotColor(self._slot(s0.name, d.sel));
          return barSet(valsOf(s0), (w.hi && w.hi !== s0.name) ? hexA(col, .16) : col, { label: s0.name, stacked: true, gap: true, surf: t.surf, partialAt: pa }); });
        this._chart('who', cv, 'bar', labels, bsets, { bar: true, stack: true, share: share, dec: dc, tip: true });
      }
    }
    this._whoTitle = d.dim.title || 'Breakdown';
    if (!E.who.querySelector('.dk-popp').hidden) this._fillPop();
  };
  function hexA(hex, a) { var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); return m ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')' : hex; }
  Desk.prototype._fillPop = function () {
    var d = this._whoData(), pp = this.el.who.querySelector('.dk-popp'), self = this, w = this._u().who; if (!d) return;
    if (!pp.querySelector('.dk-plist') || pp.dataset.key !== (d.pill ? d.pill.k : '') + '|' + d.names.length) {
      pp.dataset.key = (d.pill ? d.pill.k : '') + '|' + d.names.length;
      pp.innerHTML = '<div class="dk-ph"><span>' + d.names.length + ' ' + esc((d.dim.noun || 'items')) + ' in the database</span><button type="button" class="dk-lnk dk-reset">Reset</button></div>' +
        '<input type="search" placeholder="Search…" aria-label="Search"><div class="dk-plist"></div><div class="dk-pf">Unticked ' + esc(d.dim.noun || 'items') + ' are counted in "Others".</div>';
      pp.querySelector('input[type=search]').oninput = function () { self._fillPop(); };
      pp.querySelector('.dk-reset').onclick = function () { w.sel = null; self._who(); self._rank(); };
      pp.querySelector('.dk-plist').onchange = function (e) { var n = e.target.getAttribute('data-n'); if (n == null) return; var s = self._whoData().sel.slice(); if (e.target.checked) s.push(n); else s = s.filter(function (x) { return x !== n; }); w.sel = s.length ? s : null; self._who(); self._rank(); };
    }
    var q = (pp.querySelector('input[type=search]').value || '').toLowerCase(), hit = d.names.filter(function (n) { return !q || n.toLowerCase().indexOf(q) >= 0; });
    var list = hit.filter(function (n) { return d.sel.indexOf(n) >= 0; }).concat(hit.filter(function (n) { return d.sel.indexOf(n) < 0; })); if (!q) list.push('Others');
    pp.querySelector('.dk-plist').innerHTML = list.map(function (n) { return '<label><input type="checkbox" data-n="' + esc(n) + '"' + (d.sel.indexOf(n) >= 0 ? ' checked' : '') + '>' + esc(n) + '</label>'; }).join('') || '<p class="dk-note">No match.</p>';
  };
  Desk.prototype._rank = function () {
    var c = this.ctx, d = this._whoData(), E = this.el, w = this._u().who, self = this; if (!d) return;
    var i = this._ref(), PER = c.PER, pp = c.P[i], mode = w.mode, price = mode === 'price', rev = mode === 'revenue';
    var A = rev ? d.agg2 : d.agg, SR = rev ? d.ser2 : d.ser, T = rev ? d.tot2 : d.tot, ST = rev ? d.serTot2 : d.serTot;
    var unit = price ? (d.dim.priceUnit || '') : rev ? (d.dim.unit2 || 'US$ mn') : (d.dim.unit || 'kt'), dec = price ? (d.dim.priceDec || 0) : rev ? (d.dim.dec2 || 0) : (d.dim.dec || 0), K = d.dim.priceK || 1;
    var lfl = function (ser, k) { var s0 = 0; for (var m = pp.a - 12; m <= pp.b - 12; m++) if (m >= 0) s0 += ser[k][m] || 0; return s0; };   // parcial: mesmos meses do ano anterior
    var prevOf = function (arr, ser, k) { return pp.partial ? lfl(ser, k) : (arr[k][i - PER] || 0); };
    var totNow = T[i] || 0, totPrev = pp.partial ? (ST ? (function () { var s0 = 0; for (var m = pp.a - 12; m <= pp.b - 12; m++) if (m >= 0) s0 += ST[m] || 0; return s0; })() : d.names.reduce(function (a, _, k) { return a + lfl(SR, k); }, 0)) : (T[i - PER] || 0);
    E.who.querySelector('.dk-when').textContent = c.label(i);
    var all = d.names.map(function (n, k) { var v = A[k][i] || 0, p0 = prevOf(A, SR, k), o = { n: n, v: v, p: p0, k: k };
      if (price) { var V = d.agg[k][i] || 0, R = d.agg2[k][i] || 0, Vp = prevOf(d.agg, d.ser, k), Rp = prevOf(d.agg2, d.ser2, k); o.sortV = V; o.v = V > 0 ? R / V * K : null; o.p = Vp > 0 ? Rp / Vp * K : null; }
      return o; });
    var by = function (a, b) { return (price ? b.sortV - a.sortV : b.v - a.v); };
    var rest = all.filter(function (r) { return d.sel.indexOf(r.n) < 0; }).sort(by), nSel = d.sel.filter(function (n) { return n !== 'Others'; }).length;
    var rows = all.filter(function (r) { return d.sel.indexOf(r.n) >= 0; }).concat(rest.slice(0, Math.max(0, 10 - nSel))).sort(by);
    if (!d.dim.noOthers && !price) { var selV = 0, selP = 0; all.forEach(function (r) { if (d.sel.indexOf(r.n) >= 0) { selV += r.v; selP += r.p; } });
      rows.push({ n: 'Others', lab: 'Others (' + rest.length + ' ' + (d.dim.noun || 'items') + ')', v: Math.max(0, totNow - selV), p: Math.max(0, totPrev - selP) }); }
    E.who.querySelector('.dk-rank').innerHTML = rows.map(function (r) { var yy = (r.p && r.v != null) ? (r.v / r.p - 1) * 100 : null, on = d.sel.indexOf(r.n) >= 0;
      return '<button type="button" class="dk-rk' + (w.hi === r.n ? ' dk-on' : '') + (on ? '' : ' dk-out') + '" data-n="' + esc(r.n) + '" title="Click to show or hide"><i style="background:' + (on ? slotColor(self._slot(r.n, d.sel)) : 'transparent') + '"></i><span class="dk-nm">' + esc(r.lab || r.n) + '</span><span class="dk-shr">' + fmt(r.v, dec) + ' ' + esc(unit) + (price ? '' : ' · ' + (totNow ? fmt(r.v / totNow * 100, 0) : '—') + '%') + '</span><span class="dk-yy ' + cls(yy) + '">' + (yy != null && yy > 999 ? '>999%' : pct(yy, 0)) + '</span></button>'; }).join('') +
      (d.dim.noSelect ? '' : '<button type="button" class="dk-lnk dk-more">+ Add any of the ' + d.names.length + ' ' + esc(d.dim.noun || 'items') + '</button>');
    var R0 = E.who.querySelector('.dk-rank'), mark = function () { R0.querySelectorAll('.dk-rk').forEach(function (b) { b.classList.toggle('dk-on', b.getAttribute('data-n') === w.hi); }); };
    R0.querySelectorAll('.dk-rk').forEach(function (b) { var n = b.getAttribute('data-n');
      b.onmouseenter = function () { if (d.sel.indexOf(n) >= 0 && w.hi !== n && !price) { w.hi = n; self._who(); self._paintMarks(); mark(); } };
      b.onclick = function () { var s0 = d.sel.slice(); s0 = s0.indexOf(n) >= 0 ? s0.filter(function (x) { return x !== n; }) : s0.concat([n]); w.sel = s0.length ? s0 : null; w.hi = null; self._who(); self._paintMarks(); self._rank(); }; });
    R0.onmouseleave = function () { if (w.hi) { w.hi = null; self._who(); self._paintMarks(); mark(); } };
    var mb = R0.querySelector('.dk-more'); if (mb) mb.onclick = function (e) { e.stopPropagation(); self._openPop(true); };
  };

  Desk.prototype._minis = function () {
    var c = this.ctx, u = this._u(), E = this.el, self = this, t = theme(false);
    var gl = []; c.sec.metrics.forEach(function (M) { var G = M.group || ''; if (gl.indexOf(G) < 0) gl.push(G); });
    var top = this._tileIds();   // o que já tem quadro (botão) no topo não se repete aqui
    var ids = c.sec.metrics.filter(function (M) { return M.id !== u.metric && top.indexOf(M.id) < 0 && !M.noMini && c.has(M.id) && lastIdx(c.vals(M.id)) >= 0; })
      .sort(function (a, b) { return gl.indexOf(a.group || '') - gl.indexOf(b.group || ''); }).map(function (M) { return M.id; });
    var sig = ids.join(',');
    E.minis.hidden = !ids.length;
    if (E.minis.dataset.sig !== sig) { this._dropCharts('mini:'); E.minis.dataset.sig = sig;
      var lastG = null;
      E.minis.innerHTML = '<div class="dk-gh dk-gtop"><span>' + (top.length ? 'More indicators' : 'More in this section') + '</span><em>' + (top.length ? 'Not in the cards above · click one to show it on the main chart' : 'Click a chart to show it on the main chart') + '</em></div>' + ids.map(function (id) { var G = c.M(id).group || '', hd = (G && G !== lastG) ? '<div class="dk-gh"><span>' + esc(G) + '</span></div>' : ''; lastG = G || lastG;
        return hd + '<div class="dk-mini dk-card chart-card" data-k="' + id + '" role="button" tabindex="0"><div class="dk-mh"><span class="chart-title"></span><span class="dk-mv"></span></div><p class="dk-mwhy"></p><div class="dk-chart"><canvas id="dk-mini-' + id + '"></canvas></div><div class="dk-ta"><i></i><span>Show on chart</span></div></div>'; }).join('');
      ids.forEach(function (id) { self._bindHover(E.minis.querySelector('#dk-mini-' + id), 'mini:' + id); });
    }
    var labels = c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.label; });
    ids.forEach(function (id) { var M = c.M(id), box = E.minis.querySelector('[data-k="' + id + '"]'); box.querySelector('.chart-title').textContent = self._lbl(M);
      var hpm = self._help(self.cur, M.id, { prod: c.st.prod, label: self._lbl(M), gran: c.st.gran }), wm = (hpm && hpm.what) || (typeof M.note === 'function' ? M.note({ prod: c.st.prod }) : M.note) || '', s1 = /^.*?[.!?](\s|$)/.exec(wm), mw = box.querySelector('.dk-mwhy');
      if (mw) { mw.textContent = s1 ? s1[0].trim() : wm; mw.hidden = !wm; }
      var sb = c.subs(id), dsm = sb.map(function (S2, k) { return lineSet(c.vals(S2.id).slice(c.i0, c.i1 + 1), sb.length > 1 && k === 0 ? ORANGE : t.ink, { label: self._lbl(S2), w: 1.5, partialAt: c.partialAt() }); });
      self._chart('mini:' + id, box.querySelector('canvas'), 'line', labels, dsm, { mini: true, dec: sb[0].dec }); });
    this._miniIds = ids; this._miniHeads();
  };
  Desk.prototype._miniHeads = function () { var c = this.ctx, i = this._ref(), E = this.el; (this._miniIds || []).forEach(function (id) { var M = c.subs(id)[0], e = E.minis.querySelector('[data-k="' + id + '"] .dk-mv'); if (e) e.textContent = fmt(c.vals(id)[i], M.dec) + ' ' + M.unit; }); };

  Desk.prototype.select = function (secId, metricId, prod) {   // deixa um indicador (e o produto da seção, se ela tiver o seu) pronto para quando a seção abrir
    var keep = this.cur; this.cur = secId; var u = this._u(); this.cur = keep; u.metric = metricId; u.mode = 'level'; u.hover = u.pinA = u.pinB = null;
    if (this.sections[secId].prods && prod) u.prod = prod;
  };
  Desk.prototype._overview = function () {
    var self = this, sec = this.sections[this.cur], r = this.root, rows = '', lastG = null, seenKey = 'ibba_desk_seen_' + (this.cfg.sector || 'x'), seen = {}, now = {};
    this._destroyAll(); this._built = null;
    try { seen = JSON.parse(localStorage.getItem(seenKey) || '{}') || {}; } catch (e) {}
    sec.overview.forEach(function (it, ix) {
      var S = self.sections[it.sec], M = null; S.metrics.forEach(function (m) { if (m.id === it.metric) M = m; }); if (!M) return;
      var prod = it.prod || (S.prods ? S.prods[0].k : 'total'), all;
      try { all = self.debugSeries(it.sec, it.metric, { prod: prod, gran: 'monthly', win: 'all', from: null, to: null }, 'level').__all; } catch (e) { return; }
      var keys = Object.keys(all).sort(), v = keys.map(function (k) { return all[k]; }), i = lastIdx(v); if (i < 0) return;
      var mo = change(v, i, 1, M), yy = change(v, i, 12, M), rg = rangeN(v, i, 60), mN = +keys[i].slice(5, 7), a = 0, b = 0, ok = true, k;
      for (k = 0; k < mN; k++) { var x = v[i - k], y = v[i - k - 12]; if (x == null || y == null) { ok = false; break; } a += x; b += y; }
      var ytd = !ok ? null : (M.pp || M.diff) ? (a - b) / mN : (M.flow ? (b ? (a / b - 1) * 100 : null) : (b ? (a / b - 1) * 100 : null));
      var label = it.label || (typeof M.label === 'function' ? M.label({ prod: prod }) : M.label), id = it.sec + '.' + it.metric + '.' + prod; now[id] = keys[i];
      var isNew = seen[id] && seen[id] < keys[i], G = S.label;
      if (G !== lastG) { rows += '<tr class="dk-og"><td colspan="9">' + esc(G) + '</td></tr>'; lastG = G; }
      var pl = P1(keys[i]);
      rows += '<tr tabindex="0" data-ix="' + ix + '"><td><b>' + esc(label) + '</b><span class="dk-src">' + esc(it.src || S.src || '') + '</span>' + (it.isNew ? '<span class="dk-new">NEW SECTION</span>' : '') + (isNew ? '<span class="dk-new">NEW DATA</span>' : '') + '</td><td>' + pl + '</td><td><b>' + fmt(v[i], M.dec) + '</b> <span class="dk-src">' + esc(M.unit) + '</span></td>' +
        '<td class="' + cls(mo) + '">' + chgTxt(M, mo) + '</td><td class="' + cls(yy) + '">' + chgTxt(M, yy) + '</td><td class="' + cls(ytd) + '">' + chgTxt(M, ytd) + '</td>' +
        '<td class="dk-osp">' + sparkSVG(v.slice(Math.max(0, i - 23), i + 1), 92, 22) + '</td><td><div class="dk-rng"><i style="left:' + (rg ? (rg.pos * 100).toFixed(0) : 50) + '%"></i></div></td><td class="dk-go" aria-hidden="true">Open ›</td></tr>';
    });
    function P1(k) { return MON[+k.slice(5, 7) - 1] + '-' + k.slice(2, 4); }
    r.innerHTML = '<div class="dk-body"><div class="dk-card dk-ovw"><div class="dk-tblw"><table class="dk-ov"><thead><tr><th>Indicator</th><th>Period</th><th>Last</th><th>MoM</th><th>YoY</th><th>YTD YoY</th><th>24 months</th><th>5-year range</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<p class="dk-note">Monthly figures, latest month available in each source. Click a row to open that indicator in its section.</p></div>';
    var open = function (tr) { var it = sec.overview[+tr.getAttribute('data-ix')]; if (it && self.cfg.goto) self.cfg.goto(it); };
    var tb = r.querySelector('tbody');
    tb.addEventListener('click', function (e) { var tr = e.target.closest('tr[data-ix]'); if (tr) open(tr); });
    tb.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var tr = e.target.closest('tr[data-ix]'); if (tr) open(tr); } });
    try { localStorage.setItem(seenKey, JSON.stringify(now)); } catch (e) {}
  };

  /* matriz com o histórico INTEIRO (na granularidade escolhida) para o XLS de um gráfico da mesa */
  Desk.prototype.fullAOA = function (id) {
    var c = this.ctx, u = this._u(), self = this; if (!c) return null;
    var cols = [], head = ['Period'];
    if (id === 'stage') { var md = u.mode === 'seasonal' ? 'level' : u.mode, un = u.mode === 'yoy' ? this._stageInfo().unit : null;
      c.subs(u.metric).forEach(function (S2) { cols.push(c.vals(S2.id, md)); head.push(self._lbl(S2) + (md === 'level' ? '' : ' — ' + md.toUpperCase()) + ' (' + (un || S2.unit) + ')'); }); }
    else if (id === 'who') { var d = this._whoData(); if (!d) return null; var Ax = (this._u().who.mode === 'revenue' && d.agg2) ? d.agg2 : d.agg; d.names.forEach(function (n, k) { cols.push(Ax[k]); head.push(n); }); }
    else if (id.indexOf('mini:') === 0) { c.subs(id.slice(5)).forEach(function (M2) { cols.push(c.vals(M2.id)); head.push(self._lbl(M2) + ' (' + M2.unit + ')'); }); }
    else return null;
    var out = [head], i, first = -1; for (i = 0; i < c.P.length && first < 0; i++) if (cols.some(function (v) { return v[i] != null && v[i] !== 0; })) first = i;
    for (i = Math.max(0, first); i < c.P.length; i++) out.push([c.P[i].label].concat(cols.map(function (v) { return v[i]; })));
    return out;
  };
  Desk.prototype.titleOf = function (id) { var c = this.ctx; if (!c) return id; if (id === 'stage') return this.el.stage.querySelector('.dk-st').textContent; if (id === 'who') return (this._whoTitle || 'Breakdown'); if (id.indexOf('mini:') === 0) return this._lbl(c.M(id.slice(5))); return id; };

  /* só para os testes: os números de um indicador no estado pedido, por chave de período */
  Desk.prototype.debugSeries = function (secId, metricId, st, mode) {
    var keepCur = this.cur, keepState = this.cfg.state, self = this, out = {};
    this.cur = secId; this.cfg.state = function () { return st; }; this._dbg = true;
    try { var c = this._ctx(), v = c.vals(metricId, mode || 'level'); for (var i = c.i0; i <= c.i1; i++) out[c.P[i].key] = v[i]; out.__all = {}; c.P.forEach(function (p, i2) { out.__all[p.key] = v[i2]; }); }
    finally { this.cur = keepCur; this.cfg.state = keepState; this._dbg = false; }
    return out;
  };

  /* só para os testes: as entidades do bloco "quem" (todas, por período) e a seleção padrão da janela */
  Desk.prototype.debugWho = function (secId, st, dimIdx, pillKey, full) {
    var keepCur = this.cur, keepState = this.cfg.state, keepCtx = this.ctx, out;
    this.cur = secId; this.cfg.state = function () { return st; }; this._dbg = true;
    try { var u = this._u(), kw = u.who; u.who = { dim: dimIdx || 0, pill: pillKey || null, sel: null, mode: (st && st.whoMode) || 'volume', hi: null };
      var c = this.ctx = this._ctx(), d = this._whoData(); out = { names: d.names.length, sel: d.sel, keys: c.P.slice(c.i0, c.i1 + 1).map(function (p) { return p.key; }) };
      if (full) { var pack = function (arrs) { var o = {}; d.names.forEach(function (n, k) { var m = {}; c.P.forEach(function (p, i) { if (arrs[k][i]) m[p.key] = arrs[k][i]; }); o[n] = m; }); return o; };
        var one = function (a) { var m = {}; c.P.forEach(function (p, i) { m[p.key] = a[i]; }); return m; };
        out.all = pack(d.agg); out.tot = one(d.tot); if (d.agg2) { out.all2 = pack(d.agg2); out.tot2 = one(d.tot2); } }
      u.who = kw; }
    finally { this.cur = keepCur; this.cfg.state = keepState; this.ctx = keepCtx; this._dbg = false; }
    return out;
  };

  /* Builder: a série INTEIRA de um indicador (ref.metric) ou de uma entidade de uma quebra (ref.dim + ref.name) de uma seção,
     num produto e numa granularidade — pelo MESMO caminho do palco: mesmo eixo da seção, mesmas regras de soma/razão/último
     e de período em andamento. Devolve vetores por período (level, yoy, ltm) e quais períodos são parciais. */
  Desk.prototype.seriesAll = function (secId, ref, prod, gran) {
    var sec = this.sections[secId]; if (!sec || sec.overview || sec.builder || sec.hf) return null;
    var keep = { cur: this.cur, state: this.cfg.state, ovr: this._ovr, dbg: this._dbg, ctx: this.ctx }, out = null;
    this.cur = secId; this._ovr = null; this._dbg = true; this.cfg.state = function () { return { prod: prod, gran: gran, win: 'all', from: null, to: null }; };
    try {
      var c = this._ctx(), P = c.P, PER = c.PER, X0 = { prod: prod };
      var o = { keys: P.map(function (p) { return p.key; }), labels: P.map(function (p) { return p.label; }), partial: P.map(function (p) { return !!p.partial; }),
        starts: P.map(function (p) { return c.ax[p.a]; }), ends: P.map(function (p) { return c.ax[p.b]; }) };
      if (ref.metric) {
        var M = c.M(ref.metric); if (M && !M.multi && c.has(M.id)) {
          o.level = c.vals(M.id); o.yoy = c.vals(M.id, 'yoy'); o.ltm = gran === 'annual' ? null : c.vals(M.id, 'ltm');
          o.label = typeof M.label === 'function' ? M.label(X0) : M.label; o.unit = M.unit; o.dec = M.dec || 0; o.pp = !!M.pp; o.diff = !!M.diff; o.flow = !!M.flow; out = o; }
      } else {
        var dim = null; (sec.who || []).forEach(function (d0) { if (d0.id === ref.dim) dim = d0; });
        if (dim && (!dim.available || dim.available(X0))) { var raw = dim.entities(X0, null), k = raw.names.indexOf(ref.name);
          if (k >= 0) { var arr = align(raw.maps[k], c.ax).map(function (x) { return x == null ? 0 : x; }), lv = c.A.level.sum(arr);
            o.level = lv; o.ltm = gran === 'annual' ? null : c.A.ltm.sum(arr);
            o.yoy = lv.map(function (_, i) { if (!P[i].partial) return change(lv, i, PER); var a = P[i].a - 12, s0 = 0, m; if (a < 0) return null; for (m = a; m <= P[i].b - 12; m++) s0 += arr[m]; return s0 ? (lv[i] / s0 - 1) * 100 : null; });
            o.label = ref.name; o.unit = dim.unit || 'kt'; o.dec = dim.dec || 0; o.pp = false; o.diff = false; o.flow = true; out = o; } }
      }
    } finally { this.cur = keep.cur; this.cfg.state = keep.state; this._ovr = keep.ovr; this._dbg = keep.dbg; this.ctx = keep.ctx; }
    return out;
  };

  window.IBBADesk = {
    /* peças internas para o data-desk-builder.js (mesma régua de gráfico, mesmas contas) */
    x: { Desk: Desk, chartOptions: chartOptions, lineSet: lineSet, h: h, esc: esc, fmt: fmt, pct: pct, cls: cls, isDark: isDark, ORANGE: ORANGE, FONT: FONT, whyHTML: whyHTML,
         yearColor: yearColor, yearStyle: yearStyle, yearChip: yearChip, r2of: r2of, r2Badge: r2Badge, R2_MIN: R2_MIN, corrCells: corrCells, corrTable: corrTable,
         barSet: barSet, hexA: hexA, UP: UP, DOWN: DOWN, theme: theme, icon: icon, styleSeg: styleSeg, slotColor: slotColor, lastIdx: lastIdx },
    core: core, theme: theme, slotColor: slotColor,
    mount: function (cfg) { var d = new Desk(cfg); window.IBBADesk.instance = d; return d; }
  };
})();
