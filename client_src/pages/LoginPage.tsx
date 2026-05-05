import React from "react";
import "./LoginPage.css";
import { getCookie } from "../WebLib.ts";
import { FaLock, FaUser } from "react-icons/fa";

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

  async function handleLogin(event: React.SubmitEvent) {
    event.preventDefault(); //Prevents default submit
    const res = await fetch("http://localhost:8000/login", {
      method: "POST",
      body: JSON.stringify({
        username: username,
        password: password,
      }),
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log(res);
    if (res.status == 200) {
      setIsLoggedIn(getCookie("isLoggedIn", document.cookie));
    } else {
      console.log("login failed with code: " + res.status);
    }
  }

  return (
    <>
      <div className="login-container">
        <div className="form">
          <h1>Login</h1>
          <form onSubmit={handleLogin}>
            <div className="input-wrapper">
              <FaUser className="input-icon" />
              <input
                name="username"
                id="username"
                type="text"
                autoComplete="username"
                placeholder="brugernavn"
                className="input-field"
                required
                onChange={handleUsernameChange}
              />
            </div>
            <div className="input-wrapper">
              <FaLock className="input-icon" />
              <input
                name="password"
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="adgangskode"
                className="input-field"
                required
                onChange={handlePasswordChange}
              />
            </div>
            <button type="submit" className="input-submit">
              Login
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

export default LoginPage;
