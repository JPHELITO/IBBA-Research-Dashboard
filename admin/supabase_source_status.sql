-- =============================================================================
-- supabase_source_status.sql — sinais de frescor p/ o painel "Status das fontes"
-- (Fase 4). UMA RPC que agrega, num jsonb, "atualizado há X" de cada fonte que
-- vive no Supabase (o admin monta o resto — .db lê MAX(period) no navegador).
-- Só admin (is_admin). RODAR 1× no Supabase.
-- =============================================================================
DROP FUNCTION IF EXISTS public.get_source_status();
CREATE FUNCTION public.get_source_status()
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT CASE WHEN public.is_admin() THEN jsonb_build_object(
    'now',         now(),
    'news_last',   (SELECT max(ran_at)     FROM public.hunter_runs),                    -- heartbeat do news-hunter
    'quotes_last', (SELECT max(updated_at) FROM public.quotes),                          -- robô de preços (Yahoo)
    'macro_last',  (SELECT max(updated_at) FROM public.macro_indicators),      -- robô macro (Yahoo + BCB)
    'comm_last',   (SELECT max(updated_at) FROM public.commodities),
    'platts_last', (SELECT max(updated_at) FROM public.commodities
                     WHERE code IS NULL OR code NOT IN ('COPPER','GOLD','IRON_ORE_62')), -- Platts (exclui Yahoo/TE)
    'iron62_last', (SELECT max(updated_at) FROM public.commodities WHERE code='IRON_ORE_62'),
    'ai_last',     (SELECT max(take_llm_at) FROM public.news_articles),
    'ai_24',       (SELECT count(*)::int FROM public.news_articles
                     WHERE take_llm_at > now() - interval '24 hours'),
    'platts',      (SELECT to_jsonb(s) FROM (SELECT last_ok, last_attempt, login_failed
                     FROM public.source_health WHERE source ILIKE '%platts%'
                     ORDER BY last_attempt DESC NULLS LAST LIMIT 1) s),
    'fastmarkets', (SELECT to_jsonb(s) FROM (SELECT last_ok, last_attempt, login_failed
                     FROM public.source_health WHERE source ILIKE '%fastmarket%'
                     ORDER BY last_attempt DESC NULLS LAST LIMIT 1) s),
    'model_defs',  (SELECT jsonb_agg(jsonb_build_object('ticker',ticker,'updated_at',updated_at,'source',source) ORDER BY ticker)
                     FROM public.model_defs),
    'base_log',    (SELECT jsonb_agg(t) FROM (
                       SELECT DISTINCT ON (source) source, method, detail, created_at AS last_update
                       FROM public.update_log ORDER BY source, created_at DESC) t)
  ) ELSE NULL END;
$$;
REVOKE ALL ON FUNCTION public.get_source_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_source_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_source_status() TO authenticated;

-- Verificação:  select get_source_status();
