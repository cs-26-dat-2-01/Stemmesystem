import { useEffect, useState } from "react";
import NavBar from "../components/NavBar";
import "./BallotPage.css";

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
| "ready" // show options + radio buttions
| "confirming" // "Are you sure?
| "submitting" // send POST /vote
| "done" // succes! show receipt!
| "error"; // something went wrong ,and show to user. 

interface BallotPageProps {
  pollId: number;
}

interface Poll {
  id: number;
  title: string;
  description: string;
  voteStatus: "draft" | "started" | "finished";
  createdBy: number;
  createdAt: string;
  startsAt?: string;
  endsAt?: string;
  pollVisibility: string;
  ballotPrivacy: string;
  showTopN: number;
  ballotLimit: number;
  useBuffer: number;
}

interface PollOption {
  id: number; 
  pollId: number;
  optionText: string;
  displayOrder: number;
}


function BallotPage({ pollId }: BallotPageProps) {
    // Statevariables
    const [viewState, setViewState] = useState<ViewState>("loading");
    const [poll, setPoll] = useState<Poll | null>(null);
    const [options, setOptions] = useState<PollOption[]>([]);
    const [voteToken, setVoteToken] = useState<string>("");
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    // INDRE async funktion — HER må vi gerne bruge await
    async function openPoll() {
      const UUID = crypto.randomUUID();
      console.log("Generated UUID:", UUID);

      const resOpen = await fetch(`/api/poll/${pollId}/open`, {
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ UUID }),
        headers: { "Content-Type": "application/json" },
      });

      if (resOpen.status === 200) {
        const dataOpen = await resOpen.json();
        console.log("Open succeeded:", dataOpen);
        setPoll(dataOpen.poll); 
        setOptions(dataOpen.options);
        setVoteToken(dataOpen.voteToken); 
        setViewState("ready");
      } else {
        setErrorMessage("Kunne ikke indlæse afstemning");
        setViewState("error");
        console.log("Open failed:", resOpen.status);
      }
    }

    // Kald den INDRE funktion med det samme
    openPoll();
  }, []); // ← tom array = kør kun én gang ved mount

  if (viewState === "loading"){
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
            {options.map((option) => (
              <label key={option.id} className="ballot-option">
                <input
                  type="radio"
                  name="pollOption"
                  value={option.id}
                  checked={selectedOption === option.id}
                  onChange={() => setSelectedOption(option.id)}
                />
                {option.optionText}
              </label>
            ))}
          </div>

          <button
            className="ballot-submit"
            disabled={selectedOption === null}
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
  const selectedText = options.find((o) => o.id === selectedOption)?.optionText;

  return (
    <>
      <NavBar />
      <div className="ballot-container">
        <div className="ballot-confirm-card">
          <p>Du er ved at stemme på <strong>{selectedText}</strong></p>
          <p>Vil du bekræfte?</p>
          <div className="ballot-confirm-buttons">
            <button
              className="ballot-btn-yes"
              onClick={submitVote}
            >
              Ja
            </button>
            <button
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

  if (viewState === "submitting"){
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
  if (viewState === "done"){
    return (
    <>
      <NavBar />
      <div className="ballot-container">
        <div className="ballot-done">
          <h2>Tak for din stemme!</h2>
          <p>Din stemme er blevet registreret.</p>
          <a href="/" className="ballot-back-link">Tilbage til oversigten</a>
        </div>
      </div>
    </>
    );
  }
  if (viewState === "error"){
    return (
    <>
      <NavBar />
      <div className="ballot-container">
        <div className="ballot-error">
          <h2>Noget gik galt</h2>
          <p>{errorMessage || "Ukendt fejl."}</p>
          <a href="/" className="ballot-back-link">Tilbage til oversigten</a>
        </div>
      </div>
    </>
    );
  }

  async function submitVote() {
    setViewState("submitting");

    const resVote = await fetch(`/api/poll/${pollId}/vote`, {
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
            optionId: selectedOption,
            UUID: voteToken,
        }),
        headers: { "Content-Type": "application/json" },
    });

    if (resVote.status === 200) {
        setViewState("done");
    } else {
        const errText = await resVote.text();
        setErrorMessage(errText);
        setViewState("error");
    }
    }
}




export default BallotPage;
