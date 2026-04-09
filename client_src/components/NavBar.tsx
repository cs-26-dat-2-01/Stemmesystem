import React from "react";
import "./NavBar.css";

function NavBar() {
  return (
    <header className="navbar">
      <div className="nav-left">
        <div className="placeholder-box"></div>
        <span className="title">Se Afstemning</span>
      </div>

      <div className="nav-right-group">
        <div className="nav-center">
          <a href="#">Hjem</a>
        </div>

        <div className="vertical-divider"></div>

        <div className="nav-right">
            {/* User Icon SVG */}
          <div className="avatar">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="black"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="8" r="4" />

              <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
            </svg>
          </div>
          <span className="username">Navn</span>
        </div>
      </div>
    </header>
  );
}

export default NavBar;
