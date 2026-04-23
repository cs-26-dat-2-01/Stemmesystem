import "./App.css";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import { useState } from "react";
import PollResults from "./pages/PollResult.tsx";

/**
 * Retrieves a cookie value by name.
 * @param name - The key of the cookie to retrieve.
 * @returns The string value of the cookie, or undefined if not found.
 */
export const getCookie = (name: string): string | undefined => {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);

  if (parts.length === 2) {
    return parts.pop()?.split(";").shift();
  }

  return undefined;
};

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(getCookie("isLoggedIn"));

  return isLoggedIn === "true"
    ? <OverviewPage />
    : <LoginPage setIsLoggedIn={setIsLoggedIn} />;
}

export default App;
