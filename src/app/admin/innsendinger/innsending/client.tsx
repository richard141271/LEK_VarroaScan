"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  appendAdminContext,
  getAdminContextSearch,
  getAdminReturnInfo,
} from "@/lib/adminNavigation";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getVarroaAccess, type VarroaAccess } from "@/lib/varroaRoles";
import {
  createSignedImages,
  formatDateTime,
  getHistoryActionLabel,
  getQualityOptions,
  getStatusUi,
  getSubmissionSelect,
  getTypeLabel,
  getWorkflowMigrationMessage,
  isMissingWorkflowSchemaError,
  type SignedImage,
  type VarroaSubmissionHistory,
  type VarroaSubmissionRecord,
  type VarroaSubmissionReview,
} from "@/lib/varroaWorkflow";

type SaveAction =
  | "SAVE_DRAFT"
  | "READY_FOR_REVIEW"
  | "SAVE_AND_NEXT"
  | "APPROVED"
  | "APPROVED_FOR_TRAINING"
  | "RETURNED"
  | "ARCHIVED";

function getActionButtonLabel(action: SaveAction) {
  switch (action) {
    case "SAVE_DRAFT":
      return "Lagre kladd";
    case "READY_FOR_REVIEW":
      return "Klar for kontroll";
    case "SAVE_AND_NEXT":
      return "Lagre og neste";
    case "APPROVED":
      return "Godkjenn";
    case "APPROVED_FOR_TRAINING":
      return "Godkjenn + trening";
    case "RETURNED":
      return "Send tilbake";
    case "ARCHIVED":
      return "Arkiver";
  }
}

export function ProductionSubmissionClient() {
  const isOnline = useOnlineStatus();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const supabase = useMemo(() => getSupabaseClient(), []);
  const adminContextSearch = useMemo(() => {
    if (typeof window === "undefined") return "";
    return getAdminContextSearch(window.location.search);
  }, []);
  const returnInfo = useMemo(() => {
    if (typeof window === "undefined") {
      return { href: null as string | null, label: "← Tilbake" };
    }
    return getAdminReturnInfo(window.location.search);
  }, []);

  const [isAuthed, setIsAuthed] = useState(false);
  const [access, setAccess] = useState<VarroaAccess | null>(null);
  const [item, setItem] = useState<VarroaSubmissionRecord | null>(null);
  const [images, setImages] = useState<SignedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState(0);
  const [reviews, setReviews] = useState<VarroaSubmissionReview[]>([]);
  const [history, setHistory] = useState<VarroaSubmissionHistory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [miteCountInput, setMiteCountInput] = useState("");
  const [imageQuality, setImageQuality] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [trainingReady, setTrainingReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const totalImages = images.length;
  const isLastImage = totalImages === 0 || selectedImage >= totalImages - 1;
  const isController = Boolean(access?.canControl);

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
      const session = sessionData.session;
      setIsAuthed(Boolean(session));
      if (!session) {
        setAccess(null);
        setItem(null);
        setImages([]);
        setLoadError("Logg inn for å åpne arbeidsflaten.");
        return;
      }

      const nextAccess = await getVarroaAccess(supabase, session);
      setAccess(nextAccess);
      if (!nextAccess.role) {
        setItem(null);
        setImages([]);
        setLoadError("Du mangler rolle i VarroaScan-produksjonen.");
        return;
      }

      const [submissionRes, reviewsRes, historyRes] = await Promise.all([
        supabase
          .from("varroa_submissions")
          .select(getSubmissionSelect())
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("varroa_submission_reviews")
          .select(
            "id,submission_id,created_at,updated_at,created_by,mite_count,image_quality,comment,training_ready,approved,current_image_index,image_notes",
          )
          .eq("submission_id", id)
          .order("updated_at", { ascending: false })
          .limit(20),
        supabase
          .from("varroa_submission_history")
          .select("id,submission_id,created_at,user_id,action,from_status,to_status,comment,payload")
          .eq("submission_id", id)
          .order("created_at", { ascending: false })
          .limit(40),
      ]);

      if (submissionRes.error) {
        if (isMissingWorkflowSchemaError(submissionRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw submissionRes.error;
      }
      if (!submissionRes.data) {
        setLoadError("Fant ikke saken.");
        setItem(null);
        setImages([]);
        return;
      }
      if (reviewsRes.error) {
        if (isMissingWorkflowSchemaError(reviewsRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw reviewsRes.error;
      }
      if (historyRes.error) {
        if (isMissingWorkflowSchemaError(historyRes.error)) {
          setLoadError(getWorkflowMigrationMessage());
          return;
        }
        throw historyRes.error;
      }

      const loaded = submissionRes.data as unknown as VarroaSubmissionRecord;
      const loadedReviews =
        (reviewsRes.data ?? []) as unknown as VarroaSubmissionReview[];
      const loadedHistory =
        (historyRes.data ?? []) as unknown as VarroaSubmissionHistory[];
      const signedImages = await createSignedImages(
        supabase,
        Array.isArray(loaded.images) ? loaded.images : [],
      );

      setItem(loaded);
      setReviews(loadedReviews);
      setHistory(loadedHistory);
      setImages(signedImages);

      const ownReview = loadedReviews.find((review) => review.created_by === nextAccess.userId);
      const latestReview = ownReview ?? loadedReviews[0] ?? null;
      const nextImageIndex =
        typeof latestReview?.current_image_index === "number"
          ? latestReview.current_image_index
          : 0;
      setSelectedImage(
        signedImages.length === 0 ? 0 : Math.min(Math.max(nextImageIndex, 0), signedImages.length - 1),
      );
      setMiteCountInput(
        latestReview?.mite_count != null
          ? String(latestReview.mite_count)
          : loaded.manual_mite_count != null
            ? String(loaded.manual_mite_count)
            : "",
      );
      setImageQuality(latestReview?.image_quality ?? loaded.quality_rating ?? "");
      setReviewComment(latestReview?.comment ?? loaded.review_comment ?? "");
      setTrainingReady(Boolean(latestReview?.training_ready ?? loaded.training_ready));
    } catch (e) {
      const message =
        typeof e === "object" && e && "message" in e
          ? String((e as { message?: unknown }).message)
          : "Ukjent feil";
      setLoadError(message);
      setItem(null);
      setImages([]);
      setReviews([]);
      setHistory([]);
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

  const persist = async (action: SaveAction) => {
    setSaveError(null);
    setSaveOk(null);

    if (!supabase) {
      setSaveError("Mangler Supabase-konfig (NEXT_PUBLIC_SUPABASE_*).");
      return;
    }
    if (!isOnline) {
      setSaveError("Du er offline. Kan ikke lagre.");
      return;
    }
    if (!item || !access?.userId || !access.role) {
      setSaveError("Mangler tilgang eller sak.");
      return;
    }

    const miteCount =
      miteCountInput.trim() === "" ? null : Number.parseInt(miteCountInput.trim(), 10);
    if (miteCountInput.trim() !== "" && Number.isNaN(miteCount)) {
      setSaveError("Antall midd må være et helt tall.");
      return;
    }

    const nowIso = new Date().toISOString();
    let nextStatus = item.status;
    let nextTrainingReady = trainingReady;
    let approved = false;
    const historyComment = reviewComment.trim() || null;
    const stayOnCurrentSubmission =
      action === "SAVE_AND_NEXT" && selectedImage < Math.max(images.length - 1, 0);
    const nextImageIndex = stayOnCurrentSubmission
      ? Math.min(selectedImage + 1, Math.max(images.length - 1, 0))
      : selectedImage;

    switch (action) {
      case "SAVE_DRAFT":
        nextStatus = item.status === "NY" ? "UNDER_ARBEID" : item.status;
        break;
      case "READY_FOR_REVIEW":
        nextStatus = "KLAR_FOR_KONTROLL";
        break;
      case "SAVE_AND_NEXT":
        nextStatus =
          access.role === "STUDENT"
            ? stayOnCurrentSubmission
              ? "UNDER_ARBEID"
              : "KLAR_FOR_KONTROLL"
            : item.status;
        break;
      case "APPROVED":
        nextStatus = "GODKJENT";
        approved = true;
        break;
      case "APPROVED_FOR_TRAINING":
        nextStatus = "KLAR_FOR_TRENING";
        nextTrainingReady = true;
        approved = true;
        break;
      case "RETURNED":
        nextStatus = "UNDER_ARBEID";
        break;
      case "ARCHIVED":
        nextStatus = "ARKIVERT";
        approved = item.status === "GODKJENT" || item.status === "KLAR_FOR_TRENING";
        break;
    }

    const updatePatch: Record<string, unknown> = {
      status: nextStatus,
      manual_mite_count: miteCount,
      quality_rating: imageQuality || null,
      review_comment: historyComment,
      training_ready: nextTrainingReady,
      current_role_owner:
        action === "RETURNED" ? "STUDENT" : access.role,
    };

    if (action === "SAVE_DRAFT" || action === "READY_FOR_REVIEW" || action === "SAVE_AND_NEXT") {
      updatePatch.assigned_to = item.assigned_to ?? access.userId;
      updatePatch.assigned_at = item.assigned_at ?? nowIso;
      updatePatch.processed_by = access.userId;
      updatePatch.processed_at = item.processed_at ?? nowIso;
    }

    if (action === "APPROVED" || action === "APPROVED_FOR_TRAINING") {
      updatePatch.approved_by = access.userId;
      updatePatch.approved_at = nowIso;
      updatePatch.returned_by = null;
      updatePatch.returned_at = null;
    }

    if (action === "RETURNED") {
      updatePatch.returned_by = access.userId;
      updatePatch.returned_at = nowIso;
      updatePatch.approved_by = null;
      updatePatch.approved_at = null;
      updatePatch.assigned_to = item.processed_by ?? item.assigned_to;
    }

    if (action === "ARCHIVED") {
      updatePatch.approved_by = item.approved_by ?? access.userId;
      updatePatch.approved_at = item.approved_at ?? nowIso;
    }

    setIsSaving(true);
    try {
      const reviewRes = await supabase.from("varroa_submission_reviews").upsert(
        {
          submission_id: item.id,
          created_by: access.userId,
          mite_count: miteCount,
          image_quality: imageQuality || null,
          comment: historyComment,
          training_ready: nextTrainingReady,
          approved,
          current_image_index: nextImageIndex,
          image_notes: [],
        },
        {
          onConflict: "submission_id,created_by",
        },
      );

      if (reviewRes.error) throw reviewRes.error;

      const updateRes = await supabase
        .from("varroa_submissions")
        .update(updatePatch)
        .eq("id", item.id);
      if (updateRes.error) throw updateRes.error;

      const historyRes = await supabase.from("varroa_submission_history").insert({
        submission_id: item.id,
        user_id: access.userId,
        action,
        from_status: item.status,
        to_status: nextStatus,
        comment: historyComment,
        payload: {
          role: access.role,
          mite_count: miteCount,
          image_quality: imageQuality || null,
          training_ready: nextTrainingReady,
          approved,
          current_image_index: nextImageIndex,
          total_images: images.length,
        },
      });
      if (historyRes.error) throw historyRes.error;

      setSaveOk(`${getActionButtonLabel(action)} lagret.`);

      if (action === "SAVE_AND_NEXT") {
        if (stayOnCurrentSubmission) {
          await reload();
          return;
        }
        if (access.canControl) {
          setSaveOk("Alle bilder er kontrollert. Du kan nå godkjenne saken.");
          await reload();
          return;
        }
        const nextRes = await supabase.rpc("varroa_claim_next_submission");
        if (nextRes.error) throw nextRes.error;
        const nextId = String(nextRes.data ?? "");
        if (nextId) {
          window.location.assign(
            appendAdminContext(
              `${basePath}/admin/innsendinger/innsending/?id=${encodeURIComponent(nextId)}`,
              adminContextSearch,
            ),
          );
          return;
        }
        window.location.assign(
          appendAdminContext(`${basePath}/admin/innsendinger/?view=mine`, adminContextSearch),
        );
        return;
      }

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

  const currentImage = images[selectedImage] ?? null;
  const currentStatusUi = getStatusUi(item?.status ?? "NY");
  const qualityOptions = getQualityOptions();
  const latestReview = reviews[0] ?? null;
  const saveAndNextLabel = isController
    ? isLastImage
      ? "Kontroll fullført"
      : "Neste kontrollbilde"
    : isLastImage
      ? "Lagre og neste sak"
      : "Lagre og neste bilde";

  return (
    <div className="min-h-dvh px-4 pb-10 pt-8">
      <header className="mx-auto w-full max-w-[1500px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">Arbeidsflate</div>
            <div className="text-xs text-zinc-400">
              Stor bildeflate, rask lagring og sporbar historikk.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {returnInfo.href ? (
              <a
                href={returnInfo.href}
                className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
              >
                {returnInfo.label}
              </a>
            ) : null}
            <a
              href={appendAdminContext(`${basePath}/admin/innsendinger/?view=mine`, adminContextSearch)}
              className="text-sm font-semibold text-zinc-200 hover:text-zinc-50"
            >
              Arbeidskø
            </a>
            <button
              type="button"
              onClick={reload}
              disabled={isLoading}
              className="h-10 rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
            >
              Oppdater
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto mt-6 w-full max-w-[1500px] space-y-4">
        {!isAuthed ? (
          <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-300">
            Logg inn via `Admin` for å åpne arbeidsflaten.
          </div>
        ) : null}

        {loadError ? (
          <div className="rounded-3xl border border-red-900/60 bg-red-950/40 px-5 py-4 text-sm text-red-200">
            {loadError}
          </div>
        ) : null}

        {item && access?.role ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_420px]">
            <section className="space-y-4">
              <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-xl font-semibold text-zinc-50">
                      {getTypeLabel(item.type)}
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">
                      Innsendt {formatDateTime(item.created_at)} • ID {item.id}
                    </div>
                  </div>
                  <div
                    className={[
                      "rounded-full border px-4 py-1.5 text-[11px] font-semibold",
                      currentStatusUi.chipClass,
                    ].join(" ")}
                  >
                    {currentStatusUi.label}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-zinc-300 md:grid-cols-2 xl:grid-cols-4">
                  <div>
                    <div className="text-zinc-500">Tildelt</div>
                    <div className="mt-1">{item.assigned_to === access.userId ? "Meg" : item.assigned_to ?? "Ingen"}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Behandlet av</div>
                    <div className="mt-1">{item.processed_by ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Godkjent av</div>
                    <div className="mt-1">{item.approved_by ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500">Oppdatert</div>
                    <div className="mt-1">{formatDateTime(item.updated_at ?? item.created_at)}</div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-200">
                  {item.note || "Ingen kommentar fra innsendingen."}
                </div>
              </div>

              <div className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="text-base font-semibold text-zinc-50">Bilde</div>
                <div className="mt-2 text-sm text-zinc-400">
                  Bilde {Math.min(selectedImage + 1, Math.max(totalImages, 1))} av {Math.max(totalImages, 1)}
                </div>
                <div className="mt-4 overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950">
                  {currentImage ? (
                    <img
                      src={currentImage.url}
                      alt="Varroa-bilde"
                      className="h-[55vh] w-full object-contain xl:h-[70vh]"
                    />
                  ) : (
                    <div className="flex h-[55vh] items-center justify-center text-sm text-zinc-500 xl:h-[70vh]">
                      Ingen bilder tilgjengelig.
                    </div>
                  )}
                </div>

                {images.length > 1 ? (
                  <div className="mt-4 grid grid-cols-4 gap-3 xl:grid-cols-6">
                    {images.map((image, index) => (
                      <div
                        key={image.path}
                        className={[
                          "overflow-hidden rounded-2xl border bg-zinc-950",
                          index === selectedImage
                            ? "border-amber-300 ring-2 ring-amber-300/40"
                            : index < selectedImage
                              ? "border-emerald-700"
                              : "border-zinc-800",
                        ].join(" ")}
                      >
                        <img
                          src={image.url}
                          alt={`Miniatyr ${index + 1}`}
                          className="h-24 w-24 object-cover"
                        />
                        <div className="border-t border-zinc-800 px-2 py-1 text-center text-[10px] font-semibold text-zinc-400">
                          {index < selectedImage
                            ? "Ferdig"
                            : index === selectedImage
                              ? "Nå"
                              : "Neste"}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
              <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="text-base font-semibold text-zinc-50">Arbeidsfelt</div>
                <div className="mt-1 text-sm text-zinc-400">
                  {isController
                    ? "Kontroller bilde for bilde. Godkjenning åpnes først når siste bilde er ferdig."
                    : "Klar for høy fart. Lagre kladd, send til kontroll eller gå rett til neste."}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4">
                  <label className="block">
                    <div className="text-sm font-semibold text-zinc-200">Antall midd</div>
                    <input
                      value={miteCountInput}
                      onChange={(e) => setMiteCountInput(e.target.value)}
                      inputMode="numeric"
                      placeholder="F.eks. 14"
                      className="mt-2 h-12 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    />
                  </label>

                  <label className="block">
                    <div className="text-sm font-semibold text-zinc-200">Bildekvalitet</div>
                    <select
                      value={imageQuality}
                      onChange={(e) => setImageQuality(e.target.value)}
                      className="mt-2 h-12 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 text-sm text-zinc-50 focus:outline-none focus:ring-2 focus:ring-amber-300"
                    >
                      {qualityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <div className="text-sm font-semibold text-zinc-200">Kommentar</div>
                    <textarea
                      value={reviewComment}
                      onChange={(e) => setReviewComment(e.target.value)}
                      rows={5}
                      className="mt-2 w-full rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-sm text-zinc-50 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-300"
                      placeholder="Observasjoner, usikkerhet, kvalitet eller vurdering."
                    />
                  </label>

                  <label className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={trainingReady}
                      onChange={(e) => setTrainingReady(e.target.checked)}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-amber-400 focus:ring-amber-300"
                    />
                    <span className="text-sm font-medium text-zinc-200">Klar for trening</span>
                  </label>
                </div>

                {latestReview ? (
                  <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                    Siste review oppdatert {formatDateTime(latestReview.updated_at)} av{" "}
                    {latestReview.created_by}
                  </div>
                ) : null}

                {saveOk ? (
                  <div className="mt-4 rounded-2xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
                    {saveOk}
                  </div>
                ) : null}
                {saveError ? (
                  <div className="mt-4 rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
                    {saveError}
                  </div>
                ) : null}

                <div className="mt-4 grid grid-cols-1 gap-3">
                  <button
                    type="button"
                    onClick={() => void persist("SAVE_DRAFT")}
                    disabled={isSaving}
                    className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-60"
                  >
                    {isSaving ? "Lagrer…" : getActionButtonLabel("SAVE_DRAFT")}
                  </button>

                  {access.role === "STUDENT" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void persist("READY_FOR_REVIEW")}
                        disabled={isSaving || !isLastImage}
                        className="h-12 rounded-2xl border border-sky-700 bg-sky-950/40 text-sm font-semibold text-sky-100 active:opacity-90 disabled:opacity-40"
                      >
                        {getActionButtonLabel("READY_FOR_REVIEW")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist("SAVE_AND_NEXT")}
                        disabled={isSaving}
                        className="h-12 rounded-2xl bg-amber-400 text-sm font-semibold text-zinc-950 active:opacity-90 disabled:opacity-60"
                      >
                        {saveAndNextLabel}
                      </button>
                      {!isLastImage ? (
                        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                          Fullfør alle bildene i saken. Når siste bilde er lagret, går du
                          automatisk videre til neste sak.
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {access.canControl ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void persist("SAVE_AND_NEXT")}
                        disabled={isSaving || isLastImage}
                        className="h-12 rounded-2xl bg-amber-400 text-sm font-semibold text-zinc-950 active:opacity-90 disabled:opacity-40"
                      >
                        {saveAndNextLabel}
                      </button>
                      {!isLastImage ? (
                        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-3 text-xs text-zinc-400">
                          Gå gjennom alle bildene i saken. Godkjenning låses opp når du er på
                          siste bilde.
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void persist("APPROVED")}
                        disabled={isSaving || !isLastImage}
                        className="h-12 rounded-2xl border border-emerald-700 bg-emerald-950/40 text-sm font-semibold text-emerald-100 active:opacity-90 disabled:opacity-40"
                      >
                        {getActionButtonLabel("APPROVED")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist("APPROVED_FOR_TRAINING")}
                        disabled={isSaving || !isLastImage}
                        className="h-12 rounded-2xl border border-fuchsia-700 bg-fuchsia-950/40 text-sm font-semibold text-fuchsia-100 active:opacity-90 disabled:opacity-40"
                      >
                        {getActionButtonLabel("APPROVED_FOR_TRAINING")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void persist("RETURNED")}
                        disabled={isSaving}
                        className="h-12 rounded-2xl border border-amber-700 bg-amber-950/40 text-sm font-semibold text-amber-100 active:opacity-90 disabled:opacity-60"
                      >
                        {getActionButtonLabel("RETURNED")}
                      </button>
                      {(item.status === "GODKJENT" ||
                        item.status === "KLAR_FOR_TRENING" ||
                        item.status === "ARKIVERT") ? (
                        <button
                          type="button"
                          onClick={() => void persist("ARCHIVED")}
                          disabled={isSaving || !isLastImage}
                          className="h-12 rounded-2xl border border-zinc-700 bg-zinc-950 text-sm font-semibold text-zinc-50 active:opacity-90 disabled:opacity-40"
                        >
                          {getActionButtonLabel("ARCHIVED")}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </section>

              <section className="rounded-3xl border border-zinc-800 bg-zinc-900 p-5">
                <div className="text-base font-semibold text-zinc-50">Historikk</div>
                <div className="mt-4 space-y-3">
                  {history.length === 0 ? (
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4 text-sm text-zinc-400">
                      Ingen historikk ennå.
                    </div>
                  ) : null}
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-zinc-100">
                          {getHistoryActionLabel(entry.action)}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {formatDateTime(entry.created_at)}
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-zinc-500">
                        {entry.from_status ? `${entry.from_status} → ` : ""}
                        {entry.to_status ?? "—"}
                        {entry.user_id ? ` • ${entry.user_id}` : ""}
                      </div>
                      {entry.comment ? (
                        <div className="mt-2 text-sm text-zinc-300">{entry.comment}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        ) : null}
      </main>
    </div>
  );
}
