import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";

const DEFAULT_TSA_URL = "https://freetsa.org/tsr";

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
