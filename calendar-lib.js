/* =============================================================================
 * calendar-lib.js — motor PURO do Executive Calendar (zero Supabase, zero DOM).
 * Compartilhado por calendar.html (cliente), o preview do admin e os testes Node,
 * pra nunca divergirem (mesmo padrão do stock-guide-lib.js / window.SG).
 *
 * Convenções:
 *  - Datas trafegam como 'YYYY-MM-DD' (string). Toda Date interna é UTC-meio-dia
 *    (Date.UTC(y,m-1,d,12)) p/ nunca escorregar de dia por fuso/DST.
 *  - Dia da semana = convenção JS: 0=domingo … 6=sábado (byweekday usa isso).
 *  - Recorrência (jsonb do evento): { freq:'daily|weekly|monthly|yearly', interval:N,
 *      byweekday:[0..6]?, bymonthday:[1..31]?, bysetpos:[1,2,3,4,-1]?, until:'YYYY-MM-DD'?, count:N?,
 *      whole_week:true? }
 *    whole_week: cada ocorrência = a SEMANA ÚTIL inteira (Seg–Sex) que contém a data gerada
 *      (ex.: monthly + bysetpos:[2] + byweekday:[1] = "a 2ª semana inteira do mês"). Ignora end_date.
 * ============================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CAL = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS_LONG  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const WEEKDAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS_LONG    = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTHS_SHORT   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── date core (UTC-noon) ────────────────────────────────────────────────────
  const pad2 = n => (n < 10 ? '0' + n : '' + n);
  function mkYMD(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }          // m: 1..12
  function parseYMD(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); }
  function ymd(dt) { return mkYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
  function addDaysDate(dt, n) { const x = new Date(dt.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
  function addDays(s, n) { return ymd(addDaysDate(parseYMD(s), n)); }
  function dow(s) { return parseYMD(s).getUTCDay(); }                             // 0=Sun..6=Sat
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m: 1..12
  function diffDays(a, b) { return Math.round((parseYMD(b).getTime() - parseYMD(a).getTime()) / 86400000); }
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }                       // 'YYYY-MM-DD' ordena como string
  function overlaps(aS, aE, bS, bE) { return aS <= bE && aE >= bS; }

  // Hoje em BRT (America/Sao_Paulo) como 'YYYY-MM-DD'. (Testes passam data fixa; não usam isto.)
  function todayISO(tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (e) {
      const d = new Date(); return mkYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
  }

  // ── recorrência: gerador de datas-início EM ORDEM CRESCENTE (infinito; o driver corta) ──
  function* occStarts(rec, startYMD) {
    const freq = rec.freq;
    const interval = Math.max(1, rec.interval || 1);
    const s = parseYMD(startYMD);
    const sY = s.getUTCFullYear(), sM = s.getUTCMonth() + 1, sD = s.getUTCDate();

    if (freq === 'daily') {
      let d = s;
      while (true) { yield ymd(d); d = addDaysDate(d, interval); }
    }

    if (freq === 'weekly') {
      const wds = (rec.byweekday && rec.byweekday.length ? rec.byweekday.slice() : [s.getUTCDay()])
        .filter(w => w >= 0 && w <= 6).sort((a, b) => a - b);
      if (!wds.length) return;
      let sunday = addDaysDate(s, -s.getUTCDay());   // domingo âncora da semana de s
      while (true) {
        for (const wd of wds) {
          const d = addDaysDate(sunday, wd);
          if (cmp(ymd(d), startYMD) >= 0) yield ymd(d);
        }
        sunday = addDaysDate(sunday, 7 * interval);
      }
    }

    if (freq === 'monthly') {
      const byMonthday = rec.bymonthday && rec.bymonthday.length ? rec.bymonthday.slice().sort((a, b) => a - b) : null;
      const bySetpos = rec.bysetpos && rec.bysetpos.length ? rec.bysetpos.slice() : null;
      const byWd = rec.byweekday && rec.byweekday.length ? rec.byweekday.slice() : null;
      let y = sY, m = sM, guard = 0;
      while (guard++ < 4000) {
        const dim = daysInMonth(y, m);
        let days = [];
        if (bySetpos && byWd) {
          // n-ésima weekday do mês (ex.: "1ª terça"): p/ cada setpos × weekday
          for (const pos of bySetpos) for (const wd of byWd) {
            const day = nthWeekdayOfMonth(y, m, wd, pos);
            if (day) days.push(day);
          }
        } else if (byMonthday) {
          for (const D of byMonthday) if (D >= 1 && D <= dim) days.push(D);
        } else {
          if (sD <= dim) days.push(sD);            // mesmo dia-do-mês; pula meses sem esse dia
        }
        days = Array.from(new Set(days)).sort((a, b) => a - b);
        for (const D of days) {
          const cand = mkYMD(y, m, D);
          if (cmp(cand, startYMD) >= 0) yield cand;
        }
        m += interval; while (m > 12) { m -= 12; y++; }
      }
    }

    if (freq === 'yearly') {
      let y = sY, guard = 0;
      while (guard++ < 2000) {
        if (sD <= daysInMonth(y, sM)) {            // 29/fev pula anos não-bissextos
          const cand = mkYMD(y, sM, sD);
          if (cmp(cand, startYMD) >= 0) yield cand;
        }
        y += interval;
      }
    }
  }

  // dia-do-mês da n-ésima weekday (pos>0 = 1ª/2ª/…; pos=-1 = última). null se não existir.
  function nthWeekdayOfMonth(y, m, weekday, pos) {
    const dim = daysInMonth(y, m);
    const matches = [];
    for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() === weekday) matches.push(d);
    if (!matches.length) return null;
    if (pos === -1) return matches[matches.length - 1];
    return (pos >= 1 && pos <= matches.length) ? matches[pos - 1] : null;
  }

  // Expande UM evento em ocorrências que intersectam [fromISO,toISO]. Cada ocorrência:
  // { ...event, occ_start, occ_end, is_recurring }. Duração (em dias) é preservada.
  function expandOccurrences(ev, fromISO, toISO) {
    const startYMD = ev.start_date;
    if (!startYMD) return [];
    const durDays = ev.end_date ? Math.max(0, diffDays(startYMD, ev.end_date)) : 0;
    const rec = ev.recurrence;
    // whole_week: a ocorrência vira a semana útil INTEIRA (Seg–Sex) que contém a data gerada (ignora end_date).
    const wholeWeek = !!(rec && rec.whole_week);
    const workWeekSpan = (os) => { const monday = addDays(os, -((dow(os) + 6) % 7)); return { s: monday, e: addDays(monday, 4) }; };
    const rangeOf = (os) => wholeWeek ? workWeekSpan(os) : { s: os, e: addDays(os, durDays) };
    const out = [];
    const mk = (os) => { const r = rangeOf(os); return Object.assign({}, ev, { occ_start: r.s, occ_end: r.e, is_recurring: !!(rec && rec.freq) }); };

    if (!rec || !rec.freq) {
      const r = rangeOf(startYMD);
      if (overlaps(r.s, r.e, fromISO, toISO)) out.push(mk(startYMD));
      return out;
    }

    const until = rec.until || null;
    const maxCount = rec.count > 0 ? rec.count : Infinity;
    let n = 0, iter = 0;
    for (const os of occStarts(rec, startYMD)) {
      if (++iter > 6000) break;                     // trava dura
      if (until && cmp(os, until) > 0) break;
      if (n >= maxCount) break;
      n++;                                          // conta do início da série (semântica de count)
      if (cmp(os, toISO) > 0) break;                // starts só crescem → nada mais entra na janela
      const r = rangeOf(os);
      if (overlaps(r.s, r.e, fromISO, toISO)) out.push(mk(os));
    }
    return out;
  }

  // ── janelas de dados (auto) → faixa daquele mês + período-alvo p/ o rótulo ──
  // window: {source_key,label,from_day,to_day,lag_months}. year/month: mês visível (m 1..12).
  function dataWindowBands(win, year, month) {
    const dim = daysInMonth(year, month);
    const from = Math.min(Math.max(1, win.from_day || 1), dim);
    const to = Math.min(Math.max(from, win.to_day || from), dim);
    // período-alvo = mês visível - lag
    let ty = year, tm = month - (win.lag_months || 0);
    while (tm < 1) { tm += 12; ty--; }
    return {
      source_key: win.source_key,
      label: win.label,
      startYMD: mkYMD(year, month, from),
      endYMD: mkYMD(year, month, to),
      target: MONTHS_SHORT[tm - 1] + ' ' + ty,     // ex.: "Jun 2026"
      targetPeriod: mkYMD(ty, tm, 1).slice(0, 7)   // "YYYY-MM"
    };
  }

  // ── grade do mês: 6 semanas × N dias. weekStart: 0=domingo, 1=segunda (default).
  // daysPerWeek: 7 (default) ou 5 p/ semana útil (Seg–Sex; sáb/dom não aparecem). ──
  function monthMatrix(year, month, weekStart, daysPerWeek) {
    weekStart = (weekStart == null) ? 1 : weekStart;
    daysPerWeek = daysPerWeek || 7;
    const first = mkYMD(year, month, 1);
    const lead = (dow(first) - weekStart + 7) % 7;   // dias do mês anterior antes do dia 1
    const gridStart = addDays(first, -lead);
    const weeks = [];
    for (let w = 0; w < 6; w++) {
      const row = [];
      for (let d = 0; d < daysPerWeek; d++) {         // d<5 (útil) pega Seg..Sex; sáb/dom ficam de fora
        const cur = addDays(gridStart, w * 7 + d);
        row.push({ ymd: cur, inMonth: parseYMD(cur).getUTCMonth() + 1 === month, dow: dow(cur) });
      }
      weeks.push(row);
    }
    return weeks;
  }

  // N dias da semana que contém `anchor`. weekStart default = segunda; daysPerWeek default 7.
  function weekDays(anchorYMD, weekStart, daysPerWeek) {
    weekStart = (weekStart == null) ? 1 : weekStart;
    daysPerWeek = daysPerWeek || 7;
    const lead = (dow(anchorYMD) - weekStart + 7) % 7;
    const start = addDays(anchorYMD, -lead);
    const out = [];
    for (let d = 0; d < daysPerWeek; d++) out.push(addDays(start, d));
    return out;
  }
  function weekLabel(anchorYMD, weekStart, daysPerWeek) {
    const days = weekDays(anchorYMD, weekStart, daysPerWeek);
    const a = parseYMD(days[0]), b = parseYMD(days[days.length - 1]);
    const aM = MONTHS_SHORT[a.getUTCMonth()], bM = MONTHS_SHORT[b.getUTCMonth()];
    if (a.getUTCMonth() === b.getUTCMonth())
      return aM + ' ' + a.getUTCDate() + '–' + b.getUTCDate() + ', ' + b.getUTCFullYear();
    return aM + ' ' + a.getUTCDate() + ' – ' + bM + ' ' + b.getUTCDate() + ', ' + b.getUTCFullYear();
  }

  // Segmento visível de uma faixa [occStart,occEnd] numa linha-semana que começa em weekStartYMD.
  // Retorna {startCol:0..6, span:1..7} ou null se não intersecta a semana.
  function segmentForWeek(occStart, occEnd, weekStartYMD, daysPerWeek) {
    const wEnd = addDays(weekStartYMD, (daysPerWeek || 7) - 1);   // Seg..Sex clipa em Sex; faixas pulam o fim de semana
    if (!overlaps(occStart, occEnd, weekStartYMD, wEnd)) return null;
    const segStart = occStart < weekStartYMD ? weekStartYMD : occStart;
    const segEnd = occEnd > wEnd ? wEnd : occEnd;
    const startCol = diffDays(weekStartYMD, segStart);
    const span = diffDays(segStart, segEnd) + 1;
    return { startCol, span, contStart: occStart < weekStartYMD, contEnd: occEnd > wEnd };
  }

  // ── formatação ──────────────────────────────────────────────────────────────
  function monthTitle(year, month) { return MONTHS_LONG[month - 1] + ' ' + year; }
  function hhmm(t) { return t ? String(t).slice(0, 5) : ''; }
  function fmtTimeRange(st, et) {
    if (!st) return '';
    return hhmm(st) + (et ? '–' + hhmm(et) : '');
  }
  function fmtDateLong(s) {
    const d = parseYMD(s);
    return WEEKDAYS_LONG[d.getUTCDay()] + ', ' + MONTHS_LONG[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function isSameYMD(a, b) { return a === b; }

  return {
    WEEKDAYS_LONG, WEEKDAYS_SHORT, MONTHS_LONG, MONTHS_SHORT,
    mkYMD, parseYMD, ymd, addDays, dow, daysInMonth, diffDays, cmp, overlaps, todayISO,
    occStarts, nthWeekdayOfMonth, expandOccurrences, dataWindowBands,
    monthMatrix, weekDays, weekLabel, segmentForWeek,
    monthTitle, hhmm, fmtTimeRange, fmtDateLong, isSameYMD
  };
});
