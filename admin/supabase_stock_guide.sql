-- =============================================================================
-- STOCK GUIDE — schema + RLS + RPCs  (porta a spec STOCK_GUIDE_AND_ADMIN_REPLICATION_PROMPT.md
-- §3/§4/§5, ADAPTADO à nossa stack: is_admin() existente (role 'admin'), SEM MFA;
-- universo Steel & Mining + Pulp & Paper; preço ao vivo vem da tabela `quotes`.)
--
-- Rodar no SQL Editor do Supabase. IDEMPOTENTE (re-rodável). Requer:
--   - public.is_admin()  (já existe em supabase_admin_schema.sql; role = 'admin')
--   - tabela profiles + auth.users (já existem)
--
-- INVARIANTES MANTIDOS (spec §10): RLS-on-sem-policy; toda leitura via SECURITY DEFINER
-- + SET search_path; admin via is_admin() (42501) + revoke anon; mesh paginado keyset
-- (cap 50k do PostgREST); NaN via = 'NaN'::numeric; coords 6 casas; net debt é mesh próprio.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. TABELAS  (todas RLS-ON, SEM policy → SELECT direto devolve 0 linhas p/ anon)
-- ─────────────────────────────────────────────────────────────────────────────

-- 3.1 empresas (PK ticker) — fundamentos PRICE-INDEPENDENT (BRL milhão, por ano). HIDE-AWARE.
CREATE TABLE IF NOT EXISTS public.stock_guide_companies (
  ticker              text PRIMARY KEY,
  company_name        text NOT NULL,
  yahoo_symbol        text NOT NULL,             -- chave da tabela `quotes` (ex.: 'VALE3.SA'). HIDE-AWARE.
  sector              text NOT NULL DEFAULT 'steel',   -- livre (steel/mining/pulp_paper/...)
  volume_unit         text NOT NULL DEFAULT 'kt',      -- livre (kt/Mt/...)
  shares_outstanding  numeric,                   -- contagem ABSOLUTA de ações; mktcap = shares × preço vivo
  last_update         date,
  target_price        numeric,
  recommendation      text CHECK (recommendation IN ('OP','MP','UP') OR recommendation IS NULL),
  net_debt_y1         numeric,  net_debt_y2       numeric,   -- net cash se negativo; EV(ano)=mktcap+net_debt(ano)
  ebitda_y1           numeric,  ebitda_y2         numeric,
  net_income_y1       numeric,  net_income_y2     numeric,   -- REPORTADO (numerador do P/E da linha normal)
  net_income_ex_y1    numeric,  net_income_ex_y2  numeric,   -- NI ajustado (só p/ o P/E da linha ex-tax-credit)
  npv_tax_credit_y1   numeric,  npv_tax_credit_y2 numeric,   -- NPV de créditos fiscais, por ano (opcional)
  fcfe_y1             numeric,  fcfe_y2           numeric,
  dividends_y1        numeric,  dividends_y2      numeric,
  volumes_y1          numeric,  volumes_y2        numeric,
  model_url           text,                      -- link do modelo Excel. HIDE-AWARE.
  is_visible          boolean NOT NULL DEFAULT true,   -- false → não-admin vê só o NOME, financeiros NULL
  display_order       int NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES auth.users(id)
);
ALTER TABLE public.stock_guide_companies ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS stock_guide_companies_order_idx
  ON public.stock_guide_companies (display_order, ticker);

-- 3.2 config singleton + global peers
CREATE TABLE IF NOT EXISTS public.stock_guide_config (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  y1_label          text NOT NULL DEFAULT '2026E',
  y2_label          text NOT NULL DEFAULT '2027E',
  assumptions_note  text NOT NULL DEFAULT '',
  comps_footnote    text NOT NULL DEFAULT '',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES auth.users(id)
);
ALTER TABLE public.stock_guide_config ENABLE ROW LEVEL SECURITY;
INSERT INTO public.stock_guide_config (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.stock_guide_global_peers (
  company        text PRIMARY KEY,
  pe_y1          numeric, pe_y2 numeric,
  ev_ebitda_y1   numeric, ev_ebitda_y2 numeric,
  div_yield_y1   numeric, div_yield_y2 numeric,         -- FRAÇÕES (0.0554 = 5.54%)
  is_aggregate   boolean NOT NULL DEFAULT false,
  is_live        boolean NOT NULL DEFAULT false,
  display_order  int     NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stock_guide_global_peers ENABLE ROW LEVEL SECURITY;

-- 3.3 drivers (registro macro/premissas). NÃO hide-aware.
CREATE TABLE IF NOT EXISTS public.stock_guide_drivers (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,
  unit           text NOT NULL DEFAULT '',
  current_value  numeric,                  -- valor "hoje" (estático) E âncora base-case do grid
  source         text,                     -- NULL/'' = ESTÁTICO; chave do catálogo = DINÂMICO (vivo)
  display_order  int NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES auth.users(id)
);
ALTER TABLE public.stock_guide_drivers ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS stock_guide_drivers_order_idx ON public.stock_guide_drivers (display_order, id);

-- 3.4 tabelas de sensibilidade (definition jsonb verbatim)
CREATE TABLE IF NOT EXISTS public.stock_guide_sensitivities (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title          text NOT NULL,
  value_mode     text NOT NULL DEFAULT 'absolute'
                   CHECK (value_mode IN ('absolute','yield','pe','ev_ebitda','upside')),
  metric_label   text NOT NULL DEFAULT '',
  unit           text NOT NULL DEFAULT '',
  companies      text[] NOT NULL DEFAULT '{}',
  definition     jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_order  int NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES auth.users(id),
  CONSTRAINT stock_guide_sensitivities_definition_is_object
    CHECK (jsonb_typeof(definition) = 'object')
);
ALTER TABLE public.stock_guide_sensitivities ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS stock_guide_sensitivities_order_idx ON public.stock_guide_sensitivities (display_order, id);

-- 3.5 mesh de interpolação (PK 6 colunas)
CREATE TABLE IF NOT EXISTS public.stock_guide_scenario_grid (
  sensitivity_id  bigint  NOT NULL
                    REFERENCES public.stock_guide_sensitivities(id) ON DELETE CASCADE,
  ticker          text    NOT NULL,
  metric          text    NOT NULL DEFAULT 'target_price',
  x_value         numeric NOT NULL,
  y_value         numeric NOT NULL DEFAULT 0,
  z_value         numeric NOT NULL DEFAULT 0,
  primary_value   numeric NOT NULL,
  CONSTRAINT stock_guide_scenario_grid_pkey
    PRIMARY KEY (sensitivity_id, ticker, metric, x_value, y_value, z_value)
);
ALTER TABLE public.stock_guide_scenario_grid ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- HELPERS internos da estratégia hide-aware das tabelas de sensibilidade (§6.2)
-- ─────────────────────────────────────────────────────────────────────────────

-- filtra uma matriz 2D jsonb [linha][coluna] mantendo só índices keep (NULL = mantém tudo)
CREATE OR REPLACE FUNCTION public._sg_filter_matrix(p_cells jsonb, p_keep_rows int[], p_keep_cols int[])
  RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(
           CASE WHEN p_keep_cols IS NULL THEN r.row_val
                ELSE (SELECT COALESCE(jsonb_agg(r.row_val->c ORDER BY c), '[]'::jsonb) FROM unnest(p_keep_cols) c) END
           ORDER BY r.rn), '[]'::jsonb)
  FROM (
    SELECT e.value AS row_val, e.ordinality AS rn
    FROM jsonb_array_elements(p_cells) WITH ORDINALITY e(value, ordinality)
    WHERE p_keep_rows IS NULL OR (e.ordinality - 1) = ANY(p_keep_rows)
  ) r;
$$;

-- remove tickers ocultos de uma tabela ESTÁTICA; devolve a definition filtrada, ou NULL = pular a tabela
CREATE OR REPLACE FUNCTION public._sg_strip_static(p_def jsonb, p_hidden text[])
  RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE
    def jsonb := p_def;
    row_is_co boolean := (p_def->'row_axis'->>'kind') = 'company';
    col_is_co boolean := (p_def->'col_axis'->>'kind') = 'company';
    row_co jsonb := COALESCE(p_def->'row_axis'->'companies','[]'::jsonb);
    col_co jsonb := COALESCE(p_def->'col_axis'->'companies','[]'::jsonb);
    keep_rows int[];
    keep_cols int[];
  BEGIN
    IF row_is_co THEN
      keep_rows := ARRAY(SELECT (ord-1)::int FROM jsonb_array_elements_text(row_co) WITH ORDINALITY e(t,ord)
                         WHERE NOT (e.t = ANY(p_hidden)));
      IF COALESCE(array_length(keep_rows,1),0) = 0 THEN RETURN NULL; END IF;
      def := jsonb_set(def, '{row_axis,companies}',
               (SELECT COALESCE(jsonb_agg(row_co->k ORDER BY k),'[]'::jsonb) FROM unnest(keep_rows) k));
    END IF;
    IF col_is_co THEN
      keep_cols := ARRAY(SELECT (ord-1)::int FROM jsonb_array_elements_text(col_co) WITH ORDINALITY e(t,ord)
                         WHERE NOT (e.t = ANY(p_hidden)));
      IF COALESCE(array_length(keep_cols,1),0) = 0 THEN RETURN NULL; END IF;
      def := jsonb_set(def, '{col_axis,companies}',
               (SELECT COALESCE(jsonb_agg(col_co->k ORDER BY k),'[]'::jsonb) FROM unnest(keep_cols) k));
    END IF;
    IF def ? 'cells' AND jsonb_typeof(def->'cells') = 'array' THEN
      def := jsonb_set(def, '{cells}', public._sg_filter_matrix(def->'cells', keep_rows, keep_cols));
    END IF;
    IF def ? 'cells_secondary' AND jsonb_typeof(def->'cells_secondary') = 'array' THEN
      def := jsonb_set(def, '{cells_secondary}', public._sg_filter_matrix(def->'cells_secondary', keep_rows, keep_cols));
    END IF;
    RETURN def;
  END; $$;

-- normaliza um jsonb: troca valores string VAZIOS ("") por null. Evita ''::numeric/::date/::int/::boolean
-- → erro 22P02 (campo limpo no form serializa como "" e estouraria o cast). Não-objeto passa intacto.
CREATE OR REPLACE FUNCTION public._sg_blanks_to_null(p jsonb)
  RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(p) <> 'object' THEN p ELSE
    COALESCE((SELECT jsonb_object_agg(e.key,
        CASE WHEN jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = '' THEN 'null'::jsonb ELSE e.value END)
      FROM jsonb_each(p) e), '{}'::jsonb) END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5.1 LEITURAS PÚBLICAS (SECURITY DEFINER + search_path + GRANT anon,authenticated)
-- ─────────────────────────────────────────────────────────────────────────────

-- comps hide-aware: nome/visibilidade/ordem em claro; TODO o resto via CASE (is_visible OR is_admin())
DROP FUNCTION IF EXISTS public.get_stock_guide_comps();
CREATE FUNCTION public.get_stock_guide_comps()
 RETURNS TABLE(ticker text, company_name text, is_visible boolean, display_order integer,
   sector text, volume_unit text, yahoo_symbol text, shares_outstanding numeric,
   net_debt_y1 numeric, net_debt_y2 numeric, last_update date, target_price numeric,
   recommendation text, ebitda_y1 numeric, ebitda_y2 numeric, net_income_y1 numeric, net_income_y2 numeric,
   net_income_ex_y1 numeric, net_income_ex_y2 numeric, npv_tax_credit_y1 numeric, npv_tax_credit_y2 numeric,
   fcfe_y1 numeric, fcfe_y2 numeric, dividends_y1 numeric, dividends_y2 numeric,
   volumes_y1 numeric, volumes_y2 numeric, model_url text)
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
    CASE WHEN (c.is_visible OR public.is_admin()) THEN c.model_url          ELSE NULL END
  FROM public.stock_guide_companies c ORDER BY c.display_order, c.ticker;
$$;
REVOKE ALL ON FUNCTION public.get_stock_guide_comps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_comps() TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_stock_guide_config();
CREATE FUNCTION public.get_stock_guide_config()
 RETURNS TABLE(y1_label text, y2_label text, assumptions_note text, comps_footnote text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ SELECT y1_label, y2_label, assumptions_note, comps_footnote FROM public.stock_guide_config WHERE id = 1; $$;
REVOKE ALL ON FUNCTION public.get_stock_guide_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_config() TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_stock_guide_drivers();
CREATE FUNCTION public.get_stock_guide_drivers()
 RETURNS TABLE(id bigint, name text, unit text, current_value numeric, source text, display_order integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ SELECT d.id, d.name, d.unit, d.current_value, d.source, d.display_order
      FROM public.stock_guide_drivers d ORDER BY d.display_order, d.id; $$;
REVOKE ALL ON FUNCTION public.get_stock_guide_drivers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_drivers() TO anon, authenticated;

-- tabelas de sensibilidade — hide-stripped server-side (§6.2)
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
      IF (r.definition ? 'grid') THEN
        -- grid: sem eixo de empresa exposto; o mesh RPC esconde os dados → passa direto
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

-- mesh: keyset-paginado, visible-tickers-only, is_admin() em InitPlan (sub-select) — §5.1
DROP FUNCTION IF EXISTS public.get_stock_guide_scenario_grid(bigint, integer, integer);
DROP FUNCTION IF EXISTS public.get_stock_guide_scenario_grid(bigint, integer, integer, text, text, numeric, numeric, numeric);
CREATE FUNCTION public.get_stock_guide_scenario_grid(
    p_sensitivity_id bigint,
    p_limit integer DEFAULT NULL,
    p_offset integer DEFAULT 0,
    p_after_ticker text DEFAULT NULL,
    p_after_metric text DEFAULT NULL,
    p_after_x numeric DEFAULT NULL,
    p_after_y numeric DEFAULT NULL,
    p_after_z numeric DEFAULT NULL)
  RETURNS TABLE(ticker text, metric text, x_value numeric, y_value numeric, z_value numeric, primary_value numeric)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT g.ticker, g.metric, g.x_value, g.y_value, g.z_value, g.primary_value
    FROM public.stock_guide_scenario_grid g
   WHERE g.sensitivity_id = p_sensitivity_id
     AND ( (SELECT public.is_admin())
        OR EXISTS (SELECT 1 FROM public.stock_guide_companies c
                    WHERE c.ticker = g.ticker AND c.is_visible) )
     AND ( p_after_ticker IS NULL
        OR (g.ticker, g.metric, g.x_value, g.y_value, g.z_value)
           > (p_after_ticker, p_after_metric, p_after_x, p_after_y, p_after_z) )
   ORDER BY g.ticker, g.metric, g.x_value, g.y_value, g.z_value
   LIMIT p_limit
   OFFSET CASE WHEN p_after_ticker IS NULL THEN COALESCE(p_offset, 0) ELSE 0 END;
$$;
REVOKE ALL ON FUNCTION public.get_stock_guide_scenario_grid(bigint, integer, integer, text, text, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_scenario_grid(bigint, integer, integer, text, text, numeric, numeric, numeric) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_stock_guide_global_peers();
CREATE FUNCTION public.get_stock_guide_global_peers()
 RETURNS TABLE(company text, pe_y1 numeric, pe_y2 numeric, ev_ebitda_y1 numeric, ev_ebitda_y2 numeric,
   div_yield_y1 numeric, div_yield_y2 numeric, is_aggregate boolean, is_live boolean, display_order integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ SELECT p.company, p.pe_y1, p.pe_y2, p.ev_ebitda_y1, p.ev_ebitda_y2, p.div_yield_y1, p.div_yield_y2,
             p.is_aggregate, p.is_live, p.display_order
      FROM public.stock_guide_global_peers p ORDER BY p.display_order, p.company; $$;
REVOKE ALL ON FUNCTION public.get_stock_guide_global_peers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_stock_guide_global_peers() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5.2 ADMIN (SECURITY DEFINER + search_path + is_admin() 42501 guard + GRANT authenticated)
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.admin_get_stock_guide_companies();
CREATE FUNCTION public.admin_get_stock_guide_companies()
 RETURNS SETOF public.stock_guide_companies
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT * FROM public.stock_guide_companies ORDER BY display_order, ticker;
END; $$;
REVOKE ALL ON FUNCTION public.admin_get_stock_guide_companies() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_stock_guide_companies() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_stock_guide_companies() TO authenticated;

-- upsert empresa: is_visible NUNCA vem de p_data (default true no insert, preservado no update)
CREATE OR REPLACE FUNCTION public.admin_upsert_stock_guide_company(p_ticker text, p_data jsonb)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_ticker text := nullif(trim(p_ticker), '');
          v_name text := nullif(trim(p_data->>'company_name'), '');
          v_ysym text := nullif(trim(p_data->>'yahoo_symbol'), '');
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    p_data := public._sg_blanks_to_null(p_data);
    IF v_ticker IS NULL THEN RAISE EXCEPTION 'ticker_required' USING ERRCODE='22023'; END IF;
    IF v_name   IS NULL THEN RAISE EXCEPTION 'company_name_required' USING ERRCODE='22023'; END IF;
    IF v_ysym   IS NULL THEN RAISE EXCEPTION 'yahoo_symbol_required' USING ERRCODE='22023'; END IF;
    INSERT INTO public.stock_guide_companies (
      ticker, company_name, yahoo_symbol, sector, volume_unit, shares_outstanding, last_update,
      target_price, recommendation, net_debt_y1, net_debt_y2, ebitda_y1, ebitda_y2,
      net_income_y1, net_income_y2, net_income_ex_y1, net_income_ex_y2, npv_tax_credit_y1, npv_tax_credit_y2,
      fcfe_y1, fcfe_y2, dividends_y1, dividends_y2, volumes_y1, volumes_y2, model_url, display_order,
      updated_at, updated_by)
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
      updated_at=now(), updated_by=auth.uid();
      -- is_visible PROPOSITALMENTE não tocado (preservado).
  END; $$;
REVOKE ALL ON FUNCTION public.admin_upsert_stock_guide_company(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_stock_guide_company(text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_stock_guide_company(text, jsonb) TO authenticated;

-- ÚNICO jeito de mudar is_visible
CREATE OR REPLACE FUNCTION public.admin_set_stock_guide_visibility(p_ticker text, p_is_visible boolean)
  RETURNS public.stock_guide_companies LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_row public.stock_guide_companies;
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    UPDATE public.stock_guide_companies SET is_visible = p_is_visible, updated_at = now(), updated_by = auth.uid()
      WHERE ticker = p_ticker RETURNING * INTO v_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'company_not_found: %', p_ticker USING ERRCODE='22023'; END IF;
    RETURN v_row;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_set_stock_guide_visibility(text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_set_stock_guide_visibility(text, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_stock_guide_visibility(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_stock_guide_company(p_ticker text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    DELETE FROM public.stock_guide_companies WHERE ticker = p_ticker;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_delete_stock_guide_company(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_stock_guide_company(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_stock_guide_company(text) TO authenticated;

-- config: comps_footnote = COALESCE(p, atual) → NULL preserva, '' limpa
CREATE OR REPLACE FUNCTION public.admin_upsert_stock_guide_config(
    p_y1 text, p_y2 text, p_note text, p_comps_footnote text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    UPDATE public.stock_guide_config SET
      y1_label = COALESCE(nullif(trim(p_y1),''), y1_label),
      y2_label = COALESCE(nullif(trim(p_y2),''), y2_label),
      assumptions_note = COALESCE(p_note, assumptions_note),
      comps_footnote = COALESCE(p_comps_footnote, comps_footnote),
      updated_at = now(), updated_by = auth.uid()
    WHERE id = 1;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_upsert_stock_guide_config(text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_stock_guide_config(text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_stock_guide_config(text, text, text, text) TO authenticated;

-- driver: p_id NULL → INSERT senão UPDATE; source ''→NULL (estático); current_value SEMPRE; retorna id
CREATE OR REPLACE FUNCTION public.admin_upsert_stock_guide_driver(p_id bigint, p_data jsonb)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_id bigint; v_name text := nullif(trim(p_data->>'name'), '');
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    p_data := public._sg_blanks_to_null(p_data);
    IF v_name IS NULL THEN RAISE EXCEPTION 'name_required' USING ERRCODE='22023'; END IF;
    IF p_id IS NULL THEN
      INSERT INTO public.stock_guide_drivers (name, unit, current_value, source, display_order, updated_at, updated_by)
      VALUES (v_name, COALESCE(p_data->>'unit',''), (p_data->>'current_value')::numeric,
              nullif(trim(p_data->>'source'),''), COALESCE((p_data->>'display_order')::int,0), now(), auth.uid())
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.stock_guide_drivers SET
        name=v_name, unit=COALESCE(p_data->>'unit',''), current_value=(p_data->>'current_value')::numeric,
        source=nullif(trim(p_data->>'source'),''), display_order=COALESCE((p_data->>'display_order')::int,0),
        updated_at=now(), updated_by=auth.uid()
      WHERE id=p_id RETURNING id INTO v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'driver_not_found: %', p_id USING ERRCODE='22023'; END IF;
    END IF;
    RETURN v_id;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_upsert_stock_guide_driver(bigint, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_stock_guide_driver(bigint, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_stock_guide_driver(bigint, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_stock_guide_driver(p_id bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    DELETE FROM public.stock_guide_drivers WHERE id = p_id;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_delete_stock_guide_driver(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_stock_guide_driver(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_stock_guide_driver(bigint) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_get_stock_guide_sensitivity_tables();
CREATE FUNCTION public.admin_get_stock_guide_sensitivity_tables()
 RETURNS SETOF public.stock_guide_sensitivities
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$ BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT * FROM public.stock_guide_sensitivities ORDER BY display_order, id;
END; $$;
REVOKE ALL ON FUNCTION public.admin_get_stock_guide_sensitivity_tables() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_get_stock_guide_sensitivity_tables() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_get_stock_guide_sensitivity_tables() TO authenticated;

-- upsert sensibilidade: definition guardado VERBATIM (objeto); companies json-array→text[]; retorna id
CREATE OR REPLACE FUNCTION public.admin_upsert_stock_guide_sensitivity_table(p_id bigint, p_data jsonb)
  RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_id bigint; v_title text := nullif(trim(p_data->>'title'), '');
          v_mode text := COALESCE(nullif(trim(p_data->>'value_mode'),''), 'absolute');
          v_def jsonb := COALESCE(p_data->'definition', '{}'::jsonb);
          v_companies text[];
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    p_data := public._sg_blanks_to_null(p_data);
    IF v_title IS NULL THEN RAISE EXCEPTION 'title_required' USING ERRCODE='22023'; END IF;
    IF v_mode NOT IN ('absolute','yield','pe','ev_ebitda','upside') THEN v_mode := 'absolute'; END IF;
    IF jsonb_typeof(v_def) <> 'object' THEN RAISE EXCEPTION 'definition_must_be_object' USING ERRCODE='22023'; END IF;
    v_companies := CASE WHEN jsonb_typeof(p_data->'companies') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(p_data->'companies')) ELSE '{}'::text[] END;
    IF p_id IS NULL THEN
      INSERT INTO public.stock_guide_sensitivities (title, value_mode, metric_label, unit, companies, definition, display_order, updated_at, updated_by)
      VALUES (v_title, v_mode, COALESCE(p_data->>'metric_label',''), COALESCE(p_data->>'unit',''),
              v_companies, v_def, COALESCE((p_data->>'display_order')::int,0), now(), auth.uid())
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.stock_guide_sensitivities SET
        title=v_title, value_mode=v_mode, metric_label=COALESCE(p_data->>'metric_label',''),
        unit=COALESCE(p_data->>'unit',''), companies=v_companies, definition=v_def,
        display_order=COALESCE((p_data->>'display_order')::int,0), updated_at=now(), updated_by=auth.uid()
      WHERE id=p_id RETURNING id INTO v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'sensitivity_not_found: %', p_id USING ERRCODE='22023'; END IF;
    END IF;
    RETURN v_id;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_upsert_stock_guide_sensitivity_table(bigint, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_stock_guide_sensitivity_table(bigint, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_stock_guide_sensitivity_table(bigint, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_stock_guide_sensitivity_table(p_id bigint)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    DELETE FROM public.stock_guide_sensitivities WHERE id = p_id;  -- mesh cai por FK CASCADE
  END; $$;
REVOKE ALL ON FUNCTION public.admin_delete_stock_guide_sensitivity_table(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_delete_stock_guide_sensitivity_table(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_stock_guide_sensitivity_table(bigint) TO authenticated;

-- replace-total do mesh, chunked, idempotente, NaN-safe (§5.2)
CREATE OR REPLACE FUNCTION public.admin_replace_stock_guide_scenario_grid(
  p_sensitivity_id bigint, p_rows jsonb, p_first_chunk boolean)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DECLARE v_count int := 0; v_elem jsonb; v_ticker text; v_metric text;
          v_x numeric; v_y numeric; v_z numeric; v_v numeric;
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_guide_sensitivities WHERE id = p_sensitivity_id) THEN
      RAISE EXCEPTION 'sensitivity_not_found: %', p_sensitivity_id USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'rows_must_be_array' USING ERRCODE='22023'; END IF;
    IF p_first_chunk THEN DELETE FROM public.stock_guide_scenario_grid WHERE sensitivity_id = p_sensitivity_id; END IF;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
      v_elem := public._sg_blanks_to_null(v_elem);
      v_ticker := NULLIF(trim(v_elem->>'ticker'), '');
      v_metric := NULLIF(trim(v_elem->>'metric'), '');
      IF v_ticker IS NULL THEN RAISE EXCEPTION 'ticker_required in row %', v_elem USING ERRCODE='22023'; END IF;
      IF v_metric IS NULL THEN RAISE EXCEPTION 'metric_required in row %', v_elem USING ERRCODE='22023'; END IF;
      v_x := (v_elem->>'x')::numeric; v_y := (v_elem->>'y')::numeric;
      v_z := (v_elem->>'z')::numeric; v_v := (v_elem->>'v')::numeric;
      IF v_x IS NULL OR v_y IS NULL OR v_z IS NULL OR v_v IS NULL THEN
        RAISE EXCEPTION 'numeric_field_required (x,y,z,v) in row %', v_elem USING ERRCODE='22023'; END IF;
      -- NaN: 'NaN'::numeric é válido em PG e NaN=NaN é TRUE → compara direto
      IF v_x = 'NaN'::numeric OR v_y = 'NaN'::numeric OR v_z = 'NaN'::numeric OR v_v = 'NaN'::numeric THEN
        RAISE EXCEPTION 'nan_not_allowed in row %', v_elem USING ERRCODE='22023'; END IF;
      INSERT INTO public.stock_guide_scenario_grid
        (sensitivity_id, ticker, metric, x_value, y_value, z_value, primary_value)
      VALUES (p_sensitivity_id, v_ticker, v_metric, v_x, v_y, v_z, v_v)
      ON CONFLICT (sensitivity_id, ticker, metric, x_value, y_value, z_value)
      DO UPDATE SET primary_value = EXCLUDED.primary_value;
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_replace_stock_guide_scenario_grid(bigint, jsonb, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_replace_stock_guide_scenario_grid(bigint, jsonb, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_stock_guide_scenario_grid(bigint, jsonb, boolean) TO authenticated;

DROP FUNCTION IF EXISTS public.admin_count_stock_guide_scenario_grid(bigint);
CREATE FUNCTION public.admin_count_stock_guide_scenario_grid(p_sensitivity_id bigint)
  RETURNS TABLE(total bigint, by_metric jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
    RETURN QUERY
    WITH counts AS (SELECT g.metric, count(*) AS n FROM public.stock_guide_scenario_grid g
                     WHERE g.sensitivity_id = p_sensitivity_id GROUP BY g.metric)
    SELECT COALESCE(sum(c.n),0)::bigint,
           COALESCE(jsonb_object_agg(c.metric, c.n) FILTER (WHERE c.metric IS NOT NULL), '{}'::jsonb)
    FROM counts c;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_count_stock_guide_scenario_grid(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_count_stock_guide_scenario_grid(bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_count_stock_guide_scenario_grid(bigint) TO authenticated;

-- replace-total global peers (DELETE all + INSERT each). NaN rejeitado.
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
        (company, pe_y1, pe_y2, ev_ebitda_y1, ev_ebitda_y2, div_yield_y1, div_yield_y2, is_aggregate, is_live, display_order, updated_at)
      VALUES (v_company, (v_elem->>'pe_y1')::numeric, (v_elem->>'pe_y2')::numeric,
        (v_elem->>'ev_ebitda_y1')::numeric, (v_elem->>'ev_ebitda_y2')::numeric,
        (v_elem->>'div_yield_y1')::numeric, (v_elem->>'div_yield_y2')::numeric,
        COALESCE((v_elem->>'is_aggregate')::boolean, false), COALESCE((v_elem->>'is_live')::boolean, false),
        COALESCE((v_elem->>'display_order')::int, v_count), now());
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END; $$;
REVOKE ALL ON FUNCTION public.admin_replace_stock_guide_global_peers(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.admin_replace_stock_guide_global_peers(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_replace_stock_guide_global_peers(jsonb) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED — 2-3 empresas de exemplo (1 OCULTA p/ testar hide-aware) + driver + sensibilidades
-- (NÚMEROS FICTÍCIOS — substitua pelos reais no admin.)
-- ─────────────────────────────────────────────────────────────────────────────

-- empresas visíveis (via upsert seria is_visible=true; aqui INSERT direto p/ controlar a oculta)
INSERT INTO public.stock_guide_companies
  (ticker, company_name, yahoo_symbol, sector, volume_unit, shares_outstanding, last_update, target_price,
   recommendation, net_debt_y1, net_debt_y2, ebitda_y1, ebitda_y2, net_income_y1, net_income_y2,
   fcfe_y1, fcfe_y2, dividends_y1, dividends_y2, volumes_y1, volumes_y2, is_visible, display_order)
VALUES
  ('VALE3','Vale','VALE3.SA','mining','Mt', 4500, '2026-06-23', 75, 'OP',
   45000, 40000, 90000, 95000, 50000, 55000, 40000, 45000, 30000, 32000, 320, 325, true, 1),
  ('SUZB3','Suzano','SUZB3.SA','pulp_paper','kt', 1300, '2026-06-23', 70, 'OP',
   60000, 55000, 25000, 27000, 8000, 9000, 6000, 7000, 1500, 1800, 11000, 11500, true, 2),
  ('GGBR4','Gerdau','GGBR4.SA','steel','kt', 2000, '2026-06-23', 22, 'MP',
   12000, 10000, 14000, 15000, 6000, 6500, 4000, 4500, 2000, 2200, 12000, 12500, true, 3)
ON CONFLICT (ticker) DO NOTHING;

-- empresa OCULTA (bypassa o upsert que força is_visible=true) — p/ verificar o hide-aware
INSERT INTO public.stock_guide_companies
  (ticker, company_name, yahoo_symbol, sector, volume_unit, shares_outstanding, target_price, recommendation,
   net_debt_y1, ebitda_y1, net_income_y1, fcfe_y1, dividends_y1, volumes_y1, is_visible, display_order)
VALUES
  ('CSNA3','CSN (exemplo OCULTO)','CSNA3.SA','steel','kt', 1300, 14, 'UP',
   35000, 9000, 1500, 1000, 500, 4500, false, 4)
ON CONFLICT (ticker) DO NOTHING;

-- driver de exemplo (estático: o analista digita; é a âncora base-case do grid)
INSERT INTO public.stock_guide_drivers (name, unit, current_value, source, display_order)
SELECT 'Iron ore 62% Fe (premissa 2026)', 'USD/t', 100, NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM public.stock_guide_drivers WHERE name = 'Iron ore 62% Fe (premissa 2026)');

-- sensibilidade de exemplo 1: matriz ESTÁTICA (target price por cenário de minério × empresa)
INSERT INTO public.stock_guide_sensitivities (title, value_mode, metric_label, unit, companies, definition, display_order)
SELECT 'Target price × minério (exemplo estático)', 'absolute', 'Target price', 'BRL/ação',
  ARRAY['VALE3','GGBR4'],
  jsonb_build_object(
    'panel','commodity', 'row_label','Target price',
    'row_axis', jsonb_build_object('kind','driver','driver_id',(SELECT id FROM public.stock_guide_drivers WHERE name='Iron ore 62% Fe (premissa 2026)' LIMIT 1),'scenarios', jsonb_build_array(80,100,120)),
    'col_axis', jsonb_build_object('kind','company','companies', jsonb_build_array('VALE3','GGBR4')),
    'cells', jsonb_build_array(jsonb_build_array(60,18), jsonb_build_array(75,22), jsonb_build_array(92,27)),
    'decimal_places', 1)
WHERE NOT EXISTS (SELECT 1 FROM public.stock_guide_sensitivities WHERE title = 'Target price × minério (exemplo estático)');

-- sensibilidade de exemplo 2: SCENARIO GRID 1-D (target_price → upside) p/ VALE3 + mesh de 3 pontos
INSERT INTO public.stock_guide_sensitivities (title, value_mode, metric_label, unit, companies, definition, display_order)
SELECT 'Upside × minério (exemplo interpolado)', 'upside', 'Upside', '%',
  ARRAY['VALE3'],
  jsonb_build_object(
    'panel','commodity',
    'grid', jsonb_build_object(
      'axes', jsonb_build_array(jsonb_build_object(
        'driver_id',(SELECT id FROM public.stock_guide_drivers WHERE name='Iron ore 62% Fe (premissa 2026)' LIMIT 1),
        'label','Iron ore 62% Fe','unit','USD/t','tmin',80,'tmax',120,'tstep',20)),
      'outputs', jsonb_build_array(jsonb_build_object('key','target_price','metric','target_price','mode','upside','label','Target price'))),
    'row_axis', jsonb_build_object('kind','company','companies', jsonb_build_array('VALE3')),
    'col_axis', jsonb_build_object('kind','year','years', jsonb_build_array('y1')))
WHERE NOT EXISTS (SELECT 1 FROM public.stock_guide_sensitivities WHERE title = 'Upside × minério (exemplo interpolado)');

-- mesh do exemplo 2: 3 nós (x=80→TP60, x=100→TP75, x=120→TP92) p/ VALE3
INSERT INTO public.stock_guide_scenario_grid (sensitivity_id, ticker, metric, x_value, y_value, z_value, primary_value)
SELECT s.id, 'VALE3', 'target_price', v.x, 0, 0, v.tp
FROM public.stock_guide_sensitivities s
CROSS JOIN (VALUES (80,60.0),(100,75.0),(120,92.0)) AS v(x,tp)
WHERE s.title = 'Upside × minério (exemplo interpolado)'
ON CONFLICT (sensitivity_id, ticker, metric, x_value, y_value, z_value) DO NOTHING;

-- global peers de exemplo
INSERT INTO public.stock_guide_global_peers (company, pe_y1, pe_y2, ev_ebitda_y1, ev_ebitda_y2, div_yield_y1, div_yield_y2, is_aggregate, is_live, display_order)
VALUES
  ('Rio Tinto', 9.5, 9.0, 5.2, 5.0, 0.062, 0.065, false, false, 1),
  ('BHP', 11.0, 10.5, 5.8, 5.5, 0.051, 0.054, false, false, 2),
  ('Majors Avg.', 10.2, 9.8, 5.5, 5.3, 0.056, 0.060, true, false, 3),
  ('Vale (live)', NULL, NULL, NULL, NULL, NULL, NULL, false, true, 4)
ON CONFLICT (company) DO NOTHING;

-- =============================================================================
-- VERIFICAÇÃO (rode como ANON no SQL editor / via REST sem login):
--   select * from get_stock_guide_comps();
--     → CSNA3 deve vir com company_name='CSN (exemplo OCULTO)' mas yahoo_symbol/financeiros TODOS NULL.
--     → VALE3/SUZB3/GGBR4 completos.
--   select * from get_stock_guide_scenario_grid(<id da sensibilidade 2>);
--     → 3 pontos p/ VALE3 (ticker visível). Se VALE3 fosse oculta, viriam 0.
-- Como ADMIN: todos os campos preenchidos, inclusive CSNA3.
-- =============================================================================
