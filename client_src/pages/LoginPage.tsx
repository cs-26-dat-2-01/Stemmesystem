import React, { useState } from "react";
import "./LoginPage.css";
import { getCookie } from "../WebLib.ts";
import { FaLock, FaUser } from "react-icons/fa";

type LoginPageProps = {
  setIsLoggedIn: React.Dispatch<React.SetStateAction<string | undefined>>;
};

function LoginPage({ setIsLoggedIn }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  //Form validation error
  const [error, setError] = useState(false);

  function handleUsernameChange(event: React.ChangeEvent<HTMLInputElement>) {
    setUsername(event.target.value);
    setError(false);
  }

  function handlePasswordChange(event: React.ChangeEvent<HTMLInputElement>) {
    setPassword(event.target.value);
    setError(false);
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
      setError(true);
    }
  }

  return (
    <>
      <div className="login-page">
        <div className="login-container">
          <div className="form">
            <h1>Login</h1>
            {error && (
              <p className="error-text">Forkert brugernavn eller adgangskode</p>
            )}
            <form onSubmit={handleLogin}>
              <div className="input-wrapper">
                <FaUser className="input-icon" />
                <input
                  name="username"
                  id="username"
                  type="text"
                  autoComplete="username"
                  placeholder="brugernavn"
                  className={`input-field ${error ? "input-error" : ""}`}
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
                  className={`input-field ${error ? "input-error" : ""}`}
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
      </div>
    </>
  );
}

export default LoginPage;
