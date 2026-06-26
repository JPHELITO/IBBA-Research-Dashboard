-- =============================================================================
-- STOCK GUIDE v3 — Global Peers a partir das abas "*Peers" do modelo (.xlsm)
--
-- Complementa supabase_stock_guide.sql + _v2_upload.sql. IDEMPOTENTE. Rodar DEPOIS deles.
--
-- O QUE MUDA: a tabela de peers (stock_guide_global_peers) ganha colunas p/ os peers
-- que vêm do arquivo — country, sector, yahoo_symbol (preço AO VIVO na página),
-- Net Debt/EBITDA, P/CE (alguns setores usam P/CE em vez de P/E) e mkt_cap_usd snapshot.
-- O upload do .xlsm passa a popular os peers (replace-total) via o RPC já existente
-- admin_replace_stock_guide_global_peers, agora estendido p/ ler os campos novos.
-- Múltiplos = SNAPSHOT do arquivo (consenso); só o PREÇO é ao vivo (resolve o problema
-- de listagem: BHP/Rio negociam em Londres no arquivo e como ADR de NY na Market).
-- =============================================================================

-- 1. COLUNAS NOVAS (aditivo, idempotente)
ALTER TABLE public.stock_guide_global_peers
  ADD COLUMN IF NOT EXISTS country            text,
  ADD COLUMN IF NOT EXISTS sector             text,
  ADD COLUMN IF NOT EXISTS yahoo_symbol       text,
  ADD COLUMN IF NOT EXISTS net_debt_ebitda_y1 numeric,
  ADD COLUMN IF NOT EXISTS net_debt_ebitda_y2 numeric,
  ADD COLUMN IF NOT EXISTS pce_y1             numeric,
  ADD COLUMN IF NOT EXISTS pce_y2             numeric,
  ADD COLUMN IF NOT EXISTS mkt_cap_usd        numeric;

-- 2. LEITURA PÚBLICA — recriada com as colunas novas
DROP FUNCTION IF EXISTS public.get_stock_guide_global_peers();
CREATE FUNCTION public.get_stock_guide_global_peers()
 RETURNS TABLE(company text, pe_y1 numeric, pe_y2 numeric, ev_ebitda_y1 numeric, ev_ebitda_y2 numeric,
   div_yield_y1 numeric, div_yield_y2 numeric, is_aggregate boolean, is_live boolean, display_order integer,
   country text, sector text, yahoo_symbol text, net_debt_ebitda_y1 numeric, net_debt_ebitda_y2 numeric,
   pce_y1 numeric, pce_y2 numeric, mkt_cap_usd numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ SELECT p.company, p.pe_y1, p.pe_y2, p.ev_ebitda_y1, p.ev_ebitda_y2, p.div_yield_y1, p.div_yield_y2,
             p.is_aggregate, p.is_live, p.display_order,
             p.country, p.sector, p.yahoo_symbol, p.net_debt_ebitda_y1, p.net_debt_ebitda_y2,
             p.pce_y1, p.pce_y2, p.mkt_cap_usd
      FROM public.stock_guide_global_peers p ORDER BY p.display_order, p.company; $$;
REVOKE ALL ON FUNCTION public.get_stock_guide_global_peers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_global_peers() TO anon, authenticated;

-- 3. REPLACE-TOTAL — estendido p/ os campos novos (mantém compat com o editor manual antigo:
--    campos ausentes viram null). DELETE all + INSERT each. NaN rejeitado nos múltiplos núcleo.
CREATE OR REPLACE FUNCTION public.admin_replace_stock_guide_global_peers(p_rows jsonb)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_count int := 0; v_elem jsonb; v_company text; v_n numeric;
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'rows_must_be_array' USING ERRCODE='22023'; END IF;
    DELETE FROM public.stock_guide_global_peers;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
      v_elem := public._sg_blanks_to_null(v_elem);
      v_company := nullif(trim(v_elem->>'company'), '');
      IF v_company IS NULL THEN RAISE EXCEPTION 'company_required in row %', v_elem USING ERRCODE='22023'; END IF;
      FOREACH v_n IN ARRAY ARRAY[ (v_elem->>'pe_y1')::numeric, (v_elem->>'pe_y2')::numeric,
        (v_elem->>'ev_ebitda_y1')::numeric, (v_elem->>'ev_ebitda_y2')::numeric,
        (v_elem->>'div_yield_y1')::numeric, (v_elem->>'div_yield_y2')::numeric ] LOOP
        IF v_n = 'NaN'::numeric THEN RAISE EXCEPTION 'nan_not_allowed in row %', v_elem USING ERRCODE='22023'; END IF;
      END LOOP;
      INSERT INTO public.stock_guide_global_peers
        (company, pe_y1, pe_y2, ev_ebitda_y1, ev_ebitda_y2, div_yield_y1, div_yield_y2,
         is_aggregate, is_live, display_order,
         country, sector, yahoo_symbol, net_debt_ebitda_y1, net_debt_ebitda_y2, pce_y1, pce_y2, mkt_cap_usd, updated_at)
      VALUES (v_company, (v_elem->>'pe_y1')::numeric, (v_elem->>'pe_y2')::numeric,
        (v_elem->>'ev_ebitda_y1')::numeric, (v_elem->>'ev_ebitda_y2')::numeric,
        (v_elem->>'div_yield_y1')::numeric, (v_elem->>'div_yield_y2')::numeric,
        COALESCE((v_elem->>'is_aggregate')::boolean, false), COALESCE((v_elem->>'is_live')::boolean, false),
        COALESCE((v_elem->>'display_order')::int, v_count),
        nullif(trim(v_elem->>'country'),''), nullif(trim(v_elem->>'sector'),''), nullif(trim(v_elem->>'yahoo_symbol'),''),
        (v_elem->>'net_debt_ebitda_y1')::numeric, (v_elem->>'net_debt_ebitda_y2')::numeric,
        (v_elem->>'pce_y1')::numeric, (v_elem->>'pce_y2')::numeric, (v_elem->>'mkt_cap_usd')::numeric, now());
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_replace_stock_guide_global_peers(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_replace_stock_guide_global_peers(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_stock_guide_global_peers(jsonb) TO authenticated;

-- =============================================================================
-- VERIFICAÇÃO (admin): select count(*) from get_stock_guide_global_peers();
-- Após subir o .xlsm no /admin → ~18 peers (Steel/Mining/P&P/Gold que têm cotação na Market).
-- =============================================================================
