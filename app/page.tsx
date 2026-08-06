"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { supabase, supabaseConfigured } from "./lib/supabase";
import { allocateExpenseTotals } from "./lib/allocation";

type Person = { id: string; name: string; color: string };
type SavedGroupMember = Person & { phone: string; venmoUsername: string; selected?: boolean };
type Expense = { id: string; name: string; cents: number; consumers: string[]; addedBy?: string; addedByName?: string; splitEqually?: boolean; quantities?: Record<string, number> };
type ParticipantAdjustment = { taxEnabled: boolean; taxRate: number; tipEnabled: boolean; tipMode: "percent" | "amount"; tipValue: number; discountCents: number; discountTiming: "before" | "after" };
type RestaurantRef = { id: string; name: string; locationName: string; address: string; city: string; region: string; postalCode: string };
type RegisteredRestaurant = RestaurantRef & { phone: string; publicCode: string; active: boolean };
type RestaurantForm = { name: string; locationName: string; address: string; city: string; region: string; postalCode: string; phone: string };
type Draft = {
  flowVersion?: 5;
  cloudId?: string;
  title: string; dateTime: string; people: Person[]; expenses: Expense[];
  taxEnabled: boolean; taxRate: number; tipEnabled: boolean; tipMode: "percent" | "amount"; tipValue: number;
  discountEnabled: boolean; discountCents: number; discountTiming: "before" | "after"; participantAdjustments: Record<string, ParticipantAdjustment>; totalOverrideCents: number; payments: Record<string, number>; noRepayment: Record<string, boolean>; canPayMerchant: Record<string, boolean>; settlementPreferences: Record<string, string[]>; venmoUsernames: Record<string, string>; theme: "dark" | "light"; step: 1 | 2 | 3 | 4 | 5;
  restaurant?: RestaurantRef;
};
type CloudBill = { id: string; title: string; occurred_at: string; status: "open" | "locked" | "archived"; updated_at: string; settings: { draft?: Draft } };
type SavedGroup = { id: string; name: string; people: SavedGroupMember[] };
type SavedContact = { id: string; name: string; phone: string; venmoUsername: string };
type PayPalAccount = { merchant_id: string | null; status: string; payments_receivable: boolean; email_confirmed: boolean; environment: string; updated_at: string };
type AppConfirm =
  | { type: "save-local" }
  | { type: "delete-group"; id: string }
  | { type: "rename-bill"; id: string; value: string }
  | { type: "delete-bill"; id: string }
  | { type: "remove-duplicates"; ids: string[] };

const COLORS = ["#ffb86b", "#7dd3fc", "#c4b5fd", "#f9a8d4", "#fde047", "#fb7185", "#93c5fd", "#fdba74"];
const APP_VERSION = "0.1.30";
const STORAGE_KEY = "bill-splitter-stage-two";
const PREF_KEY = "bill-splitter-preferences";
const SHARE_AFTER_SIGN_IN_KEY = "bill-splitter-share-after-sign-in";
const uid = () => Math.random().toString(36).slice(2, 10);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const signedMoney = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const toCents = (value: string) => Math.max(0, Math.round((Number(value) || 0) * 100));
const capitalizeName = (value: string) => value.trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase());
const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const initialDraft: Draft = {
  flowVersion: 5, title: "", dateTime: localNow(), people: [], expenses: [], taxEnabled: false, taxRate: 0,
  tipEnabled: false, tipMode: "percent", tipValue: 0, discountEnabled: false, discountCents: 0, discountTiming: "before", participantAdjustments: {}, totalOverrideCents: 0, payments: {}, noRepayment: {}, canPayMerchant: {}, settlementPreferences: {}, venmoUsernames: {}, theme: "dark", step: 1,
};
const normalizeDraft = (value: Partial<Draft>): Draft => {
  const legacyStep = value.step || 1;
  const step = value.flowVersion === 5 ? legacyStep : value.flowVersion === 4 ? Math.min(5, legacyStep + 1) : legacyStep === 2 ? 4 : legacyStep === 3 ? 5 : 2;
  const people = (value.people || []).map((person, index) => ({ ...person, color: ["#86efac", "#65d69a"].includes(person.color.toLowerCase()) ? COLORS[index % COLORS.length] : person.color }));
  const expenses = (value.expenses || []).map((item) => ({ ...item, splitEqually: false, quantities: Object.fromEntries(item.consumers.map((id) => [id, Math.max(1, item.quantities?.[id] || 1)])) }));
  return { ...initialDraft, ...value, people, expenses, discountEnabled: value.discountEnabled ?? Boolean(value.discountCents), flowVersion: 5, step } as Draft;
};
const emptyRestaurantForm: RestaurantForm = { name: "", locationName: "", address: "", city: "", region: "", postalCode: "", phone: "" };

function allocateWeighted(total: number, ids: string[], quantities: Record<string, number>, rotation = 0) {
  const out: Record<string, number> = {};
  const weights = ids.map((id) => Math.max(1, Math.floor(quantities[id] || 1)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!ids.length || total <= 0 || !totalWeight) return out;
  ids.forEach((id, index) => { out[id] = Math.floor(total * weights[index] / totalWeight); });
  let remainder = total - Object.values(out).reduce((sum, cents) => sum + cents, 0);
  const normalizedRotation = ((rotation % ids.length) + ids.length) % ids.length;
  const order = ids.map((id, index) => ({
    id,
    fraction: (total * weights[index]) % totalWeight,
    rotatedIndex: (index - normalizedRotation + ids.length) % ids.length,
  })).sort((a, b) => b.fraction - a.fraction || a.rotatedIndex - b.rotatedIndex);
  for (let index = 0; remainder > 0; index++, remainder--) out[order[index % order.length].id]++;
  return out;
}

function displayDate(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function savedDraftTotal(value?: Draft) {
  if (!value) return 0;
  const draft = normalizeDraft(value);
  const owners = [...new Set(draft.expenses.map((item) => item.addedBy || "organizer"))];
  const shared = Object.keys(draft.participantAdjustments).length > 0;
  let calculated = 0;
  if (shared) {
    owners.forEach((owner) => {
      const raw = draft.expenses.filter((item) => (item.addedBy || "organizer") === owner).reduce((sum, item) => sum + item.cents, 0);
      const adjustment = draft.participantAdjustments[owner] || { taxEnabled: false, taxRate: 0, tipEnabled: false, tipMode: "percent" as const, tipValue: 0, discountCents: 0, discountTiming: "before" as const };
      const discount = Math.min(adjustment.discountCents, raw);
      const base = adjustment.discountTiming === "before" ? raw - discount : raw;
      const tax = adjustment.taxEnabled ? Math.round(base * adjustment.taxRate / 100) : 0;
      const tip = !adjustment.tipEnabled ? 0 : adjustment.tipMode === "amount" ? adjustment.tipValue : Math.round(base * adjustment.tipValue / 100);
      calculated += Math.max(0, base + tax + tip - (adjustment.discountTiming === "after" ? discount : 0));
    });
  } else {
    const subtotal = draft.expenses.reduce((sum, item) => sum + item.cents, 0);
    const discount = draft.discountEnabled ? Math.min(draft.discountCents, subtotal) : 0;
    const base = draft.discountTiming === "before" ? subtotal - discount : subtotal;
    const tax = draft.taxEnabled ? Math.round(base * draft.taxRate / 100) : 0;
    const tip = !draft.tipEnabled ? 0 : draft.tipMode === "amount" ? draft.tipValue : Math.round(base * draft.tipValue / 100);
    calculated = Math.max(0, base + tax + tip - (draft.discountTiming === "after" ? discount : 0));
  }
  return Math.max(calculated, draft.totalOverrideCents || 0);
}

function billFingerprint(bill: CloudBill) {
  const draft = bill.settings?.draft;
  if (!draft) return bill.id;
  const { cloudId: _cloudId, theme: _theme, step: _step, ...content } = draft;
  return JSON.stringify({ title: bill.title || "", occurred_at: bill.occurred_at, content });
}

function DecimalInput({ value, onValueChange, placeholder = "0", className }: { value: number; onValueChange: (value: number) => void; placeholder?: string; className?: string }) {
  const [text, setText] = useState(value ? String(value) : "");
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(value ? String(value) : "");
  }, [value]);

  return <input
    className={className}
    inputMode="decimal"
    value={text}
    placeholder={placeholder}
    onFocus={() => { focused.current = true; }}
    onChange={(event) => {
      const next = event.target.value;
      if (!/^\d*(?:\.\d{0,2})?$/.test(next)) return;
      setText(next);
      onValueChange(next === "" ? 0 : Number(next));
    }}
    onBlur={() => {
      focused.current = false;
      setText(value ? String(value) : "");
    }}
  />;
}

export default function Home() {
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [ready, setReady] = useState(false);
  const [personName, setPersonName] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemAmount, setItemAmount] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanLines, setScanLines] = useState<{ name: string; cents: number; selected: boolean }[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [preferencePersonId, setPreferencePersonId] = useState("");
  const [itemsPersonId, setItemsPersonId] = useState("");
  const [sharing, setSharing] = useState(false);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [resultsQrCode, setResultsQrCode] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [paypalAccount, setPaypalAccount] = useState<PayPalAccount | null>(null);
  const [paypalBusy, setPaypalBusy] = useState(false);
  const [paypalMessage, setPaypalMessage] = useState("");
  const [restaurantOpen, setRestaurantOpen] = useState(false);
  const [restaurantBusy, setRestaurantBusy] = useState(false);
  const [restaurantForm, setRestaurantForm] = useState<RestaurantForm>(emptyRestaurantForm);
  const [ownRestaurant, setOwnRestaurant] = useState<RegisteredRestaurant | null>(null);
  const [restaurantQrCode, setRestaurantQrCode] = useState("");
  const [pendingRestaurant, setPendingRestaurant] = useState<(RestaurantRef & { paypalConnected: boolean }) | null>(null);
  const [cloudBillId, setCloudBillId] = useState("");
  const [cloudReady, setCloudReady] = useState(false);
  const [pendingCloudDraft, setPendingCloudDraft] = useState<Draft | null>(null);
  const [saveStatus, setSaveStatus] = useState<"local" | "saving" | "saved" | "offline">("local");
  const [cloudError, setCloudError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBills, setHistoryBills] = useState<CloudBill[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyDateFilter, setHistoryDateFilter] = useState<"all" | "today" | "week" | "month" | "custom">("all");
  const [historyCustomDate, setHistoryCustomDate] = useState("");
  const [historyPreviewBill, setHistoryPreviewBill] = useState<CloudBill | null>(null);
  const [savedGroups, setSavedGroups] = useState<SavedGroup[]>([]);
  const [savedContacts, setSavedContacts] = useState<SavedContact[]>([]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<SavedGroup | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [currentPhones, setCurrentPhones] = useState<Record<string, string>>({});
  const [cloudShareToken, setCloudShareToken] = useState("");
  const [organizerShareToken, setOrganizerShareToken] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestParticipantId, setGuestParticipantId] = useState("");
  const [sharedLoaded, setSharedLoaded] = useState(false);
  const [claimedNames, setClaimedNames] = useState<string[]>([]);
  const [confirmAction, setConfirmAction] = useState<"clear" | "finish" | null>(null);
  const [appConfirm, setAppConfirm] = useState<AppConfirm | null>(null);
  const [appConfirmBusy, setAppConfirmBusy] = useState(false);
  const applyingRemote = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraft = useRef(draft);
  const pendingLocalChange = useRef(false);
  const lastOwnSaveAt = useRef(0);
  const initializedPayments = useRef(new Set<string>());
  const guestSavePending = useRef(false);
  const guestSaveStartedAt = useRef(0);
  const guestSaveVersion = useRef(0);
  const skipGuestDraftSave = useRef(false);
  const guestAtomicUntil = useRef(0);
  const billIdentityRef = useRef("");
  const sharingResultsAuth = useRef(false);

  function getBillIdentity() {
    const id = draft.cloudId || billIdentityRef.current || crypto.randomUUID();
    billIdentityRef.current = id;
    if (draft.cloudId !== id) setDraft((current) => ({ ...current, cloudId: id }));
    return id;
  }

  useEffect(() => {
    if (!supabase || !userId) return;
    void loadSavedGroups();
    void loadSavedContacts();
    void loadPayPalStatus();
    void loadOwnRestaurant();
  }, [userId]);

  useEffect(() => {
    if (!ownRestaurant?.publicCode) { setRestaurantQrCode(""); return; }
    const link = `${window.location.origin}/?restaurant=${ownRestaurant.publicCode}`;
    QRCode.toDataURL(link, { width: 300, margin: 2, color: { dark: "#10261d", light: "#ffffff" } }).then(setRestaurantQrCode).catch(() => setRestaurantQrCode(""));
  }, [ownRestaurant?.publicCode]);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("paypal");
    if (!result) return;
    setPaypalMessage(result === "connected" ? "PayPal connected successfully." : result === "attention" ? "PayPal needs one more step. Open PayPal setup again to finish." : "PayPal could not be connected.");
    const url = new URL(window.location.href);
    url.searchParams.delete("paypal");
    window.history.replaceState({}, "", url);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const restaurantCode = params.get("restaurant");
    if (restaurantCode && supabase) void loadRestaurantCode(restaurantCode);
    const permanentToken = params.get("share");
    if (permanentToken && supabase) {
      const resultsView = params.get("results") === "1";
      const rememberedGuest = localStorage.getItem(`bill-guest-${permanentToken}`);
      if (rememberedGuest && !resultsView) { const guest = JSON.parse(rememberedGuest) as { participant_id: string; name: string }; setGuestParticipantId(guest.participant_id); setGuestName(guest.name); }
      setCloudShareToken(permanentToken); setSharingEnabled(false); setShareLink(window.location.href);
      void (async () => {
        try {
          if (resultsView && rememberedGuest) {
            const guest = JSON.parse(rememberedGuest) as { participant_id?: string; edit_token?: string };
            if (guest.participant_id && guest.edit_token) await supabase.rpc("release_bill_participant", { p_token: permanentToken, p_participant_id: guest.participant_id, p_edit_token: guest.edit_token });
            localStorage.removeItem(`bill-guest-${permanentToken}`);
            setGuestParticipantId(""); setGuestName("");
          }
          const { data, error: shareError } = await supabase.rpc("open_shared_bill", { p_token: permanentToken });
          const shared = (data as { bill_id?: string; settings?: { draft?: Draft }; claimed_names?: string[] }[] | null)?.[0];
          if (shareError || !shared?.settings?.draft) throw new Error(shareError?.message || "This sharing link is invalid or closed.");
          setDraft({ ...normalizeDraft(shared.settings.draft), cloudId: shared.bill_id || shared.settings.draft.cloudId, step: resultsView ? 5 : 3 });
          setClaimedNames(shared.claimed_names || []);
          setAdvanced(false); setSharedLoaded(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not open this shared bill.");
        } finally { setReady(true); }
      })();
      return;
    }
    const sharedId = params.get("bill");
    if (sharedId) {
      setNotice("This old sharing link is no longer available. Please ask the organizer for a new private link.");
      setReady(true);
      return;
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) { const restored=normalizeDraft(JSON.parse(saved) as Draft); const cloudId=restored.cloudId||crypto.randomUUID(); billIdentityRef.current=cloudId; setDraft({...restored,cloudId}); }
      else {
        const prefs = localStorage.getItem(PREF_KEY);
        const cloudId=crypto.randomUUID(); billIdentityRef.current=cloudId;
        setDraft((d) => ({ ...d, ...(prefs?JSON.parse(prefs):{}), cloudId }));
      }
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => { if (ready) localStorage.setItem(STORAGE_KEY, JSON.stringify(draft)); }, [draft, ready]);
  useEffect(() => {
    if (ready) localStorage.setItem(PREF_KEY, JSON.stringify({ taxRate: draft.taxRate, tipMode: draft.tipMode, tipValue: draft.tipValue }));
  }, [draft.taxRate, draft.tipMode, draft.tipValue, ready]);
  useEffect(() => {
    if (!shareLink) { setQrCode(""); return; }
    QRCode.toDataURL(shareLink, { width: 260, margin: 2, color: { dark: "#10261d", light: "#ffffff" } }).then(setQrCode).catch(() => setQrCode(""));
  }, [shareLink]);
  useEffect(() => {
    if (!cloudBillId || guestParticipantId) return;
    const key = `bill-share-token-${cloudBillId}`;
    const rememberedToken = localStorage.getItem(key);
    setOrganizerShareToken(rememberedToken || "");
    setShareLink(rememberedToken ? `${window.location.origin}/?share=${rememberedToken}` : "");
  }, [cloudBillId, guestParticipantId]);
  useEffect(() => {
    latestDraft.current = draft;
    if (cloudReady && userId && !applyingRemote.current) pendingLocalChange.current = true;
  }, [draft, cloudReady, userId]);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => { setUserEmail(data.user?.email || ""); setUserId(data.user?.id || ""); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { setUserEmail(session?.user.email || ""); setUserId(session?.user.id || ""); });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    setCloudReady(false);
    if (!supabase || !userId || !ready) { setCloudBillId(""); setSaveStatus("local"); return; }
    let cancelled = false;
    (async () => {
      await supabase.from("profiles").upsert({ id: userId, display_name: userEmail.split("@")[0] || null });
      if (localStorage.getItem(SHARE_AFTER_SIGN_IN_KEY) === "1") {
        setSharing(true); setSharingEnabled(true); setSaveStatus("saving");
        const billId=getBillIdentity(); const identifiedDraft={...draft,cloudId:billId};
        const { data: created, error: createError } = await supabase.from("bills").upsert({ id: billId, owner_id: userId, restaurant_id: draft.restaurant?.id || null, title: draft.title, occurred_at: new Date(draft.dateTime).toISOString(), settings: { draft: identifiedDraft } }, { onConflict: "id" }).select("id").single();
        if (cancelled) return;
        if (createError || !created) { setCloudError(createError?.message || "Could not save this bill for sharing."); setSaveStatus("offline"); setSharing(false); setCloudReady(true); return; }
        const { data: token, error: shareError } = await supabase.rpc("create_bill_share", { p_bill_id: created.id });
        if (shareError || !token) { setCloudError(shareError?.message || "Could not create the private sharing link."); setSaveStatus("offline"); setSharing(false); setCloudReady(true); return; }
        const link = `${window.location.origin}/?share=${token}`;
        setCloudBillId(created.id); setOrganizerShareToken(token as string); setShareLink(link); setSharedLoaded(true); setAdvanced(false); setSaveStatus("saved"); setSharing(false); setAccountOpen(false); setCloudReady(true); setNotice("");
        window.history.replaceState({}, "", window.location.pathname);
        localStorage.setItem(`cloud-bill-${userId}`, created.id); localStorage.setItem(`bill-share-token-${created.id}`, token as string); localStorage.removeItem(SHARE_AFTER_SIGN_IN_KEY);
        await navigator.clipboard?.writeText(link);
        return;
      }
      const remembered = localStorage.getItem(`cloud-bill-${userId}`);
      const { data, error: loadError } = remembered
        ? await supabase.from("bills").select("id,settings,updated_at").eq("id", remembered).neq("status", "archived").limit(1)
        : { data: [], error: null };
      if (cancelled) return;
      if (loadError) { setCloudError(loadError.message); setSaveStatus("offline"); setCloudReady(true); return; }
      const cloud = data?.[0] as { id: string; settings?: { draft?: Draft } } | undefined;
      if (cloud) {
        setCloudBillId(cloud.id); localStorage.setItem(`cloud-bill-${userId}`, cloud.id);
        if (cloud.settings?.draft) {
          const cloudDraft = { ...normalizeDraft(cloud.settings.draft), cloudId: cloud.id };
          const localHasWork = Boolean(draft.title || draft.people.length || draft.expenses.length);
          const sameBill = draft.cloudId === cloud.id;
          if (sameBill || !localHasWork) {
            applyingRemote.current = true;
            billIdentityRef.current = cloud.id;
            setDraft(cloudDraft);
            setPendingCloudDraft(null);
            setSaveStatus("saved");
            setCloudReady(true);
            setTimeout(() => { applyingRemote.current = false; }, 0);
            return;
          }
          setPendingCloudDraft(cloudDraft); setSaveStatus("saved"); return;
        }
        setSaveStatus("saved");
      } else if (draft.title || draft.people.length || draft.expenses.length) {
        if (sharingResultsAuth.current) { setCloudReady(true); return; }
        setAppConfirm({ type: "save-local" });
        return;
      }
      setCloudReady(true);
    })();
    return () => { cancelled = true; };
  }, [userId, ready]);
  useEffect(() => {
    if (!supabase || !userId || !ready || !cloudReady || (cloudShareToken && guestParticipantId) || applyingRemote.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (!cloudBillId && !(draft.title || draft.people.length || draft.expenses.length)) return;
    setSaveStatus("saving");
    saveTimer.current = setTimeout(async () => {
      if (!supabase) return;
      if (!cloudBillId) {
        const billId=getBillIdentity(); const identifiedDraft={...draft,cloudId:billId};
        const { data: created, error: createError } = await supabase.from("bills").upsert({ id: billId, owner_id: userId, restaurant_id: draft.restaurant?.id || null, title: draft.title, occurred_at: new Date(draft.dateTime).toISOString(), settings: { draft: identifiedDraft } }, { onConflict: "id" }).select("id").single();
        if (createError || !created) { setCloudError(createError?.message || "Could not create the cloud bill."); setSaveStatus("offline"); return; }
        setCloudBillId(created.id); localStorage.setItem(`cloud-bill-${userId}`, created.id); pendingLocalChange.current = false; lastOwnSaveAt.current = Date.now(); setSaveStatus("saved"); return;
      }
      const { error: saveError } = await supabase.from("bills").update({ restaurant_id: draft.restaurant?.id || null, title: draft.title, occurred_at: new Date(draft.dateTime).toISOString(), settings: { draft }, updated_at: new Date().toISOString() }).eq("id", cloudBillId);
      setCloudError(saveError?.message || "");
      if (!saveError) { pendingLocalChange.current = false; lastOwnSaveAt.current = Date.now(); }
      setSaveStatus(saveError ? "offline" : "saved");
    }, 700);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [draft, userId, cloudBillId, ready, cloudReady, cloudShareToken, guestParticipantId]);
  useEffect(() => {
    if (!supabase || !cloudBillId || (cloudShareToken && guestParticipantId)) return;
    const channel = supabase.channel(`bill-${cloudBillId}`).on("postgres_changes", { event: "UPDATE", schema: "public", table: "bills", filter: `id=eq.${cloudBillId}` }, (payload) => {
      const incoming = (payload.new as { settings?: { draft?: Draft }; updated_at?: string }).settings?.draft;
      if (!incoming || pendingLocalChange.current || Date.now() - lastOwnSaveAt.current < 1500 || JSON.stringify(incoming) === JSON.stringify(latestDraft.current)) return;
      applyingRemote.current = true; setDraft(normalizeDraft(incoming)); setSaveStatus("saved"); setTimeout(() => { applyingRemote.current = false; }, 0);
    }).subscribe();
    return () => { supabase?.removeChannel(channel); };
  }, [cloudBillId, cloudShareToken, guestParticipantId]);
  useEffect(() => {
    if (!supabase || !cloudShareToken || !guestParticipantId || !ready || !sharedLoaded || applyingRemote.current) return;
    if (skipGuestDraftSave.current) { skipGuestDraftSave.current = false; return; }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const saveVersion = ++guestSaveVersion.current;
    guestSavePending.current = true;
    guestSaveStartedAt.current = Date.now();
    setSaveStatus("saving");
    saveTimer.current = setTimeout(async () => {
      const savedGuest = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
      if (!savedGuest.edit_token) { guestSavePending.current = false; setCloudError("Your participant access has expired."); setSaveStatus("offline"); return; }
      const adjustment: ParticipantAdjustment = { taxEnabled: draft.taxEnabled, taxRate: draft.taxRate, tipEnabled: draft.tipEnabled, tipMode: draft.tipMode, tipValue: draft.tipValue, discountCents: draft.discountEnabled ? draft.discountCents : 0, discountTiming: draft.discountTiming };
      const participantDraft = { ...draft, participantAdjustments: { ...draft.participantAdjustments, [guestParticipantId]: adjustment } };
      const { data, error: guestError } = await supabase!.rpc("save_participant_draft", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: savedGuest.edit_token, p_draft: participantDraft });
      if (saveVersion !== guestSaveVersion.current) return;
      setCloudError(guestError?.message || ""); setSaveStatus(guestError ? "offline" : "saved");
      if (data) {
        const canonical = data as Draft;
        latestDraft.current = { ...initialDraft, ...canonical, step: draft.step };
        applyingRemote.current = true;
        setDraft((current) => ({ ...current, expenses: canonical.expenses || current.expenses, participantAdjustments: canonical.participantAdjustments || current.participantAdjustments, payments: canonical.payments || current.payments, noRepayment: canonical.noRepayment || current.noRepayment, canPayMerchant: canonical.canPayMerchant || current.canPayMerchant, settlementPreferences: canonical.settlementPreferences || current.settlementPreferences, venmoUsernames: canonical.venmoUsernames || current.venmoUsernames }));
        setTimeout(() => { applyingRemote.current = false; }, 0);
      }
      guestSavePending.current = false;
    }, 700);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [draft, cloudShareToken, guestParticipantId, ready, sharedLoaded]);
  useEffect(() => {
    if (!supabase || !cloudShareToken || !guestParticipantId) return;
    const timer = setInterval(async () => {
      const savedGuest = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
      if (savedGuest.edit_token) await supabase!.rpc("heartbeat_bill_participant", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: savedGuest.edit_token });
      const { data, error: refreshError } = await supabase!.rpc("open_shared_bill", { p_token: cloudShareToken });
      if (refreshError) { setCloudError(refreshError.message); setSaveStatus("offline"); return; }
      setCloudError(""); setSaveStatus("saved");
      const row = (data as { settings?: { draft?: Draft }; claimed_names?: string[] }[] | null)?.[0];
      const incoming = row?.settings?.draft;
      setClaimedNames(row?.claimed_names || []);
      if (!incoming) return;
      if (Date.now() < guestAtomicUntil.current) return;
      if (guestSavePending.current && Date.now() - guestSaveStartedAt.current < 5000) return;
      guestSavePending.current = false;
      setDraft((current) => ({ ...current, participantAdjustments: incoming.participantAdjustments || current.participantAdjustments, payments: incoming.payments || current.payments, noRepayment: incoming.noRepayment || current.noRepayment }));
      applyingRemote.current = true; setDraft((current) => { const nextAvailability=incoming.canPayMerchant||current.canPayMerchant; const nextPreferences=incoming.settlementPreferences||current.settlementPreferences; const nextVenmo=incoming.venmoUsernames||current.venmoUsernames; if(JSON.stringify(incoming.expenses)===JSON.stringify(current.expenses)&&JSON.stringify(nextAvailability)===JSON.stringify(current.canPayMerchant)&&JSON.stringify(nextPreferences)===JSON.stringify(current.settlementPreferences)&&JSON.stringify(nextVenmo)===JSON.stringify(current.venmoUsernames))return current; return { ...current, expenses: incoming.expenses, participantAdjustments: incoming.participantAdjustments || current.participantAdjustments, payments: incoming.payments || current.payments, noRepayment: incoming.noRepayment || current.noRepayment, canPayMerchant: nextAvailability, settlementPreferences: nextPreferences, venmoUsernames: nextVenmo }; }); setTimeout(() => { applyingRemote.current = false; }, 0);
    }, 3000);
    return () => clearInterval(timer);
  }, [cloudShareToken, guestParticipantId, saveStatus]);
  useEffect(() => {
    if (!supabase || !cloudShareToken || guestParticipantId) return;
    let cancelled = false;
    const refreshNames = async () => {
      const { data } = await supabase!.rpc("open_shared_bill", { p_token: cloudShareToken });
      const row = (data as { claimed_names?: string[] }[] | null)?.[0];
      if (!cancelled) setClaimedNames(row?.claimed_names || []);
    };
    void refreshNames();
    const timer = setInterval(() => { void refreshNames(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cloudShareToken, guestParticipantId]);

  const savedTitle = draft.title.trim() || `Bill · ${displayDate(draft.dateTime)}`;
  const contactSuggestions = useMemo(() => {
    const search = personName.trim().toLowerCase();
    if (!search) return [];
    return savedContacts.filter((contact) => !draft.people.some((person) => person.name.toLowerCase() === contact.name.toLowerCase()) && (contact.name.toLowerCase().startsWith(search) || contact.phone.includes(search))).slice(0, 6);
  }, [personName, savedContacts, draft.people]);
  const subtotal = draft.expenses.reduce((sum, item) => sum + item.cents, 0);
  const unassigned = draft.expenses.filter((item) => !item.consumers.length).length;
  const sharedMode = Boolean(cloudShareToken || organizerShareToken || shareLink);
  const canShareResults = Boolean(draft.people.length && draft.expenses.length);
  const resultsShareToken = organizerShareToken || cloudShareToken || (shareLink ? new URL(shareLink).searchParams.get("share") || "" : "");
  useEffect(() => {
    if (!sharedMode || guestParticipantId) return;
    const organizerAdjustment: ParticipantAdjustment = { taxEnabled: draft.taxEnabled, taxRate: draft.taxRate, tipEnabled: draft.tipEnabled, tipMode: draft.tipMode, tipValue: draft.tipValue, discountCents: draft.discountEnabled ? draft.discountCents : 0, discountTiming: draft.discountTiming };
    const savedAdjustment = draft.participantAdjustments.organizer;
    if (JSON.stringify(savedAdjustment) === JSON.stringify(organizerAdjustment)) return;
    setDraft((current) => ({ ...current, participantAdjustments: { ...current.participantAdjustments, organizer: organizerAdjustment } }));
  }, [sharedMode, guestParticipantId, draft.taxEnabled, draft.taxRate, draft.tipEnabled, draft.tipMode, draft.tipValue, draft.discountEnabled, draft.discountCents, draft.discountTiming, draft.participantAdjustments]);
  useEffect(() => {
    if (!resultsShareToken) { setResultsQrCode(""); return; }
    const resultsLink = `${window.location.origin}/?share=${resultsShareToken}&results=1`;
    QRCode.toDataURL(resultsLink, { width: 260, margin: 2, color: { dark: "#10261d", light: "#ffffff" } }).then(setResultsQrCode).catch(() => setResultsQrCode(""));
  }, [resultsShareToken]);
  const finalItemCents = useMemo(() => {
    const result: Record<string, number> = Object.fromEntries(draft.expenses.map((item) => [item.id, item.cents]));
    if (!sharedMode) return result;
    [...new Set(draft.expenses.map((item) => item.addedBy || "organizer"))].forEach((owner) => {
      const items = draft.expenses.filter((item) => (item.addedBy || "organizer") === owner);
      const raw = items.reduce((sum, item) => sum + item.cents, 0);
      if (!raw) return;
      const live = owner === guestParticipantId || (owner === "organizer" && !guestParticipantId) ? { taxEnabled: draft.taxEnabled, taxRate: draft.taxRate, tipEnabled: draft.tipEnabled, tipMode: draft.tipMode, tipValue: draft.tipValue, discountCents: draft.discountEnabled ? draft.discountCents : 0, discountTiming: draft.discountTiming } : null;
      const a = live || draft.participantAdjustments[owner] || { taxEnabled: false, taxRate: 0, tipEnabled: false, tipMode: "percent" as const, tipValue: 0, discountCents: 0, discountTiming: "before" as const };
      const discount = Math.min(a.discountCents, raw);
      const base = a.discountTiming === "before" ? raw - discount : raw;
      const tax = a.taxEnabled ? Math.round(base * a.taxRate / 100) : 0;
      const tip = !a.tipEnabled ? 0 : a.tipMode === "amount" ? a.tipValue : Math.round(base * a.tipValue / 100);
      const finalTotal = Math.max(0, base + tax + tip - (a.discountTiming === "after" ? discount : 0));
      items.forEach((item) => { result[item.id] = Math.floor(finalTotal * item.cents / raw); });
      let remainder = finalTotal - items.reduce((sum, item) => sum + result[item.id], 0);
      items.forEach((item) => { if (remainder > 0) { result[item.id]++; remainder--; } });
    });
    return result;
  }, [draft, sharedMode, guestParticipantId]);
  const currentPersonId = draft.people.find((person) => person.name === guestName)?.id || "";
  useEffect(() => {
    if (!sharedMode || !guestParticipantId || !currentPersonId || draft.step !== 5 || initializedPayments.current.has(currentPersonId)) return;
    initializedPayments.current.add(currentPersonId);
    const enteredTotal = draft.expenses.filter((item) => item.addedBy === guestParticipantId).reduce((sum, item) => sum + (finalItemCents[item.id] || item.cents), 0);
    if ((draft.payments[currentPersonId] || 0) === 0 && enteredTotal > 0) setDraft((current) => ({ ...current, payments: { ...current.payments, [currentPersonId]: enteredTotal } }));
  }, [sharedMode, guestParticipantId, currentPersonId, draft.step, draft.payments, draft.expenses, finalItemCents]);

  const totals = useMemo(() => {
    const discount = sharedMode || !draft.discountEnabled ? 0 : Math.min(draft.discountCents, subtotal);
    const taxableBase = draft.discountTiming === "before" ? subtotal - discount : subtotal;
    const tax = sharedMode ? 0 : draft.taxEnabled ? Math.round(taxableBase * draft.taxRate / 100) : 0;
    const tip = sharedMode ? 0 : !draft.tipEnabled ? 0 : draft.tipMode === "amount" ? Math.round(draft.tipValue) : Math.round(taxableBase * draft.tipValue / 100);
    const calculatedGrand = sharedMode ? Object.values(finalItemCents).reduce((sum, cents) => sum + cents, 0) : Math.max(0, taxableBase + tax + tip - (draft.discountTiming === "after" ? discount : 0));
    const grand = Math.max(calculatedGrand, draft.totalOverrideCents || 0);
    const itemOwed = allocateExpenseTotals(draft.expenses, draft.people, (item) => finalItemCents[item.id] || item.cents);
    const rawItemOwed = allocateExpenseTotals(draft.expenses, draft.people, (item) => item.cents);
    const assigned = Object.values(itemOwed).reduce((a, b) => a + b, 0);
    const allocateAdjustment = (total: number) => {
      const result: Record<string, number> = Object.fromEntries(draft.people.map((p) => [p.id, 0]));
      if (!total || !assigned) return result;
      const ids = draft.people.filter((p) => itemOwed[p.id] > 0).map((p) => p.id);
      ids.forEach((id) => { result[id] = Math.floor(total * itemOwed[id] / assigned); });
      let remainder = total - Object.values(result).reduce((sum, cents) => sum + cents, 0);
      ids.forEach((id) => { if (remainder > 0) { result[id]++; remainder--; } });
      return result;
    };
    const taxByPerson = allocateAdjustment(tax);
    const tipByPerson = allocateAdjustment(tip);
    const discountByPerson = allocateAdjustment(discount);
    const shareAfterDiscount: Record<string, number> = Object.fromEntries(
      draft.people.map((p) => [p.id, Math.max(0, itemOwed[p.id] - discountByPerson[p.id])]),
    );
    const owed: Record<string, number> = Object.fromEntries(draft.people.map((p) => [p.id, 0]));
    if (assigned > 0) {
      const ids = draft.people.filter((p) => itemOwed[p.id] > 0).map((p) => p.id);
      ids.forEach((id) => { owed[id] = Math.floor(grand * itemOwed[id] / assigned); });
      let remainder = grand - Object.values(owed).reduce((a, b) => a + b, 0);
      ids.forEach((id) => { if (remainder-- > 0) owed[id]++; });
    }
    const originalOwed: Record<string, number> = Object.fromEntries(draft.people.map((p) => [p.id, (shareAfterDiscount[p.id] || 0) + (taxByPerson[p.id] || 0) + (tipByPerson[p.id] || 0)]));
    const responsibilityBeforeRepayment = { ...owed };
    let contribution = 0;
    const activePayers = draft.people.filter((person) => !draft.noRepayment[person.id]);
    draft.people.filter((person) => draft.noRepayment[person.id]).forEach((person) => {
      if (!activePayers.length) return;
      const paid = draft.payments[person.id] || 0;
      const balanceToMove = responsibilityBeforeRepayment[person.id] - paid;
      owed[person.id] = paid;
      const direction = balanceToMove < 0 ? -1 : 1;
      let remaining = Math.abs(balanceToMove);
      const equalPart = Math.floor(remaining / activePayers.length);
      let extraCent = remaining - equalPart * activePayers.length;
      activePayers.forEach((receiver) => {
        const amount = equalPart + (extraCent-- > 0 ? 1 : 0);
        owed[receiver.id] = Math.max(0, owed[receiver.id] + direction * amount);
        remaining -= amount;
      });
      contribution += Math.max(0, paid - responsibilityBeforeRepayment[person.id]);
    });
    const debtors = draft.people.map((p) => ({ ...p, amount: owed[p.id] - (draft.payments[p.id] || 0) })).filter((p) => p.amount > 0);
    const creditors = draft.people.map((p) => ({ ...p, amount: draft.noRepayment[p.id] ? 0 : (draft.payments[p.id] || 0) - owed[p.id] })).filter((p) => p.amount > 0);
    const paidTotal = Object.values(draft.payments).reduce((a, b) => a + b, 0);
    const remainingToMerchant = Math.max(0, grand - paidTotal);
    const merchantPayments: Record<string, number> = Object.fromEntries(draft.people.map((p) => [p.id, 0]));
    let merchantLeft = remainingToMerchant;
    debtors.forEach((person) => {
      const amount = Math.min(person.amount, merchantLeft);
      merchantPayments[person.id] = amount;
      person.amount -= amount;
      merchantLeft -= amount;
    });
    const settlements: { from: string; to: string; cents: number }[] = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const cents = Math.min(debtors[i].amount, creditors[j].amount);
      if (cents) settlements.push({ from: debtors[i].name, to: creditors[j].name, cents });
      debtors[i].amount -= cents; creditors[j].amount -= cents;
      if (!debtors[i].amount) i++; if (!creditors[j].amount) j++;
    }
    const outgoing: Record<string, number> = Object.fromEntries(draft.people.map((p) => [p.id, 0]));
    const incoming: Record<string, number> = Object.fromEntries(draft.people.map((p) => [p.id, 0]));
    settlements.forEach((s) => { const from = draft.people.find((p) => p.name === s.from); const to = draft.people.find((p) => p.name === s.to); if (from) outgoing[from.id] += s.cents; if (to) incoming[to.id] += s.cents; });
    return { discount, tax, tip, calculatedGrand, grand, paidTotal, remainingToMerchant, contribution, itemOwed, rawItemOwed, discountByPerson, shareAfterDiscount, taxByPerson, tipByPerson, originalOwed, owed, merchantPayments, outgoing, incoming, settlements };
  }, [draft, subtotal, sharedMode, finalItemCents]);
  const paymentPlan = useMemo(() => {
    const available = draft.people.filter((person) => !draft.noRepayment[person.id] && draft.canPayMerchant[person.id] !== false);
    const merchantPayments: Record<string, number> = Object.fromEntries(draft.people.map((person) => [person.id, 0]));
    let merchantLeft = totals.remainingToMerchant;
    available.forEach((person) => { const ownDue=Math.max(0,(totals.owed[person.id]||0)-(draft.payments[person.id]||0)); const amount=Math.min(ownDue,merchantLeft); merchantPayments[person.id]+=amount; merchantLeft-=amount; });
    draft.people.filter((person)=>!draft.noRepayment[person.id]&&draft.canPayMerchant[person.id]===false).forEach((person)=>{ const need=Math.min(Math.max(0,(totals.owed[person.id]||0)-(draft.payments[person.id]||0)),merchantLeft); const preferred=(draft.settlementPreferences[person.id]||[]).map((id)=>available.find((candidate)=>candidate.id===id)).find(Boolean)||available[0]; if(preferred&&need){merchantPayments[preferred.id]+=need;merchantLeft-=need;} });
    if(merchantLeft&&available[0])merchantPayments[available[0].id]+=merchantLeft;
    const balances=draft.people.map((person)=>({...person,amount:(totals.owed[person.id]||0)-(draft.payments[person.id]||0)-merchantPayments[person.id]}));
    const creditors=balances.filter((person)=>person.amount<0&&!draft.noRepayment[person.id]).map((person)=>({...person,amount:-person.amount}));
    const settlements:{from:string;to:string;cents:number}[]=[];
    balances.filter((person)=>person.amount>0).forEach((debtor)=>{ const rank=draft.settlementPreferences[debtor.id]||[]; [...creditors].sort((a,b)=>{const ai=rank.indexOf(a.id),bi=rank.indexOf(b.id);return(ai<0?999:ai)-(bi<0?999:bi);}).forEach((creditor)=>{if(!debtor.amount||!creditor.amount)return;const cents=Math.min(debtor.amount,creditor.amount);settlements.push({from:debtor.name,to:creditor.name,cents});debtor.amount-=cents;creditor.amount-=cents;}); });
    const outgoing:Record<string,number>=Object.fromEntries(draft.people.map((person)=>[person.id,0]));
    const incoming:Record<string,number>=Object.fromEntries(draft.people.map((person)=>[person.id,0]));
    settlements.forEach((settlement)=>{const from=draft.people.find((person)=>person.name===settlement.from);const to=draft.people.find((person)=>person.name===settlement.to);if(from)outgoing[from.id]+=settlement.cents;if(to)incoming[to.id]+=settlement.cents;});
    return {merchantPayments,settlements,outgoing,incoming};
  }, [draft.people,draft.payments,draft.noRepayment,draft.canPayMerchant,draft.settlementPreferences,totals.remainingToMerchant,totals.owed]);
  const currentReceiptOwner = guestParticipantId || "organizer";
  const ownReceiptSubtotal = draft.expenses.filter((item) => !sharedMode || (item.addedBy || "organizer") === currentReceiptOwner).reduce((sum, item) => sum + item.cents, 0);
  const ownReceiptDiscount = draft.discountEnabled ? Math.min(draft.discountCents, ownReceiptSubtotal) : 0;
  const ownReceiptBase = draft.discountTiming === "before" ? ownReceiptSubtotal - ownReceiptDiscount : ownReceiptSubtotal;
  const ownReceiptTax = draft.taxEnabled ? Math.round(ownReceiptBase * draft.taxRate / 100) : 0;
  const ownReceiptTip = !draft.tipEnabled ? 0 : draft.tipMode === "amount" ? draft.tipValue : Math.round(ownReceiptBase * draft.tipValue / 100);

  function addSavedContact(contact: SavedContact) {
    if (draft.people.some((person) => person.name.toLowerCase() === contact.name.toLowerCase())) return;
    const id = uid();
    const color = COLORS[draft.people.length % COLORS.length];
    setCurrentPhones((phones) => ({ ...phones, [id]: contact.phone }));
    setDraft((current) => ({ ...current, people: [...current.people, { id, name: contact.name, color }], venmoUsernames: { ...current.venmoUsernames, [id]: contact.venmoUsername } }));
    setPersonName("");
  }
  function addPerson() {
    const name = capitalizeName(personName);
    if (!name || draft.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
    const saved = savedContacts.find((contact) => contact.name.toLowerCase() === name.toLowerCase());
    if (saved) { addSavedContact(saved); return; }
    setDraft((d) => ({ ...d, people: [...d.people, { id: uid(), name, color: COLORS[d.people.length % COLORS.length] }] }));
    setPersonName("");
  }
  function removePerson(id: string) {
    setDraft((d) => ({ ...d, people: d.people.filter((p) => p.id !== id), expenses: d.expenses.map((e) => ({ ...e, consumers: e.consumers.filter((x) => x !== id), quantities: Object.fromEntries(Object.entries(e.quantities || {}).filter(([x]) => x !== id)) })), payments: Object.fromEntries(Object.entries(d.payments).filter(([x]) => x !== id)), noRepayment: Object.fromEntries(Object.entries(d.noRepayment).filter(([x]) => x !== id)) }));
  }
  async function loadSavedContacts() {
    if (!supabase || !userId) return;
    const { data, error: contactsError } = await supabase.from("saved_contacts").select("id,name,phone,venmo_username").order("name");
    if (contactsError) { setError(contactsError.message); return; }
    setSavedContacts((data || []).map((contact) => ({ id: contact.id as string, name: contact.name as string, phone: (contact.phone as string | null) || "", venmoUsername: (contact.venmo_username as string | null) || "" })));
  }
  async function saveMembersAsContacts(members: SavedGroupMember[]) {
    if (!supabase || !userId || !members.length) return;
    const contacts = [...new Map(members.filter((member) => member.name.trim()).map((member) => { const normalizedName = member.name.trim().toLowerCase(); return [normalizedName, { owner_id: userId, normalized_name: normalizedName, name: capitalizeName(member.name), phone: member.phone.trim() || null, venmo_username: member.venmoUsername.replace(/^@/, "").trim() || null, updated_at: new Date().toISOString() }]; })).values()];
    const { error: contactsError } = await supabase.from("saved_contacts").upsert(contacts, { onConflict: "owner_id,normalized_name" });
    if (contactsError) { setError(contactsError.message); return; }
    await loadSavedContacts();
  }
  async function loadSavedGroups() {
    if (!supabase || !userId) return;
    const { data, error: groupsError } = await supabase.from("saved_groups").select("id,name,saved_group_members(id,name,phone,venmo_username,color,sort_order)").order("updated_at", { ascending: false });
    if (groupsError) { setError(groupsError.message); return; }
    const groups = (data || []).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      people: ((row.saved_group_members || []) as { id: string; name: string; phone: string | null; venmo_username: string | null; color: string; sort_order: number }[])
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((member) => ({ id: member.id, name: member.name, phone: member.phone || "", venmoUsername: member.venmo_username || "", color: member.color, selected: true })),
    }));
    setSavedGroups(groups);
    await saveMembersAsContacts(groups.flatMap((group) => group.people));
  }
  function saveCurrentGroup() {
    if (!userId) { setError("Log in to save a group."); setAccountOpen(true); return; }
    if (draft.people.length < 2) { setError("Add at least two people before saving a group."); return; }
    setEditingGroup({
      id: "",
      name: draft.title.trim() || "My group",
      people: draft.people.map((person) => ({ ...person, phone: currentPhones[person.id] || "", venmoUsername: draft.venmoUsernames[person.id] || "", selected: true })),
    });
    setGroupsOpen(true); setError("");
  }
  async function saveEditingGroup() {
    if (!supabase || !userId || !editingGroup) return;
    const name = editingGroup.name.trim();
    if (!name) { setError("Enter a group name."); return; }
    if (editingGroup.people.length < 2) { setError("A saved group needs at least two people."); return; }
    setGroupBusy(true); setError("");
    let groupId = editingGroup.id;
    if (groupId) {
      const { error: updateError } = await supabase.from("saved_groups").update({ name, updated_at: new Date().toISOString() }).eq("id", groupId);
      if (updateError) { setError(updateError.message); setGroupBusy(false); return; }
      const { error: clearError } = await supabase.from("saved_group_members").delete().eq("group_id", groupId);
      if (clearError) { setError(clearError.message); setGroupBusy(false); return; }
    } else {
      const { data, error: createError } = await supabase.from("saved_groups").insert({ owner_id: userId, name }).select("id").single();
      if (createError || !data) { setError(createError?.message || "Could not save this group."); setGroupBusy(false); return; }
      groupId = data.id;
    }
    const members = editingGroup.people.map((person, index) => ({ group_id: groupId, name: person.name.trim(), phone: person.phone.trim() || null, venmo_username: person.venmoUsername.replace(/^@/, "").trim() || null, color: person.color, sort_order: index }));
    const { error: memberError } = await supabase.from("saved_group_members").insert(members);
    if (memberError) { setError(memberError.message); setGroupBusy(false); return; }
    await saveMembersAsContacts(editingGroup.people);
    await loadSavedGroups(); setEditingGroup(null); setGroupBusy(false); setNotice("Group and contacts saved to your account.");
  }
  async function deleteSavedGroup(groupId: string) {
    setAppConfirm({ type: "delete-group", id: groupId });
  }
  function chooseGroup(group: SavedGroup) {
    const chosen = group.people.filter((person) => person.selected !== false);
    if (chosen.length < 2) { setError("Select at least two people for this bill."); return; }
    const people = chosen.map((person, index) => ({ id: uid(), name: person.name, color: person.color || COLORS[index % COLORS.length] }));
    const phones: Record<string, string> = {};
    const venmoUsernames: Record<string, string> = {};
    people.forEach((person, index) => { phones[person.id] = chosen[index].phone; venmoUsernames[person.id] = chosen[index].venmoUsername; });
    setCurrentPhones(phones);
    setDraft((current) => ({ ...current, people, expenses: [], payments: {}, noRepayment: {}, canPayMerchant: {}, settlementPreferences: {}, venmoUsernames, step: 2 }));
    setGroupsOpen(false); setEditingGroup(null); setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function shareBillInvite() {
    if (!shareLink) { setError("Turn on bill sharing first."); return; }
    try {
      const shareData = { title: savedTitle, text: "Join our shared bill to add expenses and choose what you used.", url: shareLink };
      setNotice(""); setError("");
      if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText(shareLink); setNotice("Private bill link copied."); }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError("Could not open sharing. Please copy the private link instead.");
    }
  }
  async function shareResults() {
    if (!supabase) { setError("Cloud sharing is not available right now."); return; }
    setSharing(true); setError(""); setNotice("Saving latest results…");
    try {
      let shareBillId = cloudBillId || draft.cloudId || billIdentityRef.current;
      if (cloudShareToken && guestParticipantId) {
        const savedGuest = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
        if (!savedGuest.edit_token) throw new Error("Your participant access has expired. Choose your name again before sharing.");
        const adjustment: ParticipantAdjustment = { taxEnabled: draft.taxEnabled, taxRate: draft.taxRate, tipEnabled: draft.tipEnabled, tipMode: draft.tipMode, tipValue: draft.tipValue, discountCents: draft.discountEnabled ? draft.discountCents : 0, discountTiming: draft.discountTiming };
        const participantDraft = { ...draft, participantAdjustments: { ...draft.participantAdjustments, [guestParticipantId]: adjustment } };
        const { error: saveError } = await supabase.rpc("save_participant_draft", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: savedGuest.edit_token, p_draft: participantDraft });
        if (saveError) throw new Error(saveError.message);
      } else {
        let activeUserId = userId;
        if (!activeUserId) {
          sharingResultsAuth.current = true;
          const { data: anonymousData, error: anonymousError } = await supabase.auth.signInAnonymously();
          activeUserId = anonymousData.user?.id || "";
          if (anonymousError || !activeUserId) throw new Error(anonymousError?.message || "Could not start anonymous sharing.");
        }
        const candidateBillId = shareBillId || getBillIdentity();
        const { data: ownedBill, error: ownershipError } = await supabase.from("bills").select("id").eq("id", candidateBillId).eq("owner_id", activeUserId).maybeSingle();
        if (ownershipError) throw new Error(ownershipError.message);
        const activeBillId = ownedBill?.id || crypto.randomUUID();
        shareBillId = activeBillId;
        const sharedDraft = { ...draft, cloudId: activeBillId };
        const { error: saveError } = await supabase.from("bills").upsert({ id: activeBillId, owner_id: activeUserId, restaurant_id: draft.restaurant?.id || null, title: draft.title, occurred_at: new Date(draft.dateTime).toISOString(), settings: { draft: sharedDraft }, updated_at: new Date().toISOString() }, { onConflict: "id" });
        if (saveError) throw new Error(saveError.message);
        setCloudBillId(activeBillId); setDraft(sharedDraft);
        localStorage.setItem(`cloud-bill-${activeUserId}`, activeBillId);
        pendingLocalChange.current = false; lastOwnSaveAt.current = Date.now(); setSaveStatus("saved");
      }
      const activeBillId = shareBillId;
      let token = organizerShareToken || cloudShareToken || (shareLink ? new URL(shareLink).searchParams.get("share") || "" : "");
      if (token && !guestParticipantId && activeBillId) {
        const { data: tokenBill } = await supabase.rpc("open_shared_bill", { p_token: token });
        const linkedBillId = (tokenBill as { bill_id?: string }[] | null)?.[0]?.bill_id || "";
        if (linkedBillId !== activeBillId) {
          localStorage.removeItem(`bill-share-token-${activeBillId}`);
          setOrganizerShareToken(""); setShareLink(""); token = "";
        }
      }
      if (!token) {
        if (!activeBillId) throw new Error("Could not identify this bill for sharing.");
        const { data, error: shareError } = await supabase.rpc("create_bill_share", { p_bill_id: activeBillId });
        if (shareError || !data) throw new Error(shareError?.message || "Could not create the private results link.");
        token = data as string;
        const newLink = `${window.location.origin}/?share=${token}`;
        setOrganizerShareToken(token); setShareLink(newLink); setSharingEnabled(true);
        localStorage.setItem(`bill-share-token-${activeBillId}`, token);
      }
      const resultsLink = `${window.location.origin}/?share=${token}&results=1`;
      const shareData = { title: savedTitle, text: "View your assignments and final bill result.", url: resultsLink };
      setNotice("");
      if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText(resultsLink); setNotice("Private results link copied."); }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? `Could not share the latest results: ${cause.message}` : "Could not share the latest results.");
    } finally {
      sharingResultsAuth.current = false;
      setSharing(false);
    }
  }
  function addExpense() {
    const cents = toCents(itemAmount);
    if (!cents) { setError("Enter a price greater than zero."); return; }
    setDraft((d) => ({ ...d, expenses: [...d.expenses, { id: uid(), name: itemName.trim(), cents, consumers: [], addedBy: guestParticipantId || "organizer", addedByName: guestName || "Organizer", splitEqually: false, quantities: {} }] }));
    setItemName(""); setItemAmount(""); setError("");
  }
  async function deleteExpense(itemId: string) {
    if (!guestParticipantId || !cloudShareToken || !supabase) { setDraft((current)=>({...current,expenses:current.expenses.filter((item)=>item.id!==itemId)})); return; }
    const saved=JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`)||"{}") as {edit_token?:string};
    if (!saved.edit_token) return;
    const {data,error:deleteError}=await supabase.rpc("delete_participant_item",{p_token:cloudShareToken,p_participant_id:guestParticipantId,p_edit_token:saved.edit_token,p_item_id:itemId});
    if(deleteError){setCloudError(deleteError.message);setSaveStatus("offline");return;}
    if(data){const canonical=data as Draft;skipGuestDraftSave.current=true;setDraft((current)=>({...current,expenses:canonical.expenses||current.expenses}));setSaveStatus("saved");}
  }
  function toggleMerchantAvailability(personId:string){const isAvailable=draft.canPayMerchant[personId]!==false;const count=draft.people.filter((person)=>draft.canPayMerchant[person.id]!==false).length;if(isAvailable&&count<=1){setError("At least one person must be available to pay the merchant.");return;}setError("");setDraft((current)=>({...current,canPayMerchant:{...current.canPayMerchant,[personId]:!isAvailable}}));}
  function toggleSettlementPreference(personId:string,preferredId:string){setDraft((current)=>{const list=current.settlementPreferences[personId]||[];return{...current,settlementPreferences:{...current.settlementPreferences,[personId]:list.includes(preferredId)?list.filter((id)=>id!==preferredId):[...list,preferredId]}};});}
  function goTo(step: 1 | 2 | 3 | 4 | 5) {
    if (step === 3 && draft.people.length < 2) { setError("Add at least two people."); return; }
    if (step === 3 && sharingEnabled && shareLink && !guestParticipantId) {
      const token = organizerShareToken || new URL(shareLink).searchParams.get("share") || "";
      if (token) { latestDraft.current = draft; setSharedLoaded(true); setCloudShareToken(token); setError(""); return; }
    }
    if (step === 4 && !draft.expenses.length) { setError("Add at least one expense."); return; }
    if (step === 5 && unassigned && !guestParticipantId) { setError(`Assign ${unassigned} remaining item${unassigned === 1 ? "" : "s"}.`); return; }
    setError(""); setDraft((d) => ({ ...d, step })); window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function toggleConsumer(expenseId: string, personId: string) {
    const item = draft.expenses.find((expense) => expense.id === expenseId);
    const selected = !item?.consumers.includes(personId);
    const atomicSharedAssignment = Boolean(supabase && cloudShareToken && guestParticipantId && personId === currentPersonId);
    if (atomicSharedAssignment) {
      skipGuestDraftSave.current = true;
      guestSaveVersion.current++;
      guestSavePending.current = true;
      guestSaveStartedAt.current = Date.now();
      guestAtomicUntil.current = Date.now() + 5000;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    }
    setDraft((d) => ({ ...d, expenses: d.expenses.map((e) => {
      if (e.id !== expenseId) return e;
      const quantities = { ...(e.quantities || {}) };
      if (selected) quantities[personId] = Math.max(1, quantities[personId] || 1);
      else delete quantities[personId];
      return { ...e, quantities, consumers: selected ? [...new Set([...e.consumers, personId])] : e.consumers.filter((id) => id !== personId) };
    }) }));
    if (atomicSharedAssignment) void (async () => {
      const saved = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
      if (!saved.edit_token) return;
      const { data, error: assignmentError } = await supabase!.rpc("set_participant_item_quantity", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: saved.edit_token, p_item_id: expenseId, p_quantity: selected ? 1 : 0 });
      if (assignmentError) { guestSavePending.current=false; guestAtomicUntil.current=0; setCloudError(assignmentError.message); setSaveStatus("offline"); return; }
      if (data) { const canonical=data as Draft; latestDraft.current={...initialDraft,...canonical,step:draft.step}; skipGuestDraftSave.current=true; setDraft((current)=>({...current,expenses:canonical.expenses||current.expenses})); setSaveStatus("saved"); }
      guestSavePending.current=false;
    })();
  }
  function setItemQuantity(expenseId: string, personId: string, quantity: number) {
    const nextQuantity = Math.max(0, Math.min(99, Math.floor(quantity)));
    const atomicOwnerQuantity = Boolean(supabase && userId && cloudBillId && !guestParticipantId && sharedMode);
    if (guestParticipantId && personId === currentPersonId) { skipGuestDraftSave.current=true; guestSaveVersion.current++; guestSavePending.current=true; guestSaveStartedAt.current=Date.now(); guestAtomicUntil.current=Date.now()+5000; if(saveTimer.current)clearTimeout(saveTimer.current); }
    setDraft((current) => ({ ...current, expenses: current.expenses.map((expense) => {
      if (expense.id !== expenseId) return expense;
      const quantities = { ...(expense.quantities || {}) };
      if (nextQuantity) quantities[personId] = nextQuantity; else delete quantities[personId];
      return { ...expense, quantities, consumers: nextQuantity ? [...new Set([...expense.consumers, personId])] : expense.consumers.filter((id) => id !== personId) };
    }) }));
    if (guestParticipantId && cloudShareToken && supabase && personId === currentPersonId) void (async () => {
      const saved = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
      if (!saved.edit_token) return;
      const { data, error: quantityError } = await supabase.rpc("set_participant_item_quantity", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: saved.edit_token, p_item_id: expenseId, p_quantity: nextQuantity });
      if (quantityError) { guestSavePending.current=false; guestAtomicUntil.current=0; setCloudError(quantityError.message); setSaveStatus("offline"); return; }
      if (data) { const canonical=data as Draft; skipGuestDraftSave.current=true; setDraft((current)=>({...current,expenses:canonical.expenses||current.expenses})); setSaveStatus("saved"); }
      guestSavePending.current=false;
    })();
    if (atomicOwnerQuantity) void (async () => {
      pendingLocalChange.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveStatus("saving");
      const { data, error: quantityError } = await supabase!.rpc("set_owner_item_quantity", { p_bill_id: cloudBillId, p_item_id: expenseId, p_person_id: personId, p_quantity: nextQuantity });
      if (quantityError) { pendingLocalChange.current=false; setCloudError(quantityError.message); setSaveStatus("offline"); return; }
      if (data) {
        const canonical = data as Draft;
        latestDraft.current = { ...initialDraft, ...canonical, step: draft.step };
        applyingRemote.current = true;
        setDraft((current) => ({ ...current, expenses: canonical.expenses || current.expenses }));
        setTimeout(() => { applyingRemote.current = false; }, 0);
      }
      pendingLocalChange.current = false;
      lastOwnSaveAt.current = Date.now();
      setCloudError("");
      setSaveStatus("saved");
    })();
  }
  function toggleAll(expenseId: string) {
    const item = draft.expenses.find((e) => e.id === expenseId);
    const all = item?.consumers.length === draft.people.length;
    setDraft((d) => ({ ...d, expenses: d.expenses.map((e) => e.id === expenseId ? { ...e, consumers: all ? [] : d.people.map((p) => p.id), quantities: all ? {} : Object.fromEntries(d.people.map((p) => [p.id, 1])) } : e) }));
  }
  function assignEverything() {
    setDraft((d) => ({ ...d, expenses: d.expenses.map((e) => ({ ...e, consumers: d.people.map((p) => p.id), quantities: Object.fromEntries(d.people.map((p) => [p.id, Math.max(1, e.quantities?.[p.id] || 1)])) })) }));
  }
  async function receiptImageDataUrl(file: File) {
    try {
      const bitmap = await createImageBitmap(file);
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not prepare the receipt photo.");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return canvas.toDataURL("image/jpeg", 0.86);
    } catch {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not prepare the receipt photo."));
        reader.readAsDataURL(file);
      });
    }
  }
  async function scanWithBrowserOcr(file: File) {
    const { recognize } = await import("tesseract.js");
    const result = await recognize(file, "eng", { logger: (message) => { if (message.status === "recognizing text") setScanProgress(55 + Math.round((message.progress || 0) * 44)); } });
    const ignored = /^(sub\s*total|total|tax|tip|discount|change|cash|visa|mastercard|amex|balance|amount due|payment|credit)/i;
    return result.data.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      const match = line.match(/^(.*?)[\s.$]+(-?\d+[.,]\d{2})\D*$/);
      if (!match || ignored.test(match[1].trim())) return [];
      const cents = Math.round(Number(match[2].replace(",", ".")) * 100);
      const name = match[1].replace(/[^\p{L}\p{N}\s&'().-]/gu, "").trim();
      return name && cents > 0 ? [{ name, cents, selected: true }] : [];
    });
  }
  async function scanReceipt(file?: File) {
    if (!file) return;
    setScanBusy(true); setScanProgress(5); setScanLines([]); setError("");
    let aiError = "";
    try {
      const image = await receiptImageDataUrl(file);
      setScanProgress(25);
      const response = await fetch("/api/scan-receipt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }) });
      const data = await response.json() as { items?: { name: string; cents: number }[]; error?: string };
      if (!response.ok) throw new Error(data.error || "The AI receipt reader could not process this photo.");
      const parsed = (data.items || []).map((item) => ({ name: item.name.trim(), cents: Math.round(item.cents), selected: true })).filter((item) => item.name && item.cents > 0);
      if (!parsed.length) throw new Error("No purchased item lines were found in this receipt.");
      setScanProgress(100); setScanLines(parsed); setScanBusy(false); return;
    } catch (cause) {
      aiError = cause instanceof Error ? cause.message : "The AI receipt reader could not process this photo.";
    }
    try {
      setScanProgress(55);
      const fallback = await scanWithBrowserOcr(file);
      if (!fallback.length) throw new Error("The backup scanner also found no item lines.");
      setScanProgress(100); setScanLines(fallback);
    } catch {
      setError(`${aiError} Try a clear, straight photo with the full receipt visible, or enter the items manually.`);
    } finally { setScanBusy(false); }
  }  function addScannedItems() {
    const items = scanLines.filter((line) => line.selected && line.cents > 0).map((line) => ({ id: uid(), name: line.name, cents: line.cents, consumers: [], addedBy: guestParticipantId || "organizer", addedByName: guestName || "Organizer", splitEqually: false, quantities: {} }));
    if (!items.length) { setError("Select at least one scanned item."); return; }
    setDraft((current) => ({ ...current, expenses: [...current.expenses, ...items] })); setScanLines([]); setError("");
  }
  function clearDraft() {
    setConfirmAction("clear");
  }
  function confirmClearDraft() {
    setConfirmAction(null);
    setCloudBillId(""); setShareLink(""); setCloudShareToken(""); setOrganizerShareToken(""); setSharingEnabled(false); setSaveStatus(userId ? "saving" : "local");
    if (userId) localStorage.removeItem(`cloud-bill-${userId}`);
    const nextBillId=crypto.randomUUID(); billIdentityRef.current=nextBillId;
    setDraft({ ...initialDraft, cloudId: nextBillId, theme: draft.theme, dateTime: localNow(), taxRate: draft.taxRate, tipMode: draft.tipMode, tipValue: draft.tipValue });
  }
  function applyDifferentTotal(value: string) {
    if (!value.trim()) { setDraft((current) => ({ ...current, totalOverrideCents: 0 })); setError(""); return true; }
    const cents = toCents(value);
    if (cents < totals.calculatedGrand) { setError(`Enter ${money(totals.calculatedGrand)} or more.`); return false; }
    setDraft((current) => ({ ...current, totalOverrideCents: cents === totals.calculatedGrand ? 0 : cents })); setError(""); return true;
  }
  async function createShareLink() {
    setSharing(true); setError("");
    try {
      if (!supabase || !userId) throw new Error("Log in to create a private sharing link.");
      if (!cloudBillId) throw new Error("Wait for Saved to cloud, then turn sharing on again.");
      const { data: token, error: shareError } = await supabase.rpc("create_bill_share", { p_bill_id: cloudBillId });
      if (shareError || !token) throw new Error(shareError?.message || "Could not create the permanent sharing link.");
      const link = `${window.location.origin}/?share=${token}`;
      setOrganizerShareToken(token as string); setShareLink(link); setSharedLoaded(true); setAdvanced(false); setNotice(""); window.history.replaceState({}, "", window.location.pathname); await navigator.clipboard?.writeText(link);
      localStorage.setItem(`bill-share-token-${cloudBillId}`, token as string);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the cloud sharing link.");
    }
    finally { setSharing(false); }
  }
  async function toggleSharing() {
    const next = !sharingEnabled;
    setSharingEnabled(next);
    if (next && !shareLink) await createShareLink();
    else if (next && shareLink) {
      const token = organizerShareToken || new URL(shareLink).searchParams.get("share") || "";
      if (token) { setOrganizerShareToken(token); setSharedLoaded(true); setAdvanced(false); }
    }
  }
  async function requestSharingSignIn() {
    if (!supabase) { setError("Cloud sharing is not available yet."); return; }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    localStorage.setItem(SHARE_AFTER_SIGN_IN_KEY, "1");
    setSharing(true); setSharingEnabled(true); setError("");
    const { error: anonymousError } = await supabase.auth.signInAnonymously();
    if (anonymousError) {
      localStorage.removeItem(SHARE_AFTER_SIGN_IN_KEY);
      setSharing(false); setSharingEnabled(false);
      setError(anonymousError.message || "Could not start anonymous sharing.");
    }
  }
  async function signInWithGoogle() {
    if (!supabase) return;
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  }
  async function sendMagicLink() {
    if (!supabase || !authEmail.trim()) return;
    const { error: authError } = await supabase.auth.signInWithOtp({ email: authEmail.trim(), options: { emailRedirectTo: window.location.origin } });
    setAuthMessage(authError ? authError.message : "Check your email for the secure sign-in link.");
  }
  async function paypalHeaders() {
    const { data } = await supabase!.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Log in before connecting PayPal.");
    return { Authorization: `Bearer ${token}` };
  }
  async function loadPayPalStatus() {
    if (!supabase || !userId) return;
    try {
      const response = await fetch("/api/paypal/status", { headers: await paypalHeaders(), cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not read PayPal status.");
      setPaypalAccount(body.account || null);
    } catch (cause) {
      setPaypalMessage(cause instanceof Error ? cause.message : "Could not read PayPal status.");
    }
  }
  function restaurantFromRow(row: Record<string, unknown>): RegisteredRestaurant {
    return {
      id: String(row.id || ""),
      name: String(row.name || ""),
      locationName: String(row.location_name || ""),
      address: String(row.address_line_1 || ""),
      city: String(row.city || ""),
      region: String(row.region || ""),
      postalCode: String(row.postal_code || ""),
      phone: String(row.phone || ""),
      publicCode: String(row.public_code || ""),
      active: row.active !== false,
    };
  }
  async function loadOwnRestaurant() {
    if (!supabase || !userId) return;
    const { data, error: restaurantError } = await supabase.from("restaurants").select("*").eq("owner_id", userId).maybeSingle();
    if (restaurantError) { setPaypalMessage(restaurantError.message); return; }
    const restaurant = data ? restaurantFromRow(data as Record<string, unknown>) : null;
    setOwnRestaurant(restaurant);
    if (restaurant) setRestaurantForm({ name: restaurant.name, locationName: restaurant.locationName, address: restaurant.address, city: restaurant.city, region: restaurant.region, postalCode: restaurant.postalCode, phone: restaurant.phone });
  }
  async function saveRestaurant() {
    if (!supabase || !userId) { setAccountOpen(true); return; }
    if (!restaurantForm.name.trim() || !restaurantForm.address.trim() || !restaurantForm.city.trim() || !restaurantForm.region.trim() || !restaurantForm.postalCode.trim()) {
      setPaypalMessage("Enter the restaurant name and complete address."); return;
    }
    setRestaurantBusy(true); setPaypalMessage("");
    const values = {
      ...(ownRestaurant?.id ? { id: ownRestaurant.id } : {}),
      owner_id: userId,
      name: restaurantForm.name.trim(),
      location_name: restaurantForm.locationName.trim(),
      address_line_1: restaurantForm.address.trim(),
      city: restaurantForm.city.trim(),
      region: restaurantForm.region.trim().toUpperCase(),
      postal_code: restaurantForm.postalCode.trim(),
      phone: restaurantForm.phone.trim(),
      active: true,
      updated_at: new Date().toISOString(),
    };
    const { data, error: restaurantError } = await supabase.from("restaurants").upsert(values, { onConflict: "owner_id" }).select("*").single();
    setRestaurantBusy(false);
    if (restaurantError || !data) { setPaypalMessage(restaurantError?.message || "Could not save the restaurant."); return; }
    setOwnRestaurant(restaurantFromRow(data as Record<string, unknown>));
    setPaypalMessage("Restaurant profile saved.");
  }
  async function loadRestaurantCode(code: string) {
    if (!supabase) return;
    const { data, error: restaurantError } = await supabase.rpc("open_registered_restaurant", { p_code: code });
    const row = (data as Record<string, unknown>[] | null)?.[0];
    if (restaurantError || !row) { setError(restaurantError?.message || "This restaurant QR code is invalid."); return; }
    setPendingRestaurant({
      id: String(row.id),
      name: String(row.name),
      locationName: String(row.location_name || ""),
      address: String(row.address_line_1),
      city: String(row.city),
      region: String(row.region),
      postalCode: String(row.postal_code),
      paypalConnected: row.paypal_connected === true,
    });
  }
  function confirmRestaurant() {
    if (!pendingRestaurant) return;
    const { paypalConnected: _paypalConnected, ...restaurant } = pendingRestaurant;
    setDraft((current) => ({ ...current, restaurant }));
    setPendingRestaurant(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("restaurant");
    window.history.replaceState({}, "", url);
    setNotice(`This bill will be paid to ${restaurant.name}${restaurant.locationName ? ` — ${restaurant.locationName}` : ""}.`);
  }
  async function connectPayPal() {
    if (!supabase || !userId) { setAccountOpen(true); return; }
    setPaypalBusy(true); setPaypalMessage("");
    try {
      const response = await fetch("/api/paypal/onboard", { method: "POST", headers: await paypalHeaders() });
      const body = await response.json();
      if (!response.ok || !body.url) throw new Error(body.error || "Could not start PayPal setup.");
      window.location.assign(body.url);
    } catch (cause) {
      setPaypalMessage(cause instanceof Error ? cause.message : "Could not start PayPal setup.");
      setPaypalBusy(false);
    }
  }
  async function signOut() { await supabase?.auth.signOut(); setPaypalAccount(null); setAccountOpen(false); }
  async function loadHistory() {
    if (!supabase || !userId) return;
    const { data, error: historyError } = await supabase.from("bills").select("id,title,occurred_at,status,updated_at,settings").order("updated_at", { ascending: false });
    if (historyError) { setError(historyError.message); return; }
    setHistoryBills((data || []) as CloudBill[]); setAccountOpen(false); setHistoryOpen(true);
  }
  function openHistoryBill(bill: CloudBill) {
    if (!bill.settings?.draft) return;
    if (bill.status === "archived") { setHistoryPreviewBill(bill); setHistoryOpen(false); return; }
    applyingRemote.current = true; billIdentityRef.current=bill.id; setOrganizerShareToken(""); setShareLink(""); setDraft({ ...normalizeDraft(bill.settings.draft), cloudId: bill.id }); setCloudBillId(bill.id); localStorage.setItem(`cloud-bill-${userId}`, bill.id); setHistoryOpen(false); setSaveStatus("saved"); setTimeout(() => { applyingRemote.current = false; }, 0);
  }
  async function duplicateHistoryBill(bill: CloudBill) {
    if (!supabase || !userId || !bill.settings?.draft) return;
    const copyId=crypto.randomUUID();
    const copy: Draft = { ...normalizeDraft(bill.settings.draft), cloudId: copyId, title: `${bill.title || "Bill"} copy`, dateTime: localNow(), payments: {}, noRepayment: {}, step: 2 };
    const { data, error: duplicateError } = await supabase.from("bills").insert({ id: copyId, owner_id: userId, restaurant_id: copy.restaurant?.id || null, title: copy.title, occurred_at: new Date(copy.dateTime).toISOString(), settings: { draft: copy } }).select("id,title,occurred_at,status,updated_at,settings").single();
    if (duplicateError || !data) { setError(duplicateError?.message || "Could not duplicate this bill."); return; }
    setHistoryBills((current) => [data as CloudBill, ...current]);
  }
  async function renameHistoryBill(bill: CloudBill) {
    setAppConfirm({ type: "rename-bill", id: bill.id, value: bill.title || "" });
  }
  async function setHistoryStatus(bill: CloudBill, status: "open" | "locked" | "archived") {
    if (!supabase) return; const { error: statusError } = await supabase.from("bills").update({ status, updated_at: new Date().toISOString() }).eq("id", bill.id);
    if (statusError) { setError(statusError.message); return; } setHistoryBills((current) => current.map((item) => item.id === bill.id ? { ...item, status } : item));
  }
  async function deleteHistoryBill(bill: CloudBill) {
    setAppConfirm({ type: "delete-bill", id: bill.id });
  }
  async function claimParticipant(name: string) {
    if (!supabase || !cloudShareToken) return;
    const { data, error: claimError } = await supabase.rpc("claim_bill_participant", { p_token: cloudShareToken, p_name: name });
    if (claimError || !data) { setError(claimError?.message || "Could not join this bill."); return; }
    const guest = data as { participant_id: string; edit_token: string; name: string };
    localStorage.setItem(`bill-guest-${cloudShareToken}`, JSON.stringify(guest)); setGuestParticipantId(guest.participant_id); setGuestName(guest.name); setError("");
    setSharedLoaded(true); setAdvanced(false);
    setDraft((current) => { const a = current.participantAdjustments?.[guest.participant_id]; const resultsView = new URLSearchParams(window.location.search).get("results") === "1"; return { ...current, ...(a || {}), step: resultsView ? 5 : 3 }; });
  }
  async function changeParticipant() {
    if (!supabase || !cloudShareToken || !guestParticipantId) return;
    const saved = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
    if (saved.edit_token) await supabase.rpc("release_bill_participant", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: saved.edit_token });
    localStorage.removeItem(`bill-guest-${cloudShareToken}`); setClaimedNames((names)=>names.filter((name)=>name.toLowerCase()!==guestName.toLowerCase())); setGuestParticipantId(""); setGuestName(""); setError("");
  }
  async function finishBill() {
    setConfirmAction("finish");
  }
  async function confirmFinishBill() {
    setConfirmAction(null);
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (supabase && userId && cloudBillId) {
      const { error: finishError } = await supabase.from("bills").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", cloudBillId);
      if (finishError) { setCloudError(finishError.message); setSaveStatus("offline"); setError("The bill could not be finished online. Please try again."); return; }
    }
    if (supabase && cloudShareToken && guestParticipantId) {
      const saved = JSON.parse(localStorage.getItem(`bill-guest-${cloudShareToken}`) || "{}") as { edit_token?: string };
      if (saved.edit_token) await supabase.rpc("release_bill_participant", { p_token: cloudShareToken, p_participant_id: guestParticipantId, p_edit_token: saved.edit_token });
      localStorage.removeItem(`bill-guest-${cloudShareToken}`);
    }
    localStorage.removeItem(STORAGE_KEY);
    if (userId) localStorage.removeItem(`cloud-bill-${userId}`);
    window.history.replaceState({}, "", window.location.pathname);
    setCloudBillId(""); setCloudShareToken(""); setOrganizerShareToken(""); setShareLink(""); setSharingEnabled(false);
    setGuestParticipantId(""); setGuestName(""); setClaimedNames([]); initializedPayments.current.clear();
    const nextBillId=crypto.randomUUID(); billIdentityRef.current=nextBillId;
    setDraft({ ...initialDraft, cloudId: nextBillId, theme: draft.theme, dateTime: localNow(), taxRate: draft.taxRate, tipMode: draft.tipMode, tipValue: draft.tipValue });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function personItemDetails(personId: string) {
    const details: Record<string, { cents: number; quantity: number; totalQuantity: number; percent: number }> = {};
    draft.expenses.forEach((item, itemIndex) => {
      const consumers = draft.people.filter((person) => item.consumers.includes(person.id)).map((person) => person.id);
      if (!consumers.length) return;
      const itemTotal = finalItemCents[item.id] || item.cents;
      const quantities = Object.fromEntries(consumers.map((id) => [id, Math.max(1, item.quantities?.[id] || 1)]));
      const allocation = allocateWeighted(itemTotal, consumers, quantities, itemIndex);
      const totalQuantity = Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);
      const quantity = quantities[personId] || 0;
      if (quantity) details[item.id] = { cents: allocation[personId] || 0, quantity, totalQuantity, percent: quantity / totalQuantity * 100 };
    });
    return details;
  }

  const visibleHistory = historyBills.filter((bill) => {
    const search = historySearch.trim().toLowerCase();
    const date = new Date(bill.occurred_at);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const customDate = historyCustomDate ? new Date(`${historyCustomDate}T00:00:00`) : null;
    const matchesDate = historyDateFilter === "all" ||
      (historyDateFilter === "today" && date >= startOfToday) ||
      (historyDateFilter === "week" && date >= startOfWeek) ||
      (historyDateFilter === "month" && date >= startOfMonth) ||
      (historyDateFilter === "custom" && customDate && date.getFullYear() === customDate.getFullYear() && date.getMonth() === customDate.getMonth() && date.getDate() === customDate.getDate());
    return Boolean(matchesDate) && (!search || (bill.title || "Untitled bill").toLowerCase().includes(search));
  }).sort((a,b)=>new Date(b.occurred_at).getTime()-new Date(a.occurred_at).getTime());
  const groupedHistory = visibleHistory.reduce<Record<string,CloudBill[]>>((groups,bill)=>{const key=new Intl.DateTimeFormat("en-US",{dateStyle:"long"}).format(new Date(bill.occurred_at));(groups[key]||=[]).push(bill);return groups;},{});
  const duplicateHistoryIds = (() => { const seen=new Set<string>(); const duplicates:string[]=[]; [...historyBills].sort((a,b)=>new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()).forEach((bill)=>{const key=billFingerprint(bill);if(seen.has(key))duplicates.push(bill.id);else seen.add(key);});return duplicates; })();
  async function removeHistoryDuplicates() {
    if (duplicateHistoryIds.length) setAppConfirm({ type: "remove-duplicates", ids: duplicateHistoryIds });
  }
  async function confirmAppAction() {
    if (!appConfirm || !supabase) return;
    setAppConfirmBusy(true); setError("");
    try {
      if (appConfirm.type === "save-local") {
        setCloudReady(true);
      } else if (appConfirm.type === "delete-group") {
        const { error: deleteError } = await supabase.from("saved_groups").delete().eq("id", appConfirm.id);
        if (deleteError) throw new Error(deleteError.message);
        setEditingGroup(null); await loadSavedGroups();
      } else if (appConfirm.type === "rename-bill") {
        const title=appConfirm.value.trim();
        if (!title) throw new Error("Enter a bill name.");
        const bill=historyBills.find((item)=>item.id===appConfirm.id);
        if (!bill) throw new Error("This bill is no longer available.");
        const updatedDraft=bill.settings.draft?{...bill.settings.draft,title}:undefined;
        const { error: renameError }=await supabase.from("bills").update({title,settings:{...bill.settings,draft:updatedDraft},updated_at:new Date().toISOString()}).eq("id",bill.id);
        if(renameError)throw new Error(renameError.message);
        setHistoryBills((current)=>current.map((item)=>item.id===bill.id?{...item,title,settings:{...item.settings,draft:updatedDraft}}:item));
      } else if (appConfirm.type === "delete-bill") {
        const { error: deleteError }=await supabase.from("bills").delete().eq("id",appConfirm.id);
        if(deleteError)throw new Error(deleteError.message);
        setHistoryBills((current)=>current.filter((item)=>item.id!==appConfirm.id));
        if(cloudBillId===appConfirm.id){const nextBillId=crypto.randomUUID();billIdentityRef.current=nextBillId;setDraft({...initialDraft,cloudId:nextBillId,dateTime:localNow(),theme:draft.theme});setCloudBillId("");setOrganizerShareToken("");setShareLink("");setSharingEnabled(false);localStorage.removeItem(`cloud-bill-${userId}`);}
      } else if (appConfirm.type === "remove-duplicates") {
        const { error: deleteError }=await supabase.from("bills").delete().in("id",appConfirm.ids);
        if(deleteError)throw new Error(deleteError.message);
        setHistoryBills((current)=>current.filter((bill)=>!appConfirm.ids.includes(bill.id)));
      }
      setAppConfirm(null);
    } catch(cause) {
      setError(cause instanceof Error?cause.message:"The action could not be completed.");
      setAppConfirm(null);
    } finally { setAppConfirmBusy(false); }
  }

  if (!ready) return null;
  return <main className={`${draft.theme} ${guestParticipantId ? "guest-mode" : ""}`}><div className="app-shell">
    <header className="topbar">
      <button className="icon-button brand-mark app-logo" aria-label="Start a new bill" onClick={clearDraft}><img src="/bill-splitter-icon.png" alt="" /></button>
      <div className="brand-copy"><strong>BILL SPLITTER</strong><span>Scan, split & settle restaurant bills</span><small className="version-badge">Version {APP_VERSION}</small></div>
      <button className="icon-button theme-button" aria-label="Toggle color theme" onClick={() => setDraft((d) => ({ ...d, theme: d.theme === "dark" ? "light" : "dark" }))}>{draft.theme === "dark" ? "☀" : "☾"}</button>
    </header>
    <nav className="progress five-steps" aria-label="Bill steps">{([[1,"Start"],[2,"Group"],[3,"Expenses"],[4,"Assign"],[5,"Results"]] as const).map(([n,label]) => <button key={n} className={`${draft.step === n ? "active" : ""} ${draft.step > n ? "done" : ""}`} onClick={() => n < draft.step && !guestParticipantId && goTo(n)}><b>{draft.step > n ? "✓" : n}</b><span>{label}</span></button>)}</nav>
    {preferencePersonId&&(()=>{const person=draft.people.find((p)=>p.id===preferencePersonId);if(!person)return null;return <div className="account-backdrop" onMouseDown={()=>setPreferencePersonId("")}><section className="panel preference-dialog" role="dialog" aria-modal="true" onMouseDown={(event)=>event.stopPropagation()}><button className="account-close" onClick={()=>setPreferencePersonId("")}>×</button><h2>{person.name}’s settlement preferences</h2><p>Choose people in preferred order. Tap again to remove.</p><div className="preference-person"><div>{draft.people.filter((other)=>other.id!==person.id).map((other)=>{const rank=(draft.settlementPreferences[person.id]||[]).indexOf(other.id);return <button className={rank>=0?"selected":""} key={other.id} onClick={()=>toggleSettlementPreference(person.id,other.id)}><i style={{background:other.color}}>{other.name[0].toUpperCase()}</i><span>{other.name}</span>{rank>=0&&<b>{rank+1}</b>}</button>})}</div></div><button className="google-button" onClick={()=>setPreferencePersonId("")}>Done</button></section></div>})()}
    {itemsPersonId&&(()=>{const person=draft.people.find((p)=>p.id===itemsPersonId);if(!person)return null;const details=personItemDetails(person.id);const items=draft.expenses.map((item,index)=>({item,index})).filter(({item})=>item.consumers.includes(person.id));return <div className="account-backdrop" onMouseDown={()=>setItemsPersonId("")}><section className="panel person-items-dialog" role="dialog" aria-modal="true" aria-label={`${person.name}'s items`} onMouseDown={(event)=>event.stopPropagation()}><button className="account-close" onClick={()=>setItemsPersonId("")}>×</button><h2>{person.name}’s items</h2><div className="person-items-list">{items.map(({item,index})=>{const detail=details[item.id];return <div key={item.id}><span><strong>{item.name||`Item ${index+1}`}</strong><small>{detail.quantity} of {detail.totalQuantity} · {detail.percent.toFixed(detail.percent%1?1:0)}%</small></span><b>{money(detail.cents)}</b></div>})}</div><button className="google-button" onClick={()=>setItemsPersonId("")}>Done</button></section></div>})()}
    {notice && <div className="notice-banner">{notice}</div>}
    {error && <div className="error-banner">{error}</div>}
    {cloudShareToken && !guestParticipantId && ready && <div className="account-backdrop"><section className="account-panel panel" role="dialog" aria-modal="true" aria-label="Choose your name"><img src="/bill-splitter-icon.png" alt="" /><h2>Who are you?</h2><p>Choose your name to join this shared bill. Names already in use are locked.</p><div className="join-people">{draft.people.map((person) => { const occupied=claimedNames.some((name)=>name.toLowerCase()===person.name.toLowerCase()); return <button key={person.id} disabled={occupied} onClick={() => claimParticipant(person.name)}><span style={{background:person.color}}>{person.name[0]}</span>{person.name}{occupied&&<small>In use</small>}</button>})}</div></section></div>}
    {appConfirm&&(()=>{const destructive=appConfirm.type==="delete-group"||appConfirm.type==="delete-bill"||appConfirm.type==="remove-duplicates";const bill=appConfirm.type==="delete-bill"?historyBills.find((item)=>item.id===appConfirm.id):null;const title=appConfirm.type==="save-local"?"Save this bill?":appConfirm.type==="delete-group"?"Delete this group?":appConfirm.type==="rename-bill"?"Rename this bill":appConfirm.type==="delete-bill"?"Delete this bill?":"Remove duplicate bills?";const message=appConfirm.type==="save-local"?"Save this bill securely to your account so you can open it on other devices.":appConfirm.type==="delete-group"?"This saved group will be permanently removed.":appConfirm.type==="rename-bill"?"Enter a new name for this saved bill.":appConfirm.type==="delete-bill"?`${bill?.title||"This bill"} will be permanently deleted. This cannot be undone.`:`The newest complete copy will be kept and ${appConfirm.ids.length} duplicate ${appConfirm.ids.length===1?"record":"records"} will be removed.`;const action=appConfirm.type==="save-local"?"Save bill":appConfirm.type==="rename-bill"?"Save name":appConfirm.type==="remove-duplicates"?"Remove duplicates":"Delete";return <div className="account-backdrop confirm-backdrop" role="presentation" onMouseDown={()=>!appConfirmBusy&&setAppConfirm(null)}><section className={`panel confirm-dialog unified-confirm ${destructive?"destructive":""}`} role="alertdialog" aria-modal="true" aria-labelledby="unified-confirm-title" onMouseDown={(event)=>event.stopPropagation()}><div className="confirm-symbol">{destructive?"!":appConfirm.type==="rename-bill"?"✎":"✓"}</div><h2 id="unified-confirm-title">{title}</h2><p>{message}</p>{appConfirm.type==="rename-bill"&&<input autoFocus value={appConfirm.value} onChange={(event)=>setAppConfirm({...appConfirm,value:event.target.value})} onKeyDown={(event)=>event.key==="Enter"&&void confirmAppAction()} placeholder="Bill name"/>}<div className="confirm-actions"><button className="auth-secondary" disabled={appConfirmBusy} onClick={()=>setAppConfirm(null)}>Cancel</button><button className={destructive?"confirm-danger":"confirm-primary"} disabled={appConfirmBusy||(appConfirm.type==="rename-bill"&&!appConfirm.value.trim())} onClick={()=>void confirmAppAction()}>{appConfirmBusy?"Please wait…":action}</button></div></section></div>})()}
    {confirmAction && <div className="account-backdrop confirm-backdrop" role="presentation" onMouseDown={()=>setConfirmAction(null)}><section className="panel confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event)=>event.stopPropagation()}><div className="confirm-symbol">{confirmAction==="finish"?"✓":"↻"}</div><h2 id="confirm-title">{confirmAction==="finish"?"Finish this bill?":"Start a new bill?"}</h2><p>{confirmAction==="finish"?"This bill will be cleared from this device and your name will become available. The shared bill stays available to everyone else.":"Your current draft will be cleared from this device so you can begin a new bill."}</p><div className="confirm-actions"><button className="auth-secondary" onClick={()=>setConfirmAction(null)}>Cancel</button><button className="confirm-primary" onClick={()=>confirmAction==="finish"?void confirmFinishBill():confirmClearDraft()}>{confirmAction==="finish"?"Finish bill":"Start new bill"}</button></div></section></div>}
    {guestName && <div className="guest-banner">Viewing as <strong>{guestName}</strong><button onClick={changeParticipant}>Change person</button></div>}
    {accountOpen && <div className="account-backdrop" role="presentation" onMouseDown={() => setAccountOpen(false)}><section className="account-panel panel" role="dialog" aria-modal="true" aria-label="Account" onMouseDown={(event) => event.stopPropagation()}><button className="account-close" onClick={() => setAccountOpen(false)}>×</button><img src="/bill-splitter-icon.png" alt="" /><h2>{userEmail ? "Your account" : "Save your bills everywhere"}</h2>{userEmail ? <><p>Logged in as <strong>{userEmail}</strong></p><button className="google-button" onClick={loadHistory}>My Bills</button><button className="restaurant-settings-button" onClick={()=>{setAccountOpen(false);setRestaurantOpen(true);}}>{ownRestaurant?"Restaurant & payment settings":"Register your restaurant"}</button><button className="auth-secondary" onClick={signOut}>Log out</button></> : supabaseConfigured ? <><button className="google-button" onClick={signInWithGoogle}>Continue with Google</button><div className="auth-divider"><span>or</span></div><label><span>Email address</span><input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@example.com" /></label><button className="email-button" onClick={sendMagicLink}>Email me a login link</button>{authMessage && <p className="auth-message">{authMessage}</p>}<button className="auth-secondary" onClick={() => setAccountOpen(false)}>Continue as guest</button></> : <><p>Cloud accounts are ready to connect. Add your Supabase Project URL and public anonymous key to enable Google and email login.</p><div className="local-mode">Local mode active</div><button className="auth-secondary" onClick={() => setAccountOpen(false)}>Continue as guest</button></>}</section></div>}
    {restaurantOpen&&<div className="account-backdrop restaurant-backdrop" onMouseDown={()=>setRestaurantOpen(false)}><section className="panel restaurant-dialog" role="dialog" aria-modal="true" aria-label="Restaurant and payment settings" onMouseDown={(event)=>event.stopPropagation()}><button className="account-close" onClick={()=>setRestaurantOpen(false)}>×</button><span className="eyebrow">RESTAURANT ACCOUNT</span><h2>{ownRestaurant?"Restaurant & payment settings":"Register your restaurant"}</h2><p>Customers will see this information before paying.</p><div className="restaurant-form"><label><span>Restaurant name</span><input value={restaurantForm.name} onChange={(event)=>setRestaurantForm({...restaurantForm,name:event.target.value})} placeholder="Test Store"/></label><label><span>Branch or location name</span><input value={restaurantForm.locationName} onChange={(event)=>setRestaurantForm({...restaurantForm,locationName:event.target.value})} placeholder="Downtown (optional)"/></label><label className="restaurant-wide"><span>Street address</span><input value={restaurantForm.address} onChange={(event)=>setRestaurantForm({...restaurantForm,address:event.target.value})} placeholder="123 Main Street"/></label><label><span>City</span><input value={restaurantForm.city} onChange={(event)=>setRestaurantForm({...restaurantForm,city:event.target.value})}/></label><label><span>State</span><input value={restaurantForm.region} onChange={(event)=>setRestaurantForm({...restaurantForm,region:event.target.value})} placeholder="CA"/></label><label><span>ZIP code</span><input value={restaurantForm.postalCode} onChange={(event)=>setRestaurantForm({...restaurantForm,postalCode:event.target.value})}/></label><label><span>Business phone</span><input value={restaurantForm.phone} onChange={(event)=>setRestaurantForm({...restaurantForm,phone:event.target.value})}/></label></div><button className="google-button" disabled={restaurantBusy} onClick={()=>void saveRestaurant()}>{restaurantBusy?"Saving…":ownRestaurant?"Save restaurant":"Create restaurant profile"}</button>{paypalMessage&&<p className="restaurant-message">{paypalMessage}</p>}{ownRestaurant&&<><div className="restaurant-paypal-status"><span className="paypal-mark">P</span><div><strong>PayPal Business</strong><small>{paypalAccount?.status==="connected"?"Connected and ready for sandbox testing.":"Connect the account that should receive customer payments."}</small></div><button disabled={paypalBusy} onClick={()=>void connectPayPal()}>{paypalAccount?.status==="connected"?"Connected ✓":paypalBusy?"Opening…":"Connect PayPal"}</button></div>{restaurantQrCode&&<div className="restaurant-qr"><img src={restaurantQrCode} alt={`Permanent QR code for ${ownRestaurant.name}`}/><div><strong>Permanent restaurant QR</strong><small>Print and display this code. Customers scan it before scanning their receipt.</small><button onClick={()=>navigator.clipboard?.writeText(`${window.location.origin}/?restaurant=${ownRestaurant.publicCode}`)}>Copy restaurant link</button></div></div>}</>}</section></div>}
    {pendingRestaurant&&<div className="account-backdrop restaurant-confirm-backdrop"><section className="panel restaurant-confirm" role="alertdialog" aria-modal="true"><span className="restaurant-confirm-icon">⌂</span><h2>Paying this restaurant?</h2><strong>{pendingRestaurant.name}</strong>{pendingRestaurant.locationName&&<span>{pendingRestaurant.locationName}</span>}<p>{pendingRestaurant.address}<br/>{pendingRestaurant.city}, {pendingRestaurant.region} {pendingRestaurant.postalCode}</p>{!pendingRestaurant.paypalConnected&&<div className="restaurant-not-ready">This restaurant has not finished connecting PayPal yet. You can split the bill, but online payment is unavailable.</div>}<div className="confirm-actions"><button className="auth-secondary" onClick={()=>{setPendingRestaurant(null);const url=new URL(window.location.href);url.searchParams.delete("restaurant");window.history.replaceState({},"",url);}}>Not this restaurant</button><button className="confirm-primary" onClick={confirmRestaurant}>Confirm restaurant</button></div></section></div>}
    {pendingCloudDraft && <div className="account-backdrop"><section className="account-panel cloud-prompt panel" role="dialog" aria-modal="true" aria-label="Cloud bill found"><div className="cloud-prompt-icon">☁</div><h2>Cloud bill found</h2><p>Would you like to open your latest saved bill? Your current draft will remain safely stored on this device.</p><div className="cloud-prompt-actions"><button className="auth-secondary" onClick={()=>{setCloudBillId("");setPendingCloudDraft(null);setCloudReady(true);}}>Keep current draft</button><button className="google-button" onClick={()=>{applyingRemote.current=true;setDraft(pendingCloudDraft);setPendingCloudDraft(null);setCloudReady(true);setTimeout(()=>{applyingRemote.current=false;},0);}}>Open cloud bill</button></div></section></div>}
    {groupsOpen && <div className="account-backdrop" role="presentation" onMouseDown={() => { setGroupsOpen(false); setEditingGroup(null); }}><section className="groups-panel panel" role="dialog" aria-modal="true" aria-label="Saved groups" onMouseDown={(event) => event.stopPropagation()}><button className="account-close" onClick={() => { setGroupsOpen(false); setEditingGroup(null); }}>×</button><h2>{editingGroup ? (editingGroup.id ? "Edit saved group" : "Save new group") : "Saved groups"}</h2>
      {!userId ? <div className="group-signin"><p>Log in to securely save groups with phone numbers and Venmo usernames.</p><button className="google-button" onClick={() => { setGroupsOpen(false); setAccountOpen(true); }}>Log in</button></div> : editingGroup ? <div className="group-editor">
        <label><span>Group name</span><input value={editingGroup.name} onChange={(event)=>setEditingGroup({...editingGroup,name:event.target.value})} placeholder="Family, friends, coworkers..." /></label>
        <p>Everyone is selected by default. Uncheck anyone who is not joining this bill.</p>
        <div className="group-member-list">{editingGroup.people.map((person,index)=><article key={person.id}><input className="group-check" type="checkbox" checked={person.selected!==false} onChange={(event)=>setEditingGroup({...editingGroup,people:editingGroup.people.map((member,i)=>i===index?{...member,selected:event.target.checked}:member)})}/><div className="group-member-fields"><input value={person.name} onChange={(event)=>setEditingGroup({...editingGroup,people:editingGroup.people.map((member,i)=>i===index?{...member,name:event.target.value}:member)})} placeholder="Name"/><input type="tel" value={person.phone} onChange={(event)=>setEditingGroup({...editingGroup,people:editingGroup.people.map((member,i)=>i===index?{...member,phone:event.target.value}:member)})} placeholder="Phone number"/><div className="group-venmo"><span>@</span><input value={person.venmoUsername} onChange={(event)=>setEditingGroup({...editingGroup,people:editingGroup.people.map((member,i)=>i===index?{...member,venmoUsername:event.target.value.replace(/^@/,"")}:member)})} placeholder="Venmo username"/></div></div></article>)}</div>
        <div className="group-editor-actions">{editingGroup.id&&<button className="danger-button" onClick={()=>void deleteSavedGroup(editingGroup.id)}>Delete</button>}<button className="auth-secondary" onClick={()=>setEditingGroup(null)}>Back</button><button className="auth-secondary" disabled={groupBusy} onClick={()=>void saveEditingGroup()}>{groupBusy?"Saving…":"Save changes"}</button><button className="google-button" disabled={editingGroup.people.filter((person)=>person.selected!==false).length<2} onClick={()=>chooseGroup(editingGroup)}>Use selected</button></div>
      </div> : savedGroups.length ? <div className="saved-group-cards">{savedGroups.map((group)=><article key={group.id}><button className="saved-group-main" onClick={()=>setEditingGroup({...group,people:group.people.map((person)=>({...person,selected:true}))})}><strong>{group.name}</strong><span>{group.people.length} people</span><small>{group.people.map((person)=>person.name).join(" · ")}</small></button></article>)}</div> : <div className="group-placeholder"><p>No saved groups yet.</p><p>Add people to this bill and press <strong>Save group</strong>.</p></div>}
    </section></div>}
    {historyOpen && <div className="account-backdrop history-backdrop" role="presentation" onMouseDown={() => setHistoryOpen(false)}><section className="history-panel panel" role="dialog" aria-modal="true" aria-label="My Bills" onMouseDown={(event) => event.stopPropagation()}>
      <div className="history-header"><div><span className="eyebrow">CLOUD HISTORY</span><h2>My Bills</h2></div><button className="account-close" onClick={() => setHistoryOpen(false)}>×</button></div>
      <div className="history-tools"><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search bills"/><select value={historyDateFilter} onChange={(event)=>setHistoryDateFilter(event.target.value as typeof historyDateFilter)}><option value="all">All dates</option><option value="today">Today</option><option value="week">This week</option><option value="month">This month</option><option value="custom">Choose date</option></select>{historyDateFilter==="custom"&&<input type="date" value={historyCustomDate} onChange={(event)=>setHistoryCustomDate(event.target.value)} aria-label="History date"/>}{duplicateHistoryIds.length>0&&<button className="remove-duplicates" onClick={()=>void removeHistoryDuplicates()}>Remove {duplicateHistoryIds.length} duplicates</button>}</div>
      <div className="history-list">{visibleHistory.length ? Object.entries(groupedHistory).map(([date,bills])=><section className="history-date-group" key={date}><h3>{date}</h3>{bills.map((bill) => { const billDraft = bill.settings?.draft; return <article className="history-row" key={bill.id}><button className="history-main" onClick={() => openHistoryBill(bill)} disabled={!billDraft}><strong>{bill.title || "Untitled bill"}</strong><span>{displayDate(bill.occurred_at)} · {billDraft?.people.length || 0} people · {billDraft?.expenses.length || 0} items · {money(savedDraftTotal(billDraft))}</span><em>{bill.status==="archived"?"Finished":bill.status}</em></button><div className="history-actions"><button onClick={() => openHistoryBill(bill)}>{bill.status==="archived"?"View":"Open"}</button><button onClick={() => duplicateHistoryBill(bill)}>Duplicate</button><button onClick={() => renameHistoryBill(bill)}>Rename</button>{bill.status === "archived" ? <button onClick={() => setHistoryStatus(bill, "open")}>Restore</button> : <><button onClick={() => setHistoryStatus(bill, bill.status === "locked" ? "open" : "locked")}>{bill.status === "locked" ? "Unlock" : "Lock"}</button><button onClick={() => setHistoryStatus(bill, "archived")}>Finish</button></>}<button className="danger" onClick={() => deleteHistoryBill(bill)}>Delete</button></div></article>})}</section>) : <div className="history-empty"><strong>No bills found</strong><span>Try another name or date.</span></div>}</div>
    </section></div>}
    {historyPreviewBill&&(()=>{const billDraft=historyPreviewBill.settings?.draft;return <div className="account-backdrop history-backdrop" onMouseDown={()=>setHistoryPreviewBill(null)}><section className="panel history-preview" role="dialog" aria-modal="true" aria-label="Finished bill" onMouseDown={(event)=>event.stopPropagation()}><button className="account-close" onClick={()=>setHistoryPreviewBill(null)}>×</button><span className="eyebrow">FINISHED BILL</span><h2>{historyPreviewBill.title||"Untitled bill"}</h2><p>{displayDate(historyPreviewBill.occurred_at)}</p><div className="history-preview-summary"><div><span>People</span><strong>{billDraft?.people.length||0}</strong></div><div><span>Items</span><strong>{billDraft?.expenses.length||0}</strong></div><div><span>Final total</span><strong>{money(savedDraftTotal(billDraft))}</strong></div></div><div className="history-preview-actions"><button className="auth-secondary" onClick={()=>setHistoryPreviewBill(null)}>Close</button><button className="google-button" onClick={()=>void duplicateHistoryBill(historyPreviewBill)}>Duplicate as new bill</button></div></section></div>})()}
    {draft.step === 1 && <section className="start-page">
      <div className="start-options">
        <article className="panel start-option start-guest"><div><h2>Split &amp; Pay as a guest</h2><p>Add people, scan or enter the restaurant bill, assign items, and share the final results. No account required.</p></div><button className="calculate" onClick={()=>goTo(2)}>Continue as guest <span className="nav-arrow">›</span></button></article>
        <article className={`panel start-option start-account ${userId?"account-on":"account-off"}`}><div><h2>Saved groups &amp; bill history</h2><p>{userId?<>Logged in as <strong>{userEmail}</strong>. Your saved account features are available.</>:"Log in to reuse groups and keep your bill history available on your devices."}</p></div><div className="start-account-actions"><button className="saved-feature-button" disabled={!userId} onClick={()=>{setEditingGroup(null);setGroupsOpen(true);}}>Saved groups</button><button className="saved-feature-button" disabled={!userId} onClick={()=>void loadHistory()}>Saved bills &amp; history</button>{userId?<><button className="google-button" onClick={()=>goTo(2)}>Start a new bill</button><button className="auth-secondary start-signout" onClick={()=>void signOut()}>Log out</button></>:<button className="google-button" onClick={()=>setAccountOpen(true)}>Log in</button>}</div></article>
      </div>
    </section>}

    {draft.step === 2 && <>
      <section className="panel title-time single-title"><div className="title-field"><input disabled={Boolean(guestParticipantId)} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Restaurant or bill name (optional)" /><div className="saved-title-row"><small>Saved as: {savedTitle}</small></div></div></section>
      {draft.restaurant&&<section className="panel bill-restaurant-card"><span className="restaurant-confirm-icon">⌂</span><div><small>PAYING RESTAURANT</small><strong>{draft.restaurant.name}{draft.restaurant.locationName?` — ${draft.restaurant.locationName}`:""}</strong><span>{draft.restaurant.address}, {draft.restaurant.city}, {draft.restaurant.region} {draft.restaurant.postalCode}</span></div><button onClick={()=>setDraft((current)=>{const next={...current};delete next.restaurant;return next;})}>Change</button></section>}
      <section className="panel section-panel">
        <div className="participant-control-row"><button className="section-heading groups-trigger" onClick={() => { if (guestParticipantId) return; if (!userId) setAccountOpen(true); else { setEditingGroup(null); setGroupsOpen(true); } }} disabled={Boolean(guestParticipantId)}><strong>Who’s splitting?</strong><span className="collapse-chevron" aria-hidden="true">⌄</span></button><strong className="group-people-count">{draft.people.length} people</strong></div>
        {!guestParticipantId && <div className="add-row"><div className="contact-entry"><input value={personName} onChange={(e) => setPersonName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPerson()} placeholder="Enter a name" autoComplete="off" />{contactSuggestions.length > 0 && <div className="contact-suggestions">{contactSuggestions.map((contact) => <button key={contact.id} onClick={() => addSavedContact(contact)}><span>{contact.name[0].toUpperCase()}</span><strong>{contact.name}</strong>{contact.phone && <small>{contact.phone}</small>}</button>)}</div>}</div><div className="add-action"><button className="add-button" onClick={addPerson}>Add</button></div></div>}
        {draft.people.length ? <div className="people-list">{draft.people.map((p) => <button className="person-chip" disabled={Boolean(guestParticipantId)} key={p.id} onClick={() => removePerson(p.id)}><span style={{background:p.color}}>{p.name[0].toUpperCase()}</span><em>{p.name}</em>{!guestParticipantId&&<b>×</b>}</button>)}</div> : null}
        {!guestParticipantId&&<div className="group-footer"><p>{draft.people.length<2?"Add at least two people.":`${draft.people.length} people ready.`}</p><button className="group-save-compact" onClick={saveCurrentGroup}>Save group</button></div>}
      </section>
      <section className="panel section-panel page-one-expenses" aria-hidden="true">
        <div className="section-heading"><div><span className="step-number">2</span><h2>Add expenses</h2></div><span className="amount-badge">{money(subtotal)}</span></div>
        {draft.expenses.length > 0 && <div className="simple-items">{draft.expenses.map((item,index) => { const owner=item.addedByName || draft.people.find((p)=>p.id===item.addedBy)?.name || (item.addedBy === guestParticipantId ? guestName : "Organizer"); const canEdit=!guestParticipantId||item.addedBy===guestParticipantId; return <article key={item.id}><div><span><strong className={item.name ? "" : "generated-name"}>{item.name || `Item ${index+1}`}</strong><small>Added by {owner}</small></span><span>{money(item.cents)}</span></div>{canEdit&&<button onClick={() => { void deleteExpense(item.id); }} aria-label={`Remove ${item.name || `Item ${index+1}`}`}>×</button>}</article>})}</div>}
        <div className="expense-entry simple-entry"><div className="expense-inputs"><input value={itemName} onChange={(e)=>setItemName(e.target.value)} placeholder={`Item name (optional)`} /><div className="money-input"><span>$</span><input inputMode="decimal" value={itemAmount} onChange={(e)=>setItemAmount(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&addExpense()} placeholder="0.00" /></div></div><button className="wide-secondary" onClick={addExpense}>＋ Add item</button></div>
      </section>
      {!guestParticipantId&&<section className={`panel share-card sharing-panel ${sharingEnabled?"sharing-open":"sharing-closed"}`}><div className="sharing-switch-row"><span><strong>Bill sharing</strong>{sharingEnabled&&<small>Friends can add their own items and choose what they used.</small>}</span><button className={`switch ${sharingEnabled ? "on" : ""}`} disabled={sharing||!draft.people.length} onClick={()=>userId?void toggleSharing():requestSharingSignIn()} aria-label="Turn bill sharing on or off"><i></i></button></div>{sharingEnabled&&<>{!userId&&<button className="share-sign-in" onClick={requestSharingSignIn}>Log in to create a private link</button>}{sharing && <p className="share-status">Creating your private link…</p>}{shareLink && <><button className="share-bill-button" onClick={()=>void shareBillInvite()}>Share bill</button><div className="share-content">{qrCode && <div className="qr-wrap"><img src={qrCode} alt="QR code for the private bill link" /><small>Scan to join this bill</small></div>}<div className="share-link"><input readOnly value={shareLink} aria-label="Private bill link" /><button onClick={() => navigator.clipboard?.writeText(shareLink)}>Copy link</button><small>Anyone with this private link can open the bill.</small></div></div></>}</>}</section>}
      <button className="calculate" disabled={draft.people.length < 2} onClick={()=>goTo(3)}>Next: Add expenses <span className="nav-arrow">›</span></button>
    </>}

    {draft.step === 3 && <>
      <section className="panel section-panel receipt-scanner">
        <div className="section-heading"><div><span className="step-number">⌁</span><h2>Scan receipt</h2></div>{scanBusy&&<span className="amount-badge">{scanProgress}%</span>}</div>
        <p className="empty-note">Take a clear, straight photo. You will review every detected item before it is added.</p>
        <label className={`wide-secondary scan-button ${scanBusy?"disabled":""}`}>📷 {scanBusy?"Reading receipt…":"Take photo or upload"}<input type="file" accept="image/*" capture="environment" disabled={scanBusy} onChange={(event)=>{void scanReceipt(event.target.files?.[0]);event.currentTarget.value="";}} /></label>
        {scanBusy&&<div className="scan-progress"><i style={{width:`${scanProgress}%`}}></i></div>}
        {scanLines.length>0&&<div className="scan-review"><h3>Review detected items</h3>{scanLines.map((line,index)=><div className="scan-line" key={index}><input type="checkbox" checked={line.selected} onChange={(event)=>setScanLines((lines)=>lines.map((entry,i)=>i===index?{...entry,selected:event.target.checked}:entry))}/><input value={line.name} placeholder={`Item ${index+1}`} onChange={(event)=>setScanLines((lines)=>lines.map((entry,i)=>i===index?{...entry,name:event.target.value}:entry))}/><div className="money-input"><span>$</span><input inputMode="decimal" value={(line.cents/100).toFixed(2)} onChange={(event)=>setScanLines((lines)=>lines.map((entry,i)=>i===index?{...entry,cents:toCents(event.target.value)}:entry))}/></div></div>)}<button className="add-button scan-add" onClick={addScannedItems}>Add selected items</button></div>}
      </section>
      <p className="manual-entry-divider">or enter items manually</p>
      <section className="panel section-panel">
        {draft.expenses.length > 0 && <div className="simple-items added-items-list items-before-entry">{draft.expenses.map((item,index) => { const owner=item.addedByName || draft.people.find((p)=>p.id===item.addedBy)?.name || (item.addedBy === guestParticipantId ? guestName : "Organizer"); const canEdit=!guestParticipantId||item.addedBy===guestParticipantId; return <article key={item.id}><div><span><strong className={item.name ? "" : "generated-name"}>{item.name || `Item ${index+1}`}</strong><small>Added by {owner}</small></span><span>{money(item.cents)}</span></div>{canEdit&&<button onClick={() => { void deleteExpense(item.id); }} aria-label={`Remove ${item.name || `Item ${index+1}`}`}>×</button>}</article>})}</div>}
        <div className="section-heading entry-items-heading"><div><span className="step-number">+</span><h2>Enter items</h2><small className="item-count">{draft.expenses.length} {draft.expenses.length===1?"item":"items"}</small></div><span className="amount-badge">{money(subtotal)}</span></div>
        <div className="expense-entry simple-entry"><div className="expense-inputs"><input value={itemName} onChange={(e)=>setItemName(e.target.value)} placeholder="Item name (optional)" /><div className="money-input"><span>$</span><input inputMode="decimal" value={itemAmount} onChange={(e)=>setItemAmount(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&addExpense()} placeholder="0.00" /></div></div><button className="wide-secondary" onClick={addExpense}>＋ Add item</button></div>
      </section>
      <section className="adjustment-cards control-stack" aria-label="Tax, tip and discount">
        <div className="setting-card adjustment-card"><div className="adjustment-card-head"><div className="adjustment-card-title"><button className={`switch ${draft.taxEnabled?"on":""}`} onClick={()=>setDraft({...draft,taxEnabled:!draft.taxEnabled})} aria-label="Turn tax on or off"><i></i></button><strong>Tax</strong></div>{draft.taxEnabled&&<strong className="adjustment-head-amount">{money(sharedMode?ownReceiptTax:totals.tax)}</strong>}</div>{draft.taxEnabled&&<label className="adjustment-entry tax-rate-entry"><span>Percent</span><div className="compact-value"><DecimalInput value={draft.taxRate} onValueChange={(taxRate)=>setDraft({...draft,taxRate})} /><span>%</span></div></label>}</div>
        <div className="setting-card adjustment-card tip-adjustment-card"><div className="adjustment-card-head"><div className="adjustment-card-title"><button className={`switch ${draft.tipEnabled?"on":""}`} onClick={()=>setDraft({...draft,tipEnabled:!draft.tipEnabled})} aria-label="Turn tip on or off"><i></i></button><strong>Tip</strong></div>{draft.tipEnabled&&<strong className="adjustment-head-amount">{money(sharedMode?ownReceiptTip:totals.tip)}</strong>}</div>{draft.tipEnabled&&<><div className="tip-entry-line"><div className="segment"><button className={draft.tipMode==="percent"?"active":""} onClick={()=>setDraft({...draft,tipMode:"percent",tipValue:0})}>%</button><button className={draft.tipMode==="amount"?"active":""} onClick={()=>setDraft({...draft,tipMode:"amount",tipValue:0})}>$</button></div>{draft.tipMode==="percent"?<div className="compact-value"><DecimalInput value={draft.tipValue} onValueChange={(tipValue)=>setDraft({...draft,tipValue})} /><span>%</span></div>:<div className="money-input"><span>$</span><DecimalInput value={draft.tipValue/100} onValueChange={(value)=>setDraft({...draft,tipValue:Math.round(value*100)})} placeholder="0.00" /></div>}</div><div className="tip-presets" aria-label="Quick tip percentages">{[10,15,18,20,25].map((percent)=><button key={percent} className={draft.tipMode==="percent"&&draft.tipValue===percent?"active":""} onClick={()=>setDraft({...draft,tipEnabled:true,tipMode:"percent",tipValue:percent})}>{percent}%</button>)}</div></>}</div>
        <div className="setting-card adjustment-card"><div className="adjustment-card-head"><div className="adjustment-card-title"><button className={`switch ${draft.discountEnabled?"on":""}`} onClick={()=>setDraft({...draft,discountEnabled:!draft.discountEnabled})} aria-label="Turn discount on or off"><i></i></button><strong>Discount</strong></div></div>{draft.discountEnabled&&<><div className="adjustment-entry discount-timing-entry"><span>Apply</span><div className="segment"><button className={draft.discountTiming==="before"?"active":""} onClick={()=>setDraft({...draft,discountTiming:"before"})}>Before</button><button className={draft.discountTiming==="after"?"active":""} onClick={()=>setDraft({...draft,discountTiming:"after"})}>After</button></div><small>{draft.discountTiming==="before"?"The discount lowers the subtotal before tax and tip are calculated.":"Tax and tip are calculated first, then the discount is subtracted."}</small></div><label className="adjustment-calculated adjustment-discount-entry"><span>Amount</span><div className="money-input"><span>$</span><DecimalInput value={draft.discountCents/100} onValueChange={(value)=>setDraft((current)=>({...current,discountCents:Math.round(value*100)}))} placeholder="0.00" /></div></label></>}</div>
      </section>
      <div className="page-actions">{!guestParticipantId&&<button className="back-button" onClick={()=>goTo(2)}><span className="nav-arrow">‹</span> Back</button>}<button className="calculate" disabled={!draft.expenses.length} onClick={()=>goTo(4)}>Next: Assign items <span className="nav-arrow">›</span></button></div>
    </>}

    {draft.step === 4 && <>
      <p className="assign-instruction">{guestParticipantId?"Review everyone sharing each item. You can change only your own selection and quantity.":"Choose everyone who shared each item."}</p>
      <section className="assignment-list">{draft.expenses.map((item,index) => {
        const isAll = item.consumers.length === draft.people.length;
        const guestPersonId = draft.people.find((person) => person.name === guestName)?.id;
        return <article className={`panel assignment-card ${!item.consumers.length ? "unassigned" : ""}`} key={item.id}>
          <header><div><span>ITEM {index+1}</span><strong className={item.name ? "" : "generated-name"}>{item.name || `Item ${index+1}`}</strong><small>Added by {item.addedByName || (item.addedBy===guestParticipantId?guestName:"Organizer")}</small></div><div className="assignment-prices"><b>{money(item.cents)}</b>{(finalItemCents[item.id] || item.cents)!==item.cents&&<small>With tax, tip &amp; discount {money(finalItemCents[item.id] || item.cents)}</small>}</div></header>
          <div className="assignment-options">{!guestParticipantId&&<button className={`all-option ${isAll ? "selected" : ""}`} onClick={()=>toggleAll(item.id)}><i>{isAll ? "✓" : ""}</i><strong>All</strong></button>}{draft.people.map((p) => {const checked=item.consumers.includes(p.id);const quantity=Math.max(1,item.quantities?.[p.id]||1);const canEditPerson=!guestParticipantId||p.id===guestPersonId;return <div className={`assignment-person ${canEditPerson?"":"read-only"}`} key={p.id}><button disabled={!canEditPerson} className={checked?"selected person-selected":""} style={checked&&canEditPerson?{borderColor:p.color,borderWidth:2,color:p.color,boxShadow:`inset 0 0 18px ${p.color}24, 0 0 0 1px ${p.color}55`}:undefined} onClick={()=>toggleConsumer(item.id,p.id)}><i style={checked&&canEditPerson?{background:p.color,borderColor:p.color,color:"#132026"}:undefined}>{checked?"✓":""}</i><span style={{background:canEditPerson?p.color:"var(--muted)"}}>{p.name[0].toUpperCase()}</span><strong>{p.name}</strong></button>{checked&&(canEditPerson?<div className="quantity-stepper" style={{borderColor:p.color}}><button onClick={()=>setItemQuantity(item.id,p.id,quantity-1)} aria-label={`Decrease ${p.name}'s quantity`}>−</button><b>{quantity}</b><button onClick={()=>setItemQuantity(item.id,p.id,quantity+1)} aria-label={`Increase ${p.name}'s quantity`}>+</button></div>:<span className="quantity-readonly">Qty {quantity}</span>)}</div>})}</div>
          {!item.consumers.length && <small className="unassigned-label">Choose at least one person</small>}
        </article>})}</section>
      <div className="page-actions"><button className="back-button" onClick={()=>goTo(3)}><span className="nav-arrow">‹</span> Back</button><button className="calculate" disabled={!guestParticipantId&&unassigned>0} onClick={()=>goTo(5)}>Next: Results <span className="nav-arrow">›</span></button></div>
    </>}

    {draft.step === 5 && <>
      <section className="page-title result-title"><span className="eyebrow">STEP 5 OF 5</span><h1>{savedTitle}</h1><p>{displayDate(draft.dateTime)} · {draft.people.length} people · {draft.expenses.length} items</p></section>
      {unassigned>0&&<section className="panel unassigned-results-warning"><div className="warning-symbol">!</div><h2>One or more items have not been selected by anyone.</h2><p>Assign every item before viewing the final amounts.</p><button onClick={()=>goTo(4)}>Go back and assign items</button></section>}
      <section className={`panel result-overview ${unassigned>0?"results-hidden":""}`}>
        <div className="grand-total"><span>Final bill total</span><strong className={`original-bill-total ${draft.totalOverrideCents>totals.calculatedGrand?"different-total-active":""}`}>{money(totals.calculatedGrand)}</strong>{!guestParticipantId&&<label className="different-total-box"><span>Want to pay a different amount?</span><div className="money-input"><span>$</span><input key={`${totals.calculatedGrand}-${draft.totalOverrideCents}`} inputMode="decimal" defaultValue={draft.totalOverrideCents ? (draft.totalOverrideCents / 100).toFixed(2) : ""} placeholder="Enter amount" aria-label="Different total amount" onBlur={(event)=>{if(!applyDifferentTotal(event.currentTarget.value)) event.currentTarget.value=draft.totalOverrideCents?(draft.totalOverrideCents/100).toFixed(2):"";}} onKeyDown={(event)=>{if(event.key==="Enter") event.currentTarget.blur();}} /></div></label>}<small>{money(subtotal)} subtotal · {money(totals.tax)} tax · {money(totals.tip)} tip{totals.discount?` · −${money(totals.discount)} discount ${draft.discountTiming}`:""}</small></div>
        {draft.restaurant&&<div className="result-restaurant"><span>Paying restaurant</span><strong>{draft.restaurant.name}{draft.restaurant.locationName?` — ${draft.restaurant.locationName}`:""}</strong><small>{draft.restaurant.address}, {draft.restaurant.city}, {draft.restaurant.region}</small></div>}
        <div className="result-summary">
          <div><span>Total paid</span><strong>{money(totals.paidTotal)}</strong></div>
          <div><span>Total paying merchant</span><strong>{money(Object.values(paymentPlan.merchantPayments).reduce((sum,cents)=>sum+cents,0))}</strong></div>
          <div><span>Total settlement</span><strong>{money(paymentPlan.settlements.reduce((sum,settlement)=>sum+settlement.cents,0))}</strong></div>
        </div>
      </section>
      {!guestParticipantId&&userId&&ownRestaurant&&<section className="panel paypal-connect-card">
        <div className="paypal-connect-copy">
          <span className="paypal-mark">P</span>
          <div><strong>Receive payments with PayPal</strong><small>{paypalAccount?.status==="connected"?"Connected. Payments will go directly to your PayPal Business account.":"Connect your PayPal Business account before accepting payments from this bill."}</small></div>
        </div>
        <button className={paypalAccount?.status==="connected"?"paypal-connected":"paypal-connect-button"} disabled={paypalBusy} onClick={()=>void connectPayPal()}>{paypalBusy?"Opening PayPal…":paypalAccount?.status==="connected"?"Connected ✓":"Connect PayPal"}</button>
        {paypalMessage&&<p className={paypalAccount?.status==="connected"?"paypal-success":"paypal-message"}>{paypalMessage}</p>}
        <small className="paypal-environment">{paypalAccount?.environment==="live"?"Live payments":"Sandbox testing"}</small>
      </section>}

      <section className={`result-people ${unassigned>0?"results-hidden":""}`}>
        <h2>{guestParticipantId ? "Your payment" : "People"}</h2>
        {draft.people.filter((person)=>!guestParticipantId||person.name===guestName).map((person)=>{
          const fixedShare=totals.originalOwed[person.id]||0;
          const rawShare=totals.rawItemOwed[person.id]||0;
          const receiptAdjustment=fixedShare-rawShare;
          const totalNeed=totals.owed[person.id]||0;
          const adjustment=totalNeed-fixedShare;
          const alreadyPaid=draft.payments[person.id]||0;
          const merchant=paymentPlan.merchantPayments[person.id]||0;
          const outgoing=paymentPlan.settlements.filter((settlement)=>settlement.from===person.name);
          const incoming=paymentPlan.settlements.filter((settlement)=>settlement.to===person.name);
          const outgoingTotal=outgoing.reduce((sum,settlement)=>sum+settlement.cents,0);
          const incomingTotal=incoming.reduce((sum,settlement)=>sum+settlement.cents,0);
          const net=outgoingTotal-incomingTotal;
          const selectedItems=draft.expenses.filter((item)=>item.consumers.includes(person.id)).length;
          return <article className="panel person-payment-card" style={{borderColor:person.color,boxShadow:`0 0 0 1px color-mix(in srgb, ${person.color} 80%, transparent), 0 14px 46px color-mix(in srgb, ${person.color} 55%, transparent), inset 0 0 24px color-mix(in srgb, ${person.color} 12%, transparent)`}} key={person.id}>
            <header><span><i style={{background:person.color}}>{person.name[0].toUpperCase()}</i><strong>{person.name}</strong><button className="person-item-count" onClick={()=>setItemsPersonId(person.id)}>{selectedItems} {selectedItems===1?"item":"items"}</button></span><strong>{money(rawShare)}</strong></header>
            <div className="person-costs">
              <div><span>Tax, tip &amp; discount</span><strong>{signedMoney(receiptAdjustment)}</strong></div>
            </div>
            <div className="person-total-section">
              <div className="person-adjustment-row"><span>Adjustment</span><strong className={adjustment<0?"negative-adjustment":adjustment>0?"positive-adjustment":""}>{signedMoney(adjustment)}</strong></div>
              <div className="person-total-row"><span>Total need to pay</span><strong>{money(totalNeed)}</strong></div>
            </div>
            <section className="person-payment-box" style={{borderColor:`color-mix(in srgb, ${person.color} 32%, #111816)`}}>
            <div className="payment-box-heading"><span style={{background:person.color}}><img src="/icons/payment-icon.png" alt="" /></span><h3 style={{color:person.color}}>Payment</h3></div>
            <div className="person-control-section">
              <label className="person-money-row"><span>How much paid</span><div className="money-input"><span>$</span><input inputMode="decimal" value={alreadyPaid/100||""} onChange={(event)=>setDraft((current)=>({...current,payments:{...current.payments,[person.id]:toCents(event.target.value)}}))} placeholder="0.00" /></div></label>
              <div className="person-switch-row"><span>No repayment</span><button className={`switch ${draft.noRepayment[person.id]?"on":""}`} onClick={()=>setDraft((current)=>({...current,noRepayment:{...current.noRepayment,[person.id]:!current.noRepayment[person.id]}}))} aria-label={`No repayment for ${person.name}`}><i></i></button></div>
            </div>
            {!draft.noRepayment[person.id]&&<>
            <div className="person-control-section">
              <div className="person-value-row"><span>Paying merchant</span><strong className="merchant-payment-amount" style={{color:draft.canPayMerchant[person.id]===false?"var(--muted)":merchant>0?person.color:"var(--text)"}}>{money(merchant)}</strong></div>
              <div className="person-switch-row"><span>{draft.canPayMerchant[person.id]!==false?"Can pay merchant now":"Someone else pays now"}</span><button className={`switch ${draft.canPayMerchant[person.id]!==false?"on":""}`} onClick={()=>toggleMerchantAvailability(person.id)} aria-label={`Can ${person.name} pay the merchant now`}><i></i></button></div>
            </div>
            <div className="person-settlement-section" style={net===0?{display:"none"}:undefined}>
              <div className="person-settlement-heading"><h4>Settlement</h4><strong>{money(Math.abs(net))}</strong></div>
              {net!==0&&<>
              {outgoing.map((settlement,index)=><div className="person-settlement-row" key={`out-${index}`}><span>Pays {settlement.to}</span><strong>{money(settlement.cents)}</strong></div>)}
              {incoming.map((settlement,index)=><div className="person-settlement-row" key={`in-${index}`}><span>Gets from {settlement.from}</span><strong>{money(settlement.cents)}</strong></div>)}
              <button className="settlement-preferences-button" onClick={()=>setPreferencePersonId(person.id)}>Settlement preferences <span>›</span></button>
              </>}
            </div>
            </>}
            {sharedMode&&net!==0&&<label className="venmo-row person-venmo-row"><span>Venmo</span><input value={draft.venmoUsernames[person.id]||""} onChange={(event)=>setDraft((current)=>({...current,venmoUsernames:{...current.venmoUsernames,[person.id]:event.target.value.replace(/^@/,"").replace(/[^a-zA-Z0-9_-]/g,"")}}))} placeholder="username" /></label>}
            </section>
          </article>
        })}
      </section>

      <section className={`panel advanced results-adjustments ${advanced?"open":""}`}><button className="advanced-toggle" onClick={()=>setAdvanced(!advanced)}><span><b>+</b><span><strong>Advanced settings</strong></span></span><span className={`collapse-chevron ${advanced?"open":""}`}>⌄</span></button>{advanced && <div className="advanced-body control-stack">
        <div className="setting-card"><button className={`switch ${draft.taxEnabled?"on":""}`} onClick={()=>setDraft({...draft,taxEnabled:!draft.taxEnabled})}><i></i></button><div><strong>Tax</strong></div>{draft.taxEnabled&&<label className="compact-value"><input type="number" min="0" step="0.01" value={draft.taxRate||""} onChange={(e)=>setDraft({...draft,taxRate:Number(e.target.value)||0})} placeholder="0" /><span>%</span></label>}</div>
        <div className="setting-card tip-control"><button className={`switch ${draft.tipEnabled?"on":""}`} onClick={()=>setDraft({...draft,tipEnabled:!draft.tipEnabled})}><i></i></button><div><strong>Tip</strong></div>{draft.tipEnabled&&<><div className="segment"><button className={draft.tipMode==="percent"?"active":""} onClick={()=>setDraft({...draft,tipMode:"percent"})}>%</button><button className={draft.tipMode==="amount"?"active":""} onClick={()=>setDraft({...draft,tipMode:"amount"})}>$</button></div><input className="tip-value" inputMode="decimal" defaultValue={draft.tipValue ? (draft.tipMode==="amount"?draft.tipValue/100:draft.tipValue) : ""} onChange={(e)=>setDraft({...draft,tipValue:draft.tipMode==="amount"?toCents(e.target.value):Number(e.target.value)||0})} placeholder="0" /></>}</div>
        <div className="setting-card discount-control"><div><strong>Discount</strong></div><div className="discount-tools"><div className="segment"><button className={draft.discountTiming==="before"?"active":""} onClick={()=>setDraft({...draft,discountTiming:"before"})}>Before</button><button className={draft.discountTiming==="after"?"active":""} onClick={()=>setDraft({...draft,discountTiming:"after"})}>After</button></div><div className="money-input"><span>$</span><input inputMode="decimal" defaultValue={draft.discountCents?draft.discountCents/100:""} onChange={(e)=>setDraft({...draft,discountCents:toCents(e.target.value)})} placeholder="0.00" /></div></div></div>
      </div>}</section>
      {resultsQrCode&&unassigned===0&&<section className="panel results-qr-card"><div><strong>Scan to view results</strong><small>Open assignments and each person’s private result.</small></div><div className="results-qr-wrap"><img src={resultsQrCode} alt="QR code for the shared bill results" /></div></section>}
      <div className={`page-actions result-page-actions ${canShareResults?"has-share-results":""}`}><button className="back-button" onClick={()=>goTo(4)}><span className="nav-arrow">‹</span> Back</button>{canShareResults&&<button className="share-results-button" disabled={sharing} onClick={()=>void shareResults()}>{sharing?"Saving latest results…":"Share results"}</button>}<button className="new-bill" onClick={finishBill}>Finish bill &amp; start new</button></div>
    </>}
    <footer><span className={`save-status ${saveStatus}`} title={cloudError}>{saveStatus === "saving" ? "Saving to cloud…" : saveStatus === "saved" ? "✓ Saved to cloud" : saveStatus === "offline" ? `Cloud error — ${cloudError || "saved on this device"}` : "Saved automatically on this device"}</span><span>{savedTitle}</span></footer>
  </div></main>;
}

