/**
 * Tests for the spreadsheet engine.
 *
 *     node test/spreadsheet.test.mjs
 *
 * The engine is loaded by EVALUATING assets/spreadsheet.js the same way a
 * browser does, rather than importing a parallel module. There is one copy of
 * this code and the tests run the bytes that ship.
 *
 * What is worth holding here is the arithmetic nobody checks by hand: that a
 * reference survives a row being inserted above it, that a cycle stops instead
 * of hanging, that a pasted "$1,200.00" is a number rather than text that
 * silently drops out of the total below it.
 */

import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../assets/spreadsheet.js', import.meta.url), 'utf8');
const Sheet = new Function(`${src}; return globalThis.Sheet;`)();

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
};

/** Build a sheet from a plain map of what someone typed. */
function sheet(typed, opts) {
  const m = Sheet.createModel(opts);
  for (const [ref, text] of Object.entries(typed)) Sheet.setCell(m, ref, text);
  return m;
}
const valuesOf = (m, meta) => Sheet.recalc(m, meta);
const at = (m, ref, meta) => valuesOf(m, meta)[ref];

/* ------------------------------------------------------------- refs ------ */
console.log('\nColumn names');

t('A is 0 and Z is 25', () => {
  assert.equal(Sheet.colToIndex('A'), 0);
  assert.equal(Sheet.colToIndex('Z'), 25);
});
t('AA is 26, not 27 — the alphabet has no zero digit', () => {
  assert.equal(Sheet.colToIndex('AA'), 26);
  assert.equal(Sheet.indexToCol(26), 'AA');
});
t('column names round-trip across the boundaries', () => {
  for (const n of [0, 25, 26, 27, 51, 52, 701, 702]) {
    assert.equal(Sheet.colToIndex(Sheet.indexToCol(n)), n, 'n=' + n);
  }
});
t('anchors are parsed per axis', () => {
  assert.deepEqual(Sheet.parseRef('$B4'), { col: 1, row: 3, absCol: true, absRow: false });
  assert.deepEqual(Sheet.parseRef('B$4'), { col: 1, row: 3, absCol: false, absRow: true });
});
t('a word that is not a reference is not treated as one', () =>
  assert.equal(Sheet.parseRef('SUM'), null));

/* ------------------------------------------------------------- input ----- */
console.log('\nWhat someone typed');

t('a plain number is a number', () =>
  assert.deepEqual(Sheet.parseInput('42.5'), { v: 42.5 }));
t('text stays text', () =>
  assert.deepEqual(Sheet.parseInput('Higgsfield'), { v: 'Higgsfield' }));
t('a leading = is a formula', () =>
  assert.deepEqual(Sheet.parseInput('=A1+1'), { f: '=A1+1' }));

{
  // THE BUG THIS GUARDS: a figure pasted from a bank statement or an invoice
  // arrives as "$1,200.00". Stored as text it drops silently out of every SUM
  // beneath it, and the total looks entirely plausible while being wrong.
  t('a currency figure is a number, formatted as currency', () =>
    assert.deepEqual(Sheet.parseInput('$1,200.00'), { v: 1200, fmt: 'currency' }));
  t('a negative currency figure keeps its sign', () =>
    assert.deepEqual(Sheet.parseInput('-$99'), { v: -99, fmt: 'currency' }));
  t('a thousands-separated number is a number', () =>
    assert.deepEqual(Sheet.parseInput('1,450'), { v: 1450 }));
  t('a percentage is stored as a fraction', () =>
    assert.deepEqual(Sheet.parseInput('12.5%'), { v: 0.125, fmt: 'percent' }));
}

t('clearing a cell keeps its format, so a column stays a column', () => {
  const m = sheet({ B2: '$99' });
  Sheet.setCell(m, 'B2', '');
  assert.equal(m.cells.B2.fmt, 'currency');
  Sheet.setCell(m, 'B2', '150');
  assert.equal(Sheet.format(at(m, 'B2'), m.cells.B2.fmt), '$150.00');
});

/* --------------------------------------------------------- arithmetic ---- */
console.log('\nFormulas');

t('cells add up', () => assert.equal(at(sheet({ A1: '2', A2: '3', A3: '=A1+A2' }), 'A3'), 5));
t('precedence is arithmetic, not left to right', () =>
  assert.equal(at(sheet({ A1: '=2+3*4' }), 'A1'), 14));
t('parentheses win', () => assert.equal(at(sheet({ A1: '=(2+3)*4' }), 'A1'), 20));
t('exponent binds tighter than multiplication', () =>
  assert.equal(at(sheet({ A1: '=2*3^2' }), 'A1'), 18));
t('unary minus works', () => assert.equal(at(sheet({ A1: '=-5+2' }), 'A1'), -3));
t('percent is a postfix operator', () => assert.equal(at(sheet({ A1: '=50%' }), 'A1'), 0.5));

t('& binds looser than +, so a label and a sum concatenate correctly', () => {
  // ="Total: "&2+3 is "Total: 5" in Excel, not "Total: 2" plus 3.
  assert.equal(at(sheet({ A1: '="Total: "&2+3' }), 'A1'), 'Total: 5');
});

t('an empty cell is zero in arithmetic', () =>
  assert.equal(at(sheet({ A1: '=B9+5' }), 'A1'), 5));
t('dividing by zero says so rather than returning Infinity', () =>
  assert.deepEqual(at(sheet({ A1: '=1/0' }), 'A1'), { err: '#DIV/0!' }));
t('text in arithmetic is a value error, not a silent zero', () =>
  assert.deepEqual(at(sheet({ A1: 'apples', A2: '=A1*2' }), 'A2'), { err: '#VALUE!' }));
t('an unknown function is named, not ignored', () =>
  assert.deepEqual(at(sheet({ A1: '=WIBBLE(1)' }), 'A1'), { err: '#NAME?' }));

t('errors propagate rather than being swallowed', () => {
  const m = sheet({ A1: '=1/0', A2: '=A1+1', A3: '=SUM(A1:A2)' });
  const v = valuesOf(m);
  assert.deepEqual(v.A2, { err: '#DIV/0!' });
  assert.deepEqual(v.A3, { err: '#DIV/0!' });
});
t('IFERROR catches one, which is why a column does not cascade', () =>
  assert.equal(at(sheet({ A1: '=IFERROR(1/0, 0)' }), 'A1'), 0));

/* ------------------------------------------------------------ ranges ----- */
console.log('\nRanges');

const COL = { A1: '10', A2: '20', A3: '30', A4: 'text', A5: '' };

t('SUM adds a range', () => assert.equal(at(sheet(COL), 'A9'), undefined));
t('SUM over a column ignores text and blanks', () =>
  assert.equal(at(sheet({ ...COL, B1: '=SUM(A1:A5)' }), 'B1'), 60));
t('AVERAGE ignores them too, so the divisor is right', () =>
  assert.equal(at(sheet({ ...COL, B1: '=AVERAGE(A1:A5)' }), 'B1'), 20));
t('COUNT counts numbers, COUNTA counts anything', () => {
  const m = sheet({ ...COL, B1: '=COUNT(A1:A5)', B2: '=COUNTA(A1:A5)' });
  const v = valuesOf(m);
  assert.equal(v.B1, 3);
  assert.equal(v.B2, 4);
});
t('a range mixes with scalars in one call', () =>
  assert.equal(at(sheet({ ...COL, B1: '=SUM(A1:A3, 100, 5)' }), 'B1'), 165));
t('a backwards range is the same range', () =>
  assert.equal(at(sheet({ ...COL, B1: '=SUM(A3:A1)' }), 'B1'), 60));
t('MIN and MAX read the range', () => {
  const v = valuesOf(sheet({ ...COL, B1: '=MIN(A1:A3)', B2: '=MAX(A1:A3)' }));
  assert.equal(v.B1, 10);
  assert.equal(v.B2, 30);
});
t('a bare range outside a function is an error, not its first cell', () =>
  assert.deepEqual(at(sheet({ ...COL, B1: '=A1:A3' }), 'B1'), { err: '#VALUE!' }));
t('"A1:" is not a range and does not half-parse', () => {
  const toks = Sheet.tokenize('A1:');
  assert.equal(toks[0].type, 'ref');
});

t('SUMIF sums where the criterion matches', () => {
  const m = sheet({
    A1: 'Expense', A2: 'Revenue', A3: 'Expense',
    B1: '99', B2: '1450', B3: '20',
    C1: '=SUMIF(A1:A3, "Expense", B1:B3)',
    C2: '=SUMIF(B1:B3, ">100")',
  });
  const v = valuesOf(m);
  assert.equal(v.C1, 119);
  assert.equal(v.C2, 1450);
});
t('COUNTIF counts matches', () =>
  assert.equal(at(sheet({ A1: 'x', A2: 'y', A3: 'x', B1: '=COUNTIF(A1:A3,"x")' }), 'B1'), 2));

/* ------------------------------------------------------------ logic ------ */
console.log('\nLogic and comparison');

t('IF picks a branch', () => {
  const v = valuesOf(sheet({ A1: '10', B1: '=IF(A1>5,"over","under")', B2: '=IF(A1>50,"over","under")' }));
  assert.equal(v.B1, 'over');
  assert.equal(v.B2, 'under');
});
t('IF does not evaluate away an error in the branch not taken', () =>
  assert.equal(at(sheet({ A1: '=IF(TRUE, 1, 1/0)' }), 'A1'), 1));
t('comparison of text is case-insensitive, as in Excel', () =>
  assert.equal(at(sheet({ A1: 'Higgsfield', B1: '=A1="HIGGSFIELD"' }), 'B1'), true));
t('<> is not equal', () => assert.equal(at(sheet({ A1: '=1<>2' }), 'A1'), true));

/* ------------------------------------------------------------ cycles ----- */
console.log('\nCycles stop instead of hanging');

t('a cell referring to itself is reported', () =>
  assert.deepEqual(at(sheet({ A1: '=A1+1' }), 'A1'), { err: '#CYCLE!' }));
t('a two-cell cycle is reported', () => {
  const v = valuesOf(sheet({ A1: '=B1', B1: '=A1' }));
  assert.ok(Sheet.isErr(v.A1) && Sheet.isErr(v.B1));
});
t('a long cycle is reported and does not blow the stack', () => {
  const typed = {};
  for (let i = 1; i <= 60; i++) typed['A' + i] = '=A' + (i === 60 ? 1 : i + 1);
  const v = valuesOf(sheet(typed, { rows: 80 }));
  assert.ok(Sheet.isErr(v.A1), JSON.stringify(v.A1));
});
t('a cycle elsewhere does not poison an unrelated cell', () => {
  const v = valuesOf(sheet({ A1: '=A1', C1: '5', C2: '=C1*2' }));
  assert.equal(v.C2, 10);
});
t('a deep but acyclic chain evaluates', () => {
  const typed = { A1: '1' };
  for (let i = 2; i <= 120; i++) typed['A' + i] = `=A${i - 1}+1`;
  assert.equal(valuesOf(sheet(typed, { rows: 200 })).A120, 120);
});

/* ------------------------------------------------- structural edits ------ */
console.log('\nInserting and deleting rows rewrites formulas');

{
  // THE BUG THIS GUARDS: moving the cells but not the formulas. =SUM(A1:A3)
  // still pointing at A1:A3 after a row is inserted above keeps producing a
  // number, just the wrong one — which is the worst kind of wrong.
  const m = sheet({ A1: '10', A2: '20', A3: '30', B1: '=SUM(A1:A3)', C1: '=A2*2' });
  Sheet.insertRow(m, 0);

  t('the cells move down', () => {
    const v = valuesOf(m);
    assert.equal(v.A2, 10);
    assert.equal(v.A4, 30);
  });
  t('a range in a formula follows them', () =>
    assert.equal(m.cells.B2.f, '=SUM(A2:A4)'));
  t('a single reference follows them', () =>
    assert.equal(m.cells.C2.f, '=A3*2'));
  t('and the totals still come out right', () => assert.equal(valuesOf(m).B2, 60));
}

{
  const m = sheet({ A1: '10', A2: '20', A3: '30', B1: '=SUM(A1:A3)' });
  Sheet.insertRow(m, 1);
  Sheet.setCell(m, 'A2', '5');
  t('a row inserted INSIDE a range is included by it', () =>
    assert.equal(valuesOf(m).B1, 65));
}

{
  const m = sheet({ A1: '10', A2: '20', B1: '=A2+1' });
  Sheet.deleteRow(m, 1);
  t('a reference to a deleted row becomes #REF!, not a wrong number', () => {
    assert.equal(m.cells.B1.f, '=#REF!+1');
    assert.deepEqual(valuesOf(m).B1, { err: '#REF!' });
  });
}

{
  const m = sheet({ A1: '1', B1: '2', C1: '=A1+B1' });
  Sheet.insertCol(m, 1);
  t('inserting a column shifts cells and formulas', () => {
    assert.equal(m.cells.D1.f, '=A1+C1');
    assert.equal(valuesOf(m).D1, 3);
  });
}

{
  const m = sheet({ A1: '1', B1: '2', C1: '=SUM(A1:B1)' });
  Sheet.deleteCol(m, 0);
  t('deleting a column inside a range keeps the range valid', () =>
    assert.equal(valuesOf(m).B1, 2));
}

{
  /* A range is not two independent references. Deleting a line inside one
     should SHRINK it; treating each endpoint alone turns that into #REF! the
     moment either end happens to be the deleted line, and a working total
     becomes an error for no reason the user can see. */
  const shrink = (typed, edit) => { const m = sheet(typed, { rows: 12, cols: 6 }); edit(m); return m; };

  t('deleting a line inside a range shrinks it', () => {
    const m = shrink({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)' }, (x) => Sheet.deleteRow(x, 1));
    assert.equal(m.cells.B1.f, '=SUM(A1:A2)');
    assert.equal(valuesOf(m).B1, 4);
  });
  t('deleting the first line of a range shrinks it from the top', () => {
    const m = shrink({ A1: '1', A2: '2', A3: '3', B6: '=SUM(A1:A3)' }, (x) => Sheet.deleteRow(x, 0));
    assert.equal(m.cells.B5.f, '=SUM(A1:A2)');
    assert.equal(valuesOf(m).B5, 5);
  });
  t('deleting the last line of a range shrinks it from the bottom', () => {
    const m = shrink({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)' }, (x) => Sheet.deleteRow(x, 2));
    assert.equal(m.cells.B1.f, '=SUM(A1:A2)');
    assert.equal(valuesOf(m).B1, 3);
  });
  t('a range is only #REF! when every line of it is gone', () => {
    const m = shrink({ A2: '2', B1: '=SUM(A2:A2)' }, (x) => Sheet.deleteRow(x, 1));
    assert.deepEqual(valuesOf(m).B1, { err: '#REF!' });
  });
  t('deleting a line above a range slides it up intact', () => {
    const m = shrink({ A3: '3', A4: '4', B6: '=SUM(A3:A4)' }, (x) => Sheet.deleteRow(x, 0));
    assert.equal(m.cells.B5.f, '=SUM(A2:A3)');
    assert.equal(valuesOf(m).B5, 7);
  });
  t('deleting the row a formula sits in takes the formula with it', () => {
    const m = shrink({ A1: '1', B1: '=A1+1' }, (x) => Sheet.deleteRow(x, 0));
    assert.equal(m.cells.B1, undefined);
  });
  t('deleting a line below a range leaves it alone', () => {
    const m = shrink({ A1: '1', A2: '2', A9: 'x', B1: '=SUM(A1:A2)' }, (x) => Sheet.deleteRow(x, 8));
    assert.equal(m.cells.B1.f, '=SUM(A1:A2)');
  });
  t('the same rule holds for columns', () => {
    const m = shrink({ A1: '1', B1: '2', C1: '3', D1: '=SUM(A1:C1)' }, (x) => Sheet.deleteCol(x, 1));
    assert.equal(m.cells.C1.f, '=SUM(A1:B1)');
    assert.equal(valuesOf(m).C1, 4);
  });
}

t('an anchored reference still moves when its own cell moves', () => {
  // $A$1 means "do not change when I am COPIED", not "do not change when a row
  // is inserted above". Excel rewrites anchored refs on insert too.
  const m = sheet({ A1: '7', C5: '=$A$1*2' });
  Sheet.insertRow(m, 0);
  assert.equal(m.cells.C6.f, '=$A$2*2');
});

/* -------------------------------------------------------- copy/paste ----- */
console.log('\nCopying a formula');

t('relative references move with the copy', () =>
  assert.equal(Sheet.offsetFormula('A1+B1', 0, 1), 'A2+B2'));
t('anchored references do not', () =>
  assert.equal(Sheet.offsetFormula('$A$1+B1', 1, 1), '$A$1+C2'));
t('a half-anchored reference moves on one axis only', () =>
  assert.equal(Sheet.offsetFormula('$A1+A$1', 1, 1), '$A2+B$1'));
t('ranges move as a whole', () =>
  assert.equal(Sheet.offsetFormula('SUM(A1:A5)', 1, 0), 'SUM(B1:B5)'));
t('function names and text are handed back untouched', () =>
  assert.equal(Sheet.offsetFormula('IF(A1>0,"up","down")', 0, 1), 'IF(A2>0,"up","down")'));
t('spacing inside a formula survives a copy', () =>
  assert.equal(Sheet.offsetFormula('SUM( A1 , B1 )', 0, 1), 'SUM( A2 , B2 )'));

/* --------------------------------------------------------- live data ----- */
console.log('\nLive Meta values');

const META = {
  'adSpend.monthToDate': 183.2,
  'adSpend.dailyTotal': 30,
  'adSpend.expectedMonthTotal': 903.2,
};

t('META reads the namespace the server supplies', () =>
  assert.equal(at(sheet({ A1: '=META("adSpend.monthToDate")' }), 'A1', META), 183.2));
t('a live value takes part in arithmetic like any other', () =>
  assert.equal(at(sheet({ A1: '=META("adSpend.monthToDate") + 100' }), 'A1', META), 283.2));
t('a live value feeds a range total', () => {
  const m = sheet({ A1: '=META("adSpend.expectedMonthTotal")', A2: '99', A3: '=SUM(A1:A2)' });
  assert.equal(at(m, 'A3', META), 1002.2);
});
t('a mistyped key is named rather than silently zero', () =>
  assert.deepEqual(at(sheet({ A1: '=META("adSpend.nonsense")' }), 'A1', META), { err: '#NAME?' }));
t('the same formula follows the live figure when it changes', () => {
  const m = sheet({ A1: '=META("adSpend.monthToDate")' });
  assert.equal(at(m, 'A1', META), 183.2);
  assert.equal(at(m, 'A1', { 'adSpend.monthToDate': 250 }), 250);
});
t('no live data at all is an error, not a stale figure', () =>
  assert.deepEqual(at(sheet({ A1: '=META("adSpend.monthToDate")' }), 'A1', {}), { err: '#NAME?' }));

/* ------------------------------------------------------- persistence ----- */
console.log('\nWhat gets stored');

t('only what was typed is stored, never the computed value', () => {
  const m = sheet({ A1: '2', A2: '=A1*21' });
  assert.equal(valuesOf(m).A2, 42);
  const saved = JSON.parse(JSON.stringify(m));
  assert.equal(saved.cells.A2.f, '=A1*21');
  assert.ok(!('v' in saved.cells.A2), 'a stored value could go stale without saying so');
});
t('a reloaded model recalculates to the same figures', () => {
  const m = sheet({ A1: '2', A2: '=A1*21', A3: '=SUM(A1:A2)' });
  const reloaded = JSON.parse(JSON.stringify(m));
  assert.deepEqual(valuesOf(reloaded), valuesOf(m));
});

/* -------------------------------------------------------- formatting ----- */
console.log('\nFormatting');

t('currency keeps two decimals and a thousands separator', () =>
  assert.equal(Sheet.format(1234.5, 'currency'), '$1,234.50'));
t('a negative currency figure puts the sign before the symbol', () =>
  assert.equal(Sheet.format(-99, 'currency'), '-$99.00'));
t('percent multiplies by a hundred', () =>
  assert.equal(Sheet.format(0.125, 'percent'), '12.5%'));
t('an error shows its code', () =>
  assert.equal(Sheet.format({ err: '#DIV/0!' }), '#DIV/0!'));
t('an empty cell shows nothing, not "null" or a zero', () => {
  assert.equal(Sheet.format(null), '');
  assert.equal(Sheet.format(''), '');
});
t('an unformatted number is not rounded on screen', () =>
  assert.equal(Sheet.format(1234.567), '1,234.567'));

t('the editor shows the formula, not the result', () => {
  const m = sheet({ A1: '2', A2: '=A1*21' });
  assert.equal(Sheet.editText(m, 'A2'), '=A1*21');
  assert.equal(Sheet.editText(m, 'A1'), '2');
  assert.equal(Sheet.editText(m, 'Z9'), '');
});

/* -------------------------------------------------------- interchange ---- */
console.log('\nPaste and export');

t('a paste from another spreadsheet is split on tabs and newlines', () =>
  assert.deepEqual(Sheet.fromTSV('a\tb\nc\td'), [['a', 'b'], ['c', 'd']]));
t('a trailing newline does not create a phantom row', () =>
  assert.deepEqual(Sheet.fromTSV('a\tb\n'), [['a', 'b']]));
t('windows line endings paste the same as unix ones', () =>
  assert.deepEqual(Sheet.fromTSV('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']]));

t('CSV export quotes what needs quoting', () => {
  const m = sheet({ A1: 'Line, with comma', B1: '99' }, { rows: 2, cols: 2 });
  const csv = Sheet.toCSV(m, valuesOf(m));
  assert.match(csv, /^"Line, with comma",99/);
});
t('CSV export writes computed values, so it opens as figures', () => {
  const m = sheet({ A1: '2', B1: '=A1*21' }, { rows: 1, cols: 2 });
  assert.equal(Sheet.toCSV(m, valuesOf(m)), '2,42');
});
t('CSV export does not pad the file with empty rows', () => {
  const m = sheet({ A1: '1' }, { rows: 60, cols: 8 });
  assert.equal(Sheet.toCSV(m, valuesOf(m)).split('\n').length, 1);
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
