/* ============================================================================
 * weekly-lib.js — o MONTADOR do "Weekly Recap S&M/P&P" (window.IBBAWeekly)
 *
 * Só monta e formata. Não busca nada no Supabase, não toca no DOM: recebe um
 * objeto `model` e devolve string (HTML do e-mail / texto do .eml). É por isso
 * que dá para testar tudo no harness do navegador sem login e sem dado ao vivo.
 *
 * A ESTÉTICA é a do "Long Story Short" do time de Financials (e-mail que o
 * analista mandou como referência em 31/08/2026). Os números abaixo NÃO são
 * chute: saíram do HTML daquele e-mail, medidos um a um —
 *   fundo da página #F7F5F0 · cartão branco com borda #E8E6DF e raio 12px ·
 *   título Georgia 17,5pt · olho-de-seção Arial 7,5pt com letter-spacing 1,35pt ·
 *   laranja #D94400 · verde #0F8C57 · vermelho #CF463A · régua preta de 1,5pt.
 * Mexer aqui = mexer na cara do e-mail. Ver o objeto T.
 *
 * ⚠️ E-MAIL NÃO É PÁGINA. O Outlook desenha com o motor do Word: nada de
 * flex/grid, de `class`, de variável CSS ou de unidade rem. Tudo é TABELA com
 * estilo inline em pt. Barras de gráfico = <td> com `background`. Foi assim que
 * o Long Story Short fez, e é assim que sobrevive.
 * ==========================================================================*/
(function (root) {
'use strict';

// ── TOKENS (medidos no e-mail do Long Story Short) ───────────────────────────
var T = {
  bg:      '#F7F5F0',   // fundo da página
  card:    '#FFFFFF',   // fundo do cartão
  ink:     '#16191D',   // tinta forte (títulos, régua)
  body:    '#22262B',   // tinta de texto corrido
  soft:    '#5E6671',   // números secundários da tabela
  mute:    '#8B929B',   // olho de seção, legendas
  faint:   '#A9AEB6',   // ticker ao lado do nome
  accent:  '#D94400',   // laranja Itaú BBA
  green:   '#0F8C57',
  red:     '#CF463A',
  line:    '#F0EEE8',   // divisória interna de tabela
  border:  '#E8E6DF',   // borda do cartão
  axis:    '#D8D5CC',   // eixo do gráfico de barras
  serif:   "'Georgia',serif",
  sans:    "'Arial',sans-serif",
  W:       640,         // largura do miolo (= os 480pt do LSS)
  PAD:     '19.5pt'     // respiro lateral do miolo
};

var BAR_HALF = 133;     // metade do gráfico de barras, em px
var BAR_MAX  = 126;     // barra mais longa (deixa folga antes do %)

// ── formatação (o e-mail é em português → pt-BR em TUDO) ─────────────────────
// O e-mail montado à mão misturava "98,60" com "R$ 7.23" porque cada tabela vinha
// de um lugar diferente. Aqui é uma régua só.
var MES = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
var MESLONGO = ['janeiro','fevereiro','março','abril','maio','junho','julho',
                'agosto','setembro','outubro','novembro','dezembro'];
var DIA = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];

function num(v, casas) {
  if (v == null || !isFinite(v)) return '—';
  var c = casas == null ? 2 : casas;
  return Number(v).toLocaleString('pt-BR', {minimumFractionDigits: c, maximumFractionDigits: c});
}
function pct(v, casas) {
  if (v == null || !isFinite(v)) return '—';
  var c = casas == null ? 2 : casas;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), c) + '%';
}
function _2(n) { return (n < 10 ? '0' : '') + n; }
function dmes(d) { return d ? d.getDate() + '/' + MES[d.getMonth()] : '—'; }   // 28/ago
function dbarra(d) { return d ? _2(d.getDate()) + '/' + _2(d.getMonth() + 1) + '/' + d.getFullYear() : '—'; }
function diaSemana(d) { return d ? DIA[d.getDay()] + ', ' + dmes(d) : ''; }

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Negrito de rascunho: **palavra** vira <b>palavra</b>. Mesma convenção da intro
// do clipping (clipping/build.py), para o analista não aprender duas sintaxes.
function _rich(s) {
  return _esc(s).replace(/\*\*([\s\S]+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}
function corDe(v) { return v > 0 ? T.green : v < 0 ? T.red : T.soft; }

// ── janela da semana ─────────────────────────────────────────────────────────
// O recap fecha na SEXTA. `fim` = a sexta da semana de referência; `ini` = a sexta
// anterior (é o par de fechamentos que a tabela compara). As notícias vão de
// segunda a sexta — por isso `seg` sai de `fim` menos 4 dias, e não de `ini`.
function semanaDe(ref) {
  var d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  var recuo = (d.getDay() - 5 + 7) % 7;                 // recua até a sexta mais recente
  var fim = new Date(d.getFullYear(), d.getMonth(), d.getDate() - recuo);
  var ini = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate() - 7);
  var seg = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate() - 4);
  return {ini: ini, fim: fim, seg: seg};
}
// Rótulo do período: "24 a 28 de agosto de 2026" (mês por extenso).
function periodoLongo(seg, sex) {
  if (seg.getMonth() === sex.getMonth())
    return seg.getDate() + ' a ' + sex.getDate() + ' de ' + MESLONGO[sex.getMonth()] + ' de ' + sex.getFullYear();
  return seg.getDate() + ' de ' + MESLONGO[seg.getMonth()] + ' a ' +
         sex.getDate() + ' de ' + MESLONGO[sex.getMonth()] + ' de ' + sex.getFullYear();
}
// Os 5 dias úteis da semana, na ordem — é o esqueleto do bloco de notícias.
function diasUteis(sem) {
  var out = [];
  for (var i = 0; i < 5; i++) {
    var d = new Date(sem.seg.getFullYear(), sem.seg.getMonth(), sem.seg.getDate() + i);
    out.push({data: d, rotulo: diaSemana(d), itens: []});
  }
  return out;
}

// ISO 'AAAA-MM-DD' <-> Date LOCAL. ⚠️ `new Date('2026-08-24')` é interpretado como
// UTC e, no fuso do Brasil, volta como 23/08 às 21h — o relatório de segunda cairia
// no domingo. Por isso a data é montada campo a campo.
function ymd(d) { return d.getFullYear() + '-' + _2(d.getMonth() + 1) + '-' + _2(d.getDate()); }
function deIso(s) {
  var p = String(s || '').slice(0, 10).split('-');
  if (p.length !== 3 || !p[0]) return null;
  var d = new Date(+p[0], +p[1] - 1, +p[2]);
  return isNaN(d) ? null : d;
}

// ── RELATÓRIOS DA SEMANA ─────────────────────────────────────────────────────
// A lista é a MESMA do Clipping (`clipping_config.recent_publications`), onde cada
// item traz a data em que o relatório saiu. Aqui ela é só FILTRADA pela semana de
// referência — o analista não recadastra nada no weekly.
//
// ⚠️ A lista do Clipping fala outra língua: lá o título é `name` e o setor é o CÓDIGO
// ('SM'/'PP'/'NR'); o e-mail quer `titulo` e o nome por extenso. A tradução mora AQUI,
// num lugar só, porque ler `r.titulo` direto do que o Clipping gravou devolve vazio —
// e vazio não dá erro, só some da tela.
//
// Janela: **sábado a sexta** (`ini` exclusivo, `fim` inclusive) — a mesma dos preços.
// Relatório publicado no fim de semana entra na edição seguinte em vez de cair no vão
// entre duas semanas.
var SETOR_LONGO = {SM: 'Steel & Mining', PP: 'Pulp & Paper', NR: 'Natural Resources'};
function relatoriosDaSemana(pubs, sem) {
  var de = ymd(sem.ini), ate = ymd(sem.fim);
  return (pubs || [])
    .map(function (p) { return {p: p, d: String((p && p.date) || '').slice(0, 10)}; })
    // string ISO compara como data: 'AAAA-MM-DD' é ordenável lexicograficamente
    .filter(function (x) { return x.d > de && x.d <= ate && (x.p.name || '').trim(); })
    .sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; })
    .map(function (x) {
      return {data: dmes(deIso(x.d)), setor: SETOR_LONGO[x.p.sector] || x.p.sector || '',
              titulo: x.p.name || '', link: x.p.link || ''};
    });
}

// ── EARNINGS REVIEW ──────────────────────────────────────────────────────────
// O Clipping tem um bloco opcional ("2Q26 Review" e afins) com um TOGGLE. Regra do
// analista, textual: *"caso esteja desligado, não deve entrar no nosso weekly"*.
// Então o `on` é verificado ANTES de qualquer filtro — desligado devolve null e a
// seção inteira some do e-mail, mesmo que os itens estejam lá e dentro da semana.
function earningsDaSemana(er, sem) {
  if (!er || !er.on) return null;
  var itens = relatoriosDaSemana(er.items, sem);
  if (!itens.length) return null;
  return {label: (er.label || 'Earnings Review').trim() || 'Earnings Review', itens: itens};
}

// ── leitura de série [[epoch_s, valor], ...] ─────────────────────────────────
// Devolve o ÚLTIMO ponto com data ≤ alvo. É o que faz o fechamento cair no pregão
// certo mesmo quando a data pedida é feriado — e o que mantém honesto o assessment
// SEMANAL de celulose: aí o "fechamento de 28/ago" é legitimamente o de 27/ago, e
// a data real volta em `.data` para a tela poder avisar.
function pontoAte(serie, alvo) {
  if (!serie || !serie.length) return null;
  var lim = Date.UTC(alvo.getFullYear(), alvo.getMonth(), alvo.getDate(), 23, 59, 59) / 1000;
  var achado = null;
  for (var i = 0; i < serie.length; i++) {
    var p = serie[i];
    if (!p || p.length < 2 || p[1] == null) continue;
    if (p[0] <= lim) achado = p; else break;      // a série vem em ordem crescente
  }
  if (!achado) return null;
  return {ts: achado[0], v: Number(achado[1]), data: new Date(achado[0] * 1000)};
}

// Uma linha de tabela: {rotulo, casas, prefixo, ini:{v,data}, fim:{v,data}, delta}
function linhaDeSerie(rotulo, serie, sem, casas, prefixo) {
  var a = pontoAte(serie, sem.ini), b = pontoAte(serie, sem.fim);
  return {
    rotulo: rotulo, casas: casas == null ? 2 : casas, prefixo: prefixo || '',
    ini: a, fim: b,
    delta: (a && b && a.v) ? (b.v / a.v - 1) * 100 : null
  };
}

// ══ RASCUNHO DA PROSA ════════════════════════════════════════════════════════
// Não é IA: é o número virando frase. O analista reescreve por cima — e essa é a
// intenção. O que o rascunho garante é que nenhum número seja digitado à mão.
function _grandeza(p) {                      // "alta de ~3%" / "recuo de 0,2%"
  var a = Math.abs(p);
  if (a < 0.15) return 'praticamente estável';
  return (p > 0 ? 'alta' : 'queda') + ' de ' + (a >= 2 ? '~' : '') + num(a, a >= 2 ? 0 : 1) + '%';
}
// "A, B e C". Feito na mão de propósito: por regex ("troque a última vírgula por
// e") a VÍRGULA DECIMAL do pt-BR entra na conta — "GGBR4 (+7,54%)" tem vírgula
// dentro — e a frase sai com três vírgulas e nenhum "e". Foi assim que quebrou.
function _elista(arr) {
  if (arr.length <= 1) return arr.join('');
  return arr.slice(0, -1).join(', ') + ' e ' + arr[arr.length - 1];
}

// Como o preço aparece na prosa: 'US$/t' + 98,60 vira "US$ 98,60/t" (é o formato
// que o analista escreve). Sem `unidadeProsa`, cai no prefixo da tabela.
function _valorProsa(l) {
  var v = num(l.fim.v, l.casas);
  var m = /^(.*)\/(.*)$/.exec(l.unidadeProsa || '');
  return m ? m[1] + ' ' + v + '/' + m[2] : (l.prefixo || '') + v;
}

function rascunhoCommodities(linhas) {
  var ok = (linhas || []).filter(function (l) { return l.fim && l.delta != null; });
  if (!ok.length) return '';
  return ok.map(function (l) {
    return 'O ' + (l.prosa || l.rotulo) + ' encerrou a semana em ' + _valorProsa(l) +
           ', ' + _grandeza(l.delta) + '.';
  }).join(' ');
}
function rascunhoCompanhias(linhas, idxRotulo) {
  var todas = linhas || [];
  var idx = todas.filter(function (l) { return l.rotulo === idxRotulo; })[0];
  var acoes = todas.filter(function (l) { return l.rotulo !== idxRotulo && l.delta != null; })
                   .sort(function (a, b) { return b.delta - a.delta; });
  if (!acoes.length) return '';
  var altas  = acoes.filter(function (l) { return l.delta > 0; });
  var baixas = acoes.filter(function (l) { return l.delta < 0; });
  var nome = function (l) { return l.rotulo + ' (' + pct(l.delta) + ')'; };
  var t = 'As ações em cobertura tiveram desempenho ' +
    (altas.length >= acoes.length * 0.7 ? 'majoritariamente positivo'
      : baixas.length >= acoes.length * 0.7 ? 'majoritariamente negativo' : 'misto') + ' na semana';
  if (idx && idx.delta != null) t += ', ante ' + pct(idx.delta) + ' do ' + idxRotulo;
  t += '. ';
  if (altas.length) {
    t += _elista(altas.slice(0, 3).map(nome)) +
         (altas.length > 1 ? ' lideraram os ganhos.' : ' liderou os ganhos.');
  }
  if (baixas.length) {
    var piores = baixas.slice(-2).map(nome);
    t += ' Entre os destaques negativos, ' + _elista(piores) +
         (baixas.length === 1 ? ' foi a única ação da cobertura em queda na semana.' : ' ficaram no vermelho.');
  }
  return t;
}
function rascunhoNoticias(dias) {
  var todas = [];
  (dias || []).forEach(function (d) {
    (d.itens || []).forEach(function (i) { if ((i.texto || '').trim()) todas.push(i); });
  });
  if (!todas.length) return '';
  var ROM = ['i', 'ii', 'iii'];
  return todas.slice(0, 3).map(function (it, k) {
    return ROM[k] + ') ' + String(it.texto).trim().replace(/[.;]\s*$/, '');
  }).join('; ') + '.';
}

// ══ BLOCOS DE HTML (todos em tabela + estilo inline: regra do Outlook) ═══════
function _p(txt, est) { return '<p style="margin:0;' + (est || '') + '">' + txt + '</p>'; }

// Régua de uma linha, usada como divisória e como barra do gráfico.
function _regua(cor, alturaPt, larguraPx) {
  return '<table role="presentation" border="0" cellspacing="0" cellpadding="0"' +
    (larguraPx ? ' width="' + larguraPx + '"' : ' width="100%"') + '><tr>' +
    '<td style="background:' + cor + ';font-size:1pt;line-height:' + alturaPt +
    ';height:' + alturaPt + '">&nbsp;</td></tr></table>';
}

// Cabeçalho de seção: tracinho laranja + TÍTULO ESPAÇADO + linha de legenda.
function _secao(titulo, legenda) {
  return '<tr><td style="padding:25.5pt ' + T.PAD + ' 0 ' + T.PAD + '">' +
    _regua(T.accent, '1.5pt', 26) +
    _p('<b style="font-family:' + T.sans + ';font-size:10pt;color:' + T.ink +
       ';letter-spacing:1.05pt">' + _esc(titulo) + '</b>', 'margin:8.5pt 0 3pt 0') +
    (legenda ? _p('<span style="font-family:' + T.sans + ';font-size:9pt;color:' + T.mute + '">' +
       _esc(legenda) + '</span>', 'margin:0 0 10.5pt 0') : '') +
    '</td></tr>';
}

// Cartão branco (o formato dos 3 bullets e dos relatórios).
function _cartao(conteudo) {
  return '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%"' +
    ' style="width:100%;background:' + T.card + ';border:1px solid ' + T.border +
    ';border-radius:12px"><tr><td style="padding:13.5pt 16.5pt">' + conteudo + '</td></tr></table>';
}
function _olho(txt) {
  return _p('<b style="font-family:' + T.sans + ';font-size:8pt;color:' + T.accent +
    ';letter-spacing:.9pt">' + _esc(txt) + '</b>', 'margin:0 0 5pt 0');
}
function _vao(pt) {
  return '<div style="height:' + pt + 'pt;line-height:' + pt + 'pt;font-size:1pt">&nbsp;</div>';
}

// ── as 3 caixas do "1 Semana em 1 Minuto" ────────────────────────────────────
function _blocoResumo(m) {
  var caixas = [
    ['COMMODITIES', m.resumo && m.resumo.commodities],
    ['COMPANHIAS',  m.resumo && m.resumo.companhias],
    ['NOTÍCIAS',    m.resumo && m.resumo.noticias]
  ].filter(function (c) { return (c[1] || '').trim(); });
  if (!caixas.length) return '';
  return '<tr><td style="padding:0 ' + T.PAD + '">' +
    caixas.map(function (c, i) {
      return (i ? _vao(9) : '') +
        _cartao(_olho(c[0]) +
          _p('<span style="font-family:' + T.serif + ';font-size:12.5pt;color:' + T.body + '">' +
             _rich(c[1]) + '</span>', 'line-height:18pt'));
    }).join('') + '</td></tr>';
}

// ── tabela de preços (cabeçalho preto, igual à Coverage Summary do LSS) ──────
function _th(txt, alinha, raio) {
  return '<td style="background:' + T.ink + ';padding:6.75pt ' + (alinha ? '3.75pt' : '10.5pt') +
    (raio ? ';border-radius:' + raio : '') + '">' +
    _p('<b style="font-family:' + T.sans + ';font-size:7.5pt;color:#FFFFFF;letter-spacing:.3pt">' +
       _esc(txt) + '</b>', alinha ? 'text-align:right' : '') + '</td>';
}
function _td(html, alinha, ultima) {
  return '<td style="' + (ultima ? '' : 'border-bottom:1px solid ' + T.line + ';') +
    'padding:6pt ' + (alinha ? '3.75pt' : '10.5pt') + '">' +
    _p(html, alinha ? 'text-align:right' : '') + '</td>';
}
function _tabelaPrecos(linhas, sem) {
  if (!linhas.length) return '';
  var s8 = 'font-family:' + T.sans + ';font-size:8.5pt;';
  var cabec = '<tr>' + _th('ATIVO', false, '12px 0 0 0') +
    _th(dmes(sem.ini).toUpperCase(), true) +
    _th(dmes(sem.fim).toUpperCase(), true) +
    _th('Δ 7 DIAS', true, '0 12px 0 0') + '</tr>';
  var corpo = linhas.map(function (l, i) {
    var ult = i === linhas.length - 1;
    return '<tr>' +
      _td('<b style="' + s8 + 'color:' + T.ink + '">' + _esc(l.rotulo) + '</b>' +
          (l.unidade ? ' <span style="' + s8 + 'color:' + T.faint + '">' + _esc(l.unidade) + '</span>' : ''),
          false, ult) +
      _td('<span style="' + s8 + 'color:' + T.soft + '">' +
          (l.ini ? l.prefixo + num(l.ini.v, l.casas) : '—') + '</span>', true, ult) +
      _td('<b style="' + s8 + 'color:' + T.ink + '">' +
          (l.fim ? l.prefixo + num(l.fim.v, l.casas) : '—') + '</b>', true, ult) +
      _td('<b style="' + s8 + 'color:' + corDe(l.delta) + '">' + pct(l.delta) + '</b>', true, ult) +
      '</tr>';
  }).join('');
  return '<tr><td style="padding:0 ' + T.PAD + '">' +
    '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%"' +
    ' style="width:100%;background:' + T.card + ';border:1px solid ' + T.border +
    ';border-radius:12px;border-collapse:separate">' + cabec + corpo + '</table></td></tr>';
}

// ── ações: fechamentos + gráfico de barras divergente ────────────────────────
// O gráfico é o do "Market Performance" do LSS: coluna negativa | eixo de 1px |
// coluna positiva, cada barra sendo um <td> com `background`. As duas colunas de
// fechamento são nossas — o weekly de hoje manda os dois preços, e trocar isso
// por enfeite seria perder informação.
function _tabelaAcoes(linhas, sem) {
  if (!linhas.length) return '';
  var maxAbs = Math.max.apply(null, linhas.map(function (l) {
    return l.delta == null ? 0 : Math.abs(l.delta);
  }).concat([0.01]));
  var s8 = 'font-family:' + T.sans + ';font-size:8.5pt;';
  var s6 = 'font-family:' + T.sans + ';font-size:7pt;color:' + T.mute + ';letter-spacing:.3pt';

  var corpo = linhas.map(function (l) {
    var v = l.delta, w = v == null ? 0 : Math.max(1, Math.round(BAR_MAX * Math.abs(v) / maxAbs));
    var barra = function (lado) {
      var mostra = v != null && ((lado === 'pos' && v > 0) || (lado === 'neg' && v < 0));
      if (!mostra) return _p('<span style="font-size:1pt">&nbsp;</span>');
      return '<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="' +
        (lado === 'pos' ? 'left' : 'right') + '"><tr>' +
        '<td width="' + w + '" style="width:' + w + 'px;height:6.75pt;background:' +
        (v > 0 ? T.green : T.red) + ';font-size:1pt;line-height:6.75pt">&nbsp;</td></tr></table>';
    };
    return '<tr>' +
      '<td width="70" style="width:70px;padding:1.5pt 4.5pt 1.5pt 0">' +
        _p('<b style="' + s8 + 'color:' + T.ink + '">' + _esc(l.rotulo) + '</b>') + '</td>' +
      '<td width="62" style="width:62px;padding:1.5pt 4.5pt 1.5pt 0">' +
        _p('<span style="' + s8 + 'color:' + T.faint + '">' +
           (l.ini ? l.prefixo + num(l.ini.v, l.casas) : '—') + '</span>', 'text-align:right') + '</td>' +
      '<td width="62" style="width:62px;padding:1.5pt 9pt 1.5pt 0">' +
        _p('<span style="' + s8 + 'color:' + T.soft + '">' +
           (l.fim ? l.prefixo + num(l.fim.v, l.casas) : '—') + '</span>', 'text-align:right') + '</td>' +
      '<td width="' + BAR_HALF + '" style="width:' + BAR_HALF + 'px;padding:1.5pt 0">' + barra('neg') + '</td>' +
      '<td width="1" style="width:1px;background:' + T.axis + ';font-size:1pt;line-height:0">' +
        '<span style="font-size:1pt">&nbsp;</span></td>' +
      '<td width="' + BAR_HALF + '" style="width:' + BAR_HALF + 'px;padding:1.5pt 0">' + barra('pos') + '</td>' +
      '<td width="48" style="width:48px;padding:0 0 0 6pt">' +
        _p('<b style="' + s8 + 'color:' + corDe(l.delta) + '">' + pct(l.delta) + '</b>', 'text-align:right') + '</td>' +
      '</tr>';
  }).join('');

  var cabec = '<tr>' +
    '<td style="padding:0 4.5pt 4.5pt 0"></td>' +
    '<td style="padding:0 4.5pt 4.5pt 0">' +
      _p('<span style="' + s6 + '">' + dmes(sem.ini).toUpperCase() + '</span>', 'text-align:right') + '</td>' +
    '<td style="padding:0 9pt 4.5pt 0">' +
      _p('<span style="' + s6 + '">' + dmes(sem.fim).toUpperCase() + '</span>', 'text-align:right') + '</td>' +
    '<td colspan="4"></td></tr>';

  return '<tr><td style="padding:0 ' + T.PAD + '">' +
    _cartao('<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%"' +
      ' style="width:100%">' + cabec + corpo + '</table>') + '</td></tr>';
}

// ── relatórios publicados ────────────────────────────────────────────────────
function _blocoRelatorios(itens) {
  var lista = (itens || []).filter(function (r) { return (r.titulo || '').trim(); });
  if (!lista.length) return '';
  return '<tr><td style="padding:0 ' + T.PAD + '">' +
    lista.map(function (r, i) {
      var olho = [r.data, r.setor].filter(Boolean).join('  ·  ') || 'ITAÚ BBA';
      var corpo = _olho(olho) +
        _p('<b style="font-family:' + T.serif + ';font-size:12.5pt;color:' + T.body + '">' +
           _esc(r.titulo) + '</b>', 'line-height:17.5pt') +
        (r.link ? _p('<a href="' + _esc(r.link) + '" style="text-decoration:none"><b style="font-family:' +
           T.sans + ';font-size:8.5pt;color:' + T.accent + '">Abrir o relatório ↗</b></a>',
           'margin:6pt 0 0 0') : '');
      return (i ? _vao(7.5) : '') + _cartao(corpo);
    }).join('') + '</td></tr>';
}

// ── notícias do setor, dia a dia ─────────────────────────────────────────────
// Formato do "Next 30 Days" do LSS: rótulo do dia em maiúsculas + itens embaixo.
function _blocoNoticias(dias) {
  var comItens = (dias || []).map(function (d) {
    return {rotulo: d.rotulo, itens: (d.itens || []).filter(function (i) { return (i.texto || '').trim(); })};
  }).filter(function (d) { return d.itens.length; });
  if (!comItens.length) return '';
  var ROM = ['i', 'ii', 'iii', 'iv', 'v', 'vi'];
  return '<tr><td style="padding:0 ' + T.PAD + '">' +
    comItens.map(function (d, k) {
      var itens = d.itens.map(function (it, j) {
        var txt = '<span style="font-family:' + T.serif + ';font-size:11pt;color:' + T.body + '">' +
          '<span style="color:' + T.faint + '">' + (ROM[j] || (j + 1)) + ') </span>' + _rich(it.texto) + '</span>';
        return _p(it.link
          ? '<a href="' + _esc(it.link) + '" style="color:' + T.body + ';text-decoration:none">' + txt + '</a>'
          : txt, 'margin:0 0 6pt 0;line-height:16.5pt');
      }).join('');
      return '<div style="' + (k ? 'margin-top:13.5pt;padding-top:12pt;border-top:1px solid ' + T.border + ';' : '') + '">' +
        _p('<b style="font-family:' + T.sans + ';font-size:9pt;color:' + T.mute +
           ';letter-spacing:1pt">' + _esc(String(d.rotulo).toUpperCase()) + '</b>', 'margin:0 0 8pt 0') +
        itens + '</div>';
    }).join('') + '</td></tr>';
}

// ── comp table (molde da "Coverage Summary Table" do Long Story Short) ──────
// Um cabeçalho PRETO por grupo de setor, como no LSS. As contas NÃO são feitas aqui:
// chegam prontas de `SG.deriveComps` (stock-guide-lib.js), a mesma função que desenha
// a aba Stock Guide — só que alimentada com o fechamento da sexta em vez do preço ao
// vivo. É isso que garante que o preço desta tabela seja o MESMO da coluna "hoje" da
// tabela de performance, que era a exigência do analista.
function _tabelaComps(comps) {
  var grupos = (comps && comps.grupos || []).filter(function (g) { return (g.linhas || []).length; });
  if (!grupos.length) return '';
  var y1 = comps.y1 || '26E';
  var COLS = ['PREÇO', 'TARGET', 'UPSIDE', 'EV/EBITDA ' + y1, 'P/E ' + y1, 'DY ' + y1];
  var s8 = 'font-family:' + T.sans + ';font-size:8.5pt;';
  var s7 = 'font-family:' + T.sans + ';font-size:7.5pt;';

  var corpo = grupos.map(function (g, gi) {
    var cab = '<tr>' +
      '<td style="background:' + T.ink + ';padding:6.75pt 10.5pt' +
        (gi === 0 ? ';border-radius:12px 0 0 0' : '') + '">' +
        _p('<b style="' + s7 + 'color:#FFFFFF;letter-spacing:.9pt">' + _esc(g.titulo) + '</b>') + '</td>' +
      COLS.map(function (c, i) {
        return '<td style="background:' + T.ink + ';padding:6.75pt 3.75pt' +
          (gi === 0 && i === COLS.length - 1 ? ';border-radius:0 12px 0 0' : '') + '">' +
          _p('<b style="font-family:' + T.sans + ';font-size:6.5pt;color:#FFFFFF;letter-spacing:.3pt">' +
             _esc(c) + '</b>', 'text-align:right') + '</td>';
      }).join('') + '</tr>';

    var linhas = g.linhas.map(function (l, i) {
      var ult = (gi === grupos.length - 1) && (i === g.linhas.length - 1);
      var borda = ult ? '' : 'border-bottom:1px solid ' + T.line + ';';
      var cel = function (txt, cor, negrito) {
        return '<td style="' + borda + 'padding:6pt 3.75pt">' +
          _p('<' + (negrito ? 'b' : 'span') + ' style="' + s8 + 'color:' + (cor || T.soft) + '">' +
             txt + '</' + (negrito ? 'b' : 'span') + '>', 'text-align:right') + '</td>';
      };
      return '<tr>' +
        '<td style="' + borda + 'padding:6pt 10.5pt">' +
          _p('<b style="' + s8 + 'color:' + T.ink + '">' + _esc(l.nome) + '</b>' +
             (l.ticker ? ' <span style="' + s8 + 'color:' + T.faint + '">' + _esc(l.ticker) + '</span>' : '')) + '</td>' +
        cel(_esc(l.preco || '—'), T.ink, true) +
        cel(_esc(l.target || '—')) +
        // o upside é a leitura do analista: verde quando o alvo está acima do preço
        cel(l.upside == null ? '—' : pct(l.upside, 0), corDe(l.upside), true) +
        cel(l.evEbitda == null ? '—' : num(l.evEbitda, 1) + 'x') +
        cel(l.pe == null ? '—' : num(l.pe, 1) + 'x') +
        cel(l.dy == null ? '—' : num(l.dy, 1) + '%') +
        '</tr>';
    }).join('');
    return cab + linhas;
  }).join('');

  return '<tr><td style="padding:0 ' + T.PAD + '">' +
    '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%"' +
    ' style="width:100%;background:' + T.card + ';border:1px solid ' + T.border +
    ';border-radius:12px;border-collapse:separate">' + corpo + '</table>' +
    (comps.nota ? _p('<span style="font-family:' + T.sans + ';font-size:7.5pt;color:' + T.mute + '">' +
       _esc(comps.nota) + '</span>', 'margin:6pt 0 0 0') : '') +
    '</td></tr>';
}

// ══ O E-MAIL INTEIRO ═════════════════════════════════════════════════════════
/**
 * model = {
 *   semana:{ini,fim,seg}, precos:[linha], acoes:[linha],
 *   resumo:{commodities,companhias,noticias}, intro:'...',
 *   relatorios:[{data,setor,titulo,link}], dias:[{rotulo,itens:[{texto,link}]}],
 *   assinatura:{nome,cargo,contato}, dashboard:{url,label},
 *   marca, titulo, subtitulo, fontePrecos
 * }
 */
function buildEmail(m) {
  var sem = m.semana, linhas = [];

  // 1. cabeçalho da publicação
  linhas.push('<tr><td style="padding:19.5pt ' + T.PAD + ' 12pt ' + T.PAD + '">' +
    '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="width:100%"><tr>' +
    '<td>' + _p('<b style="font-family:' + T.sans + ';font-size:8.5pt;color:' + T.accent +
        ';letter-spacing:1.4pt">' + _esc(m.marca || 'ITAÚ BBA EQUITY RESEARCH') + '</b>') +
      _p('<span style="font-family:' + T.serif + ';font-size:20pt;color:' + T.ink +
        ';letter-spacing:-.3pt">' + _esc(m.titulo || 'Weekly Recap') + '</span>', 'margin:3pt 0 0 0') + '</td>' +
    '<td valign="bottom">' + _p('<span style="font-family:' + T.sans + ';font-size:8.5pt;color:' +
        T.mute + ';letter-spacing:.25pt">' + _esc(m.subtitulo || 'Steel & Mining · Pulp & Paper') +
        '</span>', 'text-align:right') + '</td>' +
    '</tr></table></td></tr>');
  linhas.push('<tr><td style="padding:0 ' + T.PAD + '">' + _regua(T.ink, '1.5pt') + '</td></tr>');

  // 2. abertura: período + título grande + saudação
  linhas.push('<tr><td style="padding:27pt ' + T.PAD + ' 0 ' + T.PAD + '">' +
    _p('<b style="font-family:' + T.sans + ';font-size:8pt;color:' + T.mute + ';letter-spacing:1.15pt">' +
       _esc(periodoLongo(sem.seg, sem.fim).toUpperCase()) + '</b>') +
    _p('<span style="font-family:' + T.serif + ';font-size:26.5pt;color:' + T.ink +
       ';letter-spacing:-.45pt">1 Semana em 1 Minuto</span>', 'margin:9pt 0 13.5pt 0;line-height:30pt') +
    ((m.intro || '').trim()
      ? _p('<span style="font-family:' + T.serif + ';font-size:13pt;color:' + T.body + '">' +
           _rich(m.intro) + '</span>', 'margin:0 0 15pt 0;line-height:20.25pt')
      : '') +
    '</td></tr>');

  // 3. os 3 cartões
  linhas.push(_blocoResumo(m));

  // 4. preços
  if ((m.precos || []).length) {
    linhas.push(_secao('PREÇOS', m.fontePrecos ||
      ('Fechamento de ' + dbarra(sem.ini) + ' contra ' + dbarra(sem.fim) +
       '. Assessments Platts (aço e minério) e Fastmarkets PIX (celulose)')));
    linhas.push(_tabelaPrecos(m.precos, sem));
  }

  // 5. ações
  if ((m.acoes || []).length) {
    linhas.push(_secao('AÇÕES EM COBERTURA', 'Fechamento de ' + dbarra(sem.ini) + ' contra ' +
      dbarra(sem.fim) + '. Cada papel na moeda em que negocia'));
    linhas.push(_tabelaAcoes(m.acoes, sem));
  }

  // 6. relatórios
  if ((m.relatorios || []).some(function (r) { return (r.titulo || '').trim(); })) {
    linhas.push(_secao('RELATÓRIOS PUBLICADOS', 'O que saiu na semana'));
    linhas.push(_blocoRelatorios(m.relatorios));
  }

  // 6b. earnings review (só quando o toggle do Clipping está LIGADO)
  if (m.earnings && (m.earnings.itens || []).length) {
    linhas.push(_secao(String(m.earnings.label).toUpperCase(),
      'Resultados comentados na semana'));
    linhas.push(_blocoRelatorios(m.earnings.itens));
  }

  // 6c. comp table (múltiplos no MESMO preço da tabela de performance)
  if (m.comps && (m.comps.grupos || []).some(function (g) { return (g.linhas || []).length; })) {
    linhas.push(_secao('MÚLTIPLOS DA COBERTURA',
      'Estimativas do nosso modelo sobre o fechamento de ' + dbarra(sem.fim) +
      ' — o mesmo preço da tabela acima'));
    linhas.push(_tabelaComps(m.comps));
  }

  // 7. notícias
  if ((m.dias || []).some(function (d) {
        return (d.itens || []).some(function (i) { return (i.texto || '').trim(); }); })) {
    linhas.push(_secao('PRINCIPAIS NOTÍCIAS DO SETOR',
      'Dia a dia, o que moveu Mineração, Siderurgia e Papel & Celulose'));
    linhas.push(_blocoNoticias(m.dias));
  }

  // 8. rodapé: link da dashboard + assinatura
  var a = m.assinatura || {};
  linhas.push('<tr><td style="padding:25.5pt ' + T.PAD + ' 0 ' + T.PAD + '">' +
    _regua(T.border, '1pt') + '</td></tr>');
  linhas.push('<tr><td style="padding:15pt ' + T.PAD + ' 24pt ' + T.PAD + '">' +
    (m.dashboard && m.dashboard.url
      ? _p('<a href="' + _esc(m.dashboard.url) + '" style="text-decoration:none"><b style="font-family:' +
           T.sans + ';font-size:8.5pt;color:' + T.accent + '">' +
           _esc(m.dashboard.label || 'Dashboard M&M | P&P') + ' ↗</b></a>', 'margin:0 0 12pt 0')
      : '') +
    _p('<b style="font-family:' + T.sans + ';font-size:9pt;color:' + T.ink + '">' + _esc(a.nome || '') + '</b>') +
    _p('<span style="font-family:' + T.sans + ';font-size:8.5pt;color:' + T.mute + '">' +
       _esc(a.cargo || '') + (a.contato ? '<br>' + _esc(a.contato) : '') + '</span>', 'margin:2pt 0 0 0') +
    '</td></tr>');

  // O <table width=640> é o que segura a largura no Outlook: `max-width` sozinho ele ignora.
  return '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%"' +
    ' style="width:100%;background:' + T.bg + ';margin:0;padding:0"><tr><td align="center"' +
    ' style="padding:0;background:' + T.bg + '">' +
    '<table role="presentation" border="0" cellspacing="0" cellpadding="0" width="' + T.W + '"' +
    ' style="width:' + T.W + 'px;max-width:' + T.W + 'px;background:' + T.bg + '">' +
    linhas.join('') + '</table></td></tr></table>';
}

function assunto(m) {
  return 'Weekly Recap S&M/P&P – Semana encerrada em ' + dbarra(m.semana.fim);
}

// ══ .eml — o arquivo que abre no Outlook como mensagem NOVA ══════════════════
// Lições que custaram caro no clipping (ver CLAUDE.md, `b34cc4e` e `c350d64`):
//   • a quebra de linha TEM de ser CRLF. Com LF o Outlook não decodifica o corpo
//     e cospe o código-fonte na tela.
//   • `X-Unsent: 1`, senão a mensagem abre como RECEBIDA e o analista só consegue
//     encaminhar (vai com "FW:" e com o cabeçalho de outra pessoa).
// Aqui o corpo vai em BASE64 (e não em quoted-printable): não há caractere que
// escape, não há linha longa para dobrar, e acento não depende de codificação.
function _b64(bytes) {
  var s = '', CH = 0x8000;                     // fatia p/ não estourar a pilha do apply
  for (var i = 0; i < bytes.length; i += CH)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
function buildEml(m, html) {
  var enc = new TextEncoder();
  var doc = '<!doctype html><html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width"></head>' +
            '<body style="margin:0;padding:0;background:' + T.bg + '">' + html + '</body></html>';
  var corpo = _b64(enc.encode(doc)).replace(/(.{76})/g, '$1\r\n');
  var cab = [
    'MIME-Version: 1.0',
    'X-Unsent: 1',                                   // abre como mensagem NOVA
    'Subject: =?UTF-8?B?' + _b64(enc.encode(assunto(m))) + '?=',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    ''
  ].join('\r\n');
  return cab + '\r\n' + corpo + '\r\n';
}

root.IBBAWeekly = {
  T: T, semanaDe: semanaDe, periodoLongo: periodoLongo, diasUteis: diasUteis, diaSemana: diaSemana,
  pontoAte: pontoAte, linhaDeSerie: linhaDeSerie, relatoriosDaSemana: relatoriosDaSemana,
  earningsDaSemana: earningsDaSemana,
  num: num, pct: pct, dmes: dmes, dbarra: dbarra, ymd: ymd, deIso: deIso,
  rascunhoCommodities: rascunhoCommodities,
  rascunhoCompanhias: rascunhoCompanhias,
  rascunhoNoticias: rascunhoNoticias,
  buildEmail: buildEmail, buildEml: buildEml, assunto: assunto
};
})(typeof window !== 'undefined' ? window : this);
