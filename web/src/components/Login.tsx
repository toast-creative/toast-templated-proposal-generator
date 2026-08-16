import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Login({
  onSubmit,
}: {
  onSubmit: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const ok = await onSubmit(password);
      if (!ok) {
        setError(true);
        setPassword("");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-background p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border bg-card p-8 shadow-sm"
      >
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-primary/10">
            <Lock className="size-5 text-primary" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">
            Toast<span className="text-muted-foreground"> Proposal AI MVP</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter the master password to continue.
          </p>
        </div>

        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(false);
          }}
          placeholder="Master password"
          aria-label="Master password"
          aria-invalid={error}
          className="mb-3 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
        />

        {error && (
          <p className="mb-3 text-sm text-destructive">Incorrect password.</p>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={!password || submitting}
        >
          {submitting ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
