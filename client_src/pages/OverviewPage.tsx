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
    // Poll that hasn't started yet — show time until start
    const diffMs = new Date(p.poll.startsAt).getTime() - Date.now();
    timeLeft = diffMs > 0
      ? `Starter om: ${formatTime(diffMs)}`
      : "Starter snart";
  } else {
    // Active poll — show time until it closes
    timeLeft = calculateTimeRemaining(p.poll.endsAt);
  }
  return timeLeft;
}

// ─── Helper: statusLabel ──────────────────────────────────────────────────────
// Danish translation
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

  return statusMap[status] ?? poll.pollProgress;
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

// ─── Sidebar component ────────────────────────────────────────────────────────
// Sidebar has two things: button for creating poll and buttons for filtering.
interface SidebarProps {
  activeFilter: FilterType;
  onFilterChange: (f: FilterType) => void;
}

function Sidebar({
  activeFilter,
  onFilterChange,
}: SidebarProps) {
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
            activeFilter === "all" ? "ov-filter-btn--active" : ""
          }`}
          onClick={() => {
            onFilterChange("all");
          }}
        >
          Alle afstemninger
        </button>
        <button
          type="button"
          className={`ov-filter-btn ${
            activeFilter === "eligible" ? "ov-filter-btn--active" : ""
          }`}
          onClick={() => {
            onFilterChange("eligible");
          }}
        >
          Afstemninger du er stemmeberettigede til
        </button>
        <button
          type="button"
          className={`ov-filter-btn ${
            activeFilter === "drafts" ? "ov-filter-btn--active" : ""
          }`}
          onClick={() => {
            onFilterChange("drafts");
          }}
        >
          Dine igangværende afstemninger
        </button>
      </nav>
    </aside>
  );
}

// ─── PollTable component ──────────────────────────────────────────────────────
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
  function canOwnerEdit(poll: FrontEndPoll): boolean {
    if (poll.pollOwnerUsername !== currentUsername) return false;
    if (poll.poll.status === "draft") return true;
    if (poll.poll.status === "not started" && poll.poll.startsAt) {
      return new Date(poll.poll.startsAt).getTime() > Date.now();
    }
    return false;
  }

  function canCurrentUserVote(poll: FrontEndPoll): boolean {
    return poll.isUserEligibleVoter &&
      !poll.hasVoted &&
      poll.poll.status === "started";
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
      {isMobile
        ? (
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

                    {poll.poll.status === "finished"
                      ? (
                        <Link
                          to={`/poll/${poll.poll.id}/results`}
                          className="btn-vote"
                        >
                          Se resultat
                        </Link>
                      )
                      : poll.hasVoted
                      ? (
                        <span className="voted-label">
                          Du har stemt <FaCheck />
                        </span>
                      )
                      : canCurrentUserVote(poll)
                      ? (
                        <Link
                          to={`/poll/${poll.poll.id}/vote`}
                          className="btn-vote"
                        >
                          Stem
                        </Link>
                      )
                      : canOwnerEdit(poll)
                      ? (
                        <Link
                          to={`/createpoll/${poll.poll.id}`}
                          className="btn-vote"
                        >
                          {poll.poll.status === "draft"
                            ? "Rediger kladde"
                            : "Rediger afstemning"}
                        </Link>
                      )
                      : null}
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
                      {poll.poll.ballotPrivacy === "secret"
                        ? <FaCheck />
                        : <FaXmark />}
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
        )
        : (
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
                  {poll.poll.status === "finished"
                    ? (
                      <button
                        type="button"
                        className="btn-vote"
                        onClick={() =>
                          navigate(`/poll/${poll.poll.id}/results`)}
                      >
                        Se resultat <FaCheck />
                      </button>
                    )
                    : poll.hasVoted
                    ? (
                      <span className="voted-label">
                        Du har stemt <FaCheck />
                      </span>
                    )
                    : canCurrentUserVote(poll)
                    ? (
                      <button
                        type="button"
                        className="btn-vote"
                        onClick={() => navigate(`/poll/${poll.poll.id}/vote`)}
                      >
                        Stem
                      </button>
                    )
                    : canOwnerEdit(poll)
                    ? (
                      <button
                        type="button"
                        className="btn-vote"
                        onClick={() => navigate(`/createpoll/${poll.poll.id}`)}
                      >
                        {poll.poll.status === "draft"
                          ? "Rediger kladde"
                          : "Rediger afstemning"}
                      </button>
                    )
                    : null}
                </td>
                <td className="ov-col-status">{statusLabel(poll)}</td>
                <td className="ov-col-visibility">
                  {poll.poll.pollVisibility === "public"
                    ? "Offentlig"
                    : "Privat"}
                </td>
                <td className="ov-col-anon">
                  {poll.poll.ballotPrivacy === "secret"
                    ? <FaCheck />
                    : <FaXmark />}
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
// Main component for overviewpage (wireframe figure 4.2).
function OverviewPage() {
  const [polls, setPolls] = useState<FrontEndPoll[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [serverCallback, setServerCallback] = useState(callbackTypes.nil);
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);

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
      if (message.type === callbackTypes.refetchVoteCount) {
        console.log("ws: recived refreshVoteCount");
        setServerCallback(message.type);
      }
    };
  }
  // Saves the fetched polls so timers can update without re-fetching.
  const rawPollsRef = useRef<FrontEndPoll[]>([]);

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

  function isEligiblePoll(poll: FrontEndPoll): boolean {
    return poll.isUserEligibleVoter;
  }

  function isCurrentPoll(
    poll: FrontEndPoll,
    username: string | null,
  ): boolean {
    const isStarted = poll.poll.status === "started";
    const isOwner = poll.pollOwnerUsername === username && isStarted;
    const canVoteNow = poll.isUserEligibleVoter &&
      isStarted;

    return isOwner || canVoteNow;
  }

  const filteredPolls = polls
    .filter((poll) => {
      switch (activeFilter) {
        case "eligible":
          return isEligiblePoll(poll);
        case "drafts":
          return isCurrentPoll(poll, currentUsername);
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
          .includes(searchQuery.toLowerCase()),
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
          {loading
            ? (
              <div className="ov-state">
                <div className="spinner" />
                <span>Henter afstemninger…</span>
              </div>
            )
            : (
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
