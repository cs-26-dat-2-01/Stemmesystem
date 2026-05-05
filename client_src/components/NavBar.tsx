import { useState } from "react";
import "./NavBar.css";
import { FaUser } from "react-icons/fa";
import { getCookie } from "../WebLib.ts";

function NavBar() {
  const [userName] = useState(getCookie("user", document.cookie));
  async function handleLogout() {
    const res = await fetch("/logout", {
      method: "POST",
      credentials: "include",
    });

    if (res.status == 200) {
      //Refresh site after clearing cookies
      globalThis.location.reload();
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
  return (
    <header className="navbar">
      <div className="nav-left">
        <div className="nav-logo">LOGO</div>
        <span className="title">Se Afstemning</span>
      </div>

      <div className="nav-right-group">
        <div className="nav-center">
          <a href="#">Hjem</a>
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
