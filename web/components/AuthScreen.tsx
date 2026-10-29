import { useState } from "react";
import { useCipher } from "../lib/store.tsx";
import { ShieldIcon } from "./Icons.tsx";

type Mode = "signIn" | "register";

export function AuthScreen() {
  const { status, user, busy, authError, register, signIn, unlock, forgetSession } = useCipher();
  const [mode, setMode] = useState<Mode>("signIn");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");

  const locked = status === "locked";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked) {
      await unlock(password);
    } else if (mode === "register") {
      await register(username, displayName, password);
    } else {
      await signIn(username, password);
    }
    setPassword("");
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-900 p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-700 text-cyan">
            <ShieldIcon className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Cipher</h1>
            <p className="text-xs text-lo">Messages that carry their own lifespan.</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-edge bg-ink-800 p-6">
          {locked ? (
            <div>
              <h2 className="text-sm font-semibold">Unlock as {user?.displayName}</h2>
              <p className="mt-1 text-xs leading-relaxed text-lo">
                Your encryption key is kept in memory only, so it has to be rebuilt from your password.
              </p>
            </div>
          ) : (
            <div className="flex gap-1 rounded-lg bg-ink-700 p-1">
              {(["signIn", "register"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === option ? "bg-ink-900 text-hi" : "text-lo hover:text-hi"
                  }`}
                >
                  {option === "signIn" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>
          )}

          {!locked && (
            <>
              <Field
                label="Username"
                value={username}
                onChange={setUsername}
                autoComplete="username"
                placeholder="alistair"
              />
              {mode === "register" && (
                <Field
                  label="Display name"
                  value={displayName}
                  onChange={setDisplayName}
                  autoComplete="name"
                  placeholder="Alistair Finch"
                />
              )}
            </>
          )}

          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            autoComplete={mode === "register" && !locked ? "new-password" : "current-password"}
            placeholder={mode === "register" && !locked ? "At least 10 characters" : ""}
          />

          {mode === "register" && !locked && (
            <p className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs leading-relaxed text-amber">
              Your identity key is encrypted with this password and never leaves your device unsealed. If you lose
              the password, your messages cannot be recovered by anyone — including us.
            </p>
          )}

          {authError !== null && (
            <p role="alert" className="text-xs text-red">
              {authError}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-cyan px-4 py-2.5 text-sm font-semibold text-ink-900 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Working…" : locked ? "Unlock" : mode === "register" ? "Create account" : "Sign in"}
          </button>

          {locked && (
            <button
              type="button"
              onClick={forgetSession}
              className="w-full text-xs text-lo underline-offset-2 hover:text-hi hover:underline"
            >
              Use a different account
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
};

function Field({ label, value, onChange, type = "text", autoComplete, placeholder }: FieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-lo">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
        className="w-full rounded-lg border border-edge bg-ink-900 px-3 py-2 text-sm text-hi placeholder:text-lo/50 focus:border-cyan focus:outline-none"
      />
    </label>
  );
}
