import { useState } from "react";
import "./CreatePollPage.css";
import type { ballotPrivacy, Poll, pollVisibility } from "../WebLib.ts";
import NavBar from "../components/NavBar.tsx";

/* Create poll page 1.
    - Page where the creator of the poll inputs all relevant basic information.
    - Uses data structure from WebLib to define data for input.
    - TODO: Lacks sync with backend to save data (all pages).
*/

function CreatePollStep1({ onNext }: { onNext: (data: Poll) => void }) {
  // All state variables for page 1. Allows for easy update of the variable between rendering.

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<pollVisibility>("private");
  const [privacy, setPrivacy] = useState<ballotPrivacy>("secret");
  const [startNow, setStartNow] = useState(false);
  const [useBuffer, setUseBuffer] = useState(0);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [onlyToday, setOnlyToday] = useState(false);
  const [showTopN, setShowTopN] = useState(0);
  const [topNOnly, setTopNOnly] = useState(false);
  const [ballotLimit, setBallotLimit] = useState(1);

  const today = new Date().toISOString().split("T")[0];

  // Locks date fields to today when checked.
  function handleOnlyToday(checked: boolean) {
    setOnlyToday(checked);
    if (checked) {
      setStartDate(today);
      setEndDate(today);
    }
  }

  // Clears start time when "start now" is checked.
  function handleStartNow(checked: boolean) {
    setStartNow(checked);
    if (checked) setStartsAt("");
  }

  // Builds the Poll object and passes it up to CreatePollPage().
  function buildPollData(): Poll {
    return {
      id: 0,
      title,
      description,
      status: "draft",
      createdBy: 0,
      createdAt: new Date().toISOString(),
      startsAt: startNow
        ? new Date().toISOString()
        : `${startDate}T${startsAt}`,
      endsAt: `${endDate}T${endsAt}`,
      pollVisibility: visibility,
      ballotPrivacy: privacy,
      showTopN: topNOnly ? showTopN : 0,
      ballotLimit,
      useBuffer,
    };
  }

  return (
    // Added "field-hints" as there are in the wireframe, to tell the user what each field does.
    // Certain fields have their text omitted since they take up a lot of space.

    <div className="create-poll-content">
      <h2>Generel information</h2>

      {/* Poll title */}
      <label htmlFor="title">Afstemnings titel</label>
      <p className="field-hint">Giv afstemningen en titel her.</p>
      <input
        id="title"
        name="title"
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      {/* Poll description */}
      <label htmlFor="description">Afstemnings beskrivelse</label>
      <p className="field-hint">Skriv en beskrivelse til afstemningen her.</p>
      <textarea
        id="description"
        name="description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <hr className="section-divider" />

      <div className="create-poll-grid-2">
        {/* Left: visibility settings */}
        <div>
          <h2>Synligheds indstillinger</h2>

          {/* Public or private */}
          <label htmlFor="visibility">Offentlig eller privat afstemning</label>
          <p className="field-hint"></p>
          <select
            id="visibility"
            name="visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as pollVisibility)}
          >
            <option value="public">Offentlig</option>
            <option value="private">Privat</option>
          </select>

          {/* Open or secret */}
          <label htmlFor="secrecyMode">Åben eller hemmelig stemme</label>
          <p className="field-hint"></p>
          <select
            id="privacy"
            name="privacy"
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as ballotPrivacy)}
          >
            <option value="open">Åben</option>
            <option value="secret">Hemmelig</option>
          </select>
        </div>

        {/* Right: start and end time */}
        <div>
          <h2>Afstemnings start og slut</h2>
          <p className="field-hint"></p>

          {/* Start time, disabled when start now is checked */}
          <label htmlFor="startsAt">Start tidspunkt</label>
          <input
            id="startsAt"
            name="startsAt"
            type="time"
            value={startsAt}
            disabled={startNow}
            onChange={(e) => setStartsAt(e.target.value)}
          />

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={startNow}
              onChange={(e) => handleStartNow(e.target.checked)}
            />
            Start nu
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={useBuffer === 1}
              onChange={(e) => setUseBuffer(e.target.checked ? 1 : 0)}
            />
            Indsæt 5 minutters start-buffer
          </label>

          {/* End time */}
          <label htmlFor="endsAt">Slut tidspunkt</label>
          <input
            id="endsAt"
            name="endsAt"
            type="time"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </div>
      </div>

      <hr className="section-divider" />

      <div className="create-poll-grid-3">
        {/* Result settings */}
        <div>
          <h2>Resultat indstillinger</h2>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={topNOnly}
              onChange={(e) => setTopNOnly(e.target.checked)}
            />
            Vis kun top n
          </label>
          <p className="field-hint"></p>
          {topNOnly && (
            <>
              <label htmlFor="showTopN">Top N:</label>
              <input
                id="showTopN"
                name="showTopN"
                type="number"
                min={1}
                value={showTopN}
                onChange={(e) => setShowTopN(Number(e.target.value))}
              />
            </>
          )}
        </div>

        {/* Max choices */}
        <div>
          <h2>Antal valgmuligheder</h2>
          <label htmlFor="ballotLimit">Max antal stemmer per deltager</label>
          <p className="field-hint"></p>
          <input
            id="ballotLimit"
            name="ballotLimit"
            type="number"
            min={1}
            value={ballotLimit}
            onChange={(e) => setBallotLimit(Number(e.target.value))}
          />
        </div>

        {/* Date */}
        <div>
          <h2>Dato</h2>
          <p className="field-hint">Hvornår afstemningen afslutter.</p>

          <label htmlFor="startDate">Start dato</label>
          <input
            id="startDate"
            name="startDate"
            type="date"
            value={startDate}
            disabled={onlyToday}
            onChange={(e) => setStartDate(e.target.value)}
          />

          <label htmlFor="endDate">Slut dato</label>
          <input
            id="endDate"
            name="endDate"
            type="date"
            value={endDate}
            disabled={onlyToday}
            onChange={(e) => setEndDate(e.target.value)}
          />

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={onlyToday}
              onChange={(e) => handleOnlyToday(e.target.checked)}
            />
            Afholdes kun i dag
          </label>
        </div>
      </div>

      <br />
      <button type="button" onClick={() => onNext(buildPollData())}>
        Gem og fortsæt
      </button>
    </div>
  );
}

/* Create poll page 2.
    - Lets the creator add eligible voters by their name in the system.
    - For now only a textfield where names can be entered, added and deleted to the list.
    - TODO: Actual search function.
*/

function CreatePollStep2({ onNext, voters, setVoters }: {
  onNext: () => void;
  voters: string[];
  setVoters: (v: string[]) => void;
}) {
  const [name, setName] = useState("");

  // Adds the entered name to the voter list and clears the input.
  function handleAdd() {
    if (name.trim() === "") return;
    setVoters([...voters, name.trim()]);
    setName("");
  }

  // Removes a voter at the given index.
  function handleRemove(index: number) {
    setVoters(voters.filter((_, i) => i !== index));
  }

  return (
    <div className="create-poll-content">
      <h2>Rediger stemmeberettigede</h2>
      <p className="field-hint">
        Tilføj de personer som må stemme i afstemningen.
      </p>

      <label htmlFor="name">Navn</label>
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
        <input
          id="name"
          name="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={handleAdd}>Tilføj</button>
      </div>

      {/* List of added voters */}
      <div className="voter-list" style={{ marginTop: "1rem" }}>
        {voters.length === 0
          ? (
            <p className="voter-empty">
              Ingen stemmeberettigede tilføjet endnu.
            </p>
          )
          : voters.map((voter, i) => (
            <div key={i} className="voter-row">
              <span>{voter}</span>
              <button type="button" onClick={() => handleRemove(i)}>
                Fjern
              </button>
            </div>
          ))}
      </div>

      <br />
      <button type="button" onClick={onNext}>Gem og fortsæt</button>
    </div>
  );
}

/* Create poll page 3.
    - Fields for entering the options that voters can choose between.
*/

function CreatePollStep3({ onNext, choices, setChoices }: {
  onNext: () => void;
  choices: string[]; // Current list of choices.
  setChoices: (c: string[]) => void; // Updates the list of choices.
}) {
  // Updates a single choice at a specific position.
  function handleChoiceChange(index: number, value: string) {
    const updated = [...choices];
    updated[index] = value;
    setChoices(updated);
  }

  // Appends a new empty string.
  function handleAddChoice() {
    setChoices([...choices, ""]);
  }

  // Removes choice at specific position.
  function handleRemoveChoice(index: number) {
    setChoices(choices.filter((_, i) => i !== index));
  }

  return (
    <div className="create-poll-content">
      <h2>Rediger valgmuligheder</h2>
      <p className="field-hint">
        Tilføj de valgmuligheder som stemmeberettigede kan stemme på.
      </p>

      {choices.map((choice, i) => (
        <div key={i} className="choice-row">
          <input
            id={`choice-${i}`}
            type="text"
            placeholder={`Valgmulighed ${i + 1}`}
            value={choice}
            onChange={(e) => handleChoiceChange(i, e.target.value)}
          />
          {/* Only show remove if more than one choice */}
          {choices.length > 1 && (
            <button
              type="button"
              onClick={() => handleRemoveChoice(i)}
            >
              Fjern
            </button>
          )}
        </div>
      ))}

      <br />
      <button
        type="button"
        className="button-secondary"
        onClick={handleAddChoice}
      >
        + Tilføj valgmulighed
      </button>

      <br />
      <br />
      <button type="button" onClick={onNext}>Gem og fortsæt</button>
    </div>
  );
}

/* Create poll page 4.
    - Shows an overview of all poll data before the creator finalizes.
*/

function CreatePollStep4({ onNext, pollData, voters, choices }: {
  onNext: () => void;
  pollData: Poll;
  voters: string[];
  choices: string[];
}) {
  return (
    <div className="create-poll-content">
      <h2>Færdiggør afstemning</h2>

      <div className="create-poll-grid-2">
        {/* Left: poll overview and voters */}
        <div>
          <h2>Oversigt</h2>

          <div className="overview-field">
            <label>Afstemnings titel:</label>
            <span>{pollData.title || "-"}</span>
          </div>
          <div className="overview-field">
            <label>Afstemnings beskrivelse:</label>
            <span>{pollData.description || "-"}</span>
          </div>
          <div className="overview-field">
            <label>Privat eller offentlig:</label>
            <span>
              {pollData.pollVisibility === "public" ? "Offentlig" : "Privat"}
            </span>
          </div>
          <div className="overview-field">
            <label>Hemmelig afstemning:</label>
            <span>{pollData.ballotPrivacy === "secret" ? "✓" : "X"}</span>
          </div>
          <div className="overview-field">
            <label>Vis top n resultater:</label>
            <span>{pollData.showTopN > 0 ? pollData.showTopN : "Nej"}</span>
          </div>
          <div className="overview-field">
            <label>Max stemmer per deltager:</label>
            <span>{pollData.ballotLimit}</span>
          </div>
          <div className="overview-field">
            <label>Afstemnings start:</label>
            <span>{pollData.startsAt ?? "Nu"}</span>
          </div>
          <div className="overview-field">
            <label>Afstemnings slut:</label>
            <span>{pollData.endsAt ?? "-"}</span>
          </div>

          {/* Voters */}
          <h2>Stemmeberettigede</h2>
          <div className="voter-list">
            {voters.length === 0
              ? <p className="voter-empty">Ingen tilføjet.</p>
              : voters.map((voter, i) => (
                <div key={i} className="voter-row">
                  <span>{voter}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Right: choices */}
        <div>
          <h2>Valgmuligheder</h2>
          {choices.filter((c) => c.trim() !== "").length === 0
            ? <p className="field-hint">Ingen valgmuligheder tilføjet.</p>
            : choices.filter((c) => c.trim() !== "").map((choice, i) => (
              <div key={i} className="overview-field">
                <label>Valgmulighed {i + 1}:</label>
                <span>{choice}</span>
              </div>
            ))}
        </div>
      </div>

      <br />
      <button type="button" onClick={onNext}>Start afstemning</button>
    </div>
  );
}

/* Navigation between the steps, as seen in all of the wireframes
    - Lets the user freely navigate between the pages, plus delete and save poll.
    - Save poll sends saved data to the backend.
    - Delete poll returns the creator to the overview page.
*/

function CreatePollPage({ onExit }: { onExit: () => void }) {
  // Tracks which step is currently shown.
  const [step, setStep] = useState(0);

  // Poll data from step 1, passed to step 4 for overview.
  const [pollData, setPollData] = useState<Poll>({
    id: 0,
    title: "",
    description: "",
    status: "draft",
    createdBy: 0,
    createdAt: "",
    pollVisibility: "private",
    ballotPrivacy: "secret",
    showTopN: 0,
    ballotLimit: 1,
    useBuffer: 0,
  });

  // Voters from step 2, passed to step 4 for overview.
  const [voters, setVoters] = useState<string[]>([]);

  // Choices from step 3, passed to step 4 for overview.
  const [choices, setChoices] = useState<string[]>([""]);

  const steps = [
    "Afstemnings information",
    "Rediger stemmeberettigede",
    "Rediger valgmuligheder",
    "Færdiggør afstemning",
  ];

  // Saves poll to backend.
  // TODO: Replace with actual functioning fetch when backend is ready.

  async function handleSave() {
    try {
      const res = await fetch("/api/polls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poll: pollData,
          voters,
          choices: choices.filter((c) => c.trim() !== ""),
        }),
      });
      if (res.ok) {
        onExit();
      } else {
        const msg = await res.text();
        console.error(`Failed to save poll: ${res.status} ${msg}`);
      }
    } catch (err) {
      console.error("Failed to save poll", err);
    }
  }

  return (
    <div className="create-poll-page">
      {/* Navbar at the top */}
      <NavBar />

      {/* Show the correct step */}
      {step === 0 && (
        <CreatePollStep1
          onNext={(data) => {
            setPollData(data);
            setStep(1);
          }}
        />
      )}
      {step === 1 && (
        <CreatePollStep2
          onNext={() => setStep(2)}
          voters={voters}
          setVoters={setVoters}
        />
      )}
      {step === 2 && (
        <CreatePollStep3
          onNext={() => setStep(3)}
          choices={choices}
          setChoices={setChoices}
        />
      )}
      {step === 3 && (
        <CreatePollStep4
          onNext={onExit}
          pollData={pollData}
          voters={voters}
          choices={choices}
        />
      )}

      {/* Bottom navigation bar */}
      <div className="create-poll-nav">
        <button type="button" className="button-danger" onClick={onExit}>
          Slet afstemning
        </button>

        <div className="create-poll-nav-steps">
          <button
            type="button"
            className="button-secondary"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            «
          </button>
          {steps.map((s, i) => (
            <button
              key={i}
              type="button"
              className={i === step ? "" : "button-secondary"}
              onClick={() => setStep(i)}
              disabled={i === step}
            >
              {s}
            </button>
          ))}
          <button
            type="button"
            className="button-secondary"
            onClick={() => setStep((s) => Math.min(3, s + 1))}
          >
            »
          </button>
        </div>

        <button type="button" onClick={handleSave}>Gem afstemning</button>
      </div>
    </div>
  );
}

export default CreatePollPage;
