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

type ViewId = "dashboard" | "upcoming" | "familyFinancing" | "incomeProjections" | "wishList";

type WishListStatus = "pending" | "purchased";
type WishListPriority = "low" | "medium" | "high";

interface WishListItem {
  id: string;
  name: string;
  estimatedPrice: number | null;
  notes: string | null;
  priority: WishListPriority;
  status: WishListStatus;
  createdAt: string;
  purchasedAt: string | null;
}

const WISH_PRIORITY_WEIGHT: Record<WishListPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const WISH_PRIORITY_LABELS: Record<WishListPriority, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta",
};

function mapRowToWishListItem(row: {
  id: string;
  name: string;
  estimated_price: number | null;
  notes: string | null;
  priority: string;
  status: string;
  created_at: string;
  purchased_at: string | null;
}): WishListItem {
  return {
    id: String(row.id),
    name: row.name,
    estimatedPrice: row.estimated_price != null ? Number(row.estimated_price) : null,
    notes: row.notes,
    priority: row.priority as WishListPriority,
    status: row.status as WishListStatus,
    createdAt: row.created_at,
    purchasedAt: row.purchased_at,
  };
}

function formatWishListPurchasedDate(iso: string | null): string {
  if (!iso) return "";
  return formatDisplayDate(iso.split("T")[0]);
}

function WishListPendingRow({
  item,
  onMarkPurchased,
  onEdit,
  onDelete,
}: {
  item: WishListItem;
  onMarkPurchased: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="wish-list-row wish-list-row--pending">
      <div className="wish-list-row-body">
        <span className="tx-list-desc">{item.name}</span>
        <span className="tx-list-meta wish-list-row-meta">
          <span className={`wish-list-priority-chip wish-list-priority-chip--${item.priority}`}>
            {WISH_PRIORITY_LABELS[item.priority]}
          </span>
          {item.notes && <span className="wish-list-notes-preview">{item.notes}</span>}
        </span>
      </div>
      {item.estimatedPrice != null && (
        <span className="wish-list-price wish-list-price--primary">{formatCurrency(item.estimatedPrice)}</span>
      )}
      <button
        type="button"
        className="wish-list-purchased-link"
        onClick={onMarkPurchased}
        aria-label={`Marcar ${item.name} como comprado`}
      >
        Comprado
      </button>
      <div className="wish-list-row-actions">
        <button
          type="button"
          className="wish-list-action-btn"
          data-tooltip="Editar"
          onClick={onEdit}
          aria-label="Editar deseo"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
        <button
          type="button"
          className="wish-list-action-btn wish-list-action-btn--danger"
          data-tooltip="Eliminar"
          onClick={onDelete}
          aria-label="Eliminar deseo"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  );
}

type ProjectionLineType = "income" | "expense";

function isTransferEntry(entry: Entry): boolean {
  return /^Transferencia (a|desde) /i.test(entry.comment);
}

function getSuggestedProjectionMonthValue(months: IncomeProjectionMonth[]): string {
  const now = new Date();
  if (months.length === 0) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const sorted = [...months].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
  const last = sorted[sorted.length - 1];
  const next = new Date(last.year, last.month, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

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

type FamilyFinancingStatus = "in_progress" | "completed";

interface IncomeProjectionMonth {
  id: string;
  year: number;
  month: number;
}

interface IncomeProjectionLine {
  id: string;
  monthId: string;
  description: string;
  amount: number;
  sortOrder: number;
}

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

type FamilyMonthSummaryStatus = "paid" | "pending" | "partial" | "empty";

interface FamilyMonthSummary {
  year: number;
  month: number;
  total: number;
  paidCount: number;
  count: number;
  status: FamilyMonthSummaryStatus;
  isCurrentMonth: boolean;
}

const FAMILY_DASHBOARD_FUTURE_MONTHS = 4;

function familyMonthKey(year: number, month: number): number {
  return year * 12 + month;
}

function summarizeFamilyMonthInstallments(
  installments: FamilyFinancingInstallment[],
  year: number,
  month: number,
): Pick<FamilyMonthSummary, "total" | "paidCount" | "count" | "status"> {
  const monthInstallments = installments.filter((inst) => {
    const [dueYear, dueMonth] = inst.dueDate.split("-").map(Number);
    return dueYear === year && dueMonth === month;
  });
  const total = monthInstallments.reduce((sum, inst) => sum + inst.amount, 0);
  const paidCount = monthInstallments.filter((inst) => inst.isPaid).length;
  const count = monthInstallments.length;
  let status: FamilyMonthSummaryStatus = "empty";
  if (count === 0) status = "empty";
  else if (paidCount === count) status = "paid";
  else if (paidCount === 0) status = "pending";
  else status = "partial";
  return { total, paidCount, count, status };
}

function getFamilyMonthStatusLabel(row: Pick<FamilyMonthSummary, "status" | "paidCount" | "count">): string {
  if (row.status === "paid") return "Pagado";
  if (row.status === "pending") return "Pendiente";
  if (row.status === "partial") return `Parcial · ${row.paidCount}/${row.count}`;
  return "—";
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

function computeInstallmentRedistribution(
  item: FamilyFinancingItem,
  allInstallments: FamilyFinancingInstallment[],
  editedInstallmentId: string,
  newAmount: number,
): { updates: Array<{ id: string; amount: number }> } | { error: string } {
  const installments = allInstallments
    .filter((inst) => inst.itemId === item.id)
    .sort((a, b) => a.installmentNumber - b.installmentNumber);
  const edited = installments.find((inst) => inst.id === editedInstallmentId);
  if (!edited) return { error: "Cuota no encontrada." };
  if (edited.isPaid) return { error: "No se puede editar una cuota ya pagada." };

  const paidTotal = installments.filter((inst) => inst.isPaid).reduce((sum, inst) => sum + inst.amount, 0);
  const priorUnpaidTotal = installments
    .filter((inst) => !inst.isPaid && inst.installmentNumber < edited.installmentNumber)
    .reduce((sum, inst) => sum + inst.amount, 0);
  const allocated = paidTotal + priorUnpaidTotal + newAmount;
  const remaining = Math.round((item.totalAmount - allocated) * 100) / 100;

  if (remaining < -0.001) {
    const maxAmount = Math.round((item.totalAmount - paidTotal - priorUnpaidTotal) * 100) / 100;
    return {
      error: `El monto excede el total del item. Máximo para esta cuota: ${formatCurrency(maxAmount)}.`,
    };
  }

  const subsequent = installments.filter(
    (inst) => !inst.isPaid && inst.installmentNumber > edited.installmentNumber,
  );
  const subsequentAmounts =
    subsequent.length > 0 ? splitIntoInstallments(Math.max(0, remaining), subsequent.length) : [];

  return {
    updates: [
      { id: edited.id, amount: newAmount },
      ...subsequent.map((inst, idx) => ({ id: inst.id, amount: subsequentAmounts[idx] })),
    ],
  };
}

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

  const [familyItems, setFamilyItems] = useState<FamilyFinancingItem[]>([]);
  const [familyInstallments, setFamilyInstallments] = useState<FamilyFinancingInstallment[]>([]);
  const [projectionStartingBalance, setProjectionStartingBalance] = useState(0);
  const [projectionBalanceInput, setProjectionBalanceInput] = useState("0");
  const [projectionMonths, setProjectionMonths] = useState<IncomeProjectionMonth[]>([]);
  const [projectionLines, setProjectionLines] = useState<IncomeProjectionLine[]>([]);
  const [projectionLineForm, setProjectionLineForm] = useState({
    description: "",
    amount: "",
    lineType: "income" as ProjectionLineType,
  });
  const [projectionLineTarget, setProjectionLineTarget] = useState<{ year: number; month: number } | null>(null);
  const [editingProjectionLineId, setEditingProjectionLineId] = useState<string | null>(null);
  const [projectionLineError, setProjectionLineError] = useState<string | null>(null);
  const [selectedProjectionMonthDetail, setSelectedProjectionMonthDetail] = useState<IncomeProjectionMonth | null>(null);
  const [showAddProjectionMonthModal, setShowAddProjectionMonthModal] = useState(false);
  const [addProjectionMonthInput, setAddProjectionMonthInput] = useState("");
  const [addProjectionMonthError, setAddProjectionMonthError] = useState<string | null>(null);
  const [confirmDeleteProjectionMonth, setConfirmDeleteProjectionMonth] = useState<IncomeProjectionMonth | null>(null);
  const [showProjectionBalanceModal, setShowProjectionBalanceModal] = useState(false);
  const [projectionBalanceError, setProjectionBalanceError] = useState<string | null>(null);
  const [wishListItems, setWishListItems] = useState<WishListItem[]>([]);
  const [showWishListModal, setShowWishListModal] = useState(false);
  const [editingWishListItemId, setEditingWishListItemId] = useState<string | null>(null);
  const [wishListForm, setWishListForm] = useState({
    name: "",
    estimatedPrice: "",
    notes: "",
    priority: "medium" as WishListPriority,
  });
  const [wishListFormError, setWishListFormError] = useState<string | null>(null);
  const [confirmDeleteWishListItem, setConfirmDeleteWishListItem] = useState<WishListItem | null>(null);
  const [confirmMarkWishListPurchased, setConfirmMarkWishListPurchased] = useState<WishListItem | null>(null);
  const [wishListPurchaseDateInput, setWishListPurchaseDateInput] = useState(todayIso());
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
  const [selectedFamilyItemDetail, setSelectedFamilyItemDetail] = useState<FamilyFinancingItem | null>(null);
  const [confirmMarkInstallmentPaid, setConfirmMarkInstallmentPaid] = useState<FamilyFinancingInstallment | null>(null);
  const [editingFamilyInstallment, setEditingFamilyInstallment] = useState<FamilyFinancingInstallment | null>(null);
  const [installmentEditForm, setInstallmentEditForm] = useState({ amount: "", dueMonth: "" });
  const [installmentEditError, setInstallmentEditError] = useState<string | null>(null);
  const [chartHoveredMonthIndex, setChartHoveredMonthIndex] = useState<number | null>(null);
  const [flowChartHovered, setFlowChartHovered] = useState<{ monthIndex: number; bar: "income" | "expense" } | null>(null);
  const [expandedChartModal, setExpandedChartModal] = useState<"monthly" | "flow" | null>(null);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  const [calendarHoveredDate, setCalendarHoveredDate] = useState<string | null>(null);
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
          { data: familyItemsRows },
          { data: familyInstallmentsRows },
          { data: projectionSettings },
          { data: projectionMonthsRows },
          { data: projectionLinesRows },
          { data: wishListRows },
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
            .from("family_financing_items")
            .select("id, name, total_amount, purchase_date, notes, installment_count, status, created_at, completed_at")
            .order("created_at", { ascending: false }),
          supabase
            .from("family_financing_installments")
            .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at")
            .order("installment_number", { ascending: true }),
          supabase.from("income_projection_settings").select("starting_balance").eq("id", 1).maybeSingle(),
          supabase.from("income_projection_months").select("id, year, month").order("year", { ascending: true }).order("month", { ascending: true }),
          supabase.from("income_projection_lines").select("id, month_id, description, amount, sort_order").order("sort_order", { ascending: true }),
          supabase
            .from("wish_list_items")
            .select("id, name, estimated_price, notes, priority, status, created_at, purchased_at")
            .order("created_at", { ascending: false }),
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

        if (projectionSettings && typeof projectionSettings.starting_balance !== "undefined") {
          const balance = Number(projectionSettings.starting_balance);
          if (!Number.isNaN(balance)) {
            setProjectionStartingBalance(balance);
            setProjectionBalanceInput(String(balance));
          }
        }

        if (projectionMonthsRows && Array.isArray(projectionMonthsRows)) {
          setProjectionMonths(
            projectionMonthsRows.map((row: { id: string; year: number; month: number }) => ({
              id: String(row.id),
              year: Number(row.year),
              month: Number(row.month),
            })),
          );
        }

        if (projectionLinesRows && Array.isArray(projectionLinesRows)) {
          setProjectionLines(
            projectionLinesRows.map((row: { id: string; month_id: string; description: string; amount: number; sort_order: number }) => ({
              id: String(row.id),
              monthId: String(row.month_id),
              description: row.description,
              amount: Number(row.amount),
              sortOrder: Number(row.sort_order),
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

        if (wishListRows && Array.isArray(wishListRows)) {
          setWishListItems(
            wishListRows.map((row: {
              id: string;
              name: string;
              estimated_price: number | null;
              notes: string | null;
              priority: string;
              status: string;
              created_at: string;
              purchased_at: string | null;
            }) => mapRowToWishListItem(row)),
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
        if (isTransferEntry(e)) continue;
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

  /** Actividades por fecha para el calendario (transacciones y cobros de salario) */
  const calendarActivitiesByDate = useMemo(() => {
    const map: Record<
      string,
      {
        transactions: Entry[];
        salaries: Array<{ date: Date; amount: number; month: number; year: number; id: string }>;
      }
    > = {};
    const toYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    };
    entries.forEach((e) => {
      if (!map[e.date]) map[e.date] = { transactions: [], salaries: [] };
      map[e.date].transactions.push(e);
    });
    salaryEntries.forEach((e) => {
      const date = getLastBusinessDay(e.year, e.month);
      const key = toYmd(date);
      if (!map[key]) map[key] = { transactions: [], salaries: [] };
      map[key].salaries.push({
        date,
        amount: e.hours * e.hourlyRate,
        month: e.month,
        year: e.year,
        id: e.id,
      });
    });
    return map;
  }, [entries, salaryEntries]);

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

  const ensureProjectionMonthId = async (year: number, month: number): Promise<string | null> => {
    const existing = projectionMonths.find((m) => m.year === year && m.month === month);
    if (existing) return existing.id;
    const { data, error } = await supabase
      .from("income_projection_months")
      .insert({ year, month })
      .select("id, year, month")
      .single();
    if (error || !data) return null;
    const row = data as { id: string; year: number; month: number };
    const newMonth: IncomeProjectionMonth = {
      id: String(row.id),
      year: Number(row.year),
      month: Number(row.month),
    };
    setProjectionMonths((prev) =>
      [...prev, newMonth].sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month)),
    );
    return newMonth.id;
  };

  const openProjectionBalanceModal = () => {
    setProjectionBalanceInput(String(projectionStartingBalance));
    setProjectionBalanceError(null);
    setShowProjectionBalanceModal(true);
  };

  const closeProjectionBalanceModal = () => {
    setShowProjectionBalanceModal(false);
    setProjectionBalanceError(null);
  };

  const handleSaveProjectionBalance = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const raw = projectionBalanceInput.replace(/\s/g, "").replace(",", ".");
    const parsed = Number(raw);
    if (!raw || Number.isNaN(parsed)) {
      setProjectionBalanceError("Ingresa un monto válido.");
      return;
    }
    const { error } = await supabase
      .from("income_projection_settings")
      .upsert({ id: 1, starting_balance: parsed }, { onConflict: "id" });
    if (error) {
      setProjectionBalanceError("No se pudo guardar el saldo inicial.");
      return;
    }
    setProjectionStartingBalance(parsed);
    closeProjectionBalanceModal();
  };

  const openProjectionLineModal = (year: number, month: number, line?: IncomeProjectionLine) => {
    setProjectionLineTarget({ year, month });
    if (line) {
      setEditingProjectionLineId(line.id);
      setProjectionLineForm({
        description: line.description,
        amount: String(Math.abs(line.amount)),
        lineType: line.amount < 0 ? "expense" : "income",
      });
    } else {
      setEditingProjectionLineId(null);
      setProjectionLineForm({ description: "", amount: "", lineType: "income" });
    }
    setProjectionLineError(null);
  };

  const closeProjectionLineModal = () => {
    setProjectionLineTarget(null);
    setEditingProjectionLineId(null);
    setProjectionLineForm({ description: "", amount: "", lineType: "income" });
    setProjectionLineError(null);
  };

  const openAddProjectionMonthModal = () => {
    setAddProjectionMonthInput(getSuggestedProjectionMonthValue(projectionMonths));
    setAddProjectionMonthError(null);
    setShowAddProjectionMonthModal(true);
  };

  const closeAddProjectionMonthModal = () => {
    setShowAddProjectionMonthModal(false);
    setAddProjectionMonthInput("");
    setAddProjectionMonthError(null);
  };

  const handleAddProjectionMonth = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{4}-\d{2}$/.test(addProjectionMonthInput)) {
      setAddProjectionMonthError("Selecciona un mes válido.");
      return;
    }
    const [yearStr, monthStr] = addProjectionMonthInput.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (month < 1 || month > 12) {
      setAddProjectionMonthError("Selecciona un mes válido.");
      return;
    }
    if (projectionMonths.some((m) => m.year === year && m.month === month)) {
      setAddProjectionMonthError("Ese mes ya está en la proyección.");
      return;
    }
    const monthId = await ensureProjectionMonthId(year, month);
    if (!monthId) {
      setAddProjectionMonthError("No se pudo agregar el mes.");
      return;
    }
    closeAddProjectionMonthModal();
  };

  const closeProjectionMonthDetailModal = () => {
    setSelectedProjectionMonthDetail(null);
  };

  const confirmDeleteProjectionMonthOk = async () => {
    if (!confirmDeleteProjectionMonth) return;
    const monthId = confirmDeleteProjectionMonth.id;
    const { error } = await supabase.from("income_projection_months").delete().eq("id", monthId);
    if (error) {
      setConfirmDeleteProjectionMonth(null);
      return;
    }
    setProjectionMonths((prev) => prev.filter((m) => m.id !== monthId));
    setProjectionLines((prev) => prev.filter((l) => l.monthId !== monthId));
    setConfirmDeleteProjectionMonth(null);
    if (selectedProjectionMonthDetail?.id === monthId) setSelectedProjectionMonthDetail(null);
  };

  const confirmDeleteProjectionMonthCancel = () => {
    setConfirmDeleteProjectionMonth(null);
  };

  const resetWishListForm = () => {
    setWishListForm({ name: "", estimatedPrice: "", notes: "", priority: "medium" });
    setWishListFormError(null);
  };

  const openWishListModal = (item?: WishListItem) => {
    if (item) {
      setEditingWishListItemId(item.id);
      setWishListForm({
        name: item.name,
        estimatedPrice: item.estimatedPrice != null ? String(item.estimatedPrice) : "",
        notes: item.notes ?? "",
        priority: item.priority,
      });
    } else {
      setEditingWishListItemId(null);
      resetWishListForm();
    }
    setShowWishListModal(true);
  };

  const closeWishListModal = () => {
    setShowWishListModal(false);
    setEditingWishListItemId(null);
    resetWishListForm();
  };

  const handleSubmitWishListItem = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = wishListForm.name.trim();
    const notes = wishListForm.notes.trim();
    const priceRaw = wishListForm.estimatedPrice.replace(/\s/g, "").replace(",", ".");
    let estimatedPrice: number | null = null;
    if (priceRaw) {
      const parsed = Number(priceRaw);
      if (Number.isNaN(parsed) || parsed <= 0) {
        setWishListFormError("Ingresa un precio estimado mayor a 0 o déjalo vacío.");
        return;
      }
      estimatedPrice = parsed;
    }
    if (!name) {
      setWishListFormError("Ingresa un nombre.");
      return;
    }
    if (editingWishListItemId) {
      const { data, error } = await supabase
        .from("wish_list_items")
        .update({
          name,
          estimated_price: estimatedPrice,
          notes: notes || null,
          priority: wishListForm.priority,
        })
        .eq("id", editingWishListItemId)
        .select("id, name, estimated_price, notes, priority, status, created_at, purchased_at")
        .single();
      if (error) {
        setWishListFormError(error.message || "No se pudo actualizar el deseo.");
        return;
      }
      const updated = mapRowToWishListItem(data as {
        id: string;
        name: string;
        estimated_price: number | null;
        notes: string | null;
        priority: string;
        status: string;
        created_at: string;
        purchased_at: string | null;
      });
      setWishListItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } else {
      const { data, error } = await supabase
        .from("wish_list_items")
        .insert({
          name,
          estimated_price: estimatedPrice,
          notes: notes || null,
          priority: wishListForm.priority,
          status: "pending",
        })
        .select("id, name, estimated_price, notes, priority, status, created_at, purchased_at")
        .single();
      if (error) {
        setWishListFormError(error.message || "No se pudo crear el deseo.");
        return;
      }
      const created = mapRowToWishListItem(data as {
        id: string;
        name: string;
        estimated_price: number | null;
        notes: string | null;
        priority: string;
        status: string;
        created_at: string;
        purchased_at: string | null;
      });
      setWishListItems((prev) => [created, ...prev]);
    }
    closeWishListModal();
  };

  const openMarkWishListPurchasedModal = (item: WishListItem) => {
    setConfirmMarkWishListPurchased(item);
    setWishListPurchaseDateInput(todayIso());
  };

  const confirmMarkWishListPurchasedCancel = () => {
    setConfirmMarkWishListPurchased(null);
  };

  const confirmMarkWishListPurchasedOk = async () => {
    if (!confirmMarkWishListPurchased) return;
    if (!wishListPurchaseDateInput) return;
    const purchasedAt = `${wishListPurchaseDateInput}T12:00:00.000Z`;
    const { data, error } = await supabase
      .from("wish_list_items")
      .update({ status: "purchased", purchased_at: purchasedAt })
      .eq("id", confirmMarkWishListPurchased.id)
      .select("id, name, estimated_price, notes, priority, status, created_at, purchased_at")
      .single();
    if (error) {
      confirmMarkWishListPurchasedCancel();
      return;
    }
    const updated = mapRowToWishListItem(data as {
      id: string;
      name: string;
      estimated_price: number | null;
      notes: string | null;
      priority: string;
      status: string;
      created_at: string;
      purchased_at: string | null;
    });
    setWishListItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    confirmMarkWishListPurchasedCancel();
  };

  const unmarkWishListItemPurchased = async (id: string) => {
    const { data, error } = await supabase
      .from("wish_list_items")
      .update({ status: "pending", purchased_at: null })
      .eq("id", id)
      .select("id, name, estimated_price, notes, priority, status, created_at, purchased_at")
      .single();
    if (error) return;
    const updated = mapRowToWishListItem(data as {
      id: string;
      name: string;
      estimated_price: number | null;
      notes: string | null;
      priority: string;
      status: string;
      created_at: string;
      purchased_at: string | null;
    });
    setWishListItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  };

  const confirmDeleteWishListItemOk = async () => {
    if (!confirmDeleteWishListItem) return;
    const id = confirmDeleteWishListItem.id;
    const { error } = await supabase.from("wish_list_items").delete().eq("id", id);
    if (error) {
      setConfirmDeleteWishListItem(null);
      return;
    }
    setWishListItems((prev) => prev.filter((item) => item.id !== id));
    setConfirmDeleteWishListItem(null);
  };

  const confirmDeleteWishListItemCancel = () => {
    setConfirmDeleteWishListItem(null);
  };

  const handleSubmitProjectionLine = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectionLineTarget) return;
    const description = projectionLineForm.description.trim();
    const raw = projectionLineForm.amount.replace(/\s/g, "").replace(",", ".");
    const parsed = Number(raw);
    if (!description) {
      setProjectionLineError("Ingresa una descripción.");
      return;
    }
    if (!raw || Number.isNaN(parsed) || parsed <= 0) {
      setProjectionLineError("Ingresa un monto mayor a 0.");
      return;
    }
    const amount =
      projectionLineForm.lineType === "expense" ? -Math.abs(parsed) : Math.abs(parsed);
    const monthId = await ensureProjectionMonthId(projectionLineTarget.year, projectionLineTarget.month);
    if (!monthId) {
      setProjectionLineError("No se pudo guardar el mes.");
      return;
    }
    if (editingProjectionLineId) {
      const { data, error } = await supabase
        .from("income_projection_lines")
        .update({ description, amount })
        .eq("id", editingProjectionLineId)
        .select("id, month_id, description, amount, sort_order")
        .single();
      if (error) {
        setProjectionLineError(error.message || "No se pudo actualizar la línea.");
        return;
      }
      const row = data as { id: string; month_id: string; description: string; amount: number; sort_order: number };
      setProjectionLines((prev) =>
        prev.map((l) =>
          l.id === editingProjectionLineId
            ? {
                id: String(row.id),
                monthId: String(row.month_id),
                description: row.description,
                amount: Number(row.amount),
                sortOrder: Number(row.sort_order),
              }
            : l,
        ),
      );
    } else {
      const existingLines = projectionLines.filter((l) => l.monthId === monthId);
      const sortOrder =
        existingLines.length > 0 ? Math.max(...existingLines.map((l) => l.sortOrder)) + 1 : 0;
      const { data, error } = await supabase
        .from("income_projection_lines")
        .insert({ month_id: monthId, description, amount, sort_order: sortOrder })
        .select("id, month_id, description, amount, sort_order")
        .single();
      if (error) {
        setProjectionLineError(error.message || "No se pudo crear la línea.");
        return;
      }
      const row = data as { id: string; month_id: string; description: string; amount: number; sort_order: number };
      setProjectionLines((prev) => [
        ...prev,
        {
          id: String(row.id),
          monthId: String(row.month_id),
          description: row.description,
          amount: Number(row.amount),
          sortOrder: Number(row.sort_order),
        },
      ]);
    }
    closeProjectionLineModal();
  };

  const handleDeleteProjectionLine = async (lineId: string) => {
    const { error } = await supabase.from("income_projection_lines").delete().eq("id", lineId);
    if (error) return;
    setProjectionLines((prev) => prev.filter((l) => l.id !== lineId));
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

  const applyFamilyInstallmentPaidState = async (
    installment: FamilyFinancingInstallment,
    newPaid: boolean,
  ) => {
    const item = familyItems.find((row) => row.id === installment.itemId);
    if (!item) return;
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

  const handleFamilyInstallmentPaidToggle = (installment: FamilyFinancingInstallment) => {
    if (installment.isPaid) {
      void applyFamilyInstallmentPaidState(installment, false);
      return;
    }
    setConfirmMarkInstallmentPaid(installment);
  };

  const confirmMarkInstallmentPaidOk = async () => {
    if (!confirmMarkInstallmentPaid) return;
    const installment = confirmMarkInstallmentPaid;
    setConfirmMarkInstallmentPaid(null);
    await applyFamilyInstallmentPaidState(installment, true);
  };

  const confirmMarkInstallmentPaidCancel = () => {
    setConfirmMarkInstallmentPaid(null);
  };

  const startEditFamilyInstallment = (installment: FamilyFinancingInstallment) => {
    if (installment.isPaid) return;
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
    if (editingFamilyInstallment.isPaid) {
      setInstallmentEditError("No se puede editar una cuota ya pagada.");
      return;
    }

    const parsedAmount = Number(installmentEditForm.amount.replace(/\s/g, "").replace(",", "."));
    if (!installmentEditForm.amount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setInstallmentEditError("Ingresa un monto válido mayor a 0.");
      return;
    }
    if (!installmentEditForm.dueMonth || !/^\d{4}-\d{2}$/.test(installmentEditForm.dueMonth)) {
      setInstallmentEditError("Selecciona un mes de pago válido.");
      return;
    }

    const redistribution = computeInstallmentRedistribution(
      item,
      familyInstallments,
      editingFamilyInstallment.id,
      parsedAmount,
    );
    if ("error" in redistribution) {
      setInstallmentEditError(redistribution.error);
      return;
    }

    const dueDate = `${installmentEditForm.dueMonth}-01`;
    const amountById = new Map(redistribution.updates.map((row) => [row.id, row.amount]));

    const updateResults = await Promise.all(
      redistribution.updates.map(async (row) => {
        const payload =
          row.id === editingFamilyInstallment.id
            ? { amount: row.amount, due_date: dueDate }
            : { amount: row.amount };
        const { data, error } = await supabase
          .from("family_financing_installments")
          .update(payload)
          .eq("id", row.id)
          .select("id, item_id, installment_number, amount, due_date, is_paid, paid_at, created_at")
          .single();
        return { data, error, id: row.id };
      }),
    );

    const failed = updateResults.find((result) => result.error || !result.data);
    if (failed) {
      setInstallmentEditError(failed.error?.message || "No se pudieron actualizar las cuotas.");
      return;
    }

    const updatedById = new Map(
      updateResults.map((result) => [
        result.id,
        mapRowToFamilyInstallment(
          result.data as {
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
        ),
      ]),
    );

    setFamilyInstallments((prev) =>
      prev.map((row) => {
        const updated = updatedById.get(row.id);
        if (updated) return updated;
        if (amountById.has(row.id)) {
          return { ...row, amount: amountById.get(row.id)! };
        }
        return row;
      }),
    );
    closeFamilyInstallmentModal();
  };

  const closeFamilyItemDetailModal = () => {
    setSelectedFamilyItemDetail(null);
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
    if (selectedFamilyItemDetail?.id === id) setSelectedFamilyItemDetail(null);
  };

  const confirmDeleteFamilyItemCancel = () => {
    setConfirmDeleteFamilyItem(null);
  };

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
    return { year, month, ...summarizeFamilyMonthInstallments(familyInstallments, year, month) };
  }, [familyInstallments]);

  const familyDashboardMonths = useMemo((): FamilyMonthSummary[] => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentKey = familyMonthKey(currentYear, currentMonth);

    const activeItemIds = new Set(activeFamilyItems.map((item) => item.id));
    const activeInstallments = familyInstallments.filter((inst) => activeItemIds.has(inst.itemId));

    const futureByKey = new Map<number, { year: number; month: number }>();
    for (const inst of activeInstallments) {
      const [dueYear, dueMonth] = inst.dueDate.split("-").map(Number);
      const key = familyMonthKey(dueYear, dueMonth);
      if (key > currentKey) futureByKey.set(key, { year: dueYear, month: dueMonth });
    }

    const futureMonths = Array.from(futureByKey.values())
      .sort((a, b) => familyMonthKey(a.year, a.month) - familyMonthKey(b.year, b.month))
      .slice(0, FAMILY_DASHBOARD_FUTURE_MONTHS);

    const rows: FamilyMonthSummary[] = [
      {
        year: currentYear,
        month: currentMonth,
        isCurrentMonth: true,
        ...summarizeFamilyMonthInstallments(activeInstallments, currentYear, currentMonth),
      },
    ];

    for (const { year, month } of futureMonths) {
      const summary = summarizeFamilyMonthInstallments(activeInstallments, year, month);
      if (summary.count > 0) {
        rows.push({ year, month, isCurrentMonth: false, ...summary });
      }
    }

    return rows;
  }, [activeFamilyItems, familyInstallments]);

  const projectionData = useMemo(() => {
    const sorted = [...projectionMonths].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    );
    let runningBalance = projectionStartingBalance;
    return sorted.map((monthRow) => {
      const openingBalance = runningBalance;
      const lines = projectionLines
        .filter((l) => l.monthId === monthRow.id)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const monthDelta = lines.reduce((sum, l) => sum + l.amount, 0);
      runningBalance += monthDelta;
      return {
        id: monthRow.id,
        year: monthRow.year,
        month: monthRow.month,
        monthId: monthRow.id,
        lines,
        monthDelta,
        openingBalance,
        endingBalance: runningBalance,
      };
    });
  }, [projectionStartingBalance, projectionMonths, projectionLines]);

  const pendingWishListItems = useMemo(
    () =>
      wishListItems
        .filter((item) => item.status === "pending")
        .sort((a, b) => {
          const priorityDiff = WISH_PRIORITY_WEIGHT[a.priority] - WISH_PRIORITY_WEIGHT[b.priority];
          if (priorityDiff !== 0) return priorityDiff;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }),
    [wishListItems],
  );

  const purchasedWishListItems = useMemo(
    () =>
      wishListItems
        .filter((item) => item.status === "purchased")
        .sort((a, b) => {
          const aTime = a.purchasedAt ? new Date(a.purchasedAt).getTime() : 0;
          const bTime = b.purchasedAt ? new Date(b.purchasedAt).getTime() : 0;
          return bTime - aTime;
        }),
    [wishListItems],
  );

  const pendingWishListTotal = useMemo(
    () =>
      pendingWishListItems.reduce((sum, item) => sum + (item.estimatedPrice ?? 0), 0),
    [pendingWishListItems],
  );

  useEffect(() => {
    if (
      !confirmDelete &&
      !confirmDeleteSalary &&
      !showNewTxModal &&
      !showAllTxModal &&
      !showSalaryForm &&
      !editingSalaryId &&
      !showFamilyModal &&
      !editingFamilyInstallment &&
      !confirmDeleteFamilyItem &&
      !projectionLineTarget &&
      !selectedFamilyItemDetail &&
      !confirmMarkInstallmentPaid &&
      !selectedProjectionMonthDetail &&
      !showAddProjectionMonthModal &&
      !confirmDeleteProjectionMonth &&
      !showProjectionBalanceModal &&
      !showWishListModal &&
      !confirmDeleteWishListItem &&
      !confirmMarkWishListPurchased
    )
      return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        confirmDeleteCancel();
        confirmDeleteSalaryCancel();
        closeNewTxModal();
        setShowAllTxModal(false);
        if (showSalaryForm || editingSalaryId) cancelEditSalary();
        if (showFamilyModal) {
          setShowFamilyModal(false);
          resetFamilyForm();
        }
        closeFamilyInstallmentModal();
        confirmDeleteFamilyItemCancel();
        confirmMarkInstallmentPaidCancel();
        closeFamilyItemDetailModal();
        if (projectionLineTarget) closeProjectionLineModal();
        closeProjectionMonthDetailModal();
        closeAddProjectionMonthModal();
        confirmDeleteProjectionMonthCancel();
        closeProjectionBalanceModal();
        closeWishListModal();
        confirmDeleteWishListItemCancel();
        confirmMarkWishListPurchasedCancel();
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
    showFamilyModal,
    editingFamilyInstallment,
    confirmDeleteFamilyItem,
    projectionLineTarget,
    selectedFamilyItemDetail,
    confirmMarkInstallmentPaid,
    selectedProjectionMonthDetail,
    showAddProjectionMonthModal,
    confirmDeleteProjectionMonth,
    showProjectionBalanceModal,
    showWishListModal,
    confirmDeleteWishListItem,
    confirmMarkWishListPurchased,
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
              className={`sidebar-nav-item ${activeView === "incomeProjections" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("incomeProjections"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
              </span>
              Proyección de Ingresos
            </a>
            <a
              href="#"
              className={`sidebar-nav-item ${activeView === "familyFinancing" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("familyFinancing"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </span>
              Financiamiento Familia
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
          <div className="sidebar-nav-group">
            <div className="sidebar-nav-label">LISTAS</div>
            <a
              href="#"
              className={`sidebar-nav-item ${activeView === "wishList" ? "sidebar-nav-item-active" : ""}`}
              onClick={(e) => { e.preventDefault(); setActiveView("wishList"); }}
            >
              <span className="sidebar-nav-icon" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </span>
              Lista de Deseos
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
                : activeView === "incomeProjections"
                ? "Proyección de Ingresos"
                : activeView === "wishList"
                ? "Lista de Deseos"
                : "Financiamiento Familia"}
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
          {activeView === "incomeProjections" && (
            <div className="reference-bar reference-bar-compact reference-bar--lavender">
              <span className="reference-left">
                <span className="reference-main">Proyección</span>
                <span className="reference-amount">
                  {projectionData.length > 0
                    ? `${projectionData.length} mes${projectionData.length !== 1 ? "es" : ""}`
                    : "Sin meses"}
                </span>
              </span>
              <span className="reference-right">
                {projectionData.length > 0
                  ? `Saldo final: ${formatCurrency(projectionData[projectionData.length - 1].endingBalance)}`
                  : "Agregá meses a tu proyección"}
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
          {activeView === "wishList" && (
            <div className="reference-bar reference-bar-compact reference-bar--lavender">
              <span className="reference-left">
                <span className="reference-main">Deseos pendientes</span>
                <span className="reference-amount">{pendingWishListItems.length}</span>
              </span>
              <span className="reference-right">
                {pendingWishListTotal > 0
                  ? `Total estimado ${formatCurrency(pendingWishListTotal)}`
                  : "Sin precios estimados"}
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

        {activeView === "incomeProjections" && (
          <section className="panel panel-projection">
            <div className="projection-section-layout">
              <div className="projection-section-header">
                <div>
                  <h2 className="panel-title">Proyección de Ingresos</h2>
                  <p className="panel-sub-right">Planificá ingresos y gastos mes a mes.</p>
                  <button
                    type="button"
                    className="projection-balance-link"
                    onClick={openProjectionBalanceModal}
                  >
                    Saldo inicial: {formatCurrency(projectionStartingBalance)}
                  </button>
                </div>
                <div className="projection-section-header-actions">
                  <button type="button" className="button goals-add-button" onClick={openAddProjectionMonthModal}>
                    + Agregar mes
                  </button>
                </div>
              </div>

              {projectionStartingBalance === 0 && projectionData.length === 0 && (
                <div className="projection-setup-banner">
                  <p>Configurá tu saldo inicial para empezar a proyectar desde un punto de partida real.</p>
                  <button type="button" className="button button-secondary" onClick={openProjectionBalanceModal}>
                    Configurar saldo inicial
                  </button>
                </div>
              )}

              {projectionData.length === 0 ? (
                <div className="goals-empty-state">
                  <p className="goals-empty-title">Todavía no agregaste meses</p>
                  <p className="goals-empty-sub">
                    Usá &quot;+ Agregar mes&quot; para empezar a proyectar ingresos y gastos.
                  </p>
                </div>
              ) : (
                <ul className="tx-list-plain projection-section-list">
                  {projectionData.map((monthRow) => (
                    <li key={monthRow.id}>
                      <button
                        type="button"
                        className={`projection-section-row ${
                          monthRow.monthDelta > 0
                            ? "projection-section-row--up"
                            : monthRow.monthDelta < 0
                            ? "projection-section-row--down"
                            : ""
                        }`}
                        onClick={() =>
                          setSelectedProjectionMonthDetail({
                            id: monthRow.id,
                            year: monthRow.year,
                            month: monthRow.month,
                          })
                        }
                      >
                        <div className="tx-list-body">
                          <span className="tx-list-desc">
                            {MONTH_NAMES_ES[monthRow.month - 1]} {monthRow.year}
                          </span>
                          <span className="tx-list-meta">
                            {monthRow.lines.length} línea
                            {monthRow.lines.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="tx-list-right projection-section-row-right">
                          <span className="projection-section-ending projection-section-ending--primary">
                            {formatCurrency(monthRow.endingBalance)}
                          </span>
                          <span
                            className={`projection-section-delta projection-section-delta--secondary ${
                              monthRow.monthDelta >= 0
                                ? "projection-line-amount--in"
                                : "projection-line-amount--out"
                            }`}
                          >
                            {monthRow.monthDelta >= 0 ? "+" : ""}
                            {formatCurrency(monthRow.monthDelta)}
                          </span>
                        </div>
                        <span className="projection-section-row-chevron" aria-hidden>
                          ›
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {activeView === "familyFinancing" && (
          <section className="panel panel-family">
            <div className="family-section-layout">
              <div className="family-section-header">
                <div>
                  <h2 className="panel-title">Financiamiento Familia</h2>
                  <p className="panel-sub-right">
                    {activeFamilyItems.length === 0
                      ? "Todavía no cargaste items"
                      : `${activeFamilyItems.length} item${activeFamilyItems.length !== 1 ? "s" : ""} en curso · Pendiente total ${formatCurrency(familyPendingTotal)}`}
                  </p>
                </div>
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

              {activeFamilyItems.length === 0 ? (
                <div className="goals-empty-state">
                  <p className="goals-empty-title">Registrá una compra financiada</p>
                  <p className="goals-empty-sub">
                    Por ejemplo: electrodoméstico, medicamentos o compras del super que tus papás van devolviendo en cuotas.
                  </p>
                </div>
              ) : (
                <ul className="tx-list-plain family-section-list">
                  {activeFamilyItems.map((item) => {
                    const installments = getFamilyItemInstallments(item.id);
                    const paidCount = installments.filter((row) => row.isPaid).length;
                    const remaining = getFamilyItemRemaining(item);
                    const progressPct = getFamilyItemProgressPct(item);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="family-section-row"
                          onClick={() => setSelectedFamilyItemDetail(item)}
                        >
                          <div className="tx-list-body">
                            <span className="tx-list-desc">{item.name}</span>
                            <span className="tx-list-meta">
                              Compra: {formatDisplayDate(item.purchaseDate)} · {paidCount}/{installments.length} cuota{installments.length !== 1 ? "s" : ""} pagada{paidCount !== 1 ? "s" : ""}
                            </span>
                          </div>
                          <div className="tx-list-right family-section-row-right">
                            <span className="family-section-remaining">{formatCurrency(remaining)}</span>
                            <span className="family-section-progress">{progressPct.toFixed(0)}% pagado</span>
                          </div>
                          <span className="family-section-row-chevron" aria-hidden>›</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {completedFamilyItems.length > 0 && (
                <section className="family-section-completed">
                  <h2 className="panel-title family-section-completed-title">Completados</h2>
                  <ul className="tx-list-plain family-section-list">
                    {completedFamilyItems.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="family-section-row family-section-row--completed"
                          onClick={() => setSelectedFamilyItemDetail(item)}
                        >
                          <div className="tx-list-body">
                            <span className="tx-list-desc">{item.name}</span>
                            <span className="tx-list-meta">
                              Compra: {formatDisplayDate(item.purchaseDate)} · {formatCurrency(item.totalAmount)}
                            </span>
                          </div>
                          <div className="tx-list-right family-section-row-right">
                            <span className="family-section-status-done">Completado</span>
                          </div>
                          <span className="family-section-row-chevron" aria-hidden>›</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </section>
        )}

        {activeView === "wishList" && (
          <section className="panel panel-wish-list">
            <div className="wish-list-section-layout">
              <div className="wish-list-section-header">
                <div>
                  <h2 className="panel-title">Lista de Deseos</h2>
                  <p className="panel-sub-right">
                    {pendingWishListItems.length === 0
                      ? "Todavía no agregaste deseos"
                      : `${pendingWishListItems.length} deseo${pendingWishListItems.length !== 1 ? "s" : ""} pendiente${pendingWishListItems.length !== 1 ? "s" : ""}${
                          pendingWishListTotal > 0 ? ` · Total estimado ${formatCurrency(pendingWishListTotal)}` : ""
                        }`}
                  </p>
                </div>
                <button type="button" className="button goals-add-button" onClick={() => openWishListModal()}>
                  + Nuevo deseo
                </button>
              </div>

              {pendingWishListItems.length === 0 ? (
                <div className="goals-empty-state">
                  <p className="goals-empty-title">Tu lista está vacía</p>
                  <p className="goals-empty-sub">
                    Agregá cosas que quieras comprar y marcálas cuando las consigas.
                  </p>
                </div>
              ) : (
                <ul className="tx-list-plain wish-list-section-list">
                  {pendingWishListItems.map((item) => (
                      <li key={item.id}>
                        <WishListPendingRow
                          item={item}
                          onMarkPurchased={() => openMarkWishListPurchasedModal(item)}
                          onEdit={() => openWishListModal(item)}
                          onDelete={() => setConfirmDeleteWishListItem(item)}
                        />
                      </li>
                    ))}
                </ul>
              )}

              <section className="wish-list-completed">
                <h2 className="panel-title wish-list-completed-title">Comprados</h2>
                {purchasedWishListItems.length === 0 ? (
                  <p className="wish-list-completed-empty">
                    Cuando compres algo de tu lista, aparecerá aquí.
                  </p>
                ) : (
                  <ul className="tx-list-plain wish-list-section-list">
                    {purchasedWishListItems.map((item) => (
                      <li key={item.id}>
                        <div className="wish-list-row wish-list-row--purchased">
                          <span className="wish-list-purchased-check" aria-hidden>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          </span>
                          <div className="wish-list-row-body">
                            <span className="tx-list-desc wish-list-desc--purchased">{item.name}</span>
                            <span className="tx-list-meta">
                              Comprado: {formatWishListPurchasedDate(item.purchasedAt)}
                              {item.estimatedPrice != null ? ` · ${formatCurrency(item.estimatedPrice)}` : ""}
                              {item.notes ? ` · ${item.notes}` : ""}
                            </span>
                          </div>
                          <div className="wish-list-row-actions wish-list-row-actions--purchased">
                            <button
                              type="button"
                              className="wish-list-restore-link"
                              onClick={() => void unmarkWishListItemPurchased(item.id)}
                            >
                              Volver a deseos
                            </button>
                            <button
                              type="button"
                              className="wish-list-action-btn wish-list-action-btn--danger"
                              data-tooltip="Eliminar"
                              onClick={() => setConfirmDeleteWishListItem(item)}
                              aria-label="Eliminar comprado"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
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

      {confirmDeleteFamilyItem && (
        <div
          className="modal-overlay modal-overlay--stacked"
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

      {selectedFamilyItemDetail && (() => {
        const item =
          familyItems.find((row) => row.id === selectedFamilyItemDetail.id) ?? selectedFamilyItemDetail;
        const isReadOnly = item.status === "completed";
        const installments = getFamilyItemInstallments(item.id);
        const paidAmount = getFamilyItemPaidAmount(item.id);
        const remaining = getFamilyItemRemaining(item);
        const progressPct = getFamilyItemProgressPct(item);
        const paidCount = installments.filter((row) => row.isPaid).length;
        const installmentsTotal = getFamilyItemInstallmentsTotal(item.id);
        const installmentsMismatch = Math.abs(installmentsTotal - item.totalAmount) > 0.01;

        return (
          <div
            className="modal-overlay"
            onClick={closeFamilyItemDetailModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-family-detail-title"
          >
            <div className="modal modal-family-detail" onClick={(e) => e.stopPropagation()}>
              <div className="modal-family-detail-header">
                <div>
                  <h2 id="modal-family-detail-title" className="modal-title">
                    {item.name}
                  </h2>
                  <p className="modal-family-detail-sub">
                    Compra: {formatDisplayDate(item.purchaseDate)}
                    {item.notes ? ` · ${item.notes}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className="modal-close-btn"
                  onClick={closeFamilyItemDetailModal}
                  aria-label="Cerrar"
                >
                  ×
                </button>
              </div>

              <div className="goal-progress family-detail-progress">
                <div className="goal-progress-bar">
                  <div
                    className={`goal-progress-fill goal-progress-fill--${isReadOnly ? "completed" : "in_progress"}`}
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
                  <span className="goal-progress-pct">{progressPct.toFixed(0)}%</span>
                </div>
                <p className="goal-progress-remaining">
                  {isReadOnly
                    ? "Item completado."
                    : `Restan ${formatCurrency(remaining)} de ${formatCurrency(item.totalAmount)}.`}
                </p>
                <p className="family-installments-summary">
                  {paidCount}/{installments.length} cuota{installments.length !== 1 ? "s" : ""} pagada
                  {paidCount !== 1 ? "s" : ""}
                </p>
                {installmentsMismatch && (
                  <p className="family-installments-hint">
                    Las cuotas suman {formatCurrency(installmentsTotal)} (total del item:{" "}
                    {formatCurrency(item.totalAmount)})
                  </p>
                )}
              </div>

              <div className="family-installments family-detail-installments">
                {installments.map((installment) => (
                  <div
                    key={installment.id}
                    className={`family-installment-row ${installment.isPaid ? "family-installment-row--paid" : ""}`}
                  >
                    {isReadOnly ? (
                      <span className="family-installment-check family-installment-check--readonly">
                        <span>
                          Cuota {installment.installmentNumber} · {formatDueMonth(installment.dueDate)}
                        </span>
                      </span>
                    ) : (
                      <label className="family-installment-check">
                        <input
                          type="checkbox"
                          checked={installment.isPaid}
                          onChange={() => handleFamilyInstallmentPaidToggle(installment)}
                        />
                        <span>
                          Cuota {installment.installmentNumber} · {formatDueMonth(installment.dueDate)}
                        </span>
                      </label>
                    )}
                    <div className="family-installment-actions">
                      <span className="family-installment-amount">
                        {formatCurrency(installment.amount)}
                      </span>
                      {!isReadOnly && !installment.isPaid && (
                        <button
                          type="button"
                          className="button button-secondary family-installment-edit-btn"
                          onClick={() => startEditFamilyInstallment(installment)}
                          aria-label={`Editar cuota ${installment.installmentNumber}`}
                        >
                          Editar
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {!isReadOnly && (
                <div className="modal-actions modal-family-detail-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      startEditFamilyItem(item);
                      closeFamilyItemDetailModal();
                    }}
                  >
                    Editar item
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => setConfirmDeleteFamilyItem(item)}
                  >
                    Eliminar
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {confirmMarkInstallmentPaid && (
        <div
          className="modal-overlay modal-overlay--stacked"
          onClick={confirmMarkInstallmentPaidCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-mark-installment-paid-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-mark-installment-paid-title" className="modal-title">
              Marcar cuota como pagada
            </h2>
            <p className="modal-body">
              ¿Confirmás que la cuota {confirmMarkInstallmentPaid.installmentNumber} de{" "}
              {formatDueMonth(confirmMarkInstallmentPaid.dueDate)} por{" "}
              <strong>{formatCurrency(confirmMarkInstallmentPaid.amount)}</strong> fue pagada?
            </p>
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={confirmMarkInstallmentPaidCancel}>
                Cancelar
              </button>
              <button type="button" className="button" onClick={() => void confirmMarkInstallmentPaidOk()}>
                Confirmar pago
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
          className="modal-overlay modal-overlay--stacked"
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
              Ajustá el monto o el mes de pago. Las cuotas siguientes no pagadas se recalculan automáticamente según el total del item.
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

      {showWishListModal && (
        <div
          className="modal-overlay"
          onClick={closeWishListModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-wish-list-title"
        >
          <div className="modal modal-wish-list" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-wish-list-title" className="modal-title">
              {editingWishListItemId ? "Editar deseo" : "Nuevo deseo"}
            </h2>
            <form onSubmit={(e) => void handleSubmitWishListItem(e)}>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Nombre</label>
                </div>
                <input
                  type="text"
                  className="input"
                  placeholder="Ej. Auriculares, silla ergonómica"
                  value={wishListForm.name}
                  onChange={(e) => {
                    setWishListForm((prev) => ({ ...prev, name: e.target.value }));
                    setWishListFormError(null);
                  }}
                />
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Precio estimado</label>
                  <span className="field-hint">Opcional</span>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  className="input"
                  placeholder="2500"
                  value={wishListForm.estimatedPrice}
                  onChange={(e) => {
                    setWishListForm((prev) => ({ ...prev, estimatedPrice: e.target.value }));
                    setWishListFormError(null);
                  }}
                />
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Prioridad</label>
                </div>
                <select
                  className="input"
                  value={wishListForm.priority}
                  onChange={(e) => {
                    setWishListForm((prev) => ({
                      ...prev,
                      priority: e.target.value as WishListPriority,
                    }));
                    setWishListFormError(null);
                  }}
                >
                  <option value="high">Alta</option>
                  <option value="medium">Media</option>
                  <option value="low">Baja</option>
                </select>
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Notas</label>
                  <span className="field-hint">Opcional</span>
                </div>
                <input
                  type="text"
                  className="input"
                  placeholder="Color, tienda, modelo..."
                  value={wishListForm.notes}
                  onChange={(e) => {
                    setWishListForm((prev) => ({ ...prev, notes: e.target.value }));
                    setWishListFormError(null);
                  }}
                />
              </div>
              {wishListFormError && (
                <div className="error-text goals-error-text">{wishListFormError}</div>
              )}
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={closeWishListModal}>
                  Cancelar
                </button>
                <button type="submit" className="button">
                  {editingWishListItemId ? "Guardar cambios" : "Agregar deseo"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmDeleteWishListItem && (
        <div
          className="modal-overlay modal-overlay--stacked"
          onClick={confirmDeleteWishListItemCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-delete-wish-list-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-delete-wish-list-title" className="modal-title">
              Eliminar deseo
            </h2>
            <p className="modal-body">
              ¿Eliminar <strong>{confirmDeleteWishListItem.name}</strong>?
            </p>
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={confirmDeleteWishListItemCancel}>
                Cancelar
              </button>
              <button type="button" className="button" onClick={() => void confirmDeleteWishListItemOk()}>
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmMarkWishListPurchased && (
        <div
          className="modal-overlay"
          onClick={confirmMarkWishListPurchasedCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-mark-wish-list-title"
        >
          <div className="modal modal-wish-list-purchased" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-mark-wish-list-title" className="modal-title">
              Marcar como comprado
            </h2>
            <p className="modal-body modal-wish-list-purchased-sub">
              <strong>{confirmMarkWishListPurchased.name}</strong>
            </p>
            <form onSubmit={(e) => { e.preventDefault(); void confirmMarkWishListPurchasedOk(); }}>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Fecha de compra</label>
                </div>
                <input
                  type="date"
                  className="input"
                  value={wishListPurchaseDateInput}
                  onChange={(e) => setWishListPurchaseDateInput(e.target.value)}
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={confirmMarkWishListPurchasedCancel}>
                  Cancelar
                </button>
                <button type="submit" className="button">
                  Confirmar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showProjectionBalanceModal && (
        <div
          className="modal-overlay"
          onClick={closeProjectionBalanceModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-projection-balance-title"
        >
          <div className="modal modal-projection-balance" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-projection-balance-title" className="modal-title">
              Saldo inicial
            </h2>
            <p className="modal-body modal-projection-balance-sub">
              Punto de partida para calcular el saldo acumulado mes a mes.
            </p>
            <form onSubmit={(e) => void handleSaveProjectionBalance(e)}>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label" htmlFor="projection-starting-balance">
                    Monto
                  </label>
                </div>
                <input
                  id="projection-starting-balance"
                  type="text"
                  inputMode="decimal"
                  className="input"
                  value={projectionBalanceInput}
                  onChange={(e) => {
                    setProjectionBalanceInput(e.target.value);
                    setProjectionBalanceError(null);
                  }}
                />
              </div>
              {projectionBalanceError && (
                <div className="error-text goals-error-text">{projectionBalanceError}</div>
              )}
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={closeProjectionBalanceModal}>
                  Cancelar
                </button>
                <button type="submit" className="button">
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {projectionLineTarget && (
        <div
          className="modal-overlay modal-overlay--stacked"
          onClick={closeProjectionLineModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-projection-line-title"
        >
          <div className="modal modal-projection-line" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-projection-line-title" className="modal-title">
              {editingProjectionLineId ? "Editar línea" : "Nueva línea"}
            </h2>
            <p className="modal-body modal-projection-line-sub">
              {MONTH_NAMES_ES[projectionLineTarget.month - 1]} {projectionLineTarget.year}
            </p>
            <form onSubmit={handleSubmitProjectionLine}>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Tipo</label>
                </div>
                <div className="projection-line-type-toggle" role="group" aria-label="Tipo de movimiento">
                  <button
                    type="button"
                    className={`projection-line-type-btn ${
                      projectionLineForm.lineType === "income" ? "projection-line-type-btn--active projection-line-type-btn--income" : ""
                    }`}
                    onClick={() => {
                      setProjectionLineForm((prev) => ({ ...prev, lineType: "income" }));
                      setProjectionLineError(null);
                    }}
                  >
                    Ingreso
                  </button>
                  <button
                    type="button"
                    className={`projection-line-type-btn ${
                      projectionLineForm.lineType === "expense" ? "projection-line-type-btn--active projection-line-type-btn--expense" : ""
                    }`}
                    onClick={() => {
                      setProjectionLineForm((prev) => ({ ...prev, lineType: "expense" }));
                      setProjectionLineError(null);
                    }}
                  >
                    Gasto
                  </button>
                </div>
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Descripción</label>
                </div>
                <input
                  type="text"
                  className="input"
                  placeholder="Ej. Salario, alquiler, gastos"
                  value={projectionLineForm.description}
                  onChange={(e) => {
                    setProjectionLineForm((prev) => ({ ...prev, description: e.target.value }));
                    setProjectionLineError(null);
                  }}
                />
              </div>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Monto</label>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  className="input"
                  placeholder="3500"
                  value={projectionLineForm.amount}
                  onChange={(e) => {
                    setProjectionLineForm((prev) => ({ ...prev, amount: e.target.value }));
                    setProjectionLineError(null);
                  }}
                />
              </div>
              {projectionLineError && (
                <div className="error-text goals-error-text">{projectionLineError}</div>
              )}
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={closeProjectionLineModal}>
                  Cancelar
                </button>
                <button type="submit" className="button">
                  {editingProjectionLineId ? "Guardar cambios" : "Agregar línea"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddProjectionMonthModal && (
        <div
          className="modal-overlay"
          onClick={closeAddProjectionMonthModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-add-projection-month-title"
        >
          <div className="modal modal-projection-add-month" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-add-projection-month-title" className="modal-title">
              Agregar mes
            </h2>
            <p className="modal-body">Elegí el mes que querés incluir en la proyección.</p>
            <form onSubmit={handleAddProjectionMonth}>
              <div className="field">
                <div className="field-label-row">
                  <label className="field-label">Mes</label>
                </div>
                <input
                  type="month"
                  className="input"
                  value={addProjectionMonthInput}
                  onChange={(e) => {
                    setAddProjectionMonthInput(e.target.value);
                    setAddProjectionMonthError(null);
                  }}
                />
              </div>
              {addProjectionMonthError && (
                <div className="error-text goals-error-text">{addProjectionMonthError}</div>
              )}
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={closeAddProjectionMonthModal}>
                  Cancelar
                </button>
                <button type="submit" className="button">
                  Agregar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {confirmDeleteProjectionMonth && (
        <div
          className="modal-overlay modal-overlay--stacked"
          onClick={confirmDeleteProjectionMonthCancel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-delete-projection-month-title"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="modal-delete-projection-month-title" className="modal-title">
              Eliminar mes
            </h2>
            <p className="modal-body">
              ¿Eliminar {MONTH_NAMES_ES[confirmDeleteProjectionMonth.month - 1]}{" "}
              {confirmDeleteProjectionMonth.year} y todas sus líneas?
            </p>
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={confirmDeleteProjectionMonthCancel}>
                Cancelar
              </button>
              <button type="button" className="button" onClick={() => void confirmDeleteProjectionMonthOk()}>
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedProjectionMonthDetail && (() => {
        const monthRow = projectionData.find((row) => row.id === selectedProjectionMonthDetail.id);
        if (!monthRow) return null;
        return (
          <div
            className="modal-overlay"
            onClick={closeProjectionMonthDetailModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-projection-month-title"
          >
            <div className="modal modal-projection-month-detail" onClick={(e) => e.stopPropagation()}>
              <div className="modal-projection-month-detail-header">
                <div>
                  <h2 id="modal-projection-month-title" className="modal-title">
                    {MONTH_NAMES_ES[monthRow.month - 1]} {monthRow.year}
                  </h2>
                  <p className="modal-projection-month-detail-sub">
                    Saldo al inicio: {formatCurrency(monthRow.openingBalance)}
                  </p>
                </div>
                <button
                  type="button"
                  className="modal-close-btn"
                  onClick={closeProjectionMonthDetailModal}
                  aria-label="Cerrar"
                >
                  ×
                </button>
              </div>

              <div className="projection-month-detail-summary">
                <span>
                  Variación:{" "}
                  <strong
                    className={
                      monthRow.monthDelta >= 0 ? "projection-line-amount--in" : "projection-line-amount--out"
                    }
                  >
                    {monthRow.monthDelta >= 0 ? "+" : ""}
                    {formatCurrency(monthRow.monthDelta)}
                  </strong>
                </span>
                <span>
                  Saldo acumulado: <strong>{formatCurrency(monthRow.endingBalance)}</strong>
                </span>
              </div>

              {monthRow.lines.length === 0 ? (
                <p className="projection-month-empty">Sin movimientos este mes.</p>
              ) : (
                <ul className="projection-lines-list projection-lines-list--detail">
                  {monthRow.lines.map((line) => (
                    <li key={line.id} className="projection-line-item">
                      <div className="projection-line-item-main">
                        <span className="projection-line-desc">{line.description}</span>
                        <span
                          className={`projection-line-type-chip ${
                            line.amount >= 0 ? "projection-line-type-chip--income" : "projection-line-type-chip--expense"
                          }`}
                        >
                          {line.amount >= 0 ? "Ingreso" : "Gasto"}
                        </span>
                      </div>
                      <span
                        className={`projection-line-amount ${
                          line.amount >= 0 ? "projection-line-amount--in" : "projection-line-amount--out"
                        }`}
                      >
                        {line.amount >= 0 ? "+" : ""}
                        {formatCurrency(line.amount)}
                      </span>
                      <div className="projection-line-actions">
                        <button
                          type="button"
                          className="button button-secondary goal-card-btn goal-card-btn-icon"
                          data-tooltip="Editar"
                          onClick={() => openProjectionLineModal(monthRow.year, monthRow.month, line)}
                          aria-label="Editar línea"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                        </button>
                        <button
                          type="button"
                          className="button button-secondary goal-card-btn goal-card-btn-icon"
                          data-tooltip="Eliminar"
                          onClick={() => void handleDeleteProjectionLine(line.id)}
                          aria-label="Eliminar línea"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="modal-actions modal-projection-month-detail-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => openProjectionLineModal(monthRow.year, monthRow.month)}
                >
                  + Línea
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    setConfirmDeleteProjectionMonth({
                      id: monthRow.id,
                      year: monthRow.year,
                      month: monthRow.month,
                    })
                  }
                >
                  Eliminar mes
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

          <section className="panel panel-goals-summary panel-family-summary">
            <div className="goals-summary-header">
              <h2 className="panel-title">Financiamiento Familia</h2>
              <button
                type="button"
                className="button button-secondary goals-summary-link"
                onClick={() => setActiveView("familyFinancing")}
              >
                Ver sección →
              </button>
            </div>
            <div className="family-dashboard-list-wrap">
              {familyDashboardMonths.length === 1 && familyDashboardMonths[0].count === 0 ? (
                <p className="goals-summary-empty">Sin cuotas de familia programadas.</p>
              ) : (
                <ul className="tx-list-plain family-dashboard-list">
                  {familyDashboardMonths.map((row) => (
                    <li key={`${row.year}-${row.month}`} className="tx-list-plain-item family-dashboard-row">
                      <div className="tx-list-body">
                        <span className="tx-list-desc">
                          {MONTH_NAMES_ES[row.month - 1]} {row.year}
                        </span>
                        {row.count > 0 && (
                          <span className="tx-list-meta">
                            {row.count} cuota{row.count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <div className="tx-list-right family-dashboard-right">
                        {row.count === 0 ? (
                          <span className="tx-list-meta">Sin cuotas</span>
                        ) : (
                          <>
                            <span className="family-dashboard-amount">{formatCurrency(row.total)}</span>
                            <span className={`family-dashboard-status family-dashboard-status--${row.status}`}>
                              {getFamilyMonthStatusLabel(row)}
                            </span>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
                  const hasActivity = act && (act.transactions.length > 0 || act.salaries.length > 0);
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
                          {dayActivities && (dayActivities.transactions.length > 0 || dayActivities.salaries.length > 0) ? (
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

