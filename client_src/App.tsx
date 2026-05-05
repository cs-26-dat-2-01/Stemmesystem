import "./App.css";
import { useState } from "react";
import { getCookie } from "./WebLib.ts";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import AdminPage from "./pages/AdminPage.tsx";
import BallotPage from "./pages/BallotPage.tsx";

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  // Show admin dashboard, if URL is `/admin`
  const isOnAdminPage = window.location.pathname === "/admin"; // To-do: Window is not longer available in Deno.

  if (!isLoggedIn || isLoggedIn !== "true") {
    return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  }

  if (isOnAdminPage) {
    return <AdminPage />;
  }

  const pollMatch = window.location.pathname.match(/^\/poll\/(\d+)$/); // match needs regex to match the string. Returns null if no match
  if (pollMatch) return <BallotPage pollId={Number(pollMatch[1])} />;

  return <OverviewPage />;
}

export default App;
