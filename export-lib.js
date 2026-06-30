/* =========================================================================
 * export-lib.js — utilitário de EXPORTAÇÃO admin-only da IBBA Dashboard.
 * Baixar gráficos (PNG + Excel/CSV), tabelas (Excel) e gerar PDF ("print").
 * Carregado nas 4 páginas (Stock Guide, Steel & Mining, Pulp & Paper, Market).
 * UI em inglês; comentários em PT. Sem dependências obrigatórias: SheetJS é
 * carregado SOB DEMANDA (lazy) só quando o admin pede um Excel.
 * Convenção: tudo gateado por admin NO CHAMADOR (a lib não decide permissão).
 * ====================================================================== */
(function () {
  if (window.IBBAExport) return;

  // ── infra ──────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('falha ao carregar ' + src));
      document.head.appendChild(s);
    });
  }
  const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  async function ensureXLSX() { if (!window.XLSX) await loadScript(XLSX_CDN); return window.XLSX; }

  function downloadURL(url, filename) {
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadBlob(blob, filename) {
    const u = URL.createObjectURL(blob); downloadURL(u, filename); setTimeout(() => URL.revokeObjectURL(u), 8000);
  }
  function stamp() {   // sufixo de data p/ os nomes de arquivo (YYYY-MM-DD)
    const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function safeName(s) { return String(s || 'export').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(0, 80); }
  function sheetName(s) { return (String(s || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim() || 'Sheet').slice(0, 31); }

  // fundo "real" de um elemento (sobe na árvore até achar cor não-transparente) →
  // garante que o PNG saia com o MESMO fundo que aparece na tela (claro ou escuro).
  function resolveBg(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg)) return bg;
      n = n.parentElement;
    }
    return '#ffffff';
  }

  // ── cor de texto/contraste conforme o fundo (claro vs escuro) ──
  function _rgb(s) { const m = String(s).match(/(\d+(\.\d+)?)/g); return m ? m.slice(0, 3).map(Number) : [255, 255, 255]; }
  function _isDark(bg) { const c = _rgb(bg); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) < 128; }
  function _textColor(bg) { return _isDark(bg) ? '#E6EDF3' : '#111111'; }
  function _dimColor(bg) { return _isDark(bg) ? '#9DA7B3' : '#5A6573'; }
  function _dsColor(d) { const c = d.borderColor || d.backgroundColor; return Array.isArray(c) ? c[0] : (typeof c === 'string' ? c : '#888'); }

  // ── compõe o PNG final: faixa de cabeçalho (título + sub + LEGENDA) + o desenho do gráfico ──
  // opts: {chartW, chartH, bg, title, sub, legend:[{name,color}], scale, filename, paint(ctx,x,y,w,h)}
  function _exportComposite(opts) {
    const scale = opts.scale || 2, pad = 14, W = Math.max(40, Math.round(opts.chartW || 480));
    const bg = opts.bg || '#ffffff', tcol = _textColor(bg), dim = _dimColor(bg);
    // mede a legenda (com quebra de linha) p/ dimensionar o cabeçalho
    const meas = document.createElement('canvas').getContext('2d');
    const legend = (opts.legend || []).filter(l => l && l.name);
    let legItems = [], legRows = 0;
    if (legend.length) {
      meas.font = '600 11px Arial,Helvetica,sans-serif'; let lx = pad, row = 0;
      legend.forEach(it => { const w = 16 + meas.measureText(it.name).width + 16;
        if (lx + w > W - pad && lx > pad) { lx = pad; row++; } legItems.push({ name: it.name, color: it.color, x: lx, row }); lx += w; });
      legRows = row + 1;
    }
    let headH = 0;
    if (opts.title) headH += 20;
    if (opts.sub) headH += 15;
    if (legRows) headH += legRows * 16 + 2;
    if (headH) headH += pad + 6;   // respiro acima/abaixo do cabeçalho
    const H = Math.round(opts.chartH || 300) + headH;
    const c = document.createElement('canvas'); c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    const ctx = c.getContext('2d'); ctx.scale(scale, scale);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'top';
    let y = headH ? pad - 2 : 0;
    if (opts.title) { ctx.fillStyle = tcol; ctx.font = '700 15px Arial,Helvetica,sans-serif'; ctx.fillText(opts.title, pad, y); y += 20; }
    if (opts.sub) { ctx.fillStyle = dim; ctx.font = '400 11px Arial,Helvetica,sans-serif'; ctx.fillText(opts.sub, pad, y); y += 15; }
    if (legRows) { const y0 = y + 2; ctx.font = '600 11px Arial,Helvetica,sans-serif';
      legItems.forEach(it => { const iy = y0 + it.row * 16; ctx.fillStyle = it.color || '#888'; ctx.fillRect(it.x, iy + 1, 11, 11);
        ctx.fillStyle = tcol; ctx.fillText(it.name, it.x + 16, iy); }); }
    opts.paint(ctx, 0, headH, W, Math.round(opts.chartH || 300));
    c.toBlob(b => downloadBlob(b, safeName(opts.filename) + '.png'), 'image/png');
  }

  // ── PNG de um gráfico Chart.js: título/sub (do card) + LEGENDA (das séries) + o desenho ──
  function pngFromChart(chart, filename, opts) {
    opts = opts || {};
    const src = chart.canvas, dpr = window.devicePixelRatio || 1;
    const bg = opts.bg || resolveBg(src.parentElement || src) || '#ffffff';
    const w = src.clientWidth || Math.round(src.width / dpr) || src.width;
    const h = src.clientHeight || Math.round(src.height / dpr) || src.height;
    const legend = ((chart.data && chart.data.datasets) || []).filter(d => d.label).map(d => ({ name: d.label, color: _dsColor(d) }));
    _exportComposite({ chartW: w, chartH: h, bg, title: opts.title, sub: opts.sub, legend, filename,
      paint: (ctx, x, y, cw, ch) => ctx.drawImage(src, x, y, cw, ch) });
  }

  // ── PNG de um SVG inline (Market). Inlina os estilos COMPUTADOS no clone
  //    (resolve as CSS vars de cor/fonte) → SVG autocontido → canvas → PNG. ──
  const _SVG_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
    'stroke-linejoin', 'stroke-linecap', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor'];
  function inlineStyles(src, dst) {
    const cs = getComputedStyle(src); let s = '';
    for (const p of _SVG_PROPS) { const v = cs.getPropertyValue(p); if (v) s += p + ':' + v + ';'; }
    dst.setAttribute('style', s);
    const sc = src.children, dc = dst.children;
    for (let i = 0; i < sc.length; i++) if (dc[i]) inlineStyles(sc[i], dc[i]);
  }
  function pngFromSVG(svg, filename, opts) {
    opts = opts || {};
    const scale = opts.scale || 2;
    const rect = svg.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width || +svg.getAttribute('width') || 720));
    const h = Math.max(2, Math.round(rect.height || +svg.getAttribute('height') || 320));
    const bg = opts.bg || resolveBg(svg.parentElement || svg) || '#ffffff';
    const clone = svg.cloneNode(true);
    inlineStyles(svg, clone);
    clone.setAttribute('width', w); clone.setAttribute('height', h);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const data = new XMLSerializer().serializeToString(clone);
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
    const img = new Image();
    img.onload = () => {
      _exportComposite({ chartW: w, chartH: h, bg, scale, title: opts.title, sub: opts.sub, legend: opts.legend, filename,
        paint: (ctx, x, y, cw, ch) => ctx.drawImage(img, x, y, cw, ch) });
    };
    img.onerror = () => alert('Could not render the chart image.');
    img.src = url;
  }

  // ── Chart.js → array-de-arrays (rótulos × séries). Lida com pontos {x,y}. ──
  function chartToAOA(chart) {
    const labels = (chart.data && chart.data.labels) || [];
    const ds = (chart.data && chart.data.datasets) || [];
    const val = v => (v && typeof v === 'object') ? (v.y != null ? v.y : (v.value != null ? v.value : '')) : v;
    const header = ['Label'].concat(ds.map((d, i) => d.label || ('series ' + (i + 1))));
    const n = labels.length || ds.reduce((m, d) => Math.max(m, (d.data || []).length), 0);
    const rows = [];
    for (let i = 0; i < n; i++) rows.push([labels[i] != null ? labels[i] : i].concat(ds.map(d => val((d.data || [])[i]))));
    return [header].concat(rows);
  }

  // ── CSV / Excel ─────────────────────────────────────────────────────
  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCSV(aoa, filename) {
    const csv = aoa.map(r => r.map(csvCell).join(',')).join('\r\n');
    downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), safeName(filename) + '.csv');
  }
  async function xlsxFromAOA(sheets, filename) {   // sheets = [{name, aoa}]
    const X = await ensureXLSX();
    const wb = X.utils.book_new();
    sheets.forEach(s => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(s.aoa), sheetName(s.name)));
    X.writeFile(wb, safeName(filename) + '.xlsx');
  }
  async function xlsxFromTables(tables, filename) {   // tables = [{name, el}]
    const X = await ensureXLSX();
    const wb = X.utils.book_new();
    tables.forEach(t => { if (t.el) X.utils.book_append_sheet(wb, X.utils.table_to_sheet(t.el, { raw: true }), sheetName(t.name)); });
    X.writeFile(wb, safeName(filename) + '.xlsx');
  }

  // ── mecanismo de print: iframe oculto → write doc → print() (usuário salva como PDF) ──
  function _printDoc(html) {
    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(ifr);
    const doc = ifr.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    const go = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} setTimeout(() => ifr.remove(), 1500); };
    if (doc.readyState === 'complete') setTimeout(go, 250); else ifr.onload = () => setTimeout(go, 250);
  }
  // Print genérico (estilo próprio, limpo).
  function printHTML(bodyHTML, opts) {
    opts = opts || {};
    const orient = opts.landscape === false ? 'portrait' : 'landscape';
    _printDoc(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (opts.title || 'IBBA Research — Export') + '</title><style>' +
      '@page{size:A4 ' + orient + ';margin:10mm}' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'h1{font-size:15px;margin:0 0 2px}.sub{font-size:10px;color:#666;margin:0 0 12px}' +
      'table{border-collapse:collapse;width:100%;font-size:9.5px;margin:0 0 16px}' +
      'tr{page-break-inside:avoid}th,td{border:1px solid #ccc;padding:3px 6px;text-align:right;white-space:nowrap}' +
      'th{background:#f0f0f0;font-weight:700}td:first-child,th:first-child{text-align:left}' +
      '.up{color:#1E8E4E}.down{color:#C0392B}.flat,.mute{color:#777}h2{font-size:12px;font-weight:700;margin:10px 0 5px}' +
      (opts.css || '') + '</style></head><body>' + bodyHTML + '</body></html>'
    );
  }
  function printTables(specs, opts) {   // specs = [{title, el}] — print genérico
    const body = (opts && opts.heading ? '<h1>' + opts.heading + '</h1>' : '') +
      (opts && opts.sub ? '<div class="sub">' + opts.sub + '</div>' : '') +
      specs.map(s => (s.title ? '<h2>' + s.title + '</h2>' : '') + (s.el ? s.el.outerHTML : '')).join('');
    printHTML(body, opts);
  }
  // Print que HERDA o CSS da própria página (tabelas saem IGUAIS à dash) + overrides p/ impressão.
  function printStyledTables(specs, opts) {   // specs = [{title, el}]
    opts = opts || {};
    const orient = opts.landscape === false ? 'portrait' : 'landscape';
    const fonts = [].map.call(document.querySelectorAll('link[rel="stylesheet"]'), l => l.outerHTML).join('');
    const styles = [].map.call(document.querySelectorAll('style'), s => '<style>' + s.textContent + '</style>').join('');
    const override = '<style>' +
      'html,body{background:#fff!important;margin:0!important;padding:0!important;overflow:visible!important;height:auto!important;min-height:0!important;width:auto!important;max-width:none!important}' +
      '#stage,.stage,.page,.wrap{transform:none!important;width:auto!important;max-width:none!important;height:auto!important;overflow:visible!important}' +
      '.tbl-scroll,.card{overflow:visible!important;max-height:none!important;box-shadow:none!important;border:none!important;background:transparent!important}' +
      'table.data th{position:static!important}' +
      'table.data{font-size:8.5px!important}' +
      'h1.exp{font:700 16px Inter,Arial,sans-serif;margin:0 0 2px;color:#111}.exp-sub{font:400 11px Inter,Arial,sans-serif;color:#666;margin:0 0 12px}h2.exp{font:700 13px Inter,Arial,sans-serif;margin:14px 0 6px;color:#111}' +
      '@page{size:A4 ' + orient + ';margin:8mm}' +
      '*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}' +
      (opts.css || '') + '</style>';
    const body = (opts.heading ? '<h1 class="exp">' + opts.heading + '</h1>' : '') +
      (opts.sub ? '<div class="exp-sub">' + opts.sub + '</div>' : '') +
      specs.map(s => (s.title ? '<h2 class="exp">' + s.title + '</h2>' : '') + (s.el ? s.el.outerHTML : '')).join('');
    _printDoc('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (opts.title || 'IBBA Research') + '</title>' + fonts + styles + override + '</head><body>' + body + '</body></html>');
  }

  // ── CSS dos controles (injetado 1x; não precisa editar o CSS de cada página) ──
  function injectCSS() {
    if (document.getElementById('ibba-export-css')) return;
    const st = document.createElement('style'); st.id = 'ibba-export-css';
    st.textContent =
      '.ibba-dl{position:absolute;top:6px;right:8px;z-index:8;display:inline-flex;gap:3px;opacity:0;transition:opacity .12s}' +
      '.ibba-host:hover .ibba-dl,.ibba-dl:focus-within,.ibba-dl.show{opacity:1}' +
      '.ibba-tb{display:inline-flex;gap:3px;align-items:center;margin-left:6px}' +
      '.ibba-dl button,.ibba-tb button{font:600 9.5px Arial,Helvetica,sans-serif;letter-spacing:.03em;cursor:pointer;border-radius:6px;' +
      'padding:3px 7px;border:1px solid rgba(128,128,128,.45);background:rgba(127,127,127,.16);color:inherit;line-height:1.2}' +
      '.ibba-dl button{backdrop-filter:blur(2px)}' +
      '.ibba-dl button:hover,.ibba-tb button:hover{border-color:#FF5000;color:#FF5000}' +
      '.ibba-btn{font:600 11px Arial,Helvetica,sans-serif;cursor:pointer;border-radius:7px;padding:6px 12px;' +
      'border:1px solid #FF5000;background:rgba(255,80,0,.12);color:#FF5000}.ibba-btn:hover{background:rgba(255,80,0,.22)}' +
      '@media print{.ibba-dl,.ibba-tb,.ibba-btn{display:none!important}}';
    document.head.appendChild(st);
  }

  // ── botãozinho PNG/XLS por gráfico Chart.js (genérico p/ M&M e P&P) ──
  // opts: {charts, cardSelector, isAdmin, prefix, titleOf}
  //   charts     = registro global {canvasId: ChartInstance}
  //   cardSelector = seletor do "card" que envolve cada <canvas> (default '.chart-card')
  //   titleOf(id, chart) = nome amigável p/ o arquivo (default = id)
  // Percorre os <canvas> do DOM (estáticos) — NÃO o registro — e lê opts.charts[id]
  // AO VIVO no clique (as instâncias Chart.js são recriadas a cada filtro). Idempotente.
  function attachChartjsExports(opts) {
    if (!opts || !opts.isAdmin || !opts.charts) return;
    injectCSS();
    const cardSel = opts.cardSelector || '.chart-card';
    const prefix = opts.prefix || 'chart';
    const canvases = document.querySelectorAll(opts.canvasSelector || (cardSel + ' canvas'));
    canvases.forEach(cv => {
      const id = cv.id; if (!id) return;
      const host = cv.closest(cardSel) || cv.parentElement;
      if (!host || host.querySelector(':scope > .ibba-dl')) return;   // já tem
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.classList.add('ibba-host');
      const cardText = sel => { const e = host.querySelector(sel); return e ? e.textContent.trim() : ''; };
      const ttl = () => (opts.titleOf && opts.titleOf(id)) || cardText('.chart-title') || id;
      const sub = () => cardText('.chart-sub');
      const name = () => safeName(prefix + '_' + ttl() + '_' + stamp());
      const getChart = () => opts.charts[id];
      const box = document.createElement('div'); box.className = 'ibba-dl';
      const bPng = document.createElement('button'); bPng.textContent = 'PNG'; bPng.title = 'Download image';
      const bXls = document.createElement('button'); bXls.textContent = 'XLS'; bXls.title = 'Download data (Excel)';
      bPng.onclick = e => { e.stopPropagation(); e.preventDefault(); const ch = getChart();
        if (!ch || !ch.canvas) return alert('Open/refresh this chart first, then download.');
        pngFromChart(ch, name(), { bg: resolveBg(host), title: ttl(), sub: sub() }); };
      bXls.onclick = e => { e.stopPropagation(); e.preventDefault(); const ch = getChart();
        if (!ch) return alert('Open/refresh this chart first, then download.');
        xlsxFromAOA([{ name: ttl(), aoa: chartToAOA(ch) }], name()).catch(() => alert('Could not build the Excel file.')); };
      box.appendChild(bPng); box.appendChild(bXls);
      host.appendChild(box);
    });
  }

  // ── export de UM gráfico SVG (Market): PNG + dados via callbacks ──
  // opts: {host, svgGetter, aoaGetter, name, isAdmin, sheetName}
  function attachSvgExport(opts) {
    if (!opts || !opts.isAdmin || !opts.host) return;
    injectCSS();
    const host = opts.host;
    if (host.querySelector(':scope > .ibba-dl')) host.querySelector(':scope > .ibba-dl').remove();
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.classList.add('ibba-host');
    const fname = () => safeName((opts.name ? opts.name() : 'chart') + '_' + stamp());
    const box = document.createElement('div'); box.className = 'ibba-dl';
    const bPng = document.createElement('button'); bPng.textContent = 'PNG'; bPng.title = 'Download image';
    const bXls = document.createElement('button'); bXls.textContent = 'XLS'; bXls.title = 'Download data (Excel)';
    bPng.onclick = e => { e.stopPropagation(); e.preventDefault();
      const svg = opts.svgGetter(); if (!svg) return alert('Nothing to export yet.');
      pngFromSVG(svg, fname(), { bg: resolveBg(host) }); };
    bXls.onclick = e => { e.stopPropagation(); e.preventDefault();
      const aoa = opts.aoaGetter && opts.aoaGetter(); if (!aoa || !aoa.length) return alert('No data to export yet.');
      xlsxFromAOA([{ name: opts.sheetName || 'data', aoa: aoa }], fname()).catch(() => alert('Could not build the Excel file.')); };
    box.appendChild(bPng); box.appendChild(bXls);
    host.appendChild(box);
  }

  function makeButton(label, onClick) { injectCSS(); const b = document.createElement('button'); b.className = 'ibba-btn'; b.textContent = label; b.onclick = onClick; return b; }

  // mini-toolbar inline (p/ cabeçalhos de cartão). buttons = [{label,title,onClick}] → <span.ibba-tb>
  function toolbar(buttons) {
    injectCSS();
    const box = document.createElement('span'); box.className = 'ibba-tb';
    buttons.forEach(b => {
      const el = document.createElement('button'); el.textContent = b.label; if (b.title) el.title = b.title;
      el.onclick = ev => { ev.stopPropagation(); ev.preventDefault(); b.onClick(ev); };
      box.appendChild(el);
    });
    return box;
  }
  // helper: alinha várias séries [{name,pts:[[epoch,val]]}] num array-de-arrays (Date × séries)
  function linesAOA(lines, dateHeader) {
    lines = (lines || []).filter(l => l && l.pts && l.pts.length);
    if (!lines.length) return null;
    const tset = new Set(); lines.forEach(l => l.pts.forEach(p => tset.add(p[0])));
    const ts = [...tset].sort((a, b) => a - b);
    const maps = lines.map(l => new Map(l.pts.map(p => [p[0], p[1]])));
    const header = [dateHeader || 'Date'].concat(lines.map(l => l.name || 'series'));
    const rows = ts.map(t => [new Date(t * 1000).toISOString().slice(0, 10)].concat(maps.map(m => { const v = m.get(t); return v == null ? '' : v; })));
    return [header].concat(rows);
  }

  window.IBBAExport = {
    ensureXLSX, downloadCSV, xlsxFromAOA, xlsxFromTables,
    pngFromChart, pngFromSVG, chartToAOA, linesAOA,
    printHTML, printTables, printStyledTables,
    attachChartjsExports, attachSvgExport,
    makeButton, toolbar, injectCSS, stamp, safeName, resolveBg,
  };
})();
