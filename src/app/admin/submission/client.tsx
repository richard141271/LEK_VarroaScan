"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";

type VarroaSubmission = {
  id: string;
  created_at: string;
  user_id: string | null;
  user_name: string | null;
  type: string;
  note: string | null;
  images: string[];
  source: string | null;
  app_version: string | null;
  device_info: unknown;
  route: string | null;
  status: "NY" | "UNDER_ARBEID" | "ARKIVERT";
  admin_comment: string | null;
};

type SignedImage = { path: string; url: string };

function formatDateTime(value: string) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString("no-NO");
}

export function AdminSubmissionClient() {
  const isOnline = useOnlineStatus();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);

  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [item, setItem] = useState<VarroaSubmission | null>(null);
  const [images, setImages] = useState<SignedImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [status, setStatus] = useState<VarroaSubmission["status"]>("NY");
  const [adminComment, setAdminComment] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    setSaveError(null);
    setSaveOk(null);

    if (!id) {
      setLoadError("Mangler id i URL. Bruk ?id=<uuid>.");
      return;
    }

    if (!supabase) {
      setLoadError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }

    setIsLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        setLoadError("Ikke innlogget.");
        setItem(null);
        setImages([]);
        return;
      }

      const adminRes = await supabase
        .from("varroa_admins")
        .select("user_id")
        .eq("user_id", sessionData.session.user.id)
        .maybeSingle();

      if (!adminRes.data?.user_id) {
        setLoadError("Ingen admin-tilgang.");
        setItem(null);
        setImages([]);
        return;
      }

      const res = await supabase
        .from("varroa_submissions")
        .select(
          "id,created_at,user_id,user_name,type,note,images,source,app_version,device_info,route,status,admin_comment",
        )
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
      setStatus(loaded.status);
      setAdminComment(loaded.admin_comment ?? "");

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
  }, [id, supabase]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(t);
  }, [reload]);

  const save = async () => {
    setSaveError(null);
    setSaveOk(null);

    if (!isOnline) {
      setSaveError("Du er offline. Kan ikke lagre.");
      return;
    }
    if (!supabase) {
      setSaveError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }
    if (!item) {
      setSaveError("Ingenting å lagre.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await supabase
        .from("varroa_submissions")
        .update({
          status,
          admin_comment: adminComment.trim() ? adminComment.trim() : null,
        })
        .eq("id", item.id);

      if (res.error) throw res.error;
      setSaveOk("Lagret.");
      await reload();
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Admin</div>
            <div className="text-xs text-zinc-400">Innsendelse</div>
          </div>
          <div className="flex items-center gap-4">
            <a
              href={`${basePath}/admin/`}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Innboks
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
        <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
          <div className="flex items-center justify-between">
            <div className="text-base font-semibold">Detaljer</div>
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

          {item ? (
            <div className="mt-4 grid grid-cols-1 gap-4">
              <div className="grid grid-cols-1 gap-2 text-sm">
                <div className="text-zinc-200">
                  <span className="text-zinc-400">ID:</span> {item.id}
                </div>
                <div className="text-zinc-200">
                  <span className="text-zinc-400">Tid:</span>{" "}
                  {formatDateTime(item.created_at)}
                </div>
                <div className="text-zinc-200">
                  <span className="text-zinc-400">Type:</span> {item.type}
                </div>
                <div className="text-zinc-200">
                  <span className="text-zinc-400">Bruker:</span>{" "}
                  {item.user_name ?? "—"}{" "}
                  {item.user_id ? `(${item.user_id})` : ""}
                </div>
                <div className="text-zinc-200">
                  <span className="text-zinc-400">Route:</span>{" "}
                  {item.route ?? "—"}
                </div>
                <div className="text-zinc-200">
                  <span className="text-zinc-400">Kilde:</span>{" "}
                  {item.source ?? "—"} <span className="text-zinc-500">•</span>{" "}
                  <span className="text-zinc-400">Versjon:</span>{" "}
                  {item.app_version ?? "—"}
                </div>
              </div>

              {item.note ? (
                <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-200 whitespace-pre-wrap">
                  {item.note}
                </div>
              ) : null}

              {images.length ? (
                <div className="grid grid-cols-2 gap-3">
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
              ) : null}

              <div className="grid grid-cols-1 gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">Status</div>
                  <select
                    value={status}
                    onChange={(e) =>
                      setStatus(e.target.value as VarroaSubmission["status"])
                    }
                    className="mt-2 h-12 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-50 focus:outline-none focus:ring-2 focus:ring-amber-300"
                  >
                    <option value="NY">NY</option>
                    <option value="UNDER_ARBEID">UNDER_ARBEID</option>
                    <option value="ARKIVERT">ARKIVERT</option>
                  </select>
                </div>

                <div>
                  <div className="text-sm font-semibold text-zinc-200">
                    Intern kommentar
                  </div>
                  <textarea
                    value={adminComment}
                    onChange={(e) => setAdminComment(e.target.value)}
                    rows={3}
                    className="mt-2 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    placeholder="Notater til intern behandling…"
                  />
                </div>

                {saveOk ? (
                  <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
                    {saveOk}
                  </div>
                ) : null}
                {saveError ? (
                  <div className="rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                    {saveError}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={save}
                  disabled={isSaving}
                  className="h-12 rounded-2xl bg-amber-400 text-zinc-950 font-semibold active:opacity-90 disabled:opacity-60"
                >
                  {isSaving ? "Lagrer…" : "Lagre"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

