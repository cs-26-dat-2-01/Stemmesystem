/**
 * Blind RSA helper (client side) — RFC 9474.
 *
 * The browser half of the blind-signature protocol. Wraps
 * `@cloudflare/blindrsa-ts` so the rest of the frontend never has to touch
 * CryptoKey objects, PEM strings, or base64 directly. Four things are
 * exported:
 *
 *  - {@link generateUuid} — produce a fresh 32-byte random message that
 *                           becomes (after `prepare`) the public UUID on
 *                           the cast endpoint and in the `Vote` row.
 *  - {@link prepare}      — RFC 9474 §4.1 Prepare. For the Randomized
 *                           suite this prepends 32 random bytes to the
 *                           message; the output is what `Vote.id` will be.
 *  - {@link blind}        — RFC 9474 §4.2 Blind. Produces `(blindedMsg, inv)`
 *                           where `blindedMsg` is sent to the server for
 *                           signing and `inv` is kept secret until finalize.
 *  - {@link finalize}     — RFC 9474 §4.4 Finalize. Combines the server's
 *                           blind signature with `inv` to recover an
 *                           ordinary RSA-PSS signature on the prepared msg.
 *  - {@link verify}       — RSASSA-PSS-VERIFY for the "see my vote" flow.
 *
 * The server half of the protocol (`keygen`, `blindSign`, `verify`) lives in
 * `server_src/blindRsa.ts` and MUST use the same `SUITE` constant —
 * otherwise verification silently fails.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9474 RFC 9474 — RSA Blind Signatures
 * @see https://www.rfc-editor.org/rfc/rfc8017 RFC 8017 — PKCS #1 v2.2 (PSS, MGF1)
 */

import { RSABSSA } from "@cloudflare/blindrsa-ts";

// ---------------------------------------------------------------------------
// Ciphersuite
// ---------------------------------------------------------------------------

/**
 * The RFC 9474 ciphersuite — MUST match `server_src/blindRsa.ts`.
 *
 * `RSABSSA-SHA384-PSS-Randomized` — RSA-PSS with SHA-384, MGF1-SHA-384, salt
 * length = hash length (48 bytes), and a randomized `prepare()` that
 * prepends 32 random bytes to the message before blinding.
 */
const SUITE = RSABSSA.SHA384.PSS.Randomized();

/**
 * The output of {@link blind}. `blindedMessageB64` goes to the server in
 * the `POST /api/poll/:id/blindsign` body; `invB64` MUST be kept locally
 * until {@link finalize} is called, after which it can be discarded.
 *
 * @property blindedMessageB64 base64 of the blinded message — sent to server.
 * @property invB64            base64 of the blinding inverse — KEEP PRIVATE.
 */
export interface BlindResult {
  blindedMessageB64: string;
  invB64: string;
}

/**
 * The local "receipt" that ties a voter to a vote.
 *
 * Stored in `localStorage` after a successful vote; everything needed to
 * later verify "my vote is in the tally and untampered with" lives in this
 * object plus the public results page. The server never sees these fields
 * together — `preparedMessage` only on the cast endpoint, `signature` only
 * on the cast endpoint, and neither is ever associated with a `userId`.
 *
 * @property preparedMessage the bytes verified against `signature` —
 *   ALSO the value stored as `Vote.id` on the server.
 * @property signatureB64    base64 of the finalized RSA-PSS signature.
 * @property pollId          which poll this receipt belongs to.
 * @property optionId        which option was voted for.
 */
export interface VoteReceipt {
  preparedMessage: Uint8Array;
  signatureB64: string;
  pollId: number;
  optionId: number;
}

//Base64 utilities (identical to server ones!). 

// Since we mostly works with bytes when actually doing crypto, but cant
// send raw bytes over JSON or store them in localStorage, we need encode
// and decode helpers between Uint8Array and base64 strings.

/** Encode raw bytes as standard base64 (no line wrapping). */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decode standard base64 to raw bytes. Throws on malformed input via the
 * underlying `atob` call.
 */
function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse a PEM block with the given label back to raw DER bytes. Whitespace
 * (incl. line breaks) inside the block is stripped before base64-decoding.
 *
 * @throws Error if no block with the given label is found.
 */
function pemDecode(label: string, pem: string): Uint8Array {
  const re = new RegExp(
    `-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`,
  );
  const match = pem.match(re);
  if (!match) throw new Error(`PEM missing block: ${label}`);
  return base64Decode(match[1].replace(/\s+/g, ""));
}


/* We use WebCrypto's importKey to turn PEM/DER bytes into a `CryptoKey`.
 * This is the type that `@cloudflare/blindrsa-ts` expects. The CryptoKey
 * also binds algorithm (RSA-PSS) + hash (SHA-384) + allowed operations,
 * so the library cant accidentally misuse the key. */

/**
 * Import an SPKI-PEM public key as a WebCrypto `CryptoKey` usable for
 * RSA-PSS verification AND for the `blind()` operation. The same key
 * object is reused across blind/finalize/verify within one vote flow.
 */
async function importPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  const der = pemDecode("PUBLIC KEY", publicKeyPem);
  return await crypto.subtle.importKey(
    "spki",
    der as BufferSource,
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["verify"],
  );
}

// Public API
/**
 * Generate a fresh cryptographically random 32-byte message.
 *
 * This is the "UUID" the voter holds privately during the issuance phase.
 * After {@link prepare} it becomes the public Vote.id on the server. The
 * server never sees the raw output of this function — only the prepared,
 * blinded form.
 *
 * @returns 32 random bytes from the OS CSPRNG.
 */
export function generateUuid(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * RFC 9474 §4.1 wrap a raw message in the suite's prepare step.
 *
 * For the `Randomized` suite this prepends 32 random bytes to the message;
 *
 * @param msg raw 32-byte message from {@link generateUuid}.
 * @returns the prepared message — store this; it becomes `Vote.id`.
 */
export function prepare(msg: Uint8Array): Uint8Array {
  return SUITE.prepare(msg);
}

/**
 * RFC 9474 §4.2 Blind — blind a prepared message for transmission.
 *
 * The matematical operation is `z = m · r^e mod n` where `m` is the
 * prepared message, `r` is a random blinding factor, and `(n, e)` is the
 * poll's public key. The blinded message `z` reveals nothing about `m`,
 * so the server can sign it without learning what was signed.
 *
 * We will use the inverse of r, so we can use it finalize and get the signed msg. 
 *
 * @param publicKeyPem    the poll's public key (from `/api/poll/:id/open`).
 * @param preparedMessage output of {@link prepare}.
 * @returns base64 of the blinded message + base64 of the blinding inverse.
 */
export async function blind(
  publicKeyPem: string,
  preparedMessage: Uint8Array,
): Promise<BlindResult> {
  const publicKey = await importPublicKey(publicKeyPem);
  const { blindedMsg, inv } = await SUITE.blind(publicKey, preparedMessage);
  return {
    blindedMessageB64: base64Encode(blindedMsg),
    invB64: base64Encode(inv),
  };
}

/**
 * RFC 9474 §4.4 Finalize — turn a blind signature into a real signature.
 *
 * The server returned `s' = z^d mod n` (a signature on the blinded
 * message). Multiplying by `inv = r^(-1)` gives `s = m^d mod n` — a
 * normal RSA-PSS signature on the prepared message, which `verify()`
 * accepts. The server never sees `m` or `s` directly.
 *
 * Discard `invB64` after this call returns successfully.
 *
 * @param publicKeyPem       the poll's public key (same one used in blind).
 * @param preparedMessage    output of {@link prepare} — must be byte-identical
 *   to what was passed to {@link blind}.
 * @param blindSignatureB64  base64 of the server's response to /blindsign.
 * @param invB64             base64 of the blinding inverse from {@link blind}.
 * @returns base64 of the finalized signature, ready to send to /vote.
 */
export async function finalize(
  publicKeyPem: string,
  preparedMessage: Uint8Array,
  blindSignatureB64: string,
  invB64: string,
): Promise<string> {
  const publicKey = await importPublicKey(publicKeyPem);
  const blindSignature = base64Decode(blindSignatureB64);
  const inv = base64Decode(invB64);
  const signature = await SUITE.finalize(
    publicKey,
    preparedMessage,
    blindSignature,
    inv,
  );
  return base64Encode(signature);
}

/**
 * Verify a finalized signature against a prepared message.
 *
 * Used in the "see my vote" flow on the results page: the voter
 * recomputes the expected `currentHash` row, fetches their `Vote.id`
 * from the public results, and confirms the signature is valid under
 * the poll's public key. Returns `false` (never throws) on any failure.
 *
 * Identical semantics to `verify()` in `server_src/blindRsa.ts` —
 * kept duplicated here so the client bundle does not need a server
 * import path.
 *
 * @param publicKeyPem    the poll's public key.
 * @param preparedMessage the bytes that were signed (= `Vote.id`).
 * @param signatureB64    base64 of the finalized signature.
 * @returns `true` iff the signature is a valid RSA-PSS signature.
 */
export async function verify(
  publicKeyPem: string,
  preparedMessage: Uint8Array,
  signatureB64: string,
): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyPem);
    const signature = base64Decode(signatureB64);
    return await SUITE.verify(publicKey, signature, preparedMessage);
  } catch {
    return false;
  }
}
