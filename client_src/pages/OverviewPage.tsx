import { useEffect } from "react";
import "./OverviewPage.css";
import NavBar from "../components/NavBar.tsx";

// This is the main entry point of the app
// Currently it is configured to showcase how to create declarative UI with react.
function OverviewPage() {
  // We can declare a list of variables, containing stuff we want rendered to the screen.
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
    {
      id: 3,
      name: "Jukebox",
      url: "https://minecraft.wiki/images/thumb/Jukebox_JE2_BE2.png/150px-Jukebox_JE2_BE2.png?50367",
    },
  ];

  useEffect(() => {
    fetch("http://localhost:8000/api/dinosaur", {
      method: "GET",
    });
  }, []);

  // React is just JavaScript functions that return HTML.
  // We can then inline JavaScript to create a loop inside the HTML,
  // such that each entry from the list above is used to create a new object in HTML.
  // In this way we can write declarative reusable UI components.
  return (
    <>
      <NavBar />
      {blocks.map((block) => (
        <div className="content-block">
          <img src={block.url} />
          <br />
          <span>{block.name}!!!</span>
        </div>
      ))}
      <text>Hello, World!</text>
    </>
  );
}

export default OverviewPage;
