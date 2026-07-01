-- =============================================================================
-- supabase_model_central.sql — "Model Central" (Fatia 1: CSN/USIM/GGBR)
-- O admin sobe o MODELO OFICIAL (.xlsx); o model-central-lib.js lê + valida + gera o
-- MESH de numeradores (cantos; multilinear → interp exato). Aqui guardamos UM snapshot
-- validado por empresa. A super aba recalcula os 3 indicadores AO VIVO (preço/câmbio live).
--
-- Mesh é PEQUENO (≤8 cantos × 4 métricas) → cabe num jsonb/linha; não precisa do
-- stock_guide_scenario_grid (que é p/ grids grandes paginados). Hide-aware (empresa oculta
-- não vaza mesh/base p/ não-admin). RLS on SEM policy → só via RPC SECURITY DEFINER.
-- Reusa o is_admin() existente (role 'admin') e o stock_guide_companies.is_visible.
--
-- RODAR 1× no Supabase (depende de supabase_stock_guide.sql já existir: is_admin + companies).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Tabela: 1 snapshot validado por ticker (o que está PUBLICADO/ao vivo)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.model_central_models (
  ticker      text PRIMARY KEY,
  currency    text NOT NULL DEFAULT 'BRL',
  fy          text NOT NULL DEFAULT '',                 -- ano exibido, ex. '2026E'
  model_date  text NOT NULL DEFAULT '',                 -- data do modelo (COVER/nome), ex. 'Apr-22-2026'
  axes        jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{id,label,unit,base,min,max,kind,live,source}]
  base        jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {ebitda,net_debt,fcf,dividends,mktcap,shares,price}
  mesh        jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {ebitda:[{coords,value}],net_debt,fcf,dividends}
  published   jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {ev_ebitda,fcf_yield,div_yield} (do modelo)
  gate        jsonb NOT NULL DEFAULT '{}'::jsonb,        -- {ok,diffs,recomputed}
  notes       text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id),
  CONSTRAINT model_central_axes_is_array  CHECK (jsonb_typeof(axes) = 'array'),
  CONSTRAINT model_central_mesh_is_object CHECK (jsonb_typeof(mesh) = 'object')
);
ALTER TABLE public.model_central_models ENABLE ROW LEVEL SECURITY;   -- sem policy: só RPC SECURITY DEFINER

-- ─────────────────────────────────────────────────────────────────────────────
-- Leitura HIDE-AWARE (cliente vê só visíveis; admin vê tudo). Granted anon+authenticated.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_model_central_models();
CREATE FUNCTION public.get_model_central_models()
  RETURNS SETOF public.model_central_models
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT m.* FROM public.model_central_models m
   WHERE (SELECT public.is_admin())
      OR EXISTS (SELECT 1 FROM public.stock_guide_companies c
                  WHERE c.ticker = m.ticker AND c.is_visible)
   ORDER BY m.ticker;
$$;
REVOKE ALL ON FUNCTION public.get_model_central_models() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_model_central_models() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Upsert do admin (1 empresa por chamada). Gate roda no NAVEGADOR antes (fail-closed):
-- o admin só publica se gate.ok; aqui re-checamos is_admin + que o gate veio ok.
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_upsert_model_central_model(jsonb);
CREATE FUNCTION public.admin_upsert_model_central_model(p jsonb)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p->>'ticker','') = '' THEN
    RAISE EXCEPTION 'ticker obrigatório';
  END IF;
  IF COALESCE((p#>>'{gate,ok}')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'gate reprovado — upload bloqueado (fail-closed)';
  END IF;

  INSERT INTO public.model_central_models
    (ticker, currency, fy, model_date, axes, base, mesh, published, gate, notes, updated_at, updated_by)
  VALUES
    (p->>'ticker',
     COALESCE(p->>'currency','BRL'),
     COALESCE(p->>'fy',''),
     COALESCE(p->>'model_date',''),
     COALESCE(p->'axes','[]'::jsonb),
     COALESCE(p->'base','{}'::jsonb),
     COALESCE(p->'mesh','{}'::jsonb),
     COALESCE(p->'published','{}'::jsonb),
     COALESCE(p->'gate','{}'::jsonb),
     COALESCE(p->>'notes',''),
     now(), auth.uid())
  ON CONFLICT (ticker) DO UPDATE SET
    currency   = EXCLUDED.currency,
    fy         = EXCLUDED.fy,
    model_date = EXCLUDED.model_date,
    axes       = EXCLUDED.axes,
    base       = EXCLUDED.base,
    mesh       = EXCLUDED.mesh,
    published  = EXCLUDED.published,
    gate       = EXCLUDED.gate,
    notes      = EXCLUDED.notes,
    updated_at = now(),
    updated_by = auth.uid();
END;
$$;
REVOKE ALL ON FUNCTION public.admin_upsert_model_central_model(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_model_central_model(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_model_central_model(jsonb) TO authenticated;

-- (opcional) remover um snapshot — admin
DROP FUNCTION IF EXISTS public.admin_delete_model_central_model(text);
CREATE FUNCTION public.admin_delete_model_central_model(p_ticker text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.model_central_models WHERE ticker = p_ticker;   -- WHERE explícito (guard "safe update")
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_model_central_model(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_model_central_model(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_model_central_model(text) TO authenticated;

-- Verificação rápida (anon vê só visíveis):
--   select ticker, fy, gate->>'ok' from get_model_central_models();
