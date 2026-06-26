-- =============================================================================
-- STOCK GUIDE v2 — colunas extras p/ comps "iguais à Summary" + UPLOAD do .xlsm
--
-- Complementa admin/supabase_stock_guide.sql (rodar DEPOIS dele). IDEMPOTENTE.
--
-- O QUE MUDA:
--   1) Adiciona colunas price-INDEPENDENT que faltavam p/ reproduzir a aba "Summary"
--      do modelo de equity research (EV/EBITDA · Net Debt/EBITDA · P/CE · Div Yield)
--      e p/ a futura análise de sensibilidade:
--        cash_earnings_{y1,y2}  → numerador do P/CE
--        ocf_{y1,y2}            → OCF (sensibilidade / OCF yield opcional)
--        capex_{y1,y2}          → CAPEX (sensibilidade)
--        net_revenues_{y1,y2}   → receita líquida (sensibilidade)
--        ev_adjustment_{y1,y2}  → ponte minorit./coligadas: EV = mktcap + net_debt + adj
--   2) Moeda — o modelo às vezes reporta em USD um papel que negocia em BRL/CLP/MXN
--      (Vale, Copec, CMPC, Grupo México). Em vez de adivinhar, guardamos 2 fatores
--      capturados DO PRÓPRIO modelo no upload:
--        fx_to_base  → mktcap na moeda-base do modelo = preço_vivo × ações × fx_to_base
--                      (=1 quando base==moeda de negociação, ex.: Gerdau/Suzano)
--        fx_to_usd   → mktcap em US$ (coluna comparável da Summary)
--        base_ccy / trade_ccy → rótulos cosméticos ("valores em US$mn" / moeda do preço)
--      → Todos os múltiplos passam a ser AO VIVO sem hardcode de câmbio. (USD/BRL pode,
--        opcionalmente, ser sobrescrito pelo câmbio ao vivo da aba Market mais à frente.)
--   3) get_stock_guide_comps() — devolve as colunas novas (HIDE-AWARE, igual ao resto).
--   4) admin_upsert_stock_guide_company() — passa a gravar as colunas novas.
--   5) admin_bulk_upsert_stock_guide_companies(p_rows jsonb) — NOVO: o upload do Excel
--      manda TODAS as empresas de uma vez (1 chamada). Preserva is_visible. Idempotente.
--
-- INVARIANTES preservados: RLS-on-sem-policy; leitura SECURITY DEFINER + search_path +
-- CASE (is_visible OR is_admin()); admin com is_admin() 42501 + revoke anon; ''→null.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. COLUNAS NOVAS (aditivo, idempotente)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stock_guide_companies
  ADD COLUMN IF NOT EXISTS cash_earnings_y1 numeric,
  ADD COLUMN IF NOT EXISTS cash_earnings_y2 numeric,
  ADD COLUMN IF NOT EXISTS ocf_y1           numeric,
  ADD COLUMN IF NOT EXISTS ocf_y2           numeric,
  ADD COLUMN IF NOT EXISTS capex_y1         numeric,
  ADD COLUMN IF NOT EXISTS capex_y2         numeric,
  ADD COLUMN IF NOT EXISTS net_revenues_y1  numeric,
  ADD COLUMN IF NOT EXISTS net_revenues_y2  numeric,
  ADD COLUMN IF NOT EXISTS ev_adjustment_y1 numeric,
  ADD COLUMN IF NOT EXISTS ev_adjustment_y2 numeric,
  ADD COLUMN IF NOT EXISTS fx_to_base       numeric DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_to_usd        numeric,
  ADD COLUMN IF NOT EXISTS base_ccy         text,
  ADD COLUMN IF NOT EXISTS trade_ccy        text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. LEITURA PÚBLICA — recriada com as colunas novas (HIDE-AWARE)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.get_stock_guide_comps();
CREATE FUNCTION public.get_stock_guide_comps()
 RETURNS TABLE(ticker text, company_name text, is_visible boolean, display_order integer,
   sector text, volume_unit text, yahoo_symbol text, shares_outstanding numeric,
   net_debt_y1 numeric, net_debt_y2 numeric, last_update date, target_price numeric,
   recommendation text, ebitda_y1 numeric, ebitda_y2 numeric, net_income_y1 numeric, net_income_y2 numeric,
   net_income_ex_y1 numeric, net_income_ex_y2 numeric, npv_tax_credit_y1 numeric, npv_tax_credit_y2 numeric,
   fcfe_y1 numeric, fcfe_y2 numeric, dividends_y1 numeric, dividends_y2 numeric,
   volumes_y1 numeric, volumes_y2 numeric, model_url text,
   -- novas:
   cash_earnings_y1 numeric, cash_earnings_y2 numeric, ocf_y1 numeric, ocf_y2 numeric,
   capex_y1 numeric, capex_y2 numeric, net_revenues_y1 numeric, net_revenues_y2 numeric,
   ev_adjustment_y1 numeric, ev_adjustment_y2 numeric,
   fx_to_base numeric, fx_to_usd numeric, base_ccy text, trade_ccy text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT c.ticker, c.company_name, c.is_visible, c.display_order,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.sector             ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.volume_unit        ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.yahoo_symbol       ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.shares_outstanding ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_debt_y1        ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_debt_y2        ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.last_update        ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.target_price       ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.recommendation     ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.ebitda_y1          ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.ebitda_y2          ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_income_y1      ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_income_y2      ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_income_ex_y1   ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_income_ex_y2   ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.npv_tax_credit_y1  ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.npv_tax_credit_y2  ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.fcfe_y1            ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.fcfe_y2            ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.dividends_y1       ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.dividends_y2       ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.volumes_y1         ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.volumes_y2         ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.model_url          ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.cash_earnings_y1   ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.cash_earnings_y2   ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.ocf_y1             ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.ocf_y2             ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.capex_y1           ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.capex_y2           ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_revenues_y1    ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.net_revenues_y2    ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.ev_adjustment_y1   ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.ev_adjustment_y2   ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.fx_to_base         ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.fx_to_usd          ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.base_ccy           ELSE NULL END,
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.trade_ccy          ELSE NULL END
  FROM public.stock_guide_companies c ORDER BY c.display_order, c.ticker;
$$;
REVOKE ALL ON FUNCTION public.get_stock_guide_comps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_comps() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. HELPER interno — aplica 1 linha (jsonb) na tabela (INSERT/UPDATE). is_visible
--    NUNCA vem de p_data (default true no insert; preservado no update). Reuso pelo
--    upsert unitário e pelo bulk. NÃO é GRANTado (interno; chamado por SECURITY DEFINER).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._sg_apply_company(p_ticker text, p_data jsonb)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_ticker text := nullif(trim(p_ticker), '');
          v_name text := nullif(trim(p_data->>'company_name'), '');
          v_ysym text := nullif(trim(p_data->>'yahoo_symbol'), '');
  BEGIN
    p_data := public._sg_blanks_to_null(p_data);
    IF v_ticker IS NULL THEN RAISE EXCEPTION 'ticker_required' USING ERRCODE='22023'; END IF;
    IF v_name   IS NULL THEN RAISE EXCEPTION 'company_name_required (ticker %)', v_ticker USING ERRCODE='22023'; END IF;
    IF v_ysym   IS NULL THEN RAISE EXCEPTION 'yahoo_symbol_required (ticker %)', v_ticker USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_guide_companies (
      ticker, company_name, yahoo_symbol, sector, volume_unit, shares_outstanding, last_update,
      target_price, recommendation, net_debt_y1, net_debt_y2, ebitda_y1, ebitda_y2,
      net_income_y1, net_income_y2, net_income_ex_y1, net_income_ex_y2, npv_tax_credit_y1, npv_tax_credit_y2,
      fcfe_y1, fcfe_y2, dividends_y1, dividends_y2, volumes_y1, volumes_y2, model_url, display_order,
      cash_earnings_y1, cash_earnings_y2, ocf_y1, ocf_y2, capex_y1, capex_y2,
      net_revenues_y1, net_revenues_y2, ev_adjustment_y1, ev_adjustment_y2,
      fx_to_base, fx_to_usd, base_ccy, trade_ccy, updated_at, updated_by)
    VALUES (
      v_ticker, v_name, v_ysym,
      COALESCE(nullif(trim(p_data->>'sector'),''), 'steel'),
      COALESCE(nullif(trim(p_data->>'volume_unit'),''), 'kt'),
      (p_data->>'shares_outstanding')::numeric, (p_data->>'last_update')::date,
      (p_data->>'target_price')::numeric, nullif(trim(p_data->>'recommendation'),''),
      (p_data->>'net_debt_y1')::numeric, (p_data->>'net_debt_y2')::numeric,
      (p_data->>'ebitda_y1')::numeric, (p_data->>'ebitda_y2')::numeric,
      (p_data->>'net_income_y1')::numeric, (p_data->>'net_income_y2')::numeric,
      (p_data->>'net_income_ex_y1')::numeric, (p_data->>'net_income_ex_y2')::numeric,
      (p_data->>'npv_tax_credit_y1')::numeric, (p_data->>'npv_tax_credit_y2')::numeric,
      (p_data->>'fcfe_y1')::numeric, (p_data->>'fcfe_y2')::numeric,
      (p_data->>'dividends_y1')::numeric, (p_data->>'dividends_y2')::numeric,
      (p_data->>'volumes_y1')::numeric, (p_data->>'volumes_y2')::numeric,
      nullif(trim(p_data->>'model_url'),''), COALESCE((p_data->>'display_order')::int, 0),
      (p_data->>'cash_earnings_y1')::numeric, (p_data->>'cash_earnings_y2')::numeric,
      (p_data->>'ocf_y1')::numeric, (p_data->>'ocf_y2')::numeric,
      (p_data->>'capex_y1')::numeric, (p_data->>'capex_y2')::numeric,
      (p_data->>'net_revenues_y1')::numeric, (p_data->>'net_revenues_y2')::numeric,
      (p_data->>'ev_adjustment_y1')::numeric, (p_data->>'ev_adjustment_y2')::numeric,
      COALESCE((p_data->>'fx_to_base')::numeric, 1), (p_data->>'fx_to_usd')::numeric,
      nullif(trim(p_data->>'base_ccy'),''), nullif(trim(p_data->>'trade_ccy'),''),
      now(), auth.uid())
    ON CONFLICT (ticker) DO UPDATE SET
      company_name=v_name, yahoo_symbol=v_ysym,
      sector=COALESCE(nullif(trim(p_data->>'sector'),''), 'steel'),
      volume_unit=COALESCE(nullif(trim(p_data->>'volume_unit'),''), 'kt'),
      shares_outstanding=(p_data->>'shares_outstanding')::numeric, last_update=(p_data->>'last_update')::date,
      target_price=(p_data->>'target_price')::numeric, recommendation=nullif(trim(p_data->>'recommendation'),''),
      net_debt_y1=(p_data->>'net_debt_y1')::numeric, net_debt_y2=(p_data->>'net_debt_y2')::numeric,
      ebitda_y1=(p_data->>'ebitda_y1')::numeric, ebitda_y2=(p_data->>'ebitda_y2')::numeric,
      net_income_y1=(p_data->>'net_income_y1')::numeric, net_income_y2=(p_data->>'net_income_y2')::numeric,
      net_income_ex_y1=(p_data->>'net_income_ex_y1')::numeric, net_income_ex_y2=(p_data->>'net_income_ex_y2')::numeric,
      npv_tax_credit_y1=(p_data->>'npv_tax_credit_y1')::numeric, npv_tax_credit_y2=(p_data->>'npv_tax_credit_y2')::numeric,
      fcfe_y1=(p_data->>'fcfe_y1')::numeric, fcfe_y2=(p_data->>'fcfe_y2')::numeric,
      dividends_y1=(p_data->>'dividends_y1')::numeric, dividends_y2=(p_data->>'dividends_y2')::numeric,
      volumes_y1=(p_data->>'volumes_y1')::numeric, volumes_y2=(p_data->>'volumes_y2')::numeric,
      model_url=nullif(trim(p_data->>'model_url'),''), display_order=COALESCE((p_data->>'display_order')::int, 0),
      cash_earnings_y1=(p_data->>'cash_earnings_y1')::numeric, cash_earnings_y2=(p_data->>'cash_earnings_y2')::numeric,
      ocf_y1=(p_data->>'ocf_y1')::numeric, ocf_y2=(p_data->>'ocf_y2')::numeric,
      capex_y1=(p_data->>'capex_y1')::numeric, capex_y2=(p_data->>'capex_y2')::numeric,
      net_revenues_y1=(p_data->>'net_revenues_y1')::numeric, net_revenues_y2=(p_data->>'net_revenues_y2')::numeric,
      ev_adjustment_y1=(p_data->>'ev_adjustment_y1')::numeric, ev_adjustment_y2=(p_data->>'ev_adjustment_y2')::numeric,
      fx_to_base=COALESCE((p_data->>'fx_to_base')::numeric, 1), fx_to_usd=(p_data->>'fx_to_usd')::numeric,
      base_ccy=nullif(trim(p_data->>'base_ccy'),''), trade_ccy=nullif(trim(p_data->>'trade_ccy'),''),
      updated_at=now(), updated_by=auth.uid();
      -- is_visible PROPOSITALMENTE não tocado (preservado).
  END; $$;
REVOKE ALL ON FUNCTION public._sg_apply_company(text, jsonb) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. UPSERT unitário (compatível com o admin atual; agora grava as colunas novas)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_upsert_stock_guide_company(p_ticker text, p_data jsonb)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    PERFORM public._sg_apply_company(p_ticker, p_data);
  END; $$;
REVOKE ALL ON FUNCTION public.admin_upsert_stock_guide_company(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_stock_guide_company(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_stock_guide_company(text, jsonb) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. BULK UPSERT — o upload do .xlsm manda todas as empresas de uma vez. Cada item
--    do array deve trazer 'ticker' + os campos. is_visible preservado. Retorna a
--    contagem. Tudo numa transação: se UMA linha falha, NADA é gravado (atômico).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_bulk_upsert_stock_guide_companies(p_rows jsonb)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_count int := 0; v_elem jsonb; v_ticker text;
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'rows_must_be_array' USING ERRCODE='22023'; END IF;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
      v_ticker := nullif(trim(v_elem->>'ticker'), '');
      PERFORM public._sg_apply_company(v_ticker, v_elem);
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_bulk_upsert_stock_guide_companies(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_bulk_upsert_stock_guide_companies(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_upsert_stock_guide_companies(jsonb) TO authenticated;

-- =============================================================================
-- VERIFICAÇÃO (como admin, no SQL editor):
--   select count(*) from get_stock_guide_comps();           -- colunas novas presentes
--   select admin_bulk_upsert_stock_guide_companies('[]'::jsonb);  -- → 0 (array vazio ok)
-- Como anon: get_stock_guide_comps() devolve nome+ordem; financeiros NULL p/ ocultas.
-- =============================================================================
