import "./NavBar.css";
import { FaUser } from "react-icons/fa";

function NavBar() {
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
          {/* User Icon SVG */}
          <div className="avatar">
            <a href="#">
              <FaUser />
            </a>
          </div>
          <span className="username">Navn</span>
        </div>
      </div>
    </header>
  );
}

export default NavBar;
