import { useState } from 'react';

/* Shared poll data type used across all steps,
to avoid typos later on.  */
type PollData = {
    title: string;
    description: string;
    visibility: string;
    secrecyMode: string;
    startNow: boolean;
    startBuffer: boolean;
    startTime: string;
    endTime: string;
    startDate: string;
    endDate: string;
    onlyToday: boolean;
    showResultsAfter: boolean;
    topNOnly: boolean;
    topN: number | null;
    maxChoices: number;
};

/* Page 1, fig. 4.3 in the report.
        The page where the creator of the poll inputs all relevant basic information.
        More options are seen on later pages.
*/

// Types that can only be one of three strings. These are used for validating some of the option inputs.
type Visibility = "public" | "private" | "";
type Secrecy = "open" | "secret" | "";

function CreatePollStep1({ onNext }: { onNext: (data: PollData) => void }) {

    // All state variables for page 1.
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [visibility, setVisibility] = useState<Visibility>("");
    const [secrecyMode, setSecrecyMode] = useState<Secrecy>("");
    const [startNow, setStartNow] = useState(true);
    const [startBuffer, setStartBuffer] = useState(true);
    const [startTime, setStartTime] = useState("");
    const [endTime, setEndTime] = useState("");
    const [startDate, setStartDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const [onlyToday, setOnlyToday] = useState(false);
    const [showResultsAfter, setShowResultsAfter] = useState(true);
    const [topNOnly, setTopNOnly] = useState(false);
    const [topN, setTopN] = useState("");
    const [maxChoices, setMaxChoices] = useState("");

    // Gets todays date.
    const today = new Date().toISOString().split("T")[0];

    // Checks if "only today" is checked, and lets creator edit if unchecked.
    function handleOnlyToday(checked: boolean) {
        setOnlyToday(checked);
        if (checked) {
            setStartDate(today);
            setEndDate(today);
        }
    }

    // Checks "start now", and lets creator edit if unchecked.
    function handleStartNow(checked: boolean) {
        setStartNow(checked);
        if (checked) setStartTime("");
    }

    // Collects all state into one object, and sendst it to the backend as a JSON. Calls onNext, so it can be viewed in overview.
    async function handleSave() {
        const pollData: PollData = {
            title,
            description,
            visibility,
            secrecyMode,
            startNow,
            startBuffer,
            startTime,
            endTime,
            startDate,
            endDate,
            onlyToday,
            showResultsAfter,
            topNOnly,
            topN: topNOnly ? Number(topN) : null, // If top N is not checked, send null.
            maxChoices: Number(maxChoices), // Converts string from input to a number.
        };

        const res = await fetch("http://localhost:8000/createpoll", {
            method: "POST",
            headers: {
                "Content-Type": "application/json", // Tells the server to expect JSON.
            },
            body: JSON.stringify(pollData), // Converts the object to a JSON string.
        });

        if (res.status == 200) {
            onNext(pollData); // Pass data up to CreatePollPage on success.
        } else {
            console.log("Failed to save information, status:" + res.status);
        }
    }

    // All visible elements for page 1
    return (
        <div>
            <h1>Opret afstemning</h1>

            <h2>Generel information</h2>

            {/* Field for the poll title */}
            <label htmlFor="title">Afstemnings titel</label>
            <input
                id="title"
                name="title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
            />

            <br />

            {/* Field for the poll description */}
            <label htmlFor="description">Afstemnings beskrivelse</label>
            <textarea
                id="description"
                name="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
            />

            <h2>Synligheds indstillinger</h2>

            {/* User chooses whether the poll is public or private */}
            <label htmlFor="visibility">Offentlig eller privat afstemning</label>
            <select
                id="visibility"
                name="visibility"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
                <option value="">Select...</option>
                <option value="public">Offentlig</option>
                <option value="private">Privat</option>
            </select>

            <br />

            {/* User chooses whether votes are open or secret */}
            <label htmlFor="secrecyMode">Åben eller hemmelig stemme</label>
            <select
                id="secrecyMode"
                name="secrecyMode"
                value={secrecyMode}
                onChange={(e) => setSecrecyMode(e.target.value as Secrecy)}
            >
                <option value="">Select...</option>
                <option value="open">Åben</option>
                <option value="secret">Hemmelig</option>
            </select>

            <h2>Resultat indstillinger</h2>

            {/* Checkbox: whether voters can see the results after the poll ends */}
            <label>
                <input
                    type="checkbox"
                    checked={showResultsAfter}
                    onChange={(e) => setShowResultsAfter(e.target.checked)}
                />
                Vis resultater efter
            </label>

            <br />

            {/* Checkbox: whether only the top N choices should be shown */}
            <label>
                <input
                    type="checkbox"
                    checked={topNOnly}
                    onChange={(e) => setTopNOnly(e.target.checked)}
                />
                Vis kun top n
            </label>

            {/* Only shown when top N is checked, lets the user enter the N value */}
            {topNOnly && (
                <>
                    <br />
                    <label htmlFor="topN">Top N:</label>
                    <input
                        id="topN"
                        name="topN"
                        type="number"
                        min={1}
                        value={topN}
                        onChange={(e) => setTopN(e.target.value)}
                    />
                </>
            )}

            <br />

            {/* How many choices each voter is allowed to select */}
            <label htmlFor="maxChoices">Max antal stemmer per deltager</label>
            <input
                id="maxChoices"
                name="maxChoices"
                type="number"
                min={1}
                value={maxChoices}
                onChange={(e) => setMaxChoices(e.target.value)}
            />

            <br />

            <h2>Tid og dato</h2>

            {/* Start time input, disabled when "start now" is checked */}
            <label htmlFor="startTime">Starts tidspunkt</label>
            <input
                id="startTime"
                name="startTime"
                type="time"
                value={startTime}
                disabled={startNow}
                onChange={(e) => setStartTime(e.target.value)}
            />

            {/* Checkbox: start the poll immediately */}
            <label>
                <input
                    type="checkbox"
                    checked={startNow}
                    onChange={(e) => handleStartNow(e.target.checked)}
                />
                Start nu
            </label>

            {/* Checkbox: add a 5 minute buffer before the poll starts */}
            <label>
                <input
                    type="checkbox"
                    checked={startBuffer}
                    onChange={(e) => setStartBuffer(e.target.checked)}
                />
                Start om 5-minutter
            </label>

            {/* End time input */}
            <label htmlFor="endTime">Sluts tidspunkt</label>
            <input
                id="endTime"
                name="endTime"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
            />

            {/* Start date input, disabled when "only today" is checked */}
            <label htmlFor="startDate">Starts dato</label>
            <input
                id="startDate"
                name="startDate"
                type="date"
                value={startDate}
                disabled={onlyToday}
                onChange={(e) => setStartDate(e.target.value)}
            />

            {/* End date input, disabled when "only today" is checked */}
            <label htmlFor="endDate">Slut dato</label>
            <input
                id="endDate"
                name="endDate"
                type="date"
                value={endDate}
                disabled={onlyToday}
                onChange={(e) => setEndDate(e.target.value)}
            />

            {/* Checkbox: lock the poll to today's date only */}
            <label>
                <input
                    type="checkbox"
                    checked={onlyToday}
                    onChange={(e) => handleOnlyToday(e.target.checked)}
                />
                Afstemning er kun i dag
            </label>

            <br />

            <button type="button" onClick={handleSave}>
                Gem og fortsæt
            </button>
        </div>
    );
}

/* Page 2, fig. 4.4 in the report.
        For now just a simple name input field.
*/

function CreatePollStep2({ onNext }: { onNext: () => void }) {
    const [name, setName] = useState("");

    return (
        <div>
            <h1>Rediger stemmeberettigede</h1>

            {/* Simple name input */}
            <label htmlFor="name">Navn</label>
            <input
                id="name"
                name="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
            />

            <br />

            <button type="button" onClick={onNext}>Gem og fortsæt</button>
        </div>
    )
}

/* Page 3, fig. 4.6 in the report.
        Shows an overview of the poll data collected in step 1, 
        and lets the creator add choices that can be voted on.
*/

function CreatePollStep3({ onNext, pollData }: {
    onNext: () => void;
    pollData: PollData;
}) {
    // List of choices, starts with one empty field.
    const [choices, setChoices] = useState<string[]>([""]);

    // Updates a single choice at the given index.
    function handleChoiceChange(index: number, value: string) {
        const updated = [...choices];
        updated[index] = value;
        setChoices(updated);
    }

    // Adds a new empty choice field.
    function handleAddChoice() {
        setChoices([...choices, ""]);
    }

    // Removes the choice at the given index.
    function handleRemoveChoice(index: number) {
        setChoices(choices.filter((_, i) => i !== index));
    }

    // Sends the choices to the backend and calls onNext on success.
    async function handleSave() {
        const res = await fetch("http://localhost:8000/createpoll/choices", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ choices }),
        });

        if (res.status === 200) {
            onNext();
        } else {
            console.log("Failed to save choices, status: " + res.status);
        }
    }

    return (
        <div>
            <h1>Færdiggør afstemning</h1>

            {/* Overview of the poll data collected in step 1 */}
            <h2>Oversigt</h2>

            <label>Afstemnings titel:</label>
            <span>{pollData.title}</span>

            <br />

            <label>Afstemnings beskrivelse:</label>
            <span>{pollData.description}</span>

            <br />

            <label>Privat eller offentlig afstemning:</label>
            <span>{pollData.visibility === "public" ? "Offentlig afstemning" : "Privat afstemning"}</span>

            <br />

            <label>Anonym/hemmelig afstemning:</label>
            <span>{pollData.secrecyMode === "secret" ? "✓" : "✗"}</span>

            <br />

            <label>Viser top n resultater:</label>
            <span>{pollData.topN ?? "Nej"}</span>

            <br />

            <label>Antal valgmuligheder per stemme:</label>
            <span>{pollData.maxChoices}</span>

            <br />

            <label>Afstemnings start:</label>
            <span>{pollData.startDate} {pollData.startTime}</span>

            <br />

            <label>Afstemnings slut:</label>
            <span>{pollData.endDate} {pollData.endTime}</span>

            {/* Dynamic list of choice inputs, at least one is always shown */}
            <h2>Valgmuligheder</h2>

            {choices.map((choice, i) => (
                <div key={i}>
                    <label htmlFor={`choice-${i}`}>Valgmulighed {i + 1}:</label>
                    <input
                        id={`choice-${i}`}
                        type="text"
                        value={choice}
                        onChange={(e) => handleChoiceChange(i, e.target.value)}
                    />
                    {/* Only show remove button if there is more than one choice */}
                    {choices.length > 1 && (
                        <button type="button" onClick={() => handleRemoveChoice(i)}>Fjern</button>
                    )}
                </div>
            ))}

            <br />

            <button type="button" onClick={handleAddChoice}>Tilføj valgmulighed</button>

            <br />
            <br />

            <button type="button" onClick={handleSave}>Gem og fortsæt</button>
        </div>
    );
}

/* Navigation between the steps, as seen in all the figures.
        Lets the user freely navigate between the pages,
        plus delete and save the poll. 
*/

function CreatePollPage({ onExit }: { onExit: () => void }) {
    // Tracks which step is currently shown (0 = step 1, 1 = step 2, 2 = step 3).
    const [step, setStep] = useState(0);

    // Stores the poll data from step 1 so it can be displayed in the overview on step 3.
    const [pollData, setPollData] = useState<PollData>({
        title: "",
        description: "",
        visibility: "",
        secrecyMode: "",
        startNow: false,
        startBuffer: false,
        startTime: "",
        endTime: "",
        startDate: "",
        endDate: "",
        onlyToday: false,
        showResultsAfter: true,
        topNOnly: false,
        topN: null,
        maxChoices: 1,
    });

    // Labels for the navigation bar buttons.
    const steps = [
        "Afstemnings information",
        "Rediger stemmeberettigede",
        "Færdiggør afstemning",
    ];

    return (
        <div>
            {/* Show the correct step based on current step index */}
            {step === 0 && <CreatePollStep1 onNext={(data) => { setPollData(data); setStep(1); }} />}
            {step === 1 && <CreatePollStep2 onNext={() => setStep(2)} />}
            {step === 2 && <CreatePollStep3 onNext={onExit} pollData={pollData} />}

            {/* Navigation bar shared across all steps */}
            <div>
                {/* Returns to overview page */}
                <button type="button" onClick={onExit}>Slet afstemning</button>

                {/* Go to previous step, stops at step 0 */}
                <button type="button" onClick={() => setStep(s => Math.max(0, s - 1))}>«</button>

                {/* Step buttons, current step is disabled so it can't be clicked */}
                {steps.map((s, i) => (
                    <button key={i} type="button" onClick={() => setStep(i)} disabled={i === step}>
                        {s}
                    </button>
                ))}

                {/* Go to next step, stops at step 2 */}
                <button type="button" onClick={() => setStep(s => Math.min(2, s + 1))}>»</button>

                {/* Save the poll without exiting */}
                <button type="button">Gem afstemning</button>
            </div>
        </div>
    );
}

export default CreatePollPage;