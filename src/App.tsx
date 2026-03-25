import "./App.css";

function App() {
  const blocks = [
    {
      id: 1,
      name: "Glowstone",
      url: "https://minecraft.wiki/images/Glowstone_JE4_BE2.png?0d5b0",
    },
    {
      id: 2,
      name: "Block of Gold",
      url: "https://minecraft.wiki/images/Block_of_Gold_JE6_BE3.png?09478",
    },
  ];

  return (
    <>
      {blocks.map((block) => (
        <div className="content-block">
          <img src={block.url} />
          <br />
          <pre>{block.name}!!!</pre>
        </div>
      ))}
    </>
  );
}

export default App;
