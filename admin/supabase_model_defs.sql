-- =============================================================================
-- supabase_model_defs.sql — "Modelo Vivo" (v2 da sensibilidade do Stock Guide)
--
-- Guarda, por empresa, a DEFINIÇÃO VIVA do modelo como DADO editável:
--   def = { ticker, name, base_ccy, years[],
--           drivers:[{id,label,unit,kind,live_source,base_by_year[],min,max,editable_years[]}],
--           lines:  [{id,label,unit,base_by_year[],formula,params:{nome:[porAno]}}],
--           outputs:[{id,label,unit,formula,published_by_year[]}],
--           market: {mktcap_model_by_year[],shares_by_year[],model_price,price_cell,fx_source} }
--
-- O motor (model-engine.js) LÊ isto e recalcula ao vivo no navegador (drivers ->
-- linhas com fórmula editável -> indicadores, colunas Modelo × Ao vivo). O painel
-- de admin EDITA isto (add/remove linha, editar fórmula, ligar driver, faixas).
-- O extrator fiel (model-central/extract_models.py) GERA isto a partir do .xlsx.
--
-- Hide-aware (empresa oculta não vaza p/ não-admin). RLS on SEM policy -> só via RPC
-- SECURITY DEFINER. Reusa is_admin() + stock_guide_companies.is_visible.
-- RODAR 1× no Supabase (depende de supabase_stock_guide.sql já existir).
-- Convive com model_central_models (legado); a Fase 3 migra o cliente p/ cá e aposenta o antigo.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.model_defs (
  ticker      text PRIMARY KEY,
  def         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- a definição viva inteira
  parity      numeric,                              -- pior erro % de paridade na extração (auditoria)
  source      text NOT NULL DEFAULT 'admin',        -- 'extractor' | 'admin' (quem gravou por último)
  notes       text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id),
  CONSTRAINT model_defs_is_object CHECK (jsonb_typeof(def) = 'object')
);
ALTER TABLE public.model_defs ENABLE ROW LEVEL SECURITY;   -- sem policy: só RPC SECURITY DEFINER

-- ─────────────────────────────────────────────────────────────────────────────
-- Leitura HIDE-AWARE (cliente vê só visíveis; admin vê tudo). Granted anon+authenticated.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_model_defs();
CREATE FUNCTION public.get_model_defs()
  RETURNS SETOF public.model_defs
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT m.* FROM public.model_defs m
   WHERE (SELECT public.is_admin())
      OR EXISTS (SELECT 1 FROM public.stock_guide_companies c
                  WHERE c.ticker = m.ticker AND c.is_visible)
   ORDER BY m.ticker;
$$;
REVOKE ALL ON FUNCTION public.get_model_defs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_model_defs() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Upsert do admin / extrator (1 empresa por chamada). Valida is_admin + shape mínimo.
-- p = { ticker, def, parity?, source?, notes? }
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_upsert_model_def(jsonb);
CREATE FUNCTION public.admin_upsert_model_def(p jsonb)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_ticker text := COALESCE(p->>'ticker', p#>>'{def,ticker}');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_ticker,'') = '' THEN
    RAISE EXCEPTION 'ticker obrigatório';
  END IF;
  IF jsonb_typeof(p->'def') <> 'object' THEN
    RAISE EXCEPTION 'def deve ser objeto';
  END IF;
  -- sanidade mínima: precisa de years[] e drivers[] p/ o motor funcionar
  IF jsonb_typeof(p#>'{def,years}') <> 'array' OR jsonb_typeof(p#>'{def,drivers}') <> 'array' THEN
    RAISE EXCEPTION 'def inválida: faltam years[]/drivers[]';
  END IF;

  INSERT INTO public.model_defs (ticker, def, parity, source, notes, updated_at, updated_by)
  VALUES (v_ticker, p->'def',
          NULLIF(p->>'parity','')::numeric,
          COALESCE(p->>'source','admin'),
          COALESCE(p->>'notes',''),
          now(), auth.uid())
  ON CONFLICT (ticker) DO UPDATE SET
    def = EXCLUDED.def, parity = EXCLUDED.parity, source = EXCLUDED.source,
    notes = EXCLUDED.notes, updated_at = now(), updated_by = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.admin_upsert_model_def(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_model_def(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_model_def(jsonb) TO authenticated;

-- (opcional) remover uma definição — admin
DROP FUNCTION IF EXISTS public.admin_delete_model_def(text);
CREATE FUNCTION public.admin_delete_model_def(p_ticker text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.model_defs WHERE ticker = p_ticker;   -- WHERE explícito
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_model_def(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_model_def(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_model_def(text) TO authenticated;

-- Verificação rápida:  select ticker, parity, source, updated_at from get_model_defs();
