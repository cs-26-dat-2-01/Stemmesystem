import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import "./AdminPage.css";
import { Link } from "react-router/internal/react-server-client";

//SVG icons
import { FaCheck, FaTrashCan, FaXmark } from "react-icons/fa6";
import { FaLongArrowAltLeft, FaUsers } from "react-icons/fa";
import { IoMdAdd } from "react-icons/io";

// ─── Types ────────────────────────────────────────────────────────────────────

// Representes the user we get from GET /admin/users
interface User {
  id: number;
  username: string;
}

// The three possible views/tabs in the admin dashboard
type AdminView = "users" | "add-user" | "delete-user";

// ─── Helper component: StatusMsg ───────────────────────────────────────────
// Shows a green success message or a red error message depending on type.
// Used after a user has been added or deleted.
function StatusMsg({
  msg: msg,
  type,
}: {
  msg: string;
  type: "success" | "error";
}) {
  return (
    <div className={`admin-status admin-status--${type}`}>
      {type === "success" ? <FaCheck /> : <FaXmark />} {msg}
    </div>
  );
}

// ─── Tab: User list ────────────────────────────────────────────────────────
// Fetches and shows all users in the system as a table.
// Gives admins an overview of who has access.
function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch the user list from the server when the component mounts
  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/users", {
          credentials: "include", // Send the JWT cookie so the server knows we are admin
        });
        if (res.status === 401) {
          await fetch("/logout", { method: "POST", credentials: "include" });
          globalThis.location.href = "/";
          return;
        }
        if (!res.ok) throw new Error(`Server svarede med ${res.status}`);
        const result = await res.json();
        const users: User[] = result.users;
        setUsers(users);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Ukendt fejl");
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, []);

  if (loading) {
    return (
      <div className="admin-loading">
        <div className="spinner" /> Henter brugere…
      </div>
    );
  }
  if (error) {
    return (
      <div className="admin-status admin-status--error">
        <FaXmark /> {error}
      </div>
    );
  }

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">
        Alle brugere <span className="admin-badge">{users.length}</span>
      </h2>
      <table className="admin-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Brugernavn</th>
          </tr>
        </thead>
        <tbody>
          {users.map((b) => (
            <tr key={b.id}>
              <td className="admin-table-id">{b.id}</td>
              <td>{b.username}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab: Add user ──────────────────────────────────────────────────────
// Form for creating a new user via POST /admin/users.
// The password is hashed on the server with argon2 — we send it as cleartext over HTTPS.
function AddUsers() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState<
    {
      msg: string;
      type: "success" | "error";
    } | null
  >(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmission() {
    // Validate that the passwords match before sending to the server
    if (password !== confirmation) {
      setStatus({ msg: "Adgangskoderne matcher ikke.", type: "error" });
      return;
    }
    if (username.trim() === "") {
      setStatus({ msg: "Brugernavn må ikke være tomt.", type: "error" });
      return;
    }
    if (password.length < 6) {
      setStatus({
        msg: "Adgangskoden skal være mindst 6 tegn.",
        type: "error",
      });
      return;
    }

    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/add-user", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
      });

      if (res.ok) {
        setStatus({
          msg: `Brugeren "${username}" blev oprettet.`,
          type: "success",
        });
        // Reset the form after a successful creation
        setUsername("");
        setPassword("");
        setConfirmation("");
      } else if (res.status === 409) {
        setStatus({ msg: "Brugernavnet er allerede taget.", type: "error" });
      } else {
        setStatus({ msg: `Fejl: ${res.status}`, type: "error" });
      }
    } catch {
      setStatus({ msg: "Kunne ikke forbinde til serveren.", type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Tilføj bruger</h2>
      <div className="admin-form">
        <div className="admin-field">
          <label htmlFor="nyt-brugernavn">Brugernavn</label>
          <input
            id="nyt-brugernavn"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="f.eks. jens123"
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ny-adgangskode">Adgangskode</label>
          <input
            id="ny-adgangskode"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Mindst 6 tegn"
            autoComplete="new-password"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="bekraeft-adgangskode">Bekræft adgangskode</label>
          <input
            id="bekraeft-adgangskode"
            type="password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="Gentag adgangskoden"
            autoComplete="new-password"
          />
        </div>

        {status && <StatusMsg msg={status.msg} type={status.type} />}

        <button
          type="button"
          className="admin-btn admin-btn--primary"
          onClick={handleSubmission}
          disabled={loading}
        >
          {loading ? "Opretter..." : "Opret bruger"}
        </button>
      </div>
    </div>
  );
}

// ─── Tab: Delete user ────────────────────────────────────────────────────────
// Lets an admin delete a user by entering the username.
// A confirmation step guards against accidental deletion.
function SletBruger() {
  const [username, setUsername] = useState("");
  const [submission, setSubmission] = useState(false);
  const [status, setStatus] = useState<
    {
      msg: string;
      type: "success" | "error";
    } | null
  >(null);
  const [loading, setLoading] = useState(false);

  async function handleSlet() {
    if (username.trim() === "") {
      setStatus({ msg: "Angiv et brugernavn.", type: "error" });
      return;
    }
    // Protect the admin account from being deleted via the dashboard
    if (username === "admin") {
      setStatus({ msg: "Admin-kontoen kan ikke slettes.", type: "error" });
      return;
    }
    if (!submission) {
      setStatus({
        msg: "Bekræft venligst at du vil slette brugeren.",
        type: "error",
      });
      return;
    }

    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(
        `/api/admin/delete-user`,
        {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username }),
        },
      );

      if (res.ok) {
        setStatus({
          msg: `Brugeren "${username}" blev slettet.`,
          type: "success",
        });
        setUsername("");
        setSubmission(false);
      } else if (res.status === 404) {
        setStatus({ msg: "Brugeren blev ikke fundet.", type: "error" });
      } else {
        setStatus({ msg: `Fejl: ${res.status}`, type: "error" });
      }
    } catch {
      setStatus({ msg: "Kunne ikke forbinde til serveren.", type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Slet bruger</h2>
      <div className="admin-form">
        <div className="admin-field">
          <label htmlFor="slet-brugernavn">Brugernavn</label>
          <input
            id="slet-brugernavn"
            type="text"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setSubmission(false);
              setStatus(null);
            }}
            placeholder="Brugernavnet der skal slettes"
            autoComplete="off"
          />
        </div>

        {/* Confirmation checkbox — only shown once a username has been entered */}
        {username.trim() !== "" && username !== "admin" && (
          <label className="admin-confirm-label">
            <input
              type="checkbox"
              checked={submission}
              onChange={(e) => setSubmission(e.target.checked)}
            />
            Jeg bekræfter at jeg vil slette brugeren{" "}
            <strong>"{username}"</strong> permanent.
          </label>
        )}

        {status && <StatusMsg msg={status.msg} type={status.type} />}

        <button
          type="button"
          className="admin-btn admin-btn--danger"
          onClick={handleSlet}
          disabled={loading || !submission}
        >
          {loading ? "Sletter..." : "Slet bruger"}
        </button>
      </div>
    </div>
  );
}

// ─── Main component: AdminPage ───────────────────────────────────────────────
// The admin dashboard with three tabs: user list, add user, and delete user.
// Only available to logged-in admin users (enforced server-side).
function AdminPage() {
  const [activePane, setActivePane] = useState<AdminView>("users");

  return (
    <>
      <NavBar />
      <div className="admin-layout">
        {/* Sidebar with tab navigation */}
        <aside className="admin-sidebar">
          <h1 className="admin-sidebar-title">Admin</h1>
          <nav className="admin-nav">
            <button
              type="button"
              className={`admin-nav-btn ${
                activePane === "users" ? "admin-nav-btn--active" : ""
              }`}
              onClick={() => setActivePane("users")}
            >
              <FaUsers /> Brugerliste
            </button>
            <button
              type="button"
              className={`admin-nav-btn ${
                activePane === "add-user" ? "admin-nav-btn--active" : ""
              }`}
              onClick={() => setActivePane("add-user")}
            >
              <IoMdAdd /> Tilføj bruger
            </button>
            <button
              type="button"
              className={`admin-nav-btn ${
                activePane === "delete-user" ? "admin-nav-btn--active" : ""
              }`}
              onClick={() => setActivePane("delete-user")}
            >
              <FaTrashCan /> Slet bruger
            </button>
          </nav>

          {/* Link back to the overview */}
          <Link to="/" className="admin-back-link">
            <FaLongArrowAltLeft /> Tilbage til oversigt
          </Link>
        </aside>

        {/* Main content switches depending on the active tab */}
        <main className="admin-main">
          {activePane === "users" && <UserList />}
          {activePane === "add-user" && <AddUsers />}
          {activePane === "delete-user" && <SletBruger />}
        </main>
      </div>
    </>
  );
}

export default AdminPage;
