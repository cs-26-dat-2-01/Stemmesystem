import "./App.css";
import { useState } from "react";
import { getCookie } from "./WebLib.ts";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import AdminPage from "./pages/AdminPage.tsx";
import BallotPage from "./pages/BallotPage.tsx";
import AuditLog from "./pages/AuditLog.tsx";
import CreatePollPage from "./pages/CreatePollPage.tsx";
/**
 * Retrieves a cookie value by name.
 * @param name - The key of the cookie to retrieve.
 * @returns The string value of the cookie, or undefined if not found.
 */
import PollResults from "./pages/PollResult.tsx";

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  const pollMatch = window.location.pathname.match(/^\/poll\/(\d+)$/); // match needs regex to match the string. Returns null if no match
  const auditMatch = window.location.pathname.match(/^\/auditlog$/);
  // Show admin dashboard, if URL is `/admin`
  const isOnAdminPage = window.location.pathname === "/admin"; // To-do: Window is not longer available in Deno.
  const isOnCreatePoll = window.location.pathname === "/createpoll";
  const editDraftMatch = window.location.pathname.match(
    /^\/createpoll\/(\d+)$/,
  ); // for createpoll/:/pollId

  if (!isLoggedIn || isLoggedIn !== "true") {
    return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  }

  if (isOnAdminPage) {
    return <AdminPage />;
  }

  const resultsMatch = window.location.pathname.match(
    /^\/poll\/(\d+)\/results$/,
  );

  if (isLoggedIn !== "true") return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  if (resultsMatch) return <PollResults pollId={Number(resultsMatch[1])} />;
  if (pollMatch) return <BallotPage pollId={Number(pollMatch[1])} />;
  if (auditMatch) return <AuditLog />;
  if (editDraftMatch) {
    return (
      <CreatePollPage
        onExit={() => {
          window.location.href = "/";
        }}
        draftId={Number(editDraftMatch[1])}
      />
    );
  }

  if (isOnCreatePoll) {
    return (
      <CreatePollPage
        onExit={() => {
          window.location.href = "/";
        }}
      />
    );
  }

  return <OverviewPage />;
}

export default App;
