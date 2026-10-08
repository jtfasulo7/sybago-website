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
  const { S, E, h, money, int, dec, pct, dayLabel, dayFull, tag, precisionTag, panel, table, tiles, insightList, api, saveDb, saveImport, render, setDemo } = kit;

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
        <button type="button" class="btn btn-primary" data-act="recon-save" ${undecided.length ? 'aria-disabled="true"' : ''}>Confirm and save</button>
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

  function importHistory() {
    const rows = (S.db.imports || []).slice().sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
    return table([
      { label: 'Describes', cell: (i) => h(new Date(i.observedAt).toLocaleString()) },
      { label: 'Import', cell: (i) => `${h(i.label || (i.kind === 'csv' ? 'Skool CSV export' : 'Pasted list'))}${i.filename ? `<br><small>${h(i.filename)}</small>` : ''}` },
      { label: 'Rows', num: true, cell: (i) => int(i.rowCount) },
      { label: 'Saved', cell: (i) => (i.createdAt ? h(new Date(i.createdAt).toLocaleDateString()) : '—') },
      { label: 'State', cell: (i) => (i.reverted ? tag('reversed', 'is-win') + ` <small>${h(new Date(i.reverted.at).toLocaleDateString())}</small>` : tag('in use', 'is-ok')) },
      { label: '', cell: (i) => `
        <button type="button" class="gi-link" data-act="import-raw" data-id="${h(i.id)}">View original</button>
        ${i.reverted ? `<button type="button" class="gi-link" data-act="import-restore" data-id="${h(i.id)}">Restore</button>`
          : S.recon.confirm === i.id ? `<button type="button" class="gi-link is-danger" data-act="import-revert-yes" data-id="${h(i.id)}">Confirm reverse</button> <button type="button" class="gi-link" data-act="import-revert-no">Keep</button>`
            : `<button type="button" class="gi-link" data-act="import-revert" data-id="${h(i.id)}">Reverse</button>`}` },
    ], rows, { empty: 'Nothing has been imported yet.', caption: 'Reversing an import removes its effect from every figure and keeps the original on file. It can be restored at any time.' });
  }

  const recon = {
    html() {
      const c = S.ctx; const r = S.recon;
      const dupes = c.members.filter((m) => m.possibleDuplicateOf && m.possibleDuplicateOf.length);
      const start = `
        <div class="gi-cards">
          <div class="gi-card is-wide">
            <p class="gi-card-kicker">Everyone currently in the community</p>
            <h4>Upload Skool CSV</h4>
            <p class="sub">The member export from Skool. Each upload is kept as its own snapshot and compared with the ones before it. Nothing is overwritten.</p>
            <label class="btn btn-primary gi-btn-sm gi-file">Choose a CSV file<input type="file" accept=".csv,text/csv" data-change="recon-file" class="sr-only"></label>
          </div>
          <form class="gi-card" data-form="recon-paste" data-context="active_trial">
            <p class="gi-card-kicker">On a free trial now</p>
            <h4>Paste active trials</h4>
            <p class="sub">Select the members in Skool's active-trial list, copy, and paste here.</p>
            <label class="sr-only" for="gi-paste-a">Active trials, pasted from Skool</label>
            <textarea id="gi-paste-a" name="text" rows="5" placeholder="Jane Doe&#10;@jane-doe-1234&#10;Free trial ends in 5 days&#10;Joined Oct 3, 2026&#10;$19/month"></textarea>
            <button type="submit" class="btn btn-ghost gi-btn-sm">Read this text</button>
          </form>
          <form class="gi-card" data-form="recon-paste" data-context="canceling">
            <p class="gi-card-kicker">Asked to cancel — still in the community</p>
            <h4>Paste canceling members</h4>
            <p class="sub">People who have canceled but have not left yet. They stay counted as members, and paying ones as paying, until they show up in the churned list. Everyone pasted here is treated as canceling.</p>
            <label class="sr-only" for="gi-paste-c">Canceling members, pasted from Skool</label>
            <textarea id="gi-paste-c" name="text" rows="5" placeholder="John Smith&#10;@john-smith-88&#10;Canceled Oct 1, 2026&#10;Access ends Oct 20, 2026"></textarea>
            <button type="submit" class="btn btn-ghost gi-btn-sm">Read this text</button>
          </form>
          <form class="gi-card" data-form="recon-paste" data-context="churned">
            <p class="gi-card-kicker">Fully churned — no longer in the community</p>
            <h4>Paste churned members</h4>
            <p class="sub">People who have actually left. Everyone pasted here is treated as churned. Someone who left without ever paying is recorded as a trial that did not convert, not as paid churn.</p>
            <label class="sr-only" for="gi-paste-b">Churned members, pasted from Skool</label>
            <textarea id="gi-paste-b" name="text" rows="5" placeholder="Ana Ruiz&#10;@ana-ruiz-2&#10;Churned Sep 28, 2026"></textarea>
            <button type="submit" class="btn btn-ghost gi-btn-sm">Read this text</button>
          </form>
        </div>`;
      return `
      <div class="gi-pagehead"><h3>Data Reconciliation</h3><p class="sub">Where membership data comes in. Every import is previewed against what is already on record, saved only when you confirm, kept forever, and reversible.</p></div>
      ${r.draft ? panel(r.draft.kind === 'csv' ? 'Review this CSV before saving' : 'Review this pasted list before saving', r.draft.kind === 'csv' ? csvDraftView() : pasteDraftView(), { id: 'gi-draft' }) : panel('Bring in new data', start)}
      ${panel('Import history', importHistory() + (r.showRaw ? `<div class="gi-raw"><p><strong>Original submission</strong> — ${h(r.showRaw.title)} <button type="button" class="gi-link" data-act="import-raw-close">Close</button></p><pre>${h(r.showRaw.text)}</pre></div>` : ''), { sub: c.lastCsv ? `Latest export on record: ${dayFull(c.lastCsv.day)}, ${int(c.lastCsv.rows)} rows.` : '' })}
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
    'report-print': () => {
      // Print only the report: everything else is hidden by a class on <html>.
      document.documentElement.classList.add('gi-print');
      const done = () => { document.documentElement.classList.remove('gi-print'); window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done);
      window.print();
    },

    'recon-discard': () => { S.recon.draft = null; S.recon.preview = null; render(); },
    'recon-split': (el) => { S.recon.draft.decisions[el.dataset.k] = 'new'; refreshPreview(); render(); },
    'paste-remove': (el) => { const r = S.recon.draft.rows.find((x) => x.k === el.dataset.k); if (r) r.removed = true; refreshPreview(); render(); },
    'recon-save': async (el) => {
      if (el.getAttribute('aria-disabled') === 'true') return;
      const d = S.recon.draft;
      const cand = buildCandidate(d);
      delete cand.id;
      const ok = await saveImport(cand);
      if (ok) { S.recon.draft = null; S.recon.preview = null; S.notice = `${d.label} saved: ${cand.rows.length} rows.`; }
      render();
    },
    'import-revert': (el) => { S.recon.confirm = el.dataset.id; render(); },
    'import-revert-no': () => { S.recon.confirm = null; render(); },
    'import-revert-yes': (el) => {
      const id = el.dataset.id; S.recon.confirm = null;
      saveDb((db) => { const i = db.imports.find((x) => x.id === id); if (i) i.reverted = { at: new Date().toISOString(), reason: '' }; }, { action: 'import reversed', detail: importName(id) });
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
    'recon-file': (el) => {
      const file = el.files && el.files[0];
      if (!file) return;
      if (file.size > 3_000_000) { S.error = 'That file is larger than 3 MB. Split the export and import it in parts.'; render(); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        const parsed = E.parseCsv(text);
        if (!parsed.headers.length || !parsed.rows.length) { S.error = 'That file has no rows. Is it the member export from Skool?'; render(); return; }
        // The file's own modified time is the best first guess at when it was exported.
        const when = new Date(file.lastModified || Date.now());
        const local = new Date(when.getTime() - when.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        S.recon.draft = {
          kind: 'csv', filename: file.name, raw: text, parsed, mapping: E.detectColumns(parsed.headers), decisions: {},
          observedLocal: local, observedAt: when.toISOString(), hash: E.contentHash(text), label: 'Skool CSV export', rows: [], issues: [],
        };
        S.error = '';
        remapCsv(); render();
      };
      reader.onerror = () => { S.error = 'That file could not be read.'; render(); };
      reader.readAsText(file);
    },
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
      const local = nowLocalInput();
      const observedAt = toIso(local);
      const rows = E.parsePaste(text, { pastedDay: E.dayIn(observedAt, S.ctx.settings.timezone), defaultStatus: context });
      if (!rows.length) { S.error = 'No member records could be read from that text. Each member needs at least a name or a @username.'; render(); return; }
      S.recon.draft = {
        kind: 'paste', raw: text, rows, decisions: {}, context, observedLocal: local, observedAt, hash: E.contentHash(text),
        label: { active_trial: 'Active trials', canceling: 'Canceling members', churned: 'Churned members' }[context] || 'Pasted membership status',
      };
      S.error = '';
      refreshPreview(); render();
    },
  };

  return { members, ai, recon, settings, actions, changes, submits };
}
