import { useEffect, useState } from "react";
import { CreatePollStep4 } from "./CreatePollPage.tsx";
import NavBar from "../components/NavBar.tsx";
import type { Poll, PollOption } from "../WebLib.ts";

function PollOverviewPage({ pollId }: { pollId: number }) {
  const [pollData, setPollData] = useState<Partial<Poll>>({});
  const [voters, setVoters] = useState<
    Array<{ username: string; votesAllowed: number }>
  >([]);
  const [choices, setChoices] = useState<string[]>([]);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/polls/${pollId}/overview`, {
        credentials: "include",
      });
      if (res.status === 401) {
        await fetch("/logout", { method: "POST", credentials: "include" });
        globalThis.location.href = "/";
        return;
      }
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setPollData(data.poll);
      setVoters(data.voters ?? []);
      setChoices(
        (data.options ?? [])
          .sort((a: PollOption, b: PollOption) =>
            a.displayOrder -
            b.displayOrder
          )
          .map((o: PollOption) => o.optionText ?? ""),
      );
    })();
  }, [pollId]);

  if (forbidden) {
    return (
      <div className="create-poll-page">
        <NavBar />
        <p>Not allowed to open</p>
      </div>
    );
  }

  return (
    <div className="create-poll-page">
      <NavBar />
      <CreatePollStep4
        pollData={pollData}
        voters={voters}
        choices={choices}
        onNext={() => {}}
        hideAction
        heading="Afstemnings oversigt"
        pollId={pollId}
      />
    </div>
  );
}

export default PollOverviewPage;
