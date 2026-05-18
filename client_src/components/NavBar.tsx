import { useEffect, useState } from "react";
import "./NavBar.css";
import { FaUser } from "react-icons/fa";
import { getCookie } from "../WebLib.ts";
import { Link } from "react-router/internal/react-server-client";

function NavBar() {
  const [userName] = useState(getCookie("user", document.cookie));
  const [isAdmin, setIsAdmin] = useState(false);
  async function handleLogout() {
    const res = await fetch("/logout", {
      method: "POST",
      credentials: "include",
    });

    if (res.status == 200) {
      //Refresh site after clearing cookies
      globalThis.location.reload();
      globalThis.location.href = "/";
    } else {
      console.log("logout failed with code: " + res.status);
    }
  }
  // Toggle the visibilty of the dropdown menu
  function toggleDropdown() {
    const id = document.getElementById("dropdown");
    if (id) {
      id.classList.toggle("show");
    }
  }
  // Check if admin user is logged in
  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        setIsAdmin(data.isAdmin);
      })
      .catch(() => setIsAdmin(false));
  }, []);
  return (
    <header className="navbar">
      <div className="nav-left">
        <div className="nav-logo">LOGO</div>
        <span className="title">Se Afstemning</span>
      </div>

      <div className="nav-right-group">
        <div className="nav-center">
          <Link to="/">Hjem</Link>
        </div>
        <div className="nav-center">
          {isAdmin && <Link to="/admin">Admin</Link>}
        </div>
        <div className="nav-center">
          <Link to="/auditlog">Auditlog</Link>
        </div>

        <div className="vertical-divider"></div>

        <div className="nav-right">
          <div className="dropdown">
            <button
              type="button"
              className="dropdown-button"
              onClick={toggleDropdown}
            >
              {/* User Icon SVG */}
              <FaUser />
            </button>
            <div id="dropdown" className="dropdown-content">
              <a onClick={handleLogout}>Logout</a>
            </div>
          </div>
          <span className="username">{userName}</span>
        </div>
      </div>
    </header>
  );
}

export default NavBar;
