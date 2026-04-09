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
        "Username": username,
        "Password": password,
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
    <NavBar/>
    <div>
      <h1>Login Page!</h1>
      <label htmlFor="username">User name:</label>
      <input
        name="username"
        id="username"
        type="text"
        autoComplete="username"
        onChange={handleUsernameChange}
        />

      <br />

      <label htmlFor="password">Password:</label>
      <input
        name="password"
        id="password"
        type="password"
        autoComplete="current-password"
        onChange={handlePasswordChange}
        />

      <button type="button" onClick={handleLogin}>
        Log In
      </button>
    </div>
  </>
  );
}

export default LoginPage;
