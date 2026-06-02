"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";

type VarroaSubmission = {
  id: string;
  created_at: string;
  user_name: string | null;
  type: string;
  note: string | null;
  images: string[];
  status: "NY" | "UNDER_ARBEID" | "ARKIVERT";
};

function formatDateTime(value: string) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString("no-NO");
}

export default function AdminInboxPage() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  const supabase = useMemo(() => getSupabaseClient(), []);
  const [email, setEmail] = useState("");
  const [authInfo, setAuthInfo] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

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
        return;
      }

      const adminRes = await supabase
        .from("varroa_admins")
        .select("user_id")
        .eq("user_id", session.user.id)
        .maybeSingle();

      const admin = Boolean(adminRes.data?.user_id);
      setIsAdmin(admin);
      if (!admin) {
        setItems([]);
        return;
      }

      const inboxRes = await supabase
        .from("varroa_submissions")
        .select("id,created_at,user_name,type,note,images,status")
        .neq("status", "ARKIVERT")
        .order("created_at", { ascending: false })
        .limit(100);

      if (inboxRes.error) throw inboxRes.error;
      setItems((inboxRes.data ?? []) as VarroaSubmission[]);
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

  const sendLoginLink = async () => {
    setAuthError(null);
    setAuthInfo(null);

    if (!isOnline) {
      setAuthError("Du er offline. Innlogging krever nett.");
      return;
    }

    if (!supabase) {
      setAuthError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }

    const trimmed = email.trim();
    if (!trimmed) {
      setAuthError("Skriv inn e-post.");
      return;
    }

    const res = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: {
        emailRedirectTo: `${window.location.origin}${basePath}/admin/`,
      },
    });

    if (res.error) {
      setAuthError(res.error.message);
      return;
    }

    setAuthInfo("Sjekk e-posten din for en innloggingslenke.");
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    await reload();
  };

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Admin</div>
            <div className="text-xs text-zinc-400">
              Innboks (ikke arkivert)
            </div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={`${basePath}/`}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Innsending
            </a>
            <a
              href={`${basePath}/admin/archive/`}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Arkiv
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
        {!isAuthed ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Logg inn</div>
            <div className="mt-1 text-sm text-zinc-400">
              Admin bruker Supabase e-postlenke (OTP).
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="din@epost.no"
                className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
              />
              <button
                type="button"
                onClick={sendLoginLink}
                className="h-12 rounded-2xl bg-amber-400 text-zinc-950 font-semibold active:opacity-90 disabled:opacity-60"
                disabled={!isOnline}
              >
                Send innloggingslenke
              </button>
            </div>

            {authInfo ? (
              <div className="mt-4 rounded-2xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
                {authInfo}
              </div>
            ) : null}
            {authError ? (
              <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {authError}
              </div>
            ) : null}
          </div>
        ) : null}

        {isAuthed && !isAdmin ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="text-base font-semibold">Ingen tilgang</div>
            <div className="mt-1 text-sm text-zinc-400">
              Du er innlogget, men er ikke registrert som admin i Supabase.
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={signOut}
                className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90"
              >
                Logg ut
              </button>
            </div>
          </div>
        ) : null}

        {isAdmin ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
            <div className="flex items-center justify-between">
              <div className="text-base font-semibold">Innboks</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={reload}
                  className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
                  disabled={isLoading}
                >
                  Oppdater
                </button>
                <button
                  type="button"
                  onClick={signOut}
                  className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90"
                >
                  Logg ut
                </button>
              </div>
            </div>

            {loadError ? (
              <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {loadError}
              </div>
            ) : null}

            <div className="mt-4 divide-y divide-zinc-800">
              {items.length === 0 ? (
                <div className="py-6 text-sm text-zinc-400">
                  Ingen innsendelser i innboksen.
                </div>
              ) : null}

              {items.map((s) => (
                <a
                  key={s.id}
                  href={`${basePath}/admin/submission/?id=${encodeURIComponent(s.id)}`}
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
