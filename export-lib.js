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

  // ── PNG de um gráfico Chart.js (compõe sobre o fundo p/ não sair transparente) ──
  function pngFromChart(chart, filename, bg) {
    const src = chart.canvas;
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = bg || resolveBg(src.parentElement || src) || '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0);
    c.toBlob(b => downloadBlob(b, safeName(filename) + '.png'), 'image/png');
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
      const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
      const ctx = c.getContext('2d');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.drawImage(img, 0, 0, w, h);
      c.toBlob(b => downloadBlob(b, safeName(filename) + '.png'), 'image/png');
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

  // ── "Print"/PDF: abre um iframe oculto com um doc limpo e chama print()
  //    (o usuário escolhe "Salvar como PDF"). Sem dependência. ──
  function printHTML(bodyHTML, opts) {
    opts = opts || {};
    const title = opts.title || 'IBBA Research — Export';
    const orient = opts.landscape === false ? 'portrait' : 'landscape';
    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(ifr);
    const doc = ifr.contentWindow.document;
    doc.open();
    doc.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' +
      '@page{size:A4 ' + orient + ';margin:10mm}' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'h1{font-size:15px;margin:0 0 2px}.sub{font-size:10px;color:#666;margin:0 0 12px}' +
      'table{border-collapse:collapse;width:100%;font-size:9.5px;margin:0 0 16px;page-break-inside:auto}' +
      'tr{page-break-inside:avoid}th,td{border:1px solid #ccc;padding:3px 6px;text-align:right;white-space:nowrap}' +
      'th{background:#f0f0f0;font-weight:700}td:first-child,th:first-child{text-align:left}' +
      '.up{color:#1E8E4E}.down{color:#C0392B}.flat,.mute{color:#777}' +
      'caption,h2{font-size:12px;font-weight:700;text-align:left;margin:10px 0 5px;padding:0}' +
      (opts.css || '') + '</style></head><body>' + bodyHTML + '</body></html>'
    );
    doc.close();
    const go = () => { try { ifr.contentWindow.focus(); ifr.contentWindow.print(); } catch (e) {} setTimeout(() => ifr.remove(), 1500); };
    if (doc.readyState === 'complete') setTimeout(go, 200); else ifr.onload = () => setTimeout(go, 200);
  }
  // Print a partir de tabelas HTML existentes (clona o conteúdo, com um título por tabela).
  function printTables(specs, opts) {   // specs = [{title, el}]
    const body = (opts && opts.heading ? '<h1>' + opts.heading + '</h1>' : '') +
      (opts && opts.sub ? '<div class="sub">' + opts.sub + '</div>' : '') +
      specs.map(s => (s.title ? '<h2>' + s.title + '</h2>' : '') + (s.el ? s.el.outerHTML : '')).join('');
    printHTML(body, opts);
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
      const title = () => (opts.titleOf && opts.titleOf(id)) || id;
      const name = () => safeName(prefix + '_' + title() + '_' + stamp());
      const getChart = () => opts.charts[id];
      const box = document.createElement('div'); box.className = 'ibba-dl';
      const bPng = document.createElement('button'); bPng.textContent = 'PNG'; bPng.title = 'Download image';
      const bXls = document.createElement('button'); bXls.textContent = 'XLS'; bXls.title = 'Download data (Excel)';
      bPng.onclick = e => { e.stopPropagation(); e.preventDefault(); const ch = getChart();
        if (!ch || !ch.canvas) return alert('Open/refresh this chart first, then download.'); pngFromChart(ch, name(), resolveBg(host)); };
      bXls.onclick = e => { e.stopPropagation(); e.preventDefault(); const ch = getChart();
        if (!ch) return alert('Open/refresh this chart first, then download.');
        xlsxFromAOA([{ name: title(), aoa: chartToAOA(ch) }], name()).catch(() => alert('Could not build the Excel file.')); };
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
    printHTML, printTables,
    attachChartjsExports, attachSvgExport,
    makeButton, toolbar, injectCSS, stamp, safeName, resolveBg,
  };
})();
