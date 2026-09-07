// Serves an uploaded video from sybago.ai, for platforms that fetch it
// themselves.
//
// PUBLIC by necessity — TikTok's servers do the fetching and carry no session.
// Every URL is signed and expires; see lib/social/video-proxy.js for why that
// is not optional.
//
// Range requests are forwarded rather than swallowed. A fetcher pulling a video
// will often ask for a byte range first to read the container header, and a
// server that answers 200-with-everything to a Range request looks broken to
// some clients and wastes the whole file to others.

import { resolveSignedVideo } from '../lib/social/video-proxy.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end('Method not allowed');
  }

  const check = resolveSignedVideo(req.query, process.env);
  if (!check.ok) {
    // Plain text, not JSON: the caller here is a video fetcher, not our own UI.
    res.status(check.status).setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(check.message);
  }

  const forward = {};
  if (req.headers.range) forward.range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(check.url, { method: req.method, headers: forward });
  } catch {
    return res.status(502).end('Could not reach the stored video.');
  }

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status === 404 ? 404 : 502).end('That video is no longer stored.');
  }

  // Only the headers a fetcher needs. Copying everything would pass Blob's own
  // caching and CORS decisions through as if they were ours.
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('content-type')) res.setHeader('Content-Type', 'video/mp4');
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');

  // The link expires anyway; a cache that outlived it would defeat that.
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  res.status(upstream.status);
  if (req.method === 'HEAD' || !upstream.body) return res.end();

  // Streamed, not buffered: these files are tens of megabytes and a function
  // that holds one in memory will fall over on the first large upload.
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // The connection went away mid-stream. Nothing useful to say to it.
  }
  return res.end();
}
