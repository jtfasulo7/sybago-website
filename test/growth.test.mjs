/**
 * Tests for Growth Intelligence: the engine, and the endpoints that guard its storage.
 *
 *     node test/growth.test.mjs
 *
 * No credentials and no network: Blob and Meta are stubbed. The engine tests
 * import the same file the browser loads.
 *
 * What these hold in place is mostly a list of things the dashboard must NOT
 * conclude: that a missing member canceled, that an ended trial paid, that two
 * people with one name are one person, that revenue on a day belongs to that
 * day's ads.
 */

import assert from 'node:assert';

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_FAKE_never_in_output_0123456789';
process.env.META_ADS_TOKEN = 'EAAG_FAKE_TOKEN_never_in_output_123456';
process.env.META_AD_ACCOUNT_ID = 'act_111';
process.env.CRON_SECRET = 'cron-secret-value';

const E = await import('../assets/growth/engine.js');
const { buildDemo } = await import('../assets/growth/demo.js');
const auth = await import('../lib/auth.js');
const store = await import('../lib/growth/store.js');
const { default: growth, sanitiseImport } = await import('../api/growth.js');
const { default: growthMeta } = await import('../api/growth-meta.js');
const { default: growthAi, shapeAnswer } = await import('../api/growth-ai.js');
const { mergeDaily, shapeDaily } = await import('../lib/growth/meta-sync.js');

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
};
const near = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

/* ------------------------------------------------------------ fixtures -- */

const HEAD = 'FirstName,LastName,Email,Invited By,JoinedDate,Price,Recurring Interval,LTV';
function csvImport(id, day, lines, decisions = {}) {
  const text = [HEAD, ...lines].join('\n');
  const parsed = E.parseCsv(text);
  const mapping = E.detectColumns(parsed.headers);
  const { rows } = E.normaliseCsvRows(parsed, mapping, E.DEFAULT_SETTINGS);
  return { id, kind: 'csv', observedAt: `${day}T16:00:00.000Z`, rows, decisions, hash: E.contentHash(text) };
}
function pasteImport(id, day, text, opts = {}) {
  return { id, kind: 'paste', observedAt: `${day}T17:00:00.000Z`, rows: E.parsePaste(text, { pastedDay: day, ...opts }), decisions: opts.decisions || {} };
}
function world(imports, { today = '2026-10-08', manual = [], reverted = [], meta = null, settings } = {}) {
  const db = E.emptyDb();
  // Most fixtures are about trials, so the offer is in force throughout unless a test says otherwise.
  db.settings = { ...db.settings, trialAppliesFrom: '2026-01-01', ...(settings || {}) };
  db.imports = imports.map((i) => ({ id: i.id, kind: i.kind, observedAt: i.observedAt, hash: i.hash, reverted: reverted.includes(i.id) ? { at: 'x' } : null }));
  db.manual = manual;
  return E.buildContext(db, imports, meta, { today });
}
const named = (ctx, name) => ctx.members.filter((m) => m.name === name);
const one = (ctx, name) => { const l = named(ctx, name); assert.equal(l.length, 1, `${l.length} members named ${name}`); return l[0]; };

/* --------------------------------------------------------------- dates -- */
console.log('\nDates and timezones');

await t('a UTC timestamp lands on the business-timezone day', () => {
  assert.equal(E.parseWhen('2026-10-02 02:10:00', { tz: 'America/New_York' }).day, '2026-10-01');
  assert.equal(E.parseWhen('2026-10-02 02:10:00', { tz: 'UTC' }).day, '2026-10-02');
  assert.equal(E.parseWhen('2026-10-02 02:10:00', { tz: 'Australia/Sydney' }).day, '2026-10-02');
});
await t('a different timezone setting moves the member to a different day', () => {
  const imp = csvImport('a', '2026-10-05', ['Ana,Ruiz,ana@x.com,,2026-10-02 02:10:00,$19,month,$0']);
  const parsed = E.parseCsv([HEAD, 'Ana,Ruiz,ana@x.com,,2026-10-02 02:10:00,$19,month,$0'].join('\n'));
  const utc = E.normaliseCsvRows(parsed, E.detectColumns(parsed.headers), { ...E.DEFAULT_SETTINGS, timezone: 'UTC' });
  assert.equal(imp.rows[0].joinDay, '2026-10-01');
  assert.equal(utc.rows[0].joinDay, '2026-10-02');
});
await t('other date shapes parse, and nonsense does not', () => {
  assert.equal(E.parseWhen('10/3/2026').day, '2026-10-03');
  assert.equal(E.parseWhen('Oct 3, 2026').day, '2026-10-03');
  assert.equal(E.parseWhen('2026-02-30'), null);
  assert.equal(E.parseWhen('soon'), null);
});
await t('month arithmetic clamps at the end of a short month', () => {
  assert.equal(E.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(E.addMonths('2026-11-15', 2), '2027-01-15');
});

/* ----------------------------------------------------------------- CSV -- */
console.log('\nCSV import');

await t('quoted fields, embedded commas and newlines survive', () => {
  const p = E.parseCsv('﻿Name,Note\r\n"Ruiz, Ana","said ""hi""\nthere"\r\n');
  assert.deepEqual(p.headers, ['Name', 'Note']);
  assert.deepEqual(p.rows[0], ['Ruiz, Ana', 'said "hi"\nthere']);
});
await t('columns are detected from Skool-style headers', () => {
  const m = E.detectColumns(HEAD.split(','));
  assert.equal(m.firstName, 0); assert.equal(m.email, 2); assert.equal(m.joinedAt, 4);
  assert.equal(m.price, 5); assert.equal(m.interval, 6); assert.equal(m.ltv, 7); assert.equal(m.invitedBy, 3);
});
await t('money parses; an empty price in a mapped column is a free member', () => {
  assert.equal(E.parseMoney('$1,147.50'), 1147.5);
  const imp = csvImport('a', '2026-10-01', ['Dee,Fox,dee@x.com,,2026-08-01 15:00:00,,,$0']);
  assert.equal(imp.rows[0].price, 0);
  assert.equal(one(world([imp]), 'Dee Fox').d.status, 'free');
});
await t('the same file uploaded twice is recognised', () => {
  const a = csvImport('a', '2026-10-01', ['Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$19']);
  const b = { ...csvImport('b', '2026-10-02', ['Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$19']) };
  const db = E.emptyDb();
  db.imports = [{ id: 'a', kind: 'csv', observedAt: a.observedAt, hash: a.hash }];
  const p = E.previewImport(db, [a], b, { today: '2026-10-08' });
  assert.ok(p.duplicateOf);
  assert.equal(p.newMembers.length, 0);
});

/* ------------------------------------------------------------ identity -- */
console.log('\nIdentity');

await t('two members with the same name stay two members', () => {
  const ctx = world([csvImport('a', '2026-10-01', [
    'Sam,Lee,sam1@x.com,,2026-09-10 15:00:00,$19,month,$19',
    'Sam,Lee,sam2@x.com,,2026-09-12 15:00:00,$19,month,$0',
  ])]);
  assert.equal(named(ctx, 'Sam Lee').length, 2);
});
await t('a name-only row matching two people is uncertain, never auto-merged', () => {
  const a = csvImport('a', '2026-10-01', ['Sam,Lee,sam1@x.com,,2026-09-10 15:00:00,$19,month,$19', 'Sam,Lee,sam2@x.com,,2026-09-12 15:00:00,$19,month,$0']);
  const b = pasteImport('b', '2026-10-02', 'Sam Lee\n@sam-lee-9\nChurned Oct 1, 2026');
  const db = E.emptyDb(); db.imports = [{ id: 'a', kind: 'csv', observedAt: a.observedAt }];
  const p = E.previewImport(db, [a], b, { today: '2026-10-08' });
  assert.equal(p.uncertain.length, 1);
  assert.equal(p.uncertain[0].candidates.length, 2);
  // Undecided, it becomes its own record flagged as a possible duplicate.
  const ctx = world([a, b]);
  assert.equal(named(ctx, 'Sam Lee').length, 3);
  assert.ok(ctx.members.some((m) => m.possibleDuplicateOf && m.possibleDuplicateOf.length === 2));
});
await t('an administrator decision resolves it, and the username then sticks', () => {
  const a = csvImport('a', '2026-10-01', ['Sam,Lee,sam1@x.com,,2026-09-10 15:00:00,$19,month,$19', 'Sam,Lee,sam2@x.com,,2026-09-12 15:00:00,$19,month,$0']);
  const b = pasteImport('b', '2026-10-02', 'Sam Lee\n@sam-lee-9\nChurned Oct 1, 2026', { decisions: { 0: 'e:sam1@x.com' } });
  const c = pasteImport('c', '2026-10-05', 'Sam Lee\n@sam-lee-9\nRejoined Oct 4, 2026');
  const ctx = world([a, b, c]);
  assert.equal(named(ctx, 'Sam Lee').length, 2);
  const m = ctx.byId.get('e:sam1@x.com');
  assert.equal(m.handle, 'sam-lee-9');
  assert.equal(m.d.returned, true);          // matched by username the second time, no decision needed
});
await t('a unique name with a matching join date is matched; a conflicting email is not', () => {
  const a = csvImport('a', '2026-10-01', ['Ben,Cole,ben@x.com,,2026-09-19 15:00:00,$19,month,$0']);
  const ok = pasteImport('b', '2026-10-02', 'Ben Cole\n@ben-cole\nTrial canceled Sep 24, 2026\nJoined Sep 19, 2026');
  assert.equal(named(world([a, ok]), 'Ben Cole').length, 1);
  const other = csvImport('c', '2026-10-03', ['Ben,Cole,ben@x.com,,2026-09-19 15:00:00,$19,month,$0', 'Ben,Cole,other@x.com,,2026-09-19 15:00:00,$19,month,$0']);
  assert.equal(named(world([a, other]), 'Ben Cole').length, 2);
});

/* ------------------------------------------------------- reconciliation -- */
console.log('\nSnapshots and history');

const snap1 = () => csvImport('s1', '2026-09-25', [
  'Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$19',
  'Ben,Cole,ben@x.com,,2026-09-19 15:00:00,$19,month,$0',
  'Cara,Diaz,cara@x.com,,2026-09-10 15:00:00,$147,year,$0',
]);
const snap2 = () => csvImport('s2', '2026-10-07', [
  'Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$38',
  'Cara,Diaz,cara@x.com,,2026-09-10 15:00:00,$147,year,$147',
  'Eli,Gray,eli@x.com,,2026-10-05 15:00:00,$19,month,$0',
]);

await t('a member absent from a later export is "missing — unverified", not canceled', () => {
  const ben = one(world([snap1(), snap2()]), 'Ben Cole');
  assert.equal(ben.d.status, 'missing_unverified');
  assert.equal(ben.d.statusLabel, 'Missing From Latest Export — Status Unverified');
  assert.equal(ben.d.churns.length, 0);
  const ev = ben.events.find((e) => e.type === 'missing_from_export');
  assert.equal(ev.precision, 'window');
  assert.deepEqual(ev.window, { from: '2026-09-25', to: '2026-10-07' });
});
await t('a later export never overwrites earlier history', () => {
  const ana = one(world([snap1(), snap2()]), 'Ana Ruiz');
  assert.deepEqual(ana.obs.map((o) => o.ltv), [19, 38]);
  assert.ok(ana.events.some((e) => e.type === 'ltv_observed'));
  assert.ok(ana.events.some((e) => e.type === 'payment_observed' && e.data.amount === 19));
});
await t('imports are replayed by the date they describe, not the order they arrive', () => {
  const a = world([snap2(), snap1()]);
  const b = world([snap1(), snap2()]);
  assert.equal(one(a, 'Ben Cole').d.status, one(b, 'Ben Cole').d.status);
  assert.equal(a.lastCsv.id, 's2');
});
await t('reversing an import removes its effect exactly; restoring brings it back', () => {
  const without = world([snap1(), snap2()], { reverted: ['s2'] });
  assert.equal(one(without, 'Ben Cole').d.status, 'trial_unresolved');
  assert.equal(named(without, 'Eli Gray').length, 0);
  const restored = world([snap1(), snap2()]);
  assert.equal(named(restored, 'Eli Gray').length, 1);
});
await t('a price change and a fall in LTV are recorded as observed events', () => {
  const a = csvImport('a', '2026-09-01', ['Ana,Ruiz,ana@x.com,,2026-06-01 15:00:00,$9,month,$27']);
  const b = csvImport('b', '2026-10-01', ['Ana,Ruiz,ana@x.com,,2026-06-01 15:00:00,$19,month,$18']);
  const ana = one(world([a, b]), 'Ana Ruiz');
  const pc = ana.events.find((e) => e.type === 'price_changed');
  assert.deepEqual([pc.data.from, pc.data.to], [9, 19]);
  assert.equal(ana.events.find((e) => e.type === 'refund_observed').data.amount, 9);
});
await t('a preview reports exactly what saving would change', () => {
  const db = E.emptyDb(); const a = snap1();
  db.imports = [{ id: 's1', kind: 'csv', observedAt: a.observedAt, hash: a.hash }];
  const p = E.previewImport(db, [a], snap2(), { today: '2026-10-08' });
  assert.equal(p.matched, 2); assert.equal(p.newMembers.length, 1);
  assert.equal(p.missing.length, 1); assert.equal(p.ltvChanges.length, 2);
  assert.deepEqual([p.totals.before, p.totals.after], [3, 4]);
});
await t('a suspiciously short export is called out before it marks everyone missing', () => {
  const big = csvImport('a', '2026-09-01', Array.from({ length: 10 }, (_, i) => `P${i},Q,p${i}@x.com,,2026-08-01 15:00:00,$19,month,$19`));
  const small = csvImport('b', '2026-10-01', ['P0,Q,p0@x.com,,2026-08-01 15:00:00,$19,month,$38']);
  const db = E.emptyDb(); db.imports = [{ id: 'a', kind: 'csv', observedAt: big.observedAt }];
  assert.ok(E.previewImport(db, [big], small, { today: '2026-10-08' }).notes.some((n) => /partial or filtered/.test(n.message)));
});

/* -------------------------------------------------------------- trials -- */
console.log('\nTrials');

await t('a trial that ended with no evidence is unresolved — never assumed paid', () => {
  const ben = one(world([snap1()]), 'Ben Cole');          // joined Sep 19, trial ended Sep 26, today Oct 8
  assert.equal(ben.d.trialEnd, '2026-09-26');
  assert.equal(ben.d.trialOutcome, 'unresolved');
  assert.equal(ben.d.firstPaidDay, null);
  assert.equal(ben.d.revenue, 0);
});
await t('recorded LTV is the evidence of conversion, dated to the trial end as an estimate', () => {
  const cara = one(world([snap1(), snap2()]), 'Cara Diaz');
  assert.equal(cara.d.trialOutcome, 'converted');
  assert.equal(cara.d.firstPaidDay, '2026-09-25');        // window (Sep 25, Oct 7], trial ended Sep 17 -> clamped to the window
  assert.equal(cara.d.firstPaidPrecision, 'estimated');
  assert.deepEqual(cara.d.firstPaidWindow, { from: '2026-09-25', to: '2026-10-07' });
});
await t('a payment that lands after the trial end (delayed) is bounded by the exports', () => {
  const a = csvImport('a', '2026-09-20', ['Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$0']);   // 12 days after trial end, still $0
  const b = csvImport('b', '2026-09-27', ['Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$19']);
  const ana = one(world([a, b]), 'Ana Ruiz');
  assert.equal(ana.d.firstPaidDay, '2026-09-20');
  assert.ok(ana.d.firstPaidDay > ana.d.trialEnd);
});
await t('canceling before the trial ends is a verified non-conversion with its exact date', () => {
  const p = pasteImport('p', '2026-09-26', 'Ben Cole\n@ben-cole\nTrial canceled Sep 22, 2026\nJoined Sep 19, 2026\n$19/month');
  const ben = one(world([snap1(), p]), 'Ben Cole');
  assert.equal(ben.d.trialOutcome, 'canceled');
  assert.equal(ben.d.trialOutcomeDay, '2026-09-22');
  assert.equal(ben.d.trialOutcomePrecision, 'exact');
  assert.equal(ben.d.status, 'trial_canceled');
});
await t('conversion rate = converted / KNOWN outcomes, with coverage and honest bounds', () => {
  const imp = csvImport('a', '2026-10-07', [
    'A,One,a@x.com,,2026-09-01 15:00:00,$19,month,$19', 'B,Two,b@x.com,,2026-09-01 15:00:00,$19,month,$19',
    'C,Three,c@x.com,,2026-09-01 15:00:00,$19,month,$0', 'D,Four,d@x.com,,2026-09-01 15:00:00,$19,month,$0',
    'E,Five,e@x.com,,2026-10-05 15:00:00,$19,month,$0', 'F,Free,f@x.com,,2026-09-01 15:00:00,,,$0',
  ]);
  const p = pasteImport('p', '2026-10-07', 'C Three\n@c3\nTrial canceled Sep 5, 2026\nJoined Sep 1, 2026');
  const s = E.trialStats(world([imp, p]).members);
  assert.deepEqual([s.trials, s.active, s.converted, s.nonConverted, s.unresolved], [5, 1, 2, 1, 1]);
  near(s.rate, 2 / 3); near(s.coverage, 3 / 4); near(s.rateFloor, 2 / 4); near(s.rateCeiling, 3 / 4);
});
await t('an active trial is neither converted nor unresolved', () => {
  const eli = one(world([snap2()]), 'Eli Gray');
  assert.equal(eli.d.trialOutcome, 'active');
  assert.equal(eli.d.trialEnd, '2026-10-12');
});
await t('members who joined before the trial offer began have no trial', () => {
  const imp = csvImport('a', '2026-10-07', ['Old,Timer,o@x.com,,2025-01-01 15:00:00,$9,month,$189']);
  const m = one(world([imp], { settings: { trialAppliesFrom: '2026-01-01' } }), 'Old Timer');
  assert.equal(m.d.hasTrial, false);
  assert.equal(m.d.status, 'paying');
});
await t('the trial offer began on 2026-09-27 by default, and an unset date means that default', () => {
  assert.equal(E.DEFAULT_SETTINGS.trialAppliesFrom, '2026-09-27');
  assert.equal(E.withDefaults({ trialAppliesFrom: null }).trialAppliesFrom, '2026-09-27');
  assert.equal(E.withDefaults({ trialAppliesFrom: '' }).trialAppliesFrom, '2026-09-27');
  assert.equal(E.withDefaults({ trialAppliesFrom: '2026-06-01' }).trialAppliesFrom, '2026-06-01');
});
const cutoffWorld = () => world([csvImport('a', '2026-10-07', [
  'Pre,Paid,pre@x.com,,2026-09-10 15:00:00,$19,month,$19',       // before the offer: paid to join
  'Eve,Before,eve@x.com,,2026-09-26 15:00:00,$19,month,$19',     // the day before: still no trial
  'Day,One,day1@x.com,,2026-09-27 15:00:00,$19,month,$19',       // first day of the offer: a trial, converted
  'Tri,Open,tri@x.com,,2026-10-04 15:00:00,$19,month,$0',        // on trial now
])], { settings: { trialAppliesFrom: '2026-09-27' }, meta: { ads: { a: { name: 'A' } }, daily: [['2026-09-10', 'a', 100, 1, 1, 1, 1, 1, 0], ['2026-09-27', 'a', 60, 1, 1, 1, 1, 1, 0]] } });
await t('members who joined before the cutoff are paying members, never trial members', () => {
  const ctx = cutoffWorld();
  for (const name of ['Pre Paid', 'Eve Before']) {
    const m = one(ctx, name);
    assert.equal(m.d.hasTrial, false, name);
    assert.equal(m.d.trialOutcome, 'none', name);
    assert.equal(m.d.status, 'paying', name);
    assert.equal(m.d.firstPaidDay, m.joinDay, name);        // they paid on joining, not a week later
  }
  assert.equal(one(ctx, 'Day One').d.hasTrial, true);
  assert.equal(one(ctx, 'Day One').d.trialOutcome, 'converted');
});
await t('trial counts and the conversion rate only see members from the cutoff on', () => {
  const s = E.trialStats(cutoffWorld().members);
  assert.deepEqual([s.trials, s.converted, s.active, s.known], [2, 1, 1, 1]);
  near(s.rate, 1);
});
await t('pre-trial payers are "new paying, no trial" in the series, not trial conversions', () => {
  const s = E.dailySeries(cutoffWorld(), '2026-09-01', '2026-10-08');
  const total = (k) => s.metrics[k].reduce((a, b) => a + b, 0);
  assert.equal(total('trialStarts'), 2);
  assert.equal(total('conversions'), 1);
  assert.equal(total('directPaid'), 2);
  assert.equal(s.metrics.directPaid[s.days.indexOf('2026-09-10')], 1);
  near(total('newMrr'), 57);                                // all three still add MRR
});
await t('acquisition cost divides by every new paying member, trial or not', () => {
  const pre = E.periodSummary(cutoffWorld(), '2026-09-01', '2026-09-26').cohort;
  assert.deepEqual([pre.trials, pre.converted, pre.directPaid, pre.newPaying], [0, 0, 2, 2]);
  assert.equal(pre.blendedCostPerTrial, null);              // no trials, so no cost per trial
  near(pre.blendedCac, 50);
  assert.equal(pre.rate, null);                             // and no conversion rate to quote
  const wk = E.cohorts(cutoffWorld(), 'week').find((c) => c.from === '2026-09-21');
  assert.deepEqual([wk.trials, wk.converted, wk.directPaid, wk.newPaying], [1, 1, 1, 2]);
});
await t('the forecast is built from real trials only', () => {
  const f = E.forecast(cutoffWorld());
  assert.equal(f.activeTrials, 1);
  assert.equal(f.sample, 1);                                // not 3
});
await t('a pasted trial status still counts as a trial, whatever the join date', () => {
  const imp = csvImport('a', '2026-10-07', ['Pre,Paid,pre@x.com,,2026-09-10 15:00:00,$19,month,$0']);
  const p = pasteImport('p', '2026-10-07', 'Pre Paid\n@pre\nTrial canceled Sep 14, 2026\nJoined Sep 10, 2026');
  assert.equal(one(world([imp, p], { settings: { trialAppliesFrom: '2026-09-27' } }), 'Pre Paid').d.trialOutcome, 'canceled');
});

/* --------------------------------------------------------------- paste -- */
console.log('\nPasted membership status');

await t('cards are split and read: name, username, status, dates, price', () => {
  const rows = E.parsePaste('Jane Doe\n@jane-doe-1234\nFree trial ends in 5 days\nJoined Oct 3, 2026\n$19/month\n\nJohn Smith\n@john-smith-88\nTrial canceled Oct 1, 2026\n\nAna Ruiz\n@ana-ruiz-2\nChurned Sep 28, 2026\n$147/year', { pastedDay: '2026-10-08' });
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].name, rows[0].handle, rows[0].status, rows[0].trialEnd, rows[0].joinDay, rows[0].price], ['Jane Doe', 'jane-doe-1234', 'active_trial', '2026-10-13', '2026-10-03', 19]);
  assert.equal(rows[0].approx.trialEnd, true);            // "in 5 days" is relative
  assert.deepEqual([rows[1].status, rows[1].canceledAt], ['trial_canceled', '2026-10-01']);
  assert.deepEqual([rows[2].status, rows[2].churnedAt, rows[2].interval], ['churned', '2026-09-28', 'year']);
});
await t('tab-separated rows work too, and a yearless date is flagged approximate', () => {
  const rows = E.parsePaste('Jane Doe\t@jane\tTrial declined\tJoined Oct 1\nJohn Smith\t@john\tChurned Sep 30', { pastedDay: '2026-10-08' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'trial_declined');
  assert.equal(rows[0].joinDay, '2026-10-01'); assert.equal(rows[0].approx.joinDay, true);
});
await t('every supported status maps to its event', () => {
  for (const [status] of E.STATUSES) {
    const imp = { id: 'p', kind: 'paste', observedAt: '2026-10-07T12:00:00Z', decisions: {}, rows: [{ k: '0', name: 'X Y', handle: 'xy', status, joinDay: '2026-09-01', price: 19, interval: 'month', approx: {} }] };
    const m = one(world([imp]), 'X Y');
    assert.ok(m.events.length >= 2, status);
  }
});
await t('a churn with no date is a window between observations, not an invented day', () => {
  const p = pasteImport('p', '2026-10-07', 'Ana Ruiz\n@ana\nChurned\nJoined Sep 1, 2026');
  const ana = one(world([snap1(), p]), 'Ana Ruiz');
  assert.equal(ana.d.churnPrecision, 'window');
  assert.deepEqual(ana.d.churnWindow, { from: '2026-09-25', to: '2026-10-07' });
  assert.equal(ana.d.status, 'churned');
});

/* ---------------------------------------------------- leave and return -- */
console.log('\nLeaving and returning');

await t('missing then present again is a return, bounded by the two exports', () => {
  const a = csvImport('a', '2026-08-01', ['Ana,Ruiz,ana@x.com,,2026-06-01 15:00:00,$19,month,$38']);
  const b = csvImport('b', '2026-09-01', ['Zed,Other,z@x.com,,2026-08-20 15:00:00,$19,month,$0']);
  const c = csvImport('c', '2026-10-01', ['Ana,Ruiz,ana@x.com,,2026-06-01 15:00:00,$19,month,$57', 'Zed,Other,z@x.com,,2026-08-20 15:00:00,$19,month,$19']);
  const ana = one(world([a, b, c]), 'Ana Ruiz');
  assert.equal(ana.d.returned, true);
  assert.deepEqual(ana.d.returnDays[0].window, { from: '2026-08-01', to: '2026-10-01' });
  assert.equal(ana.d.status, 'paying');
  assert.equal(ana.events.filter((e) => e.type === 'joined').length, 1);
});
await t('a later join date on the same account is a rejoin with an exact date', () => {
  const a = csvImport('a', '2026-08-01', ['Ana,Ruiz,ana@x.com,,2026-06-01 15:00:00,$19,month,$38']);
  const b = csvImport('b', '2026-10-01', ['Ana,Ruiz,ana@x.com,,2026-09-15 15:00:00,$19,month,$57']);
  const ana = one(world([a, b]), 'Ana Ruiz');
  const ev = ana.events.find((e) => e.type === 'rejoined');
  assert.deepEqual([ev.day, ev.precision], ['2026-09-15', 'exact']);
  assert.equal(ana.joinDay, '2026-06-01');                // the original join is kept
});
await t('join, pay, churn and return are all kept as separate events', () => {
  const a = csvImport('a', '2026-10-09', ['Ana,Ruiz,ana@x.com,,2026-10-01 15:00:00,$19,month,$19']);
  const p = pasteImport('p', '2026-10-26', 'Ana Ruiz\n@ana\nChurned Oct 25, 2026', { decisions: { 0: 'e:ana@x.com' } });
  const r = pasteImport('r', '2026-11-11', 'Ana Ruiz\n@ana\nRejoined Nov 10, 2026');
  const c = csvImport('c', '2026-11-20', ['Ana,Ruiz,ana@x.com,,2026-10-01 15:00:00,$19,month,$38']);
  const ana = one(world([a, p, r, c], { today: '2026-11-21' }), 'Ana Ruiz');
  const types = ana.events.map((e) => e.type);
  for (const want of ['joined', 'ltv_observed', 'churned', 'returned', 'payment_observed']) assert.ok(types.includes(want), want);
  assert.deepEqual(ana.d.intervals.map((i) => [i.start, i.end]), [['2026-10-08', '2026-10-25'], ['2026-11-10', null]]);
  assert.equal(ana.d.status, 'paying');
});

/* --------------------------------------------------------------- money -- */
console.log('\nRevenue and MRR');

await t('an annual plan is one twelfth for MRR and whole for cash', () => {
  const ctx = world([snap1(), snap2()]);
  const cara = one(ctx, 'Cara Diaz');
  near(cara.d.monthly, 12.25);
  assert.deepEqual(cara.d.payments.map((p) => p.amount), [147]);
  near(E.mrrAt(ctx, '2026-10-08').gross, 19 + 12.25);
});
await t('trials and free members contribute nothing to MRR or revenue', () => {
  const ctx = world([csvImport('a', '2026-10-07', ['E,Five,e@x.com,,2026-10-05 15:00:00,$19,month,$0', 'F,Free,f@x.com,,2026-09-01 15:00:00,,,$0'])]);
  assert.equal(E.mrrAt(ctx, '2026-10-08').gross, 0);
  assert.equal(E.periodSummary(ctx, '2026-09-01', '2026-10-08').activity.revenue, 0);
});
await t('recorded LTV is never mistaken for MRR', () => {
  const ctx = world([csvImport('a', '2026-10-07', ['Old,Timer,o@x.com,,2025-06-01 15:00:00,$9,month,$144'])]);
  assert.equal(E.mrrAt(ctx, '2026-10-08').gross, 9);
  assert.equal(one(ctx, 'Old Timer').d.revenue, 144);
});
await t('modelled payments always sum to the recorded LTV', () => {
  const demo = buildDemo('2026-10-08');
  const ctx = E.buildContext(demo.db, demo.imports, demo.meta, { today: '2026-10-08' });
  for (const m of ctx.members) near(m.d.revenue, m.ltv || 0);
});
await t('net figures apply the configured fees', () => {
  near(E.netOf(19, E.DEFAULT_SETTINGS), 19 * (1 - 0.029) - 0.3);
  near(E.netOf(19, { fees: { platformPct: 10, processingPct: 0, perTransaction: 0, networkSharePct: 20 } }, 'skool'), 19 * 0.7);
  const ctx = world([csvImport('a', '2026-10-07', ['Old,Timer,o@x.com,,2025-06-01 15:00:00,$19,month,$190'])]);
  near(E.mrrAt(ctx, '2026-10-08').net, 19 * 0.971 - 0.3);
});
await t('a refund and a failed payment recorded by hand are honoured', () => {
  const imp = csvImport('a', '2026-10-07', ['Ana,Ruiz,ana@x.com,,2026-08-01 15:00:00,$19,month,$38']);
  const ctx = world([imp], { manual: [
    { id: 'm1', type: 'refund', memberId: 'e:ana@x.com', day: '2026-09-20', amount: 19 },
    { id: 'm2', type: 'failed_payment', memberId: 'e:ana@x.com', day: '2026-10-08', amount: 19 },
  ] });
  const ana = one(ctx, 'Ana Ruiz');
  assert.ok(ana.d.payments.some((p) => p.kind === 'refund' && p.amount === -19));
  assert.equal(ana.d.failedPayments, 1);
  near(ana.d.revenue, 38);                               // LTV is still the verified total
});
await t('LTV the price cannot explain is flagged, not silently absorbed', () => {
  const imp = csvImport('a', '2026-10-07', ['Ana,Ruiz,ana@x.com,,2026-09-01 15:00:00,$19,month,$500']);
  const ctx = world([imp]);
  assert.ok(one(ctx, 'Ana Ruiz').d.flags.some((f) => f.code === 'ltv_ahead'));
  assert.ok(E.dataQuality(ctx).some((w) => w.code === 'reconcile'));
});
await t('an expected payment that never shows in LTV is flagged as overdue', () => {
  const imp = csvImport('a', '2026-10-07', ['Ana,Ruiz,ana@x.com,,2026-07-01 15:00:00,$19,month,$19']);
  assert.ok(one(world([imp]), 'Ana Ruiz').d.flags.some((f) => f.code === 'payment_overdue'));
});
await t('a paying member who vanishes is excluded from verified MRR and shown at risk', () => {
  const a = csvImport('a', '2026-09-01', ['Ana,Ruiz,ana@x.com,,2026-06-01 15:00:00,$19,month,$57', 'Z,Z,z@x.com,,2026-06-01 15:00:00,$19,month,$57']);
  const b = csvImport('b', '2026-10-01', ['Z,Z,z@x.com,,2026-06-01 15:00:00,$19,month,$76']);
  const ctx = world([a, b]);
  assert.equal(E.mrrAt(ctx, '2026-10-08').gross, 19);
  assert.equal(E.mrrAt(ctx, '2026-09-15').gross, 38);     // she still counted before she was observed missing
  assert.deepEqual(E.mrrAtRisk(ctx), { members: 1, gross: 19 });
});
await t('other expenses are pro-rated by cadence', () => {
  const ctx = world([], { settings: { expenses: [{ label: 'a', amount: 365, cadence: 'annual' }, { label: 'b', amount: 50, cadence: 'once', day: '2026-10-02' }, { label: 'c', amount: 50, cadence: 'once', day: '2026-12-02' }] } });
  near(E.expensesIn(ctx, '2026-10-01', '2026-10-10'), 10 + 50);
});

/* ----------------------------------------------------------------- ads -- */
console.log('\nAdvertising against membership');

const META = {
  account: { id: 'act_1', timezone: 'America/New_York', currency: 'USD' },
  ads: {
    a1: { name: 'Ad One', adsetId: 's1', adsetName: 'Set 1', campaignId: 'c1', campaignName: 'Camp 1' },
    a2: { name: 'Ad Two', adsetId: 's1', adsetName: 'Set 1', campaignId: 'c1', campaignName: 'Camp 1' },
  },
  // a1: Sep 1-3, paused Sep 4-5, back Sep 6-7 with a doubled budget. a2 overlaps Sep 2-3.
  daily: [
    ['2026-09-01', 'a1', 50, 1000, 900, 20, 15, 10, 1], ['2026-09-02', 'a1', 50, 1000, 900, 20, 15, 10, 0], ['2026-09-03', 'a1', 50, 1000, 900, 20, 15, 10, 2],
    ['2026-09-06', 'a1', 100, 2000, 1800, 40, 30, 20, 3], ['2026-09-07', 'a1', 100, 2000, 1800, 40, 30, 20, 1],
    ['2026-09-02', 'a2', 30, 500, 450, 5, 4, 2, 0], ['2026-09-03', 'a2', 30, 500, 450, 5, 4, 2, 0],
  ],
};
const adWorld = () => world([csvImport('a', '2026-10-07', [
  'A,One,a@x.com,,2026-09-01 15:00:00,$19,month,$19', 'B,Two,b@x.com,,2026-09-02 15:00:00,$19,month,$19',
  'C,Three,c@x.com,,2026-09-05 15:00:00,$19,month,$0', 'D,Four,d@x.com,,2026-09-06 15:00:00,$19,month,$38',
])], { meta: META });

await t('a pause and restart is two runs with the right dates and spend', () => {
  const a1 = E.adEntities(adWorld(), 'ad').find((x) => x.id === 'a1');
  assert.deepEqual(a1.runs.map((r) => [r.from, r.to, r.days, r.spend]), [['2026-09-01', '2026-09-03', 3, 150], ['2026-09-06', '2026-09-07', 2, 200]]);
  assert.deepEqual([a1.firstDay, a1.lastDay, a1.daysActive, a1.pauses, a1.spend], ['2026-09-01', '2026-09-07', 5, 1, 350]);
  near(a1.cpc, 350 / 140); near(a1.costPerLpv, 350 / 70);
});
await t('ads running simultaneously both see the same community signups — none is attributed', () => {
  const ents = E.adEntities(adWorld(), 'ad');
  const a1 = ents.find((x) => x.id === 'a1'); const a2 = ents.find((x) => x.id === 'a2');
  assert.equal(a1.community.joins, 3);                    // Sep 1, 2, 6 — not Sep 5, when it was paused
  assert.equal(a2.community.joins, 1);                    // Sep 2
  assert.equal(a1.community.concurrentAds, 1);
  assert.ok(adWorld().members.every((m) => m.attribution === null));
});
await t('ad set, campaign and account levels roll up without double counting', () => {
  const ctx = adWorld();
  assert.equal(E.adEntities(ctx, 'adset')[0].spend, 410);
  assert.equal(E.adEntities(ctx, 'campaign')[0].spend, 410);
  assert.equal(E.adEntities(ctx, 'account')[0].spend, 410);
  assert.equal(E.adEntities(ctx, 'account')[0].daysActive, 5);
});
await t('the daily series carries spend beside membership, and an ad filter narrows ONLY the ad side', () => {
  const ctx = adWorld();
  const all = E.dailySeries(ctx, '2026-09-01', '2026-09-07');
  assert.deepEqual(all.metrics.spend, [50, 80, 80, 0, 0, 100, 100]);
  assert.deepEqual(all.metrics.joins, [1, 1, 0, 0, 1, 1, 0]);
  const only2 = E.dailySeries(ctx, '2026-09-01', '2026-09-07', { level: 'ad', ids: ['a2'] });
  assert.deepEqual(only2.metrics.spend, [0, 30, 30, 0, 0, 0, 0]);
  assert.deepEqual(only2.metrics.joins, all.metrics.joins);
});
await t('a budget change mid-week is visible day by day', () => {
  const s = E.dailySeries(adWorld(), '2026-09-01', '2026-09-07', { level: 'ad', ids: ['a1'] });
  assert.deepEqual(s.metrics.spend, [50, 50, 50, 0, 0, 100, 100]);
});
await t('revenue is credited to the cohort that JOINED, not to the days it was collected', () => {
  const ctx = adWorld();
  const wk = E.periodSummary(ctx, '2026-09-01', '2026-09-07');
  assert.equal(wk.activity.revenue, 0);                   // nobody can pay inside their own trial week
  assert.equal(wk.cohort.revenue, 76);                    // but the people who joined then have paid $76 since
  assert.equal(wk.cohort.converted, 3);
  assert.equal(wk.cohort.directPaid, 0);
  near(wk.cohort.blendedCac, 410 / 3);
  const later = E.periodSummary(ctx, '2026-09-08', '2026-09-14');
  assert.equal(later.activity.spend, 0);
  assert.ok(later.activity.revenue > 0);                  // collected in a week with no ads at all
  assert.equal(later.cohort.joined, 0);
});
await t('estimated dates are counted as soft so the chart can mark them', () => {
  const s = E.dailySeries(adWorld(), '2026-09-01', '2026-09-30');
  assert.ok(s.soft.conversions.reduce((a, b) => a + b, 0) >= 3);
  assert.equal(s.soft.joins.reduce((a, b) => a + b, 0), 0);
});
await t('with no member attribution, nothing calls itself attributed', () => {
  assert.equal(E.profitability(adWorld(), '2026-09-01', '2026-09-07').attributed, false);
});
await t('attribution can be added later without rebuilding anything', () => {
  const imp = csvImport('a', '2026-10-07', ['A,One,a@x.com,,2026-09-01 15:00:00,$19,month,$19']);
  const ctx = world([imp], { meta: META, manual: [{ id: 'o', type: 'override', memberId: 'e:a@x.com', field: 'attribution', value: 'a1' }] });
  assert.equal(one(ctx, 'A One').attribution, 'a1');
  assert.equal(E.profitability(ctx, '2026-09-01', '2026-09-07').attributed, true);
});

/* ------------------------------------------------- retention / forecast -- */
console.log('\nRetention, profitability and forecasts');

await t('retention only counts members old enough to have reached the mark', () => {
  const imp = csvImport('a', '2026-10-07', [
    'A,One,a@x.com,,2026-07-01 15:00:00,$19,month,$57', 'B,Two,b@x.com,,2026-07-01 15:00:00,$19,month,$19', 'C,New,c@x.com,,2026-09-25 15:00:00,$19,month,$19',
  ]);
  const p = pasteImport('p', '2026-10-07', 'B Two\n@b2\nChurned Jul 25, 2026\nJoined Jul 1, 2026');
  const r = E.retention(world([imp, p]));
  assert.deepEqual([r.r30.eligible, r.r30.retained], [2, 1]);   // C paid Oct 2 — six days ago, not eligible
  near(r.r30.rate, 0.5);
  assert.equal(r.paidChurned, 1);
});
await t('paid churn, trial cancellations and unknown outcomes are three separate counts', () => {
  const p = pasteImport('p', '2026-09-26', 'Ana Ruiz\n@ana\nChurned Sep 24, 2026\nJoined Sep 1, 2026');
  const q = pasteImport('q', '2026-09-27', 'Cara Diaz\n@cara\nTrial canceled Sep 12, 2026\nJoined Sep 10, 2026');
  const r = E.retention(world([snap1(), p, q]));
  assert.deepEqual([r.paidChurned, r.trialCanceled, r.unknownOutcome], [1, 1, 1]);
});
await t('break-even arithmetic', () => {
  const b = E.breakEven({ dailyBudget: 100, costPerTrial: 20, convRate: 0.4, price: 19, retentionMonths: 6, platformPct: 0, perTransaction: 0 });
  near(b.cac, 50); near(b.ltv, 114); near(b.paybackMonths, 50 / 19); near(b.profitPerCustomer, 64);
  near(b.breakEvenConvRate, 20 / 114, 0.0001); near(b.breakEvenCostPerTrial, 45.6);
  assert.equal(b.profitable, true);
  assert.equal(E.breakEven({ dailyBudget: 100, costPerTrial: 80, convRate: 0.4, price: 19, retentionMonths: 6 }).profitable, false);
  assert.equal(E.breakEven({ dailyBudget: 100, costPerTrial: 20, convRate: 0, price: 19, retentionMonths: 6 }).cac, null);
});
await t('the forecast brackets the expected case and warns on a small sample', () => {
  const imp = csvImport('a', '2026-10-07', [
    'A,One,a@x.com,,2026-09-01 15:00:00,$19,month,$19', 'C,Three,c@x.com,,2026-09-01 15:00:00,$19,month,$0',
    ...Array.from({ length: 10 }, (_, i) => `T${i},R,t${i}@x.com,,2026-10-05 15:00:00,$19,month,$0`),
  ]);
  const p = pasteImport('p', '2026-10-07', 'C Three\n@c3\nTrial canceled Sep 5, 2026\nJoined Sep 1, 2026');
  const f = E.forecast(world([imp, p]));
  assert.equal(f.activeTrials, 10); near(f.historicalRate, 0.5);
  near(f.expected.members, 5); near(f.expected.grossMrr, 95);
  assert.ok(f.conservative.members < f.expected.members && f.expected.members < f.optimistic.members);
  assert.ok(f.notes.some((n) => /sample is small/.test(n)));
});
await t('no verified outcomes means no forecast rather than a made-up rate', () => {
  const f = E.forecast(world([csvImport('a', '2026-10-07', ['T,R,t@x.com,,2026-10-05 15:00:00,$19,month,$0'])]));
  assert.equal(f.expected, null);
});
await t('the weekly report covers the last complete Monday-to-Sunday week', () => {
  assert.deepEqual(E.lastCompleteWeek('2026-10-08'), { from: '2026-09-28', to: '2026-10-04' });
  const demo = buildDemo('2026-10-08');
  const rep = E.weeklyReport(E.buildContext(demo.db, demo.imports, demo.meta, { today: '2026-10-08', demo: true }));
  assert.equal(rep.rows.length, 10);
  assert.ok(rep.recommendations.length > 0);
  assert.match(E.reportText(rep), /DEMONSTRATION DATA/);
});

/* --------------------------------------------------- demo / end to end -- */
console.log('\nDemonstration data, end to end');

const demo = buildDemo('2026-10-08');
const dctx = E.buildContext(demo.db, demo.imports, demo.meta, { today: '2026-10-08', demo: true });

await t('the demo is flagged as demo everywhere it surfaces', () => {
  assert.ok(E.dataQuality(dctx).some((w) => w.code === 'demo'));
  assert.equal(E.buildDigest(dctx).demoData, true);
});
await t('the demo keeps its two same-named members apart', () => assert.equal(named(dctx, 'Chris Martin').length, 2));
await t('every insight is labelled with what kind of statement it is', () => {
  const ins = E.insights(dctx);
  assert.ok(ins.length >= 3);
  for (const i of ins) assert.ok(['fact', 'estimate', 'correlation', 'missing'].includes(i.kind), i.kind);
  for (const i of ins.filter((x) => /delivering/.test(x.text))) assert.match(i.text, /not attribution/);
});
await t('status counts add up to the member count, and the engine is fast enough to re-run on every render', () => {
  const t0 = Date.now();
  const again = E.buildContext(demo.db, demo.imports, demo.meta, { today: '2026-10-08' });
  assert.ok(Date.now() - t0 < 2000);
  const n = Object.values(E.buildDigest(again).membersByStatus).reduce((a, b) => a + b, 0);
  assert.equal(n, again.members.length);
});
await t('the AI digest carries no member names or emails', () => {
  const text = JSON.stringify(E.buildDigest(dctx));
  assert.ok(!/@example\.com/.test(text));
  assert.ok(!text.includes('Chris Martin'));
});
await t('sparse exports are called out as flattering the conversion rate', () =>
  assert.ok(E.dataQuality(dctx).some((w) => w.code === 'export_gap')));

/* ------------------------------------------------------------ endpoints -- */
console.log('\nEndpoints and storage');

const mem = new Map();
store.useBlobClient({
  async list({ prefix }) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ pathname: k, url: 'https://blob.test/' + k })) }; },
  async put(pathname, body) { mem.set(pathname, body); return { url: 'https://blob.test/' + pathname }; },
  async del(url) { mem.delete(String(url).replace('https://blob.test/', '')); },
});
const realFetch = globalThis.fetch;
let metaCalls = [];
let modelCalls = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://blob.test/')) { const v = mem.get(u.replace('https://blob.test/', '')); return new Response(v || '', { status: v ? 200 : 404 }); }
  if (u.includes('graph.facebook.com')) {
    metaCalls.push({ url: u, method: (init && init.method) || 'GET' });
    const p = new URL(u);
    let data = [];
    if (p.pathname.endsWith('/insights')) data = [{ ad_id: '9', ad_name: 'Ad Nine', adset_id: 's', adset_name: 'Set', campaign_id: 'c', campaign_name: 'Camp', date_start: '2026-10-01', spend: '42.10', impressions: '5100', reach: '4200', clicks: '96', inline_link_clicks: '71', actions: [{ action_type: 'landing_page_view', value: '54' }, { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '6' }, { action_type: 'complete_registration', value: '6' }] }];
    else if (p.pathname.endsWith('/ads')) data = [{ id: '9', name: 'Ad Nine', status: 'ACTIVE', effective_status: 'ACTIVE', created_time: '2026-09-28T10:00:00+0000' }];
    else if (p.pathname.endsWith('/activities')) data = [{ event_type: 'update_ad_run_status', event_time: '2026-10-02T10:00:00+0000', object_id: '9', object_name: 'Ad Nine', extra_data: '{"old_value":"Active","new_value":"Paused"}' }];
    else return new Response(JSON.stringify({ name: 'Acct', currency: 'USD', timezone_name: 'America/New_York' }), { status: 200 });
    return new Response(JSON.stringify({ data }), { status: 200 });
  }
  if (u.includes('api.anthropic.com')) {
    modelCalls++;
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'answer_question', input: { answer: 'Spend was $700.', basis: [{ kind: 'verified', text: 'x' }, { kind: 'made-up', text: 'y' }], confidence: 'high' } }] }), { status: 200 });
  }
  return realFetch(url, init);
};

const SECRET = process.env.DASHBOARD_SESSION_SECRET;
const cookie = auth.createSessionCookie(SECRET).split(';')[0];
function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const call = async (handler, req) => { const res = mockRes(); await handler({ headers: { cookie }, query: {}, ...req }, res); return res; };
const goodImport = () => ({ kind: 'csv', observedAt: '2026-10-01T12:00:00Z', filename: 'm.csv', hash: 'abc', raw: 'RAW TEXT', rows: [{ k: '0', name: 'Ana Ruiz', email: 'ANA@x.com', joinDay: '2026-09-01', price: 19, interval: 'month', ltv: 19, evil: '<script>' }] });

await t('every endpoint refuses a request with no session, before doing anything', async () => {
  for (const h of [growth, growthMeta, growthAi]) {
    const r = await call(h, { method: 'POST', headers: {}, body: {} });
    assert.equal(r.code, 401);
  }
  assert.equal(metaCalls.length, 0); assert.equal(modelCalls, 0);
});
await t('responses are private and never cacheable', async () =>
  assert.match((await call(growth, { method: 'GET' })).headers['Cache-Control'], /no-store/));
await t('a first GET returns an empty database rather than an error', async () => {
  const r = await call(growth, { method: 'GET' });
  assert.equal(r.code, 200); assert.equal(r.body.saved, false); assert.deepEqual(r.body.db.imports, []);
});

let importId;
await t('an import is sanitised, stored encrypted, indexed and audited', async () => {
  const r = await call(growth, { method: 'POST', body: { op: 'import', import: goodImport(), baseVersion: 0 } });
  assert.equal(r.code, 200);
  importId = r.body.import.id;
  assert.equal(r.body.db.version, 1);
  assert.equal(r.body.db.imports[0].rowCount, 1);
  assert.equal(r.body.import.rows[0].email, 'ana@x.com');
  assert.equal(r.body.import.rows[0].evil, undefined);
  assert.equal(r.body.import.raw, undefined);             // the original text is not echoed back
  assert.match(r.body.db.audit[0].action, /import saved/);
  for (const v of mem.values()) { assert.ok(!v.includes('Ana Ruiz')); assert.ok(v.startsWith('SYBSTORE1.')); }
});
await t('the original submitted text is kept, and only served when asked for', async () => {
  const plain = await call(growth, { method: 'GET', query: { import: importId } });
  assert.equal(plain.body.import.raw, undefined);
  const raw = await call(growth, { method: 'GET', query: { import: importId, raw: '1' } });
  assert.equal(raw.body.import.raw, 'RAW TEXT');
});
await t('a stale save is refused with the winning version, not merged', async () => {
  const r = await call(growth, { method: 'POST', body: { op: 'import', import: goodImport(), baseVersion: 0 } });
  assert.equal(r.code, 409); assert.equal(r.body.db.version, 1);
});
await t('a PUT can reverse and restore an import but cannot delete it or rewrite the audit trail', async () => {
  const wipe = await call(growth, { method: 'PUT', body: { baseVersion: 1, db: { imports: [], audit: [], manual: [], settings: {} } } });
  assert.equal(wipe.code, 200);
  assert.equal(wipe.body.db.imports.length, 1);           // still there
  assert.equal(wipe.body.db.audit.length, 1);             // still there
  const rev = await call(growth, { method: 'PUT', body: { baseVersion: 2, db: { imports: [{ id: importId, reverted: { reason: 'wrong file' } }] }, audit: [{ action: 'import reversed', detail: 'x' }] } });
  assert.equal(rev.body.db.imports[0].reverted.reason, 'wrong file');
  assert.equal(rev.body.db.audit.length, 2);
  const back = await call(growth, { method: 'PUT', body: { baseVersion: 3, db: { imports: [{ id: importId, reverted: null }] } } });
  assert.equal(back.body.db.imports[0].reverted, null);
  assert.ok(mem.has(`growth/imports/${importId}.enc`));
});
await t('settings and manual records from the browser are clamped and filtered', async () => {
  const r = await call(growth, { method: 'PUT', body: { baseVersion: 4, db: {
    settings: { timezone: 'Not/AZone', trialDays: 9999, fees: { platformPct: 500 }, reportEmail: 'nope', plans: [{ label: 'X', price: -5, interval: 'weekly' }] },
    manual: [{ type: 'payment', memberId: 'e:ana@x.com', day: '2026-10-01', amount: 19 }, { type: 'payment', memberId: 'e:ana@x.com', day: 'yesterday', amount: 19 }, { type: 'drop_tables' }, { type: 'override', memberId: 'x', field: 'isAdmin', value: true }],
  } } });
  const s = r.body.db.settings;
  assert.deepEqual([s.timezone, s.trialDays, s.fees.platformPct, s.reportEmail, s.plans[0].price, s.plans[0].interval], ['America/New_York', 90, 100, '', 0, 'month']);
  assert.equal(r.body.db.manual.length, 1);
});
await t('a bad import is rejected with a reason', () => {
  assert.throws(() => sanitiseImport({ kind: 'xml', rows: [] }), /CSV or a pasted block/);
  assert.throws(() => sanitiseImport({ kind: 'csv', observedAt: '2026-10-01T00:00:00Z', rows: [{}] }), /identified/);
  assert.throws(() => sanitiseImport({ kind: 'csv', observedAt: '2999-01-01T00:00:00Z', rows: [{ name: 'A' }] }), /future/);
});

await t('reading the ad history never contacts Meta', async () => {
  metaCalls = [];
  const r = await call(growthMeta, { method: 'GET' });
  assert.equal(r.code, 200); assert.equal(r.body.meta, null); assert.equal(metaCalls.length, 0);
});
await t('a sync stores the daily history and makes only read requests', async () => {
  const r = await call(growthMeta, { method: 'POST', body: {} });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.meta.daily[0], ['2026-10-01', '9', 42.1, 5100, 4200, 96, 71, 54, 6]);   // 6, not 12: aliases are never summed
  assert.equal(r.body.meta.ads['9'].createdDay, '2026-09-28');
  assert.equal(r.body.meta.account.timezone, 'America/New_York');
  assert.deepEqual([r.body.meta.statusChanges[0].from, r.body.meta.statusChanges[0].to], ['Active', 'Paused']);
  assert.ok(metaCalls.length >= 3);
  assert.ok(metaCalls.every((c) => c.method === 'GET'));
  assert.ok(!JSON.stringify(r.body).includes(process.env.META_ADS_TOKEN));
  assert.equal(r.body.tokenSource, 'META_ADS_TOKEN');
});
await t('the scheduled sync needs the cron secret', async () => {
  const no = await call(growthMeta, { method: 'GET', headers: {}, query: { cron: '1' } });
  assert.equal(no.code, 401);
  const wrong = await call(growthMeta, { method: 'GET', headers: { authorization: 'Bearer nope' }, query: { cron: '1' } });
  assert.equal(wrong.code, 401);
  const yes = await call(growthMeta, { method: 'GET', headers: { authorization: 'Bearer cron-secret-value' }, query: { cron: '1' } });
  assert.equal(yes.code, 200); assert.equal(yes.body.ok, true);
});
await t('a re-sync replaces the recent window and keeps older days', () => {
  const old = [['2026-01-01', 'a', 5, 0, 0, 0, 0, 0, 0], ['2026-09-30', 'a', 10, 0, 0, 0, 0, 0, 0], ['2026-10-01', 'gone', 3, 0, 0, 0, 0, 0, 0]];
  const merged = mergeDaily(old, [['2026-09-30', 'a', 12, 0, 0, 0, 0, 0, 0]], '2026-09-15');
  assert.deepEqual(merged.map((r) => [r[0], r[1], r[2]]), [['2026-01-01', 'a', 5], ['2026-09-30', 'a', 12]]);
  assert.equal(shapeDaily({ date_start: '2026-10-01', ad_id: '1', spend: '1.005' })[8], 0);
});

await t('the analyst is given the digest, answers through the tool, and invented kinds are coerced', async () => {
  modelCalls = 0;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-FAKE';
  const r = await call(growthAi, { method: 'POST', body: { question: 'How much did we spend?', digest: E.buildDigest(dctx) } });
  assert.equal(r.code, 200); assert.equal(modelCalls, 1);
  assert.equal(r.body.answer.answer, 'Spend was $700.');
  assert.deepEqual(r.body.answer.basis.map((b) => b.kind), ['verified', 'estimate']);
});
await t('with no data there is no model call', async () => {
  modelCalls = 0;
  const r = await call(growthAi, { method: 'POST', body: { question: 'Anything?', digest: { membersByStatus: {}, dataCoverage: {} } } });
  assert.equal(r.body.skipped, 'no_data'); assert.equal(modelCalls, 0);
});
await t('an empty answer is an error, not a blank panel', () => assert.throws(() => shapeAnswer({ answer: '  ', basis: [] }), /empty/));

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
