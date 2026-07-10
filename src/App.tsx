import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

const DEFAULT_PLACES = ["Caja Seguridad", "Efectivo", "Deel"] as const;

/** Cantidad fija de transacciones mostradas en el dashboard */
const DASHBOARD_TX_LIMIT = 8;
const SALARY_PAGE_SIZE = 10;

/** Horas por mes de referencia para 2026 */
const MONTHLY_HOURS_2026: Record<number, number> = {
  1: 176, 2: 160, 3: 176, 4: 176, 5: 168, 6: 176,
  7: 184, 8: 168, 9: 176, 10: 176, 11: 168, 12: 184,
};

const MONTH_NAMES_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const MONTH_NAMES_ES_SHORT = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

/** Horas por mes: 2026 definido; otros años reutilizan 2026 por defecto */
function getHoursForMonth(year: number, month: number): number {
  const hoursMap: Record<number, number> = year === 2026 ? MONTHLY_HOURS_2026 : { ...MONTHLY_HOURS_2026 };
  return hoursMap[month] ?? 176;
}

/** Último día hábil del mes (sin fines de semana) */
function getLastBusinessDay(year: number, month: number): Date {
  const last = new Date(year, month, 0);
  const dow = last.getDay();
  if (dow === 0) last.setDate(last.getDate() - 2);
  else if (dow === 6) last.setDate(last.getDate() - 1);
  return last;
}

function getNextSalaryPayDate(hourlyRate: number): { date: Date; amount: number; month: number; year: number } | null {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const payThisMonth = getLastBusinessDay(y, m);
  if (today <= payThisMonth) {
    const hours = getHoursForMonth(y, m);
    return { date: payThisMonth, amount: hours * hourlyRate, month: m, year: y };
  }
  let nextM = m + 1;
  let nextY = y;
  if (nextM > 12) {
    nextM = 1;
    nextY += 1;
  }
  const payNext = getLastBusinessDay(nextY, nextM);
  const hours = getHoursForMonth(nextY, nextM);
  return { date: payNext, amount: hours * hourlyRate, month: nextM, year: nextY };
}

function formatNextSalaryDate(d: Date): string {
  const day = d.getDate();
  const month = MONTH_NAMES_ES[d.getMonth()].slice(0, 3);
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

function daysUntil(d: Date): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.max(0, Math.ceil((target.getTime() - today.getTime()) / 86400000));
}

type ViewId = "dashboard" | "upcoming" | "goals" | "familyFinancing";

const HOURLY_RATE_STORAGE_KEY = "balance-plus-hourly-rate";
const DEFAULT_HOURLY_RATE = 33.5;

interface SalaryEntry {
  id: string;
  year: number;
  month: number;
  hours: number;
  hourlyRate: number;
}

function mapRowToSalaryEntry(row: { id: string; year: number; month: number; hours: number; hourly_rate: number }): SalaryEntry {
  return {
    id: String(row.id),
    year: Number(row.year),
    month: Number(row.month),
    hours: Number(row.hours),
    hourlyRate: Number(row.hourly_rate),
  };
}

/** Próximos N salarios desde la lista dinámica (fecha de cobro >= hoy) */
function getUpcomingFromEntries(entries: SalaryEntry[], count: number): Array<{ date: Date; amount: number; month: number; year: number; id: string }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const withDate = entries.map((e) => ({
    ...e,
    date: getLastBusinessDay(e.year, e.month),
    amount: e.hours * e.hourlyRate,
  }));
  const future = withDate.filter(({ date }) => date >= today);
  future.sort((a, b) => a.date.getTime() - b.date.getTime());
  return future.slice(0, count).map(({ date, amount, month, year, id }) => ({ date, amount, month, year, id }));
}

interface Entry {
  id: number;
  date: string;
  place: string;
  amount: number;
  comment: string;
}

type TxType = "income" | "expense" | "transfer";

interface FormState {
  date: string;
  place: string;
  amount: string;
  comment: string;
}

type SavingsGoalStatus = "in_progress" | "at_risk" | "completed";

interface SavingsGoal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  deadline: string | null;
  category: string;
  status: SavingsGoalStatus;
  createdAt: string;
}

interface SavingsContribution {
  id: string;
  goalId: string;
  amount: number;
  source: "manual" | "retention";
  createdAt: string;
  movementId?: number | null;
}

type FamilyFinancingStatus = "in_progress" | "completed";

interface FamilyFinancingItem {
  id: string;
  name: string;
  totalAmount: number;
  purchaseDate: string;
  notes: string | null;
  installmentCount: number;
  status: FamilyFinancingStatus;
  createdAt: string;
  completedAt: string | null;
}

interface FamilyFinancingInstallment {
  id: string;
  itemId: string;
  installmentNumber: number;
  amount: number;
  dueDate: string;
  isPaid: boolean;
  paidAt: string | null;
  createdAt: string;
}

function getDueDateForInstallment(purchaseDate: string, installmentNumber: number): string {
  const [year, month] = purchaseDate.split("-").map(Number);
  const due = new Date(year, month - 1 + installmentNumber, 1);
  const yyyy = due.getFullYear();
  const mm = String(due.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

function formatDueMonth(dueDate: string): string {
  const [year, month] = dueDate.split("-").map(Number);
  return `${MONTH_NAMES_ES[month - 1]} ${year}`;
}

function splitIntoInstallments(total: number, count: number): number[] {
  if (count < 1) return [];
  const totalCents = Math.round(total * 100);
  const base = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  return Array.from({ length: count }, (_, i) => (base + (i < remainder ? 1 : 0)) / 100);
}

function mapRowToFamilyItem(row: {
  id: string;
  name: string;
  total_amount: number;
  purchase_date: string;
  notes: string | null;
  installment_count: number;
  status: string;
  created_at: string;
  completed_at: string | null;
}): FamilyFinancingItem {
  return {
    id: String(row.id),
    name: row.name,
    totalAmount: Number(row.total_amount),
    purchaseDate: row.purchase_date,
    notes: row.notes,
    installmentCount: Number(row.installment_count),
    status: row.status === "completed" ? "completed" : "in_progress",
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapRowToFamilyInstallment(
  row: {
    id: string;
    item_id: string;
    installment_number: number;
    amount: number;
    due_date?: string | null;
    is_paid: boolean;
    paid_at: string | null;
    created_at: string;
  },
  purchaseDate?: string,
): FamilyFinancingInstallment {
  const dueDate =
    row.due_date ??
    (purchaseDate ? getDueDateForInstallment(purchaseDate, Number(row.installment_number)) : todayIso());
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    installmentNumber: Number(row.installment_number),
    amount: Number(row.amount),
    dueDate,
    isPaid: Boolean(row.is_paid),
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

const formatCurrency = (value: number) =>
  value.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 2,
  });

/** Formato compacto para etiquetas del eje Y (sin decimales) */
const formatCurrencyAxis = (value: number) =>
  value.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const formatDisplayDate = (iso: string) => {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return date.toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
};

const todayIso = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

function AccountIcon({ place }: { place: string }) {
  if (place === "Caja Seguridad") {
    return (
      <span className="account-icon account-icon-caja" aria-hidden title="Caja Seguridad">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/></svg>
      </span>
    );
  }
  if (place === "Efectivo") {
    return (
      <span className="account-icon account-icon-efectivo" aria-hidden title="Efectivo">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/></svg>
      </span>
    );
  }
  if (place === "Deel") {
    return (
      <span className="account-icon account-icon-deel deel-logo" aria-hidden title="Deel">
        d.
      </span>
    );
  }
  return (
    <span className="account-icon account-icon-default" aria-hidden>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/></svg>
    </span>
  );
}

function getStoredHourlyRate(): number {
  try {
    const s = localStorage.getItem(HOURLY_RATE_STORAGE_KEY);
    if (s != null) {
      const n = Number(s.replace(",", "."));
      if (!Number.isNaN(n) && n > 0) return n;
    }
  } catch {
    // ignore
  }
  return DEFAULT_HOURLY_RATE;
}

export function App() {
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [hourlyRate, setHourlyRate] = useState(getStoredHourlyRate);
  const [salaryEntries, setSalaryEntries] = useState<SalaryEntry[]>([]);
  const [editingSalaryId, setEditingSalaryId] = useState<string | null>(null);
  const [showSalaryForm, setShowSalaryForm] = useState(false);
  const [salaryForm, setSalaryForm] = useState({ year: new Date().getFullYear(), month: 1, hours: 176, hourlyRate: DEFAULT_HOURLY_RATE });
  const [salaryPage, setSalaryPage] = useState(1);
  const [salaryError, setSalaryError] = useState<string | null>(null);
  const totalsSliderRef = useRef<HTMLDivElement>(null);
  const totalsDragRef = useRef({ startX: 0, startScrollLeft: 0 });
  const [places, setPlaces] = useState<string[]>([...DEFAULT_PLACES]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [flowChartAccountFilter, setFlowChartAccountFilter] = useState<string | null>(null);
  const [flowChartAccountFilterOpen, setFlowChartAccountFilterOpen] = useState(false);
  const flowChartFilterRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<FormState>({
    date: todayIso(),
    place: DEFAULT_PLACES[0],
    amount: "",
    comment: "",
  });
  const [amountError, setAmountError] = useState<string | null>(null);
  const [ahorrosMamaPapa, setAhorrosMamaPapa] = useState(23000);
  const [confirmDelete, setConfirmDelete] = useState<Entry | null>(null);
  const [confirmDeleteSalary, setConfirmDeleteSalary] = useState<SalaryEntry | null>(null);

  const [showNewTxModal, setShowNewTxModal] = useState(false);
  const [showAllTxModal, setShowAllTxModal] = useState(false);
  const [txType, setTxType] = useState<TxType>("expense");
  const [txAmount, setTxAmount] = useState("");
  const [txSource, setTxSource] = useState(DEFAULT_PLACES[0]);
  const [txDestination, setTxDestination] = useState(DEFAULT_PLACES[0]);
  const [txDate, setTxDate] = useState(todayIso());
  const [txDescription, setTxDescription] = useState("");
  const [txAmountError, setTxAmountError] = useState<string | null>(null);

  const [savingsGoals, setSavingsGoals] = useState<SavingsGoal[]>([]);
  const [savingsContributions, setSavingsContributions] = useState<SavingsContribution[]>([]);
  const [familyItems, setFamilyItems] = useState<FamilyFinancingItem[]>([]);
  const [familyInstallments, setFamilyInstallments] = useState<FamilyFinancingInstallment[]>([]);
  const [familyForm, setFamilyForm] = useState({
    name: "",
    totalAmount: "",
    purchaseDate: todayIso(),
    notes: "",
    installmentCount: "1",
  });
  const [familyFormError, setFamilyFormError] = useState<string | null>(null);
  const [editingFamilyItemId, setEditingFamilyItemId] = useState<string | null>(null);
  const [showFamilyModal, setShowFamilyModal] = useState(false);
  const [confirmDeleteFamilyItem, setConfirmDeleteFamilyItem] = useState<FamilyFinancingItem | null>(null);
  const [editingFamilyInstallment, setEditingFamilyInstallment] = useState<FamilyFinancingInstallment | null>(null);
  const [installmentEditForm, setInstallmentEditForm] = useState({ amount: "", dueMonth: "" });
  const [installmentEditError, setInstallmentEditError] = useState<string | null>(null);
  const [goalForm, setGoalForm] = useState({ name: "", targetAmount: "", deadline: "", category: "" });
  const [goalFormError, setGoalFormError] = useState<string | null>(null);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [selectedGoalForContribution, setSelectedGoalForContribution] = useState<SavingsGoal | null>(null);
  const [contributionAmount, setContributionAmount] = useState("");
  const [contributionError, setContributionError] = useState<string | null>(null);
  const [editingContribution, setEditingContribution] = useState<{ id: string; amount: number } | null>(null);
  const [confirmResetGoal, setConfirmResetGoal] = useState<SavingsGoal | null>(null);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [chartHoveredMonthIndex, setChartHoveredMonthIndex] = useState<number | null>(null);
  const [flowChartHovered, setFlowChartHovered] = useState<{ monthIndex: number; bar: "income" | "expense" } | null>(null);
  const [expandedChartModal, setExpandedChartModal] = useState<"monthly" | "flow" | null>(null);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  const [calendarHoveredDate, setCalendarHoveredDate] = useState<string | null>(null);
  const goalsSliderRef = useRef<HTMLDivElement | null>(null);
  const goalsDragRef = useRef({ startX: 0, startScrollLeft: 0 });
  const familySliderRef = useRef<HTMLDivElement | null>(null);
  const familyDragRef = useRef({ startX: 0, startScrollLeft: 0 });
  const achievementsSliderRef = useRef<HTMLDivElement | null>(null);
  const achievementsDragRef = useRef({ startX: 0, startScrollLeft: 0 });
  const upcomingDashboardSliderRef = useRef<HTMLDivElement | null>(null);
  const upcomingDashboardDragRef = useRef({ startX: 0, startScrollLeft: 0 });

  // Cargar datos iniciales desde Supabase
  useEffect(() => {
    const load = async () => {
      try {
        const [
          { data: movements },
          { data: placesData },
          { data: settingsData },
          { data: salaryRows },
          { data: goalsRows },
          { data: contributionsRows },
          { data: familyItemsRows },
          { data: familyInstallmentsRows },
        ] = await Promise.all([
          supabase
            .from("movements")
            .select("id, date, place, amount, comment")
            .order("date", { ascending: false })
            .order("id", { ascending: false }),
          supabase.from("places").select("name").order("name", { ascending: true }),
          supabase.from("settings").select("id, ahorros_mama_papa").eq("id", 1).maybeSingle(),
          supabase
            .from("salary_entries")
            .select("id, year, month, hours, hourly_rate")
            .order("year", { ascending: true })
            .order("month", { ascending: true }),
          supabase
            .from("savings_goals")
            .select("id, name, target_amount, current_amount, deadline, category, status, created_at")
            .order("created_at", { ascending: true }),
          supabase
            .from("savings_goal_contributions")
            .select("id, goal_id, amount, source, created_at, movement_id")
            .order("created_at", { ascending: true }),
          supabase
            .from("family_financing_items")
            .select("id, name, total_amount, purchase_date, notes, installment_count, status, created_at, completed_at")
            .order("created_at", { ascending: false }),
          supabase
            .from("family_financing_installments")
            .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at")
            .order("installment_number", { ascending: true }),
        ]);

        if (movements) {
          setEntries(
            movements.map((m) => ({
              id: m.id as number,
              date: m.date as string,
              place: m.place as string,
              amount: Number(m.amount),
              comment: (m.comment as string | null) ?? "",
            })),
          );
        }

        if (placesData && Array.isArray(placesData)) {
          const fromDb = placesData.map((p: { name: string }) => p.name);
          const merged = Array.from(new Set([...DEFAULT_PLACES, ...fromDb]));
          setPlaces(merged);
        }

        if (settingsData && typeof settingsData.ahorros_mama_papa !== "undefined") {
          const val = Number(settingsData.ahorros_mama_papa);
          if (!Number.isNaN(val) && val >= 0) {
            setAhorrosMamaPapa(val);
          }
        }

        if (salaryRows && Array.isArray(salaryRows)) {
          setSalaryEntries(
            salaryRows.map((r: { id: string; year: number; month: number; hours: number; hourly_rate: number }) =>
              mapRowToSalaryEntry(r)
            )
          );
        }

        if (goalsRows && Array.isArray(goalsRows)) {
          setSavingsGoals(
            goalsRows.map((g: { id: string; name: string; target_amount: number; current_amount: number; deadline: string | null; category: string; status: string; created_at: string }) => ({
              id: String(g.id),
              name: g.name,
              targetAmount: Number(g.target_amount),
              currentAmount: Number(g.current_amount),
              deadline: g.deadline,
              category: g.category,
              status: (g.status as SavingsGoalStatus) ?? "in_progress",
              createdAt: g.created_at,
            })),
          );
        }

        if (contributionsRows && Array.isArray(contributionsRows)) {
          setSavingsContributions(
            contributionsRows.map((c: { id: string; goal_id: string; amount: number; source: string; created_at: string; movement_id?: number | null }) => ({
              id: String(c.id),
              goalId: String(c.goal_id),
              amount: Number(c.amount),
              source: c.source === "retention" ? "retention" : "manual",
              createdAt: c.created_at,
              movementId: typeof c.movement_id === "number" ? c.movement_id : c.movement_id ?? null,
            })),
          );
        }

        if (familyItemsRows && Array.isArray(familyItemsRows)) {
          setFamilyItems(
            familyItemsRows.map((row: {
              id: string;
              name: string;
              total_amount: number;
              purchase_date: string;
              notes: string | null;
              installment_count: number;
              status: string;
              created_at: string;
              completed_at: string | null;
            }) => mapRowToFamilyItem(row)),
          );
        }

        if (familyInstallmentsRows && Array.isArray(familyInstallmentsRows)) {
          const purchaseDateByItemId = new Map(
            (familyItemsRows ?? []).map((row: { id: string; purchase_date: string }) => [
              String(row.id),
              row.purchase_date as string,
            ]),
          );
          setFamilyInstallments(
            familyInstallmentsRows.map((row: {
              id: string;
              item_id: string;
              installment_number: number;
              amount: number;
              due_date?: string | null;
              is_paid: boolean;
              paid_at: string | null;
              created_at: string;
            }) =>
              mapRowToFamilyInstallment(
                row,
                purchaseDateByItemId.get(String(row.item_id)),
              ),
            ),
          );
        }
      } catch {
        // si falla, la app sigue vacía
      }
    };

    void load();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(HOURLY_RATE_STORAGE_KEY, String(hourlyRate));
    } catch {
      // ignore
    }
  }, [hourlyRate]);

  useEffect(() => {
    if (!flowChartAccountFilterOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (flowChartFilterRef.current && !flowChartFilterRef.current.contains(e.target as Node)) {
        setFlowChartAccountFilterOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [flowChartAccountFilterOpen]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(salaryEntries.length / SALARY_PAGE_SIZE));
    setSalaryPage((p) => (p > totalPages ? totalPages : p));
  }, [salaryEntries.length]);

  /** Al entrar a Próximos salarios o al cambiar datos, ubicar la página en el mes actual */
  useEffect(() => {
    if (activeView !== "upcoming" || salaryEntries.length === 0) return;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const sorted = [...salaryEntries].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
    const index = sorted.findIndex((e) => e.year === currentYear && e.month === currentMonth);
    if (index >= 0) {
      const pageForCurrentMonth = Math.floor(index / SALARY_PAGE_SIZE) + 1;
      setSalaryPage(pageForCurrentMonth);
    }
  }, [activeView, salaryEntries]);

  const addSalaryEntry = async () => {
    setSalaryError(null);
    const { year, month, hours, hourlyRate: rate } = salaryForm;
    if (hours <= 0 || rate < 0) return;
    const exists = salaryEntries.some((e) => e.year === year && e.month === month);
    if (exists) return;
    const payload = {
      year: Number(year),
      month: Number(month),
      hours: Number(hours),
      hourly_rate: Number(rate),
    };
    const { data, error } = await supabase
      .from("salary_entries")
      .insert(payload)
      .select("id, year, month, hours, hourly_rate")
      .single();
    if (error) {
      setSalaryError(error.message || "No se pudo guardar el salario.");
      return;
    }
    const newEntry = data ? mapRowToSalaryEntry(data as { id: string; year: number; month: number; hours: number; hourly_rate: number }) : null;
    if (newEntry) {
      setSalaryEntries((prev) => [...prev, newEntry]);
      setSalaryForm((f) => ({ ...f, hours: 176 }));
      setSalaryError(null);
      setShowSalaryForm(false);
    } else {
      setSalaryError("No se recibió el registro guardado.");
    }
  };

  const updateSalaryEntry = async () => {
    if (!editingSalaryId) return;
    const { year, month, hours, hourlyRate: rate } = salaryForm;
    if (hours <= 0 || rate < 0) return;
    const duplicate = salaryEntries.some((e) => e.id !== editingSalaryId && e.year === year && e.month === month);
    if (duplicate) return;
    const { error } = await supabase
      .from("salary_entries")
      .update({ year, month, hours, hourly_rate: rate })
      .eq("id", editingSalaryId);
    if (error) return;
    setSalaryEntries((prev) =>
      prev.map((e) => (e.id === editingSalaryId ? { ...e, year, month, hours, hourlyRate: rate } : e))
    );
    setEditingSalaryId(null);
    setShowSalaryForm(false);
    setSalaryForm({ year: new Date().getFullYear(), month: 1, hours: 176, hourlyRate: hourlyRate });
  };

  const deleteSalaryEntry = async (id: string) => {
    const { error } = await supabase.from("salary_entries").delete().eq("id", id);
    if (error) return;
    setSalaryEntries((prev) => prev.filter((e) => e.id !== id));
    if (editingSalaryId === id) setEditingSalaryId(null);
  };

  const startEditSalary = (entry: SalaryEntry) => {
    setEditingSalaryId(entry.id);
    setSalaryForm({ year: entry.year, month: entry.month, hours: entry.hours, hourlyRate: entry.hourlyRate });
    setShowSalaryForm(true);
  };

  const cancelEditSalary = () => {
    setEditingSalaryId(null);
    setShowSalaryForm(false);
    setSalaryError(null);
    setSalaryForm({ year: new Date().getFullYear(), month: 1, hours: 176, hourlyRate: hourlyRate });
  };

  const handleTotalsSliderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = totalsSliderRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    e.preventDefault();
    el.classList.add("salary-totals-slider--grabbing");
    totalsDragRef.current = { startX: e.clientX, startScrollLeft: el.scrollLeft };
    const onMove = (moveEvent: MouseEvent) => {
      el.scrollLeft = totalsDragRef.current.startScrollLeft + (totalsDragRef.current.startX - moveEvent.clientX);
    };
    const onUp = () => {
      el.classList.remove("salary-totals-slider--grabbing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const makeHorizontalDragHandler =
    (ref: React.RefObject<HTMLDivElement>, dragRef: React.MutableRefObject<{ startX: number; startScrollLeft: number }>) =>
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.classList.add("goals-slider--grabbing", "upcoming-cards-slider--grabbing");
      dragRef.current = { startX: e.clientX, startScrollLeft: el.scrollLeft };
      const state = { latestX: e.clientX, rafId: 0, targetScrollLeft: el.scrollLeft };
      const onMove = (moveEvent: MouseEvent) => {
        state.latestX = moveEvent.clientX;
        state.targetScrollLeft = dragRef.current.startScrollLeft + (dragRef.current.startX - state.latestX);
        if (state.rafId === 0) {
          state.rafId = requestAnimationFrame(() => {
            const current = el.scrollLeft;
            const next = current + (state.targetScrollLeft - current) * 0.35;
            el.scrollLeft = next;
            state.rafId = 0;
          });
        }
      };
      const onUp = () => {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        el.classList.remove("goals-slider--grabbing", "upcoming-cards-slider--grabbing");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

  const totalsByPlace = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const p of places) totals[p] = 0;
    for (const entry of entries) {
      if (!(entry.place in totals)) totals[entry.place] = 0;
      totals[entry.place] += entry.amount;
    }
    return totals;
  }, [entries, places]);

  const grandTotal = useMemo(
    () => entries.reduce((sum, e) => sum + e.amount, 0),
    [entries],
  );

  /** Variación del total vs mes anterior (para Mis cuentas) */
  const totalVsLastMonth = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const currPrefix = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
    const prevPrefix = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    let currSum = 0;
    let prevSum = 0;
    for (const e of entries) {
      if (e.date.startsWith(currPrefix)) currSum += e.amount;
      else if (e.date.startsWith(prevPrefix)) prevSum += e.amount;
    }
    if (prevSum === 0) return currSum > 0 ? { pct: 100, positive: true } : { pct: 0, positive: true };
    const pct = ((currSum - prevSum) / Math.abs(prevSum)) * 100;
    return { pct, positive: pct >= 0 };
  }, [entries]);

  const adeudado = ahorrosMamaPapa - grandTotal;

  /** Saldo al cierre de cada mes (últimos 5 meses) para el gráfico. Por mes: total y por cuenta. */
  const monthlyClosingBalances = useMemo(() => {
    const now = new Date();
    const result: Array<{
      year: number;
      month: number;
      total: number;
      byPlace: Record<string, number>;
    }> = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const lastDay = new Date(year, month, 0);
      const lastDayIso = `${year}-${String(month).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}`;
      const byPlace: Record<string, number> = {};
      for (const p of places) byPlace[p] = 0;
      let total = 0;
      for (const e of entries) {
        if (e.date > lastDayIso) continue;
        total += e.amount;
        if (e.place in byPlace) byPlace[e.place] += e.amount;
      }
      result.push({ year, month, total, byPlace });
    }
    return result;
  }, [entries, places]);

  /** Variación del saldo al cierre: mes actual vs mes anterior (para el gráfico Saldo al cierre del mes) */
  const monthlyChartVsLastMonth = useMemo(() => {
    if (monthlyClosingBalances.length < 2) return null;
    const curr = monthlyClosingBalances[monthlyClosingBalances.length - 1].total;
    const prev = monthlyClosingBalances[monthlyClosingBalances.length - 2].total;
    if (prev === 0) return curr > 0 ? { pct: 100, positive: true } : { pct: 0, positive: true };
    const pct = ((curr - prev) / Math.abs(prev)) * 100;
    return { pct, positive: curr >= prev };
  }, [monthlyClosingBalances]);

  /** Ingresos y gastos por mes (últimos 5 meses, más reciente a la derecha) para el gráfico Flujo de dinero. */
  const monthlyFlowData = useMemo(() => {
    const now = new Date();
    const result: Array<{ year: number; month: number; income: number; expense: number }> = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const prefix = `${year}-${String(month).padStart(2, "0")}`;
      let income = 0;
      let expense = 0;
      for (const e of entries) {
        if (!e.date.startsWith(prefix)) continue;
        if (e.amount > 0) income += e.amount;
        else expense += Math.abs(e.amount);
      }
      result.push({ year, month, income, expense });
    }
    return result;
  }, [entries]);

  /** Flujo ingresos/gastos por mes solo para el gráfico Flujo de dinero (filtro por cuenta opcional) */
  const flowChartMonthlyFlowData = useMemo(() => {
    const filtered = flowChartAccountFilter
      ? entries.filter((e) => e.place === flowChartAccountFilter)
      : entries;
    const now = new Date();
    const result: Array<{ year: number; month: number; income: number; expense: number }> = [];
    for (let i = 4; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const prefix = `${year}-${String(month).padStart(2, "0")}`;
      let income = 0;
      let expense = 0;
      for (const e of filtered) {
        if (!e.date.startsWith(prefix)) continue;
        if (e.amount > 0) income += e.amount;
        else expense += Math.abs(e.amount);
      }
      result.push({ year, month, income, expense });
    }
    return result;
  }, [entries, flowChartAccountFilter]);

  const nextSalary = useMemo(() => getNextSalaryPayDate(hourlyRate), [hourlyRate]);
  /** En el Dashboard mostramos más salarios para poder hacer scroll horizontal (Junio, Julio, etc.) */
  const upcomingSalaries = useMemo(() => getUpcomingFromEntries(salaryEntries, 12), [salaryEntries]);

  /** Actividades por fecha para el calendario (transacciones, cobros de salario, metas con fecha límite) */
  const calendarActivitiesByDate = useMemo(() => {
    const map: Record<
      string,
      {
        transactions: Entry[];
        salaries: Array<{ date: Date; amount: number; month: number; year: number; id: string }>;
        goals: Array<{ name: string; deadline: string }>;
      }
    > = {};
    const toYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };
    entries.forEach((e) => {
      if (!map[e.date]) map[e.date] = { transactions: [], salaries: [], goals: [] };
      map[e.date].transactions.push(e);
    });
    salaryEntries.forEach((e) => {
      const date = getLastBusinessDay(e.year, e.month);
      const key = toYmd(date);
      if (!map[key]) map[key] = { transactions: [], salaries: [], goals: [] };
      map[key].salaries.push({
        date,
        amount: e.hours * e.hourlyRate,
        month: e.month,
        year: e.year,
        id: e.id,
      });
    });
    savingsGoals.forEach((g) => {
      if (!g.deadline) return;
      if (!map[g.deadline]) map[g.deadline] = { transactions: [], salaries: [], goals: [] };
      map[g.deadline].goals.push({ name: g.name, deadline: g.deadline });
    });
    return map;
  }, [entries, salaryEntries, savingsGoals]);

  /** Totalizadores por año (ingresos a la fecha vs proyectados resto del año) */
  const salaryTotalsByYear = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const byYear: Record<number, { ingresosALaFecha: number; ingresosProyectados: number }> = {};
    for (const e of salaryEntries) {
      if (!byYear[e.year]) byYear[e.year] = { ingresosALaFecha: 0, ingresosProyectados: 0 };
      const payDate = getLastBusinessDay(e.year, e.month);
      payDate.setHours(0, 0, 0, 0);
      const amount = e.hours * e.hourlyRate;
      if (payDate <= today) byYear[e.year].ingresosALaFecha += amount;
      else byYear[e.year].ingresosProyectados += amount;
    }
    return byYear;
  }, [salaryEntries]);

  const handleChange =
    (field: keyof FormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      setForm((prev) => ({ ...prev, [field]: value }));
      if (field === "amount") {
        setAmountError(null);
      }
    };

  const resetForm = () => {
    setForm((prev) => ({
      date: todayIso(),
      place: places.includes(prev.place) ? prev.place : places[0] ?? "",
      amount: "",
      comment: "",
    }));
    setAmountError(null);
  };

  const openNewTxModal = () => {
    const first = places[0] ?? DEFAULT_PLACES[0];
    const second = places.find((p) => p !== first) ?? first;
    setTxType("expense");
    setTxAmount("");
    setTxSource(first);
    setTxDestination(second);
    setTxDate(todayIso());
    setTxDescription("");
    setTxAmountError(null);
    setShowNewTxModal(true);
  };

  const closeNewTxModal = () => {
    setShowNewTxModal(false);
  };

  const handleSubmitNewTx = async (event: React.FormEvent) => {
    event.preventDefault();
    const raw = txAmount.replace(/\s/g, "").replace(",", ".");
    const parsed = Number(raw);

    if (!raw || Number.isNaN(parsed) || parsed <= 0) {
      setTxAmountError("Ingresa un monto válido mayor a 0.");
      return;
    }
    if (txType === "transfer" && (!txDestination || txSource === txDestination)) {
      setTxAmountError("Elige un destino distinto a la fuente.");
      return;
    }
    setTxAmountError(null);

    const date = txDate || todayIso();
    const comment = txDescription.trim() || null;

    if (txType === "transfer") {
      const fromPayload = { date, place: txSource, amount: -parsed, comment: comment ? `Transferencia a ${txDestination}. ${comment}` : `Transferencia a ${txDestination}` };
      const toPayload = { date, place: txDestination, amount: parsed, comment: comment ? `Transferencia desde ${txSource}. ${comment}` : `Transferencia desde ${txSource}` };
      const [fromRes, toRes] = await Promise.all([
        supabase.from("movements").insert(fromPayload).select("id, date, place, amount, comment").single(),
        supabase.from("movements").insert(toPayload).select("id, date, place, amount, comment").single(),
      ]);
      if (fromRes.data && toRes.data) {
        setEntries((prev) => [
          { id: fromRes.data.id as number, date: fromRes.data.date as string, place: fromRes.data.place as string, amount: Number(fromRes.data.amount), comment: (fromRes.data.comment as string | null) ?? "" },
          { id: toRes.data.id as number, date: toRes.data.date as string, place: toRes.data.place as string, amount: Number(toRes.data.amount), comment: (toRes.data.comment as string | null) ?? "" },
          ...prev,
        ]);
        closeNewTxModal();
      }
      return;
    }

    const amount = txType === "income" ? parsed : -parsed;
    const { data, error } = await supabase
      .from("movements")
      .insert({ date, place: txSource, amount, comment })
      .select("id, date, place, amount, comment")
      .single();

    if (error || !data) return;

    const movement = {
      id: data.id as number,
      date: data.date as string,
      place: data.place as string,
      amount: Number(data.amount),
      comment: (data.comment as string | null) ?? "",
    };

    setEntries((prev) => [movement, ...prev]);
    closeNewTxModal();
  };

  const handleDelete = (id: number) => {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    setConfirmDelete(entry);
  };

  const confirmDeleteOk = async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;

    const { error } = await supabase.from("movements").delete().eq("id", id);

    if (error) {
      // Mostrar el error en consola y avisar al usuario si algo falla en la BD
      console.error("Error al borrar movimiento:", error);
      alert("No se pudo eliminar el movimiento en la base de datos.");
      setConfirmDelete(null);
      return;
    }

    setEntries((prev) => prev.filter((e) => e.id !== id));
    setConfirmDelete(null);
  };

  const confirmDeleteCancel = () => {
    setConfirmDelete(null);
  };

  const confirmDeleteSalaryOk = async () => {
    if (!confirmDeleteSalary) return;
    const id = confirmDeleteSalary.id;
    setConfirmDeleteSalary(null);
    const { error } = await supabase.from("salary_entries").delete().eq("id", id);
    if (error) return;
    setSalaryEntries((prev) => prev.filter((e) => e.id !== id));
    if (editingSalaryId === id) setEditingSalaryId(null);
  };

  const confirmDeleteSalaryCancel = () => {
    setConfirmDeleteSalary(null);
  };

  const handleGoalFieldChange =
    (field: "name" | "targetAmount" | "deadline" | "category") =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = event.target.value;
      setGoalForm((prev) => ({ ...prev, [field]: value }));
      setGoalFormError(null);
    };

  const resetGoalForm = () => {
    setGoalForm({ name: "", targetAmount: "", deadline: "", category: "" });
    setGoalFormError(null);
    setEditingGoalId(null);
  };

  const handleSubmitGoal = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = goalForm.name.trim();
    const category = goalForm.category.trim();
    const target = Number(goalForm.targetAmount.replace(/\s/g, "").replace(",", "."));

    if (!name) {
      setGoalFormError("Ingresa un nombre para la meta.");
      return;
    }
    if (!category) {
      setGoalFormError("Ingresa una categoría para la meta.");
      return;
    }
    if (!goalForm.targetAmount || Number.isNaN(target) || target <= 0) {
      setGoalFormError("Ingresa un monto objetivo mayor a 0.");
      return;
    }

    let deadline: string | null = null;
    if (goalForm.deadline) {
      const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(goalForm.deadline);
      if (!isValidDate) {
        setGoalFormError("La fecha límite debe tener formato YYYY-MM-DD.");
        return;
      }
      deadline = goalForm.deadline;
    }

    if (editingGoalId) {
      const { error } = await supabase
        .from("savings_goals")
        .update({
          name,
          category,
          target_amount: target,
          deadline,
        })
        .eq("id", editingGoalId);
      if (error) {
        setGoalFormError(error.message || "No se pudo actualizar la meta.");
        return;
      }
      setSavingsGoals((prev) =>
        prev.map((g) =>
          g.id === editingGoalId ? { ...g, name, category, targetAmount: target, deadline } : g,
        ),
      );
    } else {
      const { data, error } = await supabase
        .from("savings_goals")
        .insert({
          name,
          category,
          target_amount: target,
          current_amount: 0,
          deadline,
          status: "in_progress",
        })
        .select("id, name, target_amount, current_amount, deadline, category, status, created_at")
        .single();
      if (error) {
        setGoalFormError(error.message || "No se pudo crear la meta.");
        return;
      }
      const row = data as {
        id: string;
        name: string;
        target_amount: number;
        current_amount: number;
        deadline: string | null;
        category: string;
        status: string;
        created_at: string;
      };
      const newGoal: SavingsGoal = {
        id: String(row.id),
        name: row.name,
        category: row.category,
        targetAmount: Number(row.target_amount),
        currentAmount: Number(row.current_amount),
        deadline: row.deadline,
        status: (row.status as SavingsGoalStatus) ?? "in_progress",
        createdAt: row.created_at,
      };
      setSavingsGoals((prev) => [newGoal, ...prev]);
    }

    resetGoalForm();
    setShowGoalModal(false);
  };

  const startEditGoal = (goal: SavingsGoal) => {
    setEditingGoalId(goal.id);
    setGoalForm({
      name: goal.name,
      targetAmount: String(goal.targetAmount),
      deadline: goal.deadline ?? "",
      category: goal.category,
    });
    setGoalFormError(null);
    setShowGoalModal(true);
  };

  const recalcGoalStatus = (goal: SavingsGoal): SavingsGoalStatus => {
    if (goal.currentAmount >= goal.targetAmount && goal.targetAmount > 0) {
      return "completed";
    }
    return "in_progress";
  };

  const markGoalCompleted = async (id: string) => {
    const goal = savingsGoals.find((g) => g.id === id);
    if (!goal) return;
    const { error } = await supabase
      .from("savings_goals")
      .update({ current_amount: goal.targetAmount, status: "completed" })
      .eq("id", id);
    if (error) return;
    setSavingsGoals((prev) =>
      prev.map((g) =>
        g.id === id
          ? {
              ...g,
              currentAmount: g.targetAmount,
              status: "completed",
            }
          : g,
      ),
    );
  };

  const handleSubmitContribution = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedGoalForContribution) return;

    const raw = contributionAmount.replace(/\s/g, "").replace(",", ".");
    const parsed = Number(raw);

    if (!raw || Number.isNaN(parsed) || parsed <= 0) {
      setContributionError("Ingresa un monto válido mayor a 0.");
      return;
    }

    const goalId = selectedGoalForContribution.id;

    if (editingContribution) {
      // Editar un aporte manual existente
      const { id: contribId, amount: originalAmount } = editingContribution;
      const { data, error } = await supabase
        .from("savings_goal_contributions")
        .update({ amount: parsed })
        .eq("id", contribId)
        .select("id, goal_id, amount, source, created_at, movement_id")
        .single();
      if (error) {
        setContributionError(error.message || "No se pudo actualizar el aporte.");
        return;
      }
      const contribRow = data as {
        id: string;
        goal_id: string;
        amount: number;
        source: string;
        created_at: string;
        movement_id?: number | null;
      };

      const delta = parsed - originalAmount;

      setSavingsContributions((prev) =>
        prev.map((c) =>
          c.id === contribId
            ? {
                id: String(contribRow.id),
                goalId: String(contribRow.goal_id),
                amount: Number(contribRow.amount),
                source: contribRow.source === "retention" ? "retention" : "manual",
                createdAt: contribRow.created_at,
                movementId: typeof contribRow.movement_id === "number" ? contribRow.movement_id : contribRow.movement_id ?? null,
              }
            : c,
        ),
      );

      const updatedGoal = savingsGoals.find((g) => g.id === goalId);
      if (updatedGoal && delta !== 0) {
        const newCurrent = updatedGoal.currentAmount + delta;
        const withUpdated: SavingsGoal = {
          ...updatedGoal,
          currentAmount: newCurrent,
        };
        const newStatus = recalcGoalStatus(withUpdated);
        await supabase
          .from("savings_goals")
          .update({ current_amount: newCurrent, status: newStatus })
          .eq("id", goalId);
        setSavingsGoals((prev) =>
          prev.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  currentAmount: newCurrent,
                  status: newStatus,
                }
              : g,
          ),
        );
      }
    } else {
      // Crear un nuevo aporte manual
      const { data, error } = await supabase
        .from("savings_goal_contributions")
        .insert({
          goal_id: goalId,
          amount: parsed,
          source: "manual",
        })
        .select("id, goal_id, amount, source, created_at, movement_id")
        .single();
      if (error) {
        setContributionError(error.message || "No se pudo registrar el aporte.");
        return;
      }

      const contribRow = data as {
        id: string;
        goal_id: string;
        amount: number;
        source: string;
        created_at: string;
        movement_id?: number | null;
      };

      setSavingsContributions((prev) => [
        ...prev,
        {
          id: String(contribRow.id),
          goalId: String(contribRow.goal_id),
          amount: Number(contribRow.amount),
          source: contribRow.source === "retention" ? "retention" : "manual",
          createdAt: contribRow.created_at,
          movementId: typeof contribRow.movement_id === "number" ? contribRow.movement_id : contribRow.movement_id ?? null,
        },
      ]);

      const updatedGoal = savingsGoals.find((g) => g.id === goalId);
      if (updatedGoal) {
        const newCurrent = updatedGoal.currentAmount + parsed;
        const withUpdated: SavingsGoal = {
          ...updatedGoal,
          currentAmount: newCurrent,
        };
        const newStatus = recalcGoalStatus(withUpdated);
        await supabase
          .from("savings_goals")
          .update({ current_amount: newCurrent, status: newStatus })
          .eq("id", goalId);
        setSavingsGoals((prev) =>
          prev.map((g) =>
            g.id === goalId
              ? {
                  ...g,
                  currentAmount: newCurrent,
                  status: newStatus,
                }
              : g,
          ),
        );
      }
    }

    setContributionAmount("");
    setContributionError(null);
    setEditingContribution(null);
    setSelectedGoalForContribution(null);
  };

  const handleResetGoalProgress = async () => {
    if (!confirmResetGoal) return;
    const goalId = confirmResetGoal.id;
    const { error } = await supabase
      .from("savings_goals")
      .update({ current_amount: 0, status: "in_progress" })
      .eq("id", goalId);
    if (error) {
      return;
    }
    setSavingsGoals((prev) =>
      prev.map((g) =>
        g.id === goalId
          ? {
              ...g,
              currentAmount: 0,
              status: "in_progress",
            }
          : g,
      ),
    );
    setConfirmResetGoal(null);
  };

  const closeContributionModal = () => {
    setSelectedGoalForContribution(null);
    setContributionAmount("");
    setContributionError(null);
    setEditingContribution(null);
  };

  const getFamilyItemInstallments = (itemId: string) =>
    familyInstallments
      .filter((i) => i.itemId === itemId)
      .sort((a, b) => a.installmentNumber - b.installmentNumber);

  const getFamilyItemInstallmentsTotal = (itemId: string) =>
    getFamilyItemInstallments(itemId).reduce((sum, i) => sum + i.amount, 0);

  const getFamilyItemPaidAmount = (itemId: string) =>
    getFamilyItemInstallments(itemId)
      .filter((i) => i.isPaid)
      .reduce((sum, i) => sum + i.amount, 0);

  const getFamilyItemRemaining = (item: FamilyFinancingItem) =>
    Math.max(0, Math.round((item.totalAmount - getFamilyItemPaidAmount(item.id)) * 100) / 100);

  const getFamilyItemProgressPct = (item: FamilyFinancingItem) => {
    if (!item.totalAmount || item.totalAmount <= 0) return 0;
    return Math.min(100, (getFamilyItemPaidAmount(item.id) / item.totalAmount) * 100);
  };

  const updateFamilyItemStatus = async (
    item: FamilyFinancingItem,
    installments: FamilyFinancingInstallment[],
  ) => {
    const allPaid = installments.length > 0 && installments.every((i) => i.isPaid);
    const newStatus: FamilyFinancingStatus = allPaid ? "completed" : "in_progress";
    const completedAt = allPaid ? new Date().toISOString() : null;
    if (item.status === newStatus && (allPaid ? item.completedAt : !item.completedAt)) return;
    const { error } = await supabase
      .from("family_financing_items")
      .update({ status: newStatus, completed_at: completedAt })
      .eq("id", item.id);
    if (error) return;
    setFamilyItems((prev) =>
      prev.map((row) =>
        row.id === item.id ? { ...row, status: newStatus, completedAt } : row,
      ),
    );
  };

  const resetFamilyForm = () => {
    setFamilyForm({
      name: "",
      totalAmount: "",
      purchaseDate: todayIso(),
      notes: "",
      installmentCount: "1",
    });
    setFamilyFormError(null);
    setEditingFamilyItemId(null);
  };

  const handleFamilyFieldChange =
    (field: "name" | "totalAmount" | "purchaseDate" | "notes" | "installmentCount") =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFamilyForm((prev) => ({ ...prev, [field]: event.target.value }));
      setFamilyFormError(null);
    };

  const syncFamilyUnpaidInstallments = async (
    item: FamilyFinancingItem,
    currentInstallments: FamilyFinancingInstallment[],
    newInstallmentCount: number,
    newTotalAmount: number,
  ): Promise<{ installments: FamilyFinancingInstallment[] } | { error: string }> => {
    const paid = currentInstallments
      .filter((i) => i.isPaid)
      .sort((a, b) => a.installmentNumber - b.installmentNumber);
    const paidTotal = paid.reduce((sum, i) => sum + i.amount, 0);

    if (newTotalAmount + 0.001 < paidTotal) {
      return {
        error: `El monto total no puede ser menor a lo ya pagado (${formatCurrency(paidTotal)}).`,
      };
    }
    if (newInstallmentCount < paid.length) {
      return {
        error: `No podés reducir a menos de ${paid.length} cuota(s) porque ya hay cuotas pagadas.`,
      };
    }

    const remaining = Math.round((newTotalAmount - paidTotal) * 100) / 100;
    const unpaidCount = newInstallmentCount - paid.length;
    const unpaidAmounts =
      unpaidCount > 0 ? splitIntoInstallments(Math.max(0, remaining), unpaidCount) : [];

    const unpaidIds = currentInstallments.filter((i) => !i.isPaid).map((i) => i.id);
    if (unpaidIds.length > 0) {
      const { error } = await supabase
        .from("family_financing_installments")
        .delete()
        .in("id", unpaidIds);
      if (error) return { error: error.message || "No se pudieron actualizar las cuotas." };
    }

    let newUnpaidRows: FamilyFinancingInstallment[] = [];
    if (unpaidAmounts.length > 0) {
      const inserts = unpaidAmounts.map((amount, idx) => {
        const installmentNumber = paid.length + idx + 1;
        return {
          item_id: item.id,
          installment_number: installmentNumber,
          amount,
          due_date: getDueDateForInstallment(item.purchaseDate, installmentNumber),
          is_paid: false,
        };
      });
      const { data, error } = await supabase
        .from("family_financing_installments")
        .insert(inserts)
        .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at");
      if (error) return { error: error.message || "No se pudieron crear las cuotas." };
      newUnpaidRows = (data ?? []).map((row: {
        id: string;
        item_id: string;
        installment_number: number;
        amount: number;
        due_date?: string | null;
        is_paid: boolean;
        paid_at: string | null;
        created_at: string;
      }) => mapRowToFamilyInstallment(row, item.purchaseDate));
    }

    const nextInstallments = [...paid, ...newUnpaidRows].sort(
      (a, b) => a.installmentNumber - b.installmentNumber,
    );

    setFamilyInstallments((prev) => [
      ...prev.filter((i) => i.itemId !== item.id),
      ...nextInstallments,
    ]);

    return { installments: nextInstallments };
  };

  const handleSubmitFamilyItem = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = familyForm.name.trim();
    const notes = familyForm.notes.trim();
    const total = Number(familyForm.totalAmount.replace(/\s/g, "").replace(",", "."));
    const installmentCount = Number(familyForm.installmentCount);

    if (!name) {
      setFamilyFormError("Ingresa un nombre para el item.");
      return;
    }
    if (!familyForm.totalAmount || Number.isNaN(total) || total <= 0) {
      setFamilyFormError("Ingresa un monto total mayor a 0.");
      return;
    }
    if (!familyForm.purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(familyForm.purchaseDate)) {
      setFamilyFormError("La fecha de compra debe tener formato YYYY-MM-DD.");
      return;
    }
    if (!Number.isInteger(installmentCount) || installmentCount < 1) {
      setFamilyFormError("La cantidad de cuotas debe ser un número entero mayor o igual a 1.");
      return;
    }

    if (editingFamilyItemId) {
      const existing = familyItems.find((item) => item.id === editingFamilyItemId);
      if (!existing) return;
      const currentInstallments = getFamilyItemInstallments(existing.id);
      const purchaseDateChanged = familyForm.purchaseDate !== existing.purchaseDate;
      const countChanged = installmentCount !== existing.installmentCount;
      const totalChanged = total !== existing.totalAmount;
      const { error: updateError } = await supabase
        .from("family_financing_items")
        .update({
          name,
          total_amount: total,
          purchase_date: familyForm.purchaseDate,
          notes: notes || null,
          installment_count: installmentCount,
        })
        .eq("id", existing.id);
      if (updateError) {
        setFamilyFormError(updateError.message || "No se pudo actualizar el item.");
        return;
      }

      const updatedItem: FamilyFinancingItem = {
        ...existing,
        name,
        totalAmount: total,
        purchaseDate: familyForm.purchaseDate,
        notes: notes || null,
        installmentCount,
      };
      setFamilyItems((prev) =>
        prev.map((item) => (item.id === existing.id ? updatedItem : item)),
      );

      if (countChanged || totalChanged) {
        const syncResult = await syncFamilyUnpaidInstallments(
          updatedItem,
          currentInstallments,
          installmentCount,
          total,
        );
        if ("error" in syncResult) {
          setFamilyFormError(syncResult.error);
          return;
        }
        await updateFamilyItemStatus(updatedItem, syncResult.installments);
      } else if (purchaseDateChanged) {
        const unpaid = currentInstallments.filter((row) => !row.isPaid);
        if (unpaid.length > 0) {
          const updates = await Promise.all(
            unpaid.map(async (row) => {
              const dueDate = getDueDateForInstallment(familyForm.purchaseDate, row.installmentNumber);
              const { data, error } = await supabase
                .from("family_financing_installments")
                .update({ due_date: dueDate })
                .eq("id", row.id)
                .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at")
                .single();
              if (error || !data) return row;
              return mapRowToFamilyInstallment(
                data as {
                  id: string;
                  item_id: string;
                  installment_number: number;
                  amount: number;
                  due_date?: string | null;
                  is_paid: boolean;
                  paid_at: string | null;
                  created_at: string;
                },
                familyForm.purchaseDate,
              );
            }),
          );
          const paid = currentInstallments.filter((row) => row.isPaid);
          const nextInstallments = [...paid, ...updates].sort(
            (a, b) => a.installmentNumber - b.installmentNumber,
          );
          setFamilyInstallments((prev) => [
            ...prev.filter((row) => row.itemId !== existing.id),
            ...nextInstallments,
          ]);
        }
      }
    } else {
      const { data, error } = await supabase
        .from("family_financing_items")
        .insert({
          name,
          total_amount: total,
          purchase_date: familyForm.purchaseDate,
          notes: notes || null,
          installment_count: installmentCount,
          status: "in_progress",
        })
        .select("id, name, total_amount, purchase_date, notes, installment_count, status, created_at, completed_at")
        .single();
      if (error || !data) {
        setFamilyFormError(error?.message || "No se pudo crear el item.");
        return;
      }

      const newItem = mapRowToFamilyItem(data as {
        id: string;
        name: string;
        total_amount: number;
        purchase_date: string;
        notes: string | null;
        installment_count: number;
        status: string;
        created_at: string;
        completed_at: string | null;
      });
      const amounts = splitIntoInstallments(total, installmentCount);
      const { data: installmentRows, error: installmentError } = await supabase
        .from("family_financing_installments")
        .insert(
          amounts.map((amount, idx) => ({
            item_id: newItem.id,
            installment_number: idx + 1,
            amount,
            due_date: getDueDateForInstallment(newItem.purchaseDate, idx + 1),
            is_paid: false,
          })),
        )
        .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at");
      if (installmentError) {
        setFamilyFormError(installmentError.message || "No se pudieron crear las cuotas.");
        return;
      }

      const newInstallments = (installmentRows ?? []).map((row: {
        id: string;
        item_id: string;
        installment_number: number;
        amount: number;
        due_date?: string | null;
        is_paid: boolean;
        paid_at: string | null;
        created_at: string;
      }) => mapRowToFamilyInstallment(row, newItem.purchaseDate));

      setFamilyItems((prev) => [newItem, ...prev]);
      setFamilyInstallments((prev) => [...prev, ...newInstallments]);
    }

    resetFamilyForm();
    setShowFamilyModal(false);
  };

  const startEditFamilyItem = (item: FamilyFinancingItem) => {
    setEditingFamilyItemId(item.id);
    setFamilyForm({
      name: item.name,
      totalAmount: String(item.totalAmount),
      purchaseDate: item.purchaseDate,
      notes: item.notes ?? "",
      installmentCount: String(item.installmentCount),
    });
    setFamilyFormError(null);
    setShowFamilyModal(true);
  };

  const toggleFamilyInstallmentPaid = async (installment: FamilyFinancingInstallment) => {
    const item = familyItems.find((row) => row.id === installment.itemId);
    if (!item) return;
    const newPaid = !installment.isPaid;
    const paidAt = newPaid ? new Date().toISOString() : null;
    const { data, error } = await supabase
      .from("family_financing_installments")
      .update({ is_paid: newPaid, paid_at: paidAt })
      .eq("id", installment.id)
      .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at")
      .single();
    if (error || !data) return;

    const updatedInstallment = mapRowToFamilyInstallment(
      data as {
        id: string;
        item_id: string;
        installment_number: number;
        amount: number;
        due_date?: string | null;
        is_paid: boolean;
        paid_at: string | null;
        created_at: string;
      },
      item.purchaseDate,
    );
    const nextInstallments = getFamilyItemInstallments(item.id).map((row) =>
      row.id === installment.id ? updatedInstallment : row,
    );
    setFamilyInstallments((prev) =>
      prev.map((row) => (row.id === installment.id ? updatedInstallment : row)),
    );
    await updateFamilyItemStatus(item, nextInstallments);
  };

  const startEditFamilyInstallment = (installment: FamilyFinancingInstallment) => {
    setEditingFamilyInstallment(installment);
    setInstallmentEditForm({
      amount: String(installment.amount),
      dueMonth: installment.dueDate.slice(0, 7),
    });
    setInstallmentEditError(null);
  };

  const closeFamilyInstallmentModal = () => {
    setEditingFamilyInstallment(null);
    setInstallmentEditForm({ amount: "", dueMonth: "" });
    setInstallmentEditError(null);
  };

  const handleSubmitFamilyInstallmentEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingFamilyInstallment) return;
    const item = familyItems.find((row) => row.id === editingFamilyInstallment.itemId);
    if (!item) return;

    const parsedAmount = Number(installmentEditForm.amount.replace(/\s/g, "").replace(",", "."));
    if (!installmentEditForm.amount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setInstallmentEditError("Ingresa un monto válido mayor a 0.");
      return;
    }
    if (!installmentEditForm.dueMonth || !/^\d{4}-\d{2}$/.test(installmentEditForm.dueMonth)) {
      setInstallmentEditError("Selecciona un mes de pago válido.");
      return;
    }

    const dueDate = `${installmentEditForm.dueMonth}-01`;
    const { data, error } = await supabase
      .from("family_financing_installments")
      .update({ amount: parsedAmount, due_date: dueDate })
      .eq("id", editingFamilyInstallment.id)
      .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at")
      .single();
    if (error || !data) {
      setInstallmentEditError(error?.message || "No se pudo actualizar la cuota.");
      return;
    }

    const updatedInstallment = mapRowToFamilyInstallment(
      data as {
        id: string;
        item_id: string;
        installment_number: number;
        amount: number;
        due_date?: string | null;
        is_paid: boolean;
        paid_at: string | null;
        created_at: string;
      },
      item.purchaseDate,
    );
    setFamilyInstallments((prev) =>
      prev.map((row) => (row.id === editingFamilyInstallment.id ? updatedInstallment : row)),
    );
    closeFamilyInstallmentModal();
  };

  const confirmDeleteFamilyItemOk = async () => {
    if (!confirmDeleteFamilyItem) return;
    const id = confirmDeleteFamilyItem.id;
    const { error } = await supabase.from("family_financing_items").delete().eq("id", id);
    if (error) {
      setConfirmDeleteFamilyItem(null);
      return;
    }
    setFamilyItems((prev) => prev.filter((item) => item.id !== id));
    setFamilyInstallments((prev) => prev.filter((row) => row.itemId !== id));
    setConfirmDeleteFamilyItem(null);
  };

  const confirmDeleteFamilyItemCancel = () => {
    setConfirmDeleteFamilyItem(null);
  };

  const getGoalProgressPct = (goal: SavingsGoal) => {
    if (!goal.targetAmount || goal.targetAmount <= 0) return 0;
    return Math.min(100, (goal.currentAmount / goal.targetAmount) * 100);
  };

  const getGoalRemainingAmount = (goal: SavingsGoal) =>
    Math.max(0, goal.targetAmount - goal.currentAmount);

  const getGoalDaysLeft = (goal: SavingsGoal) => {
    if (!goal.deadline) return null;
    const [year, month, day] = goal.deadline.split("-");
    const d = new Date(Number(year), Number(month) - 1, Number(day));
    return daysUntil(d);
  };

  const activeGoals = useMemo(
    () =>
      savingsGoals
        .filter((g) => g.status !== "completed")
        .sort((a, b) => {
          const da = getGoalDaysLeft(a) ?? Number.POSITIVE_INFINITY;
          const db = getGoalDaysLeft(b) ?? Number.POSITIVE_INFINITY;
          return da - db;
        }),
    [savingsGoals],
  );
  const completedGoals = useMemo(
    () => savingsGoals.filter((g) => g.status === "completed"),
    [savingsGoals],
  );

  const activeFamilyItems = useMemo(
    () => familyItems.filter((item) => item.status !== "completed"),
    [familyItems],
  );

  const completedFamilyItems = useMemo(
    () => familyItems.filter((item) => item.status === "completed"),
    [familyItems],
  );

  const familyPendingTotal = useMemo(
    () => activeFamilyItems.reduce((sum, item) => sum + getFamilyItemRemaining(item), 0),
    [activeFamilyItems, familyInstallments],
  );

  const currentMonthFamilySummary = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthInstallments = familyInstallments.filter((inst) => {
      const [dueYear, dueMonth] = inst.dueDate.split("-").map(Number);
      return dueYear === year && dueMonth === month;
    });
    const total = monthInstallments.reduce((sum, inst) => sum + inst.amount, 0);
    const paidCount = monthInstallments.filter((inst) => inst.isPaid).length;
    const count = monthInstallments.length;
    let status: "paid" | "pending" | "partial" | "empty" = "empty";
    if (count === 0) status = "empty";
    else if (paidCount === count) status = "paid";
    else if (paidCount === 0) status = "pending";
    else status = "partial";
    return { year, month, total, paidCount, count, status };
  }, [familyInstallments]);

  useEffect(() => {
    if (
      !confirmDelete &&
      !confirmDeleteSalary &&
      !showNewTxModal &&
      !showAllTxModal &&
      !showSalaryForm &&
      !editingSalaryId &&
      !showGoalModal &&
      !showFamilyModal &&
      !editingFamilyInstallment &&
      !confirmDeleteFamilyItem &&
      !selectedGoalForContribution
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        confirmDeleteCancel();
        confirmDeleteSalaryCancel();
        closeNewTxModal();
        setShowAllTxModal(false);
        if (showSalaryForm || editingSalaryId) cancelEditSalary();
        if (showGoalModal) {
          setShowGoalModal(false);
          resetGoalForm();
        }
        if (showFamilyModal) {
          setShowFamilyModal(false);
          resetFamilyForm();
        }
        closeFamilyInstallmentModal();
        confirmDeleteFamilyItemCancel();
        if (selectedGoalForContribution) {
          closeContributionModal();
        }
        if (expandedChartModal) setExpandedChartModal(null);
        if (showCalendarModal) setShowCalendarModal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    confirmDelete,
    confirmDeleteSalary,
    showNewTxModal,
    showAllTxModal,
    showSalaryForm,
    editingSalaryId,
    showGoalModal,
    showFamilyModal,
    editingFamilyInstallment,
    confirmDeleteFamilyItem,
    selectedGoalForContribution,
    expandedChartModal,
    showCalendarModal,
  ]);

  return (
    <div className="app-shell-with-sidebar">
      <aside className="sidebar">
        <div
          className="sidebar-brand"
          role="button"
          tabIndex={0}
          onClick={() => setActiveView("dashboard")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActiveView("dashboard");
            }
          }}
        >
          <span className="sidebar-brand-icon" aria-hidden>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M12 8v8M8 12h8"/></svg>
          </span>
          <span className="sidebar-brand-text">Balance+</span>
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-nav-group">
            <div className="sidebar-nav-label">PRINCIPAL</div>
            <a
              href="#"
              className={`sidebar-nav-item ${activeView === "dashboard" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("dashboard"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              </span>
              Dashboard
            </a>
          </div>
          <div className="sidebar-nav-group">
            <div className="sidebar-nav-label">FINANZAS</div>
            <a
              href="#"
              className={`sidebar-nav-item ${activeView === "upcoming" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("upcoming"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </span>
              Próximos salarios
            </a>
            <a
              href="#"
              className={`sidebar-nav-item ${activeView === "goals" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("goals"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="3" x2="12" y2="5"/><line x1="21" y1="12" x2="19" y2="12"/><line x1="12" y1="21" x2="12" y2="19"/><line x1="3" y1="12" x2="5" y2="12"/></svg>
              </span>
              Metas de Ahorro
            </a>
            <a
              href="#"
              className={`sidebar-nav-item ${activeView === "familyFinancing" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("familyFinancing"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </span>
              Financiamiento familia
            </a>
            <a
              href="#"
              className={`sidebar-nav-item ${showCalendarModal ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                const d = new Date();
                setCalendarMonth({ year: d.getFullYear(), month: d.getMonth() + 1 });
                setCalendarHoveredDate(null);
                setShowCalendarModal(true);
              }}
              aria-label="Ver calendario de actividades"
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </span>
              Calendario
            </a>
          </div>
        </nav>
        <div className="sidebar-date-wrap">
          <span className="sidebar-date" aria-live="polite">
            {new Date().toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </span>
        </div>
      </aside>

      <div className="main-content">
        <header className="main-header">
          <nav className="breadcrumb" aria-label="Navegación">
            <button
              type="button"
              className="breadcrumb-link"
              onClick={() => setActiveView("dashboard")}
            >
              Balance+
            </button>
            <span className="breadcrumb-sep"> &gt; </span>
            <span className="breadcrumb-current">
              {activeView === "dashboard"
                ? "Dashboard"
                : activeView === "upcoming"
                ? "Próximos salarios"
                : activeView === "goals"
                ? "Metas de Ahorro"
                : "Financiamiento familia"}
            </span>
          </nav>
          {activeView === "dashboard" && (
            <div className={`reference-bar reference-bar-compact ${adeudado > 0 ? "reference-bar--owing" : "reference-bar--available"}`}>
              <span className="reference-left">
                <span className="reference-main">Mama y Papa</span>
                <span className="reference-amount">{formatCurrency(ahorrosMamaPapa)}</span>
              </span>
              <span className="reference-right">
                {adeudado > 0 ? `Faltando ${formatCurrency(adeudado)}` : `Disponible ${formatCurrency(-adeudado)}`}
              </span>
            </div>
          )}
          {activeView === "upcoming" && upcomingSalaries.length > 0 && (
            <div className="reference-bar reference-bar-compact reference-bar--lavender">
              <span className="reference-left">
                <span className="reference-main">Próximo cobro</span>
                <span className="reference-amount">
                  {MONTH_NAMES_ES[upcomingSalaries[0].month - 1]} {upcomingSalaries[0].year} · {formatCurrency(upcomingSalaries[0].amount)}
                </span>
              </span>
              <span className="reference-right">
                Cobro: {formatNextSalaryDate(upcomingSalaries[0].date)} · En {daysUntil(upcomingSalaries[0].date)} días
              </span>
            </div>
          )}
          {activeView === "goals" && activeGoals.length > 0 && (
            <div className="reference-bar reference-bar-compact reference-bar--goals">
              <span className="reference-left">
                <span className="reference-main">Metas activas</span>
                <span className="reference-amount">
                  {activeGoals.length} meta{activeGoals.length !== 1 ? "s" : ""} en curso
                </span>
              </span>
              <span className="reference-right">
                {(() => {
                  const next = activeGoals[0];
                  const daysLeft = getGoalDaysLeft(next);
                  return daysLeft != null
                    ? `Próxima meta vence en ${daysLeft} día${daysLeft !== 1 ? "s" : ""}`
                    : "Organiza y avanza en tus objetivos";
                })()}
              </span>
            </div>
          )}
          {activeView === "familyFinancing" && (
            <div
              className={`reference-bar reference-bar-compact reference-bar--family ${
                currentMonthFamilySummary.status === "paid"
                  ? "reference-bar--family-paid"
                  : currentMonthFamilySummary.status === "partial"
                  ? "reference-bar--family-partial"
                  : ""
              }`}
            >
              <span className="reference-left">
                <span className="reference-main">
                  Mes actual: {MONTH_NAMES_ES[currentMonthFamilySummary.month - 1]}{" "}
                  {currentMonthFamilySummary.year}
                </span>
                <span className="reference-amount">
                  {currentMonthFamilySummary.count === 0
                    ? "Sin cuotas este mes"
                    : `${formatCurrency(currentMonthFamilySummary.total)} a cobrar`}
                </span>
              </span>
              <span className="reference-right">
                {currentMonthFamilySummary.count === 0
                  ? "—"
                  : currentMonthFamilySummary.status === "paid"
                  ? "Pagado"
                  : currentMonthFamilySummary.status === "pending"
                  ? "Pendiente"
                  : `Parcial · ${currentMonthFamilySummary.paidCount}/${currentMonthFamilySummary.count} pagadas`}
              </span>
            </div>
          )}
        </header>

        {activeView === "upcoming" && (
          <section className="panel panel-upcoming panel-upcoming-page">
            <div className="salary-page-header">
              <h2 className="panel-title salary-page-title">Próximos salarios</h2>
              <button
                type="button"
                className="button button-add-salary"
                onClick={() => {
                  setSalaryError(null);
                  setShowSalaryForm(true);
                  setEditingSalaryId(null);
                  setSalaryForm({ year: new Date().getFullYear(), month: 1, hours: 176, hourlyRate: hourlyRate });
                }}
              >
                + Agregar salario
              </button>
            </div>

            {Object.keys(salaryTotalsByYear).length > 0 && (
              <div
                ref={totalsSliderRef}
                className={`salary-totals-by-year ${Object.keys(salaryTotalsByYear).length > 1 ? "salary-totals-slider" : ""}`}
                onMouseDown={handleTotalsSliderMouseDown}
              >
                {Object.entries(salaryTotalsByYear)
                  .sort(([a], [b]) => Number(b) - Number(a))
                  .map(([year, totals]) => (
                    <div key={year} className="salary-totals-card">
                      <h3 className="salary-totals-year">Año {year}</h3>
                      <div className="salary-totals-row">
                        <span className="salary-totals-label">Ingresos a la fecha</span>
                        <span className="salary-totals-value">{formatCurrency(totals.ingresosALaFecha)}</span>
                      </div>
                      <div className="salary-totals-row">
                        <span className="salary-totals-label">Ingresos proyectados (resto del año)</span>
                        <span className="salary-totals-value">{formatCurrency(totals.ingresosProyectados)}</span>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            <div className="salary-page-table-wrap">
              <table className="salary-page-table">
                <thead>
                  <tr>
                    <th>AÑO</th>
                    <th>MES</th>
                    <th className="salary-page-th-num">HORAS</th>
                    <th className="salary-page-th-num">$/HORA</th>
                    <th className="salary-page-th-num">SALARIO MENSUAL</th>
                    <th>FECHA DE COBRO</th>
                    <th className="salary-page-th-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const sorted = [...salaryEntries].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
                    if (sorted.length === 0) {
                      return (
                        <tr>
                          <td colSpan={7} className="salary-page-empty-cell">
                            No hay salarios cargados. Agregá uno con el botón de arriba.
                          </td>
                        </tr>
                      );
                    }
                    const totalPages = Math.max(1, Math.ceil(sorted.length / SALARY_PAGE_SIZE));
                    const currentPage = Math.min(Math.max(1, salaryPage), totalPages);
                    const start = (currentPage - 1) * SALARY_PAGE_SIZE;
                    const paginated = sorted.slice(start, start + SALARY_PAGE_SIZE);
                    return (
                      <>
                        {paginated.map((entry, rowIndex) => {
                      const now = new Date();
                      const isCurrentMonth = entry.year === now.getFullYear() && entry.month === now.getMonth() + 1;
                      const payDate = getLastBusinessDay(entry.year, entry.month);
                      const amount = entry.hours * entry.hourlyRate;
                      return (
                        <tr key={entry.id} className={isCurrentMonth ? "salary-page-row-current-month" : undefined}>
                          <td>{entry.year}</td>
                          <td>{MONTH_NAMES_ES[entry.month - 1]}</td>
                          <td className="salary-page-td-num">{entry.hours}</td>
                          <td className="salary-page-td-num">{formatCurrency(entry.hourlyRate)}</td>
                          <td className="salary-page-td-num">{formatCurrency(amount)}</td>
                          <td>{formatNextSalaryDate(payDate)}</td>
                          <td className="salary-page-td-actions">
                            <div className="salary-page-row-actions">
                              <button
                                type="button"
                                className="salary-page-action-btn salary-page-action-btn--edit"
                                onClick={() => {
                                  setSalaryError(null);
                                  startEditSalary(entry);
                                  setShowSalaryForm(true);
                                }}
                                aria-label="Editar"
                                title="Editar"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                              </button>
                              <button
                                type="button"
                                className="salary-page-action-btn salary-page-action-btn--delete"
                                onClick={() => setConfirmDeleteSalary(entry)}
                                aria-label="Eliminar"
                                title="Eliminar"
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                      </>
                    );
                  })()}
                </tbody>
              </table>
            </div>
            {salaryEntries.length > 0 && (() => {
              const sorted = [...salaryEntries].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
              const totalPages = Math.max(1, Math.ceil(sorted.length / SALARY_PAGE_SIZE));
              const currentPage = Math.min(Math.max(1, salaryPage), totalPages);
              return (
                <div className="salary-page-pagination">
                  <button
                    type="button"
                    className="button button-secondary salary-page-pagination-btn"
                    disabled={currentPage <= 1}
                    onClick={() => setSalaryPage((p) => Math.max(1, p - 1))}
                  >
                    Anterior
                  </button>
                  <span className="salary-page-pagination-info">
                    Página {currentPage} de {totalPages}
                  </span>
                  <button
                    type="button"
                    className="button button-secondary salary-page-pagination-btn"
                    disabled={currentPage >= totalPages}
                    onClick={() => setSalaryPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Siguiente
                  </button>
                </div>
              );
            })()}
          </section>
        )}

        {activeView === "goals" && (
          <section className="panel panel-goals">
            <div className="goals-layout">
              <div className="goals-list-card">
                <div className="goals-list-header">
                  <h2 className="panel-title">Tus metas activas</h2>
                  <div className="goals-list-header-right">
                    <p className="panel-sub-right">
                      {activeGoals.length === 0
                        ? "Todavía no creaste metas"
                        : `${activeGoals.length} meta${activeGoals.length !== 1 ? "s" : ""} en curso`}
                    </p>
                    <button
                      type="button"
                      className="button goals-add-button"
                      onClick={() => {
                        resetGoalForm();
                        setShowGoalModal(true);
                      }}
                    >
                      + Nueva meta
                    </button>
                  </div>
                </div>
                {activeGoals.length === 0 ? (
                  <div className="goals-empty-state">
                    <p className="goals-empty-title">Empieza creando tu primera meta</p>
                    <p className="goals-empty-sub">
                      Por ejemplo: "Fondo de emergencias", "Viaje de vacaciones" o "Nuevo equipo".
                    </p>
                  </div>
                ) : (
                  <div
                    ref={goalsSliderRef}
                    className="goals-grid goals-slider"
                    onMouseDown={makeHorizontalDragHandler(goalsSliderRef, goalsDragRef)}
                  >
                    {activeGoals.map((goal) => {
                      const progressPct = getGoalProgressPct(goal);
                      const remaining = getGoalRemainingAmount(goal);
                      const daysLeft = getGoalDaysLeft(goal);
                      const isAtRisk = goal.status === "at_risk";
                      const isCompleted = goal.status === "completed";
                      return (
                        <article key={goal.id} className="goal-card">
                          <header className="goal-card-header">
                            <div>
                              <h3 className="goal-card-title">{goal.name}</h3>
                              <p className="goal-card-category">{goal.category}</p>
                            </div>
                            {(goal.currentAmount > 0 || isCompleted) && (
                              <span
                                className={`goal-status-chip goal-status-chip--${goal.status}`}
                              >
                                {isCompleted
                                  ? "Completada"
                                  : isAtRisk
                                  ? "En riesgo"
                                  : "En curso"}
                              </span>
                            )}
                          </header>

                          <div className="goal-progress">
                            <div className="goal-progress-bar">
                              <div
                                className={`goal-progress-fill goal-progress-fill--${goal.status}`}
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                            <div className="goal-progress-row">
                              <span className="goal-progress-main">
                                Llevas{" "}
                                <strong>
                                  {formatCurrency(goal.currentAmount)} /{" "}
                                  {formatCurrency(goal.targetAmount)}
                                </strong>
                              </span>
                              <span className="goal-progress-pct">
                                {progressPct.toFixed(0)}%
                              </span>
                            </div>
                            <p className="goal-progress-remaining">
                              {remaining > 0
                                ? `Te faltan ${formatCurrency(remaining)} para llegar.`
                                : "¡Meta alcanzada! 🎉"}
                            </p>
                            {daysLeft != null && (
                              <p className="goal-deadline">
                                Te quedan{" "}
                                <strong>
                                  {daysLeft} día{daysLeft !== 1 ? "s" : ""}
                                </strong>{" "}
                                para tu objetivo.
                              </p>
                            )}
                          </div>

                          <footer className="goal-card-footer">
                            <button
                              type="button"
                              className="button button-secondary goal-card-btn goal-card-btn-icon"
                              data-tooltip="Aportar"
                              onClick={() => {
                                setSelectedGoalForContribution(goal);
                                setContributionAmount("");
                                setContributionError(null);
                                setEditingContribution(null);
                              }}
                              aria-label="Aportar"
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            </button>
                            <button
                              type="button"
                              className="button button-secondary goal-card-btn goal-card-btn-icon"
                              data-tooltip="Editar"
                              onClick={() => startEditGoal(goal)}
                              aria-label="Editar"
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                            </button>
                            <button
                              type="button"
                              className="button button-secondary goal-card-btn goal-card-btn-icon"
                              data-tooltip="Resetear progreso"
                              onClick={() => setConfirmResetGoal(goal)}
                              aria-label="Resetear progreso"
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                            </button>
                            <button
                              type="button"
                              className="button goal-card-btn goal-card-btn-icon"
                              data-tooltip="Marcar como completada"
                              onClick={() => markGoalCompleted(goal.id)}
                              aria-label="Marcar como completada"
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                            </button>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <section className="goals-achievements">
              <h2 className="panel-title">Logros</h2>
              {completedGoals.length === 0 ? (
                <p className="goals-achievements-empty">
                  Cuando completes una meta, aparecerá aquí para que puedas celebrar tus avances.
                </p>
              ) : (
                <div
                  ref={achievementsSliderRef}
                  className="goals-achievements-grid goals-slider"
                  onMouseDown={makeHorizontalDragHandler(achievementsSliderRef, achievementsDragRef)}
                >
                  {completedGoals.map((goal) => (
                    <article key={goal.id} className="goal-achievement-card">
                      <div className="goal-achievement-header">
                        <span className="goal-achievement-icon" aria-hidden>
                          🏆
                        </span>
                        <div>
                          <h3 className="goal-achievement-title">{goal.name}</h3>
                          <p className="goal-achievement-category">{goal.category}</p>
                        </div>
                      </div>
                      <p className="goal-achievement-amount">
                        Alcanzaste {formatCurrency(goal.targetAmount)} para esta meta.
                      </p>
                      <p className="goal-achievement-date">
                        Creada el {formatDisplayDate(goal.createdAt)}
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        )}

        {activeView === "familyFinancing" && (
          <section className="panel panel-family">
            <div className="goals-layout">
              <div className="goals-list-card">
                <div className="goals-list-header">
                  <h2 className="panel-title">Financiamiento familia</h2>
                  <div className="goals-list-header-right">
                    <p className="panel-sub-right">
                      {activeFamilyItems.length === 0
                        ? "Todavía no cargaste items"
                        : `${activeFamilyItems.length} item${activeFamilyItems.length !== 1 ? "s" : ""} en curso · Pendiente total ${formatCurrency(familyPendingTotal)}`}
                    </p>
                    <button
                      type="button"
                      className="button goals-add-button"
                      onClick={() => {
                        resetFamilyForm();
                        setShowFamilyModal(true);
                      }}
                    >
                      + Nuevo item
                    </button>
                  </div>
                </div>

                {activeFamilyItems.length === 0 ? (
                  <div className="goals-empty-state">
                    <p className="goals-empty-title">Registrá una compra financiada</p>
                    <p className="goals-empty-sub">
                      Por ejemplo: electrodoméstico, medicamentos o compras del super que tus papás van devolviendo en cuotas.
                    </p>
                  </div>
                ) : (
                  <div
                    ref={familySliderRef}
                    className="goals-grid goals-slider"
                    onMouseDown={makeHorizontalDragHandler(familySliderRef, familyDragRef)}
                  >
                    {activeFamilyItems.map((item) => {
                      const installments = getFamilyItemInstallments(item.id);
                      const paidAmount = getFamilyItemPaidAmount(item.id);
                      const remaining = getFamilyItemRemaining(item);
                      const progressPct = getFamilyItemProgressPct(item);
                      const paidCount = installments.filter((row) => row.isPaid).length;
                      const installmentsTotal = getFamilyItemInstallmentsTotal(item.id);
                      const installmentsMismatch =
                        Math.abs(installmentsTotal - item.totalAmount) > 0.01;
                      return (
                        <article key={item.id} className="goal-card family-item-card">
                          <header className="goal-card-header">
                            <div>
                              <h3 className="goal-card-title">{item.name}</h3>
                              <p className="goal-card-category family-item-date">
                                Compra: {formatDisplayDate(item.purchaseDate)}
                              </p>
                              {item.notes && (
                                <p className="family-item-notes">{item.notes}</p>
                              )}
                            </div>
                            <span className="goal-status-chip goal-status-chip--in_progress">
                              En curso
                            </span>
                          </header>

                          <div className="goal-progress">
                            <div className="goal-progress-bar">
                              <div
                                className="goal-progress-fill goal-progress-fill--in_progress"
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                            <div className="goal-progress-row">
                              <span className="goal-progress-main">
                                Pagado{" "}
                                <strong>
                                  {formatCurrency(paidAmount)} / {formatCurrency(item.totalAmount)}
                                </strong>
                              </span>
                              <span className="goal-progress-pct">
                                {progressPct.toFixed(0)}%
                              </span>
                            </div>
                            <p className="goal-progress-remaining">
                              Restan {formatCurrency(remaining)} de {formatCurrency(item.totalAmount)}.
                            </p>
                            <p className="family-installments-summary">
                              {paidCount}/{installments.length} cuota{installments.length !== 1 ? "s" : ""} pagada{paidCount !== 1 ? "s" : ""}
                            </p>
                            {installmentsMismatch && (
                              <p className="family-installments-hint">
                                Las cuotas suman {formatCurrency(installmentsTotal)} (total del item:{" "}
                                {formatCurrency(item.totalAmount)})
                              </p>
                            )}
                          </div>

                          <div className="family-installments">
                            {installments.map((installment) => (
                              <div
                                key={installment.id}
                                className={`family-installment-row ${installment.isPaid ? "family-installment-row--paid" : ""}`}
                              >
                                <label className="family-installment-check">
                                  <input
                                    type="checkbox"
                                    checked={installment.isPaid}
                                    onChange={() => void toggleFamilyInstallmentPaid(installment)}
                                  />
                                  <span>
                                    Cuota {installment.installmentNumber} · {formatDueMonth(installment.dueDate)}
                                  </span>
                                </label>
                                <div className="family-installment-actions">
                                  <span className="family-installment-amount">
                                    {formatCurrency(installment.amount)}
                                  </span>
                                  <button
                                    type="button"
                                    className="button button-secondary family-installment-edit-btn"
                                    onClick={() => startEditFamilyInstallment(installment)}
                                    aria-label={`Editar cuota ${installment.installmentNumber}`}
                                  >
                                    Editar
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>

                          <footer className="goal-card-footer">
                            <button
                              type="button"
                              className="button button-secondary goal-card-btn goal-card-btn-icon"
                              data-tooltip="Editar"
                              onClick={() => startEditFamilyItem(item)}
                              aria-label="Editar"
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            <button
                              type="button"
                              className="button button-secondary goal-card-btn goal-card-btn-icon"
                              data-tooltip="Eliminar"
                              onClick={() => setConfirmDeleteFamilyItem(item)}
                              aria-label="Eliminar"
                            >
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>

              {completedFamilyItems.length > 0 && (
                <section className="goals-achievements-section">
                  <h2 className="panel-title goals-achievements-title">Completados</h2>
                  <div
                    className="goals-grid goals-slider goals-achievements-grid"
                  >
                    {completedFamilyItems.map((item) => (
                      <article key={item.id} className="goal-achievement-card">
                        <div className="goal-achievement-header">
                          <span className="goal-achievement-icon" aria-hidden>
                            ✓
                          </span>
                          <div>
                            <h3 className="goal-achievement-title">{item.name}</h3>
                            <p className="goal-achievement-category">
                              {formatCurrency(item.totalAmount)} · {item.installmentCount} cuota{item.installmentCount !== 1 ? "s" : ""}
                            </p>
                          </div>
                        </div>
                        <p className="goal-achievement-amount">
                          Compra del {formatDisplayDate(item.purchaseDate)}
                        </p>
                        {item.notes && (
                          <p className="family-item-notes family-item-notes--achievement">{item.notes}</p>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </section>
        )}

      {confirmDelete && (
        <div
          className="modal-overlay"
          onClick={confirmDeleteCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-delete-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-delete-title" className="modal-title">
              Eliminar movimiento
            </h2>
            {confirmDelete && (
              <p className="modal-body">
                ¿Seguro que quieres eliminar este movimiento?
                <br />
                <strong>
                  {formatDisplayDate(confirmDelete.date)} · {confirmDelete.place} ·{" "}
                  {formatCurrency(confirmDelete.amount)}
                </strong>
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={confirmDeleteCancel}
              >
                Cancelar
              </button>
              <button type="button" className="button" onClick={confirmDeleteOk}>
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteSalary && (
        <div
          className="modal-overlay"
          onClick={confirmDeleteSalaryCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-delete-salary-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-delete-salary-title" className="modal-title">
              Eliminar salario
            </h2>
            <p className="modal-body">
              ¿Seguro que querés eliminar este salario?
              <br />
              <strong>
                {MONTH_NAMES_ES[confirmDeleteSalary.month - 1]} {confirmDeleteSalary.year} ·{" "}
                {formatCurrency(confirmDeleteSalary.hours * confirmDeleteSalary.hourlyRate)}
              </strong>
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={confirmDeleteSalaryCancel}
              >
                Cancelar
              </button>
              <button type="button" className="button" onClick={confirmDeleteSalaryOk}>
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmResetGoal && (
        <div
          className="modal-overlay"
          onClick={() => setConfirmResetGoal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-reset-goal-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-reset-goal-title" className="modal-title">
              Resetear progreso
            </h2>
            <p className="modal-body">
              ¿Seguro que querés resetear el progreso de esta meta a 0?
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setConfirmResetGoal(null)}
              >
                Cancelar
              </button>
              <button type="button" className="button" onClick={() => void handleResetGoalProgress()}>
                Resetear
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteFamilyItem && (
        <div
          className="modal-overlay"
          onClick={confirmDeleteFamilyItemCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-delete-family-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-delete-family-title" className="modal-title">
              Eliminar item
            </h2>
            <p className="modal-body">
              ¿Seguro que querés eliminar este item de financiamiento?
              <br />
              <strong>
                {confirmDeleteFamilyItem.name} · {formatCurrency(confirmDeleteFamilyItem.totalAmount)}
              </strong>
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={confirmDeleteFamilyItemCancel}
              >
                Cancelar
              </button>
              <button type="button" className="button" onClick={() => void confirmDeleteFamilyItemOk()}>
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {showFamilyModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowFamilyModal(false);
            resetFamilyForm();
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-family-title"
        >
          <div
            className="modal modal-goal-form"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-goal-header">
              <div>
                <h2 id="modal-family-title" className="modal-title">
                  {editingFamilyItemId ? "Editar item" : "Nuevo item"}
                </h2>
                <p className="modal-goal-subtitle">
                  Registrá una compra financiada y cuántas cuotas van a devolver.
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => {
                  setShowFamilyModal(false);
                  resetFamilyForm();
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmitFamilyItem} className="modal-goal-form-body">
              <div className="goals-modal-fields">
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Nombre del producto</label>
                  </div>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ej. Heladera, medicamentos, supermercado"
                    value={familyForm.name}
                    onChange={handleFamilyFieldChange("name")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Monto total</label>
                    <span className="field-hint">Sin comas, solo números</span>
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input"
                    placeholder="2500"
                    value={familyForm.totalAmount}
                    onChange={handleFamilyFieldChange("totalAmount")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Fecha de compra</label>
                  </div>
                  <input
                    type="date"
                    className="input"
                    value={familyForm.purchaseDate}
                    onChange={handleFamilyFieldChange("purchaseDate")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Cantidad de cuotas</label>
                    <span className="field-hint">1 = pago único</span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="input"
                    value={familyForm.installmentCount}
                    onChange={handleFamilyFieldChange("installmentCount")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Notas (opcional)</label>
                  </div>
                  <textarea
                    className="textarea"
                    placeholder="Detalle adicional sobre la compra"
                    value={familyForm.notes}
                    onChange={handleFamilyFieldChange("notes")}
                  />
                </div>
              </div>
              {familyFormError && (
                <div className="error-text goals-error-text">{familyFormError}</div>
              )}
              <div className="modal-actions modal-goal-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setShowFamilyModal(false);
                    resetFamilyForm();
                  }}
                >
                  Cancelar
                </button>
                <button type="submit" className="button">
                  {editingFamilyItemId ? "Guardar cambios" : "Crear item"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingFamilyInstallment && (
        <div
          className="modal-overlay"
          onClick={closeFamilyInstallmentModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-family-installment-title"
        >
          <div className="modal modal-family-installment" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-family-installment-title" className="modal-title">
              Editar cuota {editingFamilyInstallment.installmentNumber}
            </h2>
            <p className="modal-body modal-family-installment-sub">
              Ajustá el monto o el mes de pago si adelantaron, atrasaron o pagaron un valor distinto.
            </p>
            <form onSubmit={handleSubmitFamilyInstallmentEdit}>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Monto de la cuota</label>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  className="input"
                  value={installmentEditForm.amount}
                  onChange={(e) => {
                    setInstallmentEditForm((prev) => ({ ...prev, amount: e.target.value }));
                    setInstallmentEditError(null);
                  }}
                />
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Mes de pago</label>
                </div>
                <input
                  type="month"
                  className="input"
                  value={installmentEditForm.dueMonth}
                  onChange={(e) => {
                    setInstallmentEditForm((prev) => ({ ...prev, dueMonth: e.target.value }));
                    setInstallmentEditError(null);
                  }}
                />
              </div>
              {installmentEditError && (
                <div className="error-text goals-error-text">{installmentEditError}</div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={closeFamilyInstallmentModal}
                >
                  Cancelar
                </button>
                <button type="submit" className="button">
                  Guardar cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAllTxModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowAllTxModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-all-tx-title"
        >
          <div className="modal modal-all-transactions" onClick={(e) => e.stopPropagation()}>
            <div className="modal-all-tx-header">
              <h2 id="modal-all-tx-title" className="modal-title">
                Todas las transacciones
              </h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowAllTxModal(false)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <p className="modal-all-tx-sub">
              {entries.length} movimiento{entries.length !== 1 ? "s" : ""} en total
            </p>
            <div className="tx-list-all-wrap">
              <ul className="tx-list-plain">
                {entries.map((entry) => {
                  const positive = entry.amount >= 0;
                  return (
                    <li key={entry.id} className="tx-list-plain-item">
                      <span className={`tx-list-icon ${positive ? "tx-list-icon-in" : "tx-list-icon-out"}`}>
                        {positive ? "↑" : "↓"}
                      </span>
                      <div className="tx-list-body">
                        <span className="tx-list-desc">{entry.comment || "Sin descripción"}</span>
                        <span className="tx-list-meta">
                          {entry.place} · {formatDisplayDate(entry.date)}
                        </span>
                      </div>
                      <div className="tx-list-right">
                        <span className={positive ? "tx-list-amount-in" : "tx-list-amount-out"}>
                          {positive ? "+" : ""}{formatCurrency(entry.amount)}
                        </span>
                        <button
                          type="button"
                          className="btn-delete-inline"
                          onClick={() => handleDelete(entry.id)}
                          title="Eliminar"
                        >
                          Eliminar
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}

      {showNewTxModal && (
        <div
          className="modal-overlay"
          onClick={closeNewTxModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-new-tx-title"
        >
          <div className="modal modal-transaction" onClick={(e) => e.stopPropagation()}>
            <div className="modal-transaction-header">
              <div>
                <h2 id="modal-new-tx-title" className="modal-title modal-transaction-title">
                  Nueva transacción
                </h2>
                <p className="modal-transaction-subtitle">
                  Registra un movimiento de dinero en tus fuentes.
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={closeNewTxModal}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmitNewTx}>
              <div className="tx-type-group">
                <span className="tx-type-label">Tipo</span>
                <div className="tx-type-btns">
                  <button
                    type="button"
                    className={`tx-type-btn ${txType === "income" ? "tx-type-btn-active" : ""}`}
                    onClick={() => setTxType("income")}
                  >
                    <span className="tx-type-icon">←</span>
                    Ingreso
                  </button>
                  <button
                    type="button"
                    className={`tx-type-btn ${txType === "expense" ? "tx-type-btn-active" : ""}`}
                    onClick={() => setTxType("expense")}
                  >
                    <span className="tx-type-icon">→</span>
                    Gasto
                  </button>
                  <button
                    type="button"
                    className={`tx-type-btn ${txType === "transfer" ? "tx-type-btn-active" : ""}`}
                    onClick={() => setTxType("transfer")}
                  >
                    <span className="tx-type-icon">↔</span>
                    Transferencia
                  </button>
                </div>
              </div>

              <div className="tx-field">
                <label className="tx-label">Monto</label>
                <div className="tx-amount-wrap">
                  <span className="tx-amount-prefix">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className={`input tx-amount-input ${txAmountError ? "input-error" : ""}`}
                    placeholder="0.00"
                    value={txAmount}
                    onChange={(e) => {
                      setTxAmount(e.target.value);
                      setTxAmountError(null);
                    }}
                  />
                </div>
                {txAmountError && <div className="error-text">{txAmountError}</div>}
              </div>

              <div className="tx-field">
                <label className="tx-label">Fuente</label>
                <select
                  className="select tx-select"
                  value={txSource}
                  onChange={(e) => setTxSource(e.target.value)}
                >
                  {places.map((place) => (
                    <option key={place} value={place}>
                      {place}
                    </option>
                  ))}
                </select>
              </div>

              {txType === "transfer" && (
                <div className="tx-field">
                  <label className="tx-label">Destino</label>
                  <select
                    className="select tx-select"
                    value={txDestination === txSource ? "" : txDestination}
                    onChange={(e) => setTxDestination(e.target.value)}
                  >
                    <option value="">Selecciona destino</option>
                    {places.filter((p) => p !== txSource).map((place) => (
                      <option key={place} value={place}>
                        {place}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="tx-field">
                <label className="tx-label">Fecha</label>
                <input
                  type="date"
                  className="input tx-date-input"
                  value={txDate}
                  onChange={(e) => setTxDate(e.target.value)}
                />
              </div>

              <div className="tx-field">
                <label className="tx-label">Descripción</label>
                <textarea
                  className="textarea tx-description"
                  placeholder="¿Para qué fue esta transacción?"
                  value={txDescription}
                  onChange={(e) => setTxDescription(e.target.value)}
                />
              </div>

              <div className="modal-actions modal-transaction-actions">
                <button type="button" className="button button-secondary" onClick={closeNewTxModal}>
                  Cancelar
                </button>
                <button type="submit" className="button button-tx-submit">
                  Agregar transacción
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showGoalModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowGoalModal(false);
            resetGoalForm();
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-goal-title"
        >
          <div
            className="modal modal-goal-form"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-goal-header">
              <div>
                <h2 id="modal-goal-title" className="modal-title">
                  {editingGoalId ? "Editar meta de ahorro" : "Nueva meta de ahorro"}
                </h2>
                <p className="modal-goal-subtitle">
                  Define un objetivo, un monto a alcanzar y una fecha límite opcional.
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => {
                  setShowGoalModal(false);
                  resetGoalForm();
                }}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            <form
              onSubmit={handleSubmitGoal}
              className="modal-goal-form-body"
            >
              <div className="goals-modal-fields">
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Nombre de la meta</label>
                  </div>
                  <input
                    type="text"
                    className="input"
                    placeholder="Ej. Fondo de emergencias"
                    value={goalForm.name}
                    onChange={handleGoalFieldChange("name")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Monto objetivo</label>
                    <span className="field-hint">Sin comas, solo números</span>
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input"
                    placeholder="50000"
                    value={goalForm.targetAmount}
                    onChange={handleGoalFieldChange("targetAmount")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Fecha límite (opcional)</label>
                  </div>
                  <input
                    type="date"
                    className="input"
                    value={goalForm.deadline}
                    onChange={handleGoalFieldChange("deadline")}
                  />
                </div>
                <div className="field">
                  <div className="field-label-row">
                    <label className="field-label">Categoría de ahorro</label>
                  </div>
                  <select
                    className="select"
                    value={goalForm.category}
                    onChange={handleGoalFieldChange("category")}
                  >
                    <option value="">Selecciona o escribe</option>
                    <option value="Viajes">Viajes</option>
                    <option value="Tecnología">Tecnología</option>
                    <option value="Salud">Salud</option>
                    <option value="Hogar">Hogar</option>
                    <option value="Emergencias">Emergencias</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
              </div>
              {goalFormError && (
                <div className="error-text goals-error-text">{goalFormError}</div>
              )}
              <div className="modal-actions modal-goal-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setShowGoalModal(false);
                    resetGoalForm();
                  }}
                >
                  Cancelar
                </button>
                <button type="submit" className="button">
                  {editingGoalId ? "Guardar cambios" : "Crear meta"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedGoalForContribution && (
        <div
          className="modal-overlay"
          onClick={closeContributionModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-goal-contribution-title"
        >
          <div
            className="modal modal-goal-contribution"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-goal-contribution-header">
              <div>
                <h2
                  id="modal-goal-contribution-title"
                  className="modal-title"
                >
                  {editingContribution ? "Editar aporte" : "Aportar a la meta"}
                </h2>
                <p className="modal-goal-contribution-sub">
                  {editingContribution
                    ? "Actualiza el monto de un aporte manual ya registrado."
                    : "Registra manualmente un aporte a esta meta de ahorro."}
                </p>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={closeContributionModal}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmitContribution}>
              <div className="goal-contribution-summary">
                <div className="goal-contribution-main">
                  <span className="goal-contribution-name">
                    {selectedGoalForContribution.name}
                  </span>
                  <span className="goal-contribution-category">
                    {selectedGoalForContribution.category}
                  </span>
                </div>
                <div className="goal-contribution-amounts">
                  <span className="goal-contribution-amount">
                    {formatCurrency(selectedGoalForContribution.currentAmount)}{" "}
                    / {formatCurrency(selectedGoalForContribution.targetAmount)}
                  </span>
                </div>
              </div>

              <div className="tx-field">
                <label className="tx-label">Monto del aporte</label>
                <div className="tx-amount-wrap">
                  <span className="tx-amount-prefix">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className={`input tx-amount-input ${
                      contributionError ? "input-error" : ""
                    }`}
                    placeholder="0.00"
                    value={contributionAmount}
                    onChange={(e) => {
                      setContributionAmount(e.target.value);
                      setContributionError(null);
                    }}
                  />
                </div>
                {contributionError && (
                  <div className="error-text">{contributionError}</div>
                )}
              </div>

              <div className="modal-actions modal-transaction-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={closeContributionModal}
                >
                  Cancelar
                </button>
                <button type="submit" className="button">
                  {editingContribution ? "Guardar cambios" : "Guardar aporte"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {(showSalaryForm || editingSalaryId) && (
        <div
          className="modal-overlay"
          onClick={cancelEditSalary}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-salary-title"
        >
          <div className="modal modal-salary-form" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-salary-title" className="modal-title">
              {editingSalaryId ? "Editar salario" : "Agregar salario"}
            </h2>
            <div className="salary-form-card-fields">
              <div className="salary-abm-field">
                <label htmlFor="salary-year">Año</label>
                <input
                  id="salary-year"
                  type="number"
                  min="2020"
                  max="2030"
                  className="input salary-abm-input"
                  value={salaryForm.year}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, year: Number(e.target.value) || f.year }))}
                />
              </div>
              <div className="salary-abm-field">
                <label htmlFor="salary-month">Mes</label>
                <select
                  id="salary-month"
                  className="select salary-abm-select"
                  value={salaryForm.month}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, month: Number(e.target.value) }))}
                >
                  {MONTH_NAMES_ES.map((name, i) => (
                    <option key={i} value={i + 1}>{name}</option>
                  ))}
                </select>
              </div>
              <div className="salary-abm-field">
                <label htmlFor="salary-hours">Horas</label>
                <input
                  id="salary-hours"
                  type="number"
                  min="1"
                  className="input salary-abm-input"
                  value={salaryForm.hours}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, hours: Number(e.target.value) || 0 }))}
                />
              </div>
              <div className="salary-abm-field">
                <label htmlFor="salary-hourly">Monto por hora ($)</label>
                <input
                  id="salary-hourly"
                  type="number"
                  min="0"
                  step="0.01"
                  className="input salary-abm-input"
                  value={salaryForm.hourlyRate}
                  onChange={(e) => setSalaryForm((f) => ({ ...f, hourlyRate: Number(e.target.value) || 0 }))}
                />
              </div>
            </div>
            <p className="salary-abm-calc">Monto mensual: {formatCurrency(salaryForm.hours * salaryForm.hourlyRate)}</p>
            {salaryError && (
              <p className="salary-modal-error" role="alert">
                {salaryError}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={cancelEditSalary}>
                Cancelar
              </button>
              {editingSalaryId ? (
                <button type="button" className="button" onClick={updateSalaryEntry}>
                  Guardar
                </button>
              ) : (
                <button
                  type="button"
                  className="button"
                  onClick={addSalaryEntry}
                  disabled={salaryEntries.some((e) => e.year === salaryForm.year && e.month === salaryForm.month) || salaryForm.hours <= 0 || salaryForm.hourlyRate < 0}
                >
                  Agregar
                </button>
              )}
            </div>
          </div>
        </div>
      )}

        {activeView === "dashboard" && (
        <>
        <div className="dashboard-columns">
          <section className="panel panel-accounts">
            <div className="panel-accounts-content">
              <h2 className="panel-title">Mis cuentas</h2>
              <div className="panel-total-row">
                <div className="panel-total">{formatCurrency(grandTotal)}</div>
                <div className={`panel-total-variation ${totalVsLastMonth.positive ? "panel-total-variation--up" : "panel-total-variation--down"}`}>
                  <span className="panel-total-variation-pill">
                    <span className="panel-total-variation-arrow" aria-hidden>
                      {totalVsLastMonth.positive ? "↑" : "↓"}
                    </span>
                    <span className="panel-total-variation-pct">
                      {totalVsLastMonth.pct.toFixed(1)}%
                    </span>
                  </span>
                  <span className="panel-total-variation-label">vs último mes</span>
                </div>
              </div>
              <p className="panel-sub">Saldo total en todas las fuentes</p>
              <ul className="accounts-list">
                {places.map((place) => {
                  const value = totalsByPlace[place] ?? 0;
                  const positive = value >= 0;
                  return (
                    <li key={place} className="accounts-list-item">
                      <AccountIcon place={place} />
                      <span className="accounts-list-name">{place}</span>
                      <span className="accounts-list-balance">
                        {positive ? "+" : ""}{formatCurrency(value)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="panel-actions">
              <button type="button" className="button" onClick={openNewTxModal}>
                + Nueva transacción
              </button>
            </div>
          </section>

          <section className="panel panel-transactions">
            <h2 className="panel-title">Transacciones recientes</h2>
            <p className="panel-sub-right">
              Actividad reciente ({entries.length} movimientos)
            </p>
            <div className="tx-list-dashboard-wrap">
              <ul className="tx-list-plain">
                {entries.slice(0, DASHBOARD_TX_LIMIT).map((entry) => {
                  const positive = entry.amount >= 0;
                  return (
                    <li key={entry.id} className="tx-list-plain-item">
                      <span className={`tx-list-icon ${positive ? "tx-list-icon-in" : "tx-list-icon-out"}`}>
                        {positive ? "↑" : "↓"}
                      </span>
                      <div className="tx-list-body">
                        <span className="tx-list-desc">{entry.comment || "Sin descripción"}</span>
                        <span className="tx-list-meta">
                          {entry.place} · {formatDisplayDate(entry.date)}
                        </span>
                      </div>
                      <div className="tx-list-right">
                        <span className={positive ? "tx-list-amount-in" : "tx-list-amount-out"}>
                          {positive ? "+" : ""}{formatCurrency(entry.amount)}
                        </span>
                        <button
                          type="button"
                          className="btn-delete-inline"
                          onClick={() => handleDelete(entry.id)}
                          title="Eliminar"
                        >
                          Eliminar
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="panel-transactions-footer">
              <button
                type="button"
                className="button button-ver-todas"
                onClick={() => setShowAllTxModal(true)}
              >
                Ver todas las transacciones →
              </button>
            </div>
          </section>
        </div>

        {/* Fila de gráficos: Saldo al cierre + Flujo de dinero (misma altura) */}
        <div className="dashboard-charts-row">
        <section className="panel panel-monthly-chart">
          <div className="monthly-chart-header">
            <div className="monthly-chart-title-row">
              <h2 className="panel-title monthly-chart-title">Saldo al cierre del mes</h2>
              {monthlyChartVsLastMonth != null && (
                <div className={`panel-total-variation monthly-chart-variation ${monthlyChartVsLastMonth.positive ? "panel-total-variation--up" : "panel-total-variation--down"}`}>
                  <span className="panel-total-variation-pill">
                    <span className="panel-total-variation-arrow" aria-hidden>
                      {monthlyChartVsLastMonth.positive ? "↑" : "↓"}
                    </span>
                    <span className="panel-total-variation-pct">
                      {monthlyChartVsLastMonth.pct.toFixed(1)}%
                    </span>
                  </span>
                  <span className="panel-total-variation-label">vs último mes</span>
                </div>
              )}
              <button
                type="button"
                className="chart-expand-btn"
                onClick={() => setExpandedChartModal("monthly")}
                title="Ver gráfico más grande"
                aria-label="Ver gráfico más grande"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
              </button>
            </div>
            <p className="monthly-chart-total">{formatCurrency(grandTotal)}</p>
            <p className="panel-sub monthly-chart-sub">Saldo al cierre · últimos 5 meses</p>
          </div>
          <div className="monthly-chart-wrap">
            {monthlyClosingBalances.length === 0 ? (
              <p className="monthly-chart-empty">No hay movimientos para mostrar.</p>
            ) : (
              <>
                <div className="monthly-chart-legend">
                  {places.map((place, idx) => (
                    <span key={place} className="monthly-chart-legend-item">
                      <span
                        className="monthly-chart-legend-dot"
                        style={{
                          background:
                            idx === 0 ? "#8b5cf6" : idx === 1 ? "#06b6d4" : "#f97316",
                        }}
                      />
                      {place}
                    </span>
                  ))}
                </div>
                {(() => {
                  const extremes = monthlyClosingBalances.reduce(
                    (acc, m) => ({
                      max: Math.max(acc.max, m.total),
                      min: Math.min(acc.min, m.total),
                    }),
                    { max: 0, min: 0 },
                  );
                  const hasNegatives = extremes.min < 0;
                  const maxVal = hasNegatives
                    ? Math.max(1, Math.abs(extremes.max), Math.abs(extremes.min))
                    : Math.max(1, extremes.max);
                  const zeroY = 90;
                  const scale = hasNegatives
                    ? (v: number) => zeroY - (v / maxVal) * 80
                    : (v: number) => 170 - (v / maxVal) * 160;
                  const chartWidth = 400;
                  const monthlyViewH = 180;
                  const barW = chartWidth / monthlyClosingBalances.length;
                  const gap = 24;
                  const w = Math.max(6, barW - gap);
                  const placeColors = ["#8b5cf6", "#06b6d4", "#f97316"];
                  const yTicks = hasNegatives
                    ? [-1, -0.5, 0, 0.5, 1].map((q) => ({ val: maxVal * q, y: scale(maxVal * q) }))
                    : [0, 0.25, 0.5, 0.75, 1].map((q) => ({ val: maxVal * q, y: scale(maxVal * q) }));
                  return (
                    <div
                      className="monthly-chart-bars-and-labels"
                      style={{ gridTemplateColumns: `repeat(${monthlyClosingBalances.length}, 1fr)` }}
                    >
                      <div className="monthly-chart-y-and-bars">
                        <div className="chart-y-axis-labels chart-y-axis-labels--monthly" style={{ height: 120 }}>
                          {yTicks.map((t, ti) => (
                            <span
                              key={`saldo-y-${ti}`}
                              className="chart-y-axis-label"
                              style={{ top: `${(t.y / monthlyViewH) * 100}%` }}
                            >
                              {formatCurrencyAxis(t.val)}
                            </span>
                          ))}
                        </div>
                        <div className="monthly-chart-bars-wrap">
                          <svg className="monthly-chart-svg" viewBox={`0 0 ${chartWidth} ${monthlyViewH}`} preserveAspectRatio="none">
                            <g className="monthly-chart-y-axis">
                              {yTicks.map((t, ti) => (
                                <line key={`saldo-y-${ti}`} x1={0} y1={t.y} x2={chartWidth} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3" />
                              ))}
                            </g>
                            {hasNegatives && <line x1={0} y1={zeroY} x2={chartWidth} y2={zeroY} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="4" />}
                            {monthlyClosingBalances.map((m, i) => {
                              const x = i * barW + (barW - w) / 2;
                              let cum = 0;
                              const segments = places.map((place, pIdx) => {
                                const val = m.byPlace[place] ?? 0;
                                const top = scale(cum);
                                const bottom = scale(cum + val);
                                cum += val;
                                const y = Math.min(top, bottom);
                                const segH = Math.max(0, Math.abs(bottom - top));
                                return (
                                  <rect
                                    key={place}
                                    x={x}
                                    y={y}
                                    width={w}
                                    height={segH}
                                    fill={placeColors[pIdx] ?? "#9ca3af"}
                                    className="monthly-chart-bar-segment"
                                    opacity={chartHoveredMonthIndex === i ? 1 : chartHoveredMonthIndex != null ? 0.5 : 1}
                                  />
                                );
                              });
                              return (
                                <g
                                  key={`${m.year}-${m.month}`}
                                  onMouseEnter={() => setChartHoveredMonthIndex(i)}
                                  onMouseLeave={() => setChartHoveredMonthIndex(null)}
                                >
                                  {segments}
                                </g>
                              );
                            })}
                          </svg>
                        </div>
                      </div>
                      {monthlyClosingBalances.map((m) => (
                        <span key={`${m.year}-${m.month}`} className="monthly-chart-label">
                          {MONTH_NAMES_ES_SHORT[m.month - 1]}
                        </span>
                      ))}
                    </div>
                  );
                })()}
                {chartHoveredMonthIndex != null && monthlyClosingBalances[chartHoveredMonthIndex] && (() => {
                  const m = monthlyClosingBalances[chartHoveredMonthIndex];
                  const placeColors = ["#8b5cf6", "#06b6d4", "#f97316"];
                  return (
                    <div className="monthly-chart-tooltip">
                      <div className="monthly-chart-tooltip-title">
                        Saldo al cierre de {MONTH_NAMES_ES[m.month - 1]} {m.year}
                      </div>
                      <ul className="monthly-chart-tooltip-breakdown">
                        {places.map((place, idx) => (
                          <li key={place}>
                            <span className="monthly-chart-tooltip-dot" style={{ background: placeColors[idx] ?? "#9ca3af" }} />
                            {place}: {formatCurrency(m.byPlace[place] ?? 0)}
                          </li>
                        ))}
                      </ul>
                      <div className="monthly-chart-tooltip-total">
                        Total: {formatCurrency(m.total)}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        </section>

        {/* Gráfico Flujo de dinero (Ingresos vs Gastos por mes) */}
        <section className="panel panel-flow-chart">
          <div className="flow-chart-header-row">
            <h2 className="panel-title flow-chart-title">Flujo de dinero</h2>
            <div className="flow-chart-header-actions">
              <div className="flow-chart-filter-wrap" ref={flowChartFilterRef}>
              <button
                type="button"
                className="dashboard-account-filter-pill flow-chart-filter-pill"
                onClick={() => setFlowChartAccountFilterOpen((o) => !o)}
                aria-expanded={flowChartAccountFilterOpen}
                aria-haspopup="listbox"
                aria-label="Filtrar por cuenta"
              >
                <span className="dashboard-account-filter-label">
                  {flowChartAccountFilter ?? "Todas las cuentas"}
                </span>
                <span className="dashboard-account-filter-chevron" aria-hidden>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </span>
              </button>
              {flowChartAccountFilterOpen && (
                <div className="dashboard-account-filter-dropdown flow-chart-filter-dropdown" role="listbox">
                  <button
                    type="button"
                    role="option"
                    aria-selected={flowChartAccountFilter === null}
                    className={`dashboard-account-filter-option ${flowChartAccountFilter === null ? "dashboard-account-filter-option--active" : ""}`}
                    onClick={() => { setFlowChartAccountFilter(null); setFlowChartAccountFilterOpen(false); }}
                  >
                    Todas las cuentas
                  </button>
                  {places.map((place) => (
                    <button
                      key={place}
                      type="button"
                      role="option"
                      aria-selected={flowChartAccountFilter === place}
                      className={`dashboard-account-filter-option ${flowChartAccountFilter === place ? "dashboard-account-filter-option--active" : ""}`}
                      onClick={() => { setFlowChartAccountFilter(place); setFlowChartAccountFilterOpen(false); }}
                    >
                      {place}
                    </button>
                  ))}
                </div>
              )}
              </div>
              <button
                type="button"
                className="chart-expand-btn"
                onClick={() => setExpandedChartModal("flow")}
                title="Ver gráfico más grande"
                aria-label="Ver gráfico más grande"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
              </button>
            </div>
          </div>
          <p className="panel-sub flow-chart-sub">Ingresos y gastos · últimos 5 meses</p>
          <div className="flow-chart-legend">
            <span className="flow-chart-legend-item">
              <span className="flow-chart-legend-dot flow-chart-legend-dot--income" />
              Ingresos
            </span>
            <span className="flow-chart-legend-item">
              <span className="flow-chart-legend-dot flow-chart-legend-dot--expense" />
              Gastos
            </span>
          </div>
          <div className="flow-chart-wrap">
            {flowChartMonthlyFlowData.length === 0 ? (
              <p className="flow-chart-empty">No hay movimientos para mostrar.</p>
            ) : (
              <>
                {(() => {
                  const maxVal = Math.max(
                    1,
                    ...flowChartMonthlyFlowData.flatMap((m) => [m.income, m.expense]),
                  );
                  const scale = (v: number) => 120 - (v / maxVal) * 110;
                  const chartWidth = 400;
                  const flowViewH = 140;
                  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((q) => ({ val: maxVal * q, y: scale(maxVal * q) }));
                  const barGroupWidth = chartWidth / flowChartMonthlyFlowData.length;
                  const barWidth = Math.max(6, barGroupWidth * 0.32);
                  const gap = barGroupWidth * 0.08;
                  const incomeX = (groupIndex: number) => groupIndex * barGroupWidth + gap;
                  const expenseX = (groupIndex: number) => groupIndex * barGroupWidth + barGroupWidth / 2 + gap / 2;
                  const minBarH = 2;
                  return (
                    <div
                      className="flow-chart-bars-and-labels"
                      style={{ gridTemplateColumns: `repeat(${flowChartMonthlyFlowData.length}, 1fr)` }}
                    >
                      <div className="flow-chart-y-and-bars">
                        <div className="chart-y-axis-labels chart-y-axis-labels--flow" style={{ height: 120 }}>
                          {yTicks.map((t, ti) => (
                            <span
                              key={`flow-y-${ti}`}
                              className="chart-y-axis-label"
                              style={{ top: `${(t.y / flowViewH) * 100}%` }}
                            >
                              {formatCurrencyAxis(t.val)}
                            </span>
                          ))}
                        </div>
                        <div className="flow-chart-bars-wrap">
                          <svg className="flow-chart-svg" viewBox={`0 0 ${chartWidth} ${flowViewH}`} preserveAspectRatio="none">
                            <g className="flow-chart-y-axis">
                              {yTicks.map((t, ti) => (
                                <line key={`flow-y-${ti}`} x1={0} y1={t.y} x2={chartWidth} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3" />
                              ))}
                            </g>
                            {flowChartMonthlyFlowData.map((m, i) => (
                              <g key={`${m.year}-${m.month}`}>
                                <rect
                                  x={incomeX(i)}
                                  y={scale(m.income)}
                                  width={barWidth}
                                  height={Math.max(minBarH, 120 - scale(m.income))}
                                  fill="#5b21b6"
                                  className="flow-chart-bar"
                                  opacity={flowChartHovered?.monthIndex === i && flowChartHovered?.bar === "income" ? 1 : flowChartHovered != null ? 0.45 : 1}
                                  onMouseEnter={() => setFlowChartHovered({ monthIndex: i, bar: "income" })}
                                  onMouseLeave={() => setFlowChartHovered(null)}
                                />
                                <rect
                                  x={expenseX(i)}
                                  y={scale(m.expense)}
                                  width={barWidth}
                                  height={Math.max(minBarH, 120 - scale(m.expense))}
                                  fill="#a78bfa"
                                  className="flow-chart-bar"
                                  opacity={flowChartHovered?.monthIndex === i && flowChartHovered?.bar === "expense" ? 1 : flowChartHovered != null ? 0.45 : 1}
                                  onMouseEnter={() => setFlowChartHovered({ monthIndex: i, bar: "expense" })}
                                  onMouseLeave={() => setFlowChartHovered(null)}
                                />
                              </g>
                            ))}
                          </svg>
                        </div>
                      </div>
                      {flowChartMonthlyFlowData.map((m) => (
                        <span key={`${m.year}-${m.month}`} className="flow-chart-label">
                          {MONTH_NAMES_ES_SHORT[m.month - 1]}
                        </span>
                      ))}
                    </div>
                  );
                })()}
                {flowChartHovered != null && flowChartMonthlyFlowData[flowChartHovered.monthIndex] && (
                  <div className="flow-chart-tooltip">
                    {flowChartHovered.bar === "income"
                      ? formatCurrency(flowChartMonthlyFlowData[flowChartHovered.monthIndex].income)
                      : formatCurrency(flowChartMonthlyFlowData[flowChartHovered.monthIndex].expense)}
                  </div>
                )}
              </>
            )}
          </div>
        </section>
        </div>

      {/* Modal gráfico ampliado */}
      {expandedChartModal && (
        <div
          className="modal-overlay chart-expand-modal-overlay"
          onClick={() => setExpandedChartModal(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="chart-expand-modal-title"
        >
          <div className="modal chart-expand-modal" onClick={(e) => e.stopPropagation()}>
            <div className="chart-expand-modal-header">
              <h2 id="chart-expand-modal-title" className="modal-title">
                {expandedChartModal === "monthly" ? "Saldo al cierre del mes" : "Flujo de dinero"}
              </h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setExpandedChartModal(null)}
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <div className={`chart-expand-modal-body chart-expand-modal-body--${expandedChartModal}`}>
              {expandedChartModal === "monthly" && (
                monthlyClosingBalances.length === 0 ? (
                  <p className="monthly-chart-empty">No hay movimientos para mostrar.</p>
                ) : (
                  <>
                    <div className="monthly-chart-legend">
                      {places.map((place, idx) => (
                        <span key={place} className="monthly-chart-legend-item">
                          <span className="monthly-chart-legend-dot" style={{ background: idx === 0 ? "#8b5cf6" : idx === 1 ? "#06b6d4" : "#f97316" }} />
                          {place}
                        </span>
                      ))}
                    </div>
                    {(() => {
                      const extremes = monthlyClosingBalances.reduce((acc, m) => ({ max: Math.max(acc.max, m.total), min: Math.min(acc.min, m.total) }), { max: 0, min: 0 });
                      const hasNegatives = extremes.min < 0;
                      const maxVal = hasNegatives ? Math.max(1, Math.abs(extremes.max), Math.abs(extremes.min)) : Math.max(1, extremes.max);
                      const zeroY = 90;
                      const scale = hasNegatives ? (v: number) => zeroY - (v / maxVal) * 80 : (v: number) => 170 - (v / maxVal) * 160;
                      const chartWidth = 400;
                      const monthlyViewH = 180;
                      const barW = chartWidth / monthlyClosingBalances.length;
                      const gap = 24;
                      const w = Math.max(6, barW - gap);
                      const placeColors = ["#8b5cf6", "#06b6d4", "#f97316"];
                      const yTicks = hasNegatives ? [-1, -0.5, 0, 0.5, 1].map((q) => ({ val: maxVal * q, y: scale(maxVal * q) })) : [0, 0.25, 0.5, 0.75, 1].map((q) => ({ val: maxVal * q, y: scale(maxVal * q) }));
                      return (
                        <div className="monthly-chart-bars-and-labels" style={{ gridTemplateColumns: `repeat(${monthlyClosingBalances.length}, 1fr)` }}>
                          <div className="monthly-chart-y-and-bars">
                            <div className="chart-y-axis-labels chart-y-axis-labels--monthly chart-expand-modal-labels">
                              {yTicks.map((t, ti) => (
                                <span key={`saldo-y-${ti}`} className="chart-y-axis-label" style={{ top: `${(t.y / monthlyViewH) * 100}%` }}>{formatCurrencyAxis(t.val)}</span>
                              ))}
                            </div>
                            <div className="monthly-chart-bars-wrap">
                              <svg className="monthly-chart-svg chart-expand-modal-svg" viewBox={`0 0 ${chartWidth} ${monthlyViewH}`} preserveAspectRatio="none">
                                <g className="monthly-chart-y-axis">
                                  {yTicks.map((t, ti) => (<line key={`saldo-y-${ti}`} x1={0} y1={t.y} x2={chartWidth} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3" />))}
                                </g>
                                {hasNegatives && <line x1={0} y1={zeroY} x2={chartWidth} y2={zeroY} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="4" />}
                                {monthlyClosingBalances.map((m, i) => {
                                  const x = i * barW + (barW - w) / 2;
                                  let cum = 0;
                                  const segments = places.map((place, pIdx) => {
                                    const val = m.byPlace[place] ?? 0;
                                    const top = scale(cum);
                                    const bottom = scale(cum + val);
                                    cum += val;
                                    const y = Math.min(top, bottom);
                                    const segH = Math.max(0, Math.abs(bottom - top));
                                    return <rect key={place} x={x} y={y} width={w} height={segH} fill={placeColors[pIdx] ?? "#9ca3af"} className="monthly-chart-bar-segment" opacity={chartHoveredMonthIndex === i ? 1 : chartHoveredMonthIndex != null ? 0.5 : 1} />;
                                  });
                                  return (
                                    <g key={`${m.year}-${m.month}`} onMouseEnter={() => setChartHoveredMonthIndex(i)} onMouseLeave={() => setChartHoveredMonthIndex(null)}>{segments}</g>
                                  );
                                })}
                              </svg>
                            </div>
                          </div>
                          {monthlyClosingBalances.map((m) => (<span key={`${m.year}-${m.month}`} className="monthly-chart-label">{MONTH_NAMES_ES_SHORT[m.month - 1]}</span>))}
                        </div>
                      );
                    })()}
                    {chartHoveredMonthIndex != null && monthlyClosingBalances[chartHoveredMonthIndex] && (() => {
                      const m = monthlyClosingBalances[chartHoveredMonthIndex];
                      const placeColors = ["#8b5cf6", "#06b6d4", "#f97316"];
                      return (
                        <div className="monthly-chart-tooltip">
                          <div className="monthly-chart-tooltip-title">Saldo al cierre de {MONTH_NAMES_ES[m.month - 1]} {m.year}</div>
                          <ul className="monthly-chart-tooltip-breakdown">
                            {places.map((place, idx) => (
                              <li key={place}><span className="monthly-chart-tooltip-dot" style={{ background: placeColors[idx] ?? "#9ca3af" }} />{place}: {formatCurrency(m.byPlace[place] ?? 0)}</li>
                            ))}
                          </ul>
                          <div className="monthly-chart-tooltip-total">Total: {formatCurrency(m.total)}</div>
                        </div>
                      );
                    })()}
                  </>
                )
              )}
              {expandedChartModal === "flow" && (
                flowChartMonthlyFlowData.length === 0 ? (
                  <p className="flow-chart-empty">No hay movimientos para mostrar.</p>
                ) : (
                  <>
                    <div className="flow-chart-legend">
                      <span className="flow-chart-legend-item"><span className="flow-chart-legend-dot flow-chart-legend-dot--income" />Ingresos</span>
                      <span className="flow-chart-legend-item"><span className="flow-chart-legend-dot flow-chart-legend-dot--expense" />Gastos</span>
                    </div>
                    {(() => {
                      const maxVal = Math.max(1, ...flowChartMonthlyFlowData.flatMap((m) => [m.income, m.expense]));
                      const scale = (v: number) => 120 - (v / maxVal) * 110;
                      const chartWidth = 400;
                      const flowViewH = 140;
                      const yTicks = [0, 0.25, 0.5, 0.75, 1].map((q) => ({ val: maxVal * q, y: scale(maxVal * q) }));
                      const barGroupWidth = chartWidth / flowChartMonthlyFlowData.length;
                      const barWidth = Math.max(6, barGroupWidth * 0.32);
                      const gap = barGroupWidth * 0.08;
                      const incomeX = (groupIndex: number) => groupIndex * barGroupWidth + gap;
                      const expenseX = (groupIndex: number) => groupIndex * barGroupWidth + barGroupWidth / 2 + gap / 2;
                      const minBarH = 2;
                      return (
                        <div className="flow-chart-bars-and-labels" style={{ gridTemplateColumns: `repeat(${flowChartMonthlyFlowData.length}, 1fr)` }}>
                          <div className="flow-chart-y-and-bars">
                            <div className="chart-y-axis-labels chart-y-axis-labels--flow chart-expand-modal-labels">
                              {yTicks.map((t, ti) => (<span key={`flow-y-${ti}`} className="chart-y-axis-label" style={{ top: `${(t.y / flowViewH) * 100}%` }}>{formatCurrencyAxis(t.val)}</span>))}
                            </div>
                            <div className="flow-chart-bars-wrap">
                              <svg className="flow-chart-svg chart-expand-modal-svg" viewBox={`0 0 ${chartWidth} ${flowViewH}`} preserveAspectRatio="none">
                                <g className="flow-chart-y-axis">
                                  {yTicks.map((t, ti) => (<line key={`flow-y-${ti}`} x1={0} y1={t.y} x2={chartWidth} y2={t.y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3" />))}
                                </g>
                                {flowChartMonthlyFlowData.map((m, i) => (
                                  <g key={`${m.year}-${m.month}`}>
                                    <rect x={incomeX(i)} y={scale(m.income)} width={barWidth} height={Math.max(minBarH, 120 - scale(m.income))} fill="#5b21b6" className="flow-chart-bar" opacity={flowChartHovered?.monthIndex === i && flowChartHovered?.bar === "income" ? 1 : flowChartHovered != null ? 0.45 : 1} onMouseEnter={() => setFlowChartHovered({ monthIndex: i, bar: "income" })} onMouseLeave={() => setFlowChartHovered(null)} />
                                    <rect x={expenseX(i)} y={scale(m.expense)} width={barWidth} height={Math.max(minBarH, 120 - scale(m.expense))} fill="#a78bfa" className="flow-chart-bar" opacity={flowChartHovered?.monthIndex === i && flowChartHovered?.bar === "expense" ? 1 : flowChartHovered != null ? 0.45 : 1} onMouseEnter={() => setFlowChartHovered({ monthIndex: i, bar: "expense" })} onMouseLeave={() => setFlowChartHovered(null)} />
                                  </g>
                                ))}
                              </svg>
                            </div>
                          </div>
                          {flowChartMonthlyFlowData.map((m) => (<span key={`${m.year}-${m.month}`} className="flow-chart-label">{MONTH_NAMES_ES_SHORT[m.month - 1]}</span>))}
                        </div>
                      );
                    })()}
                    {flowChartHovered != null && flowChartMonthlyFlowData[flowChartHovered.monthIndex] && (
                      <div className="flow-chart-tooltip">
                        {flowChartHovered.bar === "income" ? formatCurrency(flowChartMonthlyFlowData[flowChartHovered.monthIndex].income) : formatCurrency(flowChartMonthlyFlowData[flowChartHovered.monthIndex].expense)}
                      </div>
                    )}
                  </>
                )
              )}
            </div>
          </div>
        </div>
      )}

        <div className="dashboard-secondary">
          <section className="panel panel-upcoming">
            <div className="upcoming-events-header">
              <span className="upcoming-events-icon" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </span>
              <h2 className="panel-title upcoming-events-title">Próximos salarios</h2>
            </div>
            <div
              ref={upcomingDashboardSliderRef}
              className="upcoming-cards upcoming-cards-slider"
              onMouseDown={makeHorizontalDragHandler(
                upcomingDashboardSliderRef,
                upcomingDashboardDragRef,
              )}
            >
              {upcomingSalaries.length === 0 ? (
                <div className="upcoming-card upcoming-card-empty">
                  <p className="upcoming-card-empty-text">No hay próximos salarios cargados.</p>
                  <a href="#" className="upcoming-card-link" onClick={(e) => { e.preventDefault(); setActiveView("upcoming"); }}>
                    Agregar en Próximos salarios →
                  </a>
                </div>
              ) : (
              upcomingSalaries.map((item, index) => {
                const days = daysUntil(item.date);
                const isFirst = index === 0;
                return (
                  <div key={item.id} className="upcoming-card">
                    <div className="upcoming-card-top">
                      <span className="upcoming-card-icon" aria-hidden>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M12 8v8M8 12h8"/></svg>
                      </span>
                      <span className={`upcoming-card-status ${isFirst ? "upcoming-card-status--next" : "upcoming-card-status--pending"}`}>
                        {isFirst ? "Próximo" : "Siguiente"}
                      </span>
                    </div>
                    <h3 className="upcoming-card-title">
                      Salario {MONTH_NAMES_ES[item.month - 1]} {item.year}
                    </h3>
                    <p className="upcoming-card-desc">Cobro último día hábil del mes</p>
                    <div className="upcoming-card-progress-wrap">
                      <span className="upcoming-card-progress-label">En {days} días</span>
                      <div className="upcoming-card-progress-bar">
                        <div
                          className="upcoming-card-progress-fill"
                          style={{ width: `${Math.min(100, Math.max(0, 100 - (days / 31) * 100))}%` }}
                        />
                      </div>
                    </div>
                    <p className="upcoming-card-amount">
                      <span className="upcoming-card-amount-label">Monto </span>
                      {formatCurrency(item.amount)}
                    </p>
                    <p className="upcoming-card-date">
                      <span className="upcoming-card-date-icon" aria-hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                      </span>
                      Cobro: {formatNextSalaryDate(item.date)}
                    </p>
                    <a
                      href="#"
                      className="upcoming-card-link"
                      onClick={(e) => { e.preventDefault(); setActiveView("upcoming"); }}
                    >
                      Ver detalle →
                    </a>
                  </div>
                );
              })
              )
              }
            </div>
          </section>

          <section className="panel panel-goals-summary">
            <div className="goals-summary-header">
              <h2 className="panel-title">Progreso de metas</h2>
              <button
                type="button"
                className="button button-secondary goals-summary-link"
                onClick={() => setActiveView("goals")}
              >
                Ver todas →
              </button>
            </div>
            {savingsGoals.length === 0 ? (
              <p className="goals-summary-empty">
                Todavía no creaste metas de ahorro. Empieza definiendo tu primer objetivo.
              </p>
            ) : (
              <ul className="goals-summary-list">
                {activeGoals.slice(0, 3).map((goal) => {
                  const progressPct = getGoalProgressPct(goal);
                  return (
                    <li key={goal.id} className="goals-summary-item">
                      <div className="goals-summary-row">
                        <span className="goals-summary-name">{goal.name}</span>
                        <span className="goals-summary-amount">
                          {formatCurrency(goal.currentAmount)} / {formatCurrency(goal.targetAmount)}
                        </span>
                      </div>
                      <div className="goals-summary-bar">
                        <div
                          className="goals-summary-bar-fill"
                          style={{ width: `${progressPct}%` }}
                        >
                          <span className="goals-summary-bar-label">
                            {progressPct.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
        </>
        )}
      </div>

      {/* Modal calendario de actividades */}
      {showCalendarModal && (() => {
        const { year, month } = calendarMonth;
        const first = new Date(year, month - 1, 1);
        const last = new Date(year, month, 0);
        const lastDate = last.getDate();
        const firstWeekday = (first.getDay() + 6) % 7;
        const totalCells = firstWeekday + lastDate;
        const weeks = Math.ceil(totalCells / 7);
        const weekDays = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
        const todayYmd = (() => {
          const t = new Date();
          return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
        })();
        const prevMonth = () => {
          if (month === 1) setCalendarMonth({ year: year - 1, month: 12 });
          else setCalendarMonth({ year, month: month - 1 });
        };
        const nextMonth = () => {
          if (month === 12) setCalendarMonth({ year: year + 1, month: 1 });
          else setCalendarMonth({ year, month: month + 1 });
        };
        const cells: Array<{ day: number | null; ymd: string | null }> = [];
        for (let i = 0; i < weeks * 7; i++) {
          if (i < firstWeekday || i >= firstWeekday + lastDate) {
            cells.push({ day: null, ymd: null });
          } else {
            const day = i - firstWeekday + 1;
            const ymd = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            cells.push({ day, ymd });
          }
        }
        return (
          <div
            className="modal-overlay"
            onClick={() => setShowCalendarModal(false)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="calendar-modal-title"
          >
            <div className="modal calendar-modal" onClick={(e) => e.stopPropagation()}>
              <div className="calendar-modal-header">
                <h2 id="calendar-modal-title" className="modal-title">Calendario de actividades</h2>
                <button type="button" className="modal-close-btn" onClick={() => setShowCalendarModal(false)} aria-label="Cerrar">×</button>
              </div>
              <div className="calendar-nav">
                <button type="button" className="calendar-nav-btn" onClick={prevMonth} aria-label="Mes anterior">‹</button>
                <span className="calendar-month-label">{MONTH_NAMES_ES[month - 1]} {year}</span>
                <button type="button" className="calendar-nav-btn" onClick={nextMonth} aria-label="Mes siguiente">›</button>
              </div>
              <div className="calendar-weekdays">
                {weekDays.map((d) => (
                  <span key={d} className="calendar-weekday">{d}</span>
                ))}
              </div>
              <div className="calendar-grid">
                {cells.map((c, i) => {
                  if (c.day === null) {
                    return <div key={`e-${i}`} className="calendar-day calendar-day--empty" />;
                  }
                  const ymd = c.ymd!;
                  const act = calendarActivitiesByDate[ymd];
                  const hasActivity = act && (act.transactions.length > 0 || act.salaries.length > 0 || act.goals.length > 0);
                  const isToday = ymd === todayYmd;
                  const isHovered = ymd === calendarHoveredDate;
                  const dayActivities = calendarActivitiesByDate[ymd];
                  return (
                    <button
                      key={ymd}
                      type="button"
                      className={`calendar-day ${isToday ? "calendar-day--today" : ""} ${isHovered ? "calendar-day--selected" : ""} ${hasActivity ? "calendar-day--has-activity" : ""}`}
                      onMouseEnter={() => setCalendarHoveredDate(ymd)}
                      onMouseLeave={() => setCalendarHoveredDate(null)}
                    >
                      <span className="calendar-day-num">{c.day}</span>
                      {hasActivity && <span className="calendar-day-dots" />}
                      {isHovered && (
                        <div className="calendar-day-tooltip" role="tooltip">
                          <div className="calendar-day-tooltip-title">
                            {(() => {
                              const [y, m, d] = ymd.split("-");
                              const date = new Date(Number(y), Number(m) - 1, Number(d));
                              return date.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
                            })()}
                          </div>
                          {dayActivities && (dayActivities.transactions.length > 0 || dayActivities.salaries.length > 0 || dayActivities.goals.length > 0) ? (
                            <ul className="calendar-day-tooltip-list">
                              {dayActivities.transactions.map((e) => (
                                <li key={`tx-${e.id}`} className="calendar-day-tooltip-item">
                                  <span className="calendar-day-tooltip-icon">↕</span>
                                  <span>{e.comment || "Transacción"}</span>
                                  <span className={e.amount >= 0 ? "calendar-day-tooltip-amount-in" : "calendar-day-tooltip-amount-out"}>
                                    {e.amount >= 0 ? "+" : ""}{formatCurrency(e.amount)}
                                  </span>
                                </li>
                              ))}
                              {dayActivities.salaries.map((s) => (
                                <li key={`sal-${s.id}`} className="calendar-day-tooltip-item">
                                  <span className="calendar-day-tooltip-icon">$</span>
                                  <span>Cobro salario {MONTH_NAMES_ES[s.month - 1]} {s.year}</span>
                                  <span className="calendar-day-tooltip-amount-in">{formatCurrency(s.amount)}</span>
                                </li>
                              ))}
                              {dayActivities.goals.map((g, idx) => (
                                <li key={`goal-${g.deadline}-${idx}`} className="calendar-day-tooltip-item">
                                  <span className="calendar-day-tooltip-icon">◎</span>
                                  <span>Fecha límite: {g.name}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="calendar-day-tooltip-empty">Sin actividades este día.</p>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

