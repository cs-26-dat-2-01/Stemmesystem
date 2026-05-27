import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import "./BallotPage.css";
import { calculateTimeRemaining } from "../WebLib.ts";
import type { Poll, PollOption, VoteReceipt } from "../WebLib.ts";
import { Link } from "react-router/internal/react-server-client";
import { blind, finalize, generateUuid, prepare } from "../blindRsa.ts";

type ViewState =
  | "loading" // loading poll-data
  | "ready" // Show options + radio buttons.
  | "confirming" // "Are you sure?
  | "submitting" // send POST /vote
  | "done" // success! Show receipt!
  | "error"; // Something went wrong, and show to user.

interface BallotPageProps {
  pollId: number;
}

function BallotPage({ pollId }: BallotPageProps) {
  // Statevariables
  const [viewState, setViewState] = useState<ViewState>("loading");
  const [poll, setPoll] = useState<Poll | null>(null);
  const [options, setOptions] = useState<PollOption[]>([]);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [votesRemaining, setVotesRemaining] = useState<number>(0);
  const [timeleft, setTimeleft] = useState<string>("");
  const [voteAllocations, setVoteAllocations] = useState<
    Record<number, number>
  >({});
  // PEM public key for this poll — needed for blind/finalize on the client.
  const [blindRsaPublicKey, setBlindRsaPublicKey] = useState<string>("");
  const [userId, setUserId] = useState<number | null>(null);

  useEffect(() => {
    async function openPoll() {
      const resOpen = await fetch(`/api/poll/${pollId}/open`, {
        method: "POST",
        credentials: "include",
      });

      if (resOpen.status === 401) {
        await fetch("/logout", { method: "POST", credentials: "include" });
        globalThis.location.href = "/";
        return;
      }

      if (resOpen.status === 200) {
        const dataOpen = await resOpen.json();
        console.log("Open succeeded:", dataOpen);
        setPoll(dataOpen.poll);
        setOptions(dataOpen.options);
        setVotesRemaining(dataOpen.votesRemaining);
        setBlindRsaPublicKey(dataOpen.blindRsaPublicKey);
        setUserId(dataOpen.userId);
        setTimeleft(calculateTimeRemaining(dataOpen.poll.endsAt));
        setViewState("ready");
      } else {
        setErrorMessage("Kunne ikke indlæse afstemning");
        setViewState("error");
        console.log("Open failed:", resOpen.status);
      }
    }
    openPoll();
  }, [pollId]); // Useeffect runs openPoll again if pollid changes.

  useEffect(() => {
    if (!poll?.endsAt) return;
    const interval = setInterval(() => {
      const timeleft: string = calculateTimeRemaining(poll?.endsAt);
      setTimeleft(timeleft);
    }, 1000);
    return () => clearInterval(interval);
  }), [poll?.endsAt];

  let allocatedVotes = 0;
  for (const count of Object.values(voteAllocations)) {
    allocatedVotes += count;
  }

  const remainingToAllocate = votesRemaining - allocatedVotes;
  const hasMultipleVotes = votesRemaining > 1;
  const canSubmit = hasMultipleVotes
    ? allocatedVotes > 0 && remainingToAllocate === 0
    : selectedOption !== null; // if the user does not have multiplevotes, the user can submit when the user has selected an option

  if (viewState === "loading") {
    return (
      <>
        <NavBar />
        <div className="ballot-container">
          <div className="ballot-loading">
            <h2>Indlæser afstemning...</h2>
            <div className="ballot-spinner"></div>
          </div>
        </div>
      </>
    );
  }
  if (viewState === "ready") {
    return (
      <>
        <NavBar />
        <div className="ballot-container">
          <div className="ballot-content">
            <h1 className="ballot-title">{poll!.title}</h1>

            <div className="ballot-description">{poll!.description}</div>

            <div className="ballot-meta">
              {poll!.endsAt && <p>Afstemningen lukker: {poll!.endsAt}</p>}
            </div>
            <div className="ballot-meta">
              <p>Du har {votesRemaining} stemmer i denne afstemning</p>
            </div>

            <div className="ballot-meta">
              <p>Tid tilbage: {timeleft}</p>
            </div>

            <div className="ballot-options">
              {votesRemaining <= 0
                ? <p>Du har allerede brugt alle dine stemmer.</p>
                : hasMultipleVotes
                ? (
                  options.map((option) => (
                    <label key={option.id} className="ballot-option">
                      <span>{option.optionText}</span>
                      <input
                        type="number"
                        min={0}
                        max={votesRemaining - allocatedVotes +
                          (voteAllocations[option.id] ?? 0)}
                        value={voteAllocations[option.id] ?? 0}
                        onChange={(e) => {
                          const nextValue = Number(e.target.value);

                          setVoteAllocations((prev) => ({
                            ...prev,
                            [option.id]: nextValue,
                          }));
                        }}
                      />
                    </label>
                  ))
                )
                : (
                  options.map((option) => (
                    <label key={option.id} className="ballot-option">
                      <input
                        type="radio"
                        name="pollOption"
                        value={option.id}
                        checked={selectedOption === option.id}
                        onChange={() =>
                          setSelectedOption(option.id)}
                      />
                      {option.optionText}
                    </label>
                  ))
                )}
            </div>

            <button
              type="submit"
              className="ballot-submit"
              disabled={!canSubmit}
              onClick={() => setViewState("confirming")}
            >
              Afgiv stemme
            </button>
          </div>
        </div>
      </>
    );
  }

  if (viewState === "confirming") {
    const selectedText = options.find(
      (o) => o.id === selectedOption,
    )?.optionText;

    const selectedAllocations = options
      .map((option) => ({
        option,
        count: voteAllocations[option.id] ?? 0,
      }))
      .filter(({ count }) => count > 0);

    return (
      <>
        <NavBar />
        <div className="ballot-container">
          <div className="ballot-confirm-card">
            {hasMultipleVotes
              ? (
                <>
                  <p>Du er ved at afgive følgende stemmer:</p>
                  <ul>
                    {selectedAllocations.map(({ option, count }) => (
                      <li key={option.id}>
                        {option.optionText}: {count}
                      </li>
                    ))}
                  </ul>
                </>
              )
              : (
                <p>
                  Du er ved at stemme på <strong>{selectedText}</strong>
                </p>
              )}

            <p>Vil du bekræfte?</p>

            <div className="ballot-confirm-buttons">
              <button className="ballot-btn-yes" onClick={submitVote}>
                Ja
              </button>
              <button
                type="button"
                className="ballot-btn-no"
                onClick={() => setViewState("ready")}
              >
                Nej
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (viewState === "submitting") {
    return (
      <>
        <NavBar />
        <div className="ballot-container">
          <div className="ballot-loading">
            <h2>Afgiver stemme...</h2>
            <div className="ballot-spinner"></div>
          </div>
        </div>
      </>
    );
  }
  if (viewState === "done") {
    return (
      <>
        <NavBar />
        <div className="ballot-container">
          <div className="ballot-done">
            <h2>Tak for din stemme!</h2>
            <p>Din stemme er blevet registreret.</p>
            <Link to="/" className="ballot-back-link">
              Tilbage til oversigten
            </Link>
          </div>
        </div>
      </>
    );
  }
  if (viewState === "error") {
    return (
      <>
        <NavBar />
        <div className="ballot-container">
          <div className="ballot-error">
            <h2>Noget gik galt</h2>
            <p>{errorMessage || "Ukendt fejl."}</p>
            <Link to="/" className="ballot-back-link">
              Tilbage til oversigten
            </Link>
          </div>
        </div>
      </>
    );
  }

  async function submitVote() {
    setViewState("submitting");

    const optionIds: number[] = hasMultipleVotes
      ? Object.entries(voteAllocations).flatMap(([optionId, count]) =>
        Array.from({ length: count }, () => Number(optionId))
      )
      : selectedOption === null
      ? []
      : [selectedOption];

    // Branch on the poll's stored privacy: open = identified batch cast in one cast 
    try {
      const newReceipts = poll?.ballotPrivacy === "open"
        ? await castOpen(optionIds)
        : await castSecret(optionIds);
      saveReceipts(newReceipts);
      setViewState("done");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Unknown error");
      setViewState("error");
    }
  }

  // Secret: per-vote blind → issue → finalize → ANONYMOUS cast.
  async function castSecret(optionIds: number[]): Promise<VoteReceipt[]> {
    const newReceipts: VoteReceipt[] = [];
    for (const optionId of optionIds) {
      const preparedMessage = prepare(generateUuid());
      const { blindedMessageB64, invB64 } = await blind(
        blindRsaPublicKey,
        preparedMessage,
      );
      const issueRes = await fetch(`/api/poll/${pollId}/blindsign`, {
        method: "POST",
        credentials: "include", // JWT cookie required for issuance
        body: JSON.stringify({ blinded: blindedMessageB64 }),
        headers: { "Content-Type": "application/json" },
      });
      if (issueRes.status !== 200) {
        throw new Error(`Issuance failed: ${await issueRes.text()}`);
      }
      const { blindSig } = await issueRes.json();
      const signatureB64 = await finalize(
        blindRsaPublicKey,
        preparedMessage,
        blindSig,
        invB64,
      );
      const uuidB64 = base64Encode(preparedMessage);
      const castRes = await fetch(`/api/poll/${pollId}/vote`, {
        method: "POST",
        credentials: "omit",
        body: JSON.stringify({
          uuid: uuidB64,
          signature: signatureB64,
          optionId,
        }),
        headers: { "Content-Type": "application/json" },
      });
      if (castRes.status !== 200) {
        throw new Error(`Cast failed: ${await castRes.text()}`);
      }

      newReceipts.push({
        pollId,
        optionId,
        uuidB64,
        signatureB64,
        castAt: new Date().toISOString(),
      });
    }
    return newReceipts;
  }

  // Open: no blind RSA. Generate a uuid per vote (same format as secret so it
  // matches Vote.id + the hash), then send the whole batch in ONE request WITH
  // the JWT cookie — the server derives userId from it. Receipts carry userId
  // (for self-verify) and no signature.
  async function castOpen(optionIds: number[]): Promise<VoteReceipt[]> {
    const castAt = new Date().toISOString();
    const receipts: VoteReceipt[] = [];
    const votes = optionIds.map((optionId) => {
      const uuidB64 = base64Encode(prepare(generateUuid()));
      receipts.push({
        pollId,
        optionId,
        uuidB64,
        userId: userId ?? undefined,
        castAt,
      });
      return { uuid: uuidB64, optionId };
    });

    const castRes = await fetch(`/api/poll/${pollId}/vote`, {
      method: "POST",
      credentials: "include", // JWT needed — server derives userId from it
      body: JSON.stringify({ votes }),
      headers: { "Content-Type": "application/json" },
    });
    if (castRes.status !== 200) {
      throw new Error(`Cast failed: ${await castRes.text()}`);
    }
    return receipts;
  }
}

/** Encode raw bytes as standard base64 — small inline helper for the cast body. */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Append the given receipts to the persistent list in localStorage. */
function saveReceipts(newReceipts: VoteReceipt[]): void {
  const key = "vote-receipts";
  try {
    const stored = localStorage.getItem(key);
    const existing: VoteReceipt[] = stored ? JSON.parse(stored) : [];
    existing.push(...newReceipts);
    localStorage.setItem(key, JSON.stringify(existing));
  } catch (err) {
    // localStorage can fail (private mode quotas, disabled storage). The
    // votes are already cast on the server — losing the receipt only
    // costs the user their "verify my vote" capability.
    console.warn("Failed to persist vote receipts:", err);
  }
}

export default BallotPage;
