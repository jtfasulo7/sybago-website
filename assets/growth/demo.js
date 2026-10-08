// Demonstration data for Growth Intelligence.
//
// Deliberately produced the long way round: this file simulates a community,
// writes it out as the CSV text and the pasted-card text Skool would give you,
// and hands THOSE to the real parsers. So the demo exercises the same import
// path as real data, and every awkward case the engine has to survive is in
// here on purpose — two members with the same name, people who vanish from an
// export with no explanation, a pause-and-restart ad, a mid-week budget change,
// an annual plan, free members, a legacy price, a leave-and-return.
//
// Nothing here is ever saved. The UI holds it in memory behind a banner.

import {
  addDays, addMonths, diffDays, parseCsv, detectColumns, normaliseCsvRows, parsePaste, contentHash, emptyDb,
} from './engine.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Taylor', 'Quinn', 'Reese', 'Dana', 'Skyler', 'Jamie', 'Rowan', 'Elliot', 'Harper', 'Logan', 'Parker', 'Sage', 'Drew', 'Blake', 'Emerson', 'Marcus', 'Elena', 'Priya', 'Tomas', 'Nadia', 'Victor', 'Leah', 'Omar', 'Greta', 'Ines', 'Callum', 'Bianca', 'Desmond', 'Farah', 'Gideon', 'Hana', 'Idris', 'Joss', 'Kira', 'Lucian', 'Mirela', 'Nico', 'Odette', 'Pavel', 'Renata', 'Soren', 'Talia', 'Wes'];
const LAST = ['Bennett', 'Okafor', 'Lindqvist', 'Moreau', 'Castillo', 'Whitfield', 'Nakamura', 'Abernathy', 'Dragomir', 'Fontaine', 'Hollis', 'Iverson', 'Kowalski', 'Marchetti', 'Novak', 'Osei', 'Pemberton', 'Quintero', 'Rasmussen', 'Thackeray', 'Ulloa', 'Vasquez', 'Winslow', 'Yamamoto', 'Zeller', 'Ashdown', 'Brannigan', 'Corvalan', 'Delacroix', 'Eastwick', 'Farrow', 'Galloway', 'Hartigan', 'Ibarra', 'Jessup', 'Kilbride', 'Lattimer', 'Montague', 'Nordstrom', 'Oyelaran', 'Prescott', 'Radcliffe', 'Sandoval', 'Tremaine', 'Underhill', 'Verhoeven', 'Wexford', 'Yarrow', 'Zamora'];
const SOURCES = ['Facebook', 'Facebook', 'Instagram', 'Instagram', 'Skool discovery', 'Direct', '', ''];

const ADS = [
  { id: 'd-ad-1', name: 'Dave Image — Hook 1', adset: 'Ad Set 1 — Paid', campaign: 'Dave Campaign Winner', from: 0, to: 149, pause: [60, 66], budget: () => 30 },
  { id: 'd-ad-2', name: 'Video Testimonial', adset: 'Ad Set 1 — Paid', campaign: 'Dave Campaign Winner', from: 20, to: 95, budget: () => 18 },
  { id: 'd-ad-3', name: 'Carousel — 7 Day Trial', adset: 'Ad Set 2 — Testing', campaign: 'Dave Campaign 2 — Testing', from: 45, to: 149, budget: (d) => (d >= 101 ? 45 : 20) },
  { id: 'd-ad-4', name: 'Static — Price Anchor', adset: 'Ad Set 2 — Testing', campaign: 'Dave Campaign 2 — Testing', from: 70, to: 110, budget: () => 15 },
  { id: 'd-ad-5', name: 'UGC Reel v2', adset: 'Ad Set 3 — Creators', campaign: 'Dave Campaign 2 — Testing', from: 118, to: 149, budget: () => 25 },
];

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const longDate = (day) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function buildDemo(today) {
  const rand = rng(20261008);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const SPAN = 150;
  const day0 = addDays(today, -(SPAN - 1));
  const dayAt = (i) => addDays(day0, i);

  /* ----------------------------------------------------------- the ads -- */
  const daily = [];
  const spendByDay = new Array(SPAN).fill(0);
  const perAdSpend = ADS.map(() => new Array(SPAN).fill(0));
  ADS.forEach((ad, a) => {
    for (let d = ad.from; d <= Math.min(ad.to, SPAN - 1); d++) {
      if (ad.pause && d >= ad.pause[0] && d <= ad.pause[1]) continue;
      const spend = Math.round(ad.budget(d) * (0.86 + rand() * 0.26) * 100) / 100;
      perAdSpend[a][d] = spend;
      spendByDay[d] += spend;
    }
  });

  /* ------------------------------------------------------- the members -- */
  const people = [];
  const used = new Set();
  const makeName = () => {
    for (let n = 0; n < 50; n++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      if (!used.has(name)) { used.add(name); return name; }
    }
    return `${pick(FIRST)} ${pick(LAST)}`;
  };
  const add = (name, joinIdx, plan) => {
    const [first, last] = name.split(' ');
    const p = {
      name, first, last,
      email: `${first}.${last}${people.length}@example.com`.toLowerCase(),
      handle: `${first}-${last}-${1000 + Math.floor(rand() * 8999)}`.toLowerCase(),
      join: dayAt(joinIdx), joinIdx, plan, source: pick(SOURCES),
      price: plan === 'free' ? 0 : plan === 'year' ? 147 : plan === 'legacy' ? 9 : 19,
      interval: plan === 'free' ? '' : plan === 'year' ? 'year' : 'month',
      fate: 'none', cancelDay: null, leaveDay: null, churnDay: null, returnDay: null, payments: [],
    };
    people.push(p);
    return p;
  };

  // A legacy block that predates the trial offer and the ad history.
  for (let i = 0; i < 14; i++) {
    const p = add(makeName(), -(40 + Math.floor(rand() * 220)), 'legacy');
    p.fate = 'paid'; p.noTrial = true;
  }
  const joinsPerDay = [];
  for (let d = 0; d < SPAN; d++) {
    // Signups loosely follow the previous two days of spend, plus a little organic.
    const drive = (spendByDay[d] + (spendByDay[d - 1] || 0)) / 2;
    const expected = drive / 13 + 0.35;
    let n = Math.floor(expected);
    if (rand() < expected - n) n++;
    if (rand() < 0.12) n += 1;
    joinsPerDay.push(n);
    for (let k = 0; k < n; k++) {
      const r = rand();
      add(makeName(), d, r < 0.05 ? 'free' : r < 0.11 ? 'year' : 'month');
    }
  }
  // Two different people with the same name.
  add('Chris Martin', 55, 'month');
  add('Chris Martin', 97, 'month');

  for (const p of people) {
    if (p.plan === 'free') { p.fate = 'free'; continue; }
    const trialEnd = p.noTrial ? p.join : addDays(p.join, 7);
    p.trialEnd = trialEnd;
    if (!p.noTrial) {
      const r = rand();
      // Later cohorts convert a little worse — the budget went up, the audience widened.
      const convert = p.joinIdx > 100 ? 0.36 : 0.46;
      if (r < convert) p.fate = 'paid';
      else if (r < convert + 0.3) { p.fate = 'canceled'; p.cancelDay = addDays(p.join, 1 + Math.floor(rand() * 6)); p.leaveDay = trialEnd; }
      else if (r < convert + 0.38) { p.fate = 'declined'; p.leaveDay = trialEnd; }
      else { p.fate = 'vanished'; p.leaveDay = trialEnd; }
    }
    if (p.fate !== 'paid') continue;
    let pay = trialEnd;
    for (let n = 0; n < 40 && pay <= today; n++) {
      p.payments.push(pay);
      if (p.interval === 'year') break;
      if (rand() < (p.plan === 'legacy' ? 0.04 : 0.13)) { p.churnDay = addMonths(trialEnd, n + 1); break; }
      pay = addMonths(trialEnd, n + 1);
    }
    if (p.churnDay && p.churnDay > today) p.churnDay = null;
    if (p.churnDay && rand() < 0.22) {
      const back = addDays(p.churnDay, 9 + Math.floor(rand() * 24));
      if (back <= today) {
        p.returnDay = back; p.returnKeepsJoin = rand() < 0.5;
        for (let n = 0, d = back; n < 12 && d <= today; n++, d = addMonths(back, n)) p.payments.push(d);
      }
    }
  }

  const presentOn = (p, day) => {
    if (p.join > day) return false;
    if (p.leaveDay && p.leaveDay <= day) return false;
    if (p.churnDay && p.churnDay <= day) return !!(p.returnDay && p.returnDay <= day);
    return true;
  };
  const ltvOn = (p, day) => p.payments.filter((d) => d <= day).length * p.price;

  /* ---------------------------------------------- what Skool would give -- */
  const imports = [];
  const db = emptyDb();
  // The simulated community has offered a trial for its whole ad history.
  db.settings.trialAppliesFrom = day0;
  const pushImport = (imp) => {
    imports.push(imp);
    db.imports.push({ id: imp.id, kind: imp.kind, observedAt: imp.observedAt, filename: imp.filename, hash: imp.hash, rowCount: imp.rows.length, label: imp.label, reverted: null, createdAt: imp.observedAt });
  };

  const csvFor = (day) => {
    const lines = ['FirstName,LastName,Email,Invited By,JoinedDate,Price,Recurring Interval,LTV,Source'];
    for (const p of people) {
      if (!presentOn(p, day)) continue;
      const joined = p.returnDay && p.returnDay <= day && !p.returnKeepsJoin ? p.returnDay : p.join;
      lines.push([p.first, p.last, p.email, '', `${joined} 15:${String(10 + (p.email.length % 49)).padStart(2, '0')}:00`,
        p.price ? `$${p.price}.00` : '', p.interval, `$${ltvOn(p, day)}.00`, p.source].map(csvCell).join(','));
    }
    return lines.join('\n');
  };
  [60, 100, 121, 128, 135, 142, 148].forEach((idx, n) => {
    const day = dayAt(idx);
    const text = csvFor(day);
    const parsed = parseCsv(text);
    const mapping = detectColumns(parsed.headers);
    const { rows } = normaliseCsvRows(parsed, mapping, db.settings);
    pushImport({ id: `demo-csv-${n + 1}`, kind: 'csv', observedAt: `${day}T16:00:00.000Z`, filename: `skool-members-${day}.csv`, hash: contentHash(text), mapping, rows, decisions: {}, label: 'Skool CSV export' });
  });

  const card = (p, lines) => [p.name, `@${p.handle}`, ...lines, `Joined ${longDate(p.join)}`, p.price ? `$${p.price}/${p.interval === 'year' ? 'year' : 'month'}` : 'Free'].join('\n');
  const pasteAt = (idx, id, label, defaultStatus, blocks) => {
    if (!blocks.length) return;
    const day = dayAt(idx);
    const text = blocks.join('\n\n');
    const rows = parsePaste(text, { pastedDay: day, defaultStatus });
    pushImport({ id, kind: 'paste', observedAt: `${day}T17:30:00.000Z`, filename: null, hash: contentHash(text), rows, decisions: {}, label, context: defaultStatus });
  };

  // Day 135: the ended-trial and churned lists — but, as in life, not all of them.
  const ended = [];
  for (const p of people) {
    if (p.name === 'Chris Martin') continue;
    if (p.fate === 'canceled' && p.cancelDay <= dayAt(135) && rand() < 0.85) ended.push(card(p, [`Trial canceled ${longDate(p.cancelDay)}`]));
    else if (p.fate === 'declined' && p.leaveDay <= dayAt(135) && rand() < 0.7) ended.push(card(p, ['Trial declined — payment failed']));
    else if (p.churnDay && p.churnDay <= dayAt(135) && rand() < 0.8) ended.push(card(p, [`Churned ${longDate(p.churnDay)}`]));
  }
  pasteAt(135, 'demo-paste-1', 'Ended trials and churned members', 'unknown', ended);

  // The latest day: who is on trial right now.
  const trials = [];
  for (const p of people) {
    if (!p.noTrial && p.plan !== 'free' && p.join <= dayAt(148) && p.trialEnd > dayAt(148) && !(p.cancelDay && p.cancelDay <= dayAt(148))) {
      trials.push(card(p, [`Free trial ends in ${diffDays(dayAt(148), p.trialEnd)} days`]));
    }
  }
  pasteAt(148, 'demo-paste-2', 'Active trials', 'active_trial', trials);

  // And a handful who have asked to cancel but are still members.
  const canceling = [];
  for (const p of people) {
    if (canceling.length >= 7) break;
    if (p.fate !== 'paid' || p.churnDay || p.interval !== 'month' || p.name === 'Chris Martin' || p.payments.length < 2 || rand() > 0.06) continue;
    const next = addMonths(p.payments[p.payments.length - 1], 1);
    canceling.push(card(p, [`Canceled ${longDate(addDays(dayAt(148), -(1 + Math.floor(rand() * 9))))}`, `Access ends ${longDate(next)}`]));
  }
  pasteAt(148, 'demo-paste-3', 'Canceling members', 'canceling', canceling);

  /* -------------------------------------------------------------- Meta -- */
  const ads = {};
  ADS.forEach((ad) => {
    ads[ad.id] = {
      name: ad.name, adsetId: 'set-' + ad.adset, adsetName: ad.adset, campaignId: 'camp-' + ad.campaign, campaignName: ad.campaign,
      status: ad.to >= SPAN - 1 ? 'ACTIVE' : 'PAUSED', effectiveStatus: ad.to >= SPAN - 1 ? 'ACTIVE' : 'PAUSED', createdDay: dayAt(ad.from),
    };
  });
  for (let d = 0; d < SPAN; d++) {
    ADS.forEach((ad, a) => {
      const spend = perAdSpend[a][d];
      if (!spend) return;
      const cpm = 34 + rand() * 14;
      const impressions = Math.round((spend / cpm) * 1000);
      const clicks = Math.max(1, Math.round(impressions * (0.011 + rand() * 0.012)));
      const linkClicks = Math.round(clicks * 0.78);
      const lpv = Math.round(linkClicks * (0.7 + rand() * 0.15));
      // Meta sees only some of the signups, and credits them by its own rules.
      const share = spendByDay[d] ? spend / spendByDay[d] : 0;
      const conv = Math.round(joinsPerDay[d] * share * (0.45 + rand() * 0.35));
      daily.push([dayAt(d), ad.id, spend, impressions, Math.round(impressions * 0.82), clicks, linkClicks, lpv, conv]);
    });
  }
  const meta = {
    account: { id: 'act_demo', name: 'Demo ad account', currency: 'USD', timezone: 'America/New_York' },
    ads, daily, statusChanges: [],
    attribution: 'Demonstration data',
    syncedAt: `${today}T12:00:00.000Z`, log: [],
  };

  db.version = 0;
  return { db, imports, meta };
}
