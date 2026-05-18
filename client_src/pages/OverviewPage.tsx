import "./OverviewPage.css";
import { useContext, useEffect, useRef, useState } from "react";
import { WebSocketContext } from "../WebsocketContext.tsx";
import NavBar from "../components/NavBar.tsx";
import {
  calculateTimeRemaining,
  callbackTypes,
  formatTime,
  type FrontEndPoll,
  type pollStatus,
} from "../WebLib.ts";
import { Link, useNavigate } from "react-router";
import { FaCheck, FaXmark } from "react-icons/fa6"; //SVG icons
import { FaSearch } from "react-icons/fa";

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterType = "all" | "eligible" | "drafts";

// ─── Helper: calculate time ───────────────────────────────────────────────────

/**
 * Calculates the time entry for the overview page table.
 */
function calculateTimeLeft(p: FrontEndPoll) {
  let timeLeft: string;

  if (p.poll.status === "not started" && p.poll.startsAt) {
    // Afstemning der ikke er startet endnu — vis tid til start
    const diffMs = new Date(p.poll.startsAt).getTime() - Date.now();
    timeLeft =
      diffMs > 0 ? `Starter om: ${formatTime(diffMs)}` : "Starter snart";
  } else {
    // Aktiv afstemning — vis tid til afslutning
    timeLeft = calculateTimeRemaining(p.poll.endsAt);
  }
  return timeLeft;
}

// ─── Helper: statusLabel ──────────────────────────────────────────────────────
// Oversætter poll.status til en læsbar dansk tekst i Status-kolonnen.
// For aktive afstemninger vises stemmefremdriften (f.eks. "3/14") i stedet.
function statusLabel(poll: FrontEndPoll): string {
  const statusMap: Record<pollStatus, string> = {
    "draft": "Kladde",
    "not started": poll.timeLeft,
    "started": `Slutter om ${poll.timeLeft}`,
    "closing": "Lukker afstemning",
    "finished": "Afsluttet",
    "invalidated": "Fejl",
  };

  const status = poll.poll.status;

  // If the status exists in our map, return the translation.
  // Otherwise, default to the progress string.
  return statusMap[status] ?? poll.pollProgress;
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

function useIsMobile(breakpoint: number) {
  const [isMobile, setIsMobile] = useState(globalThis.innerWidth < breakpoint);

  useEffect(() => {
    const onResize = () => setIsMobile(globalThis.innerWidth < breakpoint);
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, [breakpoint]);

  return isMobile;
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
  const navigate = useNavigate();

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
function PollTable(
  { polls, currentUsername }: {
    polls: FrontEndPoll[];
    currentUsername: string | null;
  },
) {
  if (polls.length === 0) {
    return <p className="ov-empty">Ingen afstemninger fundet.</p>;
  }

  const navigate = useNavigate();
  const isMobile = useIsMobile(900);
// poll can only editted by the owner, and only while in draft or not started. 
  // Pollen kan redigeres af ejeren mens den enten er kladde eller publiceret
  function canOwnerEdit(poll: FrontEndPoll): boolean {
    if (poll.pollOwnerUsername !== currentUsername) return false;
    if (poll.poll.status === "draft") return true;
    if (poll.poll.status === "not started" && poll.poll.startsAt) {
      return new Date(poll.poll.startsAt).getTime() > Date.now();
    }
    return false;
  }

  return (
    <table className="ov-table">
      <thead className="ov-table-head">
        <tr className="ov-table-row">
          <th>Afstemnings titel</th>
          <th>Din status</th>
          <th>Status</th>
          <th>Offentlig/Privat</th>
          <th>Hemmelig</th>
          <th>Afstemnings ejer</th>
        </tr>
      </thead>
      {isMobile ? (
        <tbody className="ov-table-body">
          {polls.map((poll) => (
            <tr key={poll.poll.id} className="ov-table-row">
              <td className="ov-col-title">
                <div className="ov-col-item">
                  <b className="ov-col-item-title">Afstemnings titel:</b>

                  <Link className="ov-link-btn" to={`/poll/${poll.poll.id}`}>
                    {poll.poll.title}
                  </Link>
                </div>
              </td>

              <td className="ov-col-mystatus">
                <div className="ov-col-item">
                  <b className="ov-col-item-title">Din status:</b>

                  {poll.hasVoted || poll.poll.status === "finished" ? (
                    <Link
                      to={`/poll/${poll.poll.id}/results`}
                      className="btn-vote"
                    >
                      Se resultat
                    </Link>
                  ) : poll.hasVoted ? (
                    <span className="voted-label">
                      Du har stemt <FaCheck />
                    </span>
                  ) : poll.poll.status === "started" ? (
                    <Link
                      to={`/poll/${poll.poll.id}/vote`}
                      className="btn-vote"
                    >
                      Stem
                    </Link>
                  ) : canOwnerEdit(poll) ? (
                    <Link
                      to={`/createpoll/${poll.poll.id}`}
                      className="btn-vote"
                    >
                      {poll.poll.status === "draft"
                        ? "Rediger kladde"
                        : "Rediger afstemning"}
                    </Link>
                  ) : null}
                </div>
              </td>

              <td className="ov-col-status">
                <div className="ov-col-item">
                  <b className="ov-col-item-title">Status:</b>

                  <span>{statusLabel(poll)}</span>
                </div>
              </td>

              <td className="ov-col-visibility">
                <div className="ov-col-item">
                  <b className="ov-col-item-title">Offentlig/Privat:</b>

                  <span>
                    {poll.poll.pollVisibility === "public"
                      ? "Offentlig"
                      : "Privat"}
                  </span>
                </div>
              </td>

              <td className="ov-col-anon">
                <div className="ov-col-item">
                  <b className="ov-col-item-title">Hemmelig:</b>

                  <span>
                    {poll.poll.ballotPrivacy === "secret" ? (
                      <FaCheck />
                    ) : (
                      <FaXmark />
                    )}
                  </span>
                </div>
              </td>

              <td className="ov-col-owner">
                <div className="ov-col-item">
                  <b className="ov-col-item-title">Afstemnings ejer:</b>

                  <span>{poll.poll.createdBy}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      ) : (
        <tbody className="ov-table-body">
          {polls.map((poll) => (
            <tr key={poll.poll.id} className="ov-table-row">
              <td className="ov-col-title">
                <Link
                  className="ov-link-btn"
                  to={`/poll/${poll.poll.id}/overview`}
                >
                  {poll.poll.title}
                </Link>
              </td>
              <td className="ov-col-mystatus">
                {poll.hasVoted || poll.poll.status === "finished" ? (
                  <button
                    type="button"
                    className="btn-vote"
                    onClick={() => navigate(`/poll/${poll.poll.id}/results`)}
                  >
                    Se resultat <FaCheck />
                  </button>
                ) : poll.poll.status === "started" ? (
                  <button
                    type="button"
                    className="btn-vote"
                    onClick={() => navigate(`/poll/${poll.poll.id}/vote`)}
                  >
                    Stem
                  </button>
                ) : canOwnerEdit(poll) ? (
                  <button
                    type="button"
                    className="btn-vote"
                    onClick={() => navigate(`/createpoll/${poll.poll.id}`)}
                  >
                    {poll.poll.status === "draft"
                      ? "Rediger kladde"
                      : "Rediger afstemning"}
                  </button>
                ) : null}
              </td>
              <td className="ov-col-status">{statusLabel(poll)}</td>
              <td className="ov-col-visibility">{poll.poll.pollVisibility === "public" ? "Offentlig" : "Privat"}</td>
              <td className="ov-col-anon">
                {poll.poll.ballotPrivacy === "secret" ? (
                  <FaCheck />
                ) : (
                  <FaXmark />
                )}
              </td>
              <td className="ov-col-owner">{poll.pollOwnerUsername}</td>{" "}
              {/*To-do: Change to username.*/}
            </tr>
          ))}
        </tbody>
      )}
    </table>
  );
}

// ─── OverviewPage ─────────────────────────────────────────────────────────────
// Hoved-komponenten for oversigts-siden (figur 4.2).
// Henter afstemninger én gang og opdaterer derefter timere hvert sekund
// via setInterval uden at re-fetche fra serveren.
function OverviewPage() {
  // This array is unbounded, as it fetches ALL polls from the database,
  // this will lead to performance issues as the application scales.
  const [polls, setPolls] = useState<FrontEndPoll[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [serverCallback, setServerCallback] = useState(callbackTypes.nil);
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);

  // fetches their own username so owners kan know their own polls.
  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => setCurrentUsername(data.username ?? null))
      .catch(() => setCurrentUsername(null));
  }, []);

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
        if (res.status === 401) {
          await fetch("/logout", { method: "POST", credentials: "include" });
          globalThis.location.href = "/";
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: FrontEndPoll[] = await res.json();

        // Beregn initial tid for hver afstemning
        data.forEach((p) => {
          p.timeLeft = calculateTimeLeft(p);
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
  }, [serverCallback]);

  // Opdater timere hvert sekund uden at re-fetche fra serveren.
  // Rydder intervallet når komponenten unmountes for at undgå memory leaks.
  useEffect(() => {
    const interval = setInterval(() => {
      if (rawPollsRef.current.length === 0) return;

      const updated = rawPollsRef.current.map((p) => {
        const timeLeft: string = calculateTimeLeft(p);
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
          return (
            (!poll.hasVoted && poll.poll.status === "not started") ||
            poll.poll.status === "started"
          );
        case "drafts":
          return poll.poll.status === "started";
        default:
          return true;
      }
    })
    .filter(
      (poll) =>
        (poll.poll.title ?? "")
          .toLowerCase()
          .includes(searchQuery.toLowerCase()) ||
        poll.poll.createdBy
          .toString()
          .toLowerCase()
          .includes(searchQuery.toLowerCase()), // To-do: Change to fetch username for the poll
    );

  const displayedPolls = filteredPolls.map((poll) => {
    return {
      ...poll,
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
            <PollTable
              polls={displayedPolls}
              currentUsername={currentUsername}
            />
          )}
        </main>
      </div>
    </>
  );
}

export default OverviewPage;
