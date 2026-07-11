-- Proyección de Ingresos — ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS public.income_projection_settings (
  id INT PRIMARY KEY,
  starting_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.income_projection_settings (id, starting_balance)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.income_projection_months (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  year INT NOT NULL,
  month INT NOT NULL CHECK (month >= 1 AND month <= 12),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (year, month)
);

CREATE TABLE IF NOT EXISTS public.income_projection_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month_id UUID NOT NULL REFERENCES public.income_projection_months(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_income_projection_lines_month_id
  ON public.income_projection_lines (month_id);

ALTER TABLE public.income_projection_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.income_projection_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.income_projection_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read income_projection_settings" ON public.income_projection_settings;
DROP POLICY IF EXISTS "Allow insert income_projection_settings" ON public.income_projection_settings;
DROP POLICY IF EXISTS "Allow update income_projection_settings" ON public.income_projection_settings;
DROP POLICY IF EXISTS "Allow read income_projection_months" ON public.income_projection_months;
DROP POLICY IF EXISTS "Allow insert income_projection_months" ON public.income_projection_months;
DROP POLICY IF EXISTS "Allow update income_projection_months" ON public.income_projection_months;
DROP POLICY IF EXISTS "Allow delete income_projection_months" ON public.income_projection_months;
DROP POLICY IF EXISTS "Allow read income_projection_lines" ON public.income_projection_lines;
DROP POLICY IF EXISTS "Allow insert income_projection_lines" ON public.income_projection_lines;
DROP POLICY IF EXISTS "Allow update income_projection_lines" ON public.income_projection_lines;
DROP POLICY IF EXISTS "Allow delete income_projection_lines" ON public.income_projection_lines;

CREATE POLICY "Allow read income_projection_settings" ON public.income_projection_settings FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert income_projection_settings" ON public.income_projection_settings FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update income_projection_settings" ON public.income_projection_settings FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow read income_projection_months" ON public.income_projection_months FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert income_projection_months" ON public.income_projection_months FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update income_projection_months" ON public.income_projection_months FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete income_projection_months" ON public.income_projection_months FOR DELETE TO anon USING (true);
CREATE POLICY "Allow read income_projection_lines" ON public.income_projection_lines FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert income_projection_lines" ON public.income_projection_lines FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update income_projection_lines" ON public.income_projection_lines FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete income_projection_lines" ON public.income_projection_lines FOR DELETE TO anon USING (true);

NOTIFY pgrst, 'reload schema';
