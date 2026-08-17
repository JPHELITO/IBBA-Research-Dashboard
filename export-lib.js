/* =========================================================================
 * export-lib.js — utilitário de EXPORTAÇÃO da IBBA Dashboard.
 * Baixar gráficos (PNG + Excel/CSV), tabelas (Excel), BASES BRUTAS e PDF ("print").
 * Carregado nas 4 páginas (Stock Guide, Steel & Mining, Pulp & Paper, Market).
 * UI em inglês; comentários em PT. Sem dependências obrigatórias: SheetJS é
 * carregado SOB DEMANDA (lazy) só quando alguém pede um Excel.
 * Convenção: quem decide permissão é o CHAMADOR (a lib nunca gateia sozinha).
 *   - Steel & Mining + Pulp & Paper → liberado p/ TODO usuário (2026-08-17).
 *   - Market + Stock Guide          → seguem admin-only no chamador.
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

  // ── ZIP no navegador, sem biblioteca (2026-08-17) ───────────────────────
  // POR QUÊ: baixar N arquivos num clique faz o Chrome perguntar "permitir vários
  // downloads?" — o cliente vê só o 1º chegar e, se negar, o site fica BLOQUEADO
  // p/ downloads automáticos (mata até o Excel depois). Um clique = UM arquivo.
  // Deflate real via CompressionStream (nativo); sem ele, entra como "stored".
  const _CRC_T = (() => { const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t; })();
  function _crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = _CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  async function _deflateRaw(u8) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch (e) { return null; }
  }
  function _dosTime(d) {
    return { t: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF,
             d: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF };
  }
  // files = [{name, data:Uint8Array|string}] → Blob de um .zip válido
  async function zipBlob(files, onProgress) {
    const enc = new TextEncoder(), now = _dosTime(new Date());
    const parts = [], central = []; let offset = 0, i = 0;
    for (const f of files) {
      if (onProgress) onProgress(++i, files.length, f.name);
      const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const nameB = enc.encode(f.name);
      const crc = _crc32(raw);
      const def = await _deflateRaw(raw);
      const useDef = !!def && def.length < raw.length;
      const body = useDef ? def : raw, method = useDef ? 8 : 0;

      const lh = new Uint8Array(30 + nameB.length), lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, method, true); lv.setUint16(10, now.t, true); lv.setUint16(12, now.d, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, raw.length, true);
      lv.setUint16(26, nameB.length, true); lv.setUint16(28, 0, true);
      lh.set(nameB, 30);

      const ch = new Uint8Array(46 + nameB.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
      cv.setUint16(12, now.t, true); cv.setUint16(14, now.d, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, raw.length, true);
      cv.setUint16(28, nameB.length, true); cv.setUint32(42, offset, true);
      ch.set(nameB, 46);

      parts.push(lh, body); central.push(ch);
      offset += lh.length + body.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }
  function csvText(aoa) { return '﻿' + aoa.map(r => r.map(csvCell).join(',')).join('\r\n'); }

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
  // opts: {charts, cardSelector, prefix, titleOf, fullAOA}
  //   charts     = registro global {canvasId: ChartInstance}
  //   cardSelector = seletor do "card" que envolve cada <canvas> (default '.chart-card')
  //   titleOf(id, chart) = nome amigável p/ o arquivo (default = id)
  //   fullAOA(id) = matriz com o HISTÓRICO INTEIRO daquele gráfico (opcional).
  //       Quando existe, o XLS ignora a janela (3M/1Y/YTD…) e baixa a série toda —
  //       o PNG continua saindo IGUAL à tela (decisão do usuário, 2026-08-17).
  //   alwaysVisible = botões SEMPRE à vista, em vez de aparecerem no hover.
  //       Ligado em M&M/P&P: o hover vinha da época admin-only e o cliente,
  //       que não sabe que o download existe, nunca ia passar o mouse p/ achar.
  // Percorre os <canvas> do DOM (estáticos) — NÃO o registro — e lê opts.charts[id]
  // AO VIVO no clique (as instâncias Chart.js são recriadas a cada filtro). Idempotente.
  function attachChartjsExports(opts) {
    if (!opts || !opts.charts) return;   // permissão é decidida pelo chamador
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
      const box = document.createElement('div'); box.className = 'ibba-dl' + (opts.alwaysVisible ? ' show' : '');
      const bPng = document.createElement('button'); bPng.textContent = 'PNG'; bPng.title = 'Download image (as shown)';
      const bXls = document.createElement('button'); bXls.textContent = 'XLS';
      bXls.title = opts.fullAOA ? 'Download data (Excel) — full history' : 'Download data (Excel)';
      bPng.onclick = e => { e.stopPropagation(); e.preventDefault(); const ch = getChart();
        if (!ch || !ch.canvas) return alert('Open/refresh this chart first, then download.');
        pngFromChart(ch, name(), { bg: resolveBg(host), title: ttl(), sub: sub() }); };
      bXls.onclick = e => { e.stopPropagation(); e.preventDefault();
        // histórico máximo quando a página souber gerar (fullAOA); senão, o que está na tela
        let aoa = null;
        if (opts.fullAOA) { try { aoa = opts.fullAOA(id); } catch (err) { console.warn('fullAOA falhou, usando a janela em tela:', err); } }
        if (!aoa || aoa.length < 2) { const ch = getChart(); aoa = ch ? chartToAOA(ch) : null; }
        if (!aoa || aoa.length < 2) return alert('Open/refresh this chart first, then download.');
        xlsxFromAOA([{ name: ttl(), aoa: aoa }], name()).catch(() => alert('Could not build the Excel file.')); };
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

  // ══════════════════════════════════════════════════════════════════════
  //  BASE BRUTA — modal "Download data" (2026-08-17)
  //  Pedido do usuário: o cliente poder usar a dashboard como DOWNLOADER —
  //  baixar a tabela inteira do jeito que ela está no banco (ex.: SECEX de
  //  importação COMPLETO), não só o recorte que virou gráfico.
  // ══════════════════════════════════════════════════════════════════════
  /* Excel × CSV — MEDIDO no browser (SheetJS é SÍNCRONO: enquanto escreve, a aba morre).
       10 mil linhas → 0,4 s / 3 MB      50 mil → 2,1 s / 15 MB
      100 mil linhas → 4,2 s / 30 MB    272 mil (secex_country) → 27 s / 84 MB
      as 11 tabelas juntas (285 mil) → **178 s** e 88 MB  ← o usuário desistiu, com razão
     Ou seja: até ~100 mil é linear e rápido; acima disso desanda (GC segurando as 11
     planilhas + a saída ao mesmo tempo). Por isso o Excel é TRAVADO no teto abaixo e a
     base grande sai em CSV — que faz as mesmas 272 mil linhas em 0,8 s e abre no Excel
     igual. ⚠️ Não subir esse teto sem MEDIR de novo: a curva não é linear no topo. */
  const RAW_EXCEL_MAX = 100000;
  function _int(n) { return Number(n || 0).toLocaleString('en-US'); }
  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function injectRawCSS() {
    if (document.getElementById('ibba-raw-css')) return;
    const st = document.createElement('style'); st.id = 'ibba-raw-css';
    st.textContent =
      '.ibba-ov{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Inter,Arial,Helvetica,sans-serif}' +
      '.ibba-mod{background:#fff;color:#111;border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.3);width:min(680px,100%);max-height:min(86vh,760px);display:flex;flex-direction:column;overflow:hidden}' +
      '.ibba-mod h3{margin:0;font-size:14px;font-weight:700;letter-spacing:.02em}' +
      '.ibba-mh{padding:16px 18px 12px;border-bottom:1px solid #E5E7EB;position:relative}' +
      '.ibba-mh .ibba-msub{font-size:11px;color:#6B7280;margin-top:4px;line-height:1.5}' +
      '.ibba-x{position:absolute;top:11px;right:12px;border:none;background:transparent;font-size:19px;line-height:1;cursor:pointer;color:#9CA3AF;padding:2px 6px}' +
      '.ibba-x:hover{color:#FF5000}' +
      '.ibba-mb{overflow:auto;padding:6px 8px 6px 8px;flex:1}' +
      '.ibba-row{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-radius:7px;cursor:pointer}' +
      '.ibba-row:hover{background:rgba(255,80,0,.06)}' +
      '.ibba-row input{margin:2px 0 0;accent-color:#FF5000;cursor:pointer;flex:none}' +
      '.ibba-rt{font-size:12px;font-weight:600}' +
      '.ibba-rn{font-size:10.5px;color:#6B7280;margin-top:2px;line-height:1.45}' +
      '.ibba-rc{margin-left:auto;font-size:10.5px;color:#6B7280;white-space:nowrap;padding-top:1px}' +
      '.ibba-mf{border-top:1px solid #E5E7EB;padding:12px 18px 14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}' +
      '.ibba-mf .ibba-sel{font-size:10.5px;color:#6B7280;margin-right:auto}' +
      '.ibba-mf .ibba-lnk{border:none;background:transparent;color:#FF5000;font:600 10.5px Inter,Arial,sans-serif;cursor:pointer;padding:0 2px}' +
      '.ibba-fmt{display:inline-flex;border:1px solid #D1D5DB;border-radius:7px;overflow:hidden}' +
      '.ibba-fmt button{border:none;background:transparent;font:600 10.5px Inter,Arial,sans-serif;padding:6px 12px;cursor:pointer;color:#6B7280}' +
      '.ibba-fmt button.on{background:#FF5000;color:#fff}' +
      '.ibba-fmt button.off{opacity:.4;text-decoration:line-through}' +   // Excel indisponível: linhas demais
      '.ibba-fmt button.off.on{background:#B45309;color:#fff;text-decoration:line-through}' +
      '.ibba-go{border:1px solid #FF5000;background:#FF5000;color:#fff;font:700 11px Inter,Arial,sans-serif;border-radius:7px;padding:7px 16px;cursor:pointer}' +
      '.ibba-go:disabled{opacity:.55;cursor:default}' +
      '.ibba-st{width:100%;font-size:10.5px;color:#6B7280;min-height:14px;line-height:1.45}' +
      '.ibba-st.warn{color:#B45309}.ibba-st.err{color:#C0392B}' +
      'html.dark .ibba-mod{background:#161B22;color:#E6EDF3}' +
      'html.dark .ibba-mh,html.dark .ibba-mf{border-color:#30363D}' +
      'html.dark .ibba-mh .ibba-msub,html.dark .ibba-rn,html.dark .ibba-rc,html.dark .ibba-sel,html.dark .ibba-st{color:#9DA7B3}' +
      'html.dark .ibba-fmt{border-color:#30363D}html.dark .ibba-fmt button{color:#9DA7B3}html.dark .ibba-fmt button.on{color:#fff}' +
      'html.dark .ibba-row:hover{background:rgba(255,80,0,.14)}' +
      '@media print{.ibba-ov{display:none!important}}';
    document.head.appendChild(st);
  }

  // opts: {title, sub, prefix, tables:[{name,label,note,rows}], load(name)->Promise<AOA>, onClose}
  //   load(name) devolve a matriz [cabeçalho, ...linhas] da tabela inteira.
  function rawDataPanel(opts) {
    injectCSS(); injectRawCSS();
    const tables = (opts.tables || []).filter(Boolean);
    const picked = new Set(tables.map(t => t.name));   // começa tudo marcado = "a base completa"
    const _totalRows = tables.reduce((s, t) => s + (t.rows || 0), 0);
    let fmt = _totalRows > RAW_EXCEL_MAX ? 'csv' : 'xlsx';   // base grande abre em CSV (ver nota acima)
    let busy = false;

    const ov = document.createElement('div'); ov.className = 'ibba-ov';
    ov.innerHTML =
      '<div class="ibba-mod" role="dialog" aria-modal="true" aria-label="Download data">' +
        '<div class="ibba-mh"><h3>' + _esc(opts.title || 'Download data') + '</h3>' +
          '<div class="ibba-msub">' + _esc(opts.sub || '') + '</div>' +
          '<button class="ibba-x" title="Close">×</button></div>' +
        '<div class="ibba-mb"></div>' +
        '<div class="ibba-mf">' +
          '<span class="ibba-sel"></span>' +
          '<button class="ibba-lnk" data-all="1">Select all</button>' +
          '<button class="ibba-lnk" data-all="0">Clear</button>' +
          '<span class="ibba-fmt"><button data-fmt="xlsx"' + (fmt === 'xlsx' ? ' class="on"' : '') + '>Excel (.xlsx)</button>' +
            '<button data-fmt="csv"' + (fmt === 'csv' ? ' class="on"' : '') + '>CSV (.zip)</button></span>' +
          '<button class="ibba-go">⤓ Download</button>' +
          '<div class="ibba-st"></div>' +
        '</div>' +
      '</div>';

    const body = ov.querySelector('.ibba-mb'), selInfo = ov.querySelector('.ibba-sel');
    const stEl = ov.querySelector('.ibba-st'), goBtn = ov.querySelector('.ibba-go');
    // `keep` = mensagem final (Done/erro) que o refresh() NÃO pode apagar — senão o
    // "Done" nasce e morre no mesmo instante e o usuário não vê nada acontecer.
    let sticky = false;
    const status = (msg, cls, keep) => { sticky = !!keep; stEl.className = 'ibba-st' + (cls ? ' ' + cls : ''); stEl.textContent = msg || ''; };
    const touch = () => { sticky = false; refresh(); };   // interação do usuário limpa a mensagem final

    tables.forEach(t => {
      const lab = document.createElement('label'); lab.className = 'ibba-row';
      lab.innerHTML = '<input type="checkbox" checked>' +
        '<span><span class="ibba-rt">' + _esc(t.label || t.name) + '</span>' +
        (t.note ? '<div class="ibba-rn">' + _esc(t.note) + '</div>' : '') + '</span>' +
        '<span class="ibba-rc">' + _int(t.rows) + ' rows</span>';
      const cb = lab.querySelector('input');
      cb.onchange = () => { cb.checked ? picked.add(t.name) : picked.delete(t.name); touch(); };
      lab.dataset.tbl = t.name;
      body.appendChild(lab);
    });

    function selected() { return tables.filter(t => picked.has(t.name)); }
    function refresh() {
      const sel = selected(), rows = sel.reduce((s, t) => s + (t.rows || 0), 0);
      const tooBig = fmt === 'xlsx' && rows > RAW_EXCEL_MAX;
      selInfo.textContent = sel.length + ' of ' + tables.length + ' selected · ' + _int(rows) + ' rows';
      goBtn.disabled = busy || !sel.length || tooBig;
      ov.querySelector('[data-fmt="xlsx"]').classList.toggle('off', rows > RAW_EXCEL_MAX);
      if (!busy && !sticky) {
        if (tooBig)
          status(_int(rows) + ' rows is too much for Excel in the browser — it would freeze this tab for minutes. ' +
                 'Switch to CSV (.zip): same data, seconds instead of minutes, and every file opens in Excel.', 'warn');
        else status('');
      }
    }
    ov.querySelectorAll('[data-all]').forEach(b => b.onclick = () => {
      const on = b.dataset.all === '1';
      tables.forEach(t => on ? picked.add(t.name) : picked.delete(t.name));
      body.querySelectorAll('input').forEach(i => i.checked = on);
      touch();
    });
    ov.querySelectorAll('[data-fmt]').forEach(b => b.onclick = () => {
      fmt = b.dataset.fmt;
      ov.querySelectorAll('[data-fmt]').forEach(x => x.classList.toggle('on', x === b));
      touch();
    });

    function close() { if (busy) return; ov.remove(); document.removeEventListener('keydown', onKey); if (opts.onClose) opts.onClose(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.querySelector('.ibba-x').onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    document.addEventListener('keydown', onKey);

    goBtn.onclick = async () => {
      const sel = selected(); if (!sel.length || busy) return;
      busy = true; goBtn.disabled = true;
      const base = safeName((opts.prefix || 'data') + '_' + stamp());
      try {
        // Uma tabela por vez, cedendo o fio entre elas → a mensagem PINTA e o usuário
        // vê onde está (com tudo de uma vez, a tela congelava sem explicação).
        // ⚠️ SEMPRE UM ARQUIVO SÓ no fim — ver a nota do zipBlob.
        if (fmt === 'xlsx') {
          const X = await ensureXLSX();
          const wb = X.utils.book_new();
          let i = 0;
          for (const t of sel) {
            status('Reading ' + (t.label || t.name) + '… (' + (++i) + '/' + sel.length + ')'); await _sleep(0);
            X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(await opts.load(t.name)), sheetName(t.name));
          }
          status('Writing the Excel file — the tab freezes for a moment…'); await _sleep(40);
          X.writeFile(wb, safeName(base) + '.xlsx');
        } else if (sel.length === 1) {
          status('Reading ' + (sel[0].label || sel[0].name) + '…'); await _sleep(0);
          downloadCSV(await opts.load(sel[0].name), safeName((opts.prefix || 'data') + '_' + sel[0].name + '_' + stamp()));
        } else {
          const files = []; let i = 0;
          for (const t of sel) {
            status('Reading ' + (t.label || t.name) + '… (' + (++i) + '/' + sel.length + ')'); await _sleep(0);
            files.push({ name: t.name + '.csv', data: csvText(await opts.load(t.name)) });
          }
          const zip = await zipBlob(files, (n, tot, nm) => status('Zipping ' + nm + '… (' + n + '/' + tot + ')'));
          downloadBlob(zip, safeName(base) + '.zip');
        }
        status('Done — check your downloads folder.', '', true);
      } catch (e) {
        console.error(e);
        status('Could not build the file: ' + (e && e.message ? e.message : e), 'err', true);
      } finally { busy = false; refresh(); }
    };

    refresh();
    document.body.appendChild(ov);
    return { close: close, el: ov };
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
    ensureXLSX, downloadCSV, xlsxFromAOA, xlsxFromTables, zipBlob, csvText,
    pngFromChart, pngFromSVG, chartToAOA, linesAOA,
    printHTML, printTables, printStyledTables,
    attachChartjsExports, attachSvgExport, rawDataPanel,
    makeButton, toolbar, injectCSS, stamp, safeName, resolveBg,
  };
})();
