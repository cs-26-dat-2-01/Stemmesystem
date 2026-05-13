import "./OverviewPage.css";
import { useEffect, useRef, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import { calculateTimeRemaining, type FrontEndPoll } from "../WebLib.ts";
import { FaCheck, FaXmark } from "react-icons/fa6";
import { FaSearch } from "react-icons/fa";

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterType = "all" | "eligible" | "drafts";

// ─── Helper: statusLabel ──────────────────────────────────────────────────────
// Oversætter poll.status til en læsbar dansk tekst i Status-kolonnen.
// For aktive afstemninger vises stemmefremdriften (f.eks. "3/14") i stedet.
function statusLabel(poll: FrontEndPoll): string {
  if (poll.poll.status === "finished") return "Afsluttet";
  if (poll.poll.status === "not started") return "Ikke startet";
  if (poll.poll.status === "draft") return "Kladde";
  if (poll.poll.status === "saved") return "Gemt";
  // "started" — vis stemmefremdrift
  return poll.pollProgress;
}

// ─── Helper: buildFolders ─────────────────────────────────────────────────────
// Grupperer afstemninger efter mappe-felt til sidebares mappetræ.
type FolderMap = Record<string, FrontEndPoll[]>;

function buildFolders(polls: FrontEndPoll[]): FolderMap {
  const map: FolderMap = {};
  polls.forEach((p) => {
    const key = p.folder ?? "";
    if (key) {
      if (!map[key]) map[key] = [];
      map[key].push(p);
    }
  });
  return map;
}

// ─── Helper: formatTime ───────────────────────────────────────────────────────
// Formaterer millisekunder til HH:MM:SS streng.
function formatTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// ─── Sidebar-komponent ────────────────────────────────────────────────────────
// Sidebaren indeholder:
//   1. "Opret Afstemning"-knap
//   2. Filterknapper der styrer hvilke afstemninger der vises
// Mapper er kommenteret ud indtil mapper-funktionalitet er implementeret.
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
  // folderMap, — kommenteret ud indtil mapper er implementeret
  activeFolderFilter,
  onFolderClick,
}: SidebarProps) {
  // const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  // function toggleFolder(name: string) {
  //   setOpenFolders((prev) => ({ ...prev, [name]: !prev[name] }));
  // }

  return (
    <aside className="ov-sidebar">
      <a href="/createpoll" className="btn-create">Opret afstemning</a>
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
          Alle afstemninger
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
          Afstemninger du er stemmeberettigede til
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
          Dine igangværende afstemninger
        </button>
      </nav>

      {/* Mapper — kommenteret ud indtil mapper-funktionalitet er implementeret
      <div className="ov-folders-header">
        <span className="ov-folders-title">Mapper</span>
        <button
          type="button"
          className="ov-folder-add"
          title="Opret mappe"
          aria-label="Opret mappe"
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
                      key={poll.poll.id}
                      href={`/poll/${poll.poll.id}`}
                      className={`ov-folder-item ${
                        activeFolderFilter === name ? "ov-folder-item--active" : ""
                      }`}
                    >
                      {poll.poll.title}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      */}
    </aside>
  );
}

// ─── PollTable-komponent ──────────────────────────────────────────────────────
// Viser listen af afstemninger som en tabel jf. wireframe figur 4.2.
function PollTable({ polls }: { polls: FrontEndPoll[] }) {
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
          <th>Hemmelig</th>
          <th>Afstemnings ejer</th>
        </tr>
      </thead>
      <tbody>
        {polls.map((poll) => (
          <tr key={poll.poll.id}>
            <td className="ov-col-title">
              <a href={`/poll/${poll.poll.id}`}>{poll.poll.title}</a>
            </td>

            {/* Din status:
                - Afsluttet → "Se resultat"-knap
                - Aktiv + har stemt → "Du har stemt" med hak
                - Aktiv + ikke stemt → "Stem"-knap
                - Ikke startet → tom */}
            <td className="ov-col-mystatus">
              {poll.poll.status === "finished" ? (
                <a href={`/poll/${poll.poll.id}/results`} className="btn-results">
                  Se resultat
                </a>
              ) : poll.hasVoted ? (
                <span className="voted-label">
                  Du har stemt <FaCheck />
                </span>
              ) : poll.poll.status === "started" ? (
                <a href={`/poll/${poll.poll.id}/vote`} className="btn-vote">
                  Stem
                </a>
              ) : null}
            </td>

            <td className="ov-col-status">{statusLabel(poll)}</td>

            {/* Tid tilbage — viser "Starter om: HH:MM:SS" for ikke-startede,
                eller nedtælling til afslutning for aktive afstemninger */}
            <td className="ov-col-time">{poll.timeLeft}</td>

            <td className="ov-col-visibility">
              {poll.poll.pollVisibility === "public" ? "Offentlig" : "Privat"}
            </td>

            <td className="ov-col-anon">
              {poll.poll.ballotPrivacy === "secret" ? <FaCheck /> : <FaXmark />}
            </td>

            <td className="ov-col-owner">{poll.poll.createdBy}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── OverviewPage ─────────────────────────────────────────────────────────────
// Hoved-komponenten for oversigts-siden (figur 4.2).
// Henter afstemninger én gang og opdaterer derefter timere hvert sekund
// via setInterval uden at re-fetche fra serveren.
function OverviewPage() {
  const [polls, setPolls] = useState<FrontEndPoll[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // rawPollsRef gemmer rådata så timer-intervallet kan genberegne
  // tid uden at trigge et nyt fetch fra serveren.
  const rawPollsRef = useRef<FrontEndPoll[]>([]);

  // Hent afstemninger fra serveren når siden indlæses.
  // credentials: "include" sender JWT-cookien med, så serveren ved hvem der spørger.
  useEffect(() => {
    const fetchPolls = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/polls", {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: FrontEndPoll[] = await res.json();
        // Beregn initial tid for hver afstemning
        data.forEach((p) => {
          p.timeLeft = calculateTimeRemaining(p.poll);
        });
        rawPollsRef.current = data;
        setPolls([...data]);
      } catch (err) {
        console.error("Failed to fetch polls:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchPolls();
  }, []);

  // Opdater timere hvert sekund uden at re-fetche fra serveren.
  // Rydder intervallet når komponenten unmountes for at undgå memory leaks.
  useEffect(() => {
    const interval = setInterval(() => {
      if (rawPollsRef.current.length === 0) return;

      const updated = rawPollsRef.current.map((p) => {
        let timeLeft: string;

        if (p.poll.status === "not started" && p.poll.startsAt) {
          // Afstemning der ikke er startet endnu — vis tid til start
          const diffMs = new Date(p.poll.startsAt).getTime() - Date.now();
          timeLeft = diffMs > 0
            ? `Starter om: ${formatTime(diffMs)}`
            : "Starter snart";
        } else {
          // Aktiv afstemning — vis tid til afslutning
          timeLeft = calculateTimeRemaining(p.poll);
        }

        return { ...p, timeLeft };
      });

      rawPollsRef.current = updated;
      setPolls([...updated]);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const folderMap = buildFolders(polls);

  const filteredPolls = polls
    .filter((poll) => {
      if (activeFolderFilter) return (poll.folder ?? "") === activeFolderFilter;
      switch (activeFilter) {
        case "eligible":
          return !poll.hasVoted && poll.poll.status === "started";
        case "drafts":
          return poll.poll.status === "not started";
        default:
          return true;
      }
    })
    .filter((poll) =>
      poll.poll.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      poll.poll.createdBy
        .toString()
        .toLowerCase()
        .includes(searchQuery.toLowerCase())
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
                placeholder="Søg i afstemninger..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ov-search-input"
                aria-label="Søg i afstemninger"
              />
            </div>
          </div>
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
