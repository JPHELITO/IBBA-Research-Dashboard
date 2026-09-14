/* ═══════════════════════════════════════════════════════════════════════════════
   quarterly-lib.js — motor do importador de modelos trimestrais e da página Quarterly.
   Expõe window.QL (UMD). Não depende de nada: quem lê o .xlsx é o SheetJS (no /admin), e este
   arquivo só enxerga uma "planilha" abstrata {maxR, maxC, hiddenCols, get(r,c)} — por isso os
   testes montam planilhas sintéticas sem Excel nenhum (tests/test_quarterly_lib.html).

   ⚠️ AS 3 REGRAS QUE O RAIO-X DOS 13 MODELOS IMPÔS (14/09/2026):
   1. TRIMESTRE POR SEQUÊNCIA, NUNCA PELO TEXTO DO CABEÇALHO. 5 dos 13 modelos rotulam o 2Q26
      errado (CSN/CMIN '2Q25a', Irani '2Q25', GMEX/Copec '1Q26a') e 2 rotulam realizado com 'E'
      (Ternium, Aura). O rótulo vira só aviso; quem garante o alinhamento é a IMPRESSÃO DIGITAL
      (receita × CVM/SEC, câmbio × PTAX, ou o número do release digitado no /admin).
   2. LINHA = SEÇÃO + RÓTULO + UNIDADE. Rótulo sozinho repete (Dom. Mkt 4× na CSN, Nickel 13× na
      Vale). A indentação da célula NÃO serve de pista: o SheetJS do navegador não lê estilo.
   3. O QUE PASSA DO CORTE NÃO SAI DAQUI. Projeção é IP do analista: a coluna nem é lida. O servidor
      recusa de novo (admin_quarterly_chunk), mas a primeira trava é esta.
   E uma de licença: linha com cara de preço PAGO (PIX, FOEX, Platts, LME, "discount to spot")
   bloqueia a série, mesmo que alguém a declare no manifesto por engano.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  // ── trimestres ────────────────────────────────────────────────────────────────
  const Q_HDR = /^([1-4])[QT](\d{2})[aAeE]?$/;          // '2Q26', '2Q26a', '2T26', '3Q26E'
  const Q_KEY = /^(\d{4})Q([1-4])$/;                    // '2026Q2'
  const ANNUAL = /^(?:FY)?(?:19|20)\d{2}[aAeE]?$/i;      // '2025', '2025a', '2026E', 'FY2025'

  function qFromHeader(t) {
    const m = Q_HDR.exec(String(t == null ? '' : t).trim());
    return m ? (2000 + Number(m[2])) + 'Q' + m[1] : null;
  }
  function qIdx(q) { const m = Q_KEY.exec(q || ''); return m ? Number(m[1]) * 4 + Number(m[2]) - 1 : NaN; }
  function qFromIdx(i) { return Math.floor(i / 4) + 'Q' + (i % 4 + 1); }
  function qAdd(q, n) { return qFromIdx(qIdx(q) + n); }
  function isQKey(q) { return Q_KEY.test(q || ''); }
  // São Paulo não tem horário de verão desde 2019 → UTC−3 fixo basta
  function qCurrent(d) {
    const t = new Date((d || new Date()).getTime() - 3 * 3600e3);
    return t.getUTCFullYear() + 'Q' + (Math.floor(t.getUTCMonth() / 3) + 1);
  }
  function qShort(q) { const m = Q_KEY.exec(q || ''); return m ? m[2] + 'Q' + m[1].slice(2) : String(q || ''); }

  // ── células ───────────────────────────────────────────────────────────────────
  function colIdx(letters) {
    let n = 0;
    for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  function colName(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function normLabel(s) { return String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
  function cellText(cell) {
    if (!cell) return '';
    if (cell.w != null && cell.t !== 'n') return normLabel(cell.w);
    return normLabel(cell.v);
  }
  // texto que o analista usa para "não tem": vira vazio, NUNCA zero
  const NULLISH = /^(?:-+|—|–|n\.?\s?a\.?|n\/a|na|n\.?m\.?|nm|#ref!|#n\/a|#div\/0!|#value!|#name\?|#num!|#null!|\.)$/i;
  function cellNum(cell) {
    if (!cell) return { v: null, why: null };
    if (cell.t === 'e') return { v: null, why: 'error' };
    const v = cell.v;
    if (typeof v === 'number') return isFinite(v) ? { v: v, why: null } : { v: null, why: 'nan' };
    if (v == null || typeof v === 'boolean') return { v: null, why: null };
    const s = normLabel(v);
    if (!s) return { v: null, why: null };
    if (NULLISH.test(s)) return { v: null, why: 'text' };
    const m = /^\(?(-?[\d,]*\.?\d+)\)?(%)?$/.exec(s.replace(/\s/g, ''));
    if (m) {
      let n = parseFloat(m[1].replace(/,/g, ''));
      if (s.charAt(0) === '(') n = -Math.abs(n);
      if (m[2]) n /= 100;
      return isFinite(n) ? { v: n, why: 'textnum' } : { v: null, why: 'text' };
    }
    return { v: null, why: 'text' };
  }
  // D = digitado · K = fórmula só com constantes (=1029-124) · F = fórmula com referência
  function formulaKind(cell) {
    if (!cell) return '';
    if (!cell.f) return 'D';
    return /(?:^|[^A-Za-z_])\$?[A-Z]{1,3}\$?\d+|!/.test(String(cell.f)) ? 'F' : 'K';
  }
  function round(x) {
    const a = Math.abs(x);
    if (a >= 100) return Number(x.toFixed(2));
    if (a >= 1) return Number(x.toFixed(4));
    return Number(x.toPrecision(6));
  }

  // ── planilhas: SheetJS e sintética ────────────────────────────────────────────
  function fromSheetJS(ws) {
    const ref = (ws && ws['!ref']) || 'A1:A1';
    const end = /([A-Z]+)(\d+)$/.exec(ref.split(':').pop());
    const hidden = new Set();
    ((ws && ws['!cols']) || []).forEach(function (c, i) { if (c && c.hidden) hidden.add(i + 1); });
    return {
      maxR: end ? Number(end[2]) : 1, maxC: end ? colIdx(end[1]) : 1, hiddenCols: hidden,
      get: function (r, c) { return (ws && ws[colName(c) + r]) || null; }
    };
  }
  function bookFromSheetJS(wb) {
    return { sheetNames: (wb.SheetNames || []).slice(), sheet: function (n) { return fromSheetJS(wb.Sheets[n]); } };
  }
  // rows[r-1][c-1] = número | texto | {v, f, t, w}
  function gridSheet(rows, opts) {
    const maxC = rows.reduce(function (m, r) { return Math.max(m, (r || []).length); }, 0);
    return {
      maxR: rows.length, maxC: maxC, hiddenCols: new Set((opts && opts.hiddenCols) || []),
      get: function (r, c) {
        const row = rows[r - 1]; if (!row) return null;
        const x = row[c - 1];
        if (x == null || x === '') return null;
        if (typeof x === 'object') return x;
        return { v: x, t: typeof x === 'number' ? 'n' : 's' };
      }
    };
  }
  function gridBook(sheets) {
    return { sheetNames: Object.keys(sheets), sheet: function (n) { return sheets[n]; } };
  }

  // ── avisos da prévia ──────────────────────────────────────────────────────────
  // block = não publica · warn = o admin precisa marcar que viu · info = só registro
  function makeChecks() {
    const list = [];
    const add = function (level) {
      return function (code, msg, extra) { list.push(Object.assign({ level: level, code: code, msg: msg }, extra || {})); };
    };
    return { list: list, block: add('block'), warn: add('warn'), info: add('info') };
  }

  // ── guardas de licença ────────────────────────────────────────────────────────
  const PAID_SHEET = /foex|\bpix\b|fastmarkets|platts|price model|realiza[cç][aã]o|hrc prices|prices x/i;
  const PAID_RE = /\b(?:pix|foex|platts|lme|fastmarkets|comex)\b|list price|discount to|premium to|spot price|\bspread\b|\bindex\b|consensus|guidance|benchmark|reference price/i;
  // ⚠️ normaliza separadores antes de testar: em JS o "_" é caractere de palavra, então \bpix\b NÃO
  // casa "pulp.pix_china" — e é exatamente o formato das chaves. O servidor (_q_is_denied) já trata
  // "_" e "." como separador; aqui fica igual.
  const PAID_LABEL = { test: function (t) { return PAID_RE.test(String(t == null ? '' : t).replace(/[._\-\/]+/g, ' ')); } };

  // ── catálogo de métricas comparáveis ──────────────────────────────────────────
  // src = de onde a PÁGINA pega a série, em ordem (ver o plano, seção 3). 'filed' = CVM/SEC.
  const STD = {
    revenue:         { en: 'Net revenue',           kind: 'money',  agg: 'flow',  src: ['model', 'filed'] },
    adj_ebitda:      { en: 'Adjusted EBITDA',       kind: 'money',  agg: 'flow',  src: ['model'] },
    net_income:      { en: 'Net income',            kind: 'money',  agg: 'flow',  src: ['filed', 'model'] },
    net_debt:        { en: 'Net debt',              kind: 'money',  agg: 'stock', src: ['model', 'filed'] },
    d_a:             { en: 'D&A',                   kind: 'money',  agg: 'flow',  src: ['filed', 'model'] },
    ebit:            { en: 'EBIT',                  kind: 'money',  agg: 'flow',  src: ['model', 'filed'] },
    capex:           { en: 'Capex',                 kind: 'money',  agg: 'flow',  src: ['filed', 'model'] },
    ocf:             { en: 'Operating cash flow',   kind: 'money',  agg: 'flow',  src: ['filed'] },
    sales_volume:    { en: 'Sales volume',          kind: 'volume', agg: 'flow',  src: ['model'] },
    production:      { en: 'Production',            kind: 'volume', agg: 'flow',  src: ['model'] },
    realized_price:  { en: 'Realized price',        kind: 'price',  agg: 'rate',  src: ['model'] },
    cash_cost:       { en: 'Cash cost',             kind: 'cost',   agg: 'rate',  src: ['model'] },
    segment_revenue: { en: 'Revenue by segment',    kind: 'money',  agg: 'flow',  src: ['model'] },
    segment_ebitda:  { en: 'EBITDA by segment',     kind: 'money',  agg: 'flow',  src: ['model'] },
    fx_avg:          { en: 'FX (average)',          kind: 'fx',     agg: 'rate',  src: ['model'] },
    fx_eop:          { en: 'FX (end of period)',    kind: 'fx',     agg: 'stock', src: ['model'] }
  };
  // séries em que fórmula com constante (=1029-124) vira pedido de revisão na prévia
  const FLAG_ADJ = new Set(['revenue', 'adj_ebitda', 'net_income', 'net_debt', 'segment_ebitda']);

  function unitCcy(u) {
    const m = /^(BRL|USD|CLP|MXN)(?:_|\/)/.exec(u || '');
    return m ? m[1] : null;
  }

  // ── colunas: layout 'cols' ────────────────────────────────────────────────────
  function detectHeaderRow(sheet) {
    let best = 0, bestN = 0;
    for (let r = 1; r <= Math.min(40, sheet.maxR); r++) {
      let n = 0;
      for (let c = 1; c <= sheet.maxC; c++) if (Q_HDR.test(cellText(sheet.get(r, c)))) n++;
      if (n > bestN) { best = r; bestN = n; }
    }
    return best;
  }
  function resolveCols(sheet, sh, cutoff, checks) {
    const hr = sh.headerRow || detectHeaderRow(sheet);
    if (!hr) { checks.block('no_header', 'Não achei a linha dos trimestres na aba.'); return null; }
    let c0 = sh.firstCol ? colIdx(sh.firstCol) : 0;
    if (!c0) {
      for (let c = 1; c <= sheet.maxC; c++) if (Q_HDR.test(cellText(sheet.get(hr, c)))) { c0 = c; break; }
    }
    if (!c0) { checks.block('no_first_col', 'Não achei a primeira coluna de trimestre.', { row: hr }); return null; }
    const lab0 = qFromHeader(cellText(sheet.get(hr, c0)));
    if (lab0 && lab0 !== sh.firstQ) {
      checks.warn('first_q_label', 'A 1ª coluna (' + colName(c0) + ') está rotulada ' + qShort(lab0) +
        ', mas o manifesto começa em ' + qShort(sh.firstQ) + '.', { cell: colName(c0) + hr });
    }
    const cols = [], skipped = [];
    let k = 0, blanks = 0;
    for (let c = c0; c <= sheet.maxC; c++) {
      const cell = sheet.get(hr, c), t = cellText(cell);
      if (Q_HDR.test(t)) {
        const q = qAdd(sh.firstQ, k++);
        if (qIdx(q) > qIdx(cutoff)) break;            // daqui para a frente é projeção: nem lê
        cols.push({ c: c, q: q, label: t, hidden: sheet.hiddenCols.has(c) });
        blanks = 0;
        continue;
      }
      if (ANNUAL.test(t) || (cell && typeof cell.v === 'number' && cell.v > 1900 && cell.v < 2100)) {
        skipped.push({ c: c, t: t, kind: 'annual' }); blanks = 0; continue;
      }
      skipped.push({ c: c, t: t, kind: t ? 'other' : 'blank' });
      if (!t && ++blanks > (sh.maxBlankRun || 4)) break;
    }
    const mism = cols.filter(function (x) { const h = qFromHeader(x.label); return h && h !== x.q; });
    if (mism.length) {
      const last = cols[cols.length - 1];
      const noCorte = mism.some(function (x) { return last && x.q === last.q; });
      checks[noCorte ? 'warn' : 'info']('header_mismatch',
        'Rótulo de trimestre diferente da sequência em ' + mism.length + ' coluna(s): ' +
        mism.slice(0, 6).map(function (x) { return colName(x.c) + ' diz ' + x.label + ' = ' + qShort(x.q); }).join(' · ') +
        (mism.length > 6 ? ' …' : '') + '. Vale a sequência; a impressão digital confere.');
    }
    // realizado rotulado como projeção ('2Q26E' na coluna do corte). Se a coluna anterior também tem
    // "E", é costume do modelo (Ternium, Aura) e só fica registrado; se o "E" começa no corte, o
    // próprio modelo ainda trata o trimestre como projeção → o admin confirma.
    const ult = cols[cols.length - 1];
    if (ult && ult.q === cutoff && /[eE]$/.test(ult.label)) {
      const ant = cols[cols.length - 2];
      const costume = !!(ant && /[eE]$/.test(ant.label));
      checks[costume ? 'info' : 'warn']('cutoff_label_estimate',
        'A coluna do corte (' + colName(ult.c) + ') está rotulada ' + ult.label + (costume
          ? ' — este modelo marca realizado com "E"; vale a impressão digital.'
          : ' — o modelo ainda trata ' + qShort(cutoff) + ' como projeção. Confirme que o trimestre já foi entregue.'),
        { cell: colName(ult.c) + hr });
    }
    const hid = cols.filter(function (x) { return x.hidden; });
    if (hid.length) checks.info('hidden_cols', hid.length + ' coluna(s) de trimestre oculta(s) foram lidas (' +
      hid.slice(0, 4).map(function (x) { return colName(x.c); }).join(', ') + ').');
    return { headerRow: hr, cols: cols, skipped: skipped };
  }

  // ── seções e linhas ───────────────────────────────────────────────────────────
  function readRows(sheet, sh) {
    const L = colIdx(sh.labelCol || 'B'), U = sh.unitCol ? colIdx(sh.unitCol) : 0;
    const rows = [];
    for (let r = 1; r <= sheet.maxR; r++) {
      rows.push({ r: r, label: cellText(sheet.get(r, L)), unit: U ? cellText(sheet.get(r, U)) : '' });
    }
    return rows;
  }
  function resolveSections(rows, sh, maxR, checks) {
    const out = {};
    let from = 1;
    const found = [];
    (sh.sections || []).forEach(function (pair) {
      const key = pair[0], re = pair[1];
      const hit = rows.find(function (x) { return x.r >= from && re.test(x.label); });
      if (!hit) { checks.block('section_not_found', 'Seção "' + key + '" não encontrada (' + re + ').'); out[key] = null; return; }
      out[key] = { key: key, start: hit.r };
      found.push(out[key]);
      from = hit.r + 1;
    });
    found.sort(function (a, b) { return a.start - b.start; })
      .forEach(function (s, i, arr) { s.end = i + 1 < arr.length ? arr[i + 1].start - 1 : maxR; });
    return out;
  }
  function resolveRow(rows, secs, rule, maxR, checks) {
    const sec = rule.sec ? secs[rule.sec] : { start: 1, end: maxR };
    if (!sec) return null;                         // seção ausente já bloqueou
    let cands = rows.filter(function (x) {
      return x.r >= sec.start && x.r <= sec.end && rule.lab.test(x.label) && (!rule.unit || rule.unit.test(x.unit));
    });
    if (rule.after) {
      const a = rows.find(function (x) { return x.r >= sec.start && x.r <= sec.end && rule.after.test(x.label); });
      cands = a ? cands.filter(function (x) { return x.r > a.r; }) : [];
    }
    if (rule.nth != null) cands = cands[rule.nth] ? [cands[rule.nth]] : [];
    if (!cands.length) {
      checks[rule.req ? 'block' : 'warn']('row_not_found',
        'Linha "' + rule.k + '" não encontrada' + (rule.sec ? ' na seção ' + rule.sec : '') + ' (' + rule.lab + ').', { key: rule.k });
      return null;
    }
    if (cands.length > 1) {
      checks.block('row_ambiguous', 'Linha "' + rule.k + '" casou ' + cands.length + ' linhas (' +
        cands.map(function (x) { return 'r' + x.r; }).join(', ') + ') — o manifesto precisa de seção, unidade ou "nth".', { key: rule.k });
      return null;
    }
    if (rule.row && rule.row !== cands[0].r) {
      checks.info('row_moved', '"' + rule.k + '" era a linha ' + rule.row + ' e agora está na ' + cands[0].r + '.', { key: rule.k });
    }
    return cands[0];
  }

  // ── extração de uma série ─────────────────────────────────────────────────────
  function extract(sheet, rowNum, cols, rule, checks) {
    const vals = {}, flags = {};
    let lastSign = 0, flips = 0, texts = 0;
    cols.forEach(function (col) {
      if (rule.from && qIdx(col.q) < qIdx(rule.from)) return;
      if (rule.to && qIdx(col.q) > qIdx(rule.to)) return;
      const cell = sheet.get(rowNum, col.c);
      const n = cellNum(cell);
      if (n.why === 'text' || n.why === 'error') texts++;
      if (n.v == null) return;
      let x = n.v * (rule.mult || 1);
      if (rule.sign) {
        const s = Math.sign(n.v);
        if (s && lastSign && s !== lastSign) flips++;
        if (s) lastSign = s;
        if (rule.sign === 'pos') x = Math.abs(x);
        if (rule.sign === 'neg') x = -Math.abs(x);
      }
      vals[col.q] = round(x);
      if (FLAG_ADJ.has(rule.std) && formulaKind(cell) === 'K') flags[col.q] = 'analyst_adj';
    });
    if (flips) checks.warn('sign_flip', '"' + rule.k + '" troca de sinal ' + flips + '× no histórico; normalizado para ' +
      (rule.sign === 'pos' ? 'positivo' : 'negativo') + '. Confira se é mudança de metodologia.', { key: rule.k });
    if (texts) checks.info('text_cells', '"' + rule.k + '": ' + texts + ' célula(s) com texto/erro viraram vazio.', { key: rule.k });
    // zeros de antes de a série existir ou depois da saída → vazio
    if (!rule.keepZeros) {
      const qs = Object.keys(vals).sort(function (a, b) { return qIdx(a) - qIdx(b); });
      for (let i = 0; i < qs.length && vals[qs[i]] === 0; i++) delete vals[qs[i]];
      for (let i = qs.length - 1; i >= 0 && vals[qs[i]] === 0; i--) delete vals[qs[i]];
    }
    return { vals: vals, flags: flags };
  }

  function computeCalc(rule, byKey) {
    const op = rule.calc.op, a = byKey[rule.calc.a], b = byKey[rule.calc.b];
    if (!a || !b) return null;
    const vals = {};
    Object.keys(a.vals).forEach(function (q) {
      const x = a.vals[q], y = b.vals[q];
      if (x == null || y == null) return;
      let v = null;
      if (op === 'div') v = y ? x / y : null;
      else if (op === 'per_unit') v = y ? x / y * (rule.calc.scale || 1) : null;
      else if (op === 'sub') v = x - y;
      else if (op === 'add') v = x + y;
      else if (op === 'mul') v = x * y;
      if (v != null && isFinite(v)) vals[q] = round(v);
    });
    return vals;
  }

  // ── um bloco de linhas ('cols') ───────────────────────────────────────────────
  function parseCols(sheet, sh, man, cutoff, out, checks) {
    const res = resolveCols(sheet, sh, cutoff, checks);
    if (!res) return;
    const cols = res.cols;
    if (!cols.length || cols[cols.length - 1].q !== cutoff) {
      checks.block('cutoff_missing', 'O modelo não tem a coluna do corte (' + qShort(cutoff) + '): a última lida foi ' +
        (cols.length ? qShort(cols[cols.length - 1].q) : 'nenhuma') + '.');
      return;
    }
    const rows = readRows(sheet, sh);
    const secs = resolveSections(rows, sh, sheet.maxR, checks);
    const used = new Set(), byKey = {};
    (sh.exclude || []).forEach(function (ex) {
      rows.forEach(function (x) {
        const inSec = !ex.sec || (secs[ex.sec] && x.r >= secs[ex.sec].start && x.r <= secs[ex.sec].end);
        const unitOk = !ex.unit || ex.unit.test(x.unit);          // 'Dom. Mkt' em BRL/ton sai, em ktons fica
        if (inSec && unitOk && ex.lab.test(x.label)) x.excluded = ex.cls || 'excluded';
      });
    });
    // 'skip': detalhe que o manifesto decidiu não importar, mas que NÃO é proibido — só sai da lista de
    // "não declaradas". Diferente de 'exclude', não bloqueia uma regra que aponte para a linha.
    (sh.skip || []).forEach(function (sk) {
      rows.forEach(function (x) {
        const inSec = !sk.sec || (secs[sk.sec] && x.r >= secs[sk.sec].start && x.r <= secs[sk.sec].end);
        if (inSec && (!sk.unit || sk.unit.test(x.unit)) && sk.lab.test(x.label)) x.skipped = true;
      });
    });
    (sh.rows || []).forEach(function (rule, i) {
      if (!rule.calc && PAID_LABEL.test(rule.k + ' ' + (rule.en || '')) && !rule.allowWord) {
        checks.block('paid_rule', 'A série "' + rule.k + '" tem cara de dado pago/consenso e não pode ser importada.', { key: rule.k });
        return;
      }
      if (rule.calc) return;                        // derivadas saem depois, das séries lidas
      const row = resolveRow(rows, secs, rule, sheet.maxR, checks);
      if (!row) return;
      if (row.excluded) {
        checks.block('rule_hits_excluded', '"' + rule.k + '" aponta para a linha ' + row.r + ' ("' + row.label +
          '"), que o manifesto marca como ' + row.excluded + '.', { key: rule.k });
        return;
      }
      if (PAID_LABEL.test(row.label) && !rule.allowWord) {
        checks.block('paid_row', 'A linha ' + row.r + ' ("' + row.label + '") tem cara de preço pago/índice e ficou fora.', { key: rule.k });
        return;
      }
      used.add(row.r);
      // 'from' na aba vale para todas as linhas (Suzano: antes de 1Q19 é pro-forma do analista)
      const ex = extract(sheet, row.r, cols, sh.from && !rule.from ? Object.assign({}, rule, { from: sh.from }) : rule, checks);
      const nvals = Object.keys(ex.vals).length;
      if (!nvals) { checks.info('empty_series', '"' + rule.k + '" veio sem nenhum número até o corte.', { key: rule.k }); return; }
      const s = {
        series_key: rule.k, std_key: rule.std || null, def: rule.def || null, section: rule.sec || null,
        segment: rule.seg || null, label_en: rule.en || row.label, label_model: row.label, unit: rule.u,
        ccy: rule.ccy || unitCcy(rule.u), agg: rule.agg || (STD[rule.std] ? STD[rule.std].agg : 'flow'),
        role: rule.role || 'series', headline: !!rule.head, is_calc: false, ord: i, vals: ex.vals, cell_flags: ex.flags
      };
      out.series.push(s);
      byKey[rule.k] = s;
      Object.keys(ex.flags).forEach(function (q) {
        out.candidates.push({ key: rule.k, q: q, kind: 'analyst_adj',
          msg: '"' + (rule.en || rule.k) + '" em ' + qShort(q) + ' é uma conta digitada (' + String(sheet.get(row.r, cols.find(function (c) { return c.q === q; }).c).f) + ').' });
      });
    });
    // derivadas calculadas aqui (preço por tonelada por unidade de negócio etc.)
    (sh.rows || []).forEach(function (rule, i) {
      if (!rule.calc) return;
      const vals = computeCalc(rule, byKey);
      if (!vals || !Object.keys(vals).length) { checks.info('calc_empty', 'Derivada "' + rule.k + '" sem dados.', { key: rule.k }); return; }
      const s = {
        series_key: rule.k, std_key: rule.std || null, def: rule.def || null, section: rule.sec || null,
        segment: rule.seg || null, label_en: rule.en || rule.k, label_model: null, unit: rule.u,
        ccy: rule.ccy || unitCcy(rule.u), agg: rule.agg || 'rate', role: 'series', headline: !!rule.head,
        is_calc: true, ord: i, vals: vals, cell_flags: {}
      };
      out.series.push(s);
      byKey[rule.k] = s;
    });
    // conferência das derivadas contra as linhas do próprio modelo
    (sh.derived || []).forEach(function (d) {
      const row = resolveRow(rows, secs, Object.assign({ k: d.k, req: false }, d), sheet.maxR, makeChecks());
      if (!row) return;
      const calc = computeCalc({ calc: d.calc }, byKey);
      if (!calc) return;
      const bad = [], shifted = [];
      cols.slice(-(d.last || 8)).forEach(function (col, idx, arr) {
        const mv = cellNum(sheet.get(row.r, col.c)).v, cv = calc[col.q];
        if (mv == null || cv == null) return;
        const tol = d.tol || 0.002;
        if (Math.abs(mv - cv) > tol * Math.max(1, Math.abs(cv))) {
          bad.push(qShort(col.q));
          const nx = arr[idx + 1] && calc[arr[idx + 1].q];
          if (nx != null && Math.abs(mv - nx) <= tol * Math.max(1, Math.abs(nx))) shifted.push(qShort(col.q));
        }
      });
      if (bad.length) {
        checks.warn('derived_mismatch', 'A linha "' + row.label + '" do modelo não bate com a conta em ' + bad.join(', ') +
          (shifted.length ? ' — em ' + shifted.join(', ') + ' a fórmula do modelo parece ler a coluna seguinte' : '') +
          '. A página recalcula; o modelo pode ter erro de fórmula.', { key: d.k });
      }
    });
    // coluna sem rótulo de trimestre no meio do histórico, mas com número nas linhas lidas → desalinha tudo
    const firstC = cols[0].c, lastC = cols[cols.length - 1].c;
    res.skipped.filter(function (s) { return s.kind !== 'annual' && s.c > firstC && s.c < lastC; }).forEach(function (s) {
      const temNumero = Array.from(used).some(function (r) { return cellNum(sheet.get(r, s.c)).v != null; });
      if (temNumero) checks.block('unlabeled_data_col', 'A coluna ' + colName(s.c) + ' tem números nas linhas importadas mas não tem rótulo de trimestre (' +
        (s.t ? '"' + s.t + '"' : 'vazio') + ') — a contagem por sequência ficaria errada.');
    });
    // linhas com número que ninguém declarou
    rows.forEach(function (x) {
      if (used.has(x.r) || x.excluded || x.skipped || !x.label) return;
      let n = 0;
      for (let i = Math.max(0, cols.length - 8); i < cols.length; i++) if (cellNum(sheet.get(x.r, cols[i].c)).v != null) n++;
      if (n >= 4) out.unknown.push({ row: x.r, label: x.label, unit: x.unit });
    });
    rows.forEach(function (x) { if (x.excluded) out.excluded[x.excluded] = (out.excluded[x.excluded] || 0) + 1; });
  }

  // ── blocos transpostos ('blocks', Grupo México) ───────────────────────────────
  function parseBlocks(sheet, sh, man, cutoff, out, checks) {
    const b = sh.blocks;
    const anchors = [];
    for (let c = 1; c <= sheet.maxC; c++) if (b.anchor.test(cellText(sheet.get(b.anchorRow, c)))) anchors.push(c);
    if (!anchors.length) { checks.block('no_blocks', 'Não achei os blocos por trimestre (' + b.anchor + ').'); return; }
    const blocks = [];
    anchors.forEach(function (c, i) {
      const q = qAdd(b.firstQ, i);
      if (qIdx(q) > qIdx(cutoff)) return;
      const segCols = {};
      for (let j = 1; j <= (b.width || 10); j++) {
        const t = cellText(sheet.get(b.segRow, c + j));
        const seg = b.segs.find(function (s) { return s.name.test(t); });
        if (seg && segCols[seg.key] == null) segCols[seg.key] = c + j;
      }
      blocks.push({ c: c, q: q, segCols: segCols, period: cellText(sheet.get(b.periodRow, c + (b.periodOffset || 7))) });
    });
    if (!blocks.length || blocks[blocks.length - 1].q !== cutoff) {
      checks.block('cutoff_missing', 'O modelo não tem o bloco do corte (' + qShort(cutoff) + ').');
      return;
    }
    const mism = blocks.filter(function (x) { const h = qFromHeader(x.period); return h && h !== x.q; });
    if (mism.length) {
      const noCorte = mism.some(function (x) { return x.q === cutoff; });
      checks[noCorte ? 'warn' : 'info']('header_mismatch', 'Rótulo de período diferente da sequência em ' + mism.length + ' bloco(s): ' +
        mism.slice(0, 6).map(function (x) { return colName(x.c) + ' diz ' + x.period + ' = ' + qShort(x.q); }).join(' · ') + '. Vale a sequência.');
    }
    const steps = blocks.slice(1).map(function (x, i) { return x.c - blocks[i].c; });
    const fora = steps.filter(function (s) { return b.step && (s < b.step[0] || s > b.step[1]); });
    if (fora.length) checks.warn('block_step', 'Distância entre blocos fora do esperado (' + fora.join(', ') + ' colunas).');
    blocks.forEach(function (bl) {
      b.segs.forEach(function (sg) {
        if (bl.segCols[sg.key] == null) checks.block('segment_missing', 'Segmento "' + sg.key + '" não encontrado no bloco ' + qShort(bl.q) + '.');
      });
    });
    // as linhas se resolvem pelo rótulo do 1º bloco; 'labOff' lê o rótulo noutra coluna do bloco (o volume
    // ferroviário do Grupo México tem o rótulo na coluna do AMC e o número na de Transporte)
    const rowsBy = {};
    const rowsAt = function (off) {
      off = off || 0;
      return rowsBy[off] || (rowsBy[off] = readRows(sheet, { labelCol: colName(blocks[0].c + off) }));
    };
    const cols = blocks.map(function (bl) { return { q: bl.q, bl: bl }; });
    (sh.rows || []).forEach(function (rule, i) {
      const row = resolveRow(rowsAt(rule.labOff), {}, rule, sheet.maxR, checks);
      if (!row) return;
      if (PAID_LABEL.test(row.label) && !rule.allowWord) {
        checks.block('paid_row', 'A linha ' + row.r + ' ("' + row.label + '") tem cara de preço pago e ficou fora.', { key: rule.k });
        return;
      }
      // o rótulo tem de estar na MESMA linha em todos os blocos; se um bloco trouxer outro texto ali, ele
      // desalinhou (linha inserida só num trimestre) e a série sairia misturada
      const tortos = blocks.filter(function (bl) {
        const t = cellText(sheet.get(row.r, bl.c + (rule.labOff || 0)));
        return t && !rule.lab.test(t);
      });
      if (tortos.length) {
        checks.block('block_row_mismatch', '"' + rule.k + '": a linha ' + row.r + ' tem outro rótulo em ' + tortos.length + ' bloco(s) (' +
          tortos.slice(0, 4).map(function (bl) { return qShort(bl.q) + ' em ' + colName(bl.c + (rule.labOff || 0)); }).join(', ') + ').', { key: rule.k });
        return;
      }
      b.segs.forEach(function (sg, j) {
        if ((sh.skipSegs || []).indexOf(sg.key) >= 0) return;
        if (rule.onlySegs && rule.onlySegs.indexOf(sg.key) < 0) return;
        // 'keys' dá nome próprio à coluna do total (Grupo México consolidado vira 'revenue', não 'rev.gmex')
        const key = (rule.keys && rule.keys[sg.key]) || rule.k.replace('{seg}', sg.key);
        const segCols = cols.map(function (x) { return { c: x.bl.segCols[sg.key], q: x.q }; }).filter(function (x) { return x.c; });
        const ex = extract(sheet, row.r, segCols, Object.assign({}, rule, { k: key, std: (rule.std && rule.std[sg.key]) || rule.segStd || null }), checks);
        if (!Object.keys(ex.vals).length) return;
        const std = (rule.std && rule.std[sg.key]) || rule.segStd || null;
        out.series.push({
          series_key: key, std_key: std, def: rule.def || null, section: rule.sec || 'segments', segment: sg.total ? null : sg.key,
          label_en: (rule.en || row.label).replace('{seg}', sg.en || sg.key), label_model: row.label, unit: rule.u,
          ccy: rule.ccy || unitCcy(rule.u), agg: rule.agg || 'flow', role: 'series',
          headline: !!(rule.head && rule.head[sg.key]), is_calc: false, ord: i * 10 + j, vals: ex.vals, cell_flags: ex.flags
        });
      });
    });
  }

  // ── impressão digital (alinhamento de trimestre) ──────────────────────────────
  function fingerprint(out, man, opts, checks) {
    const by = {};
    out.series.forEach(function (s) { by[s.series_key] = s; });
    const cutoff = out.cutoff_q;
    (man.finger || []).forEach(function (f) {
      const s = by[f.k];
      if (!s) { checks.block('finger_series_missing', 'Série "' + f.k + '" (usada para conferir o alinhamento) não foi lida.'); return; }
      const tol = f.tol || 0.001;
      const nivel = f.hard ? 'block' : 'warn';
      if (f.vs === 'filed') {
        const filed = opts.filed && opts.filed[f.field || 'rev'];
        if (!filed || !filed.vals || !Object.keys(filed.vals).length) {
          // com o número do release como reserva ('unlessFiled'), a falta do robô não é alerta
          const reserva = (man.finger || []).some(function (g) { return g.vs === 'gold' && g.k === f.k && g.unlessFiled === (f.field || 'rev'); });
          checks[f.hard && !reserva ? 'warn' : 'info']('finger_no_filed', 'Sem número da CVM/SEC para conferir "' + f.k + '"' +
            (reserva ? ' — vale o número do release.' : '.'));
          return;
        }
        const qs = Object.keys(s.vals).filter(function (q) { return filed.vals[q] != null; })
          .sort(function (a, b) { return qIdx(a) - qIdx(b); }).slice(-(f.last || 4));
        if (!qs.length) { checks[nivel]('finger_no_overlap', 'Nenhum trimestre em comum entre o modelo e a CVM/SEC para "' + f.k + '".'); return; }
        const erros = [], ok = [];
        qs.forEach(function (q) {
          let mv = s.vals[q];
          if (s.ccy && filed.ccy && s.ccy !== filed.ccy) {
            const fx = opts.fx && opts.fx[q];
            if (!fx) return;
            mv = mv * fx;                                          // modelo em US$ × câmbio médio → R$
          }
          const fv = filed.vals[q];
          const d = Math.abs(mv - fv) / Math.max(1e-9, Math.abs(fv));
          (d > tol ? erros : ok).push(qShort(q) + ' ' + (d * 100).toFixed(2) + '%');
        });
        if (erros.length) checks[nivel]('finger_filed', '"' + (s.label_en || f.k) + '" do modelo × CVM/SEC diverge: ' + erros.join(' · ') +
          (f.hard ? ' — trimestre desalinhado ou planilha errada.' : ' — definição diferente; a página usa o número oficial.'), { key: f.k });
        // modelo em US$ e CVM em R$ sem PTAX carregada: nada foi comparado — não pode sair como "bate"
        else if (!ok.length) checks.warn('finger_no_fx', 'Sem câmbio (PTAX) para converter "' + (s.label_en || f.k) + '" de ' + s.ccy +
          ' para ' + filed.ccy + ' e conferir com a CVM — confira a receita do ' + qShort(cutoff) + ' com o release antes de publicar.', { key: f.k });
        else checks.info('finger_filed_ok', '"' + (s.label_en || f.k) + '" bate com a CVM/SEC: ' + ok.join(' · ') + '.', { key: f.k });
        if (filed.vals[cutoff] == null) checks.warn('cutoff_not_filed', 'A CVM/SEC ainda não tem ' + qShort(cutoff) +
          ' para conferir; o corte vale pela data do release.');
      } else if (f.vs === 'fx') {
        const qs = Object.keys(s.vals).filter(function (q) { return opts.fx && opts.fx[q] != null; })
          .sort(function (a, b) { return qIdx(a) - qIdx(b); }).slice(-(f.last || 4));
        if (!qs.length) { checks.info('finger_no_fx', 'Sem PTAX carregada para conferir o câmbio.'); return; }
        const erros = qs.filter(function (q) { return Math.abs(s.vals[q] - opts.fx[q]) / opts.fx[q] > (f.tol || 0.01); });
        if (erros.length) checks[nivel]('finger_fx', 'Câmbio médio do modelo × PTAX diverge em ' + erros.map(qShort).join(', ') + ' — trimestre desalinhado?', { key: f.k });
        else checks.info('finger_fx_ok', 'Câmbio médio do modelo bate com a PTAX nos últimos ' + qs.length + ' trimestres.');
      } else if (f.vs === 'gold') {
        // 'unlessFiled': o número do release só é pedido enquanto o robô (SEC) ainda não trouxe o trimestre
        if (f.unlessFiled) {
          const fl = opts.filed && opts.filed[f.unlessFiled];
          if (fl && fl.vals && fl.vals[cutoff] != null) return;
        }
        const g = opts.gold && opts.gold[f.k];
        if (g == null || !isFinite(g)) { checks.block('gold_required', 'Digite o valor de "' + (s.label_en || f.k) + '" do release de ' + qShort(cutoff) + ' para conferir o alinhamento.', { key: f.k }); return; }
        const mv = s.vals[cutoff];
        const d = mv == null ? Infinity : Math.abs(mv - g) / Math.max(1e-9, Math.abs(g));
        if (d > (f.tol || 0.002)) checks.block('finger_gold', '"' + (s.label_en || f.k) + '" em ' + qShort(cutoff) + ': modelo ' + mv + ' × release ' + g + '.', { key: f.k });
        else checks.info('finger_gold_ok', '"' + (s.label_en || f.k) + '" em ' + qShort(cutoff) + ' bate com o release.');
      } else if (f.vs === 'sibling') {
        const other = opts.siblings && opts.siblings[f.sibling];
        if (!other) { checks.info('finger_no_sibling', 'Sem a série irmã "' + f.sibling + '" para conferir.'); return; }
        const qs = Object.keys(s.vals).filter(function (q) { return other[q] != null; }).slice(-(f.last || 4));
        const erros = qs.filter(function (q) { return Math.abs(s.vals[q] - other[q]) / Math.max(1e-9, Math.abs(other[q])) > tol; });
        if (erros.length) checks[nivel]('finger_sibling', '"' + f.k + '" × "' + f.sibling + '" diverge em ' + erros.map(qShort).join(', ') + '.');
        else if (qs.length) checks.info('finger_sibling_ok', '"' + f.k + '" bate com "' + f.sibling + '".');
      }
    });
  }

  // ── entrada principal ─────────────────────────────────────────────────────────
  function parseWorkbook(book, man, opts) {
    opts = opts || {};
    const checks = makeChecks();
    const out = {
      company: man.id, manifest_id: man.id, manifest_v: man.v, lib_v: VERSION,
      cutoff_q: opts.cutoff || null, first_q: null, series: [], checks: checks.list,
      unknown: [], excluded: {}, candidates: []
    };
    if (!isQKey(opts.cutoff)) { checks.block('cutoff_invalid', 'Corte inválido: ' + opts.cutoff); return out; }
    if (qIdx(opts.cutoff) >= qIdx(qCurrent(opts.now))) {
      checks.block('cutoff_not_past', 'O corte (' + qShort(opts.cutoff) + ') ainda não terminou — só entra trimestre fechado.');
      return out;
    }
    (man.sheets || []).forEach(function (sh) {
      const name = book.sheetNames.find(function (n) { return sh.name.test(n); });
      if (!name) { checks.block('sheet_not_found', 'Aba ' + sh.name + ' não encontrada no arquivo.'); return; }
      if (PAID_SHEET.test(name) && !sh.allowWord) { checks.block('paid_sheet', 'A aba "' + name + '" tem cara de dado pago e não é lida.'); return; }
      const sheet = book.sheet(name);
      if (sh.layout === 'blocks') parseBlocks(sheet, sh, man, opts.cutoff, out, checks);
      else parseCols(sheet, sh, man, opts.cutoff, out, checks);
    });
    const vistos = new Set();
    out.series = out.series.filter(function (s) {
      if (vistos.has(s.series_key)) { checks.block('dup_series_key', 'Chave repetida no manifesto: ' + s.series_key); return false; }
      vistos.add(s.series_key); return true;
    });
    // trava final: nada depois do corte, nem por engano
    out.series.forEach(function (s) {
      Object.keys(s.vals).forEach(function (q) {
        if (!isQKey(q) || qIdx(q) > qIdx(opts.cutoff)) { delete s.vals[q]; checks.block('after_cutoff', 'Valor depois do corte removido: ' + s.series_key + ' ' + q); }
      });
    });
    const primeiros = out.series.map(function (s) { return Object.keys(s.vals).sort(function (a, b) { return qIdx(a) - qIdx(b); })[0]; }).filter(Boolean);
    out.first_q = primeiros.sort(function (a, b) { return qIdx(a) - qIdx(b); })[0] || null;
    (man.required || []).forEach(function (k) {
      if (!out.series.some(function (s) { return s.series_key === k; })) checks.block('required_missing', 'Série obrigatória ausente: ' + k);
    });
    fingerprint(out, man, opts, checks);
    if (out.unknown.length) checks.info('unknown_rows', out.unknown.length + ' linha(s) com número não declaradas no manifesto (não entram).');
    return out;
  }

  function summarize(out) {
    const n = { block: 0, warn: 0, info: 0 };
    out.checks.forEach(function (c) { n[c.level] = (n[c.level] || 0) + 1; });
    return {
      status: n.block ? 'block' : n.warn ? 'warn' : 'ok', counts: n,
      n_series: out.series.length, n_values: countValues(out.series)
    };
  }

  // ── lotes para o servidor ─────────────────────────────────────────────────────
  function countValues(series) { return series.reduce(function (a, s) { return a + Object.keys(s.vals).length; }, 0); }
  function toBatches(series, maxBytes) {
    maxBytes = maxBytes || 60000;
    const out = [];
    let cur = [], size = 2;
    series.forEach(function (s) {
      const n = JSON.stringify(s).length + 1;
      if (cur.length && size + n > maxBytes) { out.push(cur); cur = []; size = 2; }
      cur.push(s); size += n;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  // ── o que mudou contra a versão publicada ─────────────────────────────────────
  function diffSeries(novas, antigas, cutoff) {
    const om = new Map((antigas || []).map(function (s) { return [s.key || s.series_key, s]; }));
    const added = [], revisions = [], newQuarters = [];
    novas.forEach(function (s) {
      const o = om.get(s.series_key);
      if (!o) { added.push(s.series_key); return; }
      om.delete(s.series_key);
      Object.keys(s.vals).forEach(function (q) {
        const ov = o.vals ? o.vals[q] : null, v = s.vals[q];
        if (ov == null) { newQuarters.push(s.series_key + ' ' + q); return; }
        const rel = ov !== 0 ? Math.abs((v - ov) / ov) : (v !== 0 ? Infinity : 0);
        if (rel > 1e-4) revisions.push({ key: s.series_key, q: q, old: ov, new: v, rel: rel });
      });
    });
    revisions.sort(function (a, b) { return b.rel - a.rel; });
    const velhas = cutoff ? revisions.filter(function (r) { return r.rel > 0.05 && qIdx(r.q) <= qIdx(cutoff) - 4; }) : [];
    return {
      added: added, removed: Array.from(om.keys()), n_new_quarters: newQuarters.length,
      revisions: revisions.slice(0, 20), n_revisions: revisions.length, old_big_revisions: velhas.slice(0, 20)
    };
  }

  // ── manifestos ────────────────────────────────────────────────────────────────
  // Formato de cada linha: k (chave estável) · sec (seção) · lab (regex do rótulo) · unit (regex da
  // coluna de unidade, quando houver) · nth/after (desempate) · u (unidade canônica) · std/def/head
  // (métrica comparável, definição, visão inicial) · from/to (janela de validade) · sign/mult ·
  // row (linha esperada — só gera aviso se mudar) · req (obrigatória) · en (rótulo em inglês).
  const MANIFESTS = [];

  MANIFESTS.push({
    id: 'GGBR4', v: 1, file: /^Gerdau_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview$/, layout: 'cols', labelCol: 'B', headerRow: 5, firstCol: 'C', firstQ: '2012Q2',
      sections: [
        ['vol', /^Volumes \(k tons\)$/i], ['px_brl', /^Prices \(BRL\/ton\)$/i], ['px_usd', /^Prices \(USD\/ton\)$/i],
        ['rev', /^Revenues \(BRL mn\)$/i], ['ebitda', /^EBITDA \(BRL mn\)$/i], ['margin', /^EBITDA Margin \(%\)$/i],
        ['is', /^\(=\) EBITDA$/i]
      ],
      exclude: [
        { cls: 'derived', sec: 'px_brl', lab: /./ }, { cls: 'derived', sec: 'px_usd', lab: /./ },
        { cls: 'derived', sec: 'margin', lab: /./ }, { cls: 'derived', lab: /Effective Tax Rate/i }
      ],
      rows: [
        { k: 'fx.avg', lab: /^FX Rate - Avg$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 7 },
        { k: 'fx.eop', lab: /^FX Rate - EOP$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 6 },
        { k: 'vol.br', sec: 'vol', lab: /^Brazil$/i, u: 'kt', seg: 'brazil', en: 'Shipments — Brazil', row: 10 },
        { k: 'vol.br.dom', sec: 'vol', lab: /^Domestic Mkt$/i, u: 'kt', seg: 'brazil', en: 'Shipments — Brazil domestic', row: 11 },
        { k: 'vol.br.exp', sec: 'vol', lab: /^Export Mkt$/i, u: 'kt', seg: 'brazil', en: 'Shipments — Brazil exports', row: 12 },
        { k: 'vol.na', sec: 'vol', lab: /^N\. America$/i, u: 'kt', seg: 'north_america', en: 'Shipments — North America', row: 13 },
        { k: 'vol.sa', sec: 'vol', lab: /^South America$/i, u: 'kt', seg: 'south_america', en: 'Shipments — South America', row: 14 },
        { k: 'vol.special', sec: 'vol', lab: /^Special$/i, u: 'kt', seg: 'special', to: '2022Q4', en: 'Shipments — Special Steels', row: 15 },
        { k: 'vol.total', sec: 'vol', lab: /^Total Steel Volumes$/i, u: 'kt', std: 'sales_volume', def: 'steel_kt', head: true, req: true, en: 'Steel shipments', row: 17 },
        { k: 'rev.br', sec: 'rev', lab: /^Brazil$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'brazil', en: 'Revenue — Brazil', row: 38 },
        { k: 'rev.br.dom', sec: 'rev', lab: /^Domestic Mkt$/i, u: 'BRL_mn', seg: 'brazil', en: 'Revenue — Brazil domestic', row: 39 },
        { k: 'rev.br.exp', sec: 'rev', lab: /^Export Mkt$/i, u: 'BRL_mn', seg: 'brazil', en: 'Revenue — Brazil exports', row: 40 },
        { k: 'rev.na', sec: 'rev', lab: /^N\. America$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'north_america', en: 'Revenue — North America', row: 41 },
        { k: 'rev.sa', sec: 'rev', lab: /^South America$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'south_america', en: 'Revenue — South America', row: 42 },
        { k: 'rev.special', sec: 'rev', lab: /^Special$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'special', to: '2022Q4', en: 'Revenue — Special Steels', row: 43 },
        { k: 'revenue', sec: 'rev', lab: /^Total Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 45 },
        { k: 'ebitda.br', sec: 'ebitda', lab: /^Brazil$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'brazil', en: 'EBITDA — Brazil', row: 48 },
        { k: 'ebitda.na', sec: 'ebitda', lab: /^N\. America$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'north_america', en: 'EBITDA — North America', row: 49 },
        { k: 'ebitda.sa', sec: 'ebitda', lab: /^South America$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'south_america', en: 'EBITDA — South America', row: 50 },
        { k: 'ebitda.special', sec: 'ebitda', lab: /^Special$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'special', to: '2022Q4', en: 'EBITDA — Special Steels', row: 51 },
        { k: 'adj_ebitda', sec: 'ebitda', lab: /^Total$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 53 },
        { k: 'd_a', sec: 'is', lab: /^\(-\) Depreciation$/i, u: 'BRL_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 63 },
        { k: 'ebit', sec: 'is', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 64 },
        { k: 'fin_result', sec: 'is', lab: /^\(\+\/-\) Net Fin\. Results$/i, u: 'BRL_mn', en: 'Net financial result', row: 65 },
        { k: 'taxes', sec: 'is', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 72 },
        { k: 'minorities', sec: 'is', lab: /^\(-\) Minorities$/i, u: 'BRL_mn', en: 'Minority interests', row: 75 },
        { k: 'vol.elim', sec: 'vol', lab: /^Eliminations$/i, u: 'kt', seg: 'eliminations', en: 'Shipments — eliminations', row: 16 },
        { k: 'rev.elim', sec: 'rev', lab: /^Eliminations$/i, u: 'BRL_mn', seg: 'eliminations', en: 'Revenue — eliminations', row: 44 },
        { k: 'ebitda.elim', sec: 'ebitda', lab: /^Eliminations$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'eliminations', en: 'EBITDA — eliminations', row: 52 },
        { k: 'ebitda_is', sec: 'is', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', en: 'EBITDA (income statement)', row: 62 },
        { k: 'fin_revs', sec: 'is', lab: /^\(\+\) Fin\. Revs$/i, u: 'BRL_mn', en: 'Financial income', row: 66 },
        { k: 'fin_exps', sec: 'is', lab: /^\(-\) Fin\. Exps$/i, u: 'BRL_mn', en: 'Financial expenses', row: 67 },
        { k: 'fx_var', sec: 'is', lab: /^\(\+\/-\) FX Variation$/i, u: 'BRL_mn', en: 'FX variation', row: 68 },
        { k: 'other_fin', sec: 'is', lab: /^\(\+\/-\) Other$/i, u: 'BRL_mn', en: 'Other financial items', row: 69 },
        { k: 'other_nonop', sec: 'is', lab: /^\(\+\/-\) Other Non-Op\.$/i, u: 'BRL_mn', en: 'Other non-operating items', row: 70 },
        { k: 'ebt', sec: 'is', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 71 },
        { k: 'net_income_total', sec: 'is', lab: /^\(=\) Net Income$/i, u: 'BRL_mn', en: 'Net income (incl. minorities)', row: 74 },
        { k: 'net_income', sec: 'is', lab: /^\(=\) Net Income \(ex-Minorities\)$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 76 },
        { k: 'px.br', calc: { op: 'per_unit', a: 'rev.br', b: 'vol.br', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'steel_brazil_brl', seg: 'brazil', en: 'Realized price — Brazil' },
        { k: 'px.na', calc: { op: 'per_unit', a: 'rev.na', b: 'vol.na', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'steel_na_brl', seg: 'north_america', en: 'Realized price — North America' },
        { k: 'px.sa', calc: { op: 'per_unit', a: 'rev.sa', b: 'vol.sa', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'steel_sa_brl', seg: 'south_america', en: 'Realized price — South America' },
        { k: 'ebitda_t', calc: { op: 'per_unit', a: 'adj_ebitda', b: 'vol.total', scale: 1000 }, u: 'BRL/t', en: 'EBITDA per tonne' }
      ],
      derived: [
        { k: 'chk.margin', sec: 'margin', lab: /^Total$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' }, tol: 0.002 },
        { k: 'chk.px.br', sec: 'px_brl', lab: /^Brazil$/i, calc: { op: 'per_unit', a: 'rev.br', b: 'vol.br', scale: 1000 }, tol: 0.002 }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // Usiminas — o "D&A no CPV" do aço é 70% do D&A do segmento (premissa do modelo), então custo caixa
  // e custo caixa/t são rateio e ficam fora. Receita, lucro e dívida batem com a CVM (2Q26: 6.131,4 · 382,4).
  MANIFESTS.push({
    id: 'USIM5', v: 1, file: /^Usiminas_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Quarterly$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 4, firstCol: 'D', firstQ: '2012Q3',
      sections: [
        ['steel', /^STEEL$/], ['mining', /^MINING$/], ['others', /^OTHERS$/], ['by_bu', /^EBITDA \(By Business\)$/i],
        ['e_steel', /^STEEL$/], ['e_mining', /^MINING$/], ['e_others', /^OTHERS\/ELIMINATIONS$/i],
        ['cons', /^CONSOLIDATED$/], ['debt', /^Debt & Financial Result Calculations$/i]
      ],
      exclude: [
        { cls: 'allocation', lab: /Depreciation in COGS|Cash COGS/i },
        { cls: 'paid', lab: /Premium\/Discount/i },
        { cls: 'derived', lab: /Prices$|Average Realization Price|Sales Mix|Margin|as % of|Effective Tax Rate/i },
        { cls: 'dup', sec: 'e_steel', lab: /^\(=\) Revenues$/i }, { cls: 'dup', sec: 'e_mining', lab: /^\(=\) Revenues$/i },
        { cls: 'dup', sec: 'e_others', lab: /^\(=\) Revenues$/i }, { cls: 'dup', sec: 'others', lab: /^\(=\) Consolidated Revenues$/i },
        { cls: 'assumption', sec: 'debt', lab: /^Financial (Expenses|Income)$|% of Debt in USD/i }
      ],
      rows: [
        { k: 'fx.avg', lab: /^FX Avg$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 5 },
        { k: 'fx.eop', lab: /^FX EOP$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 6 },
        { k: 'steel.vol.dom', sec: 'steel', lab: /^Domestic$/i, unit: /^ktons$/i, u: 'kt', seg: 'steel', en: 'Steel shipments — domestic', row: 11 },
        { k: 'steel.vol.exp', sec: 'steel', lab: /^Exports$/i, unit: /^ktons$/i, u: 'kt', seg: 'steel', en: 'Steel shipments — exports', row: 12 },
        { k: 'steel.vol', sec: 'steel', lab: /^Total Sales Volumes$/i, u: 'kt', std: 'sales_volume', def: 'steel_kt', seg: 'steel', head: true, req: true, en: 'Steel shipments', row: 13 },
        { k: 'steel.rev.dom', sec: 'steel', lab: /^Domestic Market$/i, u: 'BRL_mn', seg: 'steel', en: 'Steel revenue — domestic', row: 23 },
        { k: 'steel.rev.exp', sec: 'steel', lab: /^Export Market$/i, u: 'BRL_mn', seg: 'steel', en: 'Steel revenue — exports', row: 24 },
        { k: 'steel.rev', sec: 'steel', lab: /^Total$/i, unit: /^BRL m$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'steel', en: 'Revenue — Steel', row: 25 },
        { k: 'mining.vol.dom', sec: 'mining', lab: /^Domestic$/i, unit: /^ktons$/i, u: 'Mt', mult: 0.001, seg: 'mining', en: 'Iron ore sales — domestic', row: 29 },
        { k: 'mining.vol.exp', sec: 'mining', lab: /^Exports$/i, unit: /^ktons$/i, u: 'Mt', mult: 0.001, seg: 'mining', en: 'Iron ore sales — exports', row: 30 },
        { k: 'mining.vol', sec: 'mining', lab: /^Total Sales Volumes$/i, u: 'Mt', mult: 0.001, std: 'sales_volume', def: 'iron_ore_mt', seg: 'mining', en: 'Iron ore sales', row: 31 },
        { k: 'mining.rev.dom', sec: 'mining', lab: /^Domestic Market$/i, u: 'BRL_mn', seg: 'mining', en: 'Mining revenue — domestic', row: 42 },
        { k: 'mining.rev.exp', sec: 'mining', lab: /^Export Market$/i, u: 'BRL_mn', seg: 'mining', en: 'Mining revenue — exports', row: 43 },
        { k: 'mining.rev', sec: 'mining', lab: /^Total$/i, unit: /^BRL m$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'mining', en: 'Revenue — Mining', row: 44 },
        { k: 'elim.rev', sec: 'others', lab: /^Total$/i, unit: /^BRL m$/i, u: 'BRL_mn', seg: 'eliminations', en: 'Revenue — corporate & eliminations', row: 48 },
        { k: 'steel.cogs', sec: 'e_steel', lab: /^\(-\) COGS$/i, u: 'BRL_mn', seg: 'steel', en: 'COGS — Steel', row: 57 },
        { k: 'steel.ebit', sec: 'e_steel', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', seg: 'steel', en: 'EBIT — Steel', row: 63 },
        // "(+) Depreciation/Others" é EBITDA − EBIT: inclui outros itens e troca de sinal no histórico → não é D&A
        // (o D&A da página vem da CVM) e o sinal fica como está
        { k: 'steel.da_other', sec: 'e_steel', lab: /^\(\+\) Depreciation\/Others$/i, u: 'BRL_mn', seg: 'steel', en: 'D&A and other items — Steel', row: 64 },
        { k: 'steel.ebitda', sec: 'e_steel', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'steel', en: 'EBITDA — Steel', row: 65 },
        { k: 'mining.cogs', sec: 'e_mining', lab: /^\(-\) COGS$/i, u: 'BRL_mn', seg: 'mining', en: 'COGS — Mining', row: 70 },
        { k: 'mining.ebit', sec: 'e_mining', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', seg: 'mining', en: 'EBIT — Mining', row: 76 },
        { k: 'mining.da_other', sec: 'e_mining', lab: /^\(\+\) Depreciation\/Others$/i, u: 'BRL_mn', seg: 'mining', en: 'D&A and other items — Mining', row: 77 },
        { k: 'mining.ebitda', sec: 'e_mining', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'mining', en: 'EBITDA — Mining', row: 78 },
        { k: 'elim.ebitda', sec: 'e_others', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'eliminations', en: 'EBITDA — corporate & eliminations', row: 90 },
        { k: 'revenue', sec: 'cons', lab: /^\(=\) Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 94 },
        { k: 'cogs', sec: 'cons', lab: /^\(-\) COGS$/i, u: 'BRL_mn', en: 'COGS', row: 95 },
        { k: 'gross_profit', sec: 'cons', lab: /^\(=\) Gross Profit$/i, u: 'BRL_mn', en: 'Gross profit', row: 98 },
        { k: 'opex', sec: 'cons', lab: /^\(-\) Operational Expenses$/i, u: 'BRL_mn', en: 'Operating expenses', row: 99 },
        { k: 'ebit', sec: 'cons', lab: /^\(=\) EBIT$/i, nth: 0, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 100 },
        { k: 'da_other', sec: 'cons', lab: /^\(\+\) Depreciation\/Others$/i, u: 'BRL_mn', en: 'D&A and other items (EBITDA − EBIT)', row: 101 },
        { k: 'adj_ebitda', sec: 'cons', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 102 },
        { k: 'fin_result', sec: 'cons', lab: /^\(\+\/-\) Net Financial Result$/i, u: 'BRL_mn', en: 'Net financial result', row: 106 },
        { k: 'equity_income', sec: 'cons', lab: /^\(\+\/-\) Equity Income$/i, u: 'BRL_mn', en: 'Equity income', row: 110 },
        { k: 'ebt', sec: 'cons', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 112 },
        { k: 'taxes', sec: 'cons', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 113 },
        { k: 'minorities', sec: 'cons', lab: /^\(-\) Minority Interest$/i, u: 'BRL_mn', en: 'Minority interests', row: 115 },
        { k: 'net_income', sec: 'cons', lab: /^\(=\) Net Income \(Attr\. to Shareholders\)$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 117 },
        { k: 'gross_debt', sec: 'debt', lab: /^Total Debt$/i, u: 'BRL_mn', agg: 'stock', en: 'Gross debt', row: 122 },
        { k: 'cash', sec: 'debt', lab: /^Cash$/i, u: 'BRL_mn', agg: 'stock', en: 'Cash', row: 123 },
        { k: 'net_debt', sec: 'debt', lab: /^Net Debt$/i, u: 'BRL_mn', std: 'net_debt', head: true, en: 'Net debt', row: 124 },
        { k: 'steel.px', calc: { op: 'per_unit', a: 'steel.rev', b: 'steel.vol', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'steel_brazil_brl', seg: 'steel', en: 'Steel realized price' },
        { k: 'steel.px.dom', calc: { op: 'per_unit', a: 'steel.rev.dom', b: 'steel.vol.dom', scale: 1000 }, u: 'BRL/t', seg: 'steel', en: 'Steel realized price — domestic' },
        { k: 'steel.px.exp', calc: { op: 'per_unit', a: 'steel.rev.exp', b: 'steel.vol.exp', scale: 1000 }, u: 'BRL/t', seg: 'steel', en: 'Steel realized price — exports' },
        { k: 'mining.px', calc: { op: 'div', a: 'mining.rev', b: 'mining.vol' }, u: 'BRL/t', std: 'realized_price', def: 'iron_ore_brl', seg: 'mining', en: 'Iron ore realized price' },
        { k: 'steel.ebitda_t', calc: { op: 'per_unit', a: 'steel.ebitda', b: 'steel.vol', scale: 1000 }, u: 'BRL/t', seg: 'steel', en: 'Steel EBITDA per tonne' }
      ],
      derived: [
        { k: 'chk.margin', sec: 'cons', lab: /^EBITDA Margin$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' } },
        { k: 'chk.px.steel.dom', sec: 'steel', lab: /^Domestic Prices$/i, unit: /^BRL\/ton$/i, calc: { op: 'per_unit', a: 'steel.rev.dom', b: 'steel.vol.dom', scale: 1000 } },
        { k: 'chk.px.mining', sec: 'mining', lab: /^Average Realization Price$/i, calc: { op: 'div', a: 'mining.rev', b: 'mining.vol' } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // CSN — o 2Q26 está rotulado '2Q25a' (vale a sequência). Fora: rateio do D&A por segmento (e o custo caixa/t
  // que sai dele), split BRL/USD do custo, o "Others/Eliminations" (resíduo) e o bloco de spot/desconto.
  MANIFESTS.push({
    id: 'CSNA3', v: 1, file: /^CSN_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Simplified Preview Model$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 5, firstCol: 'D', firstQ: '2013Q1',
      sections: [
        ['steel', /^STEEL SEGMENT$/i], ['mining', /^MINING SEGMENT$/i], ['others', /^OTHERS\/ELIMINATIONS$/i],
        ['cons', /^CONSOLIDATED$/i], ['dep', /^CONSOLIDATED$/i], ['check', /^Model Check/i],
        ['is', /^INCOME STATEMENT$/i], ['nfr', /^NET FINANCIAL RESULTS$/i]
      ],
      exclude: [
        { cls: 'paid', lab: /Spot Price|Discount to Spot/i },
        { cls: 'allocation', sec: 'steel', lab: /^\(-\) Depreciation$|Cash COGs|Linked$/i },
        { cls: 'allocation', sec: 'mining', lab: /^\(-\) Depreciation$|Cash COGs/i },
        { cls: 'allocation', sec: 'dep', lab: /^(COGs|SG&A) Depreciation$/i },
        { cls: 'plug', sec: 'others', lab: /./ },
        { cls: 'dup', sec: 'cons', lab: /^(?!\(\+\) (?:EBITDA \(% Stake in JVs\)|Net Book Value of Asset Sold)$)./i },
        { cls: 'derived', lab: /Margin|as % of|Sales Mix|Effective Tax Rate|Realization Price|^% /i },
        { cls: 'derived', sec: 'steel', lab: /^(Dom\. Mkt|Exports)$/i, unit: /\/ton$/i },
        { cls: 'check', sec: 'check', lab: /./ },
        { cls: 'dup', sec: 'nfr', lab: /./ }
      ],
      rows: [
        { k: 'fx.avg', lab: /^BRL Avg$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 6 },
        { k: 'fx.eop', lab: /^BRL EOP$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 7 },
        { k: 'steel.vol.dom', sec: 'steel', lab: /^Dom\. Mkt$/i, unit: /^ktons$/i, u: 'kt', seg: 'steel', en: 'Steel shipments — domestic', row: 13 },
        { k: 'steel.vol.exp', sec: 'steel', lab: /^Exports$/i, unit: /^ktons$/i, u: 'kt', seg: 'steel', en: 'Steel shipments — exports', row: 14 },
        { k: 'steel.vol', sec: 'steel', lab: /^Total$/i, unit: /^ktons$/i, u: 'kt', std: 'sales_volume', def: 'steel_kt', seg: 'steel', head: true, req: true, en: 'Steel shipments', row: 15 },
        { k: 'steel.rev.dom', sec: 'steel', lab: /^Dom\. Mkt$/i, unit: /^BRL m$/i, u: 'BRL_mn', seg: 'steel', en: 'Steel revenue — domestic', row: 25 },
        { k: 'steel.rev.exp', sec: 'steel', lab: /^Exports$/i, unit: /^BRL m$/i, u: 'BRL_mn', seg: 'steel', en: 'Steel revenue — exports', row: 26 },
        { k: 'steel.rev', sec: 'steel', lab: /^\(=\) Steel Revenues$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'steel', en: 'Revenue — Steel', row: 27 },
        { k: 'steel.cogs', sec: 'steel', lab: /^\(-\) Total COGs$/i, u: 'BRL_mn', seg: 'steel', en: 'COGS — Steel', row: 29 },
        { k: 'steel.gross_profit', sec: 'steel', lab: /^\(=\) Gross Profit$/i, u: 'BRL_mn', seg: 'steel', en: 'Gross profit — Steel', row: 36 },
        { k: 'steel.sga', sec: 'steel', lab: /^\(-\) SG&A Expenses$/i, u: 'BRL_mn', seg: 'steel', en: 'SG&A — Steel', row: 38 },
        { k: 'steel.da', sec: 'steel', lab: /^\(\+\) Depreciation$/i, u: 'BRL_mn', sign: 'pos', seg: 'steel', en: 'D&A — Steel', row: 42 },
        { k: 'steel.ebitda', sec: 'steel', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'steel', en: 'EBITDA — Steel', row: 43 },
        { k: 'mining.vol', sec: 'mining', lab: /^Total$/i, unit: /^m tons$/i, u: 'Mt', std: 'sales_volume', def: 'iron_ore_mt', seg: 'mining', en: 'Iron ore sales', row: 50 },
        { k: 'mining.rev', sec: 'mining', lab: /^\(=\) Mining Revenues$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'mining', en: 'Revenue — Mining', row: 60 },
        { k: 'mining.cogs', sec: 'mining', lab: /^\(-\) Total COGs$/i, u: 'BRL_mn', seg: 'mining', en: 'COGS — Mining', row: 62 },
        { k: 'mining.gross_profit', sec: 'mining', lab: /^\(=\) Gross Profit$/i, u: 'BRL_mn', seg: 'mining', en: 'Gross profit — Mining', row: 67 },
        { k: 'mining.sga', sec: 'mining', lab: /^\(-\) SG&A Expenses$/i, u: 'BRL_mn', seg: 'mining', en: 'SG&A — Mining', row: 69 },
        { k: 'mining.da', sec: 'mining', lab: /^\(\+\) Depreciation$/i, u: 'BRL_mn', sign: 'pos', seg: 'mining', en: 'D&A — Mining', row: 73 },
        { k: 'mining.ebitda', sec: 'mining', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'mining', en: 'EBITDA — Mining', row: 74 },
        { k: 'ebitda.jv', sec: 'cons', lab: /^\(\+\) EBITDA \(% Stake in JVs\)$/i, u: 'BRL_mn', en: 'EBITDA — share of JVs', row: 108 },
        { k: 'ebitda.asset_sales', sec: 'cons', lab: /^\(\+\) Net Book Value of Asset Sold$/i, u: 'BRL_mn', en: 'EBITDA adjustment — book value of assets sold', row: 109 },
        { k: 'd_a', sec: 'dep', lab: /^Total Depreciation$/i, u: 'BRL_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 116 },
        { k: 'revenue', sec: 'is', lab: /^\(=\) Net Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 126 },
        { k: 'cogs', sec: 'is', lab: /^\(-\) Total COGs$/i, u: 'BRL_mn', en: 'COGS', row: 127 },
        { k: 'gross_profit', sec: 'is', lab: /^\(=\) Gross Profit$/i, u: 'BRL_mn', en: 'Gross profit', row: 130 },
        { k: 'sga', sec: 'is', lab: /^\(-\) SG&A Expenses$/i, u: 'BRL_mn', en: 'SG&A', row: 131 },
        { k: 'other_opex', sec: 'is', lab: /^\(\+\/-\) Other Operating Expenses$/i, u: 'BRL_mn', en: 'Other operating expenses', row: 135 },
        { k: 'ebit', sec: 'is', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 136 },
        { k: 'fin_result', sec: 'is', lab: /^\(\+\/-\) Net Financial Result$/i, u: 'BRL_mn', en: 'Net financial result', row: 137 },
        { k: 'equity_income', sec: 'is', lab: /^\(\+\/-\) Equity Income$/i, u: 'BRL_mn', en: 'Equity income', row: 142 },
        { k: 'ebt', sec: 'is', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 143 },
        { k: 'taxes', sec: 'is', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 144 },
        { k: 'minorities', sec: 'is', lab: /^\(-\) Minority Interest$/i, u: 'BRL_mn', en: 'Minority interests', row: 146 },
        { k: 'net_income', sec: 'is', lab: /^\(=\) Net Income \(ex\. Min\)$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 147 },
        { k: 'adj_ebitda', sec: 'is', lab: /^Adjusted EBITDA$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 149 },
        { k: 'gross_debt', sec: 'is', lab: /^Total Debt$/i, u: 'BRL_mn', agg: 'stock', en: 'Gross debt', row: 152 },
        { k: 'cash', sec: 'is', lab: /^Cash$/i, u: 'BRL_mn', agg: 'stock', en: 'Cash', row: 153 },
        { k: 'net_debt', sec: 'is', lab: /^Net Debt$/i, u: 'BRL_mn', std: 'net_debt', head: true, en: 'Net debt', row: 154 },
        { k: 'steel.px', calc: { op: 'per_unit', a: 'steel.rev', b: 'steel.vol', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'steel_brazil_brl', seg: 'steel', en: 'Steel realized price' },
        { k: 'steel.px.dom', calc: { op: 'per_unit', a: 'steel.rev.dom', b: 'steel.vol.dom', scale: 1000 }, u: 'BRL/t', seg: 'steel', en: 'Steel realized price — domestic' },
        { k: 'steel.px.exp', calc: { op: 'per_unit', a: 'steel.rev.exp', b: 'steel.vol.exp', scale: 1000 }, u: 'BRL/t', seg: 'steel', en: 'Steel realized price — exports' },
        { k: 'mining.px', calc: { op: 'div', a: 'mining.rev', b: 'mining.vol' }, u: 'BRL/t', std: 'realized_price', def: 'iron_ore_brl', seg: 'mining', en: 'Iron ore realized price' },
        { k: 'steel.ebitda_t', calc: { op: 'per_unit', a: 'steel.ebitda', b: 'steel.vol', scale: 1000 }, u: 'BRL/t', seg: 'steel', en: 'Steel EBITDA per tonne' }
      ],
      derived: [
        { k: 'chk.margin', sec: 'is', lab: /^EBITDA Margin$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' } },
        { k: 'chk.px.steel.dom', sec: 'steel', lab: /^Dom\. Mkt$/i, unit: /^BRL\/ton$/i, calc: { op: 'per_unit', a: 'steel.rev.dom', b: 'steel.vol.dom', scale: 1000 } },
        { k: 'chk.px.mining', sec: 'mining', lab: /^Avg IO Realization Price$/i, calc: { op: 'div', a: 'mining.rev', b: 'mining.vol' } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // Ternium — US$, sem robô (CVM/SEC não têm o trimestre estruturado): a âncora é a receita do release,
  // digitada no /admin. Custo e resultado por segmento só existem desde 1Q23 (consolidação da Usiminas).
  MANIFESTS.push({
    id: 'TX', v: 1, file: /^Ternium/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 4, firstCol: 'D', firstQ: '2013Q1',
      sections: [
        ['steel', /^STEEL$/], ['steel2', /^Revenue per ton \(By Segment\)$/i], ['mining', /^MINING$/],
        ['cons', /^CONSOLIDATED$/], ['is', /^INCOME STATEMENT$/]
      ],
      exclude: [
        { cls: 'derived', sec: 'steel2', lab: /./, unit: /\/ton$/i },
        { cls: 'derived', lab: /Revs\/ton$|Cash Opex\/ton$|as % of sales/i },
        { cls: 'dup', sec: 'steel2', lab: /^\(=\) Steel Opex$|^Depreciation$/i },
        { cls: 'dup', sec: 'mining', lab: /^\(=\) Mining Opex$|^Depreciation$/i },
        { cls: 'dup', sec: 'cons', lab: /^(Steel Revenues|Other Steel Revenues|Mining Revenues|\(\+\/-\) Eliminations|\(-\) OPEX|\(\+\) Others|\(\+\) Unigal)$/i },
        { cls: 'dup', sec: 'is', lab: /^\(=\) Operating Income$/i }
      ],
      rows: [
        { k: 'steel.vol', sec: 'steel', lab: /^Volumes$/i, unit: /^ktons$/i, u: 'kt', std: 'sales_volume', def: 'steel_kt', seg: 'steel', head: true, req: true, en: 'Steel shipments', row: 8 },
        { k: 'vol.mx', sec: 'steel', lab: /^Mexico$/i, unit: /^ktons$/i, u: 'kt', seg: 'mexico', en: 'Steel shipments — Mexico', row: 9 },
        { k: 'vol.br', sec: 'steel', lab: /^Brazil$/i, unit: /^ktons$/i, u: 'kt', seg: 'brazil', en: 'Steel shipments — Brazil', row: 10 },
        { k: 'vol.south', sec: 'steel', lab: /^Southern Region$/i, unit: /^ktons$/i, u: 'kt', seg: 'southern_region', en: 'Steel shipments — Southern Region', row: 11 },
        { k: 'vol.other', sec: 'steel', lab: /^Other Markets$/i, unit: /^ktons$/i, u: 'kt', seg: 'other_markets', en: 'Steel shipments — other markets', row: 12 },
        { k: 'rev.mx', sec: 'steel2', lab: /^Mexico$/i, unit: /^USD m$/i, u: 'USD_mn', seg: 'mexico', en: 'Steel revenue — Mexico', row: 21 },
        { k: 'rev.br', sec: 'steel2', lab: /^Brazil$/i, unit: /^USD m$/i, u: 'USD_mn', seg: 'brazil', en: 'Steel revenue — Brazil', row: 22 },
        { k: 'rev.south', sec: 'steel2', lab: /^Southern Region$/i, unit: /^USD m$/i, u: 'USD_mn', seg: 'southern_region', en: 'Steel revenue — Southern Region', row: 23 },
        { k: 'rev.other', sec: 'steel2', lab: /^Other Markets$/i, unit: /^USD m$/i, u: 'USD_mn', seg: 'other_markets', en: 'Steel revenue — other markets', row: 24 },
        { k: 'steel.rev.products', sec: 'steel2', lab: /^\(=\) Steel Product Revenues$/i, u: 'USD_mn', seg: 'steel', en: 'Steel product revenue', row: 25 },
        { k: 'steel.rev.other', sec: 'steel2', lab: /^Other Steel Revenues$/i, u: 'USD_mn', seg: 'steel', en: 'Other steel revenue', row: 26 },
        { k: 'steel.rev', sec: 'steel2', lab: /^\(=\) Total Steel Segment Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'steel', en: 'Revenue — Steel', row: 27 },
        { k: 'steel.cash_opex', sec: 'steel2', lab: /^Steel Cash Opex$/i, u: 'USD_mn', sign: 'pos', seg: 'steel', en: 'Steel cash opex', row: 31 },
        { k: 'steel.op_income', sec: 'steel2', lab: /^\(=\) Steel Operating Income$/i, u: 'USD_mn', seg: 'steel', en: 'Operating income — Steel', row: 34 },
        { k: 'steel.da', sec: 'steel2', lab: /^\(-\) Depreciation$/i, u: 'USD_mn', sign: 'pos', seg: 'steel', en: 'D&A — Steel', row: 36 },
        { k: 'steel.ebitda', sec: 'steel2', lab: /^\(=\) Steel Cash Operating Income$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'steel', en: 'EBITDA — Steel', row: 40 },
        { k: 'mining.vol', sec: 'mining', lab: /^Volumes$/i, unit: /^ktons$/i, u: 'Mt', mult: 0.001, std: 'sales_volume', def: 'iron_ore_mt', seg: 'mining', en: 'Iron ore shipments', row: 45 },
        { k: 'mining.vol.third', sec: 'mining', lab: /^Third Parties Volumes$/i, u: 'Mt', mult: 0.001, seg: 'mining', en: 'Iron ore shipments — third parties', row: 46 },
        { k: 'mining.vol.interco', sec: 'mining', lab: /^Intercompany Volumes$/i, u: 'Mt', mult: 0.001, seg: 'mining', en: 'Iron ore shipments — intercompany', row: 47 },
        { k: 'mining.rev', sec: 'mining', lab: /^\(=\) Mining Segment Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'mining', en: 'Revenue — Mining', row: 53 },
        { k: 'mining.rev.third', sec: 'mining', lab: /^Third Parties Net Revenue$/i, u: 'USD_mn', seg: 'mining', en: 'Mining revenue — third parties', row: 54 },
        { k: 'mining.rev.interco', sec: 'mining', lab: /^Intercompany Net Revenue$/i, u: 'USD_mn', seg: 'mining', en: 'Mining revenue — intercompany', row: 55 },
        { k: 'mining.cash_opex', sec: 'mining', lab: /^Mining Cash Opex$/i, u: 'USD_mn', sign: 'pos', seg: 'mining', en: 'Mining cash opex', row: 59 },
        { k: 'mining.op_income', sec: 'mining', lab: /^\(=\) ?Mining Operating Income$/i, u: 'USD_mn', seg: 'mining', en: 'Operating income — Mining', row: 62 },
        { k: 'mining.da', sec: 'mining', lab: /^\(-\) Depreciation$/i, u: 'USD_mn', sign: 'pos', seg: 'mining', en: 'D&A — Mining', row: 64 },
        { k: 'mining.ebitda', sec: 'mining', lab: /^\(=\) Mining Cash Operating Income$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'mining', en: 'EBITDA — Mining', row: 67 },
        { k: 'revenue', sec: 'cons', lab: /^\(=\) Revenues$/i, u: 'USD_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 70 },
        { k: 'cogs', sec: 'cons', lab: /^\(-\) COGs$/i, u: 'USD_mn', en: 'COGS', row: 77 },
        { k: 'gross_profit', sec: 'cons', lab: /^\(=\) Gross Profit$/i, u: 'USD_mn', en: 'Gross profit', row: 78 },
        { k: 'sga', sec: 'cons', lab: /^\(-\) SG&A Expenses$/i, u: 'USD_mn', en: 'SG&A', row: 79 },
        { k: 'other_opex', sec: 'cons', lab: /^\(\+\/-\) Other Op\. Revs\/Expenses$/i, u: 'USD_mn', en: 'Other operating income/expenses', row: 81 },
        { k: 'ebit', sec: 'cons', lab: /^\(=\) Operating Income$/i, u: 'USD_mn', std: 'ebit', en: 'Operating income', row: 83 },
        { k: 'd_a', sec: 'cons', lab: /^\(\+\) Depreciation$/i, u: 'USD_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 84 },
        { k: 'adj_ebitda', sec: 'cons', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 87 },
        { k: 'interest_exp', sec: 'is', lab: /^\(-\) Interest Expense$/i, u: 'USD_mn', en: 'Interest expense', row: 91 },
        { k: 'interest_inc', sec: 'is', lab: /^\(\+\) Interest Income$/i, u: 'USD_mn', en: 'Interest income', row: 92 },
        { k: 'other_fin', sec: 'is', lab: /^\(\+\/-\) Other financial/i, u: 'USD_mn', en: 'Other financial items', row: 93 },
        { k: 'equity_income', sec: 'is', lab: /^\(\+\/-\) Equity income$/i, u: 'USD_mn', en: 'Equity income', row: 94 },
        { k: 'ebt', sec: 'is', lab: /^\(=\) Income Before Taxes$/i, u: 'USD_mn', en: 'Pre-tax income', row: 95 },
        { k: 'taxes', sec: 'is', lab: /^\(-\) Income Taxes$/i, u: 'USD_mn', en: 'Income taxes', row: 96 },
        { k: 'net_income_total', sec: 'is', lab: /^\(=\) Net Income$/i, u: 'USD_mn', en: 'Net income (incl. minorities)', row: 98 },
        { k: 'minorities', sec: 'is', lab: /^\(-\) Non-Controlling Interest$/i, u: 'USD_mn', en: 'Minority interests', row: 99 },
        { k: 'net_income', sec: 'is', lab: /^\(=\) Net Income \(excl\. minority int\.\)$/i, u: 'USD_mn', std: 'net_income', head: true, en: 'Net income', row: 100 },
        { k: 'shares', sec: 'is', lab: /# of Shares$/i, u: 'mn_sh', agg: 'stock', en: 'Shares outstanding', row: 101 },
        { k: 'eps', sec: 'is', lab: /^\(=\) EPS$/i, u: 'USD/ADS', agg: 'flow', en: 'EPS (per ADS)', row: 102 },
        { k: 'steel.px', calc: { op: 'per_unit', a: 'steel.rev.products', b: 'steel.vol', scale: 1000 }, u: 'USD/t', std: 'realized_price', def: 'steel_usd', seg: 'steel', en: 'Steel revenue per tonne' },
        { k: 'px.mx', calc: { op: 'per_unit', a: 'rev.mx', b: 'vol.mx', scale: 1000 }, u: 'USD/t', seg: 'mexico', en: 'Revenue per tonne — Mexico' },
        { k: 'px.br', calc: { op: 'per_unit', a: 'rev.br', b: 'vol.br', scale: 1000 }, u: 'USD/t', seg: 'brazil', en: 'Revenue per tonne — Brazil' },
        { k: 'px.south', calc: { op: 'per_unit', a: 'rev.south', b: 'vol.south', scale: 1000 }, u: 'USD/t', seg: 'southern_region', en: 'Revenue per tonne — Southern Region' },
        { k: 'px.other', calc: { op: 'per_unit', a: 'rev.other', b: 'vol.other', scale: 1000 }, u: 'USD/t', seg: 'other_markets', en: 'Revenue per tonne — other markets' },
        { k: 'steel.cash_cost_t', calc: { op: 'per_unit', a: 'steel.cash_opex', b: 'steel.vol', scale: 1000 }, u: 'USD/t', std: 'cash_cost', def: 'steel_cash_opex_usd_t', seg: 'steel', en: 'Steel cash opex per tonne' },
        { k: 'mining.px.third', calc: { op: 'div', a: 'mining.rev.third', b: 'mining.vol.third' }, u: 'USD/t', std: 'realized_price', def: 'iron_ore_third_usd', seg: 'mining', en: 'Iron ore price — third parties' },
        { k: 'steel.ebitda_t', calc: { op: 'per_unit', a: 'steel.ebitda', b: 'steel.vol', scale: 1000 }, u: 'USD/t', seg: 'steel', en: 'Steel EBITDA per tonne' }
      ],
      derived: [
        { k: 'chk.px.mx', sec: 'steel2', lab: /^Mexico$/i, unit: /^USD\/ton$/i, calc: { op: 'per_unit', a: 'rev.mx', b: 'vol.mx', scale: 1000 } },
        { k: 'chk.cash_t', sec: 'steel2', lab: /^Steel Cash Opex\/ton$/i, calc: { op: 'per_unit', a: 'steel.cash_opex', b: 'steel.vol', scale: -1000 } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'gold', tol: 0.002, hard: true }
    ]
  });

  // CSN Mineração — o 2Q26 está rotulado '2Q25a'. Fora: preço spot (pago e projeção), custo de compra de
  // terceiros (modelado a partir do preço realizado) e o "Other Cash COGS" (resíduo).
  MANIFESTS.push({
    id: 'CMIN3', v: 1, file: /^CMIN_Quart/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Simplified Preview Model$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 5, firstCol: 'D', firstQ: '2020Q1',
      sections: [['mkt', /^MINING SEGMENT$/i], ['mining', /^MINING SEGMENT$/i], ['nfr', /^NET FINANCIAL RESULTS$/i]],
      exclude: [
        { cls: 'paid', lab: /Spot Price/i },
        { cls: 'assumption', lab: /Third Party (Cash )?Cost/i },
        { cls: 'plug', lab: /Other Cash COG/i },
        { cls: 'derived', lab: /Realization Price|Cash Cost\/ton|Margin|EBITDA\/ton|Effective Tax Rate|^Total C1 Costs$/i },
        { cls: 'derived', sec: 'mining', lab: /^\(-\) C1 Cash Cost$/i, unit: /^BRL\/ton$/i },
        { cls: 'dup', sec: 'mining', lab: /^Total$/i },
        { cls: 'dup', sec: 'nfr', lab: /./ }
      ],
      rows: [
        { k: 'fx.avg', lab: /^BRL Avg$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 6 },
        { k: 'fx.eop', lab: /^BRL EOP$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 7 },
        { k: 'vol.dom', sec: 'mkt', lab: /^Domestic Market$/i, unit: /^m tons$/i, u: 'Mt', en: 'Iron ore sales — domestic', row: 13 },
        { k: 'vol.exp', sec: 'mkt', lab: /^Exports$/i, unit: /^m tons$/i, u: 'Mt', en: 'Iron ore sales — exports', row: 14 },
        { k: 'vol', sec: 'mkt', lab: /^Total$/i, unit: /^m tons$/i, u: 'Mt', std: 'sales_volume', def: 'iron_ore_mt', head: true, req: true, en: 'Iron ore sales', row: 15 },
        { k: 'vol.third', sec: 'mining', lab: /^Third Party$/i, unit: /^m tons$/i, u: 'Mt', en: 'Iron ore sales — third-party purchases', row: 20 },
        { k: 'revenue', sec: 'mining', lab: /^\(=\) Mining Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 34 },
        { k: 'freight', sec: 'mining', lab: /^\(-\) Freight and Insurance$/i, u: 'BRL_mn', en: 'Freight and insurance', row: 36 },
        { k: 'revenue.fob', sec: 'mining', lab: /^\(=\) Mining Revenues FOB Basis$/i, u: 'BRL_mn', en: 'Net revenue — FOB basis', row: 38 },
        { k: 'cash_cogs', sec: 'mining', lab: /^\(-\) Total Cash COGs$/i, u: 'BRL_mn', en: 'Cash COGS', row: 40 },
        { k: 'c1_t', sec: 'mining', lab: /^\(-\) C1 Cash Cost$/i, unit: /^USD\/ton$/i, u: 'USD/t', std: 'cash_cost', def: 'iron_ore_c1_usd_t', agg: 'rate', head: true, en: 'C1 cash cost', row: 45 },
        { k: 'da.cogs', sec: 'mining', lab: /^\(\+\) COGS Depreciation$/i, u: 'BRL_mn', en: 'D&A in COGS', row: 58 },
        { k: 'gross_profit', sec: 'mining', lab: /^\(=\) Gross Profit$/i, u: 'BRL_mn', en: 'Gross profit', row: 61 },
        { k: 'sga', sec: 'mining', lab: /^\(-\) SG&A$/i, u: 'BRL_mn', en: 'SG&A', row: 63 },
        { k: 'adj_ebitda', sec: 'mining', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 67 },
        { k: 'other_opex', sec: 'mining', lab: /^\(-\) Other Operational Expenses$/i, u: 'BRL_mn', en: 'Other operating expenses', row: 71 },
        { k: 'd_a', sec: 'mining', lab: /^\(-\) Depreciation$/i, u: 'BRL_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 72 },
        { k: 'ebit', sec: 'mining', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 74 },
        { k: 'fin_result', sec: 'mining', lab: /^\(\+\/-\) Net Financial Result$/i, u: 'BRL_mn', en: 'Net financial result', row: 75 },
        { k: 'equity_income', sec: 'mining', lab: /^\(\+\/-\) Equity Income$/i, u: 'BRL_mn', en: 'Equity income', row: 79 },
        { k: 'ebt', sec: 'mining', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 80 },
        { k: 'taxes', sec: 'mining', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 81 },
        { k: 'minorities', sec: 'mining', lab: /^\(-\) Minority Interest$/i, u: 'BRL_mn', en: 'Minority interests', row: 83 },
        { k: 'net_income', sec: 'mining', lab: /^\(=\) Net Income$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 84 },
        { k: 'gross_debt', sec: 'mining', lab: /^Total Debt$/i, u: 'BRL_mn', agg: 'stock', en: 'Gross debt', row: 87 },
        { k: 'cash', sec: 'mining', lab: /^Cash$/i, u: 'BRL_mn', agg: 'stock', en: 'Cash', row: 88 },
        { k: 'net_debt', sec: 'mining', lab: /^Net Debt$/i, u: 'BRL_mn', std: 'net_debt', head: true, en: 'Net debt', row: 89 },
        { k: 'vol.own', calc: { op: 'sub', a: 'vol', b: 'vol.third' }, u: 'Mt', agg: 'flow', en: 'Iron ore sales — own production' },
        { k: 'px', calc: { op: 'div', a: 'revenue', b: 'vol' }, u: 'BRL/t', std: 'realized_price', def: 'iron_ore_brl', head: true, en: 'Iron ore realized price (CFR/FOB)' },
        { k: 'px.fob', calc: { op: 'div', a: 'revenue.fob', b: 'vol' }, u: 'BRL/t', def: 'iron_ore_fob_brl', en: 'Iron ore realized price (FOB)' }
      ],
      derived: [
        { k: 'chk.margin', sec: 'mining', lab: /^EBITDA Margin$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' } },
        { k: 'chk.px', sec: 'mining', lab: /^CFR\/FOB Avg IO Realization Price$/i, unit: /^BRL\/ton$/i, calc: { op: 'div', a: 'revenue', b: 'vol' } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // Vale — US$ desde 1Q21. Fora: índices LME/LBMA ("PRICES INDEX"), prêmios/descontos contra referência,
  // e frete/t + % CFR (no 2Q26 a fórmula do modelo lê a coluna do 3Q26E). Rótulo repete muito (Nickel,
  // Copper, Fines) → seção + after/nth. A CVM é em R$: a receita confere × PTAX, com folga de conversão.
  MANIFESTS.push({
    id: 'VALE3', v: 1, file: /^Vale_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview Model$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 4, firstCol: 'D', firstQ: '2021Q1',
      sections: [
        ['macro', /^MACRO DATA$/], ['ferrous', /^FERROUS$/], ['f_ship', /^SHIPMENTS$/], ['f_px', /^REALIZED PRICES$/],
        ['f_cost', /^\(-\) Cash Costs$/], ['base', /^BASE METALS$/], ['b_vol', /^VOLUMES$/], ['b_px', /^REALIZED PRICES$/],
        ['b_idx', /^PRICES INDEX$/], ['b_cost', /^\(-\) Cash Costs$/], ['others', /^OTHERS$/], ['cons', /^CONSOLIDATED$/]
      ],
      exclude: [
        { cls: 'paid', sec: 'b_idx', lab: /./ },
        { cls: 'paid', lab: /Discount to|Premium|Timing and Pricing|TC\/RCs/i },
        { cls: 'derived', sec: 'f_px', lab: /./ }, { cls: 'derived', sec: 'b_px', lab: /./ },
        { cls: 'derived', sec: 'f_cost', lab: /^Cash Costs\/ton$|^C1 \(Incl\. Third-Party Purchase\)\/ton$|^C1\/ton \(Third-Party\)$|^Third-Party Costs$|per Ton$|^CFR Sales$|^Royalties Rate$|^Production Cost\/ton$/i },
        { cls: 'derived', lab: /^% of Revenue$|\(%\)$|^% of (cash|debt)$/i },
        { cls: 'dup', sec: 'cons', lab: /^Interest (Income|Expense)$|^\(-\) (Cash Costs|SG&A|R&D Expenses|Pre-Op Expenses|Streaming Adjustment|EBITDA JV's)$|^\(\+\) (JV's EBITDA|Streaming Adjustment)$|^(Ferrous|Fines|Pellet|Other|Base Metals|Nickel|Copper)$/i }
      ],
      // aberturas por produto que ficam só no modelo (despesas por produto, subprodutos, detalhe do corporativo)
      skip: [
        { sec: 'ferrous', lab: /^(Rom|Others)$/i },
        { sec: 'f_cost', lab: /^(Fines|Pellet|Other Ferrous|Others)$/i },
        { sec: 'base', lab: /^(Other By-Products|PPA Adjustments|Silver|Other Base Metals)$/i },
        { sec: 'b_vol', lab: /Segment\)$/i },
        { sec: 'b_cost', lab: /^(Nickel|Copper|Other|Other Base Metals|Cash Costs\/ton|By-Product Revenues \(ex\. PPA\)|Other Expenses|EBITDA from Associates & JVs)$/i },
        { sec: 'others', lab: /./ },
        { sec: 'cons', lab: /^\(=\) Proforma EBITDA$/i }
      ],
      rows: [
        { k: 'fx.avg', sec: 'macro', lab: /^FX Avg$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 5 },
        { k: 'fx.eop', sec: 'macro', lab: /^FX EOP$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 6 },
        { k: 'ferrous.rev', sec: 'ferrous', lab: /^\(=\) Net Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'ferrous', en: 'Revenue — Iron Ore Solutions', row: 10 },
        { k: 'ferrous.rev.fines', sec: 'ferrous', lab: /^Fines$/i, u: 'USD_mn', seg: 'fines', en: 'Revenue — iron ore fines', row: 11 },
        { k: 'ferrous.rev.pellets', sec: 'ferrous', lab: /^Pellet$/i, u: 'USD_mn', seg: 'pellets', en: 'Revenue — pellets', row: 12 },
        { k: 'ferrous.rev.other', sec: 'ferrous', lab: /^Other Ferrous$/i, u: 'USD_mn', seg: 'other_ferrous', en: 'Revenue — other ferrous', row: 13 },
        { k: 'ferrous.vol', sec: 'f_ship', lab: /^TOTAL$/, u: 'Mt', en: 'Iron ore shipments (fines, ROM and pellets)', row: 18 },
        { k: 'ferrous.vol.fines', sec: 'f_ship', lab: /^Fines$/i, u: 'Mt', std: 'sales_volume', def: 'iron_ore_mt', seg: 'fines', head: true, req: true, en: 'Iron ore fines shipments', row: 19 },
        { k: 'ferrous.vol.fines.own', sec: 'f_ship', lab: /^Own Production$/i, u: 'Mt', seg: 'fines', en: 'Fines shipments — own production', row: 20 },
        { k: 'ferrous.vol.fines.third', sec: 'f_ship', lab: /^Third-Party Purchase$/i, u: 'Mt', seg: 'fines', en: 'Fines shipments — third-party purchases', row: 21 },
        { k: 'ferrous.vol.rom', sec: 'f_ship', lab: /^ROM$/i, u: 'Mt', seg: 'other_ferrous', en: 'ROM shipments', row: 22 },
        { k: 'ferrous.vol.pellets', sec: 'f_ship', lab: /^Pellets$/i, u: 'Mt', std: 'sales_volume', def: 'iron_ore_pellets_mt', seg: 'pellets', en: 'Pellet shipments', row: 23 },
        { k: 'ferrous.cash_cost', sec: 'f_cost', lab: /^\(-\) Cash Costs$/i, u: 'USD_mn', seg: 'ferrous', en: 'Cash costs — Iron Ore Solutions', row: 30 },
        { k: 'fines.cash_cost', sec: 'f_cost', lab: /^Fines$/i, nth: 0, u: 'USD_mn', seg: 'fines', en: 'Cash costs — fines', row: 32 },
        { k: 'fines.c1_incl', sec: 'f_cost', lab: /^C1 \(Incl\. Third-Party Purchase\)$/i, u: 'USD_mn', seg: 'fines', en: 'C1 cash cost incl. third-party purchases', row: 35 },
        { k: 'fines.c1_excl', sec: 'f_cost', lab: /^C1 \(Excl\. Third-Party\)$/i, u: 'USD_mn', seg: 'fines', en: 'C1 cash cost excl. third-party purchases', row: 38 },
        { k: 'fines.c1_t', sec: 'f_cost', lab: /^C1\/ton \(Excl\. Third-Party\)$/i, u: 'USD/t', sign: 'pos', std: 'cash_cost', def: 'iron_ore_c1_usd_t', agg: 'rate', seg: 'fines', head: true, en: 'C1 cash cost (ex third-party)', row: 39 },
        { k: 'fines.third_cost', sec: 'f_cost', lab: /^Third-Party Purchases Cost$/i, u: 'USD_mn', seg: 'fines', en: 'Third-party purchase costs', row: 41 },
        { k: 'fines.freight', sec: 'f_cost', lab: /^Freight$/i, u: 'USD_mn', seg: 'fines', en: 'Maritime freight costs', row: 46 },
        { k: 'fines.distribution', sec: 'f_cost', lab: /^Distribution$/i, u: 'USD_mn', seg: 'fines', en: 'Distribution costs', row: 50 },
        { k: 'fines.royalties', sec: 'f_cost', lab: /^Royalties$/i, u: 'USD_mn', seg: 'fines', en: 'Royalties', row: 53 },
        { k: 'pellets.cash_cost', sec: 'f_cost', lab: /^Pellet$/i, nth: 0, u: 'USD_mn', seg: 'pellets', en: 'Cash costs — pellets', row: 56 },
        { k: 'ferrous.sga', sec: 'f_cost', lab: /^\(-\) SG&A$/i, u: 'USD_mn', seg: 'ferrous', en: 'SG&A — Iron Ore Solutions', row: 61 },
        { k: 'ferrous.rd', sec: 'f_cost', lab: /^\(-\) R&D Expenses$/i, u: 'USD_mn', seg: 'ferrous', en: 'R&D — Iron Ore Solutions', row: 67 },
        { k: 'ferrous.preop', sec: 'f_cost', lab: /^\(-\) Pre-Op Expenses$/i, u: 'USD_mn', seg: 'ferrous', en: 'Pre-operating expenses — Iron Ore Solutions', row: 73 },
        { k: 'ferrous.jv', sec: 'f_cost', lab: /^\(\+\) JV's EBITDA$/i, u: 'USD_mn', seg: 'ferrous', en: "JVs' EBITDA — Iron Ore Solutions", row: 78 },
        { k: 'ferrous.ebitda', sec: 'f_cost', lab: /^\(=\) Adjusted EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'ferrous', en: 'Adjusted EBITDA — Iron Ore Solutions', row: 83 },
        { k: 'fines.ebitda', sec: 'f_cost', lab: /^Fines$/i, after: /^\(=\) Adjusted EBITDA$/i, nth: 0, u: 'USD_mn', std: 'segment_ebitda', seg: 'fines', en: 'Adjusted EBITDA — fines', row: 84 },
        { k: 'pellets.ebitda', sec: 'f_cost', lab: /^Pellet$/i, after: /^\(=\) Adjusted EBITDA$/i, nth: 0, u: 'USD_mn', std: 'segment_ebitda', seg: 'pellets', en: 'Adjusted EBITDA — pellets', row: 85 },
        { k: 'ferrous_other.ebitda', sec: 'f_cost', lab: /^Others$/i, after: /^\(=\) Adjusted EBITDA$/i, nth: 0, u: 'USD_mn', seg: 'other_ferrous', en: 'Adjusted EBITDA — other ferrous', row: 86 },
        { k: 'base.rev', sec: 'base', lab: /^\(=\) Net Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'base_metals', en: 'Revenue — Energy Transition Metals', row: 90 },
        { k: 'base.rev.nickel_seg', sec: 'base', lab: /^Nickel$/i, nth: 0, u: 'USD_mn', seg: 'nickel', en: 'Revenue — Nickel segment', row: 91 },
        { k: 'base.rev.nickel', sec: 'base', lab: /^Nickel$/i, nth: 1, u: 'USD_mn', seg: 'nickel', en: 'Nickel revenue (nickel product)', row: 92 },
        { k: 'base.rev.nickel.copper', sec: 'base', lab: /^Copper$/i, nth: 0, u: 'USD_mn', seg: 'nickel', en: 'Copper by-product revenue — Nickel segment', row: 93 },
        { k: 'base.rev.nickel.gold', sec: 'base', lab: /^Gold$/i, nth: 0, u: 'USD_mn', seg: 'nickel', en: 'Gold by-product revenue — Nickel segment', row: 94 },
        { k: 'base.rev.copper_seg', sec: 'base', lab: /^Copper$/i, nth: 1, u: 'USD_mn', seg: 'copper', en: 'Revenue — Copper segment', row: 97 },
        { k: 'base.rev.copper', sec: 'base', lab: /^Copper$/i, nth: 2, u: 'USD_mn', seg: 'copper', en: 'Copper revenue (copper product)', row: 98 },
        { k: 'base.rev.copper.gold', sec: 'base', lab: /^Gold$/i, nth: 1, u: 'USD_mn', seg: 'copper', en: 'Gold by-product revenue — Copper segment', row: 99 },
        { k: 'base.vol.nickel', sec: 'b_vol', lab: /^Nickel$/i, u: 'kt', std: 'sales_volume', def: 'nickel_kt', seg: 'nickel', en: 'Nickel sales', row: 105 },
        { k: 'base.vol.copper', sec: 'b_vol', lab: /^Copper$/i, u: 'kt', std: 'sales_volume', def: 'copper_kt', seg: 'copper', en: 'Copper sales', row: 106 },
        { k: 'base.vol.gold', sec: 'b_vol', lab: /^Gold$/i, u: 'koz', std: 'sales_volume', def: 'gold_koz', seg: 'copper', en: 'Gold sales (by-product)', row: 109 },
        { k: 'base.cash_cost', sec: 'b_cost', lab: /^\(-\) Cash Costs$/i, u: 'USD_mn', seg: 'base_metals', en: 'Cash costs — Energy Transition Metals', row: 130 },
        { k: 'nickel.cash_cost', sec: 'b_cost', lab: /^Nickel$/i, nth: 0, u: 'USD_mn', seg: 'nickel', en: 'Cash costs — Nickel', row: 132 },
        { k: 'nickel.breakeven', sec: 'b_cost', lab: /^All-in costs \(EBITDA Breakeven\)$/i, nth: 0, u: 'USD/t', agg: 'rate', seg: 'nickel', en: 'Nickel EBITDA breakeven', row: 135 },
        { k: 'nickel.cash_cost_t', sec: 'b_cost', lab: /^Cash Costs\/ton$/i, nth: 1, u: 'USD/t', std: 'cash_cost', def: 'nickel_cash_cost_usd_t', agg: 'rate', seg: 'nickel', en: 'Nickel unit cash cost', row: 136 },
        { k: 'copper.cash_cost', sec: 'b_cost', lab: /^Copper$/i, nth: 0, u: 'USD_mn', seg: 'copper', en: 'Cash costs — Copper', row: 142 },
        { k: 'copper.breakeven', sec: 'b_cost', lab: /^All-in costs \(EBITDA Breakeven\)$/i, nth: 1, u: 'USD/t', agg: 'rate', seg: 'copper', en: 'Copper EBITDA breakeven', row: 145 },
        { k: 'copper.cash_cost_t', sec: 'b_cost', lab: /^Cash Costs\/ton$/i, nth: 3, u: 'USD/t', std: 'cash_cost', def: 'copper_cash_cost_usd_t', agg: 'rate', seg: 'copper', en: 'Copper unit cash cost', row: 146 },
        { k: 'base.sga', sec: 'b_cost', lab: /^\(-\) SG&A$/i, u: 'USD_mn', seg: 'base_metals', en: 'SG&A — Energy Transition Metals', row: 153 },
        { k: 'base.rd', sec: 'b_cost', lab: /^\(-\) R&D Expenses$/i, u: 'USD_mn', seg: 'base_metals', en: 'R&D — Energy Transition Metals', row: 160 },
        { k: 'base.preop', sec: 'b_cost', lab: /^\(-\) Pre-Op Expenses$/i, u: 'USD_mn', seg: 'base_metals', en: 'Pre-operating expenses — Energy Transition Metals', row: 167 },
        { k: 'base.jv', sec: 'b_cost', lab: /^\(\+\) JV's EBITDA$/i, u: 'USD_mn', seg: 'base_metals', en: "JVs' EBITDA — Energy Transition Metals", row: 172 },
        { k: 'base.streaming', sec: 'b_cost', lab: /^\(\+\) Streaming Adjustment$/i, u: 'USD_mn', seg: 'base_metals', en: 'Streaming adjustment', row: 177 },
        { k: 'base.ebitda', sec: 'b_cost', lab: /^\(=\) Adjusted EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'base_metals', en: 'Adjusted EBITDA — Energy Transition Metals', row: 182 },
        { k: 'nickel.ebitda', sec: 'b_cost', lab: /^Nickel$/i, after: /^\(=\) Adjusted EBITDA$/i, nth: 0, u: 'USD_mn', std: 'segment_ebitda', seg: 'nickel', en: 'Adjusted EBITDA — Nickel', row: 183 },
        { k: 'copper.ebitda', sec: 'b_cost', lab: /^Copper$/i, after: /^\(=\) Adjusted EBITDA$/i, nth: 0, u: 'USD_mn', std: 'segment_ebitda', seg: 'copper', en: 'Adjusted EBITDA — Copper', row: 184 },
        { k: 'others.ebitda', sec: 'others', lab: /^\(=\) Adjusted EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'corporate', en: 'Adjusted EBITDA — others', row: 195 },
        { k: 'revenue', sec: 'cons', lab: /^\(=\) Net Revenues$/i, u: 'USD_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 199 },
        { k: 'ebitda_proforma', sec: 'cons', lab: /^\(=\) Proforma EBITDA$/i, nth: 0, u: 'USD_mn', en: 'Pro forma EBITDA', row: 213 },
        { k: 'nonrecurring', sec: 'cons', lab: /^\(-\) Non-recurring expenses$/i, u: 'USD_mn', en: 'Non-recurring expenses', row: 226 },
        { k: 'provisions', sec: 'cons', lab: /^\(\+\) Provisions\/Incurred Expenses$/i, u: 'USD_mn', en: 'Provisions / incurred expenses', row: 227 },
        { k: 'adj_ebitda', sec: 'cons', lab: /^\(=\) Adjusted EBITDA$/i, u: 'USD_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 229 },
        { k: 'd_a', sec: 'cons', lab: /^\(-\) Depreciation$/i, u: 'USD_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 230 },
        { k: 'ebit_adj', sec: 'cons', lab: /^Adjusted EBIT$/i, u: 'USD_mn', en: 'Adjusted EBIT', row: 231 },
        { k: 'impairment', sec: 'cons', lab: /^\(-\) Impairment/i, u: 'USD_mn', en: 'Impairment and disposals', row: 232 },
        { k: 'ebit', sec: 'cons', lab: /^EBIT$/i, u: 'USD_mn', std: 'ebit', en: 'EBIT', row: 235 },
        { k: 'fin_income', sec: 'cons', lab: /^\(\+\) Financial Income$/i, u: 'USD_mn', en: 'Financial income', row: 236 },
        { k: 'fin_expense', sec: 'cons', lab: /^\(-\) Financial Expenses$/i, u: 'USD_mn', en: 'Financial expenses', row: 237 },
        { k: 'other_fin', sec: 'cons', lab: /^\(\+\/-\) Other Financial Items$/i, u: 'USD_mn', en: 'Other financial items', row: 238 },
        { k: 'equity_income', sec: 'cons', lab: /^\(\+\/-\) Equity Income$/i, u: 'USD_mn', en: 'Equity income', row: 239 },
        { k: 'ebt', sec: 'cons', lab: /^EBT$/i, u: 'USD_mn', en: 'Pre-tax income', row: 241 },
        { k: 'taxes', sec: 'cons', lab: /^\(-\) Income Tax$/i, u: 'USD_mn', en: 'Income taxes', row: 242 },
        { k: 'minorities', sec: 'cons', lab: /^\(\+\/-\) Minority Share$/i, u: 'USD_mn', en: 'Minority interests', row: 244 },
        { k: 'discontinued', sec: 'cons', lab: /^\(-\) Discontinued operations$/i, u: 'USD_mn', en: 'Discontinued operations', row: 246 },
        { k: 'net_income', sec: 'cons', lab: /^\(=\) Net Income$/i, u: 'USD_mn', std: 'net_income', head: true, en: 'Net income', row: 247 },
        { k: 'gross_debt', sec: 'cons', lab: /^\(=\) Total Debt \(Incl\. Lease\)$/i, u: 'USD_mn', agg: 'stock', en: 'Gross debt (incl. leases)', row: 250 },
        { k: 'cash', sec: 'cons', lab: /^\(-\) Cash$/i, u: 'USD_mn', agg: 'stock', en: 'Cash', row: 251 },
        { k: 'net_debt', sec: 'cons', lab: /^\(=\) Net debt$/i, u: 'USD_mn', std: 'net_debt', head: true, en: 'Net debt', row: 252 },
        { k: 'px.fines', calc: { op: 'div', a: 'ferrous.rev.fines', b: 'ferrous.vol.fines' }, u: 'USD/t', std: 'realized_price', def: 'iron_ore_fines_usd', seg: 'fines', head: true, en: 'Iron ore fines realized price' },
        { k: 'px.pellets', calc: { op: 'div', a: 'ferrous.rev.pellets', b: 'ferrous.vol.pellets' }, u: 'USD/t', std: 'realized_price', def: 'iron_ore_pellets_usd', seg: 'pellets', en: 'Pellets realized price' },
        { k: 'px.nickel', calc: { op: 'per_unit', a: 'base.rev.nickel', b: 'base.vol.nickel', scale: 1000 }, u: 'USD/t', std: 'realized_price', def: 'nickel_usd_t', seg: 'nickel', en: 'Nickel realized price' },
        { k: 'base.rev.copper_all', calc: { op: 'add', a: 'base.rev.nickel.copper', b: 'base.rev.copper' }, u: 'USD_mn', agg: 'flow', seg: 'copper', en: 'Copper revenue (both segments)' },
        { k: 'px.copper', calc: { op: 'per_unit', a: 'base.rev.copper_all', b: 'base.vol.copper', scale: 1000 }, u: 'USD/t', std: 'realized_price', def: 'copper_usd_t', seg: 'copper', en: 'Copper realized price' },
        { k: 'base.rev.gold_all', calc: { op: 'add', a: 'base.rev.nickel.gold', b: 'base.rev.copper.gold' }, u: 'USD_mn', agg: 'flow', seg: 'copper', en: 'Gold revenue (both segments)' },
        { k: 'px.gold', calc: { op: 'per_unit', a: 'base.rev.gold_all', b: 'base.vol.gold', scale: 1000 }, u: 'USD/oz', std: 'realized_price', def: 'gold_usd_oz', seg: 'copper', en: 'Gold realized price' }
      ],
      derived: [
        { k: 'chk.px.fines', sec: 'f_px', lab: /^Fines$/i, unit: /^USD\/ton$/i, calc: { op: 'div', a: 'ferrous.rev.fines', b: 'ferrous.vol.fines' } },
        { k: 'chk.c1', sec: 'f_cost', lab: /^C1\/ton \(Excl\. Third-Party\)$/i, calc: { op: 'div', a: 'fines.c1_excl', b: 'ferrous.vol.fines.own' } },
        { k: 'chk.px.nickel', sec: 'b_px', lab: /^Nickel$/i, calc: { op: 'per_unit', a: 'base.rev.nickel', b: 'base.vol.nickel', scale: 1000 } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.03, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.05 }
    ]
  });

  // Aura — US$. A "kGEO" do modelo é onça (15.190 = 15,2 mil oz) → mult 0,001 para koz. Fora: preços de
  // referência (índices), bloco "Discount" (distância até a referência), receita bruta e custo de produção
  // (conta do modelo: custo/oz × embarques). O EBITDA do cabeçalho é o "EBITDA Reported" da companhia.
  const AURA_MINES = [
    ['minosa', /^Minosa \(San Andres\)$/i, 'Minosa (San Andrés)'], ['apoena', /^Apoena \(EPP\)$/i, 'Apoena (EPP)'],
    ['aranzazu', /^Aranzazu$/i, 'Aranzazu'], ['almas', /^Almas$/i, 'Almas'], ['borborema', /^Borborema$/i, 'Borborema'], ['msg', /^MSG$/i, 'MSG']
  ];
  function auraMines(sec, k, base, en) {
    return AURA_MINES.map(function (m) {
      return Object.assign({ k: k + '.' + m[0], sec: sec, lab: m[1], seg: m[0], en: en + ' — ' + m[2] }, base);
    });
  }
  MANIFESTS.push({
    id: 'AUGO', v: 1, file: /^Aura_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview$/, layout: 'cols', labelCol: 'B', headerRow: 5, firstCol: 'C', firstQ: '2019Q1',
      sections: [
        ['ref', /^Reference Prices$/i], ['prod', /^Production \(GEO\)$/i], ['ship', /^Shipments \(kGEO\)$/i],
        ['cc', /^Cash Cost \(USD\/oz\)$/i], ['grev', /^Gross Revenues \(USD mn\)$/i], ['disc', /^Discount$/i],
        ['nrev', /^Net Revenues \(USD mn\)$/i], ['cop', /^Cost of Production \(USD mn\)$/i], ['pl', /^\(-\) SG&A$/i],
        ['ebitda', /^\(=\) EBITDA$/i], ['is', /^\(=\) EBITDA Reported$/i]
      ],
      exclude: [
        { cls: 'paid', sec: 'ref', lab: /./ }, { cls: 'paid', sec: 'disc', lab: /./ },
        { cls: 'derived', sec: 'grev', lab: /./ }, { cls: 'derived', sec: 'cop', lab: /./ },
        { cls: 'derived', sec: 'ebitda', lab: /^\(=\) EBITDA$/i },
        { cls: 'derived', lab: /% of Net Revenue|Effective Tax Rate|EBITDA per Oz/i },
        { cls: 'dup', sec: 'pl', lab: /^\(-\) Others$|^Other Expenses$/i }
      ],
      rows: [
        { k: 'fx.avg', lab: /^FX Rate - Avg$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 6 },
        { k: 'fx.eop', lab: /^FX Rate - EOP$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 7 }
      ].concat(
        auraMines('prod', 'prod', { u: 'koz', mult: 0.001, agg: 'flow' }, 'Gold-equivalent production'),
        [{ k: 'production', sec: 'prod', lab: /^Total Production Oz$/i, u: 'koz', mult: 0.001, std: 'production', def: 'gold_geo_koz', head: true, en: 'Gold-equivalent production', row: 21 }],
        auraMines('ship', 'ship', { u: 'koz', mult: 0.001, agg: 'flow' }, 'Gold-equivalent sales'),
        [{ k: 'shipments', sec: 'ship', lab: /^Total Shipments Oz$/i, u: 'koz', mult: 0.001, std: 'sales_volume', def: 'gold_geo_koz', en: 'Gold-equivalent sales', row: 30 }],
        auraMines('cc', 'cash_cost', { u: 'USD/oz', agg: 'rate' }, 'Cash cost'),
        [{ k: 'cash_cost', sec: 'cc', lab: /^Avg Cash Cost$/i, u: 'USD/oz', std: 'cash_cost', def: 'gold_cash_cost_usd_oz', agg: 'rate', head: true, en: 'Cash cost per GEO sold', row: 39 }],
        auraMines('nrev', 'rev', { u: 'USD_mn', std: 'segment_revenue' }, 'Revenue'),
        [
          { k: 'revenue', sec: 'nrev', lab: /^Total Revenue$/i, u: 'USD_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 65 },
          { k: 'sga', sec: 'pl', lab: /^\(-\) SG&A$/i, u: 'USD_mn', en: 'SG&A', row: 76 },
          { k: 'exploration', sec: 'pl', lab: /^Exploration Expenses$/i, u: 'USD_mn', en: 'Exploration expenses', row: 80 }
        ],
        auraMines('ebitda', 'ebitda', { u: 'USD_mn', std: 'segment_ebitda' }, 'Adjusted EBITDA'),
        [
          { k: 'ebitda.corporate', sec: 'ebitda', lab: /^Others$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'corporate', en: 'Adjusted EBITDA — corporate', row: 89 },
          { k: 'adj_ebitda', sec: 'is', lab: /^\(=\) EBITDA Reported$/i, u: 'USD_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 91 },
          { k: 'd_a', sec: 'is', lab: /^\(-\) Depreciation$/i, u: 'USD_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 92 },
          { k: 'ebit', sec: 'is', lab: /^\(=\) EBIT$/i, u: 'USD_mn', std: 'ebit', en: 'EBIT', row: 93 },
          { k: 'fin_result', sec: 'is', lab: /^\(\+\/-\) Net Fin\. Results$/i, u: 'USD_mn', en: 'Net financial result', row: 94 },
          { k: 'other_nonop', sec: 'is', lab: /^\(\+\/-\) Other Non-Op\.$/i, u: 'USD_mn', en: 'Other non-operating items', row: 95 },
          { k: 'ebt', sec: 'is', lab: /^\(=\) EBT$/i, u: 'USD_mn', en: 'Pre-tax income', row: 96 },
          { k: 'taxes', sec: 'is', lab: /^\(-\) Income Taxes$/i, u: 'USD_mn', en: 'Income taxes', row: 97 },
          { k: 'net_income', sec: 'is', lab: /^\(=\) Net Income$/i, u: 'USD_mn', std: 'net_income', head: true, en: 'Net income', row: 99 },
          { k: 'px', calc: { op: 'per_unit', a: 'revenue', b: 'shipments', scale: 1000 }, u: 'USD/oz', std: 'realized_price', def: 'gold_geo_usd_oz', head: true, en: 'Realized price per GEO' },
          { k: 'ebitda_oz', calc: { op: 'per_unit', a: 'adj_ebitda', b: 'shipments', scale: 1000 }, u: 'USD/oz', en: 'Adjusted EBITDA per GEO sold' }
        ]
      )
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.03, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.05 }
    ]
  });

  // Southern Copper — US$. O "Copper Price" realizado do modelo é receita ÷ volume (confere), mas o bloco
  // de preços LME e o "Premium to LME" são dado pago → fora. Prata: "k oz" do modelo é milhão de oz.
  // A dívida/EBITDA do modelo soma a coluna anual (erro) → a página recalcula. Balanço só desde 2Q24.
  MANIFESTS.push({
    id: 'SCCO', v: 1, file: /^Preview Template \(SCCO \+ GMEX\)/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^SCCO Preview$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 4, firstCol: 'D', firstQ: '2012Q2',
      sections: [
        ['lme', /^LME Prices$/i], ['px', /^Realized Prices$/i], ['vol', /^Volumes$/i], ['rev', /^Revenues$/i],
        ['cost', /^Cash COGs$/i], ['opex', /^Operational Expenses$/i], ['fin', /^Financial Results$/i]
      ],
      exclude: [
        { cls: 'paid', sec: 'lme', lab: /./ }, { cls: 'paid', lab: /Premium to LME/i },
        { cls: 'derived', sec: 'px', lab: /./ },
        { cls: 'derived', lab: /Mined to Production|as % of revenues|Margin|Effective Tax Rate|Payout Ratio|Net Debt \/ EBITDA/i },
        { cls: 'plug', lab: /^Inventory\/Adjustments$|^Other Cash Costs$|^Operating Cash Cost$/i }
      ],
      rows: [
        { k: 'mined_copper', sec: 'vol', lab: /^Mined Copper$/i, u: 'kt', en: 'Mined copper', row: 19 },
        { k: 'production', sec: 'vol', lab: /^Own Copper Production$/i, u: 'kt', std: 'production', def: 'copper_kt', en: 'Copper production (own)', row: 20 },
        { k: 'third_conc', sec: 'vol', lab: /^Third-Party Concentrate$/i, u: 'kt', en: 'Third-party concentrate', row: 22 },
        { k: 'vol.copper', sec: 'vol', lab: /^Copper Sales Volume$/i, u: 'kt', std: 'sales_volume', def: 'copper_kt', head: true, req: true, en: 'Copper sales', row: 24 },
        { k: 'vol.moly', sec: 'vol', lab: /^Moly Sales Volume$/i, u: 'kt', std: 'sales_volume', def: 'moly_kt', en: 'Molybdenum sales', row: 25 },
        { k: 'vol.zinc', sec: 'vol', lab: /^Zinc Sales Volume$/i, u: 'kt', std: 'sales_volume', def: 'zinc_kt', en: 'Zinc sales', row: 26 },
        { k: 'vol.silver', sec: 'vol', lab: /^Silver Sales Volume$/i, u: 'Moz', std: 'sales_volume', def: 'silver_moz', en: 'Silver sales', row: 27 },
        { k: 'rev.copper', sec: 'rev', lab: /^Copper$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'copper', en: 'Revenue — copper', row: 30 },
        { k: 'rev.byproducts', sec: 'rev', lab: /^By Products$/i, u: 'USD_mn', seg: 'by_products', en: 'Revenue — by-products', row: 31 },
        { k: 'rev.moly', sec: 'rev', lab: /^Moly$/i, u: 'USD_mn', seg: 'moly', en: 'Revenue — molybdenum', row: 32 },
        { k: 'rev.zinc', sec: 'rev', lab: /^Zinc$/i, u: 'USD_mn', seg: 'zinc', en: 'Revenue — zinc', row: 33 },
        { k: 'rev.silver', sec: 'rev', lab: /^Silver$/i, u: 'USD_mn', seg: 'silver', en: 'Revenue — silver', row: 34 },
        { k: 'rev.other_byproducts', sec: 'rev', lab: /^Other By-products$/i, u: 'USD_mn', seg: 'by_products', en: 'Revenue — other by-products', row: 35 },
        { k: 'rev.other', sec: 'rev', lab: /^Other$/i, u: 'USD_mn', seg: 'other', en: 'Revenue — other', row: 36 },
        { k: 'revenue', sec: 'rev', lab: /^\(=\) Total$/i, u: 'USD_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 37 },
        { k: 'cash_cost', sec: 'cost', lab: /^Cash Cost \(before by product\)$/i, u: 'USD/lb', std: 'cash_cost', def: 'copper_cash_cost_before_byprod_usd_lb', agg: 'rate', head: true, en: 'Operating cash cost per lb (before by-product credits)', row: 40 },
        { k: 'cash_cost_net', sec: 'cost', lab: /^Cash Cost \(after by product\)$/i, u: 'USD/lb', agg: 'rate', en: 'Operating cash cost per lb (net of by-product credits)', row: 41 },
        { k: 'cash_costs', sec: 'cost', lab: /^\(=\) Total Cash Cost$/i, u: 'USD_mn', en: 'Total cash costs', row: 46 },
        { k: 'sga', sec: 'opex', lab: /^\(-\) SG&A \/ Other$/i, u: 'USD_mn', en: 'SG&A / other', row: 50 },
        { k: 'd_a', sec: 'opex', lab: /^Depreciation$/i, u: 'USD_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 53 },
        { k: 'exploration', sec: 'opex', lab: /^Exploration$/i, u: 'USD_mn', en: 'Exploration', row: 54 },
        { k: 'ebit', sec: 'opex', lab: /^\(=\) Operating Income$/i, u: 'USD_mn', std: 'ebit', en: 'Operating income', row: 56 },
        { k: 'adj_ebitda', sec: 'opex', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 58 },
        { k: 'interest_exp', sec: 'fin', lab: /^Interest Expenses$/i, u: 'USD_mn', en: 'Interest expense', row: 62 },
        { k: 'interest_inc', sec: 'fin', lab: /^Interest Income$/i, u: 'USD_mn', en: 'Interest income', row: 63 },
        { k: 'other_nonop', sec: 'fin', lab: /^Other Non Op\. Income\/Expenses$/i, u: 'USD_mn', en: 'Other non-operating items', row: 64 },
        { k: 'ebt', sec: 'fin', lab: /^\(=\) EBT$/i, u: 'USD_mn', en: 'Pre-tax income', row: 66 },
        { k: 'taxes', sec: 'fin', lab: /^\(-\) Taxes$/i, u: 'USD_mn', en: 'Income taxes', row: 68 },
        { k: 'affiliates', sec: 'fin', lab: /^\(\+\) Earnings in Affiliates$/i, u: 'USD_mn', en: 'Equity earnings of affiliates', row: 71 },
        { k: 'eat', sec: 'fin', lab: /^\(=\) Earnings After Taxes$/i, u: 'USD_mn', en: 'Net income (incl. minorities)', row: 73 },
        { k: 'minorities', sec: 'fin', lab: /^\(-\) Minorities$/i, u: 'USD_mn', en: 'Minority interests', row: 75 },
        { k: 'net_income', sec: 'fin', lab: /^\(=\) Net Income \(attr\. to Sh\.\)$/i, u: 'USD_mn', std: 'net_income', head: true, en: 'Net income', row: 77 },
        { k: 'shares', sec: 'fin', lab: /^Weighted number of shares$/i, u: 'mn_sh', agg: 'stock', en: 'Weighted average shares', row: 79 },
        { k: 'eps', sec: 'fin', lab: /^EPS$/i, u: 'USD/sh', en: 'EPS', row: 81 },
        { k: 'dps', sec: 'fin', lab: /^Dividends$/i, u: 'USD/sh', en: 'Dividends per share', row: 83 },
        { k: 'cash', sec: 'fin', lab: /^Cash and cash equivalents$/i, u: 'USD_mn', agg: 'stock', en: 'Cash and equivalents', row: 89 },
        { k: 'st_investments', sec: 'fin', lab: /^Short-term investments$/i, u: 'USD_mn', agg: 'stock', en: 'Short-term investments', row: 90 },
        { k: 'debt_current', sec: 'fin', lab: /^Current portion of long-term debt$/i, u: 'USD_mn', agg: 'stock', keepZeros: true, en: 'Current portion of long-term debt', row: 91 },
        { k: 'debt_lt', sec: 'fin', lab: /^Long-term debt$/i, u: 'USD_mn', agg: 'stock', en: 'Long-term debt', row: 92 },
        { k: 'net_debt', sec: 'fin', lab: /^Net Debt$/i, u: 'USD_mn', std: 'net_debt', head: true, en: 'Net debt', row: 93 },
        { k: 'capex', sec: 'fin', lab: /^Capital Investments$/i, u: 'USD_mn', std: 'capex', en: 'Capital investments', row: 96 },
        { k: 'px.copper', calc: { op: 'per_unit', a: 'rev.copper', b: 'vol.copper', scale: 0.45359237 }, u: 'USD/lb', std: 'realized_price', def: 'copper_usd_lb', head: true, en: 'Copper realized price' },
        { k: 'px.moly', calc: { op: 'per_unit', a: 'rev.moly', b: 'vol.moly', scale: 0.45359237 }, u: 'USD/lb', std: 'realized_price', def: 'moly_usd_lb', en: 'Molybdenum realized price' },
        { k: 'px.zinc', calc: { op: 'per_unit', a: 'rev.zinc', b: 'vol.zinc', scale: 0.45359237 }, u: 'USD/lb', std: 'realized_price', def: 'zinc_usd_lb', en: 'Zinc realized price' },
        { k: 'px.silver', calc: { op: 'div', a: 'rev.silver', b: 'vol.silver' }, u: 'USD/oz', std: 'realized_price', def: 'silver_usd_oz', en: 'Silver realized price' }
      ],
      derived: [
        { k: 'chk.px.copper', sec: 'px', lab: /^Copper Price$/i, calc: { op: 'per_unit', a: 'rev.copper', b: 'vol.copper', scale: 0.45359237 }, tol: 0.003 },
        { k: 'chk.margin', sec: 'opex', lab: /^EBITDA Margin$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'revenue', vs: 'gold', tol: 0.002, hard: true, unlessFiled: 'rev' },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // Suzano — 4Q16–4Q18 da planilha é pro-forma do analista (Suzano antiga + Fibria somadas) → tudo começa
  // em 1Q19. Fora: preço de lista e desconto (PIX), frete estimado e o bloco de hedge/dívida por moeda.
  // Volume de celulose vem em milhões de t → mult 1000 para kt (mesma régua da Klabin).
  MANIFESTS.push({
    id: 'SUZB3', v: 1, file: /^Suzano_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^PREVIEW_NEW_SUZANO$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 4, firstCol: 'D', firstQ: '2016Q4', from: '2019Q1',
      sections: [
        ['pulp', /^PULP SEGMENT$/], ['paper', /^PAPER SEGMENT$/], ['p_px', /^PAPER PRICES$/], ['p_rev', /^PAPER REVENUES$/],
        ['nonseg', /^Non-Segmented$/i], ['cons', /^CONSOLIDATED$/], ['hedge', /^Impacto varia/i]
      ],
      exclude: [
        { cls: 'paid', sec: 'pulp', lab: /List Prices|^\(-\) Discount$|Net Prices|^Pulp Prices$/i },
        { cls: 'proforma', sec: 'pulp', lab: /^Suzano \+ Fibria$|^Klabin$|Klabin Adjustment/i },
        { cls: 'allocation', lab: /D&A Allocated to SG&A/i },
        { cls: 'derived', lab: /Cash COGS\/ton|Freight|MI\/ME|Margin|EBITDA\/ton|as % of Revs|Effective Tax Rate|^Production Costs$/i },
        { cls: 'hedge', sec: 'hedge', lab: /./ }
      ],
      rows: [
        { k: 'fx.eop', lab: /^FX EOP$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 5 },
        { k: 'fx.avg', lab: /^FX Avg$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 6 },
        { k: 'pulp.rev', sec: 'pulp', lab: /^\(=\) Total Pulp Revenues$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'pulp', en: 'Revenue — Pulp', row: 8 },
        { k: 'pulp.vol', sec: 'pulp', lab: /^Pulp Volumes$/i, u: 'kt', mult: 1000, std: 'sales_volume', def: 'pulp_kt', seg: 'pulp', head: true, req: true, en: 'Pulp sales', row: 9 },
        { k: 'pulp.cogs', sec: 'pulp', lab: /^\(-\) Total COGs$/i, u: 'BRL_mn', seg: 'pulp', en: 'COGS — Pulp', row: 18 },
        { k: 'pulp.da', sec: 'pulp', lab: /^\(-\) Depreciation$/i, u: 'BRL_mn', sign: 'pos', seg: 'pulp', en: 'D&A — Pulp', row: 19 },
        { k: 'pulp.cash_cost_t', sec: 'pulp', lab: /^Cash cost\/ton \(ex-stoppage\)$/i, u: 'BRL/t', std: 'cash_cost', def: 'pulp_cash_cost_ex_downtime_brl_t', agg: 'rate', seg: 'pulp', head: true, en: 'Pulp cash cost ex-downtime', row: 23 },
        { k: 'pulp.stoppage_t', sec: 'pulp', lab: /^Stoppage Costs\/ton$/i, u: 'BRL/t', agg: 'rate', seg: 'pulp', en: 'Scheduled-downtime cost per tonne', row: 24 },
        { k: 'pulp.sales_exp', sec: 'pulp', lab: /^\(-\) Sales Expenses$/i, u: 'BRL_mn', seg: 'pulp', en: 'Selling expenses — Pulp', row: 31 },
        { k: 'pulp.ga', sec: 'pulp', lab: /^\(-\) G&A Expenses$/i, u: 'BRL_mn', seg: 'pulp', en: 'G&A — Pulp', row: 33 },
        { k: 'pulp.other_opex', sec: 'pulp', lab: /^\(-\) Other Op\. Income \(Expenses\)$/i, u: 'BRL_mn', seg: 'pulp', en: 'Other operating income/expenses — Pulp', row: 35 },
        { k: 'pulp.equity', sec: 'pulp', lab: /^\(\+\) Equity Income$/i, u: 'BRL_mn', seg: 'pulp', en: 'Equity income — Pulp', row: 36 },
        { k: 'pulp.ebitda', sec: 'pulp', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', seg: 'pulp', en: 'EBITDA — Pulp (before adjustments)', row: 39 },
        { k: 'pulp.nonrec', sec: 'pulp', lab: /^\(\+\/-\) Non-Recurring\/Non-Cash Items$/i, u: 'BRL_mn', seg: 'pulp', en: 'Non-recurring / non-cash items — Pulp', row: 40 },
        { k: 'pulp.adj_ebitda', sec: 'pulp', lab: /^\(=\) Adjusted EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'pulp', en: 'Adjusted EBITDA — Pulp', row: 41 },
        { k: 'paper.vol.dom', sec: 'paper', lab: /^Volumes Domestic Mkt$/i, u: 'kt', seg: 'paper', en: 'Paper sales — domestic', row: 47 },
        { k: 'paper.vol.dom.pw', sec: 'paper', lab: /^Printing \/ Writing$/i, nth: 0, u: 'kt', seg: 'paper', en: 'Printing & writing — domestic', row: 48 },
        { k: 'paper.vol.dom.cardboard', sec: 'paper', lab: /^Cardboard$/i, nth: 0, u: 'kt', seg: 'paper', en: 'Paperboard — domestic', row: 51 },
        { k: 'paper.vol.dom.tissue', sec: 'paper', lab: /^Specialty\/Tissue$/i, nth: 0, u: 'kt', seg: 'paper', en: 'Specialty / tissue — domestic', row: 52 },
        { k: 'paper.vol.exp', sec: 'paper', lab: /^Volumes Export Mkt$/i, u: 'kt', seg: 'paper', en: 'Paper sales — exports', row: 53 },
        { k: 'paper.vol.exp.pw', sec: 'paper', lab: /^Printing \/ Writing$/i, nth: 1, u: 'kt', seg: 'paper', en: 'Printing & writing — exports', row: 54 },
        { k: 'paper.vol.exp.cardboard', sec: 'paper', lab: /^Cardboard$/i, nth: 1, u: 'kt', seg: 'paper', en: 'Paperboard — exports', row: 57 },
        { k: 'paper.vol.exp.tissue', sec: 'paper', lab: /^Specialty\/Tissue$/i, nth: 1, u: 'kt', seg: 'paper', en: 'Specialty / tissue — exports', row: 58 },
        { k: 'paper.vol', sec: 'paper', lab: /^\(=\) Total Paper Volumes$/i, u: 'kt', std: 'sales_volume', def: 'paper_kt', seg: 'paper', en: 'Paper sales', row: 59 },
        { k: 'paper.px.dom', sec: 'p_px', lab: /^Avg Domestic Mkt Price$/i, u: 'BRL/t', std: 'realized_price', def: 'paper_domestic_brl', agg: 'rate', seg: 'paper', en: 'Paper price — domestic', row: 64 },
        { k: 'paper.px.exp', sec: 'p_px', lab: /^Avg Export Mkt Price$/i, u: 'BRL/t', std: 'realized_price', def: 'paper_export_brl', agg: 'rate', seg: 'paper', en: 'Paper price — exports', row: 65 },
        { k: 'paper.rev.dom', sec: 'p_rev', lab: /^\(\+\) Domestic Mkt$/i, u: 'BRL_mn', seg: 'paper', en: 'Paper revenue — domestic', row: 68 },
        { k: 'paper.rev.exp', sec: 'p_rev', lab: /^\(\+\) Export Mkt$/i, u: 'BRL_mn', seg: 'paper', en: 'Paper revenue — exports', row: 69 },
        { k: 'paper.rev', sec: 'p_rev', lab: /^\(=\) Total Paper Revenues$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'paper', en: 'Revenue — Paper', row: 70 },
        { k: 'paper.cogs', sec: 'p_rev', lab: /^\(-\) Total COGs$/i, u: 'BRL_mn', seg: 'paper', en: 'COGS — Paper', row: 72 },
        { k: 'paper.da', sec: 'p_rev', lab: /^\(-\) Depreciation$/i, u: 'BRL_mn', sign: 'pos', seg: 'paper', en: 'D&A — Paper', row: 73 },
        { k: 'paper.sales_exp', sec: 'p_rev', lab: /^\(-\) Sales Expenses$/i, u: 'BRL_mn', seg: 'paper', en: 'Selling expenses — Paper', row: 79 },
        { k: 'paper.ga', sec: 'p_rev', lab: /^\(-\) G&A Expenses$/i, u: 'BRL_mn', seg: 'paper', en: 'G&A — Paper', row: 81 },
        { k: 'paper.other_opex', sec: 'p_rev', lab: /^\(-\) Other Op\. Expenses$/i, u: 'BRL_mn', seg: 'paper', en: 'Other operating expenses — Paper', row: 83 },
        { k: 'paper.equity', sec: 'p_rev', lab: /^\(\+\/-\) Equity Income$/i, u: 'BRL_mn', seg: 'paper', en: 'Equity income — Paper', row: 85 },
        { k: 'paper.ebitda', sec: 'p_rev', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', seg: 'paper', en: 'EBITDA — Paper (before adjustments)', row: 87 },
        { k: 'paper.nonrec', sec: 'p_rev', lab: /^\(\+\/-\) Non-Recurring\/Non-Cash Items$/i, u: 'BRL_mn', seg: 'paper', en: 'Non-recurring / non-cash items — Paper', row: 88 },
        { k: 'paper.adj_ebitda', sec: 'p_rev', lab: /^\(=\) Adjusted EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'paper', en: 'Adjusted EBITDA — Paper', row: 89 },
        { k: 'revenue', sec: 'cons', lab: /^\(=\) Net Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 97 },
        { k: 'cogs', sec: 'cons', lab: /^\(-\) Total COGs$/i, u: 'BRL_mn', en: 'COGS', row: 99 },
        { k: 'd_a', sec: 'cons', lab: /^\(-\) Depreciation$/i, nth: 0, u: 'BRL_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 100 },
        { k: 'sales_exp', sec: 'cons', lab: /^\(-\) Sales Expenses$/i, u: 'BRL_mn', en: 'Selling expenses', row: 102 },
        { k: 'ga', sec: 'cons', lab: /^\(-\) G&A Expenses$/i, u: 'BRL_mn', en: 'G&A', row: 104 },
        { k: 'other_opex', sec: 'cons', lab: /^\(\+\/-\) Other Revs\/Expenses$/i, u: 'BRL_mn', en: 'Other operating income/expenses', row: 107 },
        { k: 'equity_income', sec: 'cons', lab: /^\(\+\/-\) Equity Income$/i, u: 'BRL_mn', en: 'Equity income', row: 108 },
        { k: 'ebitda', sec: 'cons', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', en: 'EBITDA (before adjustments)', row: 109 },
        { k: 'nonrecurring', sec: 'cons', lab: /^\(\+\/-\) Non-Recurring\/Non-Cash Items$/i, u: 'BRL_mn', en: 'Non-recurring / non-cash items', row: 110 },
        { k: 'adj_ebitda', sec: 'cons', lab: /^\(=\) Adjusted EBITDA$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 111 },
        { k: 'ebit', sec: 'cons', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 114 },
        { k: 'fin_result', sec: 'cons', lab: /^\(\+\/-\) Financial Results$/i, u: 'BRL_mn', en: 'Net financial result', row: 115 },
        { k: 'fin_income', sec: 'cons', lab: /^\(\+\) Financial Income$/i, u: 'BRL_mn', en: 'Financial income', row: 116 },
        { k: 'fin_expense', sec: 'cons', lab: /^\(-\) Financial Expenses$/i, u: 'BRL_mn', en: 'Financial expenses', row: 117 },
        { k: 'fx_var', sec: 'cons', lab: /^\(\+\/-\) FX Variation$/i, u: 'BRL_mn', en: 'FX and derivatives', row: 118 },
        { k: 'ebt', sec: 'cons', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 119 },
        { k: 'taxes', sec: 'cons', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 120 },
        { k: 'minorities', sec: 'cons', lab: /^\(-\) Minority Interest$/i, u: 'BRL_mn', en: 'Minority interests', row: 122 },
        { k: 'net_income', sec: 'cons', lab: /^\(=\) Net Income$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 123 },
        { k: 'gross_debt', sec: 'cons', lab: /^\(=\) Gross Debt$/i, u: 'BRL_mn', agg: 'stock', en: 'Gross debt', row: 127 },
        { k: 'cash', sec: 'cons', lab: /^\(-\) Cash$/i, u: 'BRL_mn', agg: 'stock', sign: 'pos', en: 'Cash', row: 128 },
        { k: 'net_debt', sec: 'cons', lab: /^\(=\) Net Debt$/i, u: 'BRL_mn', std: 'net_debt', head: true, en: 'Net debt', row: 129 },
        { k: 'pulp.px', calc: { op: 'per_unit', a: 'pulp.rev', b: 'pulp.vol', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'pulp_hw_brl', seg: 'pulp', head: true, en: 'Pulp realized price' },
        { k: 'paper.px', calc: { op: 'per_unit', a: 'paper.rev', b: 'paper.vol', scale: 1000 }, u: 'BRL/t', seg: 'paper', en: 'Paper realized price' },
        { k: 'pulp.ebitda_t', calc: { op: 'per_unit', a: 'pulp.adj_ebitda', b: 'pulp.vol', scale: 1000 }, u: 'BRL/t', seg: 'pulp', en: 'Pulp adjusted EBITDA per tonne' }
      ],
      derived: [
        { k: 'chk.margin', sec: 'cons', lab: /^EBITDA Margin$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' } },
        { k: 'chk.px.pulp', sec: 'pulp', lab: /^Pulp Prices$/i, calc: { op: 'per_unit', a: 'pulp.rev', b: 'pulp.vol', scale: 1000 } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // Klabin — seções com nome repetido (PULP, PAPER, CONSOLIDATED aparecem 3-4×): a ordem resolve. Preços
  // por produto são todos conta (receita ÷ volume) → recalculados. Fora: a linha 47 sem rótulo (PIX), as
  // eliminações e os blocos consolidados que só repetem os segmentos. Lucro do modelo ≠ CVM (277 × 387 no
  // 2Q26): a página usa o da CVM.
  MANIFESTS.push({
    id: 'KLBN11', v: 1, file: /^Klabin_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 3, firstCol: 'D', firstQ: '2013Q1',
      sections: [
        ['pulp', /^PULP$/], ['pulp_ship', /^PULP$/], ['pulp_px_brl', /^PULP \(BRL\/ton\)$/], ['pulp_px_usd', /^PULP \(USD\/ton\)$/],
        ['pulp_rev', /^PULP$/], ['pulp_elim', /^ELIMINATIONS$/], ['pulp_res', /^PULP$/], ['pp', /^PAPER AND PACKAGING$/],
        ['paper_ship', /^PAPER$/], ['pack_ship', /^PACKAGING$/], ['others_ship', /^OTHERS$/], ['wood_ship', /^WOOD$/],
        ['paper_px_brl', /^PAPER \(BRL\/ton\)$/], ['paper_px_usd', /^PAPER \(USD\/ton\)$/], ['pack_px_brl', /^PACKAGING \(BRL\/ton\)$/],
        ['pack_px_usd', /^PACKAGING \(USD\/ton\)$/], ['wood_px', /^WOOD$/], ['paper_rev', /^PAPER$/], ['pack_rev', /^PACKAGING$/],
        ['others_rev', /^OTHERS$/], ['wood_rev', /^WOOD$/], ['pp_elim', /^ELIMINATIONS$/], ['pp_res', /^PAPER AND PACKAGING$/],
        ['cons', /^CONSOLIDATED$/], ['cons_ship', /^CONSOLIDATED$/], ['cons_px', /^CONSOLIDATED$/], ['cons_rev', /^CONSOLIDATED$/],
        ['cons_res', /^RESULTS$/]
      ],
      exclude: [
        { cls: 'derived', sec: 'pulp_px_brl', lab: /./ }, { cls: 'derived', sec: 'pulp_px_usd', lab: /./ },
        { cls: 'derived', sec: 'paper_px_brl', lab: /./ }, { cls: 'derived', sec: 'paper_px_usd', lab: /./ },
        { cls: 'derived', sec: 'pack_px_brl', lab: /./ }, { cls: 'derived', sec: 'pack_px_usd', lab: /./ },
        { cls: 'derived', sec: 'wood_px', lab: /./ },
        { cls: 'derived', sec: 'pulp_elim', lab: /./ }, { cls: 'derived', sec: 'pp_elim', lab: /./ },
        { cls: 'plug', sec: 'others_ship', lab: /./ }, { cls: 'plug', sec: 'others_rev', lab: /./ },
        { cls: 'dup', sec: 'cons_ship', lab: /./ }, { cls: 'dup', sec: 'cons_px', lab: /./ }, { cls: 'dup', sec: 'cons_rev', lab: /./ },
        { cls: 'derived', lab: /per Ton|as % of Net Revenues|Margin|Effective Tax Rate|^Check$|Cash COGS\/ton|^% of (Cash|Ndebt)$|Total Cash Cost\/ton/i }
      ],
      // aberturas por mercado/fibra/produto e itens de reconciliação que ficam só no modelo
      skip: [
        { lab: /^(Softwood Pulp \+ Fluff|Hardwood Pulp|Containerboard \(Kraft\)|Coated Board|Corrugated Boxes|Industrial Bags|Containerboard|\(\+\) Domestic Mkt|\(\+\) Export Mkt)$/i },
        { sec: 'pulp_res', lab: /^\(\+\) (Pulp Revenues|Other\/Eliminations)$|^\(-\) Pulp Cash COGS$|^\(-\) Non Recurring Adjustments$/i },
        { sec: 'pp_res', lab: /^\(\+\) (Paper|Packaging|Wood) Revenues$|^\(\+\) (Others|Eliminations)$|^\(-\) Paper Cash COGS$|^\(-\) Non Recurring Adjustments\/Hedge$/i },
        { sec: 'cons_res', lab: /^\(-\) Cash COGS$|^\(-\) Other Operating Expenses$|^\(-\) Depreciation \+ Variation$|^\(\+\) Financial Income$|^\(-\) Financial Expenses$|^\(\+\/-\) FX Variation$|^\(\+\/-\) Other Adjustments$|^\(\+\) Vale do Corisco Share$|^\(\+\) EBITDA$/i }
      ],
      rows: [
        { k: 'fx.eop', lab: /^FX EOP$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 4 },
        { k: 'fx.avg', lab: /^FX Avg$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 5 },
        { k: 'pulp.vol.dom', sec: 'pulp_ship', lab: /^\(\+\) Domestic Mkt$/i, u: 'kt', seg: 'pulp', en: 'Pulp sales — domestic', row: 14 },
        { k: 'pulp.vol.exp', sec: 'pulp_ship', lab: /^\(\+\) Export Mkt$/i, u: 'kt', seg: 'pulp', en: 'Pulp sales — exports', row: 17 },
        { k: 'pulp.vol', sec: 'pulp_ship', lab: /^\(=\) Total Pulp$/i, u: 'kt', std: 'sales_volume', def: 'pulp_kt', seg: 'pulp', head: true, req: true, en: 'Pulp sales', row: 20 },
        { k: 'pulp.vol.sw', sec: 'pulp_ship', lab: /^Softwood Pulp \+ Fluff$/i, after: /^\(=\) Total Pulp$/i, nth: 0, u: 'kt', seg: 'pulp', en: 'Pulp sales — softwood + fluff', row: 21 },
        { k: 'pulp.vol.hw', sec: 'pulp_ship', lab: /^Hardwood Pulp$/i, after: /^\(=\) Total Pulp$/i, nth: 0, u: 'kt', seg: 'pulp', en: 'Pulp sales — hardwood', row: 22 },
        { k: 'pulp.rev.dom', sec: 'pulp_rev', lab: /^\(\+\) Domestic Mkt$/i, u: 'BRL_mn', seg: 'pulp', en: 'Pulp revenue — domestic', row: 51 },
        { k: 'pulp.rev.exp', sec: 'pulp_rev', lab: /^\(\+\) Export Mkt$/i, u: 'BRL_mn', seg: 'pulp', en: 'Pulp revenue — exports', row: 54 },
        { k: 'pulp.rev.gross', sec: 'pulp_rev', lab: /^\(=\) Total Pulp$/i, u: 'BRL_mn', seg: 'pulp', en: 'Pulp product revenue', row: 57 },
        { k: 'pulp.rev.sw', sec: 'pulp_rev', lab: /^Softwood Pulp \+ Fluff$/i, after: /^\(=\) Total Pulp$/i, nth: 0, u: 'BRL_mn', seg: 'pulp', en: 'Pulp revenue — softwood + fluff', row: 58 },
        { k: 'pulp.rev.hw', sec: 'pulp_rev', lab: /^Hardwood Pulp$/i, after: /^\(=\) Total Pulp$/i, nth: 0, u: 'BRL_mn', seg: 'pulp', en: 'Pulp revenue — hardwood', row: 59 },
        { k: 'pulp.rev', sec: 'pulp_res', lab: /^\(\+\) Pulp Net Revenues$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'pulp', en: 'Revenue — Pulp', row: 67 },
        { k: 'pulp.cogs', sec: 'pulp_res', lab: /^\(-\) Pulp COGS$/i, u: 'BRL_mn', seg: 'pulp', en: 'COGS — Pulp', row: 70 },
        { k: 'pulp.da', sec: 'pulp_res', lab: /^\(-\) Pulp Depreciation$/i, u: 'BRL_mn', sign: 'pos', seg: 'pulp', en: 'D&A — Pulp', row: 71 },
        { k: 'pulp.opex', sec: 'pulp_res', lab: /^\(-\) Pulp Operating Expenses$/i, u: 'BRL_mn', seg: 'pulp', en: 'Operating expenses — Pulp', row: 74 },
        { k: 'pulp.ebitda', sec: 'pulp_res', lab: /^\(=\) Pulp EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'pulp', en: 'Adjusted EBITDA — Pulp', row: 77 },
        { k: 'paper.vol.dom', sec: 'paper_ship', lab: /^\(\+\) Domestic Mkt$/i, u: 'kt', seg: 'paper', en: 'Paperboard sales — domestic', row: 85 },
        { k: 'paper.vol.exp', sec: 'paper_ship', lab: /^\(\+\) Export Mkt$/i, u: 'kt', seg: 'paper', en: 'Paperboard sales — exports', row: 88 },
        { k: 'paper.vol', sec: 'paper_ship', lab: /^\(=\) Total Paper$/i, u: 'kt', std: 'sales_volume', def: 'paperboard_kt', seg: 'paper', en: 'Paperboard sales', row: 91 },
        { k: 'paper.vol.kraft', sec: 'paper_ship', lab: /^Containerboard \(Kraft\)$/i, after: /^\(=\) Total Paper$/i, nth: 0, u: 'kt', seg: 'paper', en: 'Containerboard (kraftliner) sales', row: 92 },
        { k: 'paper.vol.coated', sec: 'paper_ship', lab: /^Coated Board$/i, after: /^\(=\) Total Paper$/i, nth: 0, u: 'kt', seg: 'paper', en: 'Coated board sales', row: 93 },
        { k: 'pack.vol', sec: 'pack_ship', lab: /^\(=\) Total Packaging$/i, u: 'kt', std: 'sales_volume', def: 'packaging_kt', seg: 'packaging', en: 'Packaging sales', row: 102 },
        { k: 'pack.vol.boxes', sec: 'pack_ship', lab: /^Corrugated Boxes$/i, after: /^\(=\) Total Packaging$/i, nth: 0, u: 'kt', seg: 'packaging', en: 'Corrugated boxes sales', row: 103 },
        { k: 'pack.vol.bags', sec: 'pack_ship', lab: /^Industrial Bags$/i, after: /^\(=\) Total Packaging$/i, nth: 0, u: 'kt', seg: 'packaging', en: 'Industrial bags sales', row: 104 },
        { k: 'wood.vol', sec: 'wood_ship', lab: /^Wood$/i, unit: /^ktons$/i, u: 'kt', seg: 'wood', en: 'Wood sales', row: 112 },
        { k: 'paper.rev', sec: 'paper_rev', lab: /^\(=\) Total Paper Revenues$/i, u: 'BRL_mn', seg: 'paper', en: 'Revenue — paperboard', row: 160 },
        { k: 'paper.rev.kraft', sec: 'paper_rev', lab: /^Containerboard \(Kraft\)$/i, after: /^\(=\) Total Paper Revenues$/i, nth: 0, u: 'BRL_mn', seg: 'paper', en: 'Revenue — containerboard (kraftliner)', row: 161 },
        { k: 'paper.rev.coated', sec: 'paper_rev', lab: /^Coated Board$/i, after: /^\(=\) Total Paper Revenues$/i, nth: 0, u: 'BRL_mn', seg: 'paper', en: 'Revenue — coated board', row: 162 },
        { k: 'pack.rev', sec: 'pack_rev', lab: /^\(=\) Total Packaging Revenues$/i, u: 'BRL_mn', seg: 'packaging', en: 'Revenue — packaging', row: 171 },
        { k: 'pack.rev.boxes', sec: 'pack_rev', lab: /^Containerboard$/i, after: /^\(=\) Total Packaging Revenues$/i, nth: 0, u: 'BRL_mn', seg: 'packaging', en: 'Revenue — corrugated boxes', row: 172 },
        { k: 'pack.rev.bags', sec: 'pack_rev', lab: /^Coated Board$/i, after: /^\(=\) Total Packaging Revenues$/i, nth: 0, u: 'BRL_mn', seg: 'packaging', en: 'Revenue — industrial bags', row: 173 },
        { k: 'wood.rev', sec: 'wood_rev', lab: /^\(=\) Total Wood Revenues$/i, u: 'BRL_mn', seg: 'wood', en: 'Revenue — wood', row: 181 },
        { k: 'pp.rev', sec: 'pp_res', lab: /^\(\+\) Net Revenues$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'paper_packaging', en: 'Revenue — Paper & Packaging', row: 191 },
        { k: 'pp.cogs', sec: 'pp_res', lab: /^\(-\) Paper COGS$/i, u: 'BRL_mn', seg: 'paper_packaging', en: 'COGS — Paper & Packaging', row: 197 },
        { k: 'pp.da', sec: 'pp_res', lab: /^\(-\) Paper Depreciation$/i, u: 'BRL_mn', sign: 'pos', seg: 'paper_packaging', en: 'D&A — Paper & Packaging', row: 198 },
        { k: 'pp.opex', sec: 'pp_res', lab: /^\(-\) Paper Operating Expenses$/i, u: 'BRL_mn', seg: 'paper_packaging', en: 'Operating expenses — Paper & Packaging', row: 201 },
        { k: 'pp.ebitda', sec: 'pp_res', lab: /^\(=\) Paper EBITDA$/i, u: 'BRL_mn', std: 'segment_ebitda', seg: 'paper_packaging', en: 'Adjusted EBITDA — Paper & Packaging', row: 204 },
        { k: 'revenue', sec: 'cons_res', lab: /^\(=\) Consolidated Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 247 },
        { k: 'cogs', sec: 'cons_res', lab: /^\(-\) COGS$/i, u: 'BRL_mn', en: 'COGS', row: 249 },
        { k: 'd_a', sec: 'cons_res', lab: /^\(-\) Depreciation$/i, u: 'BRL_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 250 },
        { k: 'opex', sec: 'cons_res', lab: /^\(-\) Operating Expenses$/i, u: 'BRL_mn', en: 'Operating expenses', row: 254 },
        { k: 'adj_ebitda', sec: 'cons_res', lab: /^\(=\) Adjusted EBITDA$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 258 },
        { k: 'bio_assets', sec: 'cons_res', lab: /^\(\+\/-\) Biological Asset Re-evaluation$/i, u: 'BRL_mn', en: 'Biological asset fair-value change', row: 261 },
        { k: 'ebit', sec: 'cons_res', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 262 },
        { k: 'fin_result', sec: 'cons_res', lab: /^\(\+\/-\) Financial Results$/i, u: 'BRL_mn', en: 'Net financial result', row: 263 },
        { k: 'equity_income', sec: 'cons_res', lab: /^\(\+\/-\) Equity Income$/i, u: 'BRL_mn', en: 'Equity income', row: 267 },
        { k: 'ebt', sec: 'cons_res', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 269 },
        { k: 'taxes', sec: 'cons_res', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 270 },
        { k: 'minorities', sec: 'cons_res', lab: /^\(-\) Minority Interest$/i, u: 'BRL_mn', en: 'Minority interests', row: 272 },
        { k: 'net_income', sec: 'cons_res', lab: /^\(=\) Net Income$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 273 },
        { k: 'gross_debt', sec: 'cons_res', lab: /^Gross Debt$/i, u: 'BRL_mn', agg: 'stock', en: 'Gross debt', row: 279 },
        { k: 'cash', sec: 'cons_res', lab: /^\(-\) Cash$/i, u: 'BRL_mn', agg: 'stock', sign: 'pos', en: 'Cash', row: 280 },
        { k: 'net_debt', sec: 'cons_res', lab: /^\(=\) Net Debt$/i, u: 'BRL_mn', std: 'net_debt', head: true, en: 'Net debt', row: 281 },
        { k: 'pulp.px', calc: { op: 'per_unit', a: 'pulp.rev.gross', b: 'pulp.vol', scale: 1000 }, u: 'BRL/t', def: 'pulp_mix_brl', seg: 'pulp', en: 'Pulp realized price (all fibers)' },
        { k: 'pulp.px.hw', calc: { op: 'per_unit', a: 'pulp.rev.hw', b: 'pulp.vol.hw', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'pulp_hw_brl', seg: 'pulp', head: true, en: 'Hardwood pulp realized price' },
        { k: 'pulp.px.sw', calc: { op: 'per_unit', a: 'pulp.rev.sw', b: 'pulp.vol.sw', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'pulp_sw_fluff_brl', seg: 'pulp', en: 'Softwood + fluff pulp realized price' },
        { k: 'paper.px', calc: { op: 'per_unit', a: 'paper.rev', b: 'paper.vol', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'paperboard_brl', seg: 'paper', en: 'Paperboard realized price' },
        { k: 'paper.px.kraft', calc: { op: 'per_unit', a: 'paper.rev.kraft', b: 'paper.vol.kraft', scale: 1000 }, u: 'BRL/t', seg: 'paper', en: 'Containerboard realized price' },
        { k: 'paper.px.coated', calc: { op: 'per_unit', a: 'paper.rev.coated', b: 'paper.vol.coated', scale: 1000 }, u: 'BRL/t', seg: 'paper', en: 'Coated board realized price' },
        { k: 'pack.px', calc: { op: 'per_unit', a: 'pack.rev', b: 'pack.vol', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'packaging_brl', seg: 'packaging', en: 'Packaging realized price' },
        { k: 'pack.px.boxes', calc: { op: 'per_unit', a: 'pack.rev.boxes', b: 'pack.vol.boxes', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'corrugated_boxes_brl', seg: 'packaging', en: 'Corrugated boxes realized price' }
      ],
      derived: [
        { k: 'chk.px.pulp', sec: 'pulp_px_brl', lab: /^Total Pulp$/i, calc: { op: 'per_unit', a: 'pulp.rev.gross', b: 'pulp.vol', scale: 1000 } },
        { k: 'chk.margin', sec: 'cons_res', lab: /^EBITDA Margin \(%\)$/i, calc: { op: 'div', a: 'adj_ebitda', b: 'revenue' } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 }
    ]
  });

  // Irani — o 2Q26 está rotulado '2Q25'. Receita, EBITDA contábil e lucro batem com a CVM (431,9 · 157,1 ·
  // 30,9). O ajustado tira a variação do ativo biológico e o PLR. Sem dívida no modelo.
  MANIFESTS.push({
    id: 'RANI3', v: 1, file: /^Irani_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 3, firstCol: 'D', firstQ: '2019Q1',
      sections: [['ship', /^SHIPMENTS$/], ['px', /^PRICES$/], ['rev', /^REVENUES$/], ['opex', /^Operational Expenses$/i]],
      exclude: [
        { cls: 'derived', sec: 'px', lab: /./ },
        { cls: 'dup', sec: 'rev', lab: /^\(=\) Total Revenues$/i },
        { cls: 'plug', lab: /Corporate\/Eliminations/i },
        { cls: 'derived', lab: /Cash COGS per Ton|as % of Net Revenues|Margin|Effective Tax Rate/i },
        { cls: 'dup', sec: 'opex', lab: /^\(=\) EBITDA$|^\(-\) Exaustion\/Depreciation$/i }
      ],
      rows: [
        { k: 'fx.eop', lab: /^FX EOP$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_eop', agg: 'stock', en: 'FX — BRL/USD end of period', row: 4 },
        { k: 'fx.avg', lab: /^FX Avg$/i, unit: /^BRL\/USD$/i, u: 'BRL/USD', std: 'fx_avg', agg: 'rate', en: 'FX — BRL/USD average', row: 5 },
        { k: 'vol', sec: 'ship', lab: /^Paper Shipments$/i, u: 'kt', std: 'sales_volume', def: 'irani_paper_packaging_kt', head: true, req: true, en: 'Shipments (corrugated + packaging paper)', row: 9 },
        { k: 'vol.corrugated', sec: 'ship', lab: /^Corrugated Cardboard Shipments$/i, u: 'kt', seg: 'corrugated', en: 'Corrugated packaging shipments', row: 10 },
        { k: 'vol.paper', sec: 'ship', lab: /^Packaging Paper Shipments$/i, u: 'kt', seg: 'packaging_paper', en: 'Packaging paper shipments', row: 11 },
        { k: 'vol.flexible', sec: 'ship', lab: /^Flexible Paper Shipments$/i, u: 'kt', seg: 'packaging_paper', en: 'Flexible packaging paper shipments', row: 12 },
        { k: 'vol.rigid', sec: 'ship', lab: /^Rigid Paper Shipments$/i, u: 'kt', seg: 'packaging_paper', en: 'Rigid packaging paper shipments', row: 13 },
        { k: 'vol.rosin', sec: 'ship', lab: /^Gum Rosin and Turpentine Shipments$/i, u: 'kt', seg: 'resins', en: 'Gum rosin & turpentine shipments', row: 14 },
        { k: 'rev.paper', sec: 'rev', lab: /^Paper$/i, u: 'BRL_mn', seg: 'paper', en: 'Revenue — paper & packaging', row: 25 },
        { k: 'rev.corrugated', sec: 'rev', lab: /^Corrugated Cardboard$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'corrugated', en: 'Revenue — corrugated packaging', row: 26 },
        { k: 'rev.packaging_paper', sec: 'rev', lab: /^Packaging Paper$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'packaging_paper', en: 'Revenue — packaging paper', row: 27 },
        { k: 'rev.flexible', sec: 'rev', lab: /^Flexible Paper$/i, u: 'BRL_mn', seg: 'packaging_paper', en: 'Revenue — flexible packaging paper', row: 28 },
        { k: 'rev.rigid', sec: 'rev', lab: /^Rigid Paper$/i, u: 'BRL_mn', seg: 'packaging_paper', en: 'Revenue — rigid packaging paper', row: 29 },
        { k: 'rev.other_paper', sec: 'rev', lab: /^Other Paper$/i, u: 'BRL_mn', seg: 'packaging_paper', en: 'Revenue — other paper', row: 30 },
        { k: 'rev.rosin', sec: 'rev', lab: /^Gum Rosin and Turpentine$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'resins', en: 'Revenue — gum rosin & turpentine', row: 31 },
        { k: 'rev.forestry', sec: 'rev', lab: /^Forestry$/i, u: 'BRL_mn', std: 'segment_revenue', seg: 'forestry', en: 'Revenue — forestry', row: 32 },
        { k: 'revenue', sec: 'rev', lab: /^\(\+\) Net Revenues$/i, u: 'BRL_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 36 },
        { k: 'bio_assets', sec: 'rev', lab: /^\(\+\/-\) Changes in the Fair Value of Biological Assets$/i, nth: 0, u: 'BRL_mn', en: 'Biological asset fair-value change', row: 38 },
        { k: 'cogs', sec: 'rev', lab: /^\(-\) COGS$/i, u: 'BRL_mn', en: 'COGS', row: 39 },
        { k: 'd_a', sec: 'rev', lab: /^\(-\) Exaustion\/Depreciation$/i, u: 'BRL_mn', std: 'd_a', sign: 'pos', en: 'D&A and depletion', row: 40 },
        { k: 'cash_cogs', sec: 'rev', lab: /^\(-\) Cash COGS$/i, u: 'BRL_mn', sign: 'pos', en: 'Cash COGS', row: 41 },
        { k: 'sga', sec: 'rev', lab: /^\(-\) SG&A$/i, u: 'BRL_mn', en: 'SG&A', row: 43 },
        { k: 'other_opex', sec: 'rev', lab: /^\(-\) Other Revenues \/ Expenses$/i, u: 'BRL_mn', en: 'Other operating income/expenses', row: 45 },
        { k: 'profit_sharing', sec: 'rev', lab: /^\(-\) Management Profit Sharing$/i, u: 'BRL_mn', en: 'Management profit sharing', row: 46 },
        { k: 'ebitda', sec: 'rev', lab: /^\(=\) EBITDA$/i, u: 'BRL_mn', en: 'EBITDA (before adjustments)', row: 47 },
        { k: 'nonrecurring', sec: 'rev', lab: /^\(\+\) Non-Recurring Events$/i, u: 'BRL_mn', en: 'Non-recurring items', row: 49 },
        { k: 'adj_ebitda', sec: 'rev', lab: /^\(=\) Adjusted EBITDA$/i, u: 'BRL_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 51 },
        { k: 'ebit', sec: 'opex', lab: /^\(=\) EBIT$/i, u: 'BRL_mn', std: 'ebit', en: 'EBIT', row: 58 },
        { k: 'fin_result', sec: 'opex', lab: /^\(\+\/-\) Financial Results$/i, u: 'BRL_mn', en: 'Net financial result', row: 59 },
        { k: 'fin_income', sec: 'opex', lab: /^\(\+\) Financial Income$/i, u: 'BRL_mn', en: 'Financial income', row: 60 },
        { k: 'fin_expense', sec: 'opex', lab: /^\(-\) Financial Expenses$/i, u: 'BRL_mn', en: 'Financial expenses', row: 61 },
        { k: 'ebt', sec: 'opex', lab: /^\(=\) EBT$/i, u: 'BRL_mn', en: 'Pre-tax income', row: 62 },
        { k: 'discontinued', sec: 'opex', lab: /^\(-\) Discontinued Operations$/i, u: 'BRL_mn', en: 'Discontinued operations', row: 63 },
        { k: 'taxes', sec: 'opex', lab: /^\(-\) Income Taxes$/i, u: 'BRL_mn', en: 'Income taxes', row: 64 },
        { k: 'minorities', sec: 'opex', lab: /^\(-\) Minority Interest$/i, u: 'BRL_mn', en: 'Minority interests', row: 66 },
        { k: 'net_income', sec: 'opex', lab: /^\(=\) Net Income$/i, u: 'BRL_mn', std: 'net_income', head: true, en: 'Net income', row: 67 },
        { k: 'px.corrugated', calc: { op: 'per_unit', a: 'rev.corrugated', b: 'vol.corrugated', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'corrugated_boxes_brl', seg: 'corrugated', head: true, en: 'Corrugated packaging realized price' },
        { k: 'px.packaging_paper', calc: { op: 'per_unit', a: 'rev.packaging_paper', b: 'vol.paper', scale: 1000 }, u: 'BRL/t', std: 'realized_price', def: 'packaging_paper_brl', seg: 'packaging_paper', en: 'Packaging paper realized price' },
        { k: 'px.flexible', calc: { op: 'per_unit', a: 'rev.flexible', b: 'vol.flexible', scale: 1000 }, u: 'BRL/t', seg: 'packaging_paper', en: 'Flexible paper realized price' },
        { k: 'px.rigid', calc: { op: 'per_unit', a: 'rev.rigid', b: 'vol.rigid', scale: 1000 }, u: 'BRL/t', seg: 'packaging_paper', en: 'Rigid paper realized price' },
        { k: 'cash_cost_t', calc: { op: 'per_unit', a: 'cash_cogs', b: 'vol', scale: 1000 }, u: 'BRL/t', std: 'cash_cost', def: 'irani_cash_cogs_brl_t', en: 'Cash COGS per tonne' }
      ],
      derived: [
        { k: 'chk.px.corrugated', sec: 'px', lab: /^Corrugated Cardboard$/i, unit: /^BRL\/ton$/i, calc: { op: 'per_unit', a: 'rev.corrugated', b: 'vol.corrugated', scale: 1000 } },
        { k: 'chk.margin', sec: 'opex', lab: /^EBITDA Margin \(%\)$/i, calc: { op: 'div', a: 'ebitda', b: 'revenue' } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'filed', field: 'rev', tol: 0.001, hard: true },
      { k: 'fx.avg', vs: 'fx', tol: 0.01, hard: true },
      { k: 'net_income', vs: 'filed', field: 'ni', tol: 0.02 },
      { k: 'ebitda', vs: 'filed', field: 'ebitda', tol: 0.02 }
    ]
  });

  // CMPC — US$, sem robô: a âncora é a receita do release digitada no /admin. O custo e as despesas por
  // negócio são rateio do modelo (só o EBITDA é digitado) → fora; custo caixa/t por fibra é digitado → entra.
  // Quebra de metodologia em 1Q23 (intercompany e sinal do D&A): vira aviso de sinal e anotação.
  const CMPC_OP = /^\(-\) |^\(\+\) |^\(\+\/-\) |as % of Net Revenues|EBITDA Margin|^Biopackaging Cash COGS per Ton$/i;
  MANIFESTS.push({
    id: 'CMPC', v: 1, file: /^CMPC_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Preview$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 3, firstCol: 'D', firstQ: '2019Q1',
      sections: [
        ['nr', /^Net Revenues$/i], ['softys', /^Tissue & Personal Care$/i], ['bio', /^\(=\) Total Softys Revenues$/i],
        ['pf', /^Pulp & Forestry$/i], ['pf_px', /^Prices$/i], ['pf_rev', /^Revenues$/i],
        ['op_softys', /^Softys \(Tissue & Personal Care\)$/i], ['op_bio', /^Biopackaging$/i], ['op_pf', /^Pulp & Forestry$/i],
        ['cons', /^Consolidated$/i], ['fin', /^Financial Profile$/i]
      ],
      exclude: [
        { cls: 'plug', sec: 'nr', lab: /^Softys \+ Biopackaging|^Other$|^Intercompany Sales$/i },
        { cls: 'derived', lab: /^(Tissue|Personal Care|Biopackaging)$/i, unit: /^USD\/(ton|unit)$/i },
        { cls: 'derived', sec: 'pf_px', lab: /^Forestry$/i },
        { cls: 'derived', sec: 'pf_rev', lab: /^(BSKP|BHKP|Others)$/i },
        { cls: 'allocation', sec: 'op_softys', lab: CMPC_OP }, { cls: 'allocation', sec: 'op_bio', lab: CMPC_OP },
        { cls: 'allocation', sec: 'op_pf', lab: CMPC_OP }, { cls: 'allocation', sec: 'op_pf', lab: /per m3$/i },
        { cls: 'dup', sec: 'cons', lab: /^\(=\) Operating Net Revenues$|^\(\+\) Intercompany Sales$|^\(=\) Total Net Revenues$/i },
        { cls: 'derived', lab: /^EBITDA Margin \(%\)$|Effective Tax Rate/i },
        { cls: 'derived', sec: 'fin', lab: /Net Debt to EBITDA|^% of |^\(\+\) Financial Income$|^\(-\) Financial Expenses$/i }
      ],
      rows: [
        { k: 'fx.eop', lab: /^FX EOP$/i, unit: /^CLP\/USD$/i, u: 'CLP/USD', std: 'fx_eop', agg: 'stock', en: 'FX — CLP/USD end of period', row: 4 },
        { k: 'fx.avg', lab: /^FX Avg$/i, unit: /^CLP\/USD$/i, u: 'CLP/USD', std: 'fx_avg', agg: 'rate', en: 'FX — CLP/USD average', row: 5 },
        { k: 'revenue', sec: 'nr', lab: /^Total Net Revenues$/i, u: 'USD_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 10 },
        { k: 'softys.vol.tissue', sec: 'softys', lab: /^Tissue$/i, unit: /^ktons$/i, nth: 0, u: 'kt', std: 'sales_volume', def: 'tissue_kt', seg: 'softys', en: 'Tissue sales', row: 17 },
        { k: 'softys.vol.personal_care', sec: 'softys', lab: /^Personal Care$/i, unit: /^m units$/i, u: 'mn_units', seg: 'softys', en: 'Personal care sales (units)', row: 19 },
        { k: 'softys.vol.diapers', sec: 'softys', lab: /^Diapers$/i, u: 'mn_units', seg: 'softys', en: 'Diapers (units)', row: 20 },
        { k: 'softys.vol.feminine', sec: 'softys', lab: /^Feminine Care$/i, u: 'mn_units', seg: 'softys', en: 'Feminine care (units)', row: 21 },
        { k: 'softys.rev.tissue', sec: 'softys', lab: /^Tissue$/i, unit: /^USD mn$/i, u: 'USD_mn', seg: 'softys', en: 'Revenue — tissue', row: 29 },
        { k: 'softys.rev.personal_care', sec: 'softys', lab: /^Personal Care$/i, unit: /^USD mn$/i, u: 'USD_mn', seg: 'softys', en: 'Revenue — personal care', row: 30 },
        { k: 'softys.rev', sec: 'bio', lab: /^\(=\) Total Softys Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'softys', en: 'Revenue — Softys', row: 31 },
        { k: 'bio.vol', sec: 'bio', lab: /^Volumes$/i, unit: /^ktons$/i, u: 'kt', std: 'sales_volume', def: 'biopackaging_kt', seg: 'biopackaging', en: 'Biopackaging sales', row: 34 },
        { k: 'bio.vol.boxboard', sec: 'bio', lab: /^Boxboard$/i, u: 'kt', seg: 'biopackaging', en: 'Boxboard sales', row: 35 },
        { k: 'bio.vol.bags', sec: 'bio', lab: /^Paper Bags$/i, u: 'kt', seg: 'biopackaging', en: 'Paper bags sales', row: 36 },
        { k: 'bio.vol.corrugated_paper', sec: 'bio', lab: /^Corrugated Paper$/i, u: 'kt', seg: 'biopackaging', en: 'Corrugated paper sales', row: 37 },
        { k: 'bio.vol.boxes', sec: 'bio', lab: /^Corrugated Boxes$/i, u: 'kt', seg: 'biopackaging', en: 'Corrugated boxes sales', row: 38 },
        { k: 'bio.vol.trays', sec: 'bio', lab: /^Molded Pulp Trays$/i, u: 'kt', seg: 'biopackaging', en: 'Molded pulp trays sales', row: 39 },
        { k: 'bio.rev', sec: 'bio', lab: /^\(=\) Total Biopackaging Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'biopackaging', en: 'Revenue — Biopackaging', row: 46 },
        { k: 'pulp.vol', sec: 'pf', lab: /^Pulp$/i, unit: /^ktons$/i, u: 'kt', std: 'sales_volume', def: 'pulp_kt', seg: 'pulp', head: true, en: 'Pulp sales', row: 50 },
        { k: 'pulp.vol.bskp', sec: 'pf', lab: /^BSKP$/i, unit: /^ktons$/i, u: 'kt', seg: 'pulp', en: 'Pulp sales — BSKP', row: 51 },
        { k: 'pulp.vol.bhkp', sec: 'pf', lab: /^BHKP$/i, unit: /^ktons$/i, u: 'kt', seg: 'pulp', en: 'Pulp sales — BHKP', row: 52 },
        { k: 'forestry.vol', sec: 'pf', lab: /^Forestry$/i, u: 'k_m3', seg: 'forestry', en: 'Wood products sales', row: 53 },
        { k: 'forestry.vol.sawn', sec: 'pf', lab: /^Sawn Timber$/i, u: 'k_m3', seg: 'forestry', en: 'Sawn timber sales', row: 56 },
        { k: 'forestry.vol.plywood', sec: 'pf', lab: /^Plywood$/i, u: 'k_m3', seg: 'forestry', en: 'Plywood sales', row: 58 },
        { k: 'pulp.px.bskp', sec: 'pf_px', lab: /^BSKP$/i, unit: /^USD\/ton$/i, u: 'USD/t', std: 'realized_price', def: 'pulp_sw_usd', agg: 'rate', seg: 'pulp', en: 'BSKP realized price', row: 63 },
        { k: 'pulp.px.bhkp', sec: 'pf_px', lab: /^BHKP$/i, unit: /^USD\/ton$/i, u: 'USD/t', std: 'realized_price', def: 'pulp_hw_usd', agg: 'rate', seg: 'pulp', head: true, en: 'BHKP realized price', row: 64 },
        { k: 'pf.rev', sec: 'pf_rev', lab: /^Pulp & Forestry$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'pulp_forestry', en: 'Revenue — Pulp & Forestry', row: 69 },
        { k: 'pulp.rev', sec: 'pf_rev', lab: /^Pulp$/i, unit: /^USD m$/i, u: 'USD_mn', seg: 'pulp', en: 'Revenue — pulp', row: 70 },
        { k: 'forestry.rev', sec: 'pf_rev', lab: /^Forestry$/i, nth: 1, u: 'USD_mn', seg: 'forestry', en: 'Revenue — wood products', row: 75 },
        { k: 'softys.ebitda', sec: 'op_softys', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'softys', en: 'EBITDA — Softys', row: 88 },
        { k: 'bio.ebitda', sec: 'op_bio', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'biopackaging', en: 'EBITDA — Biopackaging', row: 103 },
        { k: 'pulp.cash_cost_t.bskp', sec: 'op_pf', lab: /^BSKP Cash COGS per Ton$/i, u: 'USD/t', sign: 'pos', std: 'cash_cost', def: 'pulp_sw_cash_cost_usd_t', agg: 'rate', seg: 'pulp', en: 'BSKP cash cost', row: 117 },
        { k: 'pulp.cash_cost_t.bhkp', sec: 'op_pf', lab: /^BHKP Cash COGS per Ton$/i, u: 'USD/t', sign: 'pos', std: 'cash_cost', def: 'pulp_hw_cash_cost_usd_t', agg: 'rate', seg: 'pulp', head: true, en: 'BHKP cash cost', row: 119 },
        { k: 'pf.ebitda', sec: 'op_pf', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'pulp_forestry', en: 'EBITDA — Pulp & Forestry', row: 126 },
        { k: 'ebitda_operating', sec: 'cons', lab: /^\(=\) Operating EBITDA$/i, u: 'USD_mn', en: 'Operating EBITDA (sum of businesses)', row: 136 },
        { k: 'ebitda_other_adj', sec: 'cons', lab: /^\(=\) Other Adjustments$/i, u: 'USD_mn', en: 'Corporate and other adjustments', row: 137 },
        { k: 'adj_ebitda', sec: 'cons', lab: /^\(=\) Reported Consolidated EBITDA$/i, u: 'USD_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 138 },
        { k: 'd_a', sec: 'cons', lab: /^\(-\) Depreciation \+ Amortization$/i, u: 'USD_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 140 },
        { k: 'bio_assets', sec: 'cons', lab: /^\(\+\/-\) Biological Asset Revaluation$/i, u: 'USD_mn', en: 'Biological asset revaluation', row: 141 },
        { k: 'ebit', sec: 'cons', lab: /^\(=\) EBIT$/i, u: 'USD_mn', std: 'ebit', en: 'EBIT', row: 142 },
        { k: 'fin_result', sec: 'cons', lab: /^\(\+\/-\) Financial Results$/i, u: 'USD_mn', en: 'Net financial result', row: 143 },
        { k: 'fx_var', sec: 'cons', lab: /^\(\+\/-\) FX Variation$/i, u: 'USD_mn', en: 'FX variation', row: 146 },
        { k: 'equity_income', sec: 'cons', lab: /^\(\+\/-\) Equity Income$/i, u: 'USD_mn', en: 'Equity income', row: 147 },
        { k: 'ebt', sec: 'cons', lab: /^\(=\) EBT$/i, u: 'USD_mn', en: 'Pre-tax income', row: 149 },
        { k: 'taxes', sec: 'cons', lab: /^\(-\) Income Taxes$/i, u: 'USD_mn', en: 'Income taxes', row: 150 },
        { k: 'minorities', sec: 'cons', lab: /^\(-\) Minority Interest$/i, u: 'USD_mn', en: 'Minority interests', row: 152 },
        { k: 'net_income', sec: 'cons', lab: /^\(=\) Net Income \(ex-minorities\)$/i, u: 'USD_mn', std: 'net_income', head: true, en: 'Net income', row: 153 },
        { k: 'gross_debt', sec: 'fin', lab: /^Gross Debt$/i, u: 'USD_mn', agg: 'stock', en: 'Gross debt', row: 156 },
        { k: 'cash', sec: 'fin', lab: /^\(-\) Cash$/i, u: 'USD_mn', agg: 'stock', sign: 'pos', en: 'Cash', row: 157 },
        { k: 'net_debt', sec: 'fin', lab: /^\(=\) Net Debt$/i, u: 'USD_mn', std: 'net_debt', head: true, en: 'Net debt', row: 158 },
        { k: 'softys.px.tissue', calc: { op: 'per_unit', a: 'softys.rev.tissue', b: 'softys.vol.tissue', scale: 1000 }, u: 'USD/t', seg: 'softys', en: 'Tissue revenue per tonne' },
        { k: 'bio.px', calc: { op: 'per_unit', a: 'bio.rev', b: 'bio.vol', scale: 1000 }, u: 'USD/t', std: 'realized_price', def: 'biopackaging_usd', seg: 'biopackaging', en: 'Biopackaging revenue per tonne' }
      ],
      derived: [
        { k: 'chk.px.bio', sec: 'bio', lab: /^Biopackaging$/i, unit: /^USD\/ton$/i, calc: { op: 'per_unit', a: 'bio.rev', b: 'bio.vol', scale: 1000 } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'gold', tol: 0.002, hard: true }
    ]
  });

  // Copec — US$, sem robô, sem câmbio e sem dívida no modelo: a âncora é a receita do release. As
  // "ktons" de painéis e madeira são mil m³. Custo caixa/t da celulose = (receita − EBITDA) ÷ volume, a
  // mesma conta do modelo, refeita aqui. O EBITDA consolidado do 2Q26 tem ajuste do analista (fórmula).
  MANIFESTS.push({
    id: 'COPEC', v: 1, file: /^Copec_Quarterly_Model/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^Simplified Preview Model$/, layout: 'cols', labelCol: 'B', unitCol: 'C', headerRow: 5, firstCol: 'D', firstQ: '2018Q1',
      sections: [
        ['forestry', /^FORESTRY SEGMENT$/], ['f_px', /^Prices$/], ['f_rev', /^Revenues$/], ['energy', /^ENERGY SEGMENT$/],
        ['copec', /^Copec$/], ['abastible', /^Abastible$/], ['sonacol', /^Sonacol$/], ['others', /^OTHERS\/ELIMINATIONS$/],
        ['cons', /^CONSOLIDATED$/]
      ],
      exclude: [
        { cls: 'derived', sec: 'f_px', lab: /./ },
        { cls: 'derived', sec: 'forestry', lab: /^Total$/i },
        { cls: 'derived', sec: 'f_rev', lab: /^Forestry and Others$/i },
        { cls: 'derived', lab: /Cash Opex\/ton|Avg Revenue\/ton|Margin|Effective Tax Rate/i },
        { cls: 'derived', lab: /Cash Opex$/i },
        { cls: 'plug', sec: 'others', lab: /./ }
      ],
      rows: [
        { k: 'pulp.vol', sec: 'forestry', lab: /^Pulp$/i, unit: /^ktons$/i, u: 'kt', std: 'sales_volume', def: 'pulp_kt', seg: 'pulp', head: true, en: 'Pulp sales', row: 9 },
        { k: 'panels.vol', sec: 'forestry', lab: /^Panels$/i, u: 'k_m3', seg: 'wood_products', en: 'Panels sales', row: 10 },
        { k: 'sawn.vol', sec: 'forestry', lab: /^Sawn Timber$/i, u: 'k_m3', seg: 'wood_products', en: 'Sawn timber sales', row: 11 },
        { k: 'plywood.vol', sec: 'forestry', lab: /^Plywood$/i, u: 'k_m3', seg: 'wood_products', en: 'Plywood sales', row: 12 },
        { k: 'rev.pulp_energy', sec: 'f_rev', lab: /^Pulp \+ Energy Sales$/i, u: 'USD_mn', seg: 'pulp', en: 'Revenue — pulp and energy', row: 22 },
        { k: 'rev.pulp', sec: 'f_rev', lab: /^Pulp$/i, nth: 0, u: 'USD_mn', seg: 'pulp', en: 'Revenue — pulp', row: 23 },
        { k: 'rev.energy_sales', sec: 'f_rev', lab: /^Energy Sales$/i, u: 'USD_mn', seg: 'pulp', en: 'Revenue — energy sales (Arauco)', row: 24 },
        { k: 'rev.wood_products', sec: 'f_rev', lab: /^Wood Products$/i, nth: 0, u: 'USD_mn', seg: 'wood_products', en: 'Revenue — wood products', row: 25 },
        { k: 'forestry.rev', sec: 'f_rev', lab: /^\(=\) Forestry Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'forestry', en: 'Revenue — Forestry (Arauco)', row: 27 },
        { k: 'forestry.ebitda', sec: 'f_rev', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'forestry', en: 'EBITDA — Forestry (Arauco)', row: 37 },
        { k: 'pulp.ebitda', sec: 'f_rev', lab: /^Pulp$/i, after: /^\(=\) EBITDA$/i, nth: 0, u: 'USD_mn', std: 'segment_ebitda', seg: 'pulp', en: 'EBITDA — pulp', row: 38 },
        { k: 'wood_products.ebitda', sec: 'f_rev', lab: /^Wood Products$/i, after: /^\(=\) EBITDA$/i, nth: 0, u: 'USD_mn', std: 'segment_ebitda', seg: 'wood_products', en: 'EBITDA — wood products', row: 39 },
        { k: 'forestry_other.ebitda', sec: 'f_rev', lab: /^Others\/Adjustments$/i, u: 'USD_mn', seg: 'forestry', en: 'EBITDA — forestry others/adjustments', row: 40 },
        { k: 'energy.rev', sec: 'energy', lab: /^\(=\) Consolidated Energy Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'energy', en: 'Revenue — Energy', row: 45 },
        { k: 'energy.ebitda', sec: 'energy', lab: /^\(=\) Consolidated Energy EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'energy', en: 'EBITDA — Energy', row: 49 },
        { k: 'copec.vol.fuel', sec: 'copec', lab: /^Fuel Sales$/i, u: 'k_m3', std: 'sales_volume', def: 'fuel_k_m3', seg: 'copec', en: 'Fuel sales (Copec + Terpel)', row: 54 },
        { k: 'copec.vol.chile', sec: 'copec', lab: /^Copec$/i, unit: /m³/, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Copec (Chile)', row: 55 },
        { k: 'copec.vol.terpel', sec: 'copec', lab: /^Terpel$/i, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Terpel', row: 59 },
        { k: 'copec.vol.colombia', sec: 'copec', lab: /^Colombia$/i, nth: 0, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Terpel Colombia', row: 60 },
        { k: 'copec.vol.panama', sec: 'copec', lab: /^Panama$/i, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Terpel Panama', row: 61 },
        { k: 'copec.vol.ecuador', sec: 'copec', lab: /^Ecuador$/i, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Terpel Ecuador', row: 62 },
        { k: 'copec.vol.dominican', sec: 'copec', lab: /^Dominican Republic$/i, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Terpel Dominican Republic', row: 63 },
        { k: 'copec.vol.peru', sec: 'copec', lab: /^Peru$/i, u: 'k_m3', seg: 'copec', en: 'Fuel sales — Terpel Peru', row: 64 },
        { k: 'copec.rev', sec: 'copec', lab: /^\(=\) Copec Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'copec', en: 'Revenue — Copec (fuels)', row: 75 },
        { k: 'copec.ebitda', sec: 'copec', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'copec', en: 'EBITDA — Copec (fuels)', row: 80 },
        { k: 'abastible.vol', sec: 'abastible', lab: /^LPG Sales$/i, u: 'kt', std: 'sales_volume', def: 'lpg_kt', seg: 'abastible', en: 'LPG sales', row: 86 },
        { k: 'abastible.rev', sec: 'abastible', lab: /^\(=\) Abastible Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'abastible', en: 'Revenue — Abastible (LPG)', row: 96 },
        { k: 'abastible.ebitda', sec: 'abastible', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'abastible', en: 'EBITDA — Abastible (LPG)', row: 101 },
        { k: 'sonacol.rev', sec: 'sonacol', lab: /^\(=\) Sonacol Revenues$/i, u: 'USD_mn', std: 'segment_revenue', seg: 'sonacol', en: 'Revenue — Sonacol', row: 106 },
        { k: 'sonacol.ebitda', sec: 'sonacol', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'segment_ebitda', seg: 'sonacol', en: 'EBITDA — Sonacol', row: 110 },
        { k: 'revenue', sec: 'cons', lab: /^\(=\) Net Revenues$/i, u: 'USD_mn', std: 'revenue', head: true, req: true, en: 'Net revenue', row: 123 },
        { k: 'adj_ebitda', sec: 'cons', lab: /^\(=\) EBITDA$/i, u: 'USD_mn', std: 'adj_ebitda', head: true, req: true, en: 'Adjusted EBITDA', row: 127 },
        { k: 'd_a', sec: 'cons', lab: /^\(-\) Depreciation\/Amortization$/i, u: 'USD_mn', std: 'd_a', sign: 'pos', en: 'D&A', row: 130 },
        { k: 'timber_fv', sec: 'cons', lab: /^\(-\) Fair Value Cost of Timber Harvested$/i, u: 'USD_mn', en: 'Fair-value cost of timber harvested', row: 131 },
        { k: 'ebitda_elim', sec: 'cons', lab: /^\(-\) Eliminations EBITDA$/i, u: 'USD_mn', en: 'EBITDA eliminations', row: 132 },
        { k: 'ebit', sec: 'cons', lab: /^\(=\) EBIT$/i, u: 'USD_mn', std: 'ebit', en: 'EBIT', row: 134 },
        { k: 'fin_result', sec: 'cons', lab: /^\(\+\/-\) Net Financial Result$/i, u: 'USD_mn', en: 'Net financial result', row: 135 },
        { k: 'fin_expense', sec: 'cons', lab: /^\(-\) Financial Expenses$/i, u: 'USD_mn', en: 'Financial expenses', row: 136 },
        { k: 'fin_income', sec: 'cons', lab: /^\(\+\) Financial Income$/i, u: 'USD_mn', en: 'Financial income', row: 137 },
        { k: 'other_nonop', sec: 'cons', lab: /^\(\+\/-\) Other Non-Operating Results$/i, u: 'USD_mn', en: 'Other non-operating results', row: 138 },
        { k: 'equity_income', sec: 'cons', lab: /^\(\+\/-\) Equity Income$/i, u: 'USD_mn', en: 'Equity income', row: 144 },
        { k: 'ebt', sec: 'cons', lab: /^\(=\) EBT$/i, u: 'USD_mn', en: 'Pre-tax income', row: 145 },
        { k: 'taxes', sec: 'cons', lab: /^\(-\) Income Taxes$/i, u: 'USD_mn', en: 'Income taxes', row: 146 },
        { k: 'minorities', sec: 'cons', lab: /^\(-\) Minority Interest$/i, u: 'USD_mn', en: 'Minority interests', row: 148 },
        { k: 'net_income', sec: 'cons', lab: /^\(=\) Net Income$/i, u: 'USD_mn', std: 'net_income', head: true, en: 'Net income', row: 150 },
        { k: 'pulp.px', calc: { op: 'per_unit', a: 'rev.pulp', b: 'pulp.vol', scale: 1000 }, u: 'USD/t', std: 'realized_price', def: 'pulp_mix_usd', seg: 'pulp', head: true, en: 'Pulp realized price' },
        { k: 'pulp.cash_opex', calc: { op: 'sub', a: 'rev.pulp_energy', b: 'pulp.ebitda' }, u: 'USD_mn', agg: 'flow', seg: 'pulp', en: 'Pulp cash opex (revenue − EBITDA)' },
        { k: 'pulp.cash_opex_t', calc: { op: 'per_unit', a: 'pulp.cash_opex', b: 'pulp.vol', scale: 1000 }, u: 'USD/t', std: 'cash_cost', def: 'pulp_cash_opex_usd_t', seg: 'pulp', en: 'Pulp cash opex per tonne' }
      ],
      derived: [
        { k: 'chk.px.pulp', sec: 'f_px', lab: /^Pulp$/i, calc: { op: 'per_unit', a: 'rev.pulp', b: 'pulp.vol', scale: 1000 } },
        { k: 'chk.opex_t', sec: 'f_rev', lab: /^Cash Opex\/ton$/i, nth: 0, calc: { op: 'per_unit', a: 'pulp.cash_opex', b: 'pulp.vol', scale: -1000 } }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'gold', tol: 0.002, hard: true }
    ]
  });

  // Grupo México — um bloco por trimestre com 7 colunas (SCCO, Asarco, AMC, Transporte, Infraestrutura,
  // Eliminações, GMEX), passo irregular de 9 a 11 colunas; o bloco do 2Q26 está rotulado '1Q26a'. Da linha
  // 11 para baixo só a coluna GMEX tem número. Sem robô: a âncora é a receita do release, e a coluna SCCO
  // tem de bater com a receita lida pelo manifesto da própria Southern Copper (mesmo arquivo).
  MANIFESTS.push({
    id: 'GMEXICOB', v: 1, file: /^Preview Template \(SCCO \+ GMEX\)/i,
    required: ['revenue', 'adj_ebitda'],
    sheets: [{
      name: /^GMEX Preview$/, layout: 'blocks',
      blocks: {
        anchorRow: 3, anchor: /^Net Revenues$/i, segRow: 2, periodRow: 1, periodOffset: 7, firstQ: '2020Q1', step: [9, 11], width: 8,
        segs: [
          { key: 'scco', name: /^SCCO$/i, en: 'Southern Copper' }, { key: 'asarco', name: /^Asarco$/i, en: 'Asarco' },
          { key: 'amc', name: /^AMC$/i, en: 'Americas Mining' }, { key: 'transport', name: /^Transportation$/i, en: 'Transportation' },
          { key: 'infra', name: /^Infrastr\.?$/i, en: 'Infrastructure' }, { key: 'elim', name: /^Elimin\.?$/i, en: 'Eliminations' },
          { key: 'gmex', name: /^GMEX$/i, en: 'Grupo México', total: true }
        ]
      },
      rows: [
        { k: 'rev.{seg}', lab: /^Net Revenues$/i, u: 'USD_mn', segStd: 'segment_revenue', std: { gmex: 'revenue' }, keys: { gmex: 'revenue' }, head: { gmex: true }, en: 'Revenue — {seg}', row: 3 },
        { k: 'cash_cogs.{seg}', lab: /^\(-\) Cash COGS$/i, u: 'USD_mn', keys: { gmex: 'cash_cogs' }, en: 'Cash COGS — {seg}', row: 4 },
        { k: 'opex.{seg}', lab: /^\(-\) Operating Expenses$/i, u: 'USD_mn', keys: { gmex: 'opex' }, en: 'Operating expenses — {seg}', row: 5 },
        { k: 'ebitda.{seg}', lab: /^EBITDA$/i, u: 'USD_mn', segStd: 'segment_ebitda', std: { gmex: 'adj_ebitda' }, keys: { gmex: 'adj_ebitda' }, head: { gmex: true }, en: 'Adjusted EBITDA — {seg}', row: 6 },
        // unidade do volume ferroviário a confirmar com o analista (a conta receita ÷ volume do modelo sugere bilhões de t-km)
        { k: 'rail.vol', lab: /^Volume$/i, labOff: 3, onlySegs: ['transport'], keys: { transport: 'rail.vol' }, u: 'bn_tkm', std: { transport: 'sales_volume' }, def: 'rail_bn_tkm', en: 'Rail volume', row: 9 },
        { k: 'd_a', lab: /^\(-\) Depreciation$/i, onlySegs: ['gmex'], keys: { gmex: 'd_a' }, std: { gmex: 'd_a' }, sign: 'pos', u: 'USD_mn', en: 'D&A', row: 11 },
        { k: 'adjustments', lab: /^\(\+\/-\) Adjustments$/i, onlySegs: ['gmex'], keys: { gmex: 'adjustments' }, u: 'USD_mn', en: 'Adjustments', row: 12 },
        { k: 'ebit', lab: /^\(=\) Operating Income$/i, onlySegs: ['gmex'], keys: { gmex: 'ebit' }, std: { gmex: 'ebit' }, u: 'USD_mn', en: 'Operating income', row: 13 },
        { k: 'interest_exp', lab: /^\(-\) Interest Expenses$/i, onlySegs: ['gmex'], keys: { gmex: 'interest_exp' }, u: 'USD_mn', en: 'Interest expense', row: 14 },
        { k: 'interest_inc', lab: /^\(\+\) Interest Income$/i, onlySegs: ['gmex'], keys: { gmex: 'interest_inc' }, u: 'USD_mn', en: 'Interest income', row: 15 },
        { k: 'other_fin', lab: /^\(\+\/-\) Other$/i, onlySegs: ['gmex'], keys: { gmex: 'other_fin' }, u: 'USD_mn', en: 'Other financial and non-operating items', row: 16 },
        { k: 'ebt', lab: /^\(=\) EBT$/i, onlySegs: ['gmex'], keys: { gmex: 'ebt' }, u: 'USD_mn', en: 'Pre-tax income', row: 17 },
        { k: 'taxes', lab: /^\(-\) Income Taxes$/i, onlySegs: ['gmex'], keys: { gmex: 'taxes' }, u: 'USD_mn', en: 'Income taxes', row: 18 },
        { k: 'equity_income', lab: /^\(\+\) Equity income$/i, onlySegs: ['gmex'], keys: { gmex: 'equity_income' }, u: 'USD_mn', en: 'Equity income', row: 20 },
        { k: 'eat', lab: /^\(=\) Earnings After Taxes$/i, onlySegs: ['gmex'], keys: { gmex: 'eat' }, u: 'USD_mn', en: 'Earnings after taxes', row: 21 },
        { k: 'minorities', lab: /^\(-\) Minorities$/i, onlySegs: ['gmex'], keys: { gmex: 'minorities' }, u: 'USD_mn', en: 'Minority interests', row: 22 },
        { k: 'net_income', lab: /^\(=\) Net Income$/i, onlySegs: ['gmex'], keys: { gmex: 'net_income' }, std: { gmex: 'net_income' }, head: { gmex: true }, u: 'USD_mn', en: 'Net income', row: 24 }
      ]
    }],
    finger: [
      { k: 'revenue', vs: 'gold', tol: 0.002, hard: true },
      { k: 'rev.scco', vs: 'sibling', sibling: 'SCCO.revenue', tol: 0.001, hard: true }
    ]
  });

  // o arquivo certo para cada manifesto (o de SCCO+GMEX serve a 2 empresas)
  function detect(fileName, sheetNames) {
    return MANIFESTS.filter(function (m) {
      if (m.file && m.file.test(fileName || '')) return true;
      return false;
    });
  }

  return {
    VERSION: VERSION, STD: STD, MANIFESTS: MANIFESTS,
    qFromHeader: qFromHeader, qIdx: qIdx, qFromIdx: qFromIdx, qAdd: qAdd, qCurrent: qCurrent, qShort: qShort, isQKey: isQKey,
    colIdx: colIdx, colName: colName, cellNum: cellNum, cellText: cellText, formulaKind: formulaKind, normLabel: normLabel,
    fromSheetJS: fromSheetJS, bookFromSheetJS: bookFromSheetJS, gridSheet: gridSheet, gridBook: gridBook,
    parseWorkbook: parseWorkbook, summarize: summarize, detect: detect,
    countValues: countValues, toBatches: toBatches, diffSeries: diffSeries, unitCcy: unitCcy,
    _internal: { resolveCols: resolveCols, resolveSections: resolveSections, resolveRow: resolveRow, readRows: readRows,
                 computeCalc: computeCalc, makeChecks: makeChecks, PAID_LABEL: PAID_LABEL, PAID_SHEET: PAID_SHEET }
  };
});
