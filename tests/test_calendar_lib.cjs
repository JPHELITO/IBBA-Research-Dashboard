/* Testes do motor puro calendar-lib.js — `node tests/test_calendar_lib.cjs`.
 * Datas conferidas à mão (2026-07-01 é uma QUARTA-feira). */
const CAL = require('../calendar-lib.js');

let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) passes++; else { fails++; console.error('  ✗ FAIL:', msg); } }
function eqArr(got, exp, msg) { ok(JSON.stringify(got) === JSON.stringify(exp), msg + '\n      got=' + JSON.stringify(got) + '\n      exp=' + JSON.stringify(exp)); }
function eq(got, exp, msg) { ok(got === exp, msg + '  (got=' + JSON.stringify(got) + ' exp=' + JSON.stringify(exp) + ')'); }
const starts = (ev, from, to) => CAL.expandOccurrences(ev, from, to).map(o => o.occ_start);

// ── helpers de data ──
eq(CAL.dow('2026-07-01'), 3, 'dow: 2026-07-01 = quarta (3)');
eq(CAL.daysInMonth(2026, 2), 28, 'daysInMonth fev/2026 = 28');
eq(CAL.daysInMonth(2024, 2), 29, 'daysInMonth fev/2024 = 29 (bissexto)');
eq(CAL.addDays('2026-07-30', 3), '2026-08-02', 'addDays cruza mês');
eq(CAL.diffDays('2026-07-30', '2026-08-02'), 3, 'diffDays');
eq(CAL.nthWeekdayOfMonth(2026, 7, 2, 1), 7, '1ª terça de jul/2026 = 7');
eq(CAL.nthWeekdayOfMonth(2026, 7, 5, -1), 31, 'última sexta de jul/2026 = 31');

// ── não-recorrente ──
eqArr(starts({ start_date: '2026-07-15' }, '2026-07-01', '2026-07-31'), ['2026-07-15'], 'único dentro da janela');
eqArr(starts({ start_date: '2026-07-15' }, '2026-08-01', '2026-08-31'), [], 'único fora da janela');

// ── multi-dia (range) ──
{
  const occ = CAL.expandOccurrences({ start_date: '2026-07-30', end_date: '2026-08-02' }, '2026-07-01', '2026-07-31');
  eq(occ.length, 1, 'range aparece em julho');
  eq(occ[0].occ_end, '2026-08-02', 'range preserva occ_end');
  eq(CAL.expandOccurrences({ start_date: '2026-07-30', end_date: '2026-08-02' }, '2026-08-01', '2026-08-31').length, 1, 'mesmo range aparece em agosto');
}

// ── semanal ──
eqArr(starts({ start_date: '2026-07-01', recurrence: { freq: 'weekly', interval: 1 } }, '2026-07-01', '2026-07-28'),
  ['2026-07-01', '2026-07-08', '2026-07-15', '2026-07-22'], 'semanal default (quarta)');
eqArr(starts({ start_date: '2026-07-01', recurrence: { freq: 'weekly', interval: 1, byweekday: [1, 3, 5] } }, '2026-07-01', '2026-07-14'),
  ['2026-07-01', '2026-07-03', '2026-07-06', '2026-07-08', '2026-07-10', '2026-07-13'], 'semanal seg/qua/sex');
eqArr(starts({ start_date: '2026-07-01', recurrence: { freq: 'weekly', interval: 2 } }, '2026-07-01', '2026-08-31'),
  ['2026-07-01', '2026-07-15', '2026-07-29', '2026-08-12', '2026-08-26'], 'quinzenal');

// ── mensal ──
eqArr(starts({ start_date: '2026-01-15', recurrence: { freq: 'monthly', interval: 1, bymonthday: [15] } }, '2026-03-01', '2026-05-31'),
  ['2026-03-15', '2026-04-15', '2026-05-15'], 'mensal dia-15');
eqArr(starts({ start_date: '2026-01-01', recurrence: { freq: 'monthly', interval: 1, bysetpos: [1], byweekday: [2] } }, '2026-07-01', '2026-09-30'),
  ['2026-07-07', '2026-08-04', '2026-09-01'], 'mensal 1ª terça');
eqArr(starts({ start_date: '2026-07-01', recurrence: { freq: 'monthly', bysetpos: [-1], byweekday: [5] } }, '2026-07-01', '2026-07-31'),
  ['2026-07-31'], 'mensal última sexta');

// ── anual ──
eqArr(starts({ start_date: '2026-01-01', recurrence: { freq: 'yearly' } }, '2026-01-01', '2029-12-31'),
  ['2026-01-01', '2027-01-01', '2028-01-01', '2029-01-01'], 'anual (feriado)');
eqArr(starts({ start_date: '2024-02-29', recurrence: { freq: 'yearly' } }, '2024-01-01', '2032-12-31'),
  ['2024-02-29', '2028-02-29', '2032-02-29'], 'anual 29/fev pula não-bissextos');

// ── until / count ──
eqArr(starts({ start_date: '2026-07-01', recurrence: { freq: 'weekly', interval: 1, until: '2026-07-15' } }, '2026-07-01', '2026-12-31'),
  ['2026-07-01', '2026-07-08', '2026-07-15'], 'until inclusivo');
eqArr(starts({ start_date: '2026-07-01', recurrence: { freq: 'weekly', interval: 1, count: 2 } }, '2026-07-01', '2026-12-31'),
  ['2026-07-01', '2026-07-08'], 'count limita');

// ── janelas de dados ──
{
  const b = CAL.dataWindowBands({ source_key: 'secex', label: 'SECEX', from_day: 1, to_day: 10, lag_months: 1 }, 2026, 7);
  eq(b.startYMD, '2026-07-01', 'window start'); eq(b.endYMD, '2026-07-10', 'window end');
  eq(b.target, 'Jun 2026', 'window target (lag 1)'); eq(b.targetPeriod, '2026-06', 'window targetPeriod');
  const c = CAL.dataWindowBands({ source_key: 'x', label: 'X', from_day: 30, to_day: 40, lag_months: 0 }, 2026, 2);
  eq(c.startYMD, '2026-02-28', 'window clampa from ao fim do mês'); eq(c.endYMD, '2026-02-28', 'window clampa to');
}

// ── grade do mês (segunda-início) ──
{
  const wk = CAL.monthMatrix(2026, 7, 1);
  eq(wk.length, 6, 'monthMatrix 6 semanas');
  eq(wk[0].length, 7, 'monthMatrix 7 dias/semana');
  eq(wk[0][0].ymd, '2026-06-29', 'grade começa na segunda 29/06');
  eq(wk[0][2].ymd, '2026-07-01', 'dia 1 na 3ª coluna');
  eq(wk[0][2].inMonth, true, 'dia 1 inMonth');
  eq(wk[0][0].inMonth, false, '29/06 fora do mês');
}

// ── segmentForWeek (faixa multi-dia) ──
{
  const s1 = CAL.segmentForWeek('2026-07-30', '2026-08-02', '2026-07-27');
  eq(s1.startCol, 3, 'seg startCol (quinta)'); eq(s1.span, 4, 'seg span 4'); eq(s1.contEnd, false, 'não continua');
  eq(CAL.segmentForWeek('2026-07-30', '2026-08-02', '2026-08-03'), null, 'semana seguinte sem interseção');
  const s2 = CAL.segmentForWeek('2026-07-30', '2026-08-05', '2026-07-27');
  eq(s2.contEnd, true, 'contEnd true quando passa da semana');
  const s3 = CAL.segmentForWeek('2026-07-30', '2026-08-05', '2026-08-03');
  eq(s3.startCol, 0, 'continuação começa na col 0'); eq(s3.span, 3, 'continuação span 3'); eq(s3.contStart, true, 'contStart true');
}

console.log('\n' + (fails ? '✗ ' + fails + ' FALHARAM, ' : '✓ ') + passes + ' passaram.');
process.exit(fails ? 1 : 0);
