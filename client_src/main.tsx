import "./index.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebSocketProvider } from "./WebsocketContext.tsx";
import {
  BrowserRouter,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router";
import { getCookie } from "./WebLib.ts";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import AdminPage from "./pages/AdminPage.tsx";
import CreatePollPage from "./pages/CreatePollPage.tsx";
import BallotPage from "./pages/BallotPage.tsx";
import PollResults from "./pages/PollResult.tsx";
import AuditLog from "./pages/AuditLog.tsx";
import PollOverviewPage from "./pages/PollOverviewPage.tsx";

function LoginGuard({ children }: { children: React.ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(
    getCookie("isLoggedIn", document.cookie),
  );

  if (!isLoggedIn || isLoggedIn !== "true") {
    return <LoginPage setIsLoggedIn={setIsLoggedIn} />;
  }

  return <>{children}</>;
}

// Wrapper supplies onExit via useNavigate so CreatePollPage stays decoupled from the router.
const BallotPageWrapper = () => {
  const { id } = useParams();
  return <BallotPage pollId={parseInt(id ?? "0", 10) || 0} />;
};
const CreatePollPageWrapper = () => {
  const navigate = useNavigate();
  const { pollId } = useParams();
  const parsed = pollId ? parseInt(pollId, 10) : NaN;
  const draftId = Number.isInteger(parsed) ? parsed : null;
  return <CreatePollPage onExit={() => navigate("/")} draftId={draftId} />;
};

const PollResultsWrapper = () => {
  const { id } = useParams();
  return <PollResults pollId={parseInt(id ?? "0", 10) || 0} />;
};

const PollOverviewPageWrapper = () => {
  const { id } = useParams();
  return <PollOverviewPage pollId={parseInt(id ?? "0", 10) || 0} />;
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
            <Route
              path="/createpoll/:pollId?"
              element={<CreatePollPageWrapper />}
            />
            <Route
              path="/poll/:id/vote"
              element={<BallotPageWrapper />}
            />
            <Route
              path="/poll/:id/results"
              element={<PollResultsWrapper />}
            />
            <Route
              path="/poll/:id/overview"
              element={<PollOverviewPageWrapper />}
            />
          </Routes>
        </WebSocketProvider>
      </LoginGuard>
    </BrowserRouter>
  </StrictMode>,
);
