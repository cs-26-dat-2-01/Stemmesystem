import { useEffect, useState } from "react";
import "./App.css";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";

function App() {
  const [isUserLoggedIn, setLogInState] = useState<boolean>(() => {
    return localStorage.getItem("isUserLogedIn") === "true";
  });

  useEffect(() => {
    localStorage.setItem("isUserLogedIn", String(isUserLoggedIn));
  }, [isUserLoggedIn]);

  return isUserLoggedIn ? <OverviewPage /> : (
    <LoginPage
      isUserLogedIn={isUserLoggedIn}
      changeLogInState={setLogInState}
    />
  );
}

export default App;
