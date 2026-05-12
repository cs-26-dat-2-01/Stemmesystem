import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import "./BallotPage.css";
import type { Poll, PollOption } from "../WebLib.ts";
import { Link } from "react-router/internal/react-server-client";
import { blind, finalize, generateUuid, prepare } from "../blindRsa.ts";

/* What i can see is i can make a "render screen" where we create the UUID, and send it back to the server, we then
use useEffect from React to do all of this, and then use useState to rerender the page.
We will follow the basic steps:
1. First render --> poll is null --> Return <p> generating UUID and loading vote! <p>
2. useEffect runs after 1. and first generates a UUID, and then fetches the POST /open
3. Data arrives --> vi use a function called setPoll() to trigger a re-render where we renders.
4. Second render --> poll exists --> return the poll and buttons to vote
5. User click "Vote" and a new render comes up with "are you sure, you have voted for: ", and user confirms.
6. When user confirms it shows a fourth render with "Waiting confirmation.." and it does a POST /vote
7. The client receives a "OK" and a final fith renders show "You vote has been received, and a UUID:"
The following "states" is described in the type ViewState below
*/

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
  const [voteAllocations, setVoteAllocations] = useState<
    Record<number, number>
  >({});
  // PEM public key for this poll — needed for blind/finalize on the client.
  // Empty until /open responds.
  const [blindRsaPublicKey, setBlindRsaPublicKey] = useState<string>("");

  useEffect(() => {
    // INDRE async funktion — HER må vi gerne bruge await
    async function openPoll() {
      const resOpen = await fetch(`/api/poll/${pollId}/open`, {
        method: "POST",
        credentials: "include",
      });

      if (resOpen.status === 200) {
        const dataOpen = await resOpen.json();
        console.log("Open succeeded:", dataOpen);
        setPoll(dataOpen.poll);
        setOptions(dataOpen.options);
        setVotesRemaining(dataOpen.votesRemaining);
        setBlindRsaPublicKey(dataOpen.blindRsaPublicKey);
        setViewState("ready");
      } else {
        setErrorMessage("Kunne ikke indlæse afstemning");
        setViewState("error");
        console.log("Open failed:", resOpen.status);
      }
    }

    // Kald den INDRE funktion med det samme
    openPoll();
  }, [pollId]); // change if pollId changes.

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
            <p>Genererer UUID</p>
            <p>Henter stemmeseddel</p>
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
                        max={votesRemaining}
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

    // Flatten the user's selection into one optionId per vote to cast.
    // For single-vote polls there's exactly one entry; for multi-vote polls
    // we have N entries, each representing one independent vote.
    const optionIds: number[] = hasMultipleVotes
      ? Object.entries(voteAllocations).flatMap(([optionId, count]) =>
        Array.from({ length: count }, () => Number(optionId))
      )
      : selectedOption === null
      ? []
      : [selectedOption];

    const newReceipts: VoteReceipt[] = [];

    // Late issuance: for each vote, do blind → issue → finalize → cast in
    // sequence. If any step fails, we stop — already-cast votes stay cast,
    // and the user can refresh to see updated state and retry the rest.
    // The cast step deliberately sends `credentials: "omit"` so no JWT
    // cookie travels with the request — the cast endpoint is anonymous
    // by design.
    for (const optionId of optionIds) {
      try {
        // 1. Fresh random UUID + prepare (Randomized suite prepends 32 bytes)
        const msg = generateUuid();
        const preparedMessage = prepare(msg);

        // 2. Blind for transmission
        const { blindedMessageB64, invB64 } = await blind(
          blindRsaPublicKey,
          preparedMessage,
        );

        // 3. Issue: server sees only the blinded message
        const issueRes = await fetch(`/api/poll/${pollId}/blindsign`, {
          method: "POST",
          credentials: "include", // JWT cookie required for issuance
          body: JSON.stringify({ blinded: blindedMessageB64 }),
          headers: { "Content-Type": "application/json" },
        });
        if (issueRes.status !== 200) {
          const errText = await issueRes.text();
          setErrorMessage(`Issuance failed: ${errText}`);
          setViewState("error");
          return;
        }
        const { blindSig } = await issueRes.json();

        // 4. Unblind into a normal RSA-PSS signature
        const signatureB64 = await finalize(
          blindRsaPublicKey,
          preparedMessage,
          blindSig,
          invB64,
        );

        // 5. Cast: ANONYMOUS — `credentials: "omit"` strips the JWT cookie
        // so the network request carries nothing tying user ↔ UUID.
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
          const errText = await castRes.text();
          setErrorMessage(`Cast failed: ${errText}`);
          setViewState("error");
          return;
        }

        // 6. Keep a local receipt so the user can later verify their vote
        //    on the results page. The server has no copy of this link.
        newReceipts.push({
          pollId,
          optionId,
          uuidB64,
          signatureB64,
          castAt: new Date().toISOString(),
        });
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Unknown error");
        setViewState("error");
        return;
      }
    }

    saveReceipts(newReceipts);
    setViewState("done");
  }
}

/**
 * The local "receipt" written to localStorage after each successful vote.
 * Together with the poll's public key + the public results page, this is
 * everything needed to later prove "my vote is in the tally". The server
 * never has the link from userId to these fields.
 */
interface VoteReceipt {
  pollId: number;
  optionId: number;
  uuidB64: string;
  signatureB64: string;
  castAt: string;
}

/** Encode raw bytes as standard base64 — small inline helper for the cast body. */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Append the given receipts to the persistent list in localStorage. */
function saveReceipts(newReceipts: VoteReceipt[]): void {
  const key = "unf-vote-receipts";
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
