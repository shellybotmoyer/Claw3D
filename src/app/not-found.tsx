"use client";

import { redirect } from "next/navigation";

export default function NotFound() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 rounded-xl border border-border/50 bg-card/80 p-10 text-center backdrop-blur">
        <span className="font-display text-8xl tracking-wider text-foreground">
          404
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-foreground">
            Page not found
          </h1>
          <p className="text-muted-foreground text-sm">
            The page you&apos;re looking for doesn&apos;t exist or has been
            moved.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => redirect("/office")}
            className="cursor-pointer rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go to Office
          </button>
          <button
            onClick={() => redirect("/")}
            className="cursor-pointer rounded-md border border-border px-5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
