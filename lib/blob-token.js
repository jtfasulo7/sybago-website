// Finding the Blob read-write token.
//
// Extracted so there is ONE piece of code that decides which credential writes
// to Blob. Two copies of a credential lookup is two places to get it wrong, and
// only one of them gets fixed.
//
// Vercel's Blob connect dialog defaults to OIDC and hides the read-write token
// behind an unchecked box, and when you do tick it the variable can be created
// with a project-specific prefix. So the token is found by the shape of its
// VALUE rather than by the name someone happened to give it — a name match
// fails silently and looks exactly like "Blob is not connected".

const RW_PREFIX = 'vercel_blob_rw_';

/**
 * @returns {{name: string, token: string, unrecognised?: boolean} | null}
 */
export function findBlobToken(env = process.env) {
  // The documented name first, so the ordinary case is not decided by
  // enumeration order.
  const canonical = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  if (canonical.startsWith(RW_PREFIX)) {
    return { name: 'BLOB_READ_WRITE_TOKEN', token: canonical };
  }

  for (const [name, value] of Object.entries(env)) {
    const v = String(value || '').trim();
    if (v.startsWith(RW_PREFIX)) return { name, token: v };
  }

  // A token that is set but malformed is worth separating from one that is
  // absent — the fixes are different, and handing it on lets the SDK produce a
  // real error instead of us guessing at one.
  if (env.BLOB_READ_WRITE_TOKEN) {
    return { name: 'BLOB_READ_WRITE_TOKEN', token: env.BLOB_READ_WRITE_TOKEN, unrecognised: true };
  }
  return null;
}

/** Names that exist but are not the read-write token, to say what WAS found. */
export function blobVarsPresent(env = process.env) {
  return Object.keys(env).filter((k) => /BLOB/i.test(k));
}

/** A setup message that names what to do, rather than just what is missing. */
export function blobSetupHint() {
  return (
    'No Blob read-write token found. In Vercel: Storage → your Blob store → ' +
    'Connect Project, and tick "Add a read-write token env var to this connection" — ' +
    'it is off by default, and without it only an OIDC variable is created, which ' +
    'cannot write.'
  );
}
