import "./OverviewPage.css";
import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
//SVG icons
import { FaCheck, FaXmark } from "react-icons/fa6";
import { FaSearch } from "react-icons/fa";

// ─── Types ────────────────────────────────────────────────────────────────────
// Poll-interfacet beskriver formen på et afstemnings-objekt som vi forventer
// at modtage fra API-endpointet GET /api/polls.
// Alle felter skal matche hvad serveren sender – ellers får vi TypeScript-fejl.
interface OverviewPoll {
  id: number;
  title: string;
  status: "active" | "finished" | "not_started";
  voteProgress: string;
  timeLeft: string;
  isPublic: boolean;
  isAnonymous: boolean;
  owner: string;
  hasVoted: boolean;
  isEligible: boolean;
  folder?: string;
}

type FilterType = "all" | "eligible" | "drafts";

function statusLabel(poll: OverviewPoll): string {
  if (poll.status === "finished") return "Finished";
  if (poll.status === "not_started") return "Not started";
  return poll.voteProgress;
}

type FolderMap = Record<string, OverviewPoll[]>;

function buildFolders(polls: OverviewPoll[]): FolderMap {
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

function Sidebar(
  {
    activeFilter,
    onFilterChange,
    folderMap,
    activeFolderFilter,
    onFolderClick,
  }: SidebarProps,
) {
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  function toggleFolder(name: string) {
    setOpenFolders((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  return (
    <aside className="ov-sidebar">
      <a href="/create-poll" className="btn-create">Create Poll</a>
      <nav className="ov-filter-nav">
        <button
          type="button"
          className={`ov-filter-btn ${
            activeFilter === "all" && !activeFolderFilter
              ? "ov-filter-btn--active"
              : ""
          }`}
          onClick={() => {
            onFilterChange("all");
            onFolderClick(null);
          }}
        >
          All polls
        </button>
        <button
          type="button"
          className={`ov-filter-btn ${
            activeFilter === "eligible" && !activeFolderFilter
              ? "ov-filter-btn--active"
              : ""
          }`}
          onClick={() => {
            onFilterChange("eligible");
            onFolderClick(null);
          }}
        >
          Polls you are eligible to vote in
        </button>
        <button
          type="button"
          className={`ov-filter-btn ${
            activeFilter === "drafts" && !activeFolderFilter
              ? "ov-filter-btn--active"
              : ""
          }`}
          onClick={() => {
            onFilterChange("drafts");
            onFolderClick(null);
          }}
        >
          Your polls in progress
        </button>
      </nav>
      <div className="ov-folders-header">
        <span className="ov-folders-title">Folders</span>
        <button
          type="button"
          className="ov-folder-add"
          title="Create folder"
          aria-label="Create folder"
        >
          ＋
        </button>
      </div>
      <nav className="ov-folder-nav">
        {Object.keys(folderMap).sort().map((name) => {
          const isOpen = !!openFolders[name];
          return (
            <div key={name} className="ov-folder">
              <button
                type="button"
                className="ov-folder-btn"
                onClick={() => toggleFolder(name)}
                aria-expanded={isOpen}
              >
                <span className="ov-folder-arrow">{isOpen ? "∨" : "›"}</span>
                {name}
              </button>
              {isOpen && (
                <div className="ov-folder-children">
                  {folderMap[name].map((poll) => (
                    <a
                      key={poll.id}
                      href={`/poll/${poll.id}`}
                      className={`ov-folder-item ${
                        activeFolderFilter === name
                          ? "ov-folder-item--active"
                          : ""
                      }`}
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
function PollTable({ polls }: { polls: OverviewPoll[] }) {
  if (polls.length === 0) return <p className="ov-empty">No polls found.</p>;
  return (
    <table className="ov-table">
      <thead>
        <tr>
          <th>Poll title</th>
          <th>Your status</th>
          <th>Status</th>
          <th>Time remaining</th>
          <th>Public/Private</th>
          <th>Anonymous</th>
          <th>Poll owner</th>
        </tr>
      </thead>
      <tbody>
        {polls.map((poll) => (
          <tr key={poll.id}>
            <td className="ov-col-title">
              <a href={`/poll/${poll.id}`}>{poll.title}</a>
            </td>
            <td className="ov-col-mystatus">
              {poll.hasVoted
                ? (
                  <span className="voted-label">
                    Du har stemt <FaCheck />
                  </span>
                )
                : poll.status === "active"
                ? (
                  <a href={`/poll/${poll.id}/vote`} className="btn-vote">
                    Vote
                  </a>
                )
                : null}
            </td>
            <td className="ov-col-status">{statusLabel(poll)}</td>
            <td className="ov-col-time">{poll.timeLeft}</td>
            <td className="ov-col-visibility">
              {poll.isPublic ? "Public" : "Private"}
            </td>
            <td className="ov-col-anon">
              {poll.isAnonymous ? <FaCheck /> : <FaXmark />}
            </td>
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
  const [polls, setPolls] = useState<OverviewPoll[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null>(
    null,
  );
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
        console.error("Failed to fetch polls:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchPolls();
  }, []);

  const folderMap = buildFolders(polls);

  const filteredPolls = polls
    .filter((poll) => {
      if (activeFolderFilter) return (poll.folder ?? "") === activeFolderFilter;
      switch (activeFilter) {
        case "eligible":
          return !poll.hasVoted && poll.status === "active";
        case "drafts":
          return poll.status === "not_started";
        default:
          return true;
      }
    })
    .filter((poll) =>
      poll.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      poll.owner.toLowerCase().includes(searchQuery.toLowerCase())
    );

  return (
    <>
      <NavBar />
      <div className="ov-layout">
        <Sidebar
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          folderMap={folderMap}
          activeFolderFilter={activeFolderFilter}
          onFolderClick={setActiveFolderFilter}
        />
        <main className="ov-main">
          <div className="ov-search-row">
            <div className="ov-search-box">
              <FaSearch />
              <input
                type="search"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ov-search-input"
                aria-label="Search polls"
              />
            </div>
          </div>
          {loading
            ? (
              <div className="ov-state">
                <div className="spinner" />
                <span>Loading polls…</span>
              </div>
            )
            : <PollTable polls={filteredPolls} />}
        </main>
      </div>
    </>
  );
}

export default OverviewPage;
