"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to error reporting service if available
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 rounded-xl border border-red-900/40 bg-card/80 p-10 text-center backdrop-blur">
        <span className="font-display text-8xl tracking-wider text-red-500">
          !
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="text-muted-foreground text-sm">
            An unexpected error occurred. The error has been logged.
          </p>
          {error.digest && (
            <p className="font-mono text-xs text-muted-foreground">
              {error.digest}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={reset}
            className="cursor-pointer rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <button
            onClick={() => (window.location.href = "/office")}
            className="cursor-pointer rounded-md border border-border px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go to Office
          </button>
        </div>
      </div>
    </div>
  );
}
