import NavBar from "../components/NavBar.tsx";
import { useEffect, useState } from "react";
import "./AuditLog.css";

type AuditLogTable = { //Type setup.
  id: number;
  action: string;
  timestamp: string;
  details: string | null;
};

/*const mockData: AuditLogTable[] = [ //Mock data used until database connection is set up.
  {
    id: 1,
    action: "User Login",
    timestamp: "2024-06-01 10:00:00",
    details: "User with ID 123 logged in.",
  },
  {
    id: 2,
    action: "Poll Create",
    timestamp: "2024-06-01 10:02:13",
    details: "Poll created by user with ID 42.",
  },
  {
    id: 3,
    action: "Poll Opened",
    timestamp: "2024-06-01 10:02:16",
    details: "Poll opened by system with ID 42.",
  },
  {
    id: 4,
    action: "Vote Cast",
    timestamp: "2024-06-01 11:54:23",
    details: "Vote with UUID: abc-123 cast for option ID 5 in poll ID 42.",
  },
  {
    id: 5,
    action: "Vote Cast",
    timestamp: "2024-06-01 11:55:25",
    details: "Vote with UUID: acb-132 cast for option ID 3 in poll ID 42.",
  },
  {
    id: 6,
    action: "Poll Closed",
    timestamp: "2024-06-01 12:07:32",
    details: "Poll closed by system with ID 42.",
  },
  {
    id: 7,
    action: "Test",
    timestamp: "2024-06-07 00:00:00",
    details: "More Test Data!",
  },
  {
    id: 8,
    action: "Test",
    timestamp: "2024-06-07 00:00:00",
    details: "More Test Data!",
  },
  {
    id: 9,
    action: "Test",
    timestamp: "2024-06-07 00:00:00",
    details: "More Test Data!",
  },
  {
    id: 10,
    action: "Test",
    timestamp: "2024-06-07 00:00:00",
    details: "More Test Data!",
  },
  {
    id: 11,
    action: "Test",
    timestamp: "2024-06-07 00:00:00",
    details: "More Test Data!",
  },
]; */

function AuditLog() {
  //Page navigation

  const [entries, setEntries] = useState<AuditLogTable[]>([]);

  const [currentPage, setCurrentPage] = useState(1);

  const [entriesPerPage, setEntriesPerPage] = useState(10);

  //Search functionality
  const [searchTerm, setSearchTerm] = useState("");

  const filteredEntries = entries.filter((entry) =>
    Object.values(entry).some((value) =>
      String(value).toLowerCase().includes(searchTerm.toLowerCase())
    )
  );

  const [sortField, setSortField] = useState<keyof AuditLogTable>("id");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  //Sort by acending/decending
  const sortedEntries = [...filteredEntries].sort((a, b) => {
    const aValue = a[sortField];
    const bValue = b[sortField];

    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return 1;
    if (bValue === null) return -1;

    if (aValue < bValue) {
      return sortDirection === "asc" ? -1 : 1;
    }

    if (aValue > bValue) {
      return sortDirection === "asc" ? 1 : -1;
    }

    return 0;
  });

  //Page navigation logic
  const startIndex = (currentPage - 1) * entriesPerPage;
  const endIndex = startIndex + entriesPerPage;

  const currentEntries = sortedEntries.slice(startIndex, endIndex);

  const totalPages = Math.max(
    1, // Prevents total pages from being less than 1.
    Math.ceil(filteredEntries.length / entriesPerPage),
  );

  useEffect(() => { //Fetches audit log from the server.
    async function fetchAuditLog() {
      try {
        const response = await fetch("/api/auditlog");
        const data = await response.json();

        setEntries(data.logs);
      } catch (error) {
        console.error("Error fetching audit log:", error);
      }
    }

    fetchAuditLog();
  }, []);

  function handleSort(field: keyof AuditLogTable) { //Handles sorting by clicking on the table arrows.
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }

  function renderArrow(field: keyof AuditLogTable) { //Renders the sorting arrows in the table headers.
    if (sortField !== field) return "↕";

    return sortDirection === "asc" ? "▲" : "▼";
  }

  return (
    <>
      <NavBar />
      <div className="audit-log-container">
        <h1 className="alog-header">Audit Log</h1>

        <div className="alog-search">
          {/*Search Box*/}
          <div className="alog-search-box">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Søg"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="alog-search-input"
              aria-label="Søg"
            />
          </div>
        </div>

        <table className="alog-table">
          {/*Audit log table*/}
          <thead>
            <tr>
              <th onClick={() => handleSort("id")}>
                ID {renderArrow("id")}
              </th>

              <th onClick={() => handleSort("action")}>
                Handling {renderArrow("action")}
              </th>

              <th onClick={() => handleSort("timestamp")}>
                Tidspunkt {renderArrow("timestamp")}
              </th>

              <th onClick={() => handleSort("details")}>
                Detaljer {renderArrow("details")}
              </th>
            </tr>
          </thead>

          <tbody>
            {currentEntries.map((entry) => ( //Showing current entries from page rendered by page navigation.
              <tr key={entry.id}>
                <td>{entry.id}</td>
                <td>{entry.action}</td>
                <td>{entry.timestamp}</td>
                <td>{entry.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="alog-buttons">
          <button
            type="button"
            onClick={() => setCurrentPage(currentPage - 1)}
            disabled={currentPage === 1}
          >
            Forrige
          </button>
          <span>
            Side {currentPage} af {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setCurrentPage(currentPage + 1)}
            disabled={currentPage === totalPages}
          >
            Næste
          </button>
          <div className="divider" />
          <label className="label">
            Vis:
            {/*Dropdown to select how many entries to show per page.*/}
            <select
              value={entriesPerPage}
              onChange={(e) => {
                setEntriesPerPage(Number(e.target.value));
                setCurrentPage(1); // Reset to first page when entries per page changes
              }}
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
              <option value={entries.length}>Alle</option>
            </select>
          </label>
        </div>
      </div>
    </>
  );
}

export default AuditLog;
