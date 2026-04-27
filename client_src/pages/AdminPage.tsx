import { useEffect, useState } from "react";
import NavBar from "../components/NavBar.tsx";
import "./AdminPage.css";

// ─── Types ────────────────────────────────────────────────────────────────────

// Repræsenterer en bruger som vi modtager fra GET /admin/users
interface User {
  id: number;
  username: string;
}

// De tre mulige visninger/faner i admin-dashboardet
type AdminView = "users" | "add-user" | "delete-user";

// ─── Hjælpekomponent: StatusBesked ───────────────────────────────────────────
// Viser en grøn succesbesked eller rød fejlbesked afhængigt af type.
// Bruges efter at have tilføjet eller slettet en bruger.
function StatusBesked({ besked, type }: { besked: string; type: "success" | "error" }) {
  return (
    <div className={`admin-status admin-status--${type}`}>
      {type === "success" ? "✓" : "✗"} {besked}
    </div>
  );
}

// ─── Fane: Brugerliste ────────────────────────────────────────────────────────
// Henter og viser alle brugere i systemet som en tabel.
// Bruges til at give admins et overblik over hvem der har adgang.
function BrugerListe() {
  const [brugere, setBrugere] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [fejl, setFejl] = useState<string | null>(null);

  // Hent brugerlisten fra serveren når komponenten vises
  useEffect(() => {
    const hentBrugere = async () => {
      setLoading(true);
      setFejl(null);
      try {
        const res = await fetch("http://localhost:8000/admin/users", {
          credentials: "include", // Send JWT-cookie med for at serveren ved vi er admin
        });
        if (!res.ok) throw new Error(`Server svarede med ${res.status}`);
        const data: User[] = await res.json();
        setBrugere(data);
      } catch (err) {
        setFejl(err instanceof Error ? err.message : "Ukendt fejl");
      } finally {
        setLoading(false);
      }
    };
    hentBrugere();
  }, []);

  if (loading) return <div className="admin-loading"><div className="spinner" /> Henter brugere…</div>;
  if (fejl) return <div className="admin-status admin-status--error">✗ {fejl}</div>;

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Alle brugere <span className="admin-badge">{brugere.length}</span></h2>
      <table className="admin-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Brugernavn</th>
          </tr>
        </thead>
        <tbody>
          {brugere.map((b) => (
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
function TilfoejBruger() {
  const [brugernavn, setBrugernavn] = useState("");
  const [adgangskode, setAdgangskode] = useState("");
  const [bekraeft, setBekraeft] = useState("");
  const [status, setStatus] = useState<{ besked: string; type: "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleIndsend() {
    // Valider at adgangskoderne matcher inden vi sender til serveren
    if (adgangskode !== bekraeft) {
      setStatus({ besked: "Adgangskoderne matcher ikke.", type: "error" });
      return;
    }
    if (brugernavn.trim() === "") {
      setStatus({ besked: "Brugernavn må ikke være tomt.", type: "error" });
      return;
    }
    if (adgangskode.length < 6) {
      setStatus({ besked: "Adgangskoden skal være mindst 6 tegn.", type: "error" });
      return;
    }

    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch("http://localhost:8000/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: brugernavn, password: adgangskode }),
      });

      if (res.ok) {
        setStatus({ besked: `Brugeren "${brugernavn}" blev oprettet.`, type: "success" });
        // Nulstil formularen efter succesfuld oprettelse
        setBrugernavn("");
        setAdgangskode("");
        setBekraeft("");
      } else if (res.status === 409) {
        setStatus({ besked: "Brugernavnet er allerede taget.", type: "error" });
      } else {
        setStatus({ besked: `Fejl: ${res.status}`, type: "error" });
      }
    } catch {
      setStatus({ besked: "Kunne ikke forbinde til serveren.", type: "error" });
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
            value={brugernavn}
            onChange={(e) => setBrugernavn(e.target.value)}
            placeholder="f.eks. jens123"
            autoComplete="off"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="ny-adgangskode">Adgangskode</label>
          <input
            id="ny-adgangskode"
            type="password"
            value={adgangskode}
            onChange={(e) => setAdgangskode(e.target.value)}
            placeholder="Mindst 6 tegn"
            autoComplete="new-password"
          />
        </div>
        <div className="admin-field">
          <label htmlFor="bekraeft-adgangskode">Bekræft adgangskode</label>
          <input
            id="bekraeft-adgangskode"
            type="password"
            value={bekraeft}
            onChange={(e) => setBekraeft(e.target.value)}
            placeholder="Gentag adgangskoden"
            autoComplete="new-password"
          />
        </div>

        {status && <StatusBesked besked={status.besked} type={status.type} />}

        <button
          className="admin-btn admin-btn--primary"
          onClick={handleIndsend}
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
  const [brugernavn, setBrugernavn] = useState("");
  const [bekraeft, setBekraeft] = useState(false);
  const [status, setStatus] = useState<{ besked: string; type: "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSlet() {
    if (brugernavn.trim() === "") {
      setStatus({ besked: "Angiv et brugernavn.", type: "error" });
      return;
    }
    // Beskyt admin-kontoen mod at blive slettet via dashboardet
    if (brugernavn === "admin") {
      setStatus({ besked: "Admin-kontoen kan ikke slettes.", type: "error" });
      return;
    }
    if (!bekraeft) {
      setStatus({ besked: "Bekræft venligst at du vil slette brugeren.", type: "error" });
      return;
    }

    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`http://localhost:8000/admin/users/${encodeURIComponent(brugernavn)}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (res.ok) {
        setStatus({ besked: `Brugeren "${brugernavn}" blev slettet.`, type: "success" });
        setBrugernavn("");
        setBekraeft(false);
      } else if (res.status === 404) {
        setStatus({ besked: "Brugeren blev ikke fundet.", type: "error" });
      } else {
        setStatus({ besked: `Fejl: ${res.status}`, type: "error" });
      }
    } catch {
      setStatus({ besked: "Kunne ikke forbinde til serveren.", type: "error" });
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
            value={brugernavn}
            onChange={(e) => { setBrugernavn(e.target.value); setBekraeft(false); setStatus(null); }}
            placeholder="Brugernavnet der skal slettes"
            autoComplete="off"
          />
        </div>

        {/* Bekræftelsescheckbox — vises kun når et brugernavn er indtastet */}
        {brugernavn.trim() !== "" && brugernavn !== "admin" && (
          <label className="admin-confirm-label">
            <input
              type="checkbox"
              checked={bekraeft}
              onChange={(e) => setBekraeft(e.target.checked)}
            />
            Jeg bekræfter at jeg vil slette brugeren <strong>"{brugernavn}"</strong> permanent.
          </label>
        )}

        {status && <StatusBesked besked={status.besked} type={status.type} />}

        <button
          className="admin-btn admin-btn--danger"
          onClick={handleSlet}
          disabled={loading || !bekraeft}
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
  const [aktivFane, setAktivFane] = useState<AdminView>("users");

  return (
    <>
      <NavBar />
      <div className="admin-layout">
        {/* Sidebar med fanenavigation */}
        <aside className="admin-sidebar">
          <h1 className="admin-sidebar-title">Admin</h1>
          <nav className="admin-nav">
            <button
              className={`admin-nav-btn ${aktivFane === "users" ? "admin-nav-btn--active" : ""}`}
              onClick={() => setAktivFane("users")}
            >
              👥 Brugerliste
            </button>
            <button
              className={`admin-nav-btn ${aktivFane === "add-user" ? "admin-nav-btn--active" : ""}`}
              onClick={() => setAktivFane("add-user")}
            >
              ➕ Tilføj bruger
            </button>
            <button
              className={`admin-nav-btn ${aktivFane === "delete-user" ? "admin-nav-btn--active" : ""}`}
              onClick={() => setAktivFane("delete-user")}
            >
              🗑 Slet bruger
            </button>
          </nav>

          {/* Link tilbage til oversigten */}
          <a href="/" className="admin-back-link">← Tilbage til oversigt</a>
        </aside>

        {/* Hovedindhold skifter afhængigt af aktiv fane */}
        <main className="admin-main">
          {aktivFane === "users" && <BrugerListe />}
          {aktivFane === "add-user" && <TilfoejBruger />}
          {aktivFane === "delete-user" && <SletBruger />}
        </main>
      </div>
    </>
  );
}

export default AdminPage;
