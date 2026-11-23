-- ════════════════════════════════════════════════════════════════════════════
-- PREÇOS DE MERCADO DA MESA DE DADOS (M&M › Steel › Prices e Iron Ore › Prices & margin)
-- ────────────────────────────────────────────────────────────────────────────
-- Duas tabelas, as duas com dado PAGO de agência (Platts): só usuário LOGADO lê; só a chave de serviço grava.
-- Nada disto vai para o repositório do site (ele é público).
--
--  1. steel_parity — paridade de importação do aço (HRC e vergalhão): os INSUMOS de cada sexta-feira. A página refaz a
--     conta da planilha do analista:
--        CIF       = (FOB + frete) × (1 + seguro)
--        importado = CIF + CIF × tarifa + frete × AFRMM + porto          (US$/t, posto no Brasil)
--        prêmio    = (preço doméstico em R$/t ÷ câmbio) ÷ importado − 1
--     Histórico (2018 em diante) carregado da planilha; o robô _shared/update_steel_parity.py acrescenta a semana que fechou.
--
--  2. price_history — o PASSADO das séries diárias que o robô de preços guarda em commodities.daily (que só começou
--     em jun/2026). Carregado das bases da Platts do analista (minério desde 2008, aço desde 2010). A página emenda
--     este histórico com o commodities.daily (o robô manda nos dias em que os dois têm valor).
--
-- Rodar UMA vez no editor SQL do Supabase. Pode rodar de novo sem estragar nada (idempotente).
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1 · PARIDADE ───────────────────────────────────────────────────────────
create table if not exists public.steel_parity (
  product    text        not null check (product in ('hrc', 'rebar')),
  week       date        not null,                      -- a sexta-feira da semana
  fob        numeric     not null,                      -- US$/t FOB na origem (HRC China · vergalhão Turquia)
  freight    numeric     not null,                      -- frete marítimo, US$/t
  insurance  numeric     not null default 0.005,        -- seguro, fração de (FOB + frete)
  tariff     numeric     not null,                      -- imposto de importação, fração do CIF
  afrmm      numeric     not null,                      -- AFRMM, fração do frete
  port       numeric     not null,                      -- despesas portuárias, US$/t
  dom_brl    numeric,                                   -- preço doméstico, R$/t
  fx         numeric,                                   -- R$/US$
  source     text        not null default 'robot',      -- spreadsheet | robot | manual
  updated_at timestamptz not null default now(),
  primary key (product, week)
);

alter table public.steel_parity enable row level security;

drop policy if exists steel_parity_read on public.steel_parity;
create policy steel_parity_read on public.steel_parity
  for select to authenticated using (true);
-- sem policy de escrita: só a chave de serviço (robô e carga da planilha) grava.

-- A série inteira numa resposta só, compacta (a consulta direta da tabela pararia em 1.000 linhas):
-- { "hrc": [[semana, fob, frete, seguro, tarifa, afrmm, porto, doméstico, câmbio], …], "rebar": [...] }
create or replace function public.get_steel_parity()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_object_agg(product, linhas), '{}'::jsonb)
  from (
    select product,
           jsonb_agg(jsonb_build_array(week, fob, freight, insurance, tariff, afrmm, port, dom_brl, fx) order by week) as linhas
    from public.steel_parity
    group by product
  ) t;
$$;

revoke all on function public.get_steel_parity() from public, anon;
grant execute on function public.get_steel_parity() to authenticated, service_role;

-- ── 2 · HISTÓRICO DIÁRIO ───────────────────────────────────────────────────
create table if not exists public.price_history (
  code       text        not null,                      -- o mesmo código da tabela commodities (IRON_ORE, IOFBC00, HRC_CHINA…)
  day        date        not null,
  value      numeric     not null,                      -- na unidade da Platts (a mesma do commodities.daily)
  source     text        not null default 'platts_db',
  updated_at timestamptz not null default now(),
  primary key (code, day)
);

alter table public.price_history enable row level security;

drop policy if exists price_history_read on public.price_history;
create policy price_history_read on public.price_history
  for select to authenticated using (true);
-- sem policy de escrita: só a chave de serviço grava.

-- Só os códigos pedidos, num formato curto para pesar pouco na rede:
--   { "IRON_ORE": { "s": "2021-02-10", "d": [0, 1, 1, 3, …], "v": [178.35, 177.1, …] }, … }
--   s = o primeiro dia · d = dias desde o ponto anterior · v = os valores
-- (a página pede por GET: /rest/v1/rpc/get_price_history?p_codes={IRON_ORE,IOFBC00})
create or replace function public.get_price_history(p_codes text[])
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    ('{' || string_agg(format('%s:{"s":"%s","d":[%s],"v":[%s]}', to_json(code)::text, d0, dd, vv), ',') || '}')::json,
    '{}'::json)
  from (
    select code,
           min(day) as d0,
           string_agg(coalesce(day - prev_day, 0)::text, ',' order by day) as dd,
           string_agg(value::text, ',' order by day) as vv
    from (
      select code, day, value, lag(day) over (partition by code order by day) as prev_day
      from public.price_history
      where code = any (p_codes[1:40])
    ) t
    group by code
  ) x;
$$;

revoke all on function public.get_price_history(text[]) from public, anon;
grant execute on function public.get_price_history(text[]) to authenticated, service_role;
