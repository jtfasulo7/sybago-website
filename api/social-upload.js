// Issues the short-lived token the browser needs to upload a video straight to
// Vercel Blob.
//
// The file never passes through this function. A Vercel serverless function
// caps request bodies at 4.5 MB and a finished social video is routinely tens
// or hundreds of megabytes, so the browser talks to Blob directly and this
// route only says "yes, that person may upload".
//
// (req, res) — NOT a Web-standard (Request) -> Response handler.
//
// It was written that way first, copied from the docs' framework-agnostic
// example, and every call to it hung until the platform timed out: Vercel's
// Node runtime invokes this file as (req, res), so returning a Response object
// meant nothing ever ended the response. The other functions here are all
// (req, res); this one has to match them.

import { handleUpload } from '@vercel/blob/client';
import { readSession, noStore } from '../lib/auth.js';

const MAX_BYTES = 512 * 1024 * 1024; // 512 MB — well past any sane Reel.

const ALLOWED = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
];

/**
 * Find the Blob read-write token whatever Vercel decided to call it.
 *
 * The connection dialog offers a custom variable prefix, so the name is not
 * guaranteed to be BLOB_READ_WRITE_TOKEN — which is the only name the SDK looks
 * for on its own. Rather than depend on someone having left the prefix alone,
 * the value is identified by its shape: Vercel read-write tokens all begin
 * vercel_blob_rw_.
 *
 * Checked by name first so the ordinary setup costs nothing, then by value.
 * Only the NAME is ever reported anywhere; the value goes straight to the SDK.
 */
const TOKEN_PREFIX = 'vercel_blob_rw_';

function findBlobToken(env = process.env) {
  if (String(env.BLOB_READ_WRITE_TOKEN || '').startsWith(TOKEN_PREFIX)) {
    return { name: 'BLOB_READ_WRITE_TOKEN', token: env.BLOB_READ_WRITE_TOKEN };
  }
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.startsWith(TOKEN_PREFIX)) {
      return { name, token: value };
    }
  }
  // A token that is set but malformed is worth separating from one that is
  // absent — the fixes are different.
  if (env.BLOB_READ_WRITE_TOKEN) {
    return { name: 'BLOB_READ_WRITE_TOKEN', token: env.BLOB_READ_WRITE_TOKEN, unrecognised: true };
  }
  return null;
}

/** Names that exist but are not the read-write token, to say what WAS found. */
function blobVarsPresent(env = process.env) {
  return Object.keys(env).filter((k) => /BLOB/i.test(k));
}

export default async function handler(req, res) {
  noStore(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const found = findBlobToken();

  if (!found) {
    const present = blobVarsPresent();
    return res.status(500).json({
      error: 'server_misconfigured',
      // Saying which Blob variables DID arrive turns this from "it is not set"
      // into something diagnosable: BLOB_STORE_ID present on its own is the
      // signature of a connection made without the read-write token.
      blobVarsFound: present,
      message:
        'BLOB_READ_WRITE_TOKEN is not set. Connecting a Blob store is not enough on its own: ' +
        'Vercel defaults the connection to OIDC and only creates BLOB_STORE_ID and ' +
        'BLOB_WEBHOOK_PUBLIC_KEY. Re-run the connection with "Add a read-write token env var to ' +
        'this connection" ticked, because browser uploads mint a client token and that needs the ' +
        'long-lived token specifically. Then redeploy — environment changes only apply to new ' +
        'deployments.' +
        (present.length
          ? ' Blob variables that DID reach this deployment: ' + present.join(', ') + '.'
          : ' No Blob variables reached this deployment at all, so the store is not connected ' +
            'to this project in the Production environment.'),
    });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'bad_request', message: 'Expected a JSON body.' });
  }

  try {
    const result = await handleUpload({
      body,
      // Passed explicitly rather than left to the SDK's own lookup, which only
      // reads BLOB_READ_WRITE_TOKEN and would miss a prefixed name.
      token: found.token,
      // Passed straight through. handleUpload reads the callback signature as
      // `request.headers[name]` when the object has no `credentials` property,
      // which is exactly what a Node req is.
      request: req,
      onBeforeGenerateToken: async () => {
        // THE gate. Without this the upload route is open to the internet and
        // anyone could fill the Blob store. handleUpload calls this before it
        // will mint a token, and a throw here means no token is issued.
        const session = readSession(
          { headers: { cookie: req.headers.cookie || '' } },
          process.env.DASHBOARD_SESSION_SECRET,
        );
        if (!session) throw new Error('Sign in to upload a video.');

        return {
          allowedContentTypes: ALLOWED,
          maximumSizeInBytes: MAX_BYTES,
          // A random suffix stops one upload silently overwriting another that
          // happens to share a filename.
          addRandomSuffix: true,
          // Instagram, Facebook and TikTok all fetch the video themselves, so
          // the URL has to be publicly readable for the duration of the post.
          access: 'public',
          tokenPayload: JSON.stringify({ role: session.role, at: Date.now() }),
        };
      },
      // onUploadCompleted is deliberately omitted. There is no database here
      // and the browser already holds the returned URL, so the only thing it
      // would buy is a webhook round trip — and supplying it makes the SDK
      // derive a callback URL, which is one more thing to get wrong for no gain.
    });

    return res.status(200).json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Upload could not be authorised.';
    const unauthenticated = /sign in/i.test(message);
    return res
      .status(unauthenticated ? 401 : 400)
      .json({ error: unauthenticated ? 'unauthenticated' : 'upload_failed', message });
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
