import { useEffect, useState } from "react";
import type { ResultsPayload } from "../WebLib.ts";

interface PollResultsProps {
  pollId: number;
}
function PollResults({ pollId }: PollResultsProps) {
  const [data, setData] = useState<ResultsPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  useEffect(() => {
    async function fetchResults() {
      const res = await fetch(`/api/poll/${pollId}/results`, {
        credentials: "include",
      });
      if (res.status === 200) {
        const dataResults = await res.json() as ResultsPayload;
        setData(dataResults);
      } else {
        const msg = await res.text();
        setErrorMessage(msg || "Kunne ikke hente resultater");
        console.log("Results fetch failed:", res.status);
      }
    }
    fetchResults();
  }, [pollId]);

  return (
    <div>
      <h1>Resultat af afstemning</h1>

      <h2>Top resultater</h2>
      <ul>
        {sorted.map((item, i) => (
          <li key={i}>
            {item.option}: {item.count} stemmer
          </li>
        ))}
      </ul>

      <h2>Stemmer</h2>
      <ul>
        {data.votesreceived.map((vote, i) => (
          <li key={i}>
            {data.Secrecy === "secret"
              ? vote.uuid
              : `${vote.uuid} → ${vote.vote}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default PollResults;
