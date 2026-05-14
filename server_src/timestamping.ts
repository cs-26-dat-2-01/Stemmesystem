import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";

const DEFAULT_TSA_URL = "https://freetsa.org/tsr";
const CERT_DIR = "./server_certs";
const TSA_CERT_PATH = `${CERT_DIR}/tsa.crt`;
const CA_CERT_PATH = `${CERT_DIR}/cacert.pem`;
const TSA_CERT_URL = "https://freetsa.org/files/tsa.crt";
const CA_CERT_URL = "https://freetsa.org/files/cacert.pem";

export async function ensureTsaCertificates(): Promise<void> {
  await Deno.mkdir(CERT_DIR, { recursive: true });
  await ensureCertificateFile(TSA_CERT_PATH, TSA_CERT_URL);
  await ensureCertificateFile(CA_CERT_PATH, CA_CERT_URL);
}

export async function timestampCommitment(
  closeCommitment: string,
): Promise<Uint8Array> {
  const tsaUrl = env.FREETSA_URL?.trim() || DEFAULT_TSA_URL;
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
    const response = await fetch(tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
      },
      body: requestBytes,
    });

    if (!response.ok) {
      throw new Error(`FreeTSA returned HTTP ${response.status}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error`timestampCommitment failed: ${msg}`;
    throw err;
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
}

export async function verifyTimestampCommitment(
  closeCommitment: string,
  timestampToken: Uint8Array,
): Promise<boolean> {
  const tempDir = await Deno.makeTempDir({ prefix: "unf-tsa-verify-" });
  const dataPath = `${tempDir}/close-commitment.txt`;
  const responsePath = `${tempDir}/response.tsr`;

  try {
    await Deno.writeTextFile(dataPath, closeCommitment);
    await Deno.writeFile(responsePath, timestampToken);

    const verifyResult = await new Deno.Command("openssl", {
      args: [
        "ts",
        "-verify",
        "-in",
        responsePath,
        "-data",
        dataPath,
        "-CAfile",
        CA_CERT_PATH,
        "-untrusted",
        TSA_CERT_PATH,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (!verifyResult.success) {
      const stderr = new TextDecoder().decode(verifyResult.stderr);
      logger.error`verifyTimestampCommitment failed: ${stderr.trim()}`;
      return false;
    }

    return true;
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => undefined);
  }
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
