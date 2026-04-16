import { useState } from "react";
import "./App.css";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import { getCookie } from "./WebLib.ts";

/**
 * Retrieves a cookie value by name.
 * @param name - The key of the cookie to retrieve.
 * @returns The string value of the cookie, or undefined if not found.
 */

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  return isLoggedIn === "true"
    ? <OverviewPage />
    : <LoginPage setIsLoggedIn={setIsLoggedIn} />;
}

export default App;
