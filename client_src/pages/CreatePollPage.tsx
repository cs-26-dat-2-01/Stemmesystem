import { useEffect, useState } from "react";
import "./CreatePollPage.css";
import type {
  ballotPrivacy,
  Poll,
  PollOption,
  pollVisibility,
} from "../WebLib.ts";
import NavBar from "../components/NavBar.tsx";

/**
 * React hook that determines whether the viewport width is below a given breakpoint.
 *
 * @param breakpoint - The pixel width threshold used to determine "mobile".
 * @returns A boolean indicating whether the current viewport width is less than the breakpoint.
 *
 * @example
 * const isMobile = useIsMobile(900);
 * if (isMobile) {
 *   // Render mobile layout
 * }
 */
function useIsMobile(breakpoint: number) {
  const [isMobile, setIsMobile] = useState(globalThis.innerWidth < breakpoint);

  useEffect(() => {
    const onResize = () => setIsMobile(globalThis.innerWidth < breakpoint);
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, [breakpoint]);

  return isMobile;
}

/* Navigation between the steps, as seen in all of the wireframes
    - Lets the user freely navigate between the pages, plus delete and save poll.
    - Save poll sends saved data to the backend.
    - Delete poll returns the creator to the overview page.
*/

function CreatePollPage({
  onExit,
  draftId = null,
}: {
  onExit: () => void;
  draftId?: number | null;
}) {
  // Tracks which step is currently shown.
  const [step, setStep] = useState(0);
  const [pollId, setPollId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false); // state that we use to flag when saving, so we dont try to save at the same time, since its async
  // All state variables for page 1. Allows for easy update of the variable between rendering.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<pollVisibility>(
    "" as pollVisibility,
  );
  const [privacy, setPrivacy] = useState<ballotPrivacy>("" as ballotPrivacy);
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

  // toggle mobile viewport at 900px width.
  const isMobile = useIsMobile(900);

  // we use useEffect since we dont wanna render the data many times only on mount.
  useEffect(() => {
    if (draftId === null) return;

    async function loadDraft() {
      const res = await fetch(`/api/polls/${draftId}`, {
        method: "GET",
        credentials: "include",
      });

      if (!res.ok) {
        console.error(`Faield to load draft: ${res.status}`);
        return;
      }
      const data = await res.json();
      setTitle(data.poll.title ?? "");
      setDescription(data.poll.description ?? "");
      setVisibility(data.poll.pollVisibility ?? "private");
      setPrivacy(data.poll.ballotPrivacy ?? "secret");
      setUseBuffer(data.poll.useBuffer ?? 0);
      setBallotLimit(data.poll.ballotLimit ?? 1);
      setShowTopN(data.poll.showTopN ?? 0);
      setTopNOnly((data.poll.showTopN ?? 0) > 0);
      // startsAt/endsAt saves as  ISO in the DB ("2026-05-07T14:30..."),
      // UI holds time and date seperate
      if (data.poll.startsAt) {
        const [d, t] = data.poll.startsAt.split("T");
        setStartDate(d);
        setStartsAt(t.slice(0, 5)); // "HH:MM"
      }
      if (data.poll.endsAt) {
        const [d, t] = data.poll.endsAt.split("T");
        setEndDate(d);
        setEndsAt(t.slice(0, 5));
      }
      setVoters(data.voters ?? []);
      // Option has {optionText, displayOrder,..}, but UI uses string[].
      setChoices(
        (data.options ?? [])
          .sort(
            (a: PollOption, b: PollOption) => a.displayOrder - b.displayOrder,
          )
          .map((o: PollOption) => o.optionText ?? ""),
      );

      setPollId(draftId);
    }

    loadDraft();
  }, []);

  /**
   * Persits a poll draft to the bachkend.
   *
   * On the first call when 'pollId' is 'null, it creates a new poll via POST /api/polls
   * and stores the returned id in component state. On subsequent calls, it only patches the
   * existing poll via PATCH /api/polls/:id with the ull payload (poll fields, voters, and choices).
   *
   * Concurrent invocations are guarded by the `isSaving` flag: if a save is already in flight, the
   * call is a no-go.
   *
   * @param payload - the draft data to save.
   * @param poyload.poll - Partial poll fields to create or update
   * @param payload.voters - Optional list of voter identifiers. Only sent on PATCH
   * @param payload.choices - optional list of poll choices. Only sent on PATCH
   *
   * @remarks
   * - The initial POST sends only 'payload.poll'( voters and choices are ignored until the poll exists
   *   and can be patched, this is because it saves after the first step, so you cant input voters or choices
   *   before you have the initial POST.
   *   - Patch responses are not currently checked for success.
   */
  async function saveDraft(payload: {
    poll: Partial<Poll>;
    voters?: Array<{ username: string; votesAllowed: number }>;
    choices?: string[];
  }) {
    if (isSaving) return;
    setIsSaving(true);
    try {
      if (pollId === null) {
        const res = await fetch("/api/polls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poll: payload.poll }),
        });
        if (!res.ok) {
          console.error(`Failed to create poll: ${res.status}`);
          return;
        }
        const { pollId: newId } = await res.json();
        setPollId(newId);
      } else {
        await fetch(`/api/polls/${pollId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
    } finally {
      setIsSaving(false);
    }
  }

  /**
   * Assembles the current form state into a `Partial<Poll>` payload suitable for sending to the
   * poll create/update endpoints.
   *
   * Date and time fields are combined from their seperate inputs, but this also does so date and time
   * needs to be set before it can save it to the database.
   *
   * @returns A partial poll object reflecting the current form state. Fields with incomplete date/time are omitted (left: undefined)
   * rather than sent as malformed strings.
   */
  function buildPollData(): Partial<Poll> {
    const startsAtValue = startNow
      ? new Date().toISOString()
      : startDate && startsAt
        ? `${startDate}T${startsAt}`
        : undefined;
    const endsAtValue = endDate && endsAt ? `${endDate}T${endsAt}` : undefined;
    return {
      title,
      description,
      startsAt: startsAtValue,
      endsAt: endsAtValue,
      pollVisibility: visibility,
      ballotPrivacy: privacy,
      showTopN: topNOnly ? showTopN : 0,
      ballotLimit,
      useBuffer,
    };
  }

  // Voters from step 2, passed to step 4 for overview.
  const [voters, setVoters] = useState<
    Array<{ username: string; votesAllowed: number }>
  >([]);

  // Choices from step 3, passed to step 4 for overview.
  const [choices, setChoices] = useState<string[]>([""]);

  const steps = [
    "Afstemnings information",
    "Rediger stemmeberettigede",
    "Rediger valgmuligheder",
    "Færdiggør afstemning",
  ];

  /**
   * Saves the current form state as a draft via {@link saveDraft}.
   */
  async function handleSave() {
    await saveDraft({
      poll: buildPollData(),
      voters,
      choices: choices.filter((c) => c.trim() !== ""),
    });
  }
  /**
   * Publishes the current poll, transitioning it from draft to active state.
   *
   * Requires an existing `pollId` — calling this before the draft has been
   * persisted (i.e. while `pollId` is `null`) logs an error and returns
   * without making a request.
   *
   * The full current form state is sent in the request body so the server
   * can apply any unsaved edits as part of the publish step. On success,
   * `onExit` is invoked to leave the editor; on failure, the response status
   * and body are logged to the console.
   */
  async function handlePublish() {
    if (pollId === null) {
      console.error("cant publish without pollId");
      return;
    }
    const res = await fetch(`/api/polls/${pollId}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        poll: buildPollData(),
        voters,
        choices: choices.filter((c) => c.trim() !== ""),
      }),
    });
    if (res.ok) {
      onExit();
    } else {
      const msg = await res.text();
      console.error(`Publish fejlede: ${res.status} ${msg}`);
    }
  }

  /**
   * Deletes the current poll after user confirmation.
   *
   * No-op when `pollId` is `null` (nothing has been persisted yet). Otherwise
   * prompts the user via `window.confirm`; if confirmed, sends
   * `DELETE /api/polls/:id` and calls `onExit` on success. Failures are
   * logged to the console and the editor remains open.
   */
  async function handleDelete() {
    if (pollId !== null) {
      if (!window.confirm("Er du sikker på, at du vil slette afstemningen?")) {
        return;
      }

      const res = await fetch(`/api/polls/${pollId}`, { method: "DELETE" });
      if (res.ok) {
        onExit();
      } else {
        const msg = await res.text();
        console.error(`Delete fejlede: ${res.status} ${msg}`);
      }
    }
  }
  async function handleNext() {
    await handleSave();
    setStep((s) => s + 1);
  }

  return (
    <div className="create-poll-page">
      {/* Navbar at the top */}
      <NavBar />

      {/* Show the correct step */}
      {step === 0 && (
        <CreatePollStep1
          title={title}
          setTitle={setTitle}
          description={description}
          setDescription={setDescription}
          visibility={visibility}
          setVisibility={setVisibility}
          privacy={privacy}
          setPrivacy={setPrivacy}
          startNow={startNow}
          setStartNow={setStartNow}
          useBuffer={useBuffer}
          setUseBuffer={setUseBuffer}
          startsAt={startsAt}
          setStartsAt={setStartsAt}
          endsAt={endsAt}
          setEndsAt={setEndsAt}
          startDate={startDate}
          setStartDate={setStartDate}
          endDate={endDate}
          setEndDate={setEndDate}
          onlyToday={onlyToday}
          setOnlyToday={setOnlyToday}
          showTopN={showTopN}
          setShowTopN={setShowTopN}
          topNOnly={topNOnly}
          setTopNOnly={setTopNOnly}
          ballotLimit={ballotLimit}
          setBallotLimit={setBallotLimit}
          onNext={handleNext}
        />
      )}
      {step === 1 && (
        <CreatePollStep2
          onNext={handleNext}
          voters={voters}
          setVoters={setVoters}
          ballotLimit={ballotLimit}
        />
      )}
      {step === 2 && (
        <CreatePollStep3
          onNext={handleNext}
          choices={choices}
          setChoices={setChoices}
        />
      )}
      {step === 3 && (
        <CreatePollStep4
          onNext={handlePublish}
          pollData={buildPollData()}
          voters={voters}
          choices={choices}
          pollId={pollId}
          startNow={startNow}
        />
      )}

      {/* Bottom navigation bar */}
      <div className="create-poll-nav">
        <button type="button" className="button-danger" onClick={handleDelete}>
          Slet afstemning
        </button>

        <div className="create-poll-nav-steps">
          <button
            type="button"
            className="button-secondary"
            onClick={async () => {
              await handleSave();
              setStep((s) => Math.max(0, s - 1));
            }}
          >
            «
          </button>
          {isMobile ? (
            <span className="step-indicator">
              {step + 1}/{steps.length}
              <div className="step-label">{steps[step]}</div>
            </span>
          ) : (
            steps.map((s, i) => (
              <button
                key={i}
                type="button"
                className={i === step ? "button-secondary" : "button-secondary"}
                onClick={async () => {
                  await handleSave();
                  setStep(i);
                }}
                disabled={i === step}
              >
                {s}
              </button>
            ))
          )}
          <button
            type="button"
            className="button-secondary"
            onClick={async () => {
              await handleSave();
              setStep((s) => Math.min(3, s + 1));
            }}
          >
            »
          </button>
        </div>

        <button
          type="button"
          className="create-poll-content button"
          onClick={async () => {
            await handleSave();
          }}
        >
          Gem kladde
        </button>
      </div>
    </div>
  );
}

/* Create poll page 1.
    - Page where the creator of the poll inputs all relevant basic information.
    - Uses data structure from WebLib to define data for input.
*/
function CreatePollStep1({
  title,
  setTitle,
  description,
  setDescription,
  visibility,
  setVisibility,
  privacy,
  setPrivacy,
  startNow,
  setStartNow,
  useBuffer,
  setUseBuffer,
  startsAt,
  setStartsAt,
  endsAt,
  setEndsAt,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  onlyToday,
  setOnlyToday,
  showTopN,
  setShowTopN,
  topNOnly,
  setTopNOnly,
  ballotLimit,
  setBallotLimit,
  onNext,
}: {
  title: string;
  setTitle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  visibility: pollVisibility;
  setVisibility: (v: pollVisibility) => void;
  privacy: ballotPrivacy;
  setPrivacy: (v: ballotPrivacy) => void;
  startNow: boolean;
  setStartNow: (v: boolean) => void;
  useBuffer: number;
  setUseBuffer: (v: number) => void;
  startsAt: string;
  setStartsAt: (v: string) => void;
  endsAt: string;
  setEndsAt: (v: string) => void;
  startDate: string;
  setStartDate: (v: string) => void;
  endDate: string;
  setEndDate: (v: string) => void;
  onlyToday: boolean;
  setOnlyToday: (v: boolean) => void;
  showTopN: number;
  setShowTopN: (v: number) => void;
  topNOnly: boolean;
  setTopNOnly: (v: boolean) => void;
  ballotLimit: number;
  setBallotLimit: (v: number) => void;
  onNext: () => void;
}) {
  const [attempted, setAttempted] = useState(false);
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
  // check to see if the dates are valid ( for example not in the past, or end before start)
  const now = new Date();
  const startDateTime = startNow
    ? now
    : startDate && startsAt
      ? new Date(`${startDate}T${startsAt}`)
      : null;
  const endDateTime =
    endDate && endsAt ? new Date(`${endDate}T${endsAt}`) : null;
  const datesValid =
    !!startDateTime &&
    !!endDateTime &&
    startDateTime >= now &&
    endDateTime > startDateTime;

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
        className="input-createPoll"
        onChange={(e) => setTitle(e.target.value)}
      />

      {/* Poll description */}
      <label htmlFor="description">Afstemnings beskrivelse</label>
      <p className="field-hint">Skriv en beskrivelse til afstemningen her.</p>
      <textarea
        id="description"
        name="description"
        value={description}
        className="input-createPoll"
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
            className="input-createPoll"
            onChange={(e) => setVisibility(e.target.value as pollVisibility)}
          >
            <option value="" disabled>
              Vælg...
            </option>
            <option value="public">Offentlig</option>
            <option value="private">Privat</option>
          </select>
          {attempted && !visibility && (
            <p style={{ color: "red" }}>
              Vælg venligst offentlig eller privat afstemning.
            </p>
          )}

          {/* Open or secret */}
          <label htmlFor="secrecyMode">Åben eller hemmelig stemme</label>
          <p className="field-hint"></p>
          <select
            id="privacy"
            name="privacy"
            value={privacy}
            className="input-createPoll"
            onChange={(e) => setPrivacy(e.target.value as ballotPrivacy)}
          >
            <option value="" disabled>
              Vælg...
            </option>
            <option value="open">Åben</option>
            <option value="secret">Hemmelig</option>
          </select>
          {attempted && !privacy && (
            <p style={{ color: "red" }}>
              Vælg venligst åben eller hemmelig stemme.
            </p>
          )}
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
          {attempted && !startsAt && !startNow && (
            <p style={{ color: "red" }}>
              Vælg venligst enten starttidspunkt eller start nu.
            </p>
          )}

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
          {attempted && !endsAt && (
            <p style={{ color: "red" }}>Vælg venligst sluttidspunkt.</p>
          )}
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
          {attempted && !startDate && (
            <p style={{ color: "red" }}>Vælg venligst startdato.</p>
          )}

          <label htmlFor="endDate">Slut dato</label>
          <input
            id="endDate"
            name="endDate"
            type="date"
            value={endDate}
            disabled={onlyToday}
            onChange={(e) => setEndDate(e.target.value)}
          />
          {attempted && !endDate && (
            <p style={{ color: "red" }}>Vælg venligst slutdato.</p>
          )}

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
      {attempted && startDateTime && startDateTime < now && (
        <p style={{ color: "red" }}>
          Starttidspunktet skal være i fremtiden (eller brug "Start nu").
        </p>
      )}
      {attempted &&
        startDateTime &&
        endDateTime &&
        endDateTime <= startDateTime && (
          <p style={{ color: "red" }}>
            Sluttidspunktet skal være efter starttidspunktet.
          </p>
        )}

      <button
        type="button"
        onClick={() => {
          setAttempted(true);
          if (
            visibility &&
            privacy &&
            ((startsAt && startDate) || startNow) &&
            endsAt &&
            endDate &&
            datesValid
          )
            onNext();
        }}
      >
        Gem og fortsæt
      </button>
    </div>
  );
}

/* Create poll page 2.
    - Lets the creator add eligible voters by their name in the system.
    - Fetches all users from the DB.
    - Filters users by username.
*/
function CreatePollStep2({
  onNext,
  voters,
  setVoters,
  ballotLimit,
}: {
  onNext: () => void;
  voters: Array<{ username: string; votesAllowed: number }>;
  setVoters: (v: Array<{ username: string; votesAllowed: number }>) => void;
  ballotLimit: number;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [allUsers, setAllUsers] = useState<
    Array<{ id: number; username: string }>
  >([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Fetch all users once when component mounts.
  useEffect(() => {
    async function fetchUsers() {
      setLoading(true);
      try {
        const response = await fetch("/api/users", {
          method: "GET",
          credentials: "include",
        });
        if (response.ok) {
          const data = await response.json();
          setAllUsers(data.users);
        } else {
          setError("Kunne ikke hente brugere.");
        }
      } catch {
        setError("Kunne ikke forbinde til serveren.");
      } finally {
        setLoading(false);
      }
    }
    fetchUsers();
  }, []);

  // Filters users based on search query and exclude already added voters.
  const filteredUsers = allUsers.filter((user) => {
    const matchesSearch = user.username
      .toLowerCase()
      .includes(searchQuery.toLocaleLowerCase());
    const notAlreadyAdded = !voters.some((v) => v.username === user.username);
    return matchesSearch && notAlreadyAdded;
  });

  // Adds the entered name to the voter list and clears the input.
  function handleAdd(username: string) {
    if (!voters.some((v) => v.username === username)) {
      setVoters([...voters, { username, votesAllowed: 1 }]);
    }
    setSearchQuery("");
    setShowDropdown(false);
  }

  // Removes a voter at the given index.
  function handleRemove(index: number) {
    setVoters(voters.filter((_, i) => i !== index));
  }

  // Updates the votesAllowed for a voter, clamped to [1, ballotLimit].
  function handleVotesChange(index: number, raw: number) {
    const n = Number.isFinite(raw) ? raw : 1;
    const clamped = Math.min(Math.max(1, Math.floor(n)), ballotLimit);
    setVoters(
      voters.map((v, i) => (i === index ? { ...v, votesAllowed: clamped } : v)),
    );
  }

  return (
    <div className="create-poll-content">
      <h2>Rediger stemmeberettigede</h2>
      <p className="field-hint">
        Søg efter brugere og tilføj dem som stemmeberettigede i afstemningen.
      </p>

      <label htmlFor="search">Søg efter brugere</label>

      {/* Show loading or error state instead of the search box if relevant. */}
      {loading && <p className="field-hint">Henter brugere...</p>}
      {error && (
        <p className="field-hint" style={{ color: "#e74c3c" }}>
          {error}
        </p>
      )}

      {/* Only show search once users have been loaded AND there is no error. */}
      {!loading && !error && (
        <div className="search-container">
          <input
            id="search"
            name="search"
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            // Small delay allows the click on a result to register before the dropdown closes-
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            placeholder="Søg efter brugernavn..."
          />
          {/* Dropdown which is only shown when search field has content. */}

          {showDropdown && searchQuery.trim() && (
            <div className="search-dropdown">
              {filteredUsers.length === 0 ? (
                <div className="search-no-results">Ingen brugere fundet</div>
              ) : (
                filteredUsers.map((user) => (
                  <div
                    key={user.id}
                    className="search-result-item"
                    onClick={() => handleAdd(user.username)}
                  >
                    {user.username}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}

      {/* List of added voters */}
      <h2 style={{ marginTop: "1.5rem" }}>Tilføjede stemmeberettigede</h2>
      <div className="voter-list">
        {voters.length === 0 ? (
          <p className="voter-empty">Ingen stemmeberettigede tilføjet endnu.</p>
        ) : (
          voters.map((voter, i) => (
            <div key={i} className="voter-row">
              <span>{voter.username}</span>
              <label className="voter-votes">
                Stemmer:
                <input
                  type="number"
                  min={1}
                  max={ballotLimit}
                  value={voter.votesAllowed}
                  onChange={(e) => handleVotesChange(i, Number(e.target.value))}
                />
              </label>
              <button type="button" onClick={() => handleRemove(i)}>
                Fjern
              </button>
            </div>
          ))
        )}
      </div>

      <br />
      <button type="button" className="create-poll-button" onClick={onNext}>
        Gem og fortsæt
      </button>
    </div>
  );
}

/* Create poll page 3.
    - Fields for entering the options that voters can choose between.
*/
function CreatePollStep3({
  onNext,
  choices,
  setChoices,
}: {
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
            <button type="button" onClick={() => handleRemoveChoice(i)}>
              Fjern
            </button>
          )}
        </div>
      ))}

      <br />
      <button
        type="button"
        className="button-secondary create-poll-button"
        onClick={handleAddChoice}
      >
        + Tilføj valgmulighed
      </button>

      <br />
      <br />
      <button type="button" className="create-poll-button" onClick={onNext}>
        Gem og fortsæt
      </button>
    </div>
  );
}

/* Create poll page 4.
    - Shows an overview of all poll data before the creator finalizes.
*/
export function CreatePollStep4({
  onNext,
  pollData,
  voters,
  choices,
  hideAction = false,
  heading = "Færdiggør afstemning",
  pollId,
  startNow = false,
}: {
  onNext: () => void;
  pollData: Partial<Poll>;
  voters: Array<{ username: string; votesAllowed?: number }>;
  choices: string[];
  hideAction?: boolean;
  heading?: string;
  pollId: number | null;
  startNow?: boolean;
}) {
  const ballotLimit = pollData.ballotLimit ?? 0;
  const invalidVoters = voters.filter(
    (v) =>
      v.votesAllowed !== undefined &&
      ballotLimit > 0 &&
      v.votesAllowed > ballotLimit,
  );

  // check to see if date is wrong
  const now = new Date();
  const startDateTime = pollData.startsAt ? new Date(pollData.startsAt) : null;
  const endDateTime = pollData.endsAt ? new Date(pollData.endsAt) : null;
  const startInPast =
    !hideAction && !startNow && !!startDateTime && startDateTime < now;
  const endBeforeStart =
    !hideAction &&
    !!startDateTime &&
    !!endDateTime &&
    endDateTime <= startDateTime;

  //validate the poll is complete
  const isComplete =
    !!pollData.title?.trim() &&
    pollId !== null &&
    !!pollData.pollVisibility &&
    !!pollData.ballotPrivacy &&
    !!pollData.startsAt &&
    !!pollData.endsAt &&
    ballotLimit > 0 &&
    choices.filter((c) => c.trim() !== "").length > 0 &&
    invalidVoters.length === 0 &&
    !startInPast &&
    !endBeforeStart;

  const missing: string[] = [];
  if (!pollData.title?.trim()) missing.push("titel");
  if (!pollData.pollVisibility) missing.push("offentlig/privat");
  if (!pollData.ballotPrivacy) missing.push("åben/hemmelig stemme");
  if (!pollData.startsAt) missing.push("starttidspunkt");
  if (!pollData.endsAt) missing.push("sluttidspunkt");
  if (ballotLimit <= 0) missing.push("max stemmer per deltager");
  if (choices.filter((c) => c.trim() !== "").length === 0) {
    missing.push("valgmuligheder");
  }
  if (pollId === null) {
    missing.push(
      "Afstemningen er ikke gemt endnu - klik venligst 'Gem kladde' og prøv igen!",
    );
  }
  if (startInPast) {
    missing.push("gyldigt starttidspunkt (skal være i fremtiden)");
  }
  if (endBeforeStart) {
    missing.push("gyldigt sluttidspunkt (skal være efter starttidspunktet)");
  }

  return (
    <div className="create-poll-content">
      <h2>{heading}</h2>

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
            <span>
              {(pollData.showTopN ?? 0) > 0 ? (pollData.showTopN ?? 0) : "Nej"}
            </span>
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
          {invalidVoters.length > 0 && (
            <p className="field-hint" style={{ color: "#e74c3c" }}>
              Følgende stemmeberettigede har flere stemmer end max (
              {ballotLimit}): {invalidVoters.map((v) => v.username).join(", ")}.
              Ret det inden afstemningen kan oprettes.
            </p>
          )}
          <div className="voter-list">
            {voters.length === 0 ? (
              <p className="voter-empty">Ingen tilføjet.</p>
            ) : (
              voters.map((voter, i) => {
                const exceeds =
                  voter.votesAllowed !== undefined &&
                  ballotLimit > 0 &&
                  voter.votesAllowed > ballotLimit;
                return (
                  <div key={i} className="voter-row">
                    <span>{voter.username}</span>
                    {voter.votesAllowed !== undefined && (
                      <span style={exceeds ? { color: "#e74c3c" } : undefined}>
                        Stemmer: {voter.votesAllowed}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: choices */}
        <div>
          <h2>Valgmuligheder</h2>
          {choices.filter((c) => c.trim() !== "").length === 0 ? (
            <p className="field-hint">Ingen valgmuligheder tilføjet.</p>
          ) : (
            choices
              .filter((c) => c.trim() !== "")
              .map((choice, i) => (
                <div key={i} className="overview-field">
                  <label>Valgmulighed {i + 1}:</label>
                  <span>{choice}</span>
                </div>
              ))
          )}
        </div>
      </div>

      <br />
      {!isComplete && missing.length > 0 && (
        <p className="field-hint" style={{ color: "#e74c3c" }}>
          Følgende mangler før afstemningen kan oprettes: {missing.join(", ")}.
        </p>
      )}

      {!hideAction && (
        <button type="button" onClick={onNext} disabled={!isComplete}>
          Opret afstemning
        </button>
      )}
    </div>
  );
}

export default CreatePollPage;
