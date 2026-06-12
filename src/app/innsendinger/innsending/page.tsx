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

export default function InnsendingPage() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);

  const [isAuthed, setIsAuthed] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [item, setItem] = useState<VarroaSubmission | null>(null);
  const [images, setImages] = useState<SignedImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    setIsLoading(true);
    try {
      const id =
        typeof window === "undefined"
          ? null
          : new URLSearchParams(window.location.search).get("id");

      if (!id) {
        setLoadError("Mangler id i URL. Bruk ?id=<uuid>.");
        setItem(null);
        setImages([]);
        return;
      }
      if (!isOnline) {
        setLoadError("Du er offline. Kan ikke hente innsendingen.");
        setItem(null);
        setImages([]);
        return;
      }
      if (!supabase) {
        setLoadError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
        setItem(null);
        setImages([]);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      setIsAuthed(Boolean(session));
      if (!session) {
        setIsAdmin(false);
        setLoadError("Logg inn som admin for å se innsendingen.");
        setItem(null);
        setImages([]);
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
        setLoadError("Kun admin kan se innsendingen.");
        setItem(null);
        setImages([]);
        return;
      }

      const res = await supabase
        .from("varroa_submissions")
        .select("id,created_at,note,status,images")
        .eq("id", id)
        .maybeSingle();

      if (res.error) throw res.error;
      if (!res.data) {
        setLoadError("Fant ikke innsendelsen.");
        setItem(null);
        setImages([]);
        return;
      }

      const loaded = res.data as VarroaSubmission;
      setItem(loaded);

      const imagePaths = Array.isArray(loaded.images) ? loaded.images : [];
      if (imagePaths.length === 0) {
        setImages([]);
        return;
      }

      const signedRes = await supabase.storage
        .from("varroa-submissions")
        .createSignedUrls(imagePaths, 60 * 30);

      if (signedRes.error) throw signedRes.error;

      const signedImages: SignedImage[] = (signedRes.data ?? []).flatMap((x) => {
        if (!x) return [];
        if (typeof x.path !== "string") return [];
        if (typeof x.signedUrl !== "string") return [];
        return [{ path: x.path, url: x.signedUrl }];
      });
      setImages(signedImages);
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
      setItem(null);
      setImages([]);
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

  const ui = item ? getStatusUi(item.status) : null;

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-xl">
        <div className="flex items-center justify-between">
          <a
            href={`${basePath}/innsendinger/`}
            className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
          >
            ← Innsendinger
          </a>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-zinc-800 flex items-center justify-center">
              <span className="text-sm font-semibold">VS</span>
            </div>
            <div>
              <div className="text-lg font-semibold leading-6">Innsending</div>
              <div className="text-xs text-zinc-400">Detaljer</div>
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

        {!isAuthed && loadError === "Logg inn som admin for å se innsendingen." ? (
          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-4 text-sm text-zinc-300">
            <div className="font-semibold text-zinc-100">Admin kreves</div>
            <div className="mt-1">Logg inn via admin for å åpne denne innsendingen.</div>
            <a
              href={`${basePath}/admin/`}
              className="mt-3 inline-flex h-10 items-center justify-center rounded-2xl bg-amber-400 px-4 font-semibold text-zinc-950 active:opacity-90"
            >
              Gå til admin
            </a>
          </div>
        ) : null}

        {isAuthed && !isAdmin && loadError === "Kun admin kan se innsendingen." ? (
          <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-4 text-sm text-zinc-300">
            <div className="font-semibold text-zinc-100">Ingen tilgang</div>
            <div className="mt-1">Denne detaljsiden er kun for VarroaScan-admin.</div>
            <a
              href={`${basePath}/admin/`}
              className="mt-3 inline-flex h-10 items-center justify-center rounded-2xl border border-zinc-700 px-4 font-semibold text-zinc-100 active:opacity-90"
            >
              Til admin
            </a>
          </div>
        ) : null}

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Kan ikke hente innsendingen.
          </div>
        ) : null}

        {loadError ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-xl space-y-4">
        {item ? (
          <>
            <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-100">
                    {formatDateTime(item.created_at)}
                  </div>
                  <div className="mt-2 text-xs text-zinc-500 break-all">
                    ID: {item.id}
                  </div>
                </div>
                {ui ? (
                  <div
                    className={[
                      "shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold",
                      ui.cls,
                    ].join(" ")}
                  >
                    {ui.label}
                  </div>
                ) : null}
              </div>

              <div className="mt-4">
                <div className="text-sm font-semibold text-zinc-200">
                  Kommentar
                </div>
                <div className="mt-2 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-200 whitespace-pre-wrap">
                  {item.note ?? "—"}
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
              <div className="text-sm font-semibold text-zinc-200">Bilder</div>
              {images.length === 0 ? (
                <div className="mt-3 text-sm text-zinc-400">Ingen bilder.</div>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {images.map((img) => (
                    <a
                      key={img.path}
                      href={img.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950"
                    >
                      <img
                        src={img.url}
                        alt="Bilde"
                        className="h-44 w-full object-cover"
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
