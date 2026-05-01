import { useEffect } from "react";
import "./OverviewPage.css";

<<<<<<< HEAD
// This is the main entry point of the app
// Currently it is configured to showcase how to create declarative UI with react.
=======
// ─── Types ────────────────────────────────────────────────────────────────────
// Poll-interfacet beskriver formen på et afstemnings-objekt som vi forventer
// at modtage fra API-endpointet GET /api/polls.
// Alle felter skal matche hvad serveren sender – ellers får vi TypeScript-fejl.
 export interface Poll { 
   id: pollId; 
   title: string; 
   description: string; 
   voteStatus: pollStatus; 
   createdBy: userId; 
   createdAt: string; 
   startsAt?: string; 
   endsAt?: string; 
   pollVisibility: pollVisibility; 
   ballotPrivacy: ballotPrivacy; 
   showTopN: number; 
   ballotLimit: number; 
   useBuffer: number; 
 } 

// De tre filtermuligheder brugeren kan vælge i sidebaren
type FilterType = "all" | "eligible" | "drafts";

// ─── Mock data ────────────────────────────────────────────────────────────────
// Disse data bruges som fallback mens API-endpointet ikke er implementeret endnu.
// Når GET /api/polls er klar, fjernes MOCK_POLLS og fetch-fejlhåndteringen nedenfor.
const MOCK_POLLS: Poll[] = [
  {
    id: 1,
    title: "Afstemning 1",
    status: "active",
    voteProgress: "3/14",
    timeLeft: "02:14:33",
    isPublic: true,
    isAnonymous: true,
    owner: "TBF1",
    hasVoted: true,
    folder: "Mappe 2",
  },
  {
    id: 2,
    title: "Afstemning 2",
    status: "finished",
    voteProgress: "14/14",
    timeLeft: "00:00:00",
    isPublic: false,
    isAnonymous: true,
    owner: "TBF1",
    hasVoted: true,
    folder: "Mappe 2",
  },
  {
    id: 3,
    title: "Afstemning 3",
    status: "active",
    voteProgress: "1/61803",
    timeLeft: "05:00:00",
    isPublic: true,
    isAnonymous: false,
    owner: "TBF2",
    hasVoted: false,
    folder: "Mappe 1",
  },
  {
    id: 4,
    title: "Afstemning 4",
    status: "not_started",
    voteProgress: "0/0",
    timeLeft: "10:00:00",
    isPublic: false,
    isAnonymous: false,
    owner: "TBF3",
    hasVoted: false,
    folder: "",
  },
];

// ─── Hjælpefunktion: statusLabel ──────────────────────────────────────────────
// Oversætter poll.status til den tekst der vises i "Status"-kolonnen.
// Er afstemningen aktiv, vises stemmefremdriften (f.eks. "3/14") i stedet for en fast tekst,
// så brugeren løbende kan se hvor mange der har stemt.
function statusLabel(poll: Poll): string {
  if (poll.status === "finished") return "Færdig";
  if (poll.status === "not_started") return "Ikke startet";
  // Aktiv afstemning: vis antal stemmer afgivet ud af total stemmeberettigede
  return poll.voteProgress;
}

// ─── Hjælpetype og -funktion: buildFolders ────────────────────────────────────
// FolderMap er et objekt hvor nøglen er mappenavnet og værdien er listen af
// afstemninger i den mappe. Dette gør det nemt at bygge mapper-træet i sidebaren.
type FolderMap = Record<string, Poll[]>;

// Gennemgår alle afstemninger og grupperer dem efter deres folder-felt.
// Afstemninger uden mappe (folder = "" eller undefined) ignoreres, da de
// ikke skal vises i mappetræet.
function buildFolders(polls: Poll[]): FolderMap {
  const map: FolderMap = {};
  polls.forEach((p) => {
    const key = p.folder ?? "";
    if (key) {
      // Opret mapper-arrayet første gang vi ser denne mappe
      if (!map[key]) map[key] = [];
      map[key].push(p);
    }
  });
  return map;
}

// ─── Sidebar-komponent ────────────────────────────────────────────────────────
// Sidebaren indeholder:
//   1. "Opret Afstemning"-knap (link til oprettelsessiden)
//   2. Filterknapper der styrer hvilke afstemninger der vises i tabellen
//   3. Mappetræ med collapsible mapper og deres afstemninger som links
//
// Al filtertilstand bor i OverviewPage og sendes ned som props, så Sidebar
// ikke behøver at kende til selve datahåndteringen.
interface SidebarProps {
  activeFilter: FilterType;
  onFilterChange: (f: FilterType) => void;
  folderMap: FolderMap;
  activeFolderFilter: string | null;
  onFolderClick: (folder: string | null) => void;
}

function Sidebar({
  activeFilter,
  onFilterChange,
  folderMap,
  activeFolderFilter,
  onFolderClick,
}: SidebarProps) {
  // openFolders holder styr på hvilke mapper der er foldet ud i træet.
  // Det er et objekt hvor nøglen er mappenavnet og værdien er true/false.
  // Vi bruger et objekt frem for et Set fordi React-state fungerer bedst
  // med plain objekter.
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  // Skifter en mappes åben/lukket-tilstand uden at påvirke de andre mapper.
  // Vi spreder den eksisterende state (...prev) og overskriver kun den
  // ene mappe vi klikkede på.
  function toggleFolder(name: string) {
    setOpenFolders((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  return (
    <aside className="ov-sidebar">
      {/* Link til siden hvor man opretter en ny afstemning */}
      <a href="/create-poll" className="btn-create">
        Opret Afstemning
      </a>

      {/* Filterknapper – klik nulstiller også eventuel mappe-filtrering */}
      <nav className="ov-filter-nav">
        <button
          className={`ov-filter-btn ${activeFilter === "all" && !activeFolderFilter ? "ov-filter-btn--active" : ""}`}
          onClick={() => { onFilterChange("all"); onFolderClick(null); }}
        >
          Alle Afstemninger
        </button>
        <button
          className={`ov-filter-btn ${activeFilter === "eligible" && !activeFolderFilter ? "ov-filter-btn--active" : ""}`}
          onClick={() => { onFilterChange("eligible"); onFolderClick(null); }}
        >
          Afstemninger du er stemmeberettigede
        </button>
        <button
          className={`ov-filter-btn ${activeFilter === "drafts" && !activeFolderFilter ? "ov-filter-btn--active" : ""}`}
          onClick={() => { onFilterChange("drafts"); onFolderClick(null); }}
        >
          Dine afstemninger under udarbejdelse
        </button>
      </nav>

      {/* Mapper-sektion */}
      <div className="ov-folders-header">
        <span className="ov-folders-title">Mapper</span>
        {/* TODO: ＋-knappen skal senere åbne en dialog til at oprette en ny mappe */}
        <button className="ov-folder-add" title="Opret mappe" aria-label="Opret mappe">＋</button>
      </div>

      {/* Mappetræ: sorteret alfabetisk, hver mappe kan foldes ud/ind */}
      <nav className="ov-folder-nav">
        {Object.keys(folderMap).sort().map((name) => {
          const isOpen = !!openFolders[name];
          return (
            <div key={name} className="ov-folder">
              {/* Klik på mappenavnet åbner/lukker mappen */}
              <button
                className="ov-folder-btn"
                onClick={() => toggleFolder(name)}
                aria-expanded={isOpen} // Tilgængelighed: skærmlæsere forstår om træet er åbent
              >
                <span className="ov-folder-arrow">{isOpen ? "∨" : "›"}</span>
                {name}
              </button>

              {/* Vis afstemningerne i mappen kun når den er foldet ud */}
              {isOpen && (
                <div className="ov-folder-children">
                  {folderMap[name].map((poll) => (
                    <a
                      key={poll.id}
                      href={`/poll/${poll.id}`}
                      className={`ov-folder-item ${activeFolderFilter === name ? "ov-folder-item--active" : ""}`}
                    >
                      {poll.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

// ─── PollTable-komponent ──────────────────────────────────────────────────────
// Viser listen af afstemninger som en tabel jf. wireframe figur 4.2.
// Modtager den allerede filtrerede og søgte liste som prop, så komponenten
// selv ikke behøver at kende til filtertilstanden.
function PollTable({ polls }: { polls: Poll[] }) {
  // Vis en besked hvis ingen afstemninger matcher det aktive filter/søgning
  if (polls.length === 0) {
    return <p className="ov-empty">Ingen afstemninger fundet.</p>;
  }

  return (
    <table className="ov-table">
      <thead>
        <tr>
          <th>Afstemnings titel</th>
          <th>Din status</th>
          <th>Status</th>
          <th>Tid tilbage</th>
          <th>Offentlig/Privat</th>
          <th>Anonym</th>
          <th>Afstemnings ejer</th>
        </tr>
      </thead>
      <tbody>
        {polls.map((poll) => (
          <tr key={poll.id}>

            {/* Afstemningens titel linker til detaljesiden */}
            <td className="ov-col-title">
              <a href={`/poll/${poll.id}`}>{poll.title}</a>
            </td>

            {/* "Din status": viser brugerens personlige relation til afstemningen.
                - Har stemt → tekst + flueben
                - Ikke stemt + afstemning er aktiv → blå "Stem"-knap der linker til stemme-siden
                - Ikke stemt + afstemning er ikke aktiv → ingenting (tom celle) */}
            <td className="ov-col-mystatus">
              {poll.hasVoted ? (
                <span className="voted-label">
                  Du har stemt
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
              ) : poll.status === "active" ? (
                <a href={`/poll/${poll.id}/vote`} className="btn-vote">
                  Stem
                </a>
              ) : null}
            </td>

            {/* Overordnet status på afstemningen – tekst fra statusLabel() */}
            <td className="ov-col-status">{statusLabel(poll)}</td>

            {/* Tid tilbage til deadline, formateret af serveren */}
            <td className="ov-col-time">{poll.timeLeft}</td>

            {/* Om afstemningen er åben for alle eller kun inviterede */}
            <td className="ov-col-visibility">
              {poll.isPublic ? "Offentlig" : "Privat"}
            </td>

            {/* Anonym-kolonnen viser et flueben eller kryds som SVG-ikoner.
                Vi bruger SVG i stedet for ✓/✗ tegn for at sikre ensartet
                visuel størrelse og farve på tværs af browsere. */}
            <td className="ov-col-anon">
              {poll.isAnonymous ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="icon-check" aria-label="Ja">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="icon-cross" aria-label="Nej">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              )}
            </td>

            {/* Brugernavnet på den person der oprettede afstemningen */}
            <td className="ov-col-owner">{poll.owner}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── OverviewPage ─────────────────────────────────────────────────────────────
// Hoved-komponenten for oversigts-siden (figur 4.2).
// Håndterer:
//   - Hentning af afstemninger fra serveren (eller mock-data under udvikling)
//   - Filtertilstand (sidebar-valg og mapper)
//   - Søgetilstand
// Sender de processerede data ned til <Sidebar> og <PollTable>.
>>>>>>> 1ddd4dbe6a5e0cbf8d02e1dcf7f5e350a40df600
function OverviewPage() {
  // We can declare a list of variables, containing stuff we want rendered to the screen.
  const blocks = [
    {
      id: 1,
      name: "Glowstone",
      url: "https://minecraft.wiki/images/Glowstone_JE4_BE2.png?0d5b0",
    },
    {
      id: 2,
      name: "Block of Gold",
      url: "https://minecraft.wiki/images/Block_of_Gold_JE6_BE3.png?09478",
    },
    {
      id: 3,
      name: "Jukebox",
      url:
        "https://minecraft.wiki/images/thumb/Jukebox_JE2_BE2.png/150px-Jukebox_JE2_BE2.png?50367",
    },
  ];

  useEffect(() => {
    fetch("http://localhost:8000/api/dinosaur", {
      method: "GET",
    });
  }, []);

  // React is just JavaScript functions that return HTML.
  // We can then inline JavaScript to create a loop inside the HTML,
  // such that each entry from the list above is used to create a new object in HTML.
  // In this way we can write declarative reusable UI components.
  return (
    <>
      {blocks.map((block) => (
        <div className="content-block">
          <img src={block.url} />
          <br />
          <span>{block.name}!!!</span>
        </div>
      ))}
      <text>Hello, World!</text>
    </>
  );
}

export default OverviewPage;
