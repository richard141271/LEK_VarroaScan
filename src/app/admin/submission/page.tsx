import { Suspense } from "react";
import { AdminSubmissionClient } from "./client";

export default function AdminSubmissionPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh px-4 pb-10 pt-8">
          <div className="mx-auto w-full max-w-3xl rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Laster…</div>
          </div>
        </div>
      }
    >
      <AdminSubmissionClient />
    </Suspense>
  );
}
