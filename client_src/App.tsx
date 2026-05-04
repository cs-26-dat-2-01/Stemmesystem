import { useState } from "react";
import "./App.css";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import { getCookie } from "./WebLib.ts";
import BallotPage from "./pages/BallotPage.tsx";
import PollResults from "./pages/PollResult.tsx";

/**
 * Retrieves a cookie value by name.
 * @param name - The key of the cookie to retrieve.
 * @returns The string value of the cookie, or undefined if not found.
 */

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  const pollMatch = window.location.pathname.match(/^\/poll\/(\d+)$/); // match needs regex to match the string. Returns null if no match
  
  if (isLoggedIn !== "true") return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  if (pollMatch) return <BallotPage pollId={Number(pollMatch[1])} />;
  return <PollResults />;
}

export default App;
