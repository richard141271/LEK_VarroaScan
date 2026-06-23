import { Suspense } from "react";
import { ProductionSubmissionClient } from "./client";

export default function AdminInnsendingDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-dvh px-4 pb-10 pt-8">
          <div className="mx-auto w-full max-w-3xl rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
            <div className="text-base font-semibold">Laster arbeidsflate…</div>
          </div>
        </div>
      }
    >
      <ProductionSubmissionClient />
    </Suspense>
  );
}
