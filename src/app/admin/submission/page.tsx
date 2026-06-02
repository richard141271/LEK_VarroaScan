import { Suspense } from "react";
import { AdminSubmissionClient } from "./client";

export default function AdminSubmissionPage() {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const isAdminEnabled = process.env.NEXT_PUBLIC_ENABLE_ADMIN === "true";

  if (!isAdminEnabled) {
    return (
      <div className="min-h-dvh px-4 pb-10 pt-8">
        <header className="mx-auto w-full max-w-3xl">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">Admin</div>
              <div className="text-xs text-zinc-400">Deaktivert</div>
            </div>
            <a
              href={`${basePath}/`}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Innsending
            </a>
          </div>
        </header>
      </div>
    );
  }

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
