import { useEffect, useState } from "react";
import "./PollResults.css";
import NavBar from "../components/NavBar.tsx";
import type { ResultsPayload } from "../WebLib.ts";
import { verify } from "../blindRsa.ts";

type ViewState =
  | "loading"
  | "ready"
  | "error";

/**
 * Local "receipt" persisted by BallotPage after a successful vote.
 * Mirrors the shape there — kept in sync manually since the two pages
 * exchange data through localStorage, not through a shared type.
 */
interface VoteReceipt {
  pollId: number;
  optionId: number;
  uuidB64: string;
  signatureB64: string;
  castAt: string;
}

/** Outcome of running self-verification on a single receipt. */
interface VerifyResult {
  uuidB64: string;
  optionId: number;
  castAt: string;
  found: boolean; // vote with this uuid is present in the tally
  hashOk: boolean; // computed sha256 matches the stored currentHash
  signatureOk: boolean; // signature is valid under the poll's public key
  detail?: string; // human-readable error when something failed
}

interface PollResultsProps {
  pollId: number;
}

function PollResults({ pollId }: PollResultsProps) {
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [errorMessage] = useState("");
  const [data, setData] = useState<ResultsPayload | null>(null);
  const [myReceipts, setMyReceipts] = useState<VoteReceipt[]>([]);
  const [verifyResults, setVerifyResults] = useState<VerifyResult[] | null>(
    null,
  );
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/poll/${pollId}/results`);
        if (!res.ok) {
          setViewState("error");
          return;
        }
        const json: ResultsPayload = await res.json();
        setData(json);
        setViewState("ready");
      } catch {
        setViewState("error");
      }
    })();
  }, [pollId]);

  // Load local receipts for this poll once we're on the page. Other polls'
  // receipts stay in storage untouched.
  useEffect(() => {
    try {
      const stored = localStorage.getItem("unf-vote-receipts");
      if (!stored) return;
      const all: VoteReceipt[] = JSON.parse(stored);
      setMyReceipts(all.filter((r) => r.pollId === pollId));
    } catch (err) {
      console.warn("Failed to load vote receipts:", err);
    }
  }, [pollId]);

  if (viewState === "loading") {
    return (
      <>
        <NavBar />
        <div className="rs-layout">
          <div className="rs-main">Indlæser resultater...</div>
        </div>
      </>
    );
  }
  if (viewState === "error") {
    return (
      <>
        <NavBar />
        <div className="rs-layout">
          <div className="rs-main">
            <h2>Fejl</h2>
            <p>{errorMessage}</p>
          </div>
        </div>
      </>
    );
  }

  if (!data) return null;

  const isOpen = data.ballotPrivacy === "open";
  const votes = data.votes;

  /**
   * Self-verify each local receipt against the public results.
   *
   * For each receipt the user holds locally, we:
   *   1. Find the matching row in the results by `uuid`.
   *   2. Recompute `sha256(prev|uuid|optionId|pollId)` and compare to the
   *      row's `currentHash`. The hash chain is publicly verifiable, so
   *      any tampering with previous votes would break this match.
   *   3. Verify the row's RSA-PSS signature under the poll's public key,
   *      using the prepared-message bytes recovered from the base64 uuid.
   *
   * Everything runs client-side! server is not contacted during verify.
   */
  async function runSelfVerify() {
    if (!data) return;
    setVerifying(true);
    const results: VerifyResult[] = [];

    for (const receipt of myReceipts) {
      const row = data.votes.find((v) => v.uuid === receipt.uuidB64);
      if (!row) {
        results.push({
          uuidB64: receipt.uuidB64,
          optionId: receipt.optionId,
          castAt: receipt.castAt,
          found: false,
          hashOk: false,
          signatureOk: false,
          detail: "UUID ikke fundet i resultaterne",
        });
        continue;
      }

      // Recompute the chain hash. Format must match server's createVoteHash.
      const hashMsg =
        `PreviousHash:${row.previousHash}|UUID:${row.uuid}|pollOptionId:${receipt.optionId}|pollId:${pollId}`;
      const expectedHash = await sha256Hex(hashMsg);
      const hashOk = expectedHash === row.currentHash;

      // Verify the stored signature under the poll's public key. We pass
      // the raw prepared-message bytes (decoded from base64) — that's what
      // the signature is over.
      const preparedBytes = base64Decode(row.uuid);
      const signatureOk = await verify(
        data.blindRsaPublicKey,
        preparedBytes,
        row.signature,
      );

      const detail = !hashOk
        ? "Hash matcher ikke (ændring i kæden?)"
        : !signatureOk
        ? "Signatur er ugyldig"
        : undefined;

      results.push({
        uuidB64: receipt.uuidB64,
        optionId: receipt.optionId,
        castAt: receipt.castAt,
        found: true,
        hashOk,
        signatureOk,
        detail,
      });
    }

    setVerifyResults(results);
    setVerifying(false);
  }

  // Helper function to determine if shoptopN is shown as sidebar or results.
  function TopNSidebar({ data }: { data: ResultsPayload }) {
    return (
      <>
        <div className="rs-top-title">Top {data.showTopN} resultater</div>
        {data.counts.map((item, i) => (
          <div key={item.optionId} className="rs-top-item">
            <div className="rs-rank">{i + 1}. {item.optionText}</div>
          </div>
        ))}
      </>
    );
  }

  function FullResultsSidebar({ data }: { data: ResultsPayload }) {
    // Compute max once — counts are guaranteed non-null in full-results mode
    const max = Math.max(...data.counts.map((c) => c.count ?? 0), 1);
    return (
      <>
        <div className="rs-top-title">Resultater</div>
        {data.counts.map((item) => (
          <div key={item.optionId} className="rs-top-item">
            <div>{item.optionText}</div>
            <div className="rs-bar-wrapper">
              <div
                className="rs-bar-fill"
                style={{ width: `${((item.count ?? 0) / max) * 100}%` }}
              />
            </div>
            <div className="rs-meta">{item.count} stemmer</div>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <NavBar />

      <div className="rs-layout">
        {/* List of votes */}
        <div className="rs-main">
          <h2 className="rs-title">Resultat af afstemning</h2>

          <table className="rs-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Stemme</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {votes.map((vote, i) => (
                <tr key={i}>
                  <td>{vote.uuid}</td>
                  <td>
                    {isOpen
                      ? (vote as Extract<
                        typeof data,
                        { ballotPrivacy: "open" }
                      >["votes"][number]).optionText
                      : "Skjult"}
                  </td>
                  <td>{vote.currentHash}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {myReceipts.length > 0 && (
            <div className="rs-verify">
              <h3>Verificér mine stemmer</h3>
              <p>
                Du har {myReceipts.length} kvittering
                {myReceipts.length === 1 ? "" : "er"}{" "}
                gemt lokalt for denne afstemning. Klik for at tjekke at de er
                korrekt registreret og at hash-kæden er intakt.
              </p>
              <button
                type="button"
                className="rs-verify-btn"
                onClick={runSelfVerify}
                disabled={verifying}
              >
                {verifying ? "Verificerer..." : "Verificér"}
              </button>

              {verifyResults && (
                <ul className="rs-verify-list">
                  {verifyResults.map((r, i) => {
                    const allOk = r.found && r.hashOk && r.signatureOk;
                    return (
                      <li key={i} className={allOk ? "ok" : "fail"}>
                        <strong>{allOk ? "✓" : "✗"}</strong> Stemme {i + 1}:
                        {" "}
                        {allOk ? "Verificeret" : r.detail}
                        <div className="rs-verify-meta">
                          UUID: {r.uuidB64.slice(0, 16)}…
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Right sidebar that shows topN votes */}
        <div className="rs-sidebar">
          <div className="rs-top-box">
            {data.showTopN > 0
              ? <TopNSidebar data={data} />
              : <FullResultsSidebar data={data} />}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * SHA-256 of a UTF-8 string, returned as lowercase hex — matches the
 * `createHash("sha256").update(...).digest("hex")` format the server
 * stores in `Vote.currentHash`.
 */
async function sha256Hex(message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode standard base64 → bytes. */
function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export default PollResults;
