import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import "./OverviewPage.css";

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
      if (!map[key]) map[key] = [];
      map[key].push(p);
    }
  });
  return map;
}

interface SidebarProps {
  activeFilter: FilterType;
  onFilterChange: (f: FilterType) => void;
  folderMap: FolderMap;
  activeFolderFilter: string | null;
  onFolderClick: (folder: string | null) => void;
}

function Sidebar({ activeFilter, onFilterChange, folderMap, activeFolderFilter, onFolderClick }: SidebarProps) {
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  function toggleFolder(name: string) {
    setOpenFolders((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  return (
    <aside className="ov-sidebar">
      <a href="/create-poll" className="btn-create">Create Poll</a>
      <nav className="ov-filter-nav">
        <button className={`ov-filter-btn ${activeFilter === "all" && !activeFolderFilter ? "ov-filter-btn--active" : ""}`} onClick={() => { onFilterChange("all"); onFolderClick(null); }}>All polls</button>
        <button className={`ov-filter-btn ${activeFilter === "eligible" && !activeFolderFilter ? "ov-filter-btn--active" : ""}`} onClick={() => { onFilterChange("eligible"); onFolderClick(null); }}>Polls you are eligible to vote in</button>
        <button className={`ov-filter-btn ${activeFilter === "drafts" && !activeFolderFilter ? "ov-filter-btn--active" : ""}`} onClick={() => { onFilterChange("drafts"); onFolderClick(null); }}>Your polls in progress</button>
      </nav>
      <div className="ov-folders-header">
        <span className="ov-folders-title">Folders</span>
        <button className="ov-folder-add" title="Create folder" aria-label="Create folder">＋</button>
      </div>
      <nav className="ov-folder-nav">
        {Object.keys(folderMap).sort().map((name) => {
          const isOpen = !!openFolders[name];
          return (
            <div key={name} className="ov-folder">
              <button className="ov-folder-btn" onClick={() => toggleFolder(name)} aria-expanded={isOpen}>
                <span className="ov-folder-arrow">{isOpen ? "∨" : "›"}</span>
                {name}
              </button>
              {isOpen && (
                <div className="ov-folder-children">
                  {folderMap[name].map((poll) => (
                    <a key={poll.id} href={`/poll/${poll.id}`} className={`ov-folder-item ${activeFolderFilter === name ? "ov-folder-item--active" : ""}`}>{poll.title}</a>
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
            <td className="ov-col-title"><a href={`/poll/${poll.id}`}>{poll.title}</a></td>
            <td className="ov-col-mystatus">
              {poll.hasVoted ? (
                <span className="voted-label">You have voted <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg></span>
              ) : poll.status === "active" ? (
                <a href={`/poll/${poll.id}/vote`} className="btn-vote">Vote</a>
              ) : null}
            </td>
            <td className="ov-col-status">{statusLabel(poll)}</td>
            <td className="ov-col-time">{poll.timeLeft}</td>
            <td className="ov-col-visibility">{poll.isPublic ? "Public" : "Private"}</td>
            <td className="ov-col-anon">
              {poll.isAnonymous ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="icon-check" aria-label="Yes"><polyline points="20 6 9 17 4 12" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="icon-cross" aria-label="No"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              )}
            </td>
            <td className="ov-col-owner">{poll.owner}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OverviewPage() {
  const [polls, setPolls] = useState<OverviewPoll[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [activeFolderFilter, setActiveFolderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const fetchPolls = async () => {
      setLoading(true);
      try {
        const res = await fetch("http://localhost:8000/api/polls", { method: "GET", credentials: "include" });
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
        case "eligible": return !poll.hasVoted && poll.status === "active";
        case "drafts": return poll.status === "not_started";
        default: return true;
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
        <Sidebar activeFilter={activeFilter} onFilterChange={setActiveFilter} folderMap={folderMap} activeFolderFilter={activeFolderFilter} onFolderClick={setActiveFolderFilter} />
        <main className="ov-main">
          <div className="ov-search-row">
            <div className="ov-search-box">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input type="search" placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="ov-search-input" aria-label="Search polls" />
            </div>
          </div>
          {loading ? (
            <div className="ov-state"><div className="spinner" /><span>Loading polls…</span></div>
          ) : (
            <PollTable polls={filteredPolls} />
          )}
        </main>
      </div>
    </>
  );
}

export default OverviewPage;
