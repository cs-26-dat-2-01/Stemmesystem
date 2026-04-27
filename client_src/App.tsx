import { useState } from "react";
import "./App.css";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import AdminPage from "./pages/AdminPage.tsx";
import { getCookie } from "./WebLib.ts";

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  // Vis admin-dashboardet hvis URL'en er /admin
  // Dette er en simpel client-side routing uden React Router
  const erPaaAdminSide = window.location.pathname === "/admin";

  if (!isLoggedIn || isLoggedIn !== "true") {
    return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  }

  if (erPaaAdminSide) {
    return <AdminPage />;
  }

  return <OverviewPage />;
}

export default App;
