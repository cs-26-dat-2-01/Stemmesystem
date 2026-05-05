function PollResults() {
  // Mock data (for now)
  const data = {
    Secrecy: "open",
    topN: 3,
    pollresults: [
      { option: "Option 1", count: 10 },
      { option: "Option 2", count: 7 },
      { option: "Option 3", count: 5 },
      { option: "Option 4", count: 1 },
    ],
    votesreceived: [
      { uuid: "abc-123", vote: "Option 1" },
      { uuid: "def-456", vote: "Option 2" },
      { uuid: "ghi-789", vote: "Option 3" },
    ],
  };

  // Sort the data according to votes and show only the top N
  const sorted = [...data.pollresults]
    .sort((a, b) => b.count - a.count)
    .slice(0, data.topN);

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

