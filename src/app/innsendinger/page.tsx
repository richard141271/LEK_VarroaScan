"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";

type SubmissionStatus = "NY" | "UNDER_ARBEID" | "ARKIVERT" | string;

type VarroaSubmission = {
  id: string;
  created_at: string;
  note: string | null;
  status: SubmissionStatus;
  images: string[];
};

type SignedImage = { path: string; url: string };

function formatDateTime(value: string) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString("no-NO");
}

function getStatusUi(status: SubmissionStatus) {
  if (status === "NY") {
    return { label: "NY", cls: "bg-zinc-800 text-zinc-100 border-zinc-700" };
  }
  if (status === "UNDER_ARBEID" || status === "UNDER_BEHANDLING") {
    return {
      label: "UNDER_BEHANDLING",
      cls: "bg-amber-400 text-zinc-950 border-amber-300",
    };
  }
  if (status === "ARKIVERT" || status === "FERDIG") {
    return {
      label: "FERDIG",
      cls: "bg-emerald-500 text-zinc-950 border-emerald-400",
    };
  }
  return { label: status, cls: "bg-zinc-800 text-zinc-100 border-zinc-700" };
}

export default function InnsendingerPage() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [items, setItems] = useState<VarroaSubmission[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, SignedImage | null>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setIsLoading(true);
    try {
      if (!isOnline) {
        setItems([]);
        setThumbs({});
        setLoadError("Du er offline. Kan ikke hente innsendinger.");
        return;
      }
      if (!supabase) {
        setLoadError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
        return;
      }

      const res = await supabase
        .from("varroa_submissions")
        .select("id,created_at,note,status,images")
        .order("created_at", { ascending: false })
        .limit(200);

      if (res.error) throw res.error;

      const rows = (res.data ?? []) as VarroaSubmission[];
      setItems(rows);

      const firstPaths = rows.flatMap((s) => {
        const p = Array.isArray(s.images) ? s.images[0] : null;
        return typeof p === "string" && p ? [p] : [];
      });

      if (firstPaths.length === 0) {
        setThumbs({});
        return;
      }

      const signedRes = await supabase.storage
        .from("varroa-submissions")
        .createSignedUrls(firstPaths, 60 * 30);

      if (signedRes.error) throw signedRes.error;

      const byPath = new Map<string, string>();
      for (const x of signedRes.data ?? []) {
        if (!x) continue;
        if (typeof x.path !== "string") continue;
        if (typeof x.signedUrl !== "string") continue;
        byPath.set(x.path, x.signedUrl);
      }

      const nextThumbs: Record<string, SignedImage | null> = {};
      for (const s of rows) {
        const p = Array.isArray(s.images) ? s.images[0] : null;
        if (typeof p !== "string" || !p) {
          nextThumbs[s.id] = null;
          continue;
        }
        const url = byPath.get(p) ?? null;
        nextThumbs[s.id] = url ? { path: p, url } : null;
      }
      setThumbs(nextThumbs);
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
      setItems([]);
      setThumbs({});
    } finally {
      setIsLoading(false);
    }
  }, [isOnline, supabase]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-xl">
        <div className="flex items-center justify-between">
          <a
            href={`${basePath}/`}
            className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
          >
            ← Tilbake
          </a>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-zinc-800 flex items-center justify-center">
              <span className="text-sm font-semibold">VS</span>
            </div>
            <div>
              <div className="text-lg font-semibold leading-6">Innsendinger</div>
              <div className="text-xs text-zinc-400">Nyeste først</div>
            </div>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={isLoading || !isOnline}
            className="text-sm font-semibold text-zinc-200 hover:text-zinc-50 disabled:opacity-50"
          >
            Oppdater
          </button>
        </div>

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Kan ikke hente innsendinger.
          </div>
        ) : null}

        {loadError ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-xl">
        {items.length === 0 && !loadError ? (
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5 text-sm text-zinc-400">
            Ingen innsendinger ennå
          </div>
        ) : null}

        <div className="space-y-4">
          {items.map((s) => {
            const ui = getStatusUi(s.status);
            const thumb = thumbs[s.id] ?? null;
            return (
              <a
                key={s.id}
                href={`${basePath}/innsendinger/innsending/?id=${encodeURIComponent(s.id)}`}
                className="block rounded-3xl bg-zinc-900 border border-zinc-800 p-5 hover:bg-zinc-950/60 active:opacity-95"
              >
                <div className="flex items-start gap-4">
                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
                    {thumb ? (
                      <img
                        src={thumb.url}
                        alt="Thumbnail"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-xs text-zinc-500">
                        Ingen bilde
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-zinc-100 truncate">
                        {formatDateTime(s.created_at)}
                      </div>
                      <div
                        className={[
                          "shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold",
                          ui.cls,
                        ].join(" ")}
                      >
                        {ui.label}
                      </div>
                    </div>

                    <div className="mt-2 text-xs text-zinc-500 truncate">
                      ID: {s.id}
                    </div>

                    {s.note ? (
                      <div className="mt-2 text-sm text-zinc-200 whitespace-pre-wrap">
                        {s.note}
                      </div>
                    ) : (
                      <div className="mt-2 text-sm text-zinc-500">
                        Ingen kommentar
                      </div>
                    )}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </main>
    </div>
  );
}

