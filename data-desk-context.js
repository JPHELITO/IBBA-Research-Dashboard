/* ════════════════════════════════════════════════════════════════════════════
   IBBA · DATA DESK — CONTEXT: o que está em volta do número (as OUTRAS abas dentro da mesa)
   ────────────────────────────────────────────────────────────────────────────
   Plano: IBBA-Dashboard/data-desk/PLANO.md (5.7 e Fase 6). Carrega DEPOIS do data-desk.js.

   Uma faixa logo abaixo do palco, com até três blocos — cada um leva à aba de origem:
     · Exposed names      → empresas cobertas mais expostas à seção (cotação do dia)  → Market
       + Next release     → quando sai o próximo dado da fonte (janelas do Calendário) → Calendar
     · Benchmarks         → 2 a 4 preços de referência (tabela commodities)            → Market › Commodities
     · Related headlines  → as 3 manchetes mais recentes do assunto, com o take        → News

   Regras (consumo do banco é restrito):
     · só busca quando a faixa chega perto da tela (IntersectionObserver);
     · colunas pelo nome, `limit`, nunca `daily`; do `spark` só a janela de 1 ano (`y:spark->y`);
     · cada consulta fica 10 min em sessionStorage — trocar de seção e voltar não vai à rede;
     · orçamento: ≤ 4 consultas e ≤ 6 KB por visita de seção (medido em data-desk/ferramentas/ver_context.py);
     · bloco que falha ou vem vazio SOME; sem rede a mesa inteira funciona igual (nada disto é necessário para os gráficos).
   A página declara o mapa (cfg.context.sections) e como buscar (cfg.context.get / .rpc).
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var D = window.IBBADesk; if (!D || !D.x || D.x.Desk.prototype._context) return;
  var X = D.x, Desk = X.Desk, esc = X.esc, fmt = X.fmt, MON = D.core.MON, TTL = 10 * 60 * 1000, PRE = 'ibba_dkcx:';

  /* consulta com cache de 10 min (memória + sessionStorage). Falha = null (o bloco some) e pode tentar de novo depois */
  Desk.prototype._cxGet = function (key, run) {
    var mem = this._cxMem = this._cxMem || {}, now = Date.now(), hit = mem[key];
    if (hit && now - hit.t < TTL) return hit.p;
    try { var raw = sessionStorage.getItem(PRE + key); if (raw) { var o = JSON.parse(raw); if (o && now - o.t < TTL) { mem[key] = { t: o.t, p: Promise.resolve(o.d) }; return mem[key].p; } } } catch (e) {}
    var p = Promise.resolve().then(run).then(function (d) { if (d == null) throw new Error('vazio'); try { sessionStorage.setItem(PRE + key, JSON.stringify({ t: Date.now(), d: d })); } catch (e) {} return d; })
      .catch(function () { delete mem[key]; return null; });
    mem[key] = { t: now, p: p }; return p;
  };

  function quoted(list) { return list.map(function (t) { return encodeURIComponent('"' + t + '"'); }).join(','); }
  function px(v) { return (v == null || !isFinite(v)) ? '—' : fmt(v, Math.abs(v) >= 100 ? 0 : 2); }
  function chg(v) { if (v == null || !isFinite(v)) return '<span>—</span>'; var c = v > 0 ? 'dk-up' : v < 0 ? 'dk-dn' : ''; return '<span class="' + c + '">' + (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%</span>'; }
  function dayTxt(iso) { var d = iso ? new Date(iso) : null; return (d && !isNaN(d)) ? MON[d.getMonth()] + ' ' + d.getDate() : ''; }
  function ago(iso) { var d = iso ? new Date(iso) : null; if (!d || isNaN(d)) return ''; var m = Math.round((Date.now() - d) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm ago' : m < 24 * 60 ? Math.round(m / 60) + 'h ago' : dayTxt(iso); }
  function spark(s, w, hh) { var pts = []; (s || []).forEach(function (v, i) { if (v != null) pts.push([i, +v]); }); if (pts.length < 2) return '';
    var mn = Infinity, mx = -Infinity, n = s.length - 1; pts.forEach(function (p) { mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]); });
    var d = pts.map(function (p, j) { return (j ? 'L' : 'M') + (1 + p[0] / n * (w - 2)).toFixed(1) + ' ' + (hh - 1 - (mx > mn ? (p[1] - mn) / (mx - mn) : .5) * (hh - 2)).toFixed(1); }).join('');
    return '<svg viewBox="0 0 ' + w + ' ' + hh + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>'; }
  /* próxima janela de divulgação de uma fonte: {from_day,to_day,lag_months} → "Nov data expected 1–10 Dec" */
  function nextRelease(w, today) {
    today = today || new Date(); var y = today.getFullYear(), m = today.getMonth(), k;
    for (k = 0; k < 3; k++) { var mm = new Date(y, m + k, 1), dim = new Date(mm.getFullYear(), mm.getMonth() + 1, 0).getDate(), a = Math.min(Math.max(1, w.from_day || 1), dim), b = Math.min(Math.max(a, w.to_day || a), dim);
      var end = new Date(mm.getFullYear(), mm.getMonth(), b, 23, 59, 59); if (end < today) continue;
      var ref = new Date(mm.getFullYear(), mm.getMonth() - (w.lag_months == null ? 1 : w.lag_months), 1), start = new Date(mm.getFullYear(), mm.getMonth(), a);
      return { data: MON[ref.getMonth()], when: (a === b ? a : a + '–' + b) + ' ' + MON[mm.getMonth()], open: start <= today }; }
    return null;
  }
  function srcName(label) { return String(label || '').split(/\s[—–-]\s/)[0].trim(); }

  Desk.prototype._context = function () {
    var cx = this.cfg.context, E = this.el; if (!E || !E.ctx) return;
    var map = cx && cx.sections && cx.sections[this.cur];
    if (!map || !cx.get) { E.ctx.className = 'dk-ctx0'; E.ctx.innerHTML = ''; E.ctx.dataset.sec = ''; return; }
    if (E.ctx.dataset.sec === this.cur) { this._cxDraw(map); return; }   // tema ou filtro mudou: redesenha com o que já chegou
    E.ctx.dataset.sec = this.cur; E.ctx.className = 'dk-ctx0'; E.ctx.innerHTML = ''; this._cxData = {};
    var self = this, sec = this.cur, go = function () { self._cxLoad(map, sec); };
    if (this._cxIO) { try { this._cxIO.disconnect(); } catch (e) {} this._cxIO = null; }
    if (!('IntersectionObserver' in window)) { go(); return; }
    this._cxIO = new IntersectionObserver(function (en) { if (!en.some(function (x) { return x.isIntersecting; })) return; self._cxIO.disconnect(); self._cxIO = null; go(); }, { rootMargin: '260px 0px' });
    this._cxIO.observe(E.ctx);
  };
  Desk.prototype._cxLoad = function (map, sec) {
    var cx = this.cfg.context, self = this;
    var put = function (k) { return function (d) { if (self.cur !== sec || !self.el || !self.el.ctx || self.el.ctx.dataset.sec !== sec) return; self._cxData[k] = d; self._cxDraw(map); }; };
    if (map.tickers && map.tickers.length) this._cxGet('q:' + map.tickers.join(','), function () { return cx.get('quotes?select=ticker,name,price,change_pct&ticker=in.(' + quoted(map.tickers) + ')'); }).then(put('quotes'));
    if (map.bench && map.bench.length) this._cxGet('c:' + map.bench.join(','), function () { return cx.get('commodities?select=code,name,unit,price,change_pct,assessed_at,updated_at,y:spark->y&code=in.(' + quoted(map.bench) + ')'); }).then(put('bench'));
    if (map.news && map.news.topics && map.news.topics.length) { var f = 'news_articles?select=title,url,take_llm,source_name,found_at&include_in_report=eq.true&take_llm=neq.' + encodeURIComponent('no take') +
        (map.news.sector ? '&sector=eq.' + encodeURIComponent(map.news.sector) : '') + '&or=(' + map.news.topics.map(function (t) { return 'take_topics.ilike.*' + encodeURIComponent(t) + '*'; }).join(',') + ')&order=found_at.desc&limit=3';
      this._cxGet('n:' + (map.news.sector || '') + ':' + map.news.topics.join(','), function () { return cx.get(f); }).then(put('news')); }
    if (map.cal && map.cal.length && cx.rpc) this._cxGet('cal', function () { return cx.rpc('get_exec_calendar_data_windows'); }).then(put('cal'));
  };
  Desk.prototype._cxDraw = function (map) {
    var E = this.el, d = this._cxData || {}, cx = this.cfg.context, dark = X.isDark(), blocks = [], ok = function (a) { return Array.isArray(a) && a.length; };
    /* 1 · empresas expostas (+ próxima divulgação) */
    var names = ok(d.quotes) ? (map.tickers || []).map(function (t) { return d.quotes.filter(function (r) { return r.ticker === t; })[0]; }).filter(Boolean) : [];
    var rel = ok(d.cal) ? (map.cal || []).map(function (k) { var w = d.cal.filter(function (r) { return r.source_key === k; })[0], n = w && nextRelease(w); return n ? { src: srcName(w.label), n: n } : null; }).filter(Boolean) : [];
    if (names.length || rel.length) blocks.push('<div class="dk-cx dk-cx1">' +
      (names.length ? '<div class="dk-cxh"><span>Exposed names</span><em>today · click to open in Market</em></div><div class="dk-cxnames">' + names.map(function (r) {
        var code = String(r.ticker).split('.')[0], logo = window.IBBALogo ? IBBALogo(r.ticker, { dark: dark }) : null;
        return '<a class="dk-cxname" href="' + esc((cx.marketHref || '/market.html') + '?t=' + encodeURIComponent(r.ticker)) + '" title="Open ' + esc(r.name || code) + ' in Market">' +
          (logo ? '<img src="' + esc(logo) + '" alt="" loading="lazy">' : '') + '<b>' + esc(code) + '</b>' + chg(r.change_pct) + '</a>'; }).join('') + '</div>' : '') +
      (rel.length ? '<a class="dk-cxnext" href="' + esc(cx.agendaHref || '/agenda.html') + '" title="Open the calendar"><span>Next release</span>' + rel.map(function (x) { return '<b>' + esc(x.src) + '</b> ' + esc(x.n.data) + ' data ' + (x.n.open ? 'due now · ' : 'expected ') + esc(x.n.when); }).join(' · ') + ' <i>Calendar →</i></a>' : '') + '</div>');
    /* 2 · benchmarks */
    var bench = ok(d.bench) ? (map.bench || []).map(function (c0) { return d.bench.filter(function (r) { return r.code === c0; })[0]; }).filter(Boolean) : [];
    if (bench.length) blocks.push('<div class="dk-cx dk-cx2"><div class="dk-cxh"><span>Benchmarks</span><a href="' + esc(cx.commoditiesHref || '/market.html?tab=commodities') + '">Open in Market →</a></div><div class="dk-cxbs">' + bench.map(function (r) {
      var y = r.y && r.y.s, day = dayTxt(r.assessed_at || r.updated_at);
      return '<a class="dk-cxb" href="' + esc(cx.commoditiesHref || '/market.html?tab=commodities') + '" title="' + esc(r.name) + (day ? ' — as of ' + day : '') + ' · change vs the previous assessment · line = last 12 months">' +
        '<span class="n">' + esc(r.name) + '</span><b>' + px(r.price) + '<small>' + esc(r.unit || '') + '</small></b><span class="c">' + chg(r.change_pct) + (day ? '<em>' + day + '</em>' : '') + '</span>' + (y ? '<span class="s">' + spark(y, 120, 22) + '</span>' : '') + '</a>'; }).join('') + '</div></div>');
    /* 3 · manchetes do assunto */
    var news = ok(d.news) ? d.news.filter(function (r) { return r && r.title; }).slice(0, 3) : [];
    if (news.length) { var href = (cx.newsHref || '/news.html') + (map.news.q ? '?q=' + encodeURIComponent(map.news.q) : '');
      blocks.push('<div class="dk-cx dk-cx3"><div class="dk-cxh"><span>Related headlines</span><a href="' + esc(href) + '">All in News →</a></div>' + news.map(function (r) {
        var t = r.take_llm, k = t === '+' ? 'p' : t === '-' ? 'm' : t === '=' ? 'e' : 'o', sym = t === '+' ? '+' : t === '-' ? '−' : t === '=' ? '=' : '○', safe = /^https?:\/\//i.test(r.url || '');
        return '<a class="dk-cxnews"' + (safe ? ' href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer"' : ' href="' + esc(href) + '"') + ' title="' + esc(r.title) + '"><i class="dk-tk dk-tk-' + k + '" title="Our take: ' + (k === 'p' ? 'positive' : k === 'm' ? 'negative' : k === 'e' ? 'neutral' : 'none') + '">' + sym + '</i><span class="t">' + esc(r.title) + '</span><em>' + esc(r.source_name || '') + (r.found_at ? ' · ' + ago(r.found_at) : '') + '</em></a>'; }).join('') + '</div>'); }
    if (!blocks.length) { E.ctx.className = 'dk-ctx0'; E.ctx.innerHTML = ''; return; }
    E.ctx.className = 'dk-ctx dk-card dk-cxn' + blocks.length; E.ctx.innerHTML = blocks.join('');
  };
  D.context = { nextRelease: nextRelease, srcName: srcName, ago: ago };
})();
