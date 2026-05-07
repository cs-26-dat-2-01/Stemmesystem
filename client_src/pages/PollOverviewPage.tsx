import { useEffect, useState } from "react";
import { CreatePollStep4 } from "./CreatePollPage.tsx";
import NavBar from "../components/NavBar.tsx";
import type { Poll, PollOption } from "../WebLib.ts";

function PollOverviewPage({ pollId }: { pollId: number }) {
  const [pollData, setPollData] = useState<Partial<Poll>>({});
  const [voters, setVoters] = useState<string[]>([]);
  const [choices, setChoices] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/polls/${pollId}/overview`, {
        credentials: "include",
      });
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
      />
    </div>
  );
}

export default PollOverviewPage;
