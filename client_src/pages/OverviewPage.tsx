import "./OverviewPage.css";
import { useContext, useEffect, useState } from "react";
import { WebSocketContext } from "../WebsocketContext.tsx";
import NavBar from "../components/NavBar.tsx";
import {
  calculateTimeRemaining,
  callbackTypes,
  type FrontEndPoll,
} from "../WebLib.ts";
import { FaCheck, FaXmark } from "react-icons/fa6"; //SVG icons
import { FaSearch } from "react-icons/fa";
import { Link, useNavigate } from "react-router/internal/react-server-client";

// ─── Types ────────────────────────────────────────────────────────────────────
// Poll-interfacet beskriver formen på et afstemnings-objekt som vi forventer
// at modtage fra API-endpointet GET /api/polls.
// Alle felter skal matche hvad serveren sender – ellers får vi TypeScript-fejl.

type FilterType = "all" | "eligible" | "drafts";

function statusLabel(poll: FrontEndPoll): string {
  if (poll.poll.status === "finished" || poll.poll.status === "not started") {
    return poll.poll.status;
  }

  return poll.pollProgress;
}

type FolderMap = Record<string, FrontEndPoll[]>;

function buildFolders(polls: FrontEndPoll[]): FolderMap {
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
  const navigate = useNavigate();

  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  function toggleFolder(name: string) {
    setOpenFolders((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  return (
    <aside className="ov-sidebar">
      <button
        type="button"
        className="btn-create"
        onClick={() => navigate("/createpoll")}
      >
        Opret afstemning
      </button>
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
      <div className="ov-folders-header">
        <span className="ov-folders-title">Mapper</span>
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
                    <button
                      type="button"
                      key={poll.poll.id}
                      onClick={() => navigate(`/poll/${poll.poll.id}`)}
                      className={`ov-folder-item ${
                        activeFolderFilter === name
                          ? "ov-folder-item--active"
                          : ""
                      }`}
                    >
                      {poll.poll.title}
                    </button>
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
function PollTable({ polls }: { polls: FrontEndPoll[] }) {
  if (polls.length === 0) {
    return <p className="ov-empty">Ingen afstemninger fundet.</p>;
  }
  const navigate = useNavigate();

  return (
    <table className="ov-table">
      <thead>
        <tr>
          <th>Afstemnings title</th>
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
              <Link className="ov-link-btn" to={`/poll/${poll.poll.id}/overview`}>
                {poll.poll.title}
              </Link>
            </td>
            <td className="ov-col-mystatus">
              {poll.hasVoted
                ? (
			<button
			type="button"
			className="btn-vote"
			onClick={() => navigate(`/poll/${poll.poll.id}/results`)}
			>
			Se resultat <FaCheck />
			</button>
		)
                : poll.poll.status === "started"
                ? (
                  <button
                    type="button"
                    className="btn-vote"
                    onClick={() => navigate(`/poll/${poll.poll.id}/vote`)}
                  >
                    Stem
                  </button>
                )
                : null}
            </td>
            <td className="ov-col-status">{statusLabel(poll)}</td>
            <td className="ov-col-time">{poll.timeLeft}</td>
            <td className="ov-col-visibility">
              {poll.poll.pollVisibility}
            </td>
            <td className="ov-col-anon">
              {poll.poll.ballotPrivacy === "secret" ? <FaCheck /> : <FaXmark />}
            </td>
            <td className="ov-col-owner">{poll.pollOwnerUsername}</td>{" "}
            {/*To-do: Change to username.*/}
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
  // This array is unbounded, as it fetches ALL polls from the database,
  // this will lead to performance issues as the application scales.
  const [polls, setPolls] = useState<FrontEndPoll[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [serverCallback, setServerCallback] = useState(callbackTypes.nil);

  const ws = useContext(WebSocketContext);

  if (ws) {
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      // console.log("Received WebSocket message:", message);
      if (message.type === callbackTypes.refetchVoteCount) {
        console.log("ws: recived refreshVoteCount");
        setServerCallback(message.type);
      }
    };
  }

  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(id);
    };
  }, []);

  // Hent afstemninger fra serveren når siden indlæses.
  // useEffect med tomt dependency-array [] kører kun én gang – ved første render.
  // credentials: "include" sender JWT-cookien med, så serveren ved hvem der spørger,
  // og kan returnere f.eks. hasVoted korrekt for den indloggede bruger.
  useEffect(() => {
    const fetchPolls = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/polls", {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const pollData: FrontEndPoll[] = await res.json();
        setPolls(pollData);
      } catch (err) {
        console.error("Failed to fetch polls:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchPolls();
  }, [serverCallback]);

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
      (poll.poll.title ?? "").toLowerCase().includes(
        searchQuery.toLowerCase(),
      ) ||
      poll.poll.createdBy.toString().toLowerCase().includes(
        searchQuery.toLowerCase(),
      ) // To-do: Change to fetch username for the poll
    );

  const displayedPolls = filteredPolls.map((poll) => {
    const timeLeft = calculateTimeRemaining(poll.poll.endsAt, now);

    return {
      ...poll,
      timeLeft: timeLeft === "00:00:00" ? "afsluttet" : timeLeft,
    };
  });

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
                aria-label="Search polls"
              />
            </div>
          </div>
          {loading
            ? (
              <div className="ov-state">
                <div className="spinner" />
                <span>Henter afstemninger…</span>
              </div>
            )
            : <PollTable polls={displayedPolls} />}
        </main>
      </div>
    </>
  );
}

export default OverviewPage;
