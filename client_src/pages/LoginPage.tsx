import React from "react";
import "./LoginPage.css";
import { getCookie } from "../App.tsx";
import NavBar from "../components/NavBar.tsx";

type LoginPageProps = {
  setIsLoggedIn: React.Dispatch<React.SetStateAction<string | undefined>>;
};

function LoginPage({ setIsLoggedIn }: LoginPageProps) {
  let username: string;
  let password: string;

  function handleUsernameChange(event: React.ChangeEvent<HTMLInputElement>) {
    username = event.target.value;
  }

  function handlePasswordChange(event: React.ChangeEvent<HTMLInputElement>) {
    password = event.target.value;
  }

  async function handleLogin() {
    console.log("Username: ", username);
    console.log("Password: ", password);

    const res = await fetch("http://localhost:8000/login", {
      method: "GET",
      headers: {
        Username: username,
        Password: password,
      },
    });
    console.log(res);
    if (res.status == 200) {
      setIsLoggedIn(getCookie("isLoggedIn"));
    } else {
      console.log("login failed with code: " + res.status);
    }
  }

  return (
    <>
      <NavBar />
      <div className="login-container">
        <div className="form">
          <h1>Login</h1>
          <input
            name="username"
            id="username"
            type="text"
            placeholder="brugernavn"
            autoComplete="username"
            onChange={handleUsernameChange}
          />
          <input
            name="password"
            id="password"
            type="password"
            placeholder="adgangskode"
            autoComplete="current-password"
            onChange={handlePasswordChange}
          />

          <button type="button" onClick={handleLogin}>
            Login
          </button>
        </div>
      </div>
    </>
  );
}

export default LoginPage;
