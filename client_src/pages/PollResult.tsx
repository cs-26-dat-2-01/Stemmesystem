import { useEffect, useState } from "react";
import './PollResults.css';
import NavBar from "../components/NavBar.tsx";
import type { ResultsPayload } from "../WebLib.ts";

type ViewState =
  | "loading"
  | "ready"
  | "error";

  interface PollResultsProps{
	  pollId: number;
  }

function PollResults( {pollId}: PollResultsProps) {

const [viewState, setViewState] = useState<ViewState>("loading")
const [errorMessage] = useState("");
const [data, setData] = useState<ResultsPayload | null>(null);
 

	useEffect(() => {
		 (async () => {
		 try {
		 	const res = await fetch(`/api/poll/${pollId}/results`);
			if (!res.ok){
				setViewState("error");
				return; 
			}
		 const json: ResultsPayload = await res.json(); 
		 setData(json); 
		 setViewState("ready");
		 } catch {
			 setViewState("error");
		 }
		 })(); 
	}, [pollId]);

  if (viewState === "loading") {

   return (
    <>
      <NavBar />
      <div className= "rs-layout">
        <div className= "rs-main">Indlæser resultater...</div>
        </div>
        </>
   );
  }
 if (viewState === "error") {
  return (
    <>
      <NavBar />
      <div className="rs-layout">
        <div className="rs-main">
          <h2>Fejl</h2>
          <p>{errorMessage}</p>
        </div>
      </div>
    </>
  );
  }


if (!data) return null;

const isOpen = data.ballotPrivacy === "open";
const votes = data.votes;

// Sort the data according to votes and show only the top
   const sortedTop = [...data.counts]
    .sort((a, b) => b.count - a.count)
    .slice(0, data.showTopN);

  const max = Math.max(...data.counts.map((c) => c.count), 1);

  return (
    <>
      <NavBar />

      <div className="rs-layout">

        {/* List of votes */}
        <div className="rs-main">
          <h2 className="rs-title">Resultat af afstemning</h2>

          <table className="rs-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Stemme</th>
              </tr>
            </thead>
              <tbody>
                {votes.map((vote, i) => (
                  <tr key={i}>
                    <td>{vote.uuid}</td>
                    <td>
                       {isOpen
                       ? (vote as Extract<typeof data, { ballotPrivacy: "open" }>["votes"][number]).optionText
                       : "Skjult"}
                       </td>
                       </tr>
                      ))}
                      </tbody>
          </table>
        </div>

        {/* Right sidebar that shows topN votes */}
        <div className="rs-sidebar">
          <div className="rs-top-box">
            <div className="rs-top-title">
              Top {data.showTopN} resultater
            </div>

            {sortedTop.map((item, i) => (
              <div key={i} className="rs-top-item">
                <div>{item.optionText}</div>

                <div className="rs-bar-wrapper">
                  <div
                    className="rs-bar-fill"
                    style={{
                      width: `${(item.count / max) * 100}%`,
                    }}
                  />
                </div>

                <div className="rs-meta">
                  {item.count} stemmer
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </>
  );
}

export default PollResults;
