/**
 * Blind RSA helper — RFC 9474.
 *
 * Wraps `@cloudflare/blindrsa-ts` so the rest of the codebase never has to
 * touch CryptoKey objects, PEM strings, or base64 directly. Three things are
 * exported:
 *
 *  - {@link keygen}    — generate a per-poll keypair (PEM in, PEM out).
 *  - {@link blindSign} — server-side: sign a blinded message with the poll's
 *                       private key. Server never sees the unblinded UUID.
 *  - {@link verify}    — anyone-side: verify that a finalized signature is a
 *                       valid signature on a message under the poll's public
 *                       key. Used by the cast endpoint and by client-side
 *                       "see my vote" verification.
 *
 * The `prepare`, `blind`, and `finalize` halves of the protocol live in the
 * browser (`client_src/...`) and use the same `@cloudflare/blindrsa-ts`
 * package — keep the suite choice (see {@link SUITE}) in sync between client
 * and server, otherwise verify fails silently.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9474 RFC 9474 — RSA Blind Signatures
 * @see https://www.rfc-editor.org/rfc/rfc8017 RFC 8017 — PKCS #1 v2.2 (PSS, MGF1)
 */

import { RSABSSA } from "@cloudflare/blindrsa-ts";

// ---------------------------------------------------------------------------
// Ciphersuite
// ---------------------------------------------------------------------------

/**
 * The RFC 9474 ciphersuite used by both server and client.
 *
 * `RSABSSA-SHA384-PSS-Randomized` — RSA-PSS with SHA-384, MGF1-SHA-384, salt
 * length = hash length (48 bytes), and a randomized `prepare()` step that
 * prepends 32 random bytes to the message before blinding.
 *
 * BEMÆRK (dansk): RFC 9474 §6 anbefaler `Randomized`-varianten frem for
 * `Deterministic`, fordi den giver beskyttelse mod en angriber der prøver at
 * få samme UUID signeret to gange og dermed reducere entropi. For os er
 * msg (= UUID) allerede 32 tilfældige bytes, så `PrepareIdentity` ville
 * også være sikkert nok — men vi følger RFC-anbefalingen for at undgå at
 * skulle forsvare valget i rapporten. Konsekvens: `Vote.id` skal være
 * den *prepared* msg (random_prefix || msg), ikke den rå UUID, fordi det
 * er det `verify()` validerer signaturen imod.
 */
const SUITE = RSABSSA.SHA384.PSS.Randomized();

/** RSA public exponent — 65537 (0x010001). Standard and not negotiable. */
const PUBLIC_EXPONENT = Uint8Array.from([0x01, 0x00, 0x01]);


/**
 * A keypair exported as PEM strings. Suitable for direct storage in
 * `Poll.blindRsaPublicKey` / `Poll.blindRsaPrivateKey`.
 *
 * @property publicKeyPem  SubjectPublicKeyInfo (SPKI) PEM. Safe to publish.
 * @property privateKeyPem PKCS#8 PEM. Server-only — never expose via API.
 */
export interface BlindRsaKeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}



// Since we mosly works with bytes when actual doing work, however we cant
// save the raw bytes to the database so we need a way to encode and decode
// bytes to string. 
/** Encode raw bytes as standard base64 (no line wrapping). */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decode standard base64 to raw bytes. Throws on malformed input via the
 * underlying `atob` call — callers should treat that as a 400 from clients.
 */
function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Wrap raw DER bytes as a PEM block with the given label
 * (e.g. `"PUBLIC KEY"` or `"PRIVATE KEY"`). 64-char line wrapping per RFC 7468.
 */
function pemEncode(label: string, der: Uint8Array): string {
  const b64 = base64Encode(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
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

/* We use WebCrypto's importkey to turn PEM/DER bytes into a 'Cryptokey'
 * This is the type that '@cloudflare/blindrsa-ts' expects. They Cryptokey
 * also binds algorithm (RSA-PSS) + hash (SHA-384) + allowed operations, so the
 * library cant accidentally misuse the key. 

/**
 * Import an SPKI-PEM public key as a WebCrypto `CryptoKey` usable for
 * RSA-PSS verification under the suite's hash. The same `CryptoKey` is what
 * `@cloudflare/blindrsa-ts` accepts for `verify()` and `blind()`.
 */
async function importPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  const der = pemDecode("PUBLIC KEY", publicKeyPem);
  return await crypto.subtle.importKey(
    "spki",
    der as BufferSource,
    { name: "RSA-PSS", hash: "SHA-384" },
    true, // extractable — fine, this is the public side
    ["verify"],
  );
}

/**
 * Import a PKCS#8-PEM private key as a WebCrypto `CryptoKey` usable for
 * blind-signing. Marked extractable so future code can rotate or re-export
 * it; if that becomes a concern, flip to `false` here and regenerate any
 * existing keys.
 */
async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const der = pemDecode("PRIVATE KEY", privateKeyPem);
  return await crypto.subtle.importKey(
    "pkcs8",
    der as BufferSource,
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["sign"],
  );
}

// Which below is the "public" API, used by the server. 
//
/**
 * Generate a fresh RSA keypair for blind-signing a single poll.
 *
 * Call this once per poll at creation time and persist both PEMs on the
 * `Poll` row (`blindRsaPublicKey` + `blindRsaPrivateKey`). The public key is
 * served to clients via `GET /api/poll/:id/open`; the private key must
 * never leave the server.
 *
 * @param modulusLength RSA modulus size in bits. 2048 is the project
 *   default; 3072 or 4096 are valid but slow down `keygen`.
 * @returns the keypair as PEM strings ready for DB storage.
 */
export async function keygen(
  modulusLength = 2048,
): Promise<BlindRsaKeyPairPem> {
  const { publicKey, privateKey } = await SUITE.generateKey({
    publicExponent: PUBLIC_EXPONENT,
    modulusLength,
  });

  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", privateKey),
  );

  return {
    publicKeyPem: pemEncode("PUBLIC KEY", spki),
    privateKeyPem: pemEncode("PRIVATE KEY", pkcs8),
  };
}

/**
 * Server-side blind-signing operation (RFC 9474).
 *
 * Takes the blinded message the client uploaded and returns the blind
 * signature. The server learns nothing about the underlying UUID — that's
 * the whole point.
 *
 * @param privateKeyPem the poll's PKCS#8-PEM private key (from DB).
 * @param blindedMessageB64 base64 of the client-supplied blinded message;
 * @returns base64 of the blind signature, ready to send back to the client.
 * @throws if the key fails to import, or if the underlying suite rejects
 *   the blinded message (malformed, out of range, wrong length).
 */
export async function blindSign(
  privateKeyPem: string,
  blindedMessageB64: string,
): Promise<string> {
  const privateKey = await importPrivateKey(privateKeyPem);
  const blindedMessage = base64Decode(blindedMessageB64);
  const blindSignature = await SUITE.blindSign(privateKey, blindedMessage);
  return base64Encode(blindSignature);
}

/**
 * Verify a finalized blind signature against a message.
 *
 * Used in two places:
 *
 *  1. Server-side at the cast endpoint, before accepting a `Vote`.
 *  2. Client-side in the "verify my vote" flow on the results page.
 *
 * Returns `false` (never throws) on any verification failure — malformed
 * signature, key import error, wrong length, bad signature — so callers
 * can treat it as a pure boolean predicate. Distinguishing "invalid input"
 * from "valid input, bad signature" is not useful here: both mean "reject".
 *
 *
 * @param publicKeyPem the poll's SPKI-PEM public key (from DB or `/open`).
 * @param message the prepared message bytes that were signed.
 * @param signatureB64 base64 of the finalized signature
 * @returns `true` iff the signature is a valid RSA-PSS signature on
 *   `message` under `publicKeyPem`.
 */
export async function verify(
  publicKeyPem: string,
  message: Uint8Array,
  signatureB64: string,
): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyPem);
    const signature = base64Decode(signatureB64);
    return await SUITE.verify(publicKey, signature, message);
  } catch {
    return false;
  }
}
