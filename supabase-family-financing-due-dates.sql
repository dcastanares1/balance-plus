-- ============================================================
-- Migración: mes de pago (due_date) en cuotas de Financiamiento familia
-- ============================================================
-- 1. Entrá a https://supabase.com/dashboard y abrí tu proyecto.
-- 2. SQL Editor > New query.
-- 3. Pegá todo este archivo y hacé clic en Run.
-- 4. Recargá la app.
-- ============================================================

ALTER TABLE public.family_financing_installments
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- Cuota N = primer día del mes (compra + N meses)
UPDATE public.family_financing_installments fi
SET due_date = (
  date_trunc('month', i.purchase_date::timestamp)
  + make_interval(months => fi.installment_number)
)::date
FROM public.family_financing_items i
WHERE fi.item_id = i.id
  AND fi.due_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_family_financing_installments_due_date
  ON public.family_financing_installments (due_date);

-- Refrescar el schema cache de la API (evita el error "Could not find ... in the schema cache")
NOTIFY pgrst, 'reload schema';
