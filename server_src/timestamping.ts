import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";

const CERT_DIR = "./server_certs";
const FREETSA_CA_PATH = `${CERT_DIR}/cacert.pem`;
const FREETSA_TSA_PATH = `${CERT_DIR}/tsa.crt`;
const FREETSA_CA_URL = "https://freetsa.org/files/cacert.pem";
const FREETSA_TSA_URL = "https://freetsa.org/files/tsa.crt";

/** Per-TSA request timeout before falling through to the next TSA. */
const TSA_TIMEOUT_MS = Number(env.TSA_TIMEOUT_MS) || 4000;

/**
 * Candidate locations for the OS trusted-root bundle, used to verify tokens
 * from publicly-trusted TSAs (DigiCert et al.) whose roots ship with the OS.
 * Override with `TSA_SYSTEM_CA_BUNDLE` if the server keeps it elsewhere.
 */
const SYSTEM_CA_CANDIDATES = [
  env.TSA_SYSTEM_CA_BUNDLE?.trim(),
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu/Arch
  "/etc/pki/tls/certs/ca-bundle.crt", // Fedora/RHEL
  "/etc/ssl/cert.pem", // Alpine/macOS
].filter((p): p is string => Boolean(p));

interface Tsa {
  /** Stable identifier persisted on the poll so verify can pin the right root. */
  name: string;
  /** RFC 3161 endpoint that accepts `application/timestamp-query`. */
  url: string;
  /**
   * Trusted root(s) for `openssl ts -verify -CAfile`. The literal `"system"`
   * resolves to the OS bundle at verify time; otherwise an explicit PEM path.
   */
  caFile: string;
  /** Optional intermediate/TSA cert, for a TSA whose root isn't public (freetsa). */
  untrusted?: string;
}

/**
 * Ordered TSA fallback chain. freetsa is tried first (non-profit, the trust
 * anchor we bundle); DigiCert is the fallback when freetsa is unreachable. The
 * primary endpoint stays overridable via `FREETSA_URL`. A close pays up to
 * `TSA_TIMEOUT_MS` per failed TSA before moving on, so while freetsa is down
 * each close waits that long before DigiCert answers.
 */
const TSAS: Tsa[] = [
  {
    name: "freetsa",
    url: env.FREETSA_URL?.trim() || "https://freetsa.org/tsr",
    caFile: FREETSA_CA_PATH,
    untrusted: FREETSA_TSA_PATH,
  },
  {
    name: "digicert",
    url: "http://timestamp.digicert.com",
    caFile: "system",
  },
];

/**
 * Ensures the freetsa certificates needed for verifying historical tokens are
 * present. Public-CA TSAs verify against the system bundle and need no
 * download. The download is a best-effort bootstrap: if freetsa is unreachable
 * but the certs are already present (committed under `server_certs/`), startup
 * proceeds with a warning rather than failing.
 */
export async function ensureTsaCertificates(): Promise<void> {
  await Deno.mkdir(CERT_DIR, { recursive: true });
  await ensureCertificateFile(FREETSA_CA_PATH, FREETSA_CA_URL).catch((err) => {
    logger.warn`Could not refresh freetsa CA cert (using cached if present): ${
      errMsg(err)
    }`;
  });
  await ensureCertificateFile(FREETSA_TSA_PATH, FREETSA_TSA_URL).catch(
    (err) => {
      logger
        .warn`Could not refresh freetsa TSA cert (using cached if present): ${
        errMsg(err)
      }`;
    },
  );
}

/**
 * Obtains an RFC 3161 timestamp for a poll's close commitment, trying each TSA
 * in {@link TSAS} in order until one answers.
 *
 * @remarks
 * The commitment is hashed (SHA-256) into a `.tsq` request via `openssl ts
 * -query`. The query is independent of the TSA, so it is built once and reused
 * for every fallback attempt. Each TSA is POSTed with a {@link TSA_TIMEOUT_MS}
 * timeout; the first success returns its `.tsr` token along with the original
 * query and the `name` of the TSA that signed it — the caller persists that
 * name so {@link verifyTimestampCommitment} can pin the matching root. Temporary
 * files live under a per-call temp directory removed in `finally`.
 *
 * Requires the `openssl` binary on `PATH` and at least one reachable TSA.
 *
 * @param closeCommitment - Hex-encoded close commitment to be timestamped.
 * @returns The RFC 3161 query, the TSA-signed token, and the signing TSA's name.
 * @throws If `openssl ts -query` fails or every TSA in the chain fails.
 */
export async function timestampCommitment(
  closeCommitment: string,
): Promise<{
  timestampQuery: Uint8Array;
  timestampToken: Uint8Array;
  tsaName: string;
}> {
  const tempDir = await Deno.makeTempDir({ prefix: "unf-tsa-" });
  const dataPath = `${tempDir}/close-commitment.txt`;
  const requestPath = `${tempDir}/request.tsq`;

  try {
    await Deno.writeTextFile(dataPath, closeCommitment);

    const queryResult = await new Deno.Command("openssl", {
      args: [
        "ts",
        "-query",
        "-data",
        dataPath,
        "-sha256",
        "-cert",
        "-out",
        requestPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!queryResult.success) {
      const stderr = new TextDecoder().decode(queryResult.stderr);
      throw new Error(`openssl ts -query failed: ${stderr.trim()}`);
    }

    const requestBytes = await Deno.readFile(requestPath);

    const failures: string[] = [];
    for (const tsa of TSAS) {
      try {
        const response = await fetch(tsa.url, {
          method: "POST",
          headers: { "Content-Type": "application/timestamp-query" },
          body: requestBytes,
          signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const timestampToken = new Uint8Array(await response.arrayBuffer());
        logger.info`Timestamped close commitment via ${tsa.name} (${tsa.url})`;
        return {
          timestampQuery: new Uint8Array(requestBytes),
          timestampToken,
          tsaName: tsa.name,
        };
      } catch (err) {
        const msg = errMsg(err);
        failures.push(`${tsa.name}: ${msg}`);
        logger
          .warn`TSA ${tsa.name} (${tsa.url}) failed: ${msg}; trying next TSA`;
      }
    }

    throw new Error(`All TSAs failed: ${failures.join("; ")}`);
  } catch (err) {
    logger.error`timestampCommitment failed: ${errMsg(err)}`;
    throw err;
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
}

/**
 * Verifies a timestamp token against the poll's close commitment, using
 * `openssl ts -verify` and the root(s) pinned for the TSA that signed it.
 *
 * @remarks
 * The TSA is resolved from `tsaName`; a `null` name means a pre-tracking poll,
 * all of which were stamped by freetsa. freetsa verifies against its bundled
 * root plus its TSA cert (`-untrusted`); publicly-trusted TSAs verify against
 * the system CA bundle, since the token already carries its signer chain.
 * Verification succeeds only if the token chains to the pinned root *and* its
 * hash matches the commitment. The temp directory is removed in `finally`.
 *
 * Requires the `openssl` binary on `PATH`.
 *
 * @param closeCommitment - Hex-encoded close commitment originally timestamped.
 * @param timestampToken - The RFC 3161 timestamp token bytes.
 * @param tsaName - Name of the signing TSA, or `null` for legacy freetsa tokens.
 * @returns `true` if verification succeeds, `false` otherwise (errors logged).
 */
export async function verifyTimestampCommitment(
  closeCommitment: string,
  timestampToken: Uint8Array,
  tsaName: string | null,
): Promise<boolean> {
  const resolvedName = tsaName ?? "freetsa";
  const tsa = TSAS.find((t) => t.name === resolvedName);
  if (!tsa) {
    logger.error`verifyTimestampCommitment: unknown TSA "${resolvedName}"`;
    return false;
  }

  const caFile = tsa.caFile === "system"
    ? await resolveSystemCaBundle()
    : tsa.caFile;
  if (!caFile) {
    logger
      .error`verifyTimestampCommitment: no CA bundle available for ${tsa.name}`;
    return false;
  }

  const tempDir = await Deno.makeTempDir({ prefix: "unf-tsa-verify-" });
  const dataPath = `${tempDir}/close-commitment.txt`;
  const responsePath = `${tempDir}/response.tsr`;

  try {
    await Deno.writeTextFile(dataPath, closeCommitment);
    await Deno.writeFile(responsePath, timestampToken);

    const args = [
      "ts",
      "-verify",
      "-in",
      responsePath,
      "-data",
      dataPath,
      "-CAfile",
      caFile,
    ];
    if (tsa.untrusted) args.push("-untrusted", tsa.untrusted);

    const verifyResult = await new Deno.Command("openssl", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!verifyResult.success) {
      const stderr = new TextDecoder().decode(verifyResult.stderr);
      logger
        .error`verifyTimestampCommitment (${tsa.name}) failed: ${stderr.trim()}`;
      return false;
    }

    return true;
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
}

let cachedSystemCaBundle: string | null | undefined;

/** Resolves (and caches) the first existing OS trusted-root bundle, or null. */
async function resolveSystemCaBundle(): Promise<string | null> {
  if (cachedSystemCaBundle !== undefined) return cachedSystemCaBundle;
  for (const candidate of SYSTEM_CA_CANDIDATES) {
    try {
      await Deno.stat(candidate);
      cachedSystemCaBundle = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  cachedSystemCaBundle = null;
  return null;
}

async function ensureCertificateFile(
  filePath: string,
  downloadUrl: string,
): Promise<void> {
  try {
    await Deno.stat(filePath);
    return;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download TSA certificate from ${downloadUrl}: HTTP ${response.status}`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Deno.writeFile(filePath, bytes);
  logger.info`Downloaded TSA certificate to ${filePath}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
