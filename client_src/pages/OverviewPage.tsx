import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import "./OverviewPage.css";

// ─── Types ────────────────────────────────────────────────────────────────────
// Poll-interfacet beskriver formen på et afstemnings-objekt som vi forventer
// at modtage fra API-endpointet GET /api/polls.
// Alle felter skal matche hvad serveren sender – ellers får vi TypeScript-fejl.
interface Poll {
  id: number;
  title: string;
  // "active" = afstemning er i gang, "finished" = afsluttet, "not_started" = endnu ikke åbnet
  status: "active" | "finished" | "not_started";
  // Hvor mange har stemt ud af det totale antal stemmeberettigede, f.eks. "3/14"
  voteProgress: string;
  // Resterende tid som en formateret streng, f.eks. "02:14:33" (timer:minutter:sekunder)
  timeLeft: string;
  isPublic: boolean;
  isAnonymous: boolean;
  owner: string;
  // Om den indloggede bruger selv har afgivet stemme i denne afstemning
  hasVoted: boolean;
  // Hvilken mappe afstemningen evt. er placeret i – valgfri (undefined = ingen mappe)
  folder?: string;
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
function OverviewPage() {
  // polls: den rå liste af afstemninger vi fik fra serveren
  const [polls, setPolls] = useState<Poll[]>([]);
  // loading: true mens vi venter på svar fra serveren
  const [loading, setLoading] = useState(true);
  // activeFilter: hvilket sidebarfilter er valgt (all / eligible / drafts)
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  // activeFolderFilter: navn på den mappe brugeren har valgt, eller null hvis ingen
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null>(null);
  // searchQuery: indholdet af søgefeltet
  const [searchQuery, setSearchQuery] = useState("");

  // Hent afstemninger fra serveren når siden indlæses.
  // useEffect med tomt dependency-array [] kører kun én gang – ved første render.
  // credentials: "include" sender JWT-cookien med, så serveren ved hvem der spørger,
  // og kan returnere f.eks. hasVoted korrekt for den indloggede bruger.
  useEffect(() => {
    const fetchPolls = async () => {
      setLoading(true);
      try {
        const res = await fetch("http://localhost:8000/api/polls", {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setPolls(await res.json());
      } catch (err) {
        // Fallback til mock-data mens API-endpointet ikke er implementeret.
        // TODO: fjern denne catch-blok og MOCK_POLLS når /api/polls er klar.
        console.warn("API not reachable, using mock data:", err);
        setPolls(MOCK_POLLS);
      } finally {
        // Skjul loading-indikatoren uanset om fetch lykkedes eller ej
        setLoading(false);
      }
    };
    fetchPolls();
  }, []);

  // Byg mappetræet ud fra den aktuelle poll-liste.
  // Dette genberegnes automatisk hver gang polls ændres (f.eks. efter fetch).
  const folderMap = buildFolders(polls);

  // Filtrer og søg i afstemningerne.
  // Vi kæder to .filter()-kald:
  //   1. Sidebarfilter/mappefilter – bestemmer hvilken "gruppe" der vises
  //   2. Søgefilter – yderligere indsnævring baseret på søgeteksten
  const filteredPolls = polls
    .filter((poll) => {
      // Mappe-filter har højere prioritet end sidebarfilteret:
      // hvis en mappe er valgt, vises kun afstemninger i den mappe
      if (activeFolderFilter) return (poll.folder ?? "") === activeFolderFilter;

      switch (activeFilter) {
        // Stemmeberettigede: aktive afstemninger hvor brugeren ikke har stemt endnu
        case "eligible": return !poll.hasVoted && poll.status === "active";
        // Under udarbejdelse: afstemninger der endnu ikke er startet
        case "drafts": return poll.status === "not_started";
        // Standard: vis alle afstemninger
        default: return true;
      }
    })
    // Søgning på titel og ejer (case-insensitiv)
    .filter((poll) =>
      poll.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      poll.owner.toLowerCase().includes(searchQuery.toLowerCase())
    );

  return (
    <>
      <NavBar />
      <div className="ov-layout">
        {/* Sidebar: modtager filtertilstand og callbacks til at ændre den */}
        <Sidebar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          folderMap={folderMap}
          activeFolderFilter={activeFolderFilter}
          onFolderClick={setActiveFolderFilter}
        />

        <main className="ov-main">
          {/* Søgefelt øverst over tabellen */}
          <div className="ov-search-row">
            <div className="ov-search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                placeholder="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ov-search-input"
                aria-label="Søg afstemninger"
              />
            </div>
          </div>

          {/* Vis loading-spinner mens data hentes, ellers tabellen */}
          {loading ? (
            <div className="ov-state">
              <div className="spinner" />
              <span>Henter afstemninger…</span>
            </div>
          ) : (
            <PollTable polls={filteredPolls} />
          )}
        </main>
      </div>
    </>
  );
}

export default OverviewPage;
