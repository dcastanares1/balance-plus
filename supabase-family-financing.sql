-- ============================================================
-- Crear tablas de Financiamiento familia en Supabase
-- ============================================================
-- 1. Entrá a https://supabase.com/dashboard y abrí tu proyecto.
-- 2. En el menú izquierdo: SQL Editor > New query.
-- 3. Pegá todo este archivo y hacé clic en Run (o Cmd+Enter).
-- 4. Deberías ver "Success". Después recargá la app.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_financing_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount > 0),
  purchase_date DATE NOT NULL,
  notes TEXT NULL,
  installment_count INT NOT NULL CHECK (installment_count >= 1),
  status TEXT NOT NULL DEFAULT 'in_progress',
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS public.family_financing_installments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.family_financing_items(id) ON DELETE CASCADE,
  installment_number INT NOT NULL CHECK (installment_number >= 1),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  due_date DATE NULL,
  is_paid BOOLEAN NOT NULL DEFAULT false,
  paid_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (item_id, installment_number)
);

CREATE INDEX IF NOT EXISTS idx_family_financing_installments_item_id
  ON public.family_financing_installments (item_id);

CREATE INDEX IF NOT EXISTS idx_family_financing_items_status
  ON public.family_financing_items (status);

ALTER TABLE public.family_financing_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_financing_installments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read family_financing_items" ON public.family_financing_items;
DROP POLICY IF EXISTS "Allow insert family_financing_items" ON public.family_financing_items;
DROP POLICY IF EXISTS "Allow update family_financing_items" ON public.family_financing_items;
DROP POLICY IF EXISTS "Allow delete family_financing_items" ON public.family_financing_items;

DROP POLICY IF EXISTS "Allow read family_financing_installments" ON public.family_financing_installments;
DROP POLICY IF EXISTS "Allow insert family_financing_installments" ON public.family_financing_installments;
DROP POLICY IF EXISTS "Allow update family_financing_installments" ON public.family_financing_installments;
DROP POLICY IF EXISTS "Allow delete family_financing_installments" ON public.family_financing_installments;

CREATE POLICY "Allow read family_financing_items"
  ON public.family_financing_items FOR SELECT TO anon USING (true);

CREATE POLICY "Allow insert family_financing_items"
  ON public.family_financing_items FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow update family_financing_items"
  ON public.family_financing_items FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow delete family_financing_items"
  ON public.family_financing_items FOR DELETE TO anon USING (true);

CREATE POLICY "Allow read family_financing_installments"
  ON public.family_financing_installments FOR SELECT TO anon USING (true);

CREATE POLICY "Allow insert family_financing_installments"
  ON public.family_financing_installments FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow update family_financing_installments"
  ON public.family_financing_installments FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow delete family_financing_installments"
  ON public.family_financing_installments FOR DELETE TO anon USING (true);
