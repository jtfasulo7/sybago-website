// Growth Intelligence — the AI analyst.
//
//   POST { question, digest }          -> { answer }    one question, answered
//   POST { briefing: true, digest }    -> { answer }    the short weekly briefing
//   POST { report: true, digest }      -> { report }    the full written report for a period
//
// The model is given ONE thing to reason from: a digest the engine builds
// (assets/growth/engine.js → buildDigest / buildReportDigest). It is computed
// in the browser from exactly the data on screen, so the analyst cannot
// describe a different window than the reader is looking at, and every
// estimate, blend and unresolved count arrives already labelled as one.
//
// Transport only. The instructions live in lib/growth/analyst-prompt.js.
//
// It answers through a FORCED TOOL CALL, for the reason api/ads-analysis.js
// documents at length: asking for JSON in prose fails in five different ways
// that all look the same.
//
// The report is a long reply. vercel.json raises this function's time limit,
// because a report cut off by the platform is a report nobody gets.

import { requireSession, noStore } from '../lib/auth.js';
import { analystSystem, analystUser, reportSystem, reportUser, BRIEFING_QUESTION } from '../lib/growth/analyst-prompt.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const MAX_DIGEST = 400_000;      // characters of JSON
const KINDS = ['verified', 'estimate', 'forecast', 'correlation', 'missing'];
const VERDICTS = ['profitable', 'breakeven', 'unprofitable', 'unclear'];
const PRIORITIES = ['high', 'medium', 'low'];

const ANSWER_TOOL = {
  name: 'answer_question',
  description: 'Give the finished answer. This is the only way to reply.',
  input_schema: {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description: 'The answer in plain prose: the direct answer first with its numbers, then brief reasoning. Separate paragraphs with a blank line. No markdown.',
      },
      basis: {
        type: 'array',
        description: 'The supporting points, each classified by what kind of statement it is.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            text: { type: 'string', description: 'One sentence, with the figure it rests on.' },
          },
          required: ['kind', 'text'],
        },
      },
      confidence: {
        type: 'string', enum: ['high', 'medium', 'low'],
        description: 'How settled the evidence is. Low when samples are small, trials are unresolved, or cohorts are still mid-trial.',
      },
    },
    required: ['answer', 'basis', 'confidence'],
  },
};

const REPORT_TOOL = {
  name: 'write_report',
  description: 'Deliver the finished report. This is the only way to reply.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string', enum: VERDICTS,
        description: 'Whether the business made more than it spent in this period, on the evidence. "unclear" when the data cannot say.',
      },
      headline: { type: 'string', description: 'One sentence: the verdict and the number it rests on.' },
      summary: { type: 'string', description: 'Two to four sentences an owner could read and stop. Plain prose, the most important figures included.' },
      sections: {
        type: 'array',
        description: 'The body of the report, in the order given in the instructions.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            body: { type: 'string', description: 'Plain prose. Separate paragraphs with a blank line. No markdown, no bullet characters.' },
          },
          required: ['heading', 'body'],
        },
      },
      recommendations: {
        type: 'array',
        description: 'What to change, most important first. Each must follow from figures in the report.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'The specific thing to do.' },
            reason: { type: 'string', description: 'The figures that support it, and how settled they are.' },
            priority: { type: 'string', enum: PRIORITIES },
          },
          required: ['action', 'reason', 'priority'],
        },
      },
      caveats: {
        type: 'array', items: { type: 'string' },
        description: 'What limits these conclusions: unresolved trials, estimated dates, stale exports, cohorts still mid-trial, missing data.',
      },
    },
    required: ['verdict', 'headline', 'summary', 'sections', 'recommendations', 'caveats'],
  },
};

const clean = (v, max, keepBreaks) =>
  String(v == null ? '' : v)
    .replace(keepBreaks ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ')
    .trim().slice(0, max);

function scrub(message) {
  const key = process.env.ANTHROPIC_API_KEY;
  let out = String(message || '');
  if (key && key.length > 8) out = out.split(key).join('[redacted]');
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
}

export function shapeAnswer(input) {
  const basis = [];
  for (const b of Array.isArray(input && input.basis) ? input.basis.slice(0, 12) : []) {
    const text = clean(b && b.text, 500);
    if (text) basis.push({ kind: KINDS.includes(b.kind) ? b.kind : 'estimate', text });
  }
  const answer = clean(input && input.answer, 6000, true);
  if (!answer) throw new Error('the answer came back empty');
  return { answer, basis, confidence: ['high', 'medium', 'low'].includes(input.confidence) ? input.confidence : 'low' };
}

/** The report, rebuilt field by field. An invented verdict or priority falls back rather than reaching the page. */
export function shapeReport(input) {
  const src = input && typeof input === 'object' ? input : {};
  const sections = [];
  for (const s of Array.isArray(src.sections) ? src.sections.slice(0, 14) : []) {
    const heading = clean(s && s.heading, 120);
    const body = clean(s && s.body, 6000, true);
    if (heading && body) sections.push({ heading, body });
  }
  const recommendations = [];
  for (const r of Array.isArray(src.recommendations) ? src.recommendations.slice(0, 10) : []) {
    const action = clean(r && r.action, 400);
    if (action) recommendations.push({ action, reason: clean(r.reason, 800), priority: PRIORITIES.includes(r.priority) ? r.priority : 'medium' });
  }
  const caveats = (Array.isArray(src.caveats) ? src.caveats.slice(0, 12) : []).map((c) => clean(c, 500)).filter(Boolean);
  const out = {
    verdict: VERDICTS.includes(src.verdict) ? src.verdict : 'unclear',
    headline: clean(src.headline, 400),
    summary: clean(src.summary, 2500, true),
    sections, recommendations, caveats,
  };
  if (!out.headline && !out.summary && !sections.length) throw new Error('the report came back empty');
  return out;
}

async function callModel({ key, system, user, tool, maxTokens }) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(scrub((out && out.error && out.error.message) || `HTTP ${resp.status}`));
    err.status = resp.status;
    throw err;
  }
  const blocks = Array.isArray(out.content) ? out.content : [];
  const call = blocks.find((b) => b && b.type === 'tool_use' && b.name === tool.name);
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
  return { input: call && call.input && typeof call.input === 'object' ? call.input : null, text, stopReason: out.stop_reason, blocks };
}

function unusable(r) {
  const seen = r.blocks.map((b) => (b && b.type) || 'unknown').join(', ') || 'no content blocks';
  const err = new Error(
    `The model returned nothing usable (stop_reason: ${r.stopReason || 'unknown'}; blocks: ${seen}).` +
    (r.stopReason === 'max_tokens' ? ' The reply hit the length limit before it finished.' : ''),
  );
  err.status = 502;
  return err;
}

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message: 'ANTHROPIC_API_KEY is not set on this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  body = body || {};

  const wantReport = !!body.report;
  const question = wantReport ? '' : body.briefing ? BRIEFING_QUESTION : clean(body.question, 600);
  if (!wantReport && !question) return res.status(400).json({ error: 'bad_request', message: 'Ask a question.' });

  const digest = body.digest;
  if (!digest || typeof digest !== 'object' || Array.isArray(digest)) {
    return res.status(400).json({ error: 'bad_request', message: 'No data snapshot was sent with the request.' });
  }
  // Re-serialising is the sanitiser: it cannot carry a raw control character,
  // and anything that is not plain data does not survive it.
  let json;
  try { json = JSON.stringify(digest); } catch { json = ''; }
  if (!json || json.length > MAX_DIGEST) {
    return res.status(413).json({ error: 'too_large', message: 'The data snapshot is too large to analyse in one request. Choose a shorter time frame.' });
  }
  const snapshot = JSON.parse(json);
  const trialDays = Number(snapshot.business && snapshot.business.trialDays) || 7;

  // Nothing to reason from is not a model call.
  const members = snapshot.membersByStatus && Object.keys(snapshot.membersByStatus).length;
  const hasAds = snapshot.dataCoverage && snapshot.dataCoverage.metaFirstDay;
  if (!members && !hasAds) {
    const text = 'There is no membership or advertising data loaded yet, so there is nothing to analyse. Upload a Skool CSV in Data Reconciliation and run a Meta sync first.';
    if (wantReport) return res.status(200).json({ report: null, skipped: 'no_data', message: text });
    return res.status(200).json({
      answer: { answer: text, basis: [{ kind: 'missing', text: 'No Skool export and no Meta history are stored.' }], confidence: 'low' },
      model: null, skipped: 'no_data',
    });
  }

  try {
    if (wantReport) {
      const r = await callModel({ key, system: reportSystem(trialDays), user: reportUser(snapshot), tool: REPORT_TOOL, maxTokens: 8000 });
      if (!r.input) throw unusable(r);
      return res.status(200).json({ report: shapeReport(r.input), model: MODEL, generatedAt: new Date().toISOString() });
    }

    const r = await callModel({ key, system: analystSystem(trialDays), user: analystUser(question, snapshot), tool: ANSWER_TOOL, maxTokens: 2500 });
    let answer;
    if (r.input) answer = shapeAnswer(r.input);
    // A model that answered in prose regardless: keep the prose, claim nothing about its basis.
    else if (r.text) answer = shapeAnswer({ answer: r.text, basis: [], confidence: 'low' });
    else throw unusable(r);
    return res.status(200).json({ answer, question, model: MODEL, generatedAt: new Date().toISOString() });
  } catch (e) {
    const status = e.status || 502;
    if (status === 401) return res.status(401).json({ error: 'anthropic_unauthorized', message: 'The Anthropic API rejected the key. Check ANTHROPIC_API_KEY is current and complete.' });
    if (status === 429) return res.status(429).json({ error: 'anthropic_rate_limited', message: 'The Anthropic API is rate limiting this key. Wait a moment and try again.' });
    return res.status(502).json({ error: 'analysis_failed', message: scrub(e.message) });
  }
}
