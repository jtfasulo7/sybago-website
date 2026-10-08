// Growth Intelligence — the pages that change data, and the AI/report page.
//
// Split from ./ui.js only for size. It receives the shared state and widgets
// as `kit` rather than importing them, so there is no import cycle and one
// obvious owner of the state.
//
// THE RULE THIS FILE LIVES BY: nothing is saved without a review step. A CSV
// and a pasted block both become a draft, the draft is replayed through the
// real engine to show exactly what it would change, and only "Confirm and
// save" sends it. What gets previewed is what gets saved, because it is the
// same function that computes both.

export function adminPages(kit) {
  const { S, E, h, money, int, dec, pct, dayLabel, dayFull, tag, precisionTag, panel, table, tiles, insightList, api, saveDb, saveImport, rebuild, render, setDemo } = kit;

  const uid = () => Math.random().toString(36).slice(2, 10);
  const liveImports = () => [...S.imports.values()];
  const nowLocalInput = () => { const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  const toIso = (local) => { const d = new Date(local); return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); };
  const who = (m) => `<button type="button" class="gi-link" data-act="member-open" data-id="${h(m.id)}">${h(m.name)}</button>`;
  const ident = (m) => h(m.handle ? '@' + m.handle : m.email || '—');

  /* ============================================================ members == */

  const STATUS_ORDER = ['paying', 'canceling', 'trial_active', 'trial_unresolved', 'trial_canceled', 'trial_declined', 'churned', 'returned_unverified', 'missing_unverified', 'free', 'unknown'];

  function importName(id) {
    const i = (S.db.imports || []).find((x) => x.id === id);
    return i ? `${i.label || (i.kind === 'csv' ? 'CSV export' : 'Pasted list')} · ${dayLabel(String(i.observedAt).slice(0, 10), true)}` : 'Recorded by hand';
  }

  function memberDetail(m) {
    const c = S.ctx; const d = m.d;
    const dupes = (m.possibleDuplicateOf || []).map((id) => c.byId.get(id)).filter(Boolean);
    const events = m.events.slice().reverse();
    const eventTypes = [['trial_started', 'Trial started'], ['trial_canceled', 'Trial canceled'], ['trial_declined', 'Trial declined'], ['trial_ended', 'Trial ended — outcome unknown'], ['paid_verified', 'Paid subscription verified'], ['cancel_scheduled', 'Cancellation requested — still a member'], ['churned', 'Churned — has left'], ['returned', 'Returned'], ['reactivated', 'Subscription reactivated'], ['note', 'Note']];
    return panel(m.name, `
      <div class="gi-member-top">
        <p class="gi-status-line">${tag(d.statusLabel, d.verified ? 'is-ok' : 'is-win')} ${d.returned ? tag('returning member', 'is-est') : ''}</p>
        <dl class="gi-facts">
          <div><dt>Skool username</dt><dd>${m.handle ? '@' + h(m.handle) : '—'}</dd></div>
          <div><dt>Email</dt><dd>${h(m.email || '—')}</dd></div>
          <div><dt>Profile ID</dt><dd>${h(m.profileId || '—')}</dd></div>
          <div><dt>Joined</dt><dd>${dayFull(m.joinDay)}</dd></div>
          <div><dt>Plan</dt><dd>${h(E.planLabel(c.settings, m))}</dd></div>
          <div><dt>Recorded lifetime value</dt><dd>${money(m.ltv, 2)}${m.ltvDay ? ` <small>as of ${dayLabel(m.ltvDay)}</small>` : ''}</dd></div>
          <div><dt>Trial</dt><dd>${!d.hasTrial && m.price > 0 && m.joinDay && c.settings.trialAppliesFrom && m.joinDay < c.settings.trialAppliesFrom ? `No trial — joined before the offer began (${dayLabel(c.settings.trialAppliesFrom, true)})` : d.hasTrial ? `${dayLabel(d.trialStart)} – ${dayLabel(d.trialEnd, true)}${d.trialStartInferred ? ' <small>(start inferred from join date)</small>' : ''}` : 'No trial'}</dd></div>
          <div><dt>Trial outcome</dt><dd>${h({ none: '—', active: 'Active', converted: 'Verified converted to paid', canceled: 'Canceled', declined: 'Declined', unresolved: 'Ended — payment outcome unknown' }[d.trialOutcome])}</dd></div>
          <div><dt>First payment</dt><dd>${d.firstPaidDay ? `${dayFull(d.firstPaidDay)} ${precisionTag(d.firstPaidPrecision, d.firstPaidWindow)} <small>evidence: ${h(d.paidEvidence)}</small>` : 'No payment evidence'}</dd></div>
          ${d.canceling ? `<div><dt>Cancellation</dt><dd>Requested ${d.cancelRequestedPrecision === 'window' ? '' : dayFull(d.cancelRequestedDay)} ${precisionTag(d.cancelRequestedPrecision, d.cancelRequestedWindow)}<small>${d.accessEnds ? `Access ends ${dayFull(d.accessEnds)}${d.accessEndsApprox ? ' (approximate)' : ''}` : 'End date not known'} · still a member, still counted as paying</small></dd></div>` : ''}
          <div><dt>In latest export</dt><dd>${m.present === true ? 'Yes' : m.present === false ? `No — last listed ${dayLabel(m.missingFrom, true)}` : 'Never seen in an export'}</dd></div>
          <div><dt>Acquisition source</dt><dd>
            <select data-change="member-source" data-id="${h(m.id)}" aria-label="Acquisition source">${E.SOURCES.map((s) => `<option value="${s}"${(m.source || 'unknown') === s ? ' selected' : ''}>${h(E.SOURCE_LABELS[s])}</option>`).join('')}</select>
            ${m.sourceRaw ? `<small>Skool says: ${h(m.sourceRaw)}</small>` : ''}${m.invitedBy ? `<small>Invited by ${h(m.invitedBy)}</small>` : ''}
          </dd></div>
          <div><dt>Ad attribution</dt><dd>${m.attribution ? h(m.attribution) : '<small>None on record. Members are never assigned to an ad without evidence.</small>'}</dd></div>
        </dl>
      </div>
      ${d.flags.length ? `<ul class="gi-flags">${d.flags.map((f) => `<li>${h(f.message)}</li>`).join('')}</ul>` : ''}
      ${dupes.length ? `<div class="notice notice-warn"><span>Shares a name with ${dupes.map((x) => `${who(x)} (${ident(x)}, joined ${dayLabel(x.joinDay, true)})`).join(', ')}. They are kept as separate people. If they are the same account, reverse the import that created the duplicate and re-import it with the match confirmed.</span></div>` : ''}

      <h4 class="gi-h4">Event history</h4>
      ${table([
        { label: 'When it happened', cell: (e) => `${e.precision === 'window' ? '<span class="gi-dim">unknown</span>' : dayFull(e.day)} ${precisionTag(e.precision, e.window)}` },
        { label: 'Event', cell: (e) => h(E.EVENT_LABEL[e.type] || e.type) + (e.data && e.data.amount != null ? ` — ${money(e.data.amount, 2)}` : '') + (e.data && e.data.from != null && e.type === 'price_changed' ? ` — ${money(e.data.from, 2)} → ${money(e.data.to, 2)}` : '') + (e.data && (e.data.note || e.data.text) ? `<br><small>${h(e.data.note || e.data.text)}</small>` : '') },
        { label: 'Learned from', cell: (e) => h(importName(e.importId)) },
        { label: 'Observed', cell: (e) => (e.observedAt ? dayLabel(String(e.observedAt).slice(0, 10), true) : '—') },
        { label: '', cell: (e) => (e.manualId ? `<button type="button" class="gi-link" data-act="manual-remove" data-id="${h(e.manualId)}">Remove</button>` : `<button type="button" class="gi-link" data-act="event-void" data-key="${h(e.key)}" title="Exclude this event from every calculation. It stays in the original import.">Mark as wrong</button>`) },
      ], events, { caption: 'Newest first. “Observed” is when the dashboard learned of it, which is not always when it happened.' })}

      <h4 class="gi-h4">Payments</h4>
      ${table([
        { label: 'Day', cell: (p) => `${dayFull(p.day)} ${precisionTag(p.precision)}` },
        { label: 'Type', cell: (p) => (p.kind === 'refund' ? 'Refund' : p.kind === 'refund_observed' ? `Recorded LTV fell by ${money(p.note, 2)}` : 'Payment') },
        { label: 'Amount', num: true, cell: (p) => money(p.amount, 2) },
      ], d.payments, { empty: 'No payment evidence for this member.', caption: `Total ${money(d.revenue, 2)}. Estimated days sit on the billing anchor; the total is Skool's recorded figure.` })}

      <div class="gi-two gi-forms">
        <form data-form="member-event" data-id="${h(m.id)}" class="gi-form">
          <h4 class="gi-h4">Record something that happened</h4>
          <label>Event <select name="eventType">${eventTypes.map(([k, l]) => `<option value="${k}">${h(l)}</option>`).join('')}</select></label>
          <label>Date <input type="date" name="day" required max="${h(c.today)}" value="${h(c.today)}"></label>
          <label>Note <input type="text" name="note" maxlength="300" placeholder="Where this came from"></label>
          <button type="submit" class="btn btn-ghost gi-btn-sm">Add event</button>
        </form>
        <form data-form="member-payment" data-id="${h(m.id)}" class="gi-form">
          <h4 class="gi-h4">Record a payment, refund or failed payment</h4>
          <label>Type <select name="type"><option value="payment">Successful payment</option><option value="refund">Refund</option><option value="failed_payment">Failed payment</option></select></label>
          <label>Date <input type="date" name="day" required max="${h(c.today)}" value="${h(c.today)}"></label>
          <label>Amount <input type="number" name="amount" step="0.01" min="0" required value="${h(m.price || '')}"></label>
          <label>Note <input type="text" name="note" maxlength="300"></label>
          <button type="submit" class="btn btn-ghost gi-btn-sm">Record</button>
        </form>
      </div>`,
    { id: 'gi-member-detail', sub: `${ident(m)} · first seen in ${h(importName(m.firstImport))}`, ctl: '<button type="button" class="btn btn-ghost gi-btn-sm" data-act="member-close">Close</button>' });
  }

  const members = {
    html() {
      const c = S.ctx; const f = S.members;
      const counts = {};
      for (const m of c.members) counts[m.d.status] = (counts[m.d.status] || 0) + 1;
      const q = f.q.trim().toLowerCase();
      const list = c.members.filter((m) => (!f.status || m.d.status === f.status) &&
        (!q || [m.name, m.email, m.handle].some((v) => v && String(v).toLowerCase().includes(q))))
        .sort((a, b) => String(b.joinDay || '').localeCompare(String(a.joinDay || '')));
      const sel = f.sel ? c.byId.get(f.sel) : null;
      const group = (keyOf) => {
        const g = new Map();
        for (const m of c.members) {
          const k = keyOf(m);
          const row = g.get(k) || { key: k, members: 0, paying: 0, trials: [], revenue: 0 };
          row.members++; if (m.d.status === 'paying') row.paying++; row.trials.push(m); row.revenue += m.d.revenue;
          g.set(k, row);
        }
        return [...g.values()].map((r) => ({ ...r, t: E.trialStats(r.trials) })).sort((a, b) => b.members - a.members);
      };
      const groupCols = (label) => [
        { label, cell: (x) => h(x.key) }, { label: 'Members', num: true, cell: (x) => int(x.members) },
        { label: 'Paying now', num: true, cell: (x) => int(x.paying) },
        { label: 'Trial conversion', num: true, cell: (x) => pct(x.t.rate) + (x.t.known ? ` <small>(${int(x.t.converted)}/${int(x.t.known)})</small>` : '') },
        { label: 'Revenue to date', num: true, cell: (x) => money(x.revenue) },
      ];
      return `
      <div class="gi-pagehead"><h3>Member Analytics</h3><p class="sub">Every member the imports have ever seen, with the full history behind their current status.</p></div>
      ${sel ? memberDetail(sel) : ''}
      ${panel('Members', `
        <div class="gi-chips" role="group" aria-label="Filter by status">
          <button type="button" class="gi-chip" data-act="member-status" data-status="" aria-pressed="${!f.status}">All <b>${int(c.members.length)}</b></button>
          ${STATUS_ORDER.filter((s) => counts[s]).map((s) => `<button type="button" class="gi-chip" data-act="member-status" data-status="${s}" aria-pressed="${f.status === s}">${h(E.MEMBER_STATUS_LABEL[s])} <b>${int(counts[s])}</b></button>`).join('')}
        </div>
        <form data-form="member-search" class="gi-search"><label class="sr-only" for="gi-q">Search members</label><input type="text" id="gi-q" name="q" value="${h(f.q)}" placeholder="Search by name, email or username"><button type="submit" class="btn btn-ghost gi-btn-sm">Search</button>${f.q ? '<button type="button" class="gi-link" data-act="member-clear">Clear</button>' : ''}</form>
        ${table([
          { label: 'Member', cell: (m) => who(m) + (m.d.flags.some((x) => x.code === 'possible_duplicate') ? ' <abbr title="Possible duplicate">⚑</abbr>' : '') },
          { label: 'Identifier', cell: ident },
          { label: 'Joined', cell: (m) => dayLabel(m.joinDay, true) },
          { label: 'Plan', cell: (m) => h(E.planLabel(c.settings, m)) },
          { label: 'Status', cell: (m) => tag(m.d.statusLabel, m.d.verified ? 'is-ok' : 'is-win') },
          { label: 'Recorded LTV', num: true, cell: (m) => money(m.ltv, 2) },
          { label: 'Source', cell: (m) => h(E.SOURCE_LABELS[m.source || 'unknown']) },
        ], list.slice(0, f.limit), { empty: 'No member matches that.', rowAttr: (m) => (m.id === f.sel ? 'class="is-sel"' : '') })}
        ${list.length > f.limit ? `<p class="gi-actions"><button type="button" class="btn btn-ghost gi-btn-sm" data-act="member-more">Show ${Math.min(100, list.length - f.limit)} more of ${int(list.length)}</button></p>` : `<p class="gi-fine">${int(list.length)} member${list.length === 1 ? '' : 's'}.</p>`}`)}
      <div class="gi-two">
        ${panel('By acquisition source', table(groupCols('Source'), group((m) => E.SOURCE_LABELS[m.source || 'unknown'])), { sub: 'As recorded by Skool or corrected here. Not ad-level attribution.' })}
        ${panel('By plan', table(groupCols('Plan'), group((m) => E.planLabel(c.settings, m))))}
      </div>`;
    },
  };

  /* ================================================================= ai == */

  const SUGGESTIONS = [
    'How much did we spend on ads last week?',
    'What happened to membership growth after we increased our advertising budget?',
    'How many members who joined last week are still on trial?',
    'Are we making more money than we are spending?',
    'Which ads appear to be underperforming?',
    'Should we consider reducing or increasing our advertising budget?',
    'How many people have churned this month?',
  ];

  function reportView(rep) {
    const d = (x) => (x == null ? '' : `${x >= 0 ? '+' : ''}${x.toFixed(0)}%`);
    return `<article class="gi-report" id="gi-report">
      <header><p class="eyebrow">Peps by Dave</p><h3>Weekly performance report</h3>
      <p class="sub">${dayFull(rep.range.from)} – ${dayFull(rep.range.to)} · compared with ${dayLabel(rep.previous.from)} – ${dayLabel(rep.previous.to)}</p></header>
      ${rep.demo ? '<p class="gi-demo"><strong>Demonstration data — not real business data.</strong></p>' : ''}
      <table class="gi-table"><thead><tr><th scope="col"></th><th scope="col" class="num">This week</th><th scope="col" class="num">Previous week</th><th scope="col" class="num">Change</th></tr></thead>
      <tbody>${rep.rows.map(([l, a, b, x]) => `<tr><th scope="row">${h(l)}</th><td class="num">${h(a)}</td><td class="num">${h(b)}</td><td class="num">${h(d(x))}</td></tr>`).join('')}</tbody></table>
      <h4>MRR</h4>
      <p>Gross MRR ${money(rep.mrr.gross)} (from ${money(rep.mrr.grossBefore)} at the start of the week) · Net MRR ${money(rep.mrr.net)} · New MRR ${money(rep.mrr.newMrr)} · Churned MRR ${money(rep.mrr.churnedMrr)}</p>
      <h4>This week's joining cohort</h4>
      <p>${int(rep.cohort.joined)} joined · ${int(rep.cohort.trials)} trials started · ${int(rep.cohort.converted)} of them verified paying · ${int(rep.cohort.directPaid)} paying with no trial · ${int(rep.cohort.nonConverted)} canceled or declined · ${int(rep.cohort.unresolved)} with no verified outcome · ${int(rep.cohort.active)} still on trial${rep.cohort.active ? ' (not final)' : ''}.</p>
      <h4>Ads, on the available evidence</h4>
      ${rep.ads.all.length ? `<p>Ranked by ${h(rep.ads.basis)} — Meta's own reporting, not verified member attribution.</p>
      <table class="gi-table"><thead><tr><th scope="col">Ad</th><th scope="col" class="num">Spend</th><th scope="col" class="num">Clicks</th><th scope="col" class="num">LP views</th><th scope="col" class="num">Meta conv.</th><th scope="col"></th></tr></thead><tbody>
      ${rep.ads.all.map((a) => `<tr><th scope="row">${h(a.name)}</th><td class="num">${money(a.spend, 2)}</td><td class="num">${int(a.clicks)}</td><td class="num">${int(a.lpv)}</td><td class="num">${int(a.conv)}</td><td>${rep.ads.best && a.id === rep.ads.best.id ? 'Best' : rep.ads.worst && a.id === rep.ads.worst.id ? 'Weakest' : ''}</td></tr>`).join('')}</tbody></table>` : '<p>No ad delivered this week.</p>'}
      <h4>Advertising against member growth</h4>${insightList(rep.insights)}
      <h4>Recommendations</h4><ul>${rep.recommendations.map((r) => `<li>${h(r)}</li>`).join('')}</ul>
      ${rep.quality.length ? `<h4>Data quality</h4><ul class="gi-fine">${rep.quality.map((q) => `<li>${h(q.message)}</li>`).join('')}</ul>` : ''}
      <p class="gi-fine">Membership figures cover the whole community and are compared with advertising; no member is attributed to a specific ad. Generated ${h(new Date().toLocaleString())}.</p>
    </article>`;
  }

  const ai = {
    html() {
      const c = S.ctx; const a = S.ai;
      const mail = a.email;
      return `
      <div class="gi-pagehead"><h3>AI Insights</h3><p class="sub">An analyst that reads the same figures you do. It is given only the dashboard's own data, already labelled as verified, estimated or unresolved.</p></div>
      ${panel('Ask a question', `
        <form data-form="ai-ask" class="gi-ask"><label class="sr-only" for="gi-ask-q">Your question</label>
          <input type="text" id="gi-ask-q" name="q" maxlength="600" placeholder="e.g. How many members joined while the Carousel ad was running?" ${a.asking ? 'disabled' : ''}>
          <button type="submit" class="btn btn-primary gi-btn-sm" ${a.asking ? 'aria-disabled="true"' : ''}>${a.asking ? 'Thinking…' : 'Ask'}</button>
        </form>
        <div class="gi-chips" aria-label="Suggested questions">${SUGGESTIONS.map((q) => `<button type="button" class="gi-chip" data-act="ai-suggest" data-q="${h(q)}">${h(q)}</button>`).join('')}</div>
        <p class="gi-actions"><button type="button" class="btn btn-ghost gi-btn-sm" data-act="ai-briefing">Write this week's briefing</button></p>
        ${a.log.length ? a.log.slice().reverse().map((x) => `<article class="gi-answer">
            <p class="gi-q">${h(x.question)}</p>
            ${x.error ? `<p class="notice notice-error">${h(x.error)}</p>` : `
              ${x.answer.answer.split(/\n\s*\n/).map((p) => `<p>${h(p)}</p>`).join('')}
              ${x.answer.basis.length ? `<h4 class="gi-h4">What that rests on</h4>${insightList(x.answer.basis)}` : ''}
              <p class="gi-fine">Confidence: ${h(x.answer.confidence)}${x.model ? ` · ${h(x.model)}` : ''} · ${h(new Date(x.at).toLocaleTimeString())}</p>`}
          </article>`).join('') : '<p class="gi-fine">Answers appear here. Each one lists what it rests on, classified as a verified fact, an estimate, a forecast, a correlation or missing information.</p>'}`,
      { sub: 'Needs an Anthropic API key on the deployment. Each question sends a summary of the figures on screen — no member names or emails.' })}
      ${panel('Automated insights', insightList(E.insights(c)), { sub: 'Computed by fixed rules from the data, with no model involved. Always available.' })}
      ${panel('Weekly report', `
        <p class="gi-actions">
          <button type="button" class="btn btn-primary gi-btn-sm" data-act="report-make">${a.report ? 'Regenerate' : 'Generate'} last week's report</button>
          ${a.report ? '<button type="button" class="btn btn-ghost gi-btn-sm" data-act="report-print">Print or save as PDF</button>' : ''}
        </p>
        <form data-form="report-email" class="gi-search">
          <label class="sr-only" for="gi-mail-to">Send to</label>
          <input type="text" id="gi-mail-to" name="to" inputmode="email" placeholder="name@example.com" value="${h(c.settings.reportEmail || (mail && mail.defaultTo) || '')}">
          <button type="submit" class="btn btn-ghost gi-btn-sm" ${S.demo ? 'aria-disabled="true"' : ''}>Email it now</button>
        </form>
        <p class="gi-fine">${S.demo ? 'Email is switched off while demonstration data is on screen — it would send the real figures, not these.' : mail ? (mail.configured ? `Email delivery is connected (from ${h(mail.from)}). A report is also sent automatically every Monday to the address in Settings.` : 'Email delivery is not connected yet. It needs a Resend account: set <code>RESEND_API_KEY</code> and a verified sender in <code>GROWTH_REPORT_FROM</code> on the deployment. Printing to PDF works without it.') : 'Checking email delivery…'}</p>
        ${a.mailResult ? `<p class="notice ${a.mailResult.ok ? 'notice-info' : 'notice-warn'}">${h(a.mailResult.text)}</p>` : ''}
        ${a.report ? reportView(a.report) : ''}`,
      { sub: 'Monday to Sunday, against the week before.' })}`;
    },
    after() {
      if (S.ai.email || S.demo || S.ai.emailAsked) return;
      S.ai.emailAsked = true;
      api('/api/growth-report').then((j) => { S.ai.email = j.email; if (S.page === 'ai') render(); }).catch(() => { S.ai.email = { configured: false }; });
    },
  };

  async function ask(question, briefing) {
    if (S.ai.asking) return;
    S.ai.asking = true; render();
    const entry = { question: briefing ? 'This week\'s briefing' : question, at: Date.now() };
    try {
      const j = await api('/api/growth-ai', { method: 'POST', body: { question, briefing: !!briefing, digest: E.buildDigest(S.ctx) } });
      entry.answer = j.answer; entry.model = j.model;
    } catch (e) { entry.error = e.message; }
    S.ai.log.push(entry);
    S.ai.asking = false; render();
  }

  /* ============================================================= report == */

  const VERDICT = {
    profitable: ['Profitable', 'is-good'], breakeven: ['About break-even', 'is-mid'],
    unprofitable: ['Not profitable', 'is-bad'], unclear: ['Not yet clear', 'is-mid'],
  };

  function reportState() {
    if (!S.report) {
      const today = S.ctx.today;
      S.report = { from: E.addDays(today, -7), to: E.addDays(today, -1), busy: false, error: '', result: null };
    }
    return S.report;
  }

  /** The period's figures, straight from the engine — the model never supplies a number in this table. */
  function reportFigures(from, to) {
    const o = E.overview(S.ctx, from, to);
    const a = o.cur.activity; const b = o.prev.activity; const co = o.cur.cohort; const p = o.profitability;
    const m = (v) => money(v, 2); const n = (v) => int(v);
    const row = (label, cur, prev, fmt, invert) => ({ label, cur: fmt(cur), prev: prev === undefined ? '' : fmt(prev), change: prev === undefined ? null : E.pctChange(cur, prev), invert });
    return {
      previous: o.previous,
      groups: [
        ['Advertising', [
          row('Ad spend', a.spend, b.spend, m, true), row('Average daily spend', a.spend / o.cur.days, b.spend / o.cur.days, m, true),
          row('Clicks', a.clicks, b.clicks, n), row('Cost per click', a.cpc, b.cpc, m, true),
          row('Landing-page views', a.lpv, b.lpv, n), row('Cost per landing-page view', a.costPerLpv, b.costPerLpv, m, true),
          row('Meta-reported conversions', a.metaConv, b.metaConv, n),
        ]],
        ['Sign-ups and trials', [
          row('New member sign-ups', a.joins, b.joins, n), row('Free trials started', a.trialStarts, b.trialStarts, n),
          row('Trial-to-paid conversions', a.conversions, b.conversions, n), row('New paying, no trial', a.directPaid, b.directPaid, n),
          row('Net member growth', a.net, b.net, n),
        ]],
        ['Cancellations and churn', [
          row('Trial cancellations', a.trialCancels, b.trialCancels, n, true),
          row('Cancellations requested (still members)', a.cancelRequests, b.cancelRequests, n, true),
          row('Paid members churned (left)', a.churn, b.churn, n, true),
          row('Went missing (unverified)', a.missing, b.missing, n, true), row('Returning members', a.returns, b.returns, n),
        ]],
        ['Money', [
          row('Revenue collected', a.revenue, b.revenue, m), row('Fees', a.fees, b.fees, m, true),
          row('Other expenses', a.otherExpenses, b.otherExpenses, m, true), row('Net cash contribution', a.netCash, b.netCash, m),
          row('Gross MRR now', o.mrr.gross, o.mrr.grossBefore, m), row('MRR scheduled to end (canceling)', o.mrr.canceling.gross, undefined, m),
        ]],
        ['Acquisition — blended, not per ad', [
          row('Spend ÷ trial started', co.blendedCostPerTrial, undefined, m), row('Spend ÷ new paying member', co.blendedCac, undefined, m),
          row('Estimated lifetime margin per paying member', p.estimatedLtv, undefined, m),
        ]],
      ],
      stillOnTrial: co.active,
    };
  }

  function reportArticle(res) {
    const r = res.report; const f = res.figures;
    const [word, cls] = VERDICT[r.verdict] || VERDICT.unclear;
    const chg = (x) => (x.change == null ? '' : `<span class="gi-delta ${Math.abs(x.change) < 0.5 ? '' : (x.change > 0) !== !!x.invert ? 'is-up' : 'is-down'}">${Math.abs(x.change) < 0.5 ? 'no change' : `${x.change > 0 ? '▲' : '▼'} ${Math.abs(x.change).toFixed(0)}%`}</span>`);
    const paras = (text) => String(text).split(/\n\s*\n/).map((p) => `<p>${h(p)}</p>`).join('');
    return `<article class="gi-report" id="gi-report">
      <header>
        <p class="eyebrow">Peps by Dave · Growth report</p>
        <h3>${dayFull(res.from)} – ${dayFull(res.to)}</h3>
        <p class="sub">${E.diffDays(res.from, res.to) + 1} days, compared with ${dayFull(f.previous.from)} – ${dayFull(f.previous.to)}</p>
      </header>
      ${res.demo ? '<p class="gi-demo"><strong>Demonstration data — not real business data.</strong></p>' : ''}
      <p class="gi-verdict ${cls}"><span class="gi-verdict-word">${h(word)}</span> ${h(r.headline)}</p>
      <div class="gi-report-summary">${paras(r.summary)}</div>

      <h4>The figures</h4>
      <p class="gi-fine">Computed by the dashboard from your Skool imports and Meta's reporting. The written analysis below was generated from these same figures.</p>
      <table class="gi-table"><thead><tr><th scope="col"></th><th scope="col" class="num">This period</th><th scope="col" class="num">Previous period</th><th scope="col" class="num">Change</th></tr></thead>
      ${f.groups.map(([title, rows]) => `<tbody><tr class="gi-grouprow"><th scope="colgroup" colspan="4">${h(title)}</th></tr>${rows.map((x) => `<tr><th scope="row">${h(x.label)}</th><td class="num">${x.cur}</td><td class="num">${x.prev}</td><td class="num">${chg(x)}</td></tr>`).join('')}</tbody>`).join('')}</table>
      ${f.stillOnTrial ? `<p class="gi-fine">${int(f.stillOnTrial)} trial${f.stillOnTrial === 1 ? '' : 's'} started in this period ${f.stillOnTrial === 1 ? 'is' : 'are'} still running, so its acquisition cost is not final.</p>` : ''}

      ${r.sections.map((s) => `<section><h4>${h(s.heading)}</h4>${paras(s.body)}</section>`).join('')}

      ${r.recommendations.length ? `<h4>What to change</h4><ol class="gi-recs">${r.recommendations.map((x) => `<li><p><strong>${h(x.action)}</strong> ${tag(x.priority + ' priority', x.priority === 'high' ? 'is-win' : x.priority === 'medium' ? 'is-est' : '')}</p>${x.reason ? `<p class="gi-rec-why">${h(x.reason)}</p>` : ''}</li>`).join('')}</ol>` : ''}
      ${r.caveats.length ? `<h4>What limits these conclusions</h4><ul class="gi-fine">${r.caveats.map((c) => `<li>${h(c)}</li>`).join('')}</ul>` : ''}
      <p class="gi-fine">Written by ${h(res.model || 'the AI analyst')} on ${h(new Date(res.at).toLocaleString())} from the dashboard's figures. Membership is compared with advertising for the whole community; no member is attributed to a specific ad. Dates of payments and conversions may be estimates — see the Overview's data-quality notes.</p>
    </article>`;
  }

  const report = {
    html() {
      const c = S.ctx; const r = reportState();
      const quick = (label, from, to) => `<button type="button" class="gi-chip" data-act="report-range" data-from="${from}" data-to="${to}" aria-pressed="${r.from === from && r.to === to}">${label}</button>`;
      const y = E.addDays(c.today, -1);
      const wk = E.lastCompleteWeek(c.today);
      return `
      <div class="gi-pagehead"><h3>Report</h3><p class="sub">One written report for any time frame: how the ads performed, what the community did over the same days — sign-ups, cancellations and churn — whether that was profitable, and what to change.</p></div>
      ${panel('Choose a time frame', `
        <form data-form="report-make" class="gi-reportform">
          <label>From <input type="date" name="from" value="${h(r.from)}" max="${h(c.today)}" required data-change="report-date"></label>
          <label>To <input type="date" name="to" value="${h(r.to)}" max="${h(c.today)}" required data-change="report-date"></label>
          <button type="submit" class="btn btn-primary" ${r.busy ? 'aria-disabled="true"' : ''}>${r.busy ? 'Generating…' : 'Generate'}</button>
        </form>
        <div class="gi-chips" aria-label="Quick time frames">
          ${quick('Past 7 days', E.addDays(c.today, -7), y)}${quick('Last week (Mon–Sun)', wk.from, wk.to)}${quick('Past 14 days', E.addDays(c.today, -14), y)}${quick('Past 30 days', E.addDays(c.today, -30), y)}${quick('Past 90 days', E.addDays(c.today, -90), y)}
        </div>
        <p class="gi-fine">${E.isDay(r.from) && E.isDay(r.to) && r.from <= r.to ? `${E.diffDays(r.from, r.to) + 1} days, compared with the ${E.diffDays(r.from, r.to) + 1} days before.` : 'Choose a start date on or before the end date.'} The report is written by the AI analyst from the dashboard's own figures for that period — it sees totals and per-ad numbers, never member names. It needs the Anthropic API key on the deployment and takes up to a minute.</p>
        ${r.busy ? '<p class="notice notice-info" role="status">Writing the report. This usually takes 20 to 60 seconds — keep this tab open.</p>' : ''}
        ${r.error ? `<p class="notice notice-error" role="alert">${h(r.error)}</p>` : ''}`)}
      ${r.result ? panel('Report', `
        <p class="gi-actions"><button type="button" class="btn btn-ghost gi-btn-sm" data-act="report-print">Print or save as PDF</button></p>
        ${reportArticle(r.result)}`, { sub: `Generated ${h(new Date(r.result.at).toLocaleString())}. Generating again replaces it; nothing is stored.` }) : ''}`;
    },
  };

  async function makeReport() {
    const r = reportState();
    if (r.busy) return;
    const today = S.ctx.today;
    if (!E.isDay(r.from) || !E.isDay(r.to) || r.from > r.to) { r.error = 'Choose a start date on or before the end date.'; render(); return; }
    if (r.to > today) { r.error = 'The time frame cannot end in the future.'; render(); return; }
    if (E.diffDays(r.from, r.to) > 366) { r.error = 'Choose a time frame of a year or less.'; render(); return; }
    const from = r.from; const to = r.to;
    r.busy = true; r.error = ''; render();
    try {
      const figures = reportFigures(from, to);
      const j = await api('/api/growth-ai', { method: 'POST', body: { report: true, digest: E.buildReportDigest(S.ctx, from, to) } });
      if (!j.report) r.error = j.message || 'There is nothing to report on yet.';
      else r.result = { report: j.report, model: j.model, at: j.generatedAt || new Date().toISOString(), from, to, figures, demo: S.demo };
    } catch (e) {
      // A failed attempt never replaces a report already on screen.
      r.error = e.status === 0 || e.status === 504 ? 'The report took too long or the connection dropped. Try again, or choose a shorter time frame.' : e.message;
    }
    r.busy = false; render();
  }

  /* ============================================================== recon == */

  function buildCandidate(d) {
    return {
      id: 'pending', kind: d.kind, observedAt: d.observedAt, rows: d.rows.filter((r) => !r.removed), decisions: d.decisions,
      mapping: d.mapping || {}, filename: d.filename || null, label: d.label, context: d.context || null, hash: d.hash, raw: d.raw,
    };
  }
  function refreshPreview() {
    const d = S.recon.draft;
    if (!d || !d.rows.some((r) => !r.removed)) { S.recon.preview = null; return; }
    S.recon.preview = E.previewImport(S.db, liveImports(), buildCandidate(d), { today: S.ctx.today });
  }
  function remapCsv() {
    const d = S.recon.draft;
    const out = E.normaliseCsvRows(d.parsed, d.mapping, S.ctx.settings);
    d.rows = out.rows; d.issues = out.issues;
    refreshPreview();
  }

  function decisionSelect(k, candidates, current) {
    return `<select data-change="recon-decide" data-k="${h(k)}" aria-label="Who is this?">
      <option value=""${!current ? ' selected' : ''}>Decide…</option>
      ${candidates.map((m) => `<option value="${h(m.id)}"${current === m.id ? ' selected' : ''}>Same person as ${h(m.name)} — ${h(m.handle ? '@' + m.handle : m.email || 'no identifier')}, joined ${h(dayLabel(m.joinDay, true))}</option>`).join('')}
      <option value="new"${current === 'new' ? ' selected' : ''}>A different person — add as new</option>
    </select>`;
  }

  function previewBlock() {
    const d = S.recon.draft; const p = S.recon.preview;
    if (!p) return '<p class="gi-empty">Nothing usable to import yet.</p>';
    const undecided = p.uncertain.filter((u) => !d.decisions[u.k]);
    const list = (title, items, row, open) => (items.length ? `<details class="gi-diff"${open ? ' open' : ''}><summary>${h(title)} <b>${int(items.length)}</b></summary><ul>${items.slice(0, 60).map((x) => `<li>${row(x)}</li>`).join('')}${items.length > 60 ? `<li class="gi-dim">…and ${int(items.length - 60)} more</li>` : ''}</ul></details>` : '');
    const ev = (x) => `${h(x.member.name)} <small>${ident(x.member)}</small>`;
    return `
      ${p.notes.map((n) => `<div class="notice ${n.level === 'warn' ? 'notice-warn' : 'notice-info'}"><span>${h(n.message)}</span></div>`).join('')}
      ${tiles([
        { label: 'Matched to existing members', value: int(p.matched) },
        { label: 'New members', value: int(p.newMembers.length) },
        { label: 'Missing from this export', value: int(p.missing.length), note: p.missing.length ? 'Marked “status unverified”, never canceled.' : '' },
        { label: 'Returning members', value: int(p.returning.length) },
        { label: 'Changed membership prices', value: int(p.priceChanges.length) },
        { label: 'Changed recorded LTV', value: int(p.ltvChanges.length) },
        { label: 'Updated trial statuses', value: int(p.trialUpdates.length) },
        { label: 'Now canceling — still members', value: int(p.canceling.length), note: p.canceling.length ? 'Not counted as churn.' : '' },
        { label: 'Churned — left the community', value: int(p.churned.length) },
        { label: 'Trial cancellations', value: int(p.cancellations.length) },
        { label: 'Possible duplicate accounts', value: int(p.uncertain.length), note: undecided.length ? `${int(undecided.length)} need a decision` : '' },
      ])}
      ${p.uncertain.length ? `<div class="gi-decide"><h4 class="gi-h4">Needs your decision</h4>
        <p class="sub">These share a name with an existing member and have no username or email in common. Identical names are never assumed to be the same account.</p>
        ${table([
          { label: 'In this import', cell: (u) => { const r = d.rows.find((x) => x.k === u.k) || {}; return `${h(u.name)}<br><small>${h(r.handle ? '@' + r.handle : r.email || 'no identifier')}${r.joinDay ? ' · joined ' + h(dayLabel(r.joinDay, true)) : ''}</small>`; } },
          { label: 'Who is this?', cell: (u) => decisionSelect(u.k, u.candidates, d.decisions[u.k]) },
        ], p.uncertain)}</div>` : ''}
      ${list('Matched by name and join date', p.nameMatched, (x) => `${h(x.name)} → ${h(x.member.name)} <small>${ident(x.member)}, joined ${h(dayLabel(x.member.joinDay, true))}</small> <button type="button" class="gi-link" data-act="recon-split" data-k="${h(x.k)}">Not the same person</button>`)}
      ${list('New members', p.newMembers, (m) => `${h(m.name)} <small>${ident(m)}${m.joinDay ? ' · joined ' + h(dayLabel(m.joinDay, true)) : ''} · ${h(E.planLabel(S.ctx.settings, m))}</small>`)}
      ${list('Missing from this export — status unverified', p.missing, (x) => `${ev(x)} <small>last listed ${h(dayLabel(x.event.window.from, true))}</small>`, true)}
      ${list('Returning members', p.returning, (x) => `${ev(x)} ${precisionTag(x.event.precision, x.event.window)}`)}
      ${list('Changed membership prices', p.priceChanges, (x) => `${ev(x)} — ${money(x.event.data.from, 2)} → ${money(x.event.data.to, 2)}`)}
      ${list('Changed recorded LTV', p.ltvChanges, (x) => `${ev(x)} — ${x.event.type === 'refund_observed' ? '−' : '+'}${money(x.event.data.amount, 2)} <small>now ${money(x.event.data.ltv, 2)}</small>`)}
      ${list('Updated trial statuses', p.trialUpdates, (x) => `${ev(x)} — ${h(E.EVENT_LABEL[x.event.type])} ${x.event.precision === 'window' ? '' : h(dayLabel(x.event.day, true))} ${precisionTag(x.event.precision, x.event.window)}`)}
      ${list('Now canceling — still members', p.canceling, (x) => `${ev(x)} — requested ${x.event.precision === 'window' ? '' : h(dayLabel(x.event.day, true))} ${precisionTag(x.event.precision, x.event.window)}${x.event.data && x.event.data.endsOn ? ` · access ends ${h(dayLabel(x.event.data.endsOn, true))}` : ''}`, true)}
      ${list('Churned — left the community', p.churned, (x) => `${ev(x)} — ${x.event.precision === 'window' ? '' : h(dayLabel(x.event.day, true))} ${precisionTag(x.event.precision, x.event.window)}${x.member.d.paidEvidence ? '' : ' <small>never paid: recorded as a trial that did not convert</small>'}`, true)}
      ${list('Trial cancellations', p.cancellations, (x) => `${ev(x)} — ${h(E.EVENT_LABEL[x.event.type])} ${x.event.precision === 'window' ? '' : h(dayLabel(x.event.day, true))} ${precisionTag(x.event.precision, x.event.window)}`)}
      ${list('Members whose status changes', p.statusChanges, (x) => `${h(x.member.name)} — ${h(x.from)} → <strong>${h(x.to)}</strong>`)}
      <p class="gi-actions">
        <button type="button" class="btn btn-primary" data-act="recon-save" ${undecided.length || S.recon.saving ? 'aria-disabled="true"' : ''}>${S.recon.saving ? 'Saving and confirming…' : 'Confirm and save'}</button>
        <button type="button" class="btn btn-ghost" data-act="recon-discard">Discard</button>
        ${undecided.length ? `<span class="gi-fine">Decide the ${int(undecided.length)} uncertain match${undecided.length === 1 ? '' : 'es'} first.</span>` : `<span class="gi-fine">${int(p.totals.before)} members on record now → ${int(p.totals.after)} after this import. Earlier history is kept either way.</span>`}
      </p>`;
  }

  function csvDraftView() {
    const d = S.recon.draft;
    const sample = d.parsed.rows.slice(0, 3);
    return `
      <p><strong>${h(d.filename)}</strong> — ${int(d.parsed.rows.length)} rows, ${int(d.parsed.headers.length)} columns.</p>
      <label class="gi-inline">Exported on <input type="datetime-local" value="${h(d.observedLocal)}" data-change="recon-when"></label>
      <p class="gi-fine">This is the moment the export describes. It decides where the file sits in history, so set it to when you downloaded it from Skool — not when you uploaded it here.</p>
      <h4 class="gi-h4">Columns</h4>
      <p class="sub">Detected automatically. Correct any that are wrong; leave a field on “Not in this file” if the export does not carry it.</p>
      <div class="gi-map">${E.CSV_FIELDS.map(([f, label]) => `<label><span>${h(label)}</span><select data-change="recon-map" data-field="${f}"><option value="">Not in this file</option>${d.parsed.headers.map((hd, i) => `<option value="${i}"${d.mapping[f] === i ? ' selected' : ''}>${h(hd || `Column ${i + 1}`)}</option>`).join('')}</select></label>`).join('')}</div>
      <details class="alt"><summary>First rows of the file</summary>${table(d.parsed.headers.map((hd, i) => ({ label: hd || `Column ${i + 1}`, cell: (r) => h(r[i] ?? '') })), sample)}</details>
      ${d.issues.length ? `<details class="gi-diff" open><summary>Rows with a problem <b>${int(d.issues.length)}</b></summary><ul>${d.issues.slice(0, 40).map((x) => `<li>Row ${int(x.row)}: ${h(x.message)}</li>`).join('')}</ul></details>` : ''}
      <h4 class="gi-h4">Compared with what is already on record</h4>
      ${previewBlock()}`;
  }

  function pasteDraftView() {
    const d = S.recon.draft;
    const cell = (r, f, type = 'text', w = '') => `<input type="${type}" value="${h(r[f] == null ? '' : r[f])}" data-change="paste-edit" data-k="${h(r.k)}" data-field="${f}" aria-label="${h(f)}" class="gi-cell ${w}${r.approx && r.approx[f] ? ' is-approx' : ''}"${r.approx && r.approx[f] ? ' title="Worked out from a relative or yearless date — check it"' : ''}>`;
    const rows = d.rows.filter((r) => !r.removed);
    return `
      <label class="gi-inline">Copied from Skool on <input type="datetime-local" value="${h(d.observedLocal)}" data-change="recon-when"></label>
      <h4 class="gi-h4">Review what was read — ${int(rows.length)} member${rows.length === 1 ? '' : 's'}</h4>
      <p class="sub">Every field can be corrected. Highlighted dates were worked out from a relative phrase (“in 3 days”) or had no year. The original text is kept with the import for audit.</p>
      ${table([
        { label: 'Name', cell: (r) => cell(r, 'name') },
        { label: 'Username', cell: (r) => cell(r, 'handle', 'text', 'is-mid') },
        { label: 'Status', cell: (r) => `<select data-change="paste-edit" data-k="${h(r.k)}" data-field="status" aria-label="Status">${E.STATUSES.map(([k, l]) => `<option value="${k}"${r.status === k ? ' selected' : ''}>${h(l)}</option>`).join('')}</select>` },
        { label: 'Joined', cell: (r) => cell(r, 'joinDay', 'date') },
        { label: 'Trial started', cell: (r) => cell(r, 'trialStart', 'date') },
        { label: 'Trial ends', cell: (r) => cell(r, 'trialEnd', 'date') },
        { label: 'Canceled on', cell: (r) => cell(r, 'canceledAt', 'date') },
        { label: 'Access ends', cell: (r) => cell(r, 'endsAt', 'date') },
        { label: 'Left on', cell: (r) => cell(r, 'churnedAt', 'date') },
        { label: 'Price', cell: (r) => cell(r, 'price', 'number', 'is-narrow') },
        { label: 'Source', cell: (r) => `<select data-change="paste-edit" data-k="${h(r.k)}" data-field="source" aria-label="Source"><option value="">—</option>${E.SOURCES.map((s) => `<option value="${s}"${r.source === s ? ' selected' : ''}>${h(E.SOURCE_LABELS[s])}</option>`).join('')}</select>` },
        { label: '', cell: (r) => `<details class="gi-rawcell"><summary>Original</summary><pre>${h(r.raw)}</pre></details><button type="button" class="gi-link" data-act="paste-remove" data-k="${h(r.k)}">Remove</button>` },
      ], rows, { empty: 'No member records could be read from that text.' })}
      <h4 class="gi-h4">Compared with what is already on record</h4>
      ${previewBlock()}`;
  }

  /* ------------------------------------------------------------ slots -- */

  const PLACEHOLDER = {
    active_trial: 'Jane Doe&#10;@jane-doe-1234&#10;Free trial ends in 5 days&#10;Joined Oct 3, 2026&#10;$19/month',
    canceling: 'John Smith&#10;@john-smith-88&#10;Canceled Oct 1, 2026&#10;Access ends Oct 20, 2026',
    churned: 'Ana Ruiz&#10;@ana-ruiz-2&#10;Churned Sep 28, 2026',
  };
  const HELP = {
    csv: 'The member export from Skool. This is the base everything else is matched against.',
    active_trial: 'Select the members in Skool’s active-trial list, copy, and paste.',
    canceling: 'People who have canceled but have not left yet. Everyone here is treated as canceling and stays counted as a member.',
    churned: 'People who have actually left. Everyone here is treated as churned.',
  };

  const occupants = (key) => (S.db.imports || []).filter((i) => E.slotOf(i) === key)
    .sort((x, y) => String(y.createdAt || y.observedAt).localeCompare(String(x.createdAt || x.observedAt)));
  const draftSlot = () => (S.recon.draft ? (S.recon.draft.kind === 'csv' ? 'csv' : S.recon.draft.context) : null);
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const CHECK = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-8.2"/></svg>';

  function uploadedFile(i) {
    return `<div class="gi-upfile${i.reverted ? ' is-off' : ''}">
      <span class="gi-upfile-ico">${CHECK}</span>
      <div class="gi-upfile-body">
        <p class="gi-upfile-name">${h(i.filename || i.label || 'Pasted list')}</p>
        <p class="gi-upfile-meta">${int(i.rowCount)} ${i.kind === 'csv' ? 'rows' : `member${i.rowCount === 1 ? '' : 's'}`} · describes ${h(when(i.observedAt))} · saved ${h(when(i.createdAt))}</p>
        <p class="gi-upfile-ok">${i.reverted ? 'Reversed — stored, but not counted in any figure' : 'Saved and confirmed in storage'}${i.recovered ? ' · restored after a failed save' : ''}</p>
        <p class="gi-upfile-actions">
          <button type="button" class="gi-link" data-act="import-raw" data-id="${h(i.id)}">View original</button>
          ${S.recon.removing === i.id
            ? `<span class="gi-confirm">Delete this upload for good? <button type="button" class="gi-link is-danger" data-act="import-remove-yes" data-id="${h(i.id)}">Yes, remove it</button> <button type="button" class="gi-link" data-act="import-remove-no">Keep</button></span>`
            : `<button type="button" class="gi-link is-danger" data-act="import-remove" data-id="${h(i.id)}">Remove</button>`}
        </p>
      </div>
    </div>`;
  }

  function slotCard(slot, n) {
    const occ = occupants(slot.key);
    const reviewing = draftSlot() === slot.key;
    const state = occ.length ? 'filled' : reviewing ? 'review' : 'empty';
    const pill = { filled: `<span class="gi-pill is-done">${CHECK} Uploaded</span>`, review: '<span class="gi-pill is-review">In review</span>', empty: '<span class="gi-pill">Not uploaded</span>' }[state];
    let body;
    if (occ.length) {
      body = occ.map(uploadedFile).join('') +
        `<p class="gi-slot-note">${occ.length > 1 ? `This list holds ${occ.length} uploads from before the one-at-a-time rule. Remove them all to upload again.` : `Remove this upload to add a new ${h(slot.noun)}.`}</p>`;
    } else if (reviewing) {
      body = '<p class="gi-slot-wait">Open for review below. <strong>Nothing is saved yet</strong> — check it, then press Confirm and save.</p><p><button type="button" class="gi-link" data-act="recon-discard">Discard this upload</button></p>';
    } else if (S.recon.draft) {
      body = '<p class="gi-slot-wait">Finish or discard the upload being reviewed below first.</p>';
    } else if (slot.key === 'csv') {
      body = `<label class="gi-dropzone" data-dropzone="csv">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>
          <span class="gi-dropzone-main">Drop the CSV here</span>
          <span class="gi-dropzone-sub">or <u>choose a file</u> · .csv, up to 3 MB</span>
          <input type="file" accept=".csv,text/csv" data-change="recon-file" class="sr-only">
        </label>`;
    } else {
      body = `<form data-form="recon-paste" data-context="${slot.key}" class="gi-pasteform">
          <label class="sr-only" for="gi-paste-${slot.key}">${h(slot.title)}, pasted from Skool</label>
          <textarea id="gi-paste-${slot.key}" name="text" rows="5" placeholder="${PLACEHOLDER[slot.key]}"></textarea>
          <button type="submit" class="btn btn-ghost gi-btn-sm">Review before saving</button>
        </form>`;
    }
    return `<section class="gi-slot is-${state}" aria-labelledby="gi-slot-${slot.key}">
      <header class="gi-slot-head">
        <span class="gi-slot-n" aria-hidden="true">${n + 1}</span>
        <div><p class="gi-card-kicker">${h(slot.kicker)}</p><h4 id="gi-slot-${slot.key}">${h(slot.title)}</h4></div>
        ${pill}
      </header>
      ${occ.length ? '' : `<p class="gi-slot-help">${h(HELP[slot.key])}</p>`}
      <div class="gi-slot-body">${body}</div>
    </section>`;
  }

  function slotsView() {
    const filled = E.SLOTS.filter((x) => occupants(x.key).length).length;
    return `<div class="gi-slots-progress" role="status">
        <p><strong>${filled} of 4</strong> uploaded${filled === 4 ? ' — everything is in.' : ''}</p>
        <div class="gi-meter" aria-hidden="true"><span style="width:${filled * 25}%"></span></div>
      </div>
      <div class="gi-slots">${E.SLOTS.map(slotCard).join('')}</div>`;
  }

  /** The proof that an upload went in. Stays on screen until dismissed. */
  function receiptView() {
    const r = S.recon.receipt;
    if (!r) return '';
    return `<div class="gi-receipt" role="status" aria-live="polite">
      <span class="gi-receipt-ico">${CHECK}</span>
      <div>
        <p class="gi-receipt-title">Upload successful — saved and confirmed</p>
        <p><strong>${h(r.label)}</strong>${r.filename ? ` · ${h(r.filename)}` : ''} · ${int(r.rows)} ${r.rows === 1 ? 'row' : 'rows'}</p>
        <p class="gi-receipt-fine">${r.demo
          ? 'Demonstration mode: held in this browser tab only, not sent to the server.'
          : `Stored at ${h(new Date(r.savedAt).toLocaleTimeString())}, read back from storage by the server, then found again in the list by a second, separate check. It will still be here after a refresh. Reference ${h(r.id)}.`}</p>
      </div>
      <button type="button" class="gi-link" data-act="receipt-dismiss">Dismiss</button>
    </div>`;
  }

  function importHistory() {
    const rows = (S.db.imports || []).slice().sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
    return table([
      { label: 'Describes', cell: (i) => h(new Date(i.observedAt).toLocaleString()) },
      { label: 'Import', cell: (i) => `${h(i.label || (i.kind === 'csv' ? 'Skool CSV export' : 'Pasted list'))}${i.filename ? `<br><small>${h(i.filename)}</small>` : ''}${i.recovered ? `<br>${tag('restored after a failed save', 'is-est')}` : ''}` },
      { label: 'List', cell: (i) => { const sl = E.SLOTS.find((x) => x.key === E.slotOf(i)); return sl ? h(sl.title) : '<small>Older combined list</small>'; } },
      { label: 'Rows', num: true, cell: (i) => int(i.rowCount) },
      { label: 'Saved', cell: (i) => h(when(i.createdAt)) },
      { label: 'State', cell: (i) => (i.reverted ? tag('reversed', 'is-win') + ` <small>${h(new Date(i.reverted.at).toLocaleDateString())}</small>` : tag('in use', 'is-ok')) },
      { label: '', cell: (i) => `
        <button type="button" class="gi-link" data-act="import-raw" data-id="${h(i.id)}">View original</button>
        ${i.reverted ? `<button type="button" class="gi-link" data-act="import-restore" data-id="${h(i.id)}">Restore</button>`
          : S.recon.confirm === i.id ? `<button type="button" class="gi-link is-danger" data-act="import-revert-yes" data-id="${h(i.id)}">Confirm reverse</button> <button type="button" class="gi-link" data-act="import-revert-no">Keep</button>`
            : `<button type="button" class="gi-link" data-act="import-revert" data-id="${h(i.id)}">Reverse</button>`}
        ${S.recon.removing === i.id
          ? `<span class="gi-confirm">Delete this import for good? <button type="button" class="gi-link is-danger" data-act="import-remove-yes" data-id="${h(i.id)}">Yes, remove it</button> <button type="button" class="gi-link" data-act="import-remove-no">Keep</button></span>`
          : `<button type="button" class="gi-link is-danger" data-act="import-remove" data-id="${h(i.id)}">Remove</button>`}` },
    ], rows, { empty: 'Nothing has been imported yet.', caption: 'Reverse takes an import out of every figure but keeps it on file, and it can be restored. Remove deletes that one import permanently — its rows, its original text and its effect on every figure — and cannot be undone.' });
  }

  const recon = {
    html() {
      const c = S.ctx; const r = S.recon;
      const dupes = c.members.filter((m) => m.possibleDuplicateOf && m.possibleDuplicateOf.length);
      return `
      <div class="gi-pagehead"><h3>Data Reconciliation</h3><p class="sub">Where membership data comes in. Each upload is reviewed before it is saved, confirmed once it is, and stays in use until you remove it.</p></div>
      ${receiptView()}
      ${panel('Uploads', slotsView(), { cls: 'gi-uploads', sub: 'Four lists, one upload each. An upload is only marked Uploaded once it has been saved and read back from storage. To replace one, remove it first.' })}
      ${r.draft ? panel(r.draft.kind === 'csv' ? 'Review this CSV before saving' : 'Review this pasted list before saving', r.draft.kind === 'csv' ? csvDraftView() : pasteDraftView(), { id: 'gi-draft' }) : ''}
      ${panel('Import history', importHistory() + (r.showRaw ? `<div class="gi-raw"><p><strong>Original submission</strong> — ${h(r.showRaw.title)} <button type="button" class="gi-link" data-act="import-raw-close">Close</button></p><pre>${h(r.showRaw.text)}</pre></div>` : ''), { sub: `${int((S.db.imports || []).length)} upload${(S.db.imports || []).length === 1 ? '' : 's'} on record. ` + (c.lastCsv ? `Latest export on record: ${dayFull(c.lastCsv.day)}, ${int(c.lastCsv.rows)} rows.` : '') })}
      ${panel(`Possible duplicate accounts (${dupes.length})`, table([
        { label: 'Member', cell: who }, { label: 'Identifier', cell: ident }, { label: 'Joined', cell: (m) => dayLabel(m.joinDay, true) },
        { label: 'Shares a name with', cell: (m) => m.possibleDuplicateOf.map((id) => c.byId.get(id)).filter(Boolean).map((x) => `${who(x)} <small>${ident(x)}, joined ${h(dayLabel(x.joinDay, true))}</small>`).join('<br>') },
        { label: 'First seen in', cell: (m) => h(importName(m.firstImport)) },
      ], dupes, { empty: 'No unresolved duplicates.' }), { sub: 'Kept as separate people, because a shared name is not proof. To merge a pair, reverse the import that created the second record and re-import it, choosing the match.' })}
      ${panel('Audit trail', table([
        { label: 'When', cell: (a) => h(new Date(a.at).toLocaleString()) }, { label: 'Action', cell: (a) => h(a.action) }, { label: 'Detail', cell: (a) => h(a.detail || '') },
      ], (S.db.audit || []).slice(-40).reverse(), { empty: 'No changes recorded yet.' }))}`;
    },
  };

  /* =========================================================== settings == */

  const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney', 'UTC'];

  function draft() {
    if (!S.settingsDraft) S.settingsDraft = JSON.parse(JSON.stringify(E.withDefaults(S.db.settings)));
    return S.settingsDraft;
  }

  const settings = {
    html() {
      const s = draft();
      const dirty = JSON.stringify(s) !== JSON.stringify(E.withDefaults(S.db.settings));
      const num = (path, value, step = '1', extra = '') => `<input type="number" step="${step}" min="0" value="${h(value)}" data-change="set" data-path="${path}" ${extra}>`;
      const conn = S.metaConn || {};
      const mail = S.ai.email;
      const check = (ok, label, detail) => `<li class="${ok === true ? 'is-ok' : ok === false ? 'is-no' : 'is-unk'}"><strong>${h(label)}</strong> — ${ok === true ? 'connected' : ok === false ? 'not connected' : 'not checked'}<br><small>${detail}</small></li>`;
      return `
      <div class="gi-pagehead"><h3>Settings</h3><p class="sub">The assumptions every calculation uses. Changing one recalculates the whole history — nothing is baked in at import time.</p></div>
      ${panel('Business rules', `
        <div class="gi-setgrid">
          <label>Business timezone<select data-change="set" data-path="timezone">${[...new Set([s.timezone, ...TIMEZONES])].map((z) => `<option${z === s.timezone ? ' selected' : ''}>${h(z)}</option>`).join('')}</select><small>Which calendar day a join or payment falls on. Timestamps are stored in UTC.</small></label>
          <label>CSV timestamps with no zone are<select data-change="set" data-path="csvTimestamps"><option value="utc"${s.csvTimestamps === 'utc' ? ' selected' : ''}>UTC</option><option value="local"${s.csvTimestamps === 'local' ? ' selected' : ''}>Already in the business timezone</option></select><small>Skool exports in UTC.</small></label>
          <label>Free trial length (days)${num('trialDays', s.trialDays)}</label>
          <label>Trial offer began on<input type="date" value="${h(s.trialAppliesFrom || '')}" data-change="set" data-path="trialAppliesFrom"><small>The first full day the free trial was available. Members on a paid plan who joined before it are paying members who never had a trial, and are left out of every trial count and conversion rate.</small></label>
          <label>Grace before a payment is flagged overdue (days)${num('graceDays', s.graceDays)}</label>
          <label>Weekly report email<input type="text" inputmode="email" value="${h(s.reportEmail || '')}" data-change="set" data-path="reportEmail" placeholder="name@example.com"></label>
        </div>`)}
      ${panel('Subscription plans', `
        ${table([
          { label: 'Name', cell: (p, i) => `<input type="text" value="${h(p.label)}" data-change="set" data-path="plans.${i}.label" aria-label="Plan name">` },
          { label: 'Price', cell: (p, i) => num(`plans.${i}.price`, p.price, '0.01', 'aria-label="Price"') },
          { label: 'Billed', cell: (p, i) => `<select data-change="set" data-path="plans.${i}.interval" aria-label="Billing interval">${[['month', 'Monthly'], ['year', 'Annually'], ['once', 'Once'], ['none', 'Never (free)']].map(([k, l]) => `<option value="${k}"${p.interval === k ? ' selected' : ''}>${l}</option>`).join('')}</select>` },
          { label: 'Counts toward MRR as', num: true, cell: (p) => money(E.monthlyValue(p.price, p.interval), 2) + ' / mo' },
          { label: '', cell: (p, i) => `<button type="button" class="gi-link" data-act="set-remove" data-list="plans" data-i="${i}">Remove</button>` },
        ], s.plans)}
        <p class="gi-actions"><button type="button" class="btn btn-ghost gi-btn-sm" data-act="set-add" data-list="plans">Add a plan</button></p>`,
      { sub: 'Used to name a member\'s plan and to decide how a price with no stated interval is billed. An annual plan counts at a twelfth toward MRR and whole toward cash.' })}
      ${panel('Fees', `
        <div class="gi-setgrid">
          <label>Skool platform fee (%)${num('fees.platformPct', s.fees.platformPct, '0.1')}<small>2.9% on Skool Pro, 10% on Hobby. Check your plan.</small></label>
          <label>Payment processing fee (%)${num('fees.processingPct', s.fees.processingPct, '0.1')}<small>Only if charged on top of the platform fee.</small></label>
          <label>Fee per charge ($)${num('fees.perTransaction', s.fees.perTransaction, '0.01')}</label>
          <label>Skool network revenue share (%)${num('fees.networkSharePct', s.fees.networkSharePct, '0.1')}<small>Extra share on members whose source is the Skool network.</small></label>
        </div>`, { sub: 'Net MRR and net cash contribution are gross figures less these.' })}
      ${panel('Other business expenses', `
        ${table([
          { label: 'What', cell: (e, i) => `<input type="text" value="${h(e.label)}" data-change="set" data-path="expenses.${i}.label" aria-label="Expense name">` },
          { label: 'Amount', cell: (e, i) => num(`expenses.${i}.amount`, e.amount, '0.01', 'aria-label="Amount"') },
          { label: 'How often', cell: (e, i) => `<select data-change="set" data-path="expenses.${i}.cadence" aria-label="Cadence">${[['monthly', 'Every month'], ['annual', 'Every year'], ['once', 'One time']].map(([k, l]) => `<option value="${k}"${e.cadence === k ? ' selected' : ''}>${l}</option>`).join('')}</select>` },
          { label: 'Date (one-time only)', cell: (e, i) => `<input type="date" value="${h(e.day || '')}" data-change="set" data-path="expenses.${i}.day" aria-label="Date"${e.cadence === 'once' ? '' : ' disabled'}>` },
          { label: '', cell: (e, i) => `<button type="button" class="gi-link" data-act="set-remove" data-list="expenses" data-i="${i}">Remove</button>` },
        ], s.expenses, { empty: 'None entered. Ad spend is read from Meta and is not entered here.' })}
        <p class="gi-actions"><button type="button" class="btn btn-ghost gi-btn-sm" data-act="set-add" data-list="expenses">Add an expense</button></p>`,
      { sub: 'Enter the real billed amount and how often. Recurring costs are pro-rated to whatever period is on screen.' })}
      <p class="gi-actions gi-savebar">
        <button type="button" class="btn btn-primary" data-act="set-save" ${dirty ? '' : 'aria-disabled="true"'}>Save settings</button>
        ${dirty ? '<button type="button" class="btn btn-ghost" data-act="set-reset">Discard changes</button><span class="gi-fine">Unsaved changes.</span>' : '<span class="gi-fine">Saved.</span>'}
      </p>
      ${panel('Connections', `<ul class="gi-conn">
        ${check(S.demo ? null : S.store ? !!S.store.configured : null, 'Encrypted storage (Vercel Blob)', 'Holds the member database, every import and the ad history. Already used by the Finances tab.')}
        ${check(S.demo ? null : conn.configured === undefined ? null : !!conn.configured, 'Meta Marketing API — read-only', `Uses the same token as the Performance tab (<code>${h(conn.tokenSource || 'META_ADS_TOKEN')}</code>, scope <code>ads_read</code>). It cannot modify a campaign.`)}
        ${check(null, 'AI analyst (Anthropic)', 'Needs <code>ANTHROPIC_API_KEY</code>, already set for the Performance tab\'s analysis panels. Checked the first time you ask a question.')}
        ${check(mail ? !!mail.configured : null, 'Report email (Resend)', 'Optional. Needs a Resend account: <code>RESEND_API_KEY</code> and a verified sender in <code>GROWTH_REPORT_FROM</code>.')}
        ${check(null, 'Scheduled jobs (Vercel Cron)', 'The daily Meta sync and the Monday report email need <code>CRON_SECRET</code> set on the deployment. Manual sync works without it.')}
      </ul>`, { sub: 'What this tab needs from outside. Everything else works from uploads alone.' })}
      ${panel('Demonstration data', `
        <p>A simulated community and ad account, built to include the awkward cases: two members with the same name, members who vanish from an export, a leave-and-return, a paused and restarted ad, a mid-week budget change, annual and free plans.</p>
        <p class="gi-actions"><button type="button" class="btn btn-ghost" data-act="${S.demo ? 'demo-off' : 'demo-on'}">${S.demo ? 'Return to real data' : 'Show demonstration data'}</button></p>
        <p class="gi-fine">It is held in memory only, flagged on every page while it is showing, and never mixed with or saved over real data.</p>`)}`;
    },
  };

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
  }

  const slotFull = (key) => {
    if (!occupants(key).length) return false;
    const sl = E.SLOTS.find((x) => x.key === key);
    S.error = `"${sl.title}" already has an upload. Remove it before uploading another.`;
    render();
    return true;
  };

  function readCsvFile(file) {
    if (!file) return;
    if (S.recon.draft) { S.error = 'Finish or discard the upload being reviewed first.'; render(); return; }
    if (slotFull('csv')) return;
    if (!/\.csv$/i.test(file.name) && !/csv|text\/plain|excel/i.test(file.type || '')) { S.error = 'That is not a CSV file. Export the member list from Skool as CSV.'; render(); return; }
    if (file.size > 3_000_000) { S.error = 'That file is larger than 3 MB. Split the export and import it in parts.'; render(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const parsed = E.parseCsv(text);
      if (!parsed.headers.length || !parsed.rows.length) { S.error = 'That file has no rows. Is it the member export from Skool?'; render(); return; }
      // The file's own modified time is the best first guess at when it was exported.
      const at = new Date(file.lastModified || Date.now());
      const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      S.recon.draft = {
        kind: 'csv', filename: file.name, raw: text, parsed, mapping: E.detectColumns(parsed.headers), decisions: {},
        observedLocal: local, observedAt: at.toISOString(), hash: E.contentHash(text), label: 'Skool CSV export', rows: [], issues: [],
      };
      S.error = ''; S.recon.receipt = null;
      remapCsv(); render();
      const d = S.root.querySelector('#gi-draft'); if (d) d.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };
    reader.onerror = () => { S.error = 'That file could not be read.'; render(); };
    reader.readAsText(file);
  }

  /* ============================================================= wiring == */

  const manualAdd = (rec, audit) => saveDb((db) => { db.manual = [...(db.manual || []), { id: uid(), at: new Date().toISOString(), ...rec }]; }, audit);

  const actions = {
    'member-status': (el) => { S.members.status = el.dataset.status; S.members.limit = 60; render(); },
    'member-clear': () => { S.members.q = ''; render(); },
    'member-more': () => { S.members.limit += 100; render(); },
    'member-close': () => { S.members.sel = null; render(); },
    'event-void': (el) => {
      const m = S.ctx.byId.get(S.members.sel);
      saveDb((db) => { db.manual = [...(db.manual || []), { id: uid(), at: new Date().toISOString(), type: 'void', key: el.dataset.key }]; },
        { action: 'event marked wrong', detail: `${m ? m.name : ''}: ${el.dataset.key.split('|')[2]}` });
    },
    'manual-remove': (el) => saveDb((db) => { db.manual = (db.manual || []).filter((r) => r.id !== el.dataset.id); }, { action: 'manual record removed', detail: el.dataset.id }),

    'ai-suggest': (el) => ask(el.dataset.q),
    'ai-briefing': () => ask('', true),
    'report-make': () => { S.ai.report = E.weeklyReport(S.ctx); S.ai.mailResult = null; render(); },
    'report-range': (el) => { const r = reportState(); r.from = el.dataset.from; r.to = el.dataset.to; r.error = ''; render(); },
    'report-print': () => {
      // Print only the report: everything else is hidden by a class on <html>.
      document.documentElement.classList.add('gi-print');
      const done = () => { document.documentElement.classList.remove('gi-print'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
    },

    'receipt-dismiss': () => { S.recon.receipt = null; render(); },
    'recon-discard': () => { S.recon.draft = null; S.recon.preview = null; render(); },
    'recon-split': (el) => { S.recon.draft.decisions[el.dataset.k] = 'new'; refreshPreview(); render(); },
    'paste-remove': (el) => { const r = S.recon.draft.rows.find((x) => x.k === el.dataset.k); if (r) r.removed = true; refreshPreview(); render(); },
    'recon-save': async (el) => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      const d = S.recon.draft;
      const cand = buildCandidate(d);
      delete cand.id;
      S.recon.saving = true; S.recon.receipt = null; render();
      const receipt = await saveImport(cand);
      S.recon.saving = false;
      if (receipt) { S.recon.draft = null; S.recon.preview = null; S.recon.receipt = receipt; S.notice = ''; }
      render();
      if (receipt) { const el2 = S.root.querySelector('.gi-receipt'); if (el2) el2.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    },
    'import-revert': (el) => { S.recon.confirm = el.dataset.id; render(); },
    'import-revert-no': () => { S.recon.confirm = null; render(); },
    'import-revert-yes': (el) => {
      const id = el.dataset.id; S.recon.confirm = null;
      saveDb((db) => { const i = db.imports.find((x) => x.id === id); if (i) i.reverted = { at: new Date().toISOString(), reason: '' }; }, { action: 'import reversed', detail: importName(id) });
    },
    'import-remove': (el) => { S.recon.removing = el.dataset.id; S.recon.confirm = null; render(); },
    'import-remove-no': () => { S.recon.removing = null; render(); },
    'import-remove-yes': async (el) => {
      const id = el.dataset.id;
      const title = importName(id);
      S.recon.removing = null;
      if (S.recon.showRaw && S.recon.showRaw.id === id) S.recon.showRaw = null;
      if (S.demo) {
        S.db.imports = S.db.imports.filter((x) => x.id !== id); S.imports.delete(id);
        S.notice = `Removed: ${title}.`; rebuild(); render(); return;
      }
      S.busy = 'Removing import…'; render();
      try {
        const j = await api(`/api/growth?import=${encodeURIComponent(id)}&baseVersion=${S.db.version || 0}`, { method: 'DELETE' });
        S.db = j.db; S.imports.delete(id);
        S.error = ''; S.notice = `Removed: ${title}. Every figure has been recalculated without it.`;
      } catch (e) {
        if (e.status === 409 && e.payload && e.payload.db) S.db = e.payload.db;
        S.error = e.message;
      }
      S.busy = ''; rebuild(); render();
    },
    'import-restore': (el) => {
      const id = el.dataset.id;
      saveDb((db) => { const i = db.imports.find((x) => x.id === id); if (i) i.reverted = null; }, { action: 'import restored', detail: importName(id) });
    },
    'import-raw': async (el) => {
      const id = el.dataset.id;
      const title = importName(id);
      let text;
      if (S.demo || String(id).startsWith('local-')) {
        const imp = S.imports.get(id);
        text = imp && imp.raw ? imp.raw : imp ? imp.rows.map((r) => r.raw || JSON.stringify(r)).join('\n\n') : 'Not available.';
      } else {
        try { const j = await api('/api/growth?raw=1&import=' + encodeURIComponent(id)); text = j.import.raw || '(The original text was not stored with this import.)'; }
        catch (e) { text = e.message; }
      }
      S.recon.showRaw = { id, title, text }; render();
    },
    'import-raw-close': () => { S.recon.showRaw = null; render(); },

    'set-add': (el) => {
      const s = draft();
      if (el.dataset.list === 'plans') s.plans.push({ id: 'p' + uid(), label: 'New plan', price: 0, interval: 'month' });
      else s.expenses.push({ id: 'e' + uid(), label: '', amount: 0, cadence: 'monthly', day: null });
      render();
    },
    'set-remove': (el) => { draft()[el.dataset.list].splice(Number(el.dataset.i), 1); render(); },
    'set-reset': () => { S.settingsDraft = null; render(); },
    'set-save': async (el) => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      const next = draft();
      const ok = await saveDb((db) => { db.settings = next; }, { action: 'settings changed', detail: `timezone ${next.timezone}, trial ${next.trialDays} days, ${next.plans.length} plans` });
      if (ok) { S.settingsDraft = null; S.be = null; render(); }
    },
  };

  const changes = {
    'member-source': (el) => {
      const m = S.ctx.byId.get(el.dataset.id);
      manualAdd({ type: 'override', memberId: el.dataset.id, field: 'source', value: el.value }, { action: 'source corrected', detail: `${m ? m.name : ''} → ${E.SOURCE_LABELS[el.value]}` });
    },
    'recon-file': (el) => { readCsvFile(el.files && el.files[0]); },
    'recon-map': (el) => {
      const d = S.recon.draft;
      if (el.value === '') delete d.mapping[el.dataset.field]; else d.mapping[el.dataset.field] = Number(el.value);
      d.decisions = {};
      remapCsv(); render();
    },
    'recon-when': (el) => {
      const d = S.recon.draft;
      d.observedLocal = el.value; d.observedAt = toIso(el.value);
      if (d.kind === 'paste') {
        // Relative dates were computed from the old day; read the text again.
        const day = E.dayIn(d.observedAt, S.ctx.settings.timezone);
        d.rows = E.parsePaste(d.raw, { pastedDay: day, defaultStatus: d.context });
        d.decisions = {};
      }
      refreshPreview(); render();
    },
    'recon-decide': (el) => { const d = S.recon.draft; if (el.value) d.decisions[el.dataset.k] = el.value; else delete d.decisions[el.dataset.k]; refreshPreview(); render(); },
    'paste-edit': (el) => {
      const r = S.recon.draft.rows.find((x) => x.k === el.dataset.k);
      if (!r) return;
      const f = el.dataset.field;
      let v = el.value.trim();
      if (f === 'price') v = v === '' ? null : Number(v);
      else if (['joinDay', 'trialStart', 'trialEnd', 'canceledAt', 'endsAt', 'churnedAt'].includes(f)) v = E.isDay(v) ? v : null;
      else if (f === 'handle') v = v.replace(/^@/, '').toLowerCase() || null;
      else if (f === 'source') v = v || null;
      r[f] = v;
      if (r.approx) delete r.approx[f];     // a person has now stated it
      refreshPreview(); render();
    },
    'report-date': (el) => { const r = reportState(); r[el.name] = el.value; r.error = ''; render(); },
    set: (el) => {
      const s = draft();
      let v = el.value;
      if (el.type === 'number') v = Number(v) || 0;
      if (el.type === 'date') v = E.isDay(v) ? v : null;
      setPath(s, el.dataset.path, v);
      render();
    },
  };

  const submits = {
    'member-search': (form) => { S.members.q = form.elements.q.value; S.members.limit = 60; render(); },
    'member-event': (form) => {
      const m = S.ctx.byId.get(form.dataset.id);
      const f = form.elements;
      if (!E.isDay(f.day.value)) return;
      manualAdd({ type: 'event', memberId: form.dataset.id, eventType: f.eventType.value, day: f.day.value, note: f.note.value },
        { action: 'event recorded', detail: `${m ? m.name : ''}: ${E.EVENT_LABEL[f.eventType.value]} on ${f.day.value}` });
    },
    'member-payment': (form) => {
      const m = S.ctx.byId.get(form.dataset.id);
      const f = form.elements;
      const amount = Number(f.amount.value);
      if (!E.isDay(f.day.value) || !(amount >= 0)) return;
      manualAdd({ type: f.type.value, memberId: form.dataset.id, day: f.day.value, amount, note: f.note.value },
        { action: `${f.type.value.replace('_', ' ')} recorded`, detail: `${m ? m.name : ''}: ${money(amount, 2)} on ${f.day.value}` });
    },
    'report-make': () => makeReport(),
    'ai-ask': (form) => { const q = form.elements.q.value.trim(); if (q) ask(q); },
    'report-email': async (form) => {
      if (S.demo) return;
      const to = form.elements.to.value.trim();
      S.busy = 'Sending the report…'; render();
      try {
        const j = await api('/api/growth-report', { method: 'POST', body: { to } });
        S.ai.mailResult = j.sent ? { ok: true, text: `Sent to ${j.to}.` } : { ok: false, text: j.reason };
      } catch (e) { S.ai.mailResult = { ok: false, text: e.message }; }
      S.busy = ''; render();
    },
    'recon-paste': (form) => {
      const text = form.elements.text.value;
      if (!text.trim()) return;
      const context = form.dataset.context;
      if (S.recon.draft) { S.error = 'Finish or discard the upload being reviewed first.'; render(); return; }
      if (slotFull(context)) return;
      const local = nowLocalInput();
      const observedAt = toIso(local);
      const rows = E.parsePaste(text, { pastedDay: E.dayIn(observedAt, S.ctx.settings.timezone), defaultStatus: context });
      if (!rows.length) { S.error = 'No member records could be read from that text. Each member needs at least a name or a @username.'; render(); return; }
      S.recon.draft = {
        kind: 'paste', raw: text, rows, decisions: {}, context, observedLocal: local, observedAt, hash: E.contentHash(text),
        label: { active_trial: 'Active trials', canceling: 'Canceling members', churned: 'Churned members' }[context] || 'Pasted membership status',
      };
      S.error = ''; S.recon.receipt = null;
      refreshPreview(); render();
      const dEl = S.root.querySelector('#gi-draft'); if (dEl) dEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
  };

  return { members, ai, report, recon, settings, actions, changes, submits, dropFile: readCsvFile };
}
