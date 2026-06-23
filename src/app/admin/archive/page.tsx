"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendAdminContext,
  getAdminReturnInfo,
} from "@/lib/adminNavigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { isVarroaAdmin } from "@/lib/varroaAdmin";

type VarroaSubmission = {
  id: string;
  created_at: string;
  user_name: string | null;
  type: string;
  note: string | null;
  images: string[];
  status: "NY" | "UNDER_ARBEID" | "ARKIVERT";
  ai_status?: "PENDING" | "RUNNING" | "DONE" | "FAILED" | null;
  ai_count?: number | null;
};

function isMissingAiColumnsError(value: unknown) {
  if (!value || typeof value !== "object") return false;
  if (!("message" in value)) return false;
  const message = String((value as { message?: unknown }).message ?? "");
  return (
    message.includes("does not exist") &&
    (message.includes("ai_status") || message.includes("ai_count"))
  );
}

function formatDateTime(value: string) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString("no-NO");
}

export default function AdminArchivePage() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);
  const adminContextSearch = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.search;
  }, []);
  const returnInfo = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: null as string | null, label: "← Tilbake" };
    }
    return getAdminReturnInfo(window.location.search);
  }, []);

  const [isAuthed, setIsAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [items, setItems] = useState<VarroaSubmission[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoadError(null);
    if (!supabase) {
      setLoadError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }
    setIsLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      setIsAuthed(Boolean(session));
      if (!session) {
        setIsAdmin(false);
        setItems([]);
        setLoadError("Logg inn som admin for å se arkivet.");
        return;
      }

      const admin = await isVarroaAdmin(supabase, session);
      setIsAdmin(admin);
      if (!admin) {
        setItems([]);
        setLoadError("Kun admin kan se arkivet.");
        return;
      }

      const selectWithAi =
        "id,created_at,user_name,type,note,images,status,ai_status,ai_count";
      const selectWithoutAi = "id,created_at,user_name,type,note,images,status";

      const resWithAi = await supabase
        .from("varroa_submissions")
        .select(selectWithAi)
        .eq("status", "ARKIVERT")
        .order("created_at", { ascending: false })
        .limit(200);

      if (resWithAi.error && isMissingAiColumnsError(resWithAi.error)) {
        const resWithoutAi = await supabase
          .from("varroa_submissions")
          .select(selectWithoutAi)
          .eq("status", "ARKIVERT")
          .order("created_at", { ascending: false })
          .limit(200);

        if (resWithoutAi.error) throw resWithoutAi.error;
        setItems((resWithoutAi.data ?? []) as VarroaSubmission[]);
        return;
      }

      if (resWithAi.error) throw resWithAi.error;
      setItems((resWithAi.data ?? []) as VarroaSubmission[]);
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(t);
  }, [reload]);

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Admin</div>
            <div className="text-xs text-zinc-400">Arkiv</div>
          </div>
          <div className="flex items-center gap-4">
            {returnInfo.href ? (
              <a
                href={returnInfo.href}
                className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
              >
                {returnInfo.label}
              </a>
            ) : null}
            <a
              href={appendAdminContext(`${basePath}/admin/innsendinger/`, adminContextSearch)}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Innsendinger
            </a>
          </div>
        </div>

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Admin krever nett.
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-3xl space-y-4">
        {!isAuthed && loadError === "Logg inn som admin for å se arkivet." ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Admin kreves</div>
            <div className="mt-1 text-sm text-zinc-400">
              Logg inn via admin for å åpne arkivet.
            </div>
            <a
              href={`${basePath}/admin/`}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-2xl bg-amber-400 px-4 font-semibold text-zinc-950 active:opacity-90"
            >
              Gå til admin
            </a>
          </div>
        ) : null}

        {isAuthed && !isAdmin && loadError === "Kun admin kan se arkivet." ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Ingen tilgang</div>
            <div className="mt-1 text-sm text-zinc-400">
              Du er innlogget, men er ikke registrert som admin i Supabase.
            </div>
          </div>
        ) : null}

        {isAdmin ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold">Arkiv</div>
              <button
                type="button"
                onClick={reload}
                className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
                disabled={isLoading}
              >
                Oppdater
              </button>
            </div>

            {loadError ? (
              <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {loadError}
              </div>
            ) : null}

            <div className="mt-4 divide-y divide-zinc-800">
              {items.length === 0 ? (
                <div className="py-6 text-sm text-zinc-400">
                  Ingen innsendelser i arkivet.
                </div>
              ) : null}

              {items.map((s) => (
                <a
                  key={s.id}
                  href={appendAdminContext(
                    `${basePath}/admin/submission/?id=${encodeURIComponent(s.id)}`,
                    adminContextSearch,
                  )}
                  className="block py-4 hover:bg-zinc-950/60 rounded-2xl px-3 -mx-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-zinc-100 truncate">
                        {s.type === "BUNNBRETT_FOTO"
                          ? "Bunnbrett foto"
                          : s.type === "KONTROLLFOTO"
                            ? "Kontrollfoto"
                            : s.type}
                      </div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {formatDateTime(s.created_at)}
                        {s.user_name ? ` • ${s.user_name}` : ""}
                        {s.images?.length ? ` • ${s.images.length} bilder` : ""}
                        {s.status ? ` • ${s.status}` : ""}
                        {s.ai_status ? ` • AI ${s.ai_status}` : ""}
                        {typeof s.ai_count === "number" ? ` • ${s.ai_count} midd` : ""}
                      </div>
                      {s.note ? (
                        <div className="mt-2 text-sm text-zinc-300">
                          {s.note}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-sm font-semibold text-zinc-200">
                      Åpne →
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
