interface BallotPageProps {
  pollId: number;
}

function BallotPage({ pollId }: BallotPageProps) {
  return <h1>Poll {pollId}</h1>;
}

export default BallotPage;
