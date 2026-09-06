// Issues the short-lived token the browser needs to upload a video straight to
// Vercel Blob.
//
// The file never passes through this function. A Vercel serverless function
// caps request bodies at 4.5 MB and a finished social video is routinely tens
// or hundreds of megabytes, so the browser talks to Blob directly and this
// route only says "yes, that person may upload".
//
// This handler is Web-standard (Request in, Response out) rather than the
// (req, res) shape the other functions use, because handleUpload expects a
// Request. Vercel's Node runtime supports both.

import { handleUpload } from '@vercel/blob/client';
import { readSession } from '../lib/auth.js';

const MAX_BYTES = 512 * 1024 * 1024; // 512 MB — well past any sane Reel.

const ALLOWED = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Same rule as every other authenticated response here.
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json(
      {
        error: 'server_misconfigured',
        message:
          'BLOB_READ_WRITE_TOKEN is not set. Create a Blob store in Vercel → Storage and ' +
          'connect it to this project, then redeploy.',
      },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Expected a JSON body.' }, 400);
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // THE gate. Without this the upload route is open to the internet and
        // anyone could fill the Blob store. handleUpload calls this before it
        // will mint a token, and a throw here means no token is issued.
        //
        // The cookie is read off the raw header because this handler receives a
        // Request rather than the Node-style req the other functions get.
        const session = readSession(
          { headers: { cookie: request.headers.get('cookie') || '' } },
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
      onUploadCompleted: async () => {
        // Nothing to record — there is no database here, and the browser
        // already holds the returned URL. Present because handleUpload
        // requires it.
      },
    });

    return json(result);
  } catch (e) {
    // handleUpload throws for both a refused token and a malformed callback.
    const message = e instanceof Error ? e.message : 'Upload could not be authorised.';
    const unauthenticated = /sign in/i.test(message);
    return json(
      { error: unauthenticated ? 'unauthenticated' : 'upload_failed', message },
      unauthenticated ? 401 : 400,
    );
  }
}
