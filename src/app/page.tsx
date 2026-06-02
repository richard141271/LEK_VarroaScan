"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { getAppVersion } from "@/lib/appVersion";
import { getDeviceInfo } from "@/lib/deviceInfo";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";

type SubmissionType = "BUNNBRETT_FOTO" | "KONTROLLFOTO";

const MAX_IMAGES_PER_SUBMISSION = 6;
const MAX_FILE_SIZE_MB = 15;

type LocalImage = {
  id: string;
  file: File;
  previewUrl: string;
};

function formatBytes(bytes: number) {
  const kb = bytes / 1024;
  const mb = kb / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${kb.toFixed(0)} KB`;
}

function normalizeErrorMessage(e: unknown) {
  const raw =
    typeof e === "object" && e && "message" in e
      ? String((e as { message?: unknown }).message)
      : "Ukjent feil";

  const lower = raw.toLowerCase();
  if (
    lower.includes("row-level security") ||
    lower.includes("violates row-level security") ||
    lower.includes("rls")
  ) {
    return `RLS blokkerer innsetting i Supabase. Sjekk at du kjører SQL i samme Supabase-prosjekt som appen peker mot (se supabaseUrl i teknisk info). Kjør både policy-setup og GRANT (schema/table privileges) i dette prosjektet. (${raw})`;
  }

  if (
    e instanceof TypeError ||
    lower.includes("load failed") ||
    lower.includes("failed to fetch")
  ) {
    return `Nettverksfeil mot backend. Sjekk Vercel env (NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY) og at Supabase-migrasjonen er kjørt (bucket/policies). (${raw})`;
  }

  return raw;
}

export default function Home() {
  const pathname = usePathname();
  const isOnline = useOnlineStatus();

  const [submissionType, setSubmissionType] = useState<SubmissionType>(
    "BUNNBRETT_FOTO",
  );
  const [note, setNote] = useState("");
  const [images, setImages] = useState<LocalImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [didSubmit, setDidSubmit] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const [lastTech, setLastTech] = useState<string | null>(null);

  const appVersion = useMemo(() => getAppVersion(), []);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isAdminEnabled = process.env.NEXT_PUBLIC_ENABLE_ADMIN === "true";

  const onPickImages = (files: FileList | null) => {
    setError(null);
    if (!files || files.length === 0) return;

    const currentCount = images.length;
    const remaining = Math.max(0, MAX_IMAGES_PER_SUBMISSION - currentCount);
    const picked = Array.from(files).slice(0, remaining);

    const tooLarge = picked.find(
      (f) => f.size > MAX_FILE_SIZE_MB * 1024 * 1024,
    );
    if (tooLarge) {
      setError(
        `Bildet "${tooLarge.name}" er for stort (${formatBytes(tooLarge.size)}). Maks ${MAX_FILE_SIZE_MB} MB per bilde.`,
      );
      return;
    }

    const next: LocalImage[] = picked.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setImages((prev) => [...prev, ...next]);
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const img = prev.find((p) => p.id === id);
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const resetForm = () => {
    setSubmissionType("BUNNBRETT_FOTO");
    setNote("");
    setError(null);
    setIsSubmitting(false);
    setDidSubmit(false);
    setImages((prev) => {
      for (const img of prev) URL.revokeObjectURL(img.previewUrl);
      return [];
    });
  };

  const onSubmit = async () => {
    setError(null);
    setLastTech(null);

    if (!isOnline) {
      setError("Du er offline. Koble til nett og prøv igjen.");
      return;
    }

    if (images.length === 0) {
      setError("Legg til minst ett bilde.");
      return;
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      setError("Appen mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }

    let step = "Starter";
    setIsSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      const userId = session?.user?.id ?? null;
      const userName =
        (session?.user?.user_metadata?.name as string | undefined) ?? null;

      const submissionId = crypto.randomUUID();
      const uploadedPaths: string[] = [];
      for (const [index, img] of images.entries()) {
        step = `Laster opp bilde ${index + 1}/${images.length}`;
        const ext = img.file.name.split(".").pop()?.toLowerCase();
        const safeExt = ext && ext.length <= 10 ? ext : "jpg";
        const objectPath = `submissions/${submissionId}/${crypto.randomUUID()}.${safeExt}`;

        const uploadRes = await supabase.storage
          .from("varroa-submissions")
          .upload(objectPath, img.file, {
            cacheControl: "3600",
            upsert: false,
            contentType: img.file.type || undefined,
          });

        if (uploadRes.error) throw uploadRes.error;
        uploadedPaths.push(objectPath);
      }

      step = "Oppretter innsending";
      const insertRes = await supabase
        .from("varroa_submissions")
        .insert({
          id: submissionId,
          user_id: userId,
          user_name: userName,
          type: submissionType,
          images: uploadedPaths,
          note: note.trim() ? note.trim() : null,
          source: "web",
          app_version: appVersion,
          device_info: getDeviceInfo(),
          route: pathname,
          status: "NY",
        });
      if (insertRes.error) throw insertRes.error;

      setDidSubmit(true);
      setImages((prev) => {
        for (const img of prev) URL.revokeObjectURL(img.previewUrl);
        return [];
      });
      setNote("");
    } catch (e) {
      const friendly = normalizeErrorMessage(e);
      setLastTech(`${step}: ${friendly}`);
      setError(`Kunne ikke sende inn (${step}): ${friendly}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (didSubmit) {
    return (
      <div className="flex flex-col min-h-dvh px-4 pb-10 pt-8">
        <header className="mx-auto w-full max-w-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-2xl bg-zinc-800 flex items-center justify-center">
                <span className="text-sm font-semibold">VS</span>
              </div>
              <div>
                <div className="text-lg font-semibold leading-6">
                  LEK-VarroaScan
                </div>
                <div className="text-xs text-zinc-400">v{appVersion}</div>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto mt-10 w-full max-w-xl">
          <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-6">
            <div className="text-2xl font-semibold">Takk!</div>
            <div className="mt-2 text-zinc-300">
              Innsendingen er mottatt. Vil du sende inn flere?
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3">
              <button
                type="button"
                onClick={resetForm}
                className="h-12 rounded-2xl bg-amber-400 text-zinc-950 font-semibold active:opacity-90 disabled:opacity-60"
              >
                Send flere
              </button>
              <a
                href={`${basePath}/admin/`}
                className="h-12 rounded-2xl border border-zinc-700 text-zinc-100 font-semibold flex items-center justify-center active:opacity-90"
                style={{ display: isAdminEnabled ? undefined : "none" }}
              >
                Admin
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-zinc-800 flex items-center justify-center">
              <span className="text-sm font-semibold">VS</span>
            </div>
            <div>
              <div className="text-lg font-semibold leading-6">
                LEK-VarroaScan
              </div>
              <div className="text-xs text-zinc-400">v{appVersion}</div>
            </div>
          </div>
          <a
            href={`${basePath}/admin/`}
            className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            style={{ display: isAdminEnabled ? undefined : "none" }}
          >
            Admin
          </a>
        </div>

        {!isOnline ? (
          <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            Du er offline. Opplasting krever nett.
          </div>
        ) : null}
      </header>

      <main className="mx-auto mt-6 w-full max-w-xl">
        <div className="rounded-3xl bg-zinc-900 border border-zinc-800 p-5">
          <div className="text-base font-semibold">
            Send inn bunnbrett-bilder (MVP)
          </div>
          <div className="mt-1 text-sm text-zinc-400">
            Raskt, enkelt og robust. Snakk med utviklerne hvis noe føles rart.
          </div>

          <div className="mt-6 space-y-5">
            <div>
              <div className="text-sm font-semibold text-zinc-200">Type</div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSubmissionType("BUNNBRETT_FOTO")}
                  className={[
                    "h-12 rounded-2xl border text-sm font-semibold",
                    submissionType === "BUNNBRETT_FOTO"
                      ? "border-amber-300 bg-amber-400 text-zinc-950"
                      : "border-zinc-700 bg-zinc-950 text-zinc-100",
                  ].join(" ")}
                >
                  Bunnbrett foto
                </button>
                <button
                  type="button"
                  onClick={() => setSubmissionType("KONTROLLFOTO")}
                  className={[
                    "h-12 rounded-2xl border text-sm font-semibold",
                    submissionType === "KONTROLLFOTO"
                      ? "border-amber-300 bg-amber-400 text-zinc-950"
                      : "border-zinc-700 bg-zinc-950 text-zinc-100",
                  ].join(" ")}
                >
                  Kontrollfoto
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-200">Bilder</div>
                <div className="text-xs text-zinc-400">
                  {images.length}/{MAX_IMAGES_PER_SUBMISSION}
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-3">
                {images.map((img) => (
                  <div
                    key={img.id}
                    className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950"
                  >
                    <img
                      src={img.previewUrl}
                      alt="Valgt bilde"
                      className="h-40 w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(img.id)}
                      className="absolute right-2 top-2 h-9 w-9 rounded-full bg-black/60 text-white text-sm font-semibold active:opacity-80"
                    >
                      ×
                    </button>
                  </div>
                ))}

                {images.length < MAX_IMAGES_PER_SUBMISSION ? (
                  <label className="h-40 rounded-2xl border border-dashed border-zinc-700 bg-zinc-950 flex items-center justify-center text-sm font-semibold text-zinc-200 active:opacity-90">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      capture="environment"
                      className="hidden"
                      onChange={(e) => onPickImages(e.target.files)}
                    />
                    + Legg til
                  </label>
                ) : null}
              </div>

              <div className="mt-2 text-xs text-zinc-500">
                Maks {MAX_IMAGES_PER_SUBMISSION} bilder per innsending. Maks{" "}
                {MAX_FILE_SIZE_MB} MB per bilde.
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold text-zinc-200">
                Kommentar (valgfritt)
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className="mt-2 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                placeholder="F.eks. bigård, dato, behandling, noe spesielt…"
              />
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setShowTech((v) => !v)}
              className="text-left text-xs text-zinc-400 hover:text-zinc-200"
            >
              {showTech ? "Skjul teknisk info" : "Vis teknisk info"}
            </button>

            {showTech ? (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-300">
                <div>route: {pathname}</div>
                <div>appVersion: {appVersion}</div>
                <div>online: {String(isOnline)}</div>
                <div>
                  supabaseUrl:{" "}
                  {supabaseUrl
                    ? (() => {
                        try {
                          const u = new URL(supabaseUrl);
                          return u.origin;
                        } catch {
                          return supabaseUrl;
                        }
                      })()
                    : "Mangler"}
                </div>
                {lastTech ? <div>feil: {lastTech}</div> : null}
              </div>
            ) : null}

            <button
              type="button"
              disabled={isSubmitting}
              onClick={onSubmit}
              className="h-12 w-full rounded-2xl bg-amber-400 text-zinc-950 font-semibold active:opacity-90 disabled:opacity-60"
            >
              {isSubmitting ? "Sender…" : "Send inn"}
            </button>

            <div className="text-xs text-zinc-500">
              Metadata sendes automatisk: tidspunkt, route, device, appversjon,
              bruker (hvis innlogget).
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
