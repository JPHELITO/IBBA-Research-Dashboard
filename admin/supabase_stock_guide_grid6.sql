-- =============================================================================
-- STOCK GUIDE — SENSIBILIDADE 6-D POR EMPRESA (grade pré-calculada + interpolação viva)
--
-- Adiciona ao Stock Guide o formato "grid6": cada empresa sobe UMA grade de cenários
-- (3 variáveis × 2 anos = sequência de 6 valores) já calculada no Excel, com 6 métricas
-- por cenário (EBITDA/FCF/Net Debt × ano atual/próximo). A dash interpola (multilinear
-- 6-D) e deriva EV/EBITDA · FCF yield · ND/EBITDA AO VIVO com o market cap em tempo real.
--
-- Grades grandes (dezenas a centenas de milhares de cenários) NÃO cabem em linhas
-- (`stock_guide_scenario_grid` só tem x/y/z + cap de 50k do PostgREST + milhões de linhas
-- por empresa). Solução: 1 BLOB por sensibilidade = gzip(JSON dos arrays densos) em base64,
-- guardado em CHUNKS (robusto ao proxy corporativo que barra POST grande — "Failed to fetch").
--   • definition (jsonb, PEQUENO)  = kind:'grid6' + eixos/rótulos/níveis + base + outputs
--                                    → a UI monta os 6 steppers SEM baixar o blob.
--   • blob (base64 gzip, GRANDE)   = só os arrays densos das 6 métricas (indexados pela
--                                    grade dos `levels`) → baixado lazy ao abrir a abinha.
--
-- Rodar no SQL Editor do Supabase, DEPOIS de `supabase_stock_guide.sql`. IDEMPOTENTE.
-- Mesmos invariantes: RLS-on-sem-policy; leitura via SECURITY DEFINER + search_path,
-- hide-aware; escrita guardada por is_admin() (42501) + revoke anon.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA — blob de cenários (base64 do gzip, em chunks ordenados por seq)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_guide_scenario_blob (
  sensitivity_id bigint NOT NULL
                   REFERENCES public.stock_guide_sensitivities(id) ON DELETE CASCADE,
  seq            int    NOT NULL,           -- ordem do chunk (0..N)
  chunk          text   NOT NULL,           -- fragmento base64 do gzip
  CONSTRAINT stock_guide_scenario_blob_pkey PRIMARY KEY (sensitivity_id, seq)
);
ALTER TABLE public.stock_guide_scenario_blob ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- LEITURA — blob concatenado, HIDE-AWARE (só se a empresa da sensibilidade é visível
-- ou o requisitante é admin). Retorna NULL quando oculto/inexistente.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_stock_guide_scenario_blob(p_sensitivity_id bigint)
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_ok boolean;
  BEGIN
    SELECT public.is_admin() OR EXISTS (
      SELECT 1
        FROM public.stock_guide_sensitivities s
        JOIN public.stock_guide_companies c ON c.ticker = ANY (s.companies)
       WHERE s.id = p_sensitivity_id AND c.is_visible
    ) INTO v_ok;
    IF NOT v_ok THEN RETURN NULL; END IF;
    RETURN (SELECT string_agg(b.chunk, '' ORDER BY b.seq)
              FROM public.stock_guide_scenario_blob b
             WHERE b.sensitivity_id = p_sensitivity_id);
  END; $$;
REVOKE ALL ON FUNCTION public.get_stock_guide_scenario_blob(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_scenario_blob(bigint) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- ESCRITA (admin) — replace chunked. p_first_chunk=true zera o blob antes de inserir.
-- Cliente parte o base64 em pedaços de ~256 KB e chama em sequência (seq 0,1,2,...).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_replace_stock_guide_scenario_blob(
    p_sensitivity_id bigint, p_seq int, p_chunk text, p_first_chunk boolean)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_guide_sensitivities WHERE id = p_sensitivity_id) THEN
      RAISE EXCEPTION 'sensitivity_not_found: %', p_sensitivity_id USING ERRCODE='22023'; END IF;
    IF p_first_chunk THEN
      DELETE FROM public.stock_guide_scenario_blob WHERE sensitivity_id = p_sensitivity_id;
    END IF;
    IF p_chunk IS NOT NULL AND length(p_chunk) > 0 THEN
      INSERT INTO public.stock_guide_scenario_blob (sensitivity_id, seq, chunk)
      VALUES (p_sensitivity_id, p_seq, p_chunk)
      ON CONFLICT (sensitivity_id, seq) DO UPDATE SET chunk = EXCLUDED.chunk;
    END IF;
    RETURN p_seq;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_replace_stock_guide_scenario_blob(bigint, int, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_replace_stock_guide_scenario_blob(bigint, int, text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_stock_guide_scenario_blob(bigint, int, text, boolean) TO authenticated;

-- tamanho do blob guardado (p/ o admin conferir após subir) — nº de chunks + bytes de base64
DROP FUNCTION IF EXISTS public.admin_stock_guide_scenario_blob_info(bigint);
CREATE FUNCTION public.admin_stock_guide_scenario_blob_info(p_sensitivity_id bigint)
  RETURNS TABLE(chunks bigint, base64_len bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT count(*)::bigint, COALESCE(sum(length(b.chunk)),0)::bigint
      FROM public.stock_guide_scenario_blob b WHERE b.sensitivity_id = p_sensitivity_id;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_stock_guide_scenario_blob_info(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_stock_guide_scenario_blob_info(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_stock_guide_scenario_blob_info(bigint) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- REDEFINE get_stock_guide_sensitivity_tables() — acrescenta o ramo 'grid6'
-- (superset da versão de supabase_stock_guide.sql; a abinha grid6 some p/ não-admin
--  quando a empresa está oculta, pois `definition.base` traz métricas sensíveis).
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_stock_guide_sensitivity_tables();
CREATE FUNCTION public.get_stock_guide_sensitivity_tables()
 RETURNS TABLE(id bigint, title text, value_mode text, metric_label text, unit text,
   companies text[], definition jsonb, display_order integer)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  DECLARE v_admin boolean := public.is_admin();
          v_hidden text[];
          r record; v_def jsonb; v_companies text[];
  BEGIN
    IF v_admin THEN
      RETURN QUERY SELECT s.id, s.title, s.value_mode, s.metric_label, s.unit, s.companies, s.definition, s.display_order
                   FROM public.stock_guide_sensitivities s ORDER BY s.display_order, s.id;
      RETURN;
    END IF;
    SELECT COALESCE(array_agg(c.ticker), '{}') INTO v_hidden
      FROM public.stock_guide_companies c WHERE c.is_visible = false;
    FOR r IN SELECT * FROM public.stock_guide_sensitivities s ORDER BY s.display_order, s.id LOOP
      IF (r.definition->>'kind') = 'grid6' THEN
        -- abinha por empresa: só aparece se ALGUMA company da sensibilidade for visível
        IF EXISTS (SELECT 1 FROM unnest(r.companies) t WHERE NOT (t = ANY(v_hidden))) THEN
          RETURN QUERY SELECT r.id, r.title, r.value_mode, r.metric_label, r.unit, r.companies, r.definition, r.display_order;
        END IF;
        CONTINUE;
      END IF;
      IF (r.definition ? 'grid') THEN
        -- grid antigo: sem eixo de empresa exposto; o mesh RPC esconde os dados → passa direto
        RETURN QUERY SELECT r.id, r.title, r.value_mode, r.metric_label, r.unit, r.companies, r.definition, r.display_order;
        CONTINUE;
      END IF;
      v_def := public._sg_strip_static(r.definition, v_hidden);
      IF v_def IS NULL THEN CONTINUE; END IF;                        -- nenhuma empresa sobrou
      v_companies := ARRAY(SELECT t FROM unnest(r.companies) t WHERE NOT (t = ANY(v_hidden)));
      IF COALESCE(array_length(v_companies,1),0) = 0 THEN CONTINUE; END IF;
      RETURN QUERY SELECT r.id, r.title, r.value_mode, r.metric_label, r.unit, v_companies, v_def, r.display_order;
    END LOOP;
    RETURN;
  END; $$;
REVOKE ALL ON FUNCTION public.get_stock_guide_sensitivity_tables() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_sensitivity_tables() TO anon, authenticated;

-- =============================================================================
-- VERIFICAÇÃO
--   -- como ADMIN, após subir uma grade pela área de admin:
--   select * from admin_stock_guide_scenario_blob_info(<id>);   -- chunks>0, base64_len>0
--   select length(get_stock_guide_scenario_blob(<id>));         -- = base64_len (admin OU empresa visível)
--   -- como ANON, se a empresa da sensibilidade estiver OCULTA:
--   select get_stock_guide_scenario_blob(<id>);                 -- NULL
--   select * from get_stock_guide_sensitivity_tables();         -- a abinha grid6 oculta NÃO aparece
-- =============================================================================
