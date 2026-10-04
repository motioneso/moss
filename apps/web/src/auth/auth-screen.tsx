import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, LogIn, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { signInEmail, signUpEmail } from "../api/client";
import { assistantName } from "../api/use-assistant-name";

interface AuthScreenProps {
  readonly needsBootstrap: boolean;
  readonly onAuthenticated: () => Promise<void>;
}

type AuthMode = "sign-in" | "sign-up";

export function AuthScreen(props: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(props.needsBootstrap ? "sign-up" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign-up") {
        await signUpEmail({ name, email, password });
        return;
      }

      await signInEmail({ email, password });
    },
    onSuccess: () => props.onAuthenticated()
  });

  useEffect(() => {
    if (props.needsBootstrap) {
      setMode("sign-up");
    }
  }, [props.needsBootstrap]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div>
          <p className="eyebrow">{assistantName()}</p>
          <h1 id="auth-title">{mode === "sign-up" ? "Create owner account" : "Sign in"}</h1>
        </div>

        {!props.needsBootstrap ? (
          <div className="segmented-control" aria-label="Auth mode">
            <button
              className={mode === "sign-in" ? "active" : ""}
              type="button"
              onClick={() => setMode("sign-in")}
            >
              Sign in
            </button>
            <button
              className={mode === "sign-up" ? "active" : ""}
              type="button"
              onClick={() => setMode("sign-up")}
            >
              Create account
            </button>
          </div>
        ) : null}

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === "sign-up" ? (
            <label>
              Name
              <input
                autoComplete="name"
                minLength={1}
                onChange={(event) => setName(event.target.value)}
                required
                type="text"
                value={name}
              />
            </label>
          ) : null}

          <label>
            Email
            <input
              autoComplete="email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>

          <label>
            Password
            <input
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>

          {mutation.error ? <p className="form-error">{mutation.error.message}</p> : null}

          <button className="primary-button" disabled={mutation.isPending} type="submit">
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
            ) : mode === "sign-up" ? (
              <UserPlus size={18} aria-hidden="true" />
            ) : (
              <LogIn size={18} aria-hidden="true" />
            )}
            {mode === "sign-up" ? "Create account" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
