"use client";

import dynamic from "next/dynamic";
import { RunningAvatarLoader } from "@/features/agents/components/RunningAvatarLoader";

function OfficeLoadingFallback() {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-background"
      aria-label="Loading office"
      role="status"
    >
      <div className="flex flex-col items-center gap-3">
        <RunningAvatarLoader
          size={28}
          trackWidth={76}
          label="Loading..."
          labelClassName="text-muted-foreground"
        />
      </div>
    </div>
  );
}

const OfficePageClient = dynamic(() => import("./OfficePageClient"), {
  ssr: false,
  loading: () => <OfficeLoadingFallback />,
});

export default function OfficePage() {
  return <OfficePageClient />;
}
