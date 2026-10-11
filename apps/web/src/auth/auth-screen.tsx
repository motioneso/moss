import { Button, Eyebrow, Field, FormLabel, Segmented } from "@moss/ui";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, LogIn, UserPlus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { signInEmail, signUpEmail } from "../api/client";
import { assistantName, holdAssistantNameForSignIn } from "../api/use-assistant-name.js";

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
    onSuccess: () => {
      holdAssistantNameForSignIn();
      props.onAuthenticated();
    }
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
          <Eyebrow tone="accent">{assistantName()}</Eyebrow>
          <h1 id="auth-title">{mode === "sign-up" ? "Create owner account" : "Sign in"}</h1>
        </div>

        {!props.needsBootstrap ? (
          <Segmented
            value={mode}
            options={[
              { value: "sign-in", label: "Sign in" },
              { value: "sign-up", label: "Create account" }
            ]}
            onChange={setMode}
            ariaLabel="Auth mode"
          />
        ) : null}

        <form className="auth-form" onSubmit={handleSubmit}>
          {mode === "sign-up" ? (
            <Field>
              <FormLabel htmlFor="auth-name">Name</FormLabel>
              <input
                id="auth-name"
                className="jds-input"
                autoComplete="name"
                minLength={1}
                onChange={(event) => setName(event.target.value)}
                required
                type="text"
                value={name}
              />
            </Field>
          ) : null}

          <Field>
            <FormLabel htmlFor="auth-email">Email</FormLabel>
            <input
              id="auth-email"
              className="jds-input"
              autoComplete="email"
              inputMode="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </Field>

          <Field>
            <FormLabel htmlFor="auth-password">Password</FormLabel>
            <input
              id="auth-password"
              className="jds-input"
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </Field>

          {mutation.error ? (
            <p className="form-error" role="alert">
              {mutation.error.message}
            </p>
          ) : null}

          <Button block disabled={mutation.isPending} type="submit">
            {mutation.isPending ? (
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
            ) : mode === "sign-up" ? (
              <UserPlus size={18} aria-hidden="true" />
            ) : (
              <LogIn size={18} aria-hidden="true" />
            )}
            {mode === "sign-up" ? "Create account" : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}
