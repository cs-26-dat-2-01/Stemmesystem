import React from "react";
import "./LoginPage.css";
import { getCookie } from "../App.tsx";
import NavBar from "../components/NavBar.tsx";
import { FaUser, FaLock } from "react-icons/fa";

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
          <div className="input-wrapper">
            <FaUser className="input-icon"/>
            <input
              name="username"
              id="username"
              type="text"
              autoComplete="username"
              placeholder="brugernavn"
              className="input-field"
              onChange={handleUsernameChange}
            />
          </div>
          <div className="input-wrapper">
            <FaLock className="input-icon"/>
            <input
              name="password"
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="adgangskode"
              className="input-field"
              onChange={handlePasswordChange}
            />
          </div>

          <button type="button" onClick={handleLogin}>
            Login
          </button>
        </div>
      </div>
    </>
  );
}

export default LoginPage;
