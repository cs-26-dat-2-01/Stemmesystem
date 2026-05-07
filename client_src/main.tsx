import "./index.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebSocketProvider } from "./WebsocketContext.tsx";
import { BrowserRouter, Route, Routes, useParams } from "react-router";
import { getCookie } from "./WebLib.ts";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import AdminPage from "./pages/AdminPage.tsx";
import CreatePollPage from "./pages/CreatePollPage.tsx";
import BallotPage from "./pages/BallotPage.tsx";
import PollResults from "./pages/PollResult.tsx";
import AuditLog from "./pages/AuditLog.tsx";

function LoginGuard({ children }: { children: React.ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  if (!isLoggedIn || isLoggedIn !== "true") {
    return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  }

  return <>{children}</>;
}

/* To-do: clean up the wrapper components */
const BallotPageWrapper = () => {
  const { id } = useParams();
  // We parse it here so BallotPage just gets a clean number
  return <BallotPage pollId={parseInt(id ?? "0", 10) || 0} />;
};

const PollResultsWrapper = () => {
  const { id } = useParams();
  // We parse it here so BallotPage just gets a clean number
  return <PollResults pollId={parseInt(id ?? "0", 10) || 0} />;
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <LoginGuard>
        <WebSocketProvider>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/admin/*" element={<AdminPage />} />
            <Route path="/auditlog/*" element={<AuditLog />} />
            <Route path="/createpoll/*" element={<CreatePollPage />} />
            <Route
              path="/poll/:id"
              element={<BallotPageWrapper />}
            />
            <Route
              path="/poll/:id/results"
              element={<PollResultsWrapper />}
            />
          </Routes>
        </WebSocketProvider>
      </LoginGuard>
    </BrowserRouter>
  </StrictMode>,
);
