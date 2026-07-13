-- ============================================================
-- Crear tabla de Lista de Deseos en Supabase
-- ============================================================
-- 1. Entrá a https://supabase.com/dashboard y abrí tu proyecto.
-- 2. En el menú izquierdo: SQL Editor > New query.
-- 3. Pegá todo este archivo y hacé clic en Run (o Cmd+Enter).
-- 4. Deberías ver "Success". Después recargá la app.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.wish_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  estimated_price NUMERIC(12,2) NULL CHECK (estimated_price IS NULL OR estimated_price > 0),
  notes TEXT NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'purchased')),
  created_at TIMESTAMPTZ DEFAULT now(),
  purchased_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_wish_list_items_status
  ON public.wish_list_items (status);

CREATE INDEX IF NOT EXISTS idx_wish_list_items_purchased_at
  ON public.wish_list_items (purchased_at DESC NULLS LAST);

ALTER TABLE public.wish_list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read wish_list_items" ON public.wish_list_items;
DROP POLICY IF EXISTS "Allow insert wish_list_items" ON public.wish_list_items;
DROP POLICY IF EXISTS "Allow update wish_list_items" ON public.wish_list_items;
DROP POLICY IF EXISTS "Allow delete wish_list_items" ON public.wish_list_items;

CREATE POLICY "Allow read wish_list_items"
  ON public.wish_list_items FOR SELECT TO anon USING (true);

CREATE POLICY "Allow insert wish_list_items"
  ON public.wish_list_items FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow update wish_list_items"
  ON public.wish_list_items FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "Allow delete wish_list_items"
  ON public.wish_list_items FOR DELETE TO anon USING (true);

NOTIFY pgrst, 'reload schema';
