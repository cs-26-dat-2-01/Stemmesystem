import { useEffect, useState } from "react";
import "./PollResults.css";
import NavBar from "../components/NavBar.tsx";
import type { ResultsPayload, VoteReceipt } from "../WebLib.ts";
import { verify } from "../blindRsa.ts";
import { voteHashMessage } from "../WebLib.ts";

type ViewState =
  | "loading"
  | "ready"
  | "error";

/** Outcome of running self-verification on a single receipt. */
interface VerifyResult {
  uuidB64: string;
  optionId: number;
  castAt: string;
  found: boolean; // vote with this uuid is present in the tally
  hashOk: boolean; // computed sha256 matches the stored currentHash
  signatureOk: boolean; // signature is valid under the poll's public key
  unrecognised?: boolean; // for open votes. A vote attributed to MY userId that this device has no receipt of 
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
  const [timestampVerifyState, setTimestampVerifyState] = useState<
    "idle" | "verifying" | "ok" | "fail"
  >("idle");
  const [timestampVerifyMessage, setTimestampVerifyMessage] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/poll/${pollId}/results`);
        if (res.status === 401) {
          await fetch("/logout", { method: "POST", credentials: "include" });
          globalThis.location.href = "/";
          return;
        }
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

      // Recompute the chain hash. from receipts.
      const hashMsg = voteHashMessage(
        {
          previousHash: row.previousHash,
          uuid: row.uuid,
          optionId: receipt.optionId,
          userId: receipt.userId,
          pollId: pollId,
          ballotPrivacy: data.ballotPrivacy,
          showTopN: data.showTopN,
        },
      );
      const expectedHash = await sha256Hex(hashMsg);
      const hashOk = expectedHash === row.currentHash;

      // Verify the stored signature under the poll's public key. Only for secret poll 
      const preparedBytes = base64Decode(row.uuid);
      const signatureOk = isOpen
        ? true
        : row.signature !== null && data.blindRsaPublicKey !== null
        ? await verify(data.blindRsaPublicKey, preparedBytes, row.signature)
        : false;

      const detail = !hashOk
        ? "Hash matcher ikke (ændring i kæden?)"
        : !isOpen && !signatureOk
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

    // Reverse (open only): votes attributed to MY userId that this device has
    // no receipt for. Could be a server-fabricated vote under my identity or
    // simply one cast from another device / after clearing browser data.
    // Surfaced as a warning, since this device cannot tell the two apart.
    if (data.ballotPrivacy === "open") {
      const myUuids = new Set(myReceipts.map((r) => r.uuidB64));
      const myUserId = myReceipts[0]?.userId;
      if (myUserId !== undefined) {
        for (const v of data.votes) {
          if (v.userId === myUserId && !myUuids.has(v.uuid)) {
            results.push({
              uuidB64: v.uuid,
              optionId: v.optionId,
              castAt: "",
              found: true,
              hashOk: false,
              signatureOk: true,
              unrecognised: true,
              detail:
                "Registreret under dit bruger-id, men ingen kvittering på denne enhed (kan stamme fra en anden enhed).",
            });
          }
        }
      }
    }

    setVerifyResults(results);
    setVerifying(false);
  }

  async function runTimestampVerify() {
    setTimestampVerifyState("verifying");
    setTimestampVerifyMessage("");
    try {
      const res = await fetch(`/api/poll/${pollId}/verify-timestamp`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        setTimestampVerifyState("fail");
        setTimestampVerifyMessage(text || "Timestamp verification failed");
        return;
      }
      const body: { verified: boolean } = await res.json();
      if (body.verified) {
        setTimestampVerifyState("ok");
        setTimestampVerifyMessage("Timestamp verified");
      } else {
        setTimestampVerifyState("fail");
        setTimestampVerifyMessage("Timestamp could not be verified");
      }
    } catch {
      setTimestampVerifyState("fail");
      setTimestampVerifyMessage("Timestamp verification failed");
    }
  }

  // Helper function to determine if shoptopN is shown as sidebar or results.
  function TopNSidebar({ data }: { data: ResultsPayload }) {
    return (
      <>
        <div className="rs-top-title">Top {data.showTopN} resultater</div>
        {data.counts.map((item, i, arr) => {
          const tiedWithPrev = i > 0 && arr[i - 1].rank === item.rank;
          const tiedWithNext = i < arr.length - 1 &&
            arr[i + 1].rank === item.rank;
          const isTied = tiedWithPrev || tiedWithNext;
          const marker = isTied ? "=" : ".";
          return (
            <div key={item.optionId} className="rs-top-item">
              <div className="rs-rank">
                {item.rank}
                {marker} {item.optionText}
              </div>
            </div>
          );
        })}
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

          <div className="rs-close-box">
            <div className="rs-close-row">
              <span className="rs-close-label">Closed at</span>
              <span>{data.closedAt ?? "Not recorded"}</span>
            </div>
            <div className="rs-close-row">
              <span className="rs-close-label">Close commitment</span>
              <code className="rs-close-commitment">
                {data.closeCommitment ?? "Not available"}
              </code>
            </div>
            <div className="rs-close-row">
              <span className="rs-close-label">Timestamp token</span>
              <span>{data.hasCloseTimestampToken ? "Present" : "Missing"}</span>
            </div>
            <button
              type="button"
              className="rs-verify-btn"
              onClick={runTimestampVerify}
              disabled={!data.hasCloseTimestampToken ||
                !data.closeCommitment ||
                timestampVerifyState === "verifying"}
            >
              {timestampVerifyState === "verifying"
                ? "Verifying timestamp..."
                : "Verify timestamp"}
            </button>
            <button
              type="button"
              className="rs-verify-btn"
              onClick={() => {
                globalThis.location.href =
                  `/api/poll/${pollId}/timestamp-token`;
              }}
              disabled={!data.hasCloseTimestampToken}
            >
              Download response (.tsr)
            </button>
            <button
              type="button"
              className="rs-verify-btn"
              onClick={() => {
                globalThis.location.href =
                  `/api/poll/${pollId}/timestamp-query`;
              }}
              disabled={!data.hasCloseTimestampQuery}
            >
              Download request (.tsq)
            </button>
            {timestampVerifyState !== "idle" && (
              <div
                className={`rs-close-status ${
                  timestampVerifyState === "ok" ? "ok" : "fail"
                }`}
              >
                {timestampVerifyMessage}
              </div>
            )}
          </div>

          <div className="rs-nonvoters">
            {data.ballotPrivacy === "secret"
              ? (
                <>
                  <p>
                    {data.nonVoterCount} af {data.eligibleCount}{" "}
                    stemmeberettigede har ikke anmodet om en stemmeseddel.
                  </p>
                  <p className="rs-nonvoter-note">
                    I anonyme afstemninger er dette det tætteste systemet kan
                    komme på "har ikke stemt".
                  </p>
                </>
              )
              : data.nonVoters.length === 0
              ? <p>Alle stemmeberettigede har stemt.</p>
              : (
                <>
                  <p>
                    {data.nonVoters.length} af {data.eligibleCount}{" "}
                    har ikke stemt:
                  </p>
                  <ul className="rs-nonvoter-list">
                    {data.nonVoters.map((v) => (
                      <li key={v.userId}>{v.username}</li>
                    ))}
                  </ul>
                </>
              )}
          </div>

          <table className="rs-table">
            <thead>
              <tr>
                <th>Id</th>
                {isOpen && <th>Bruger</th>}
                <th>Stemme</th>
                <th>Hash</th>
              </tr>
            </thead>
            <tbody>
              {votes.map((vote, i) => {
                const openVote = isOpen
                  ? (vote as Extract<
                    typeof data,
                    { ballotPrivacy: "open" }
                  >["votes"][number])
                  : null;
                return (
                  <tr key={i}>
                    <td>{vote.uuid}</td>
                    {openVote && (
                      <td>
                        {openVote.username} (id: {openVote.userId ?? "—"})
                      </td>
                    )}
                    <td>{openVote ? openVote.optionText : "Skjult"}</td>
                    <td>{vote.currentHash}</td>
                  </tr>
                );
              })}
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
              {isOpen && (
                <p className="rs-verify-note">
                  Bemærk: verificering bygger på kvitteringer gemt lokalt i
                  denne browser. Stemmer afgivet fra en anden enhed — eller hvis
                  browserdata er ryddet — kan ikke verificeres her og markeres
                  med !.
                </p>
              )}
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
                    if (r.unrecognised) {
                      return (
                        <li key={i} className="warn">
                          <strong>!</strong> {r.detail}
                          <div className="rs-verify-meta">
                            UUID: {r.uuidB64.slice(0, 16)}…
                          </div>
                        </li>
                      );
                    }
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
