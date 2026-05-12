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

// De tre mulige visninger/faner i admin-dashboardet
type AdminView = "users" | "add-user" | "delete-user";

// ─── Hjælpekomponent: StatusBesked ───────────────────────────────────────────
// Viser en grøn succesbesked eller rød fejlbesked afhængigt af type.
// Bruges efter at have tilføjet eller slettet en bruger.
function StatusMsg({
  msg: msg,
  type,
}: {
  msg: string;
  type: "success" | "error";
}) {
  return (
    <div className={`admin-status admin-status--${type}`}>
      {type === "success" ? `${<FaCheck />}` : `${<FaXmark />}`} {msg}
    </div>
  );
}

// ─── Fane: Brugerliste ────────────────────────────────────────────────────────
// Henter og viser alle brugere i systemet som en tabel.
// Bruges til at give admins et overblik over hvem der har adgang.
function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Hent brugerlisten fra serveren når komponenten vises
  useEffect(() => {
    const fetchUsers = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/users", {
          credentials: "include", // Send JWT-cookie med for at serveren ved vi er admin
        });
        if (!res.ok) throw new Error(`Server svarede med ${res.status}`);
        const data: User[] = await res.json();
        setUsers(data);
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

// ─── Fane: Tilføj bruger ──────────────────────────────────────────────────────
// Formular til at oprette en ny bruger ved at sende POST /admin/users.
// Adgangskoden hashes på serveren med argon2 — vi sender den som klartekst over HTTPS.
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
    // Valider at adgangskoderne matcher inden vi sender til serveren
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
        // Nulstil formularen efter succesfuld oprettelse
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
          {loading ? "Opretter…" : "Opret bruger"}
        </button>
      </div>
    </div>
  );
}

// ─── Fane: Slet bruger ────────────────────────────────────────────────────────
// Giver admin mulighed for at slette en bruger ved at angive brugernavnet.
// Der er en bekræftelsesdialog for at undgå utilsigtet sletning.
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
    // Beskyt admin-kontoen mod at blive slettet via dashboardet
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
        `/admin/users/${encodeURIComponent(username)}`,
        {
          method: "DELETE",
          credentials: "include",
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

        {/* Bekræftelsescheckbox — vises kun når et brugernavn er indtastet */}
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
          {loading ? "Sletter…" : "Slet bruger"}
        </button>
      </div>
    </div>
  );
}

// ─── Hoved-komponent: AdminPage ───────────────────────────────────────────────
// Admin-dashboardet med tre faner: brugerliste, tilføj bruger og slet bruger.
// Kun tilgængeligt for indloggede admin-brugere (håndhæves på server-siden).
function AdminPage() {
  const [activePane, setActivePane] = useState<AdminView>("users");

  return (
    <>
      <NavBar />
      <div className="admin-layout">
        {/* Sidebar med fanenavigation */}
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

          {/* Link tilbage til oversigten */}
          <Link to="/" className="admin-back-link">
            <FaLongArrowAltLeft /> Tilbage til oversigt
          </Link>
        </aside>

        {/* Hovedindhold skifter afhængigt af aktiv fane */}
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
