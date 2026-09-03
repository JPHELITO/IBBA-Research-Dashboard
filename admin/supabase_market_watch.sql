-- =============================================================================
-- MARKET WATCH — aluguel de ações (short interest), recompras, insiders, free float
-- e comunicados oficiais (B3/CVM) das empresas B3 da cobertura.
--
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin) + supabase_config_schema.sql (dashboard_flags).
--
-- PADRÃO (o mesmo do Stock Guide / Calendário): RLS habilitado SEM policy → ninguém lê
-- a tabela direto; LEITURA via RPC SECURITY DEFINER (anon+authenticated, hide-aware);
-- ESCRITA só pelo robô `_shared/market_watch.py` com a SERVICE KEY (ignora RLS).
-- Nenhuma service key no navegador.
--
-- FONTES (todas públicas e gratuitas — ver o robô p/ os endpoints exatos):
--   • B3 BDI (Boletim Diário) → "Empréstimos de ativos": posições em aberto e taxas
--   • CVM Dados Abertos → programas de recompra (diário), VLMO/insiders (mensal, semanal
--     na CVM), Formulário de Referência (capital social + distribuição/free float)
--   • B3 Plantão de Notícias → comunicados/fatos relevantes em tempo real (+ link CVM)
--
-- DESFAZER TUDO (não toca em nada de cotação, notícia ou clipping):
--   drop function if exists public.get_mw_companies(), public.get_mw_short_interest(text,date),
--     public.get_mw_short_latest(), public.get_mw_buybacks(text), public.get_mw_insiders(text,date),
--     public.get_mw_filings(text,int), public.get_mw_share_capital();
--   drop table if exists public.mw_filings, public.mw_insider_moves, public.mw_buyback_programs,
--     public.mw_share_capital, public.mw_short_interest, public.mw_companies;
--   delete from public.dashboard_flags where key = 'market_watch';
-- =============================================================================

-- ───────────── 1) EMPRESAS (mestre: ticker principal ↔ CNPJ ↔ código no Plantão da B3) ─────
create table if not exists public.mw_companies (
  ticker        text primary key,            -- papel principal da cobertura (ex.: 'GGBR4')
  name          text not null,
  cnpj          text not null,               -- '33.592.510/0001-54' (formato da CVM)
  cvm_code      text,                        -- Codigo_CVM (preenchido pelo robô a partir da CVM)
  b3_code       text not null,               -- prefixo do Plantão de Notícias: 'VALE', 'CSNA', 'KLBN'…
  share_class   text not null default 'ON',  -- ON | PN | PNA | UNT | BDR
  lending_tickers text[] not null default '{}', -- todos os códigos que a B3 lista no aluguel (ON/PN/UNT)
  yahoo_symbol  text,                        -- chave em public.quotes (ex.: 'VALE3.SA')
  sector        text not null default 'steel',
  is_visible    boolean not null default true,
  display_order int not null default 0,
  updated_at    timestamptz not null default now()
);
alter table public.mw_companies enable row level security;

insert into public.mw_companies (ticker, name, cnpj, b3_code, share_class, lending_tickers, yahoo_symbol, sector, display_order) values
  ('VALE3',  'Vale',                 '33.592.510/0001-54', 'VALE', 'ON',  '{VALE3}',               'VALE3.SA',  'iron_ore',   10),
  ('CMIN3',  'CSN Mineração',        '08.902.291/0001-15', 'CMIN', 'ON',  '{CMIN3}',               'CMIN3.SA',  'iron_ore',   20),
  ('BRAP4',  'Bradespar',            '03.847.461/0001-92', 'BRAP', 'PN',  '{BRAP3,BRAP4}',         'BRAP4.SA',  'iron_ore',   25),
  ('CSNA3',  'CSN',                  '33.042.730/0001-04', 'CSNA', 'ON',  '{CSNA3}',               'CSNA3.SA',  'steel',      30),
  ('GGBR4',  'Gerdau',               '33.611.500/0001-19', 'GGBR', 'PN',  '{GGBR3,GGBR4}',         'GGBR4.SA',  'steel',      40),
  ('GOAU4',  'Metalúrgica Gerdau',   '92.690.783/0001-09', 'GOAU', 'PN',  '{GOAU3,GOAU4}',         'GOAU4.SA',  'steel',      45),
  ('USIM5',  'Usiminas',             '60.894.730/0001-05', 'USIM', 'PNA', '{USIM3,USIM5,USIM6}',   'USIM5.SA',  'steel',      50),
  ('KLBN11', 'Klabin',               '89.637.490/0001-45', 'KLBN', 'UNT', '{KLBN3,KLBN4,KLBN11}',  'KLBN11.SA', 'pulp_paper', 60),
  ('SUZB3',  'Suzano',               '16.404.287/0001-55', 'SUZB', 'ON',  '{SUZB3}',               'SUZB3.SA',  'pulp_paper', 70),
  ('RANI3',  'Irani',                '92.791.243/0001-03', 'RANI', 'ON',  '{RANI3}',               'RANI3.SA',  'pulp_paper', 80),
  ('AURA33', 'Aura Minerals',        '07.857.093/0001-14', 'AURA', 'BDR', '{AURA33}',              'AURA33.SA', 'gold',       90)
on conflict (ticker) do nothing;

-- ───────────── 2) ALUGUEL DE AÇÕES — uma linha por papel × dia (B3 BDI) ─────────────
create table if not exists public.mw_short_interest (
  ticker          text not null,             -- código negociado (GGBR3 e GGBR4 são linhas distintas)
  company         text not null references public.mw_companies(ticker) on delete cascade,
  ref_date        date not null,
  qty_total       bigint,                    -- posição em aberto TOTAL (quantidade de ações doadas)
  value_brl       numeric,                   -- saldo em R$ (posições em aberto, Total)
  avg_price       numeric,                   -- preço médio implícito (valor ÷ quantidade)
  qty_registro    bigint,                    -- posição por modalidade (Registro / eletrônico D+0 / D+1)
  qty_d0          bigint,
  qty_d1          bigint,
  rate_taker_avg  numeric,                   -- taxa TOMADOR média ponderada do dia, % a.a. (o "custo do short")
  rate_taker_min  numeric,
  rate_taker_max  numeric,
  rate_donor_avg  numeric,                   -- taxa DOADOR média, % a.a.
  contracts_day   int,                       -- contratos registrados no dia
  qty_day         bigint,                    -- quantidade emprestada no dia
  value_day       numeric,                   -- volume do dia em R$
  source          text not null default 'bdi_api',   -- 'bdi_api' (últimos ~21 dias) | 'bdi_pdf' (histórico)
  updated_at      timestamptz not null default now(),
  primary key (ticker, ref_date)
);
alter table public.mw_short_interest enable row level security;
create index if not exists mw_short_interest_company_idx on public.mw_short_interest (company, ref_date);

-- ───────────── 3) CAPITAL SOCIAL + FREE FLOAT (CVM — Formulário de Referência) ─────────────
create table if not exists public.mw_share_capital (
  company         text primary key references public.mw_companies(ticker) on delete cascade,
  ref_date        date,                      -- Data_Referencia do FRE
  doc_version     int,
  shares_on       bigint,                    -- capital integralizado
  shares_pn       bigint,
  shares_total    bigint,
  float_on        bigint,                    -- ações em circulação (free float) por classe
  float_pn        bigint,
  float_total     bigint,
  pct_float_total numeric,                   -- % declarado no FRE
  float_by_class  jsonb not null default '{}'::jsonb,   -- {"PNA": 518248757, "PNB": 66261} quando há classes
  updated_at      timestamptz not null default now()
);
alter table public.mw_share_capital enable row level security;

-- ───────────── 4) PROGRAMAS DE RECOMPRA (CVM — dados abertos, diário) ─────────────
create table if not exists public.mw_buyback_programs (
  program_id    bigint primary key,          -- ID_Programa da CVM
  company       text not null references public.mw_companies(ticker) on delete cascade,
  company_name  text,
  decided_on    date,
  expires_on    date,
  status        text,                        -- 'Em Andamento' | 'Encerrado'
  operation     text,                        -- 'Compra' | 'Venda'
  reason        text,
  purpose       text,                        -- 'AS AÇÕES PODERÃO SER CANCELADAS.' etc.
  qty_on        bigint,                      -- quantidade autorizada por classe
  qty_pn        bigint,
  qty_circ_on   bigint,                      -- ações em circulação declaradas no programa
  qty_circ_pn   bigint,
  brokers       text[] not null default '{}',
  updated_at    timestamptz not null default now()
);
alter table public.mw_buyback_programs enable row level security;
create index if not exists mw_buyback_programs_company_idx on public.mw_buyback_programs (company, decided_on desc);

-- ───────────── 5) INSIDERS (CVM — art. 11 Res. 44, formulário consolidado mensal) ─────────────
create table if not exists public.mw_insider_moves (
  id            text primary key,            -- hash determinístico (empresa, mês, versão, linha)
  company       text not null references public.mw_companies(ticker) on delete cascade,
  ref_month     date not null,               -- 1º dia do mês de referência
  doc_version   int not null default 1,
  entity_type   text,                        -- Tipo_Empresa: Companhia | Controladora | Controlada
  entity        text,                        -- Empresa
  group_type    text,                        -- Tipo_Cargo: Controlador / Conselho / Diretor / Fiscal…
  move_type     text,                        -- Tipo_Movimentacao: Saldo Inicial, Compra à vista, Venda à vista…
  move_desc     text,
  operation     text,                        -- Crédito | Débito
  asset_type    text,                        -- Ações | Units | Debêntures | Outros…
  asset_class   text,                        -- ON | PN | KLBN11 | ADR…
  broker        text,
  move_date     date,                        -- null nos saldos
  qty           bigint,
  unit_price    numeric,
  volume        numeric,
  is_balance    boolean not null default false,   -- Saldo Inicial / Saldo Final
  updated_at    timestamptz not null default now()
);
alter table public.mw_insider_moves enable row level security;
create index if not exists mw_insider_moves_company_idx on public.mw_insider_moves (company, ref_month desc);

-- ───────────── 6) COMUNICADOS OFICIAIS (B3 Plantão de Notícias → documento na CVM) ─────────────
create table if not exists public.mw_filings (
  id            bigint primary key,          -- id da notícia no Plantão da B3
  company       text not null references public.mw_companies(ticker) on delete cascade,
  b3_code       text,
  headline      text not null,
  category      text,                        -- 'Fato Relevante', 'Outros Comunicados ao Mercado'…
  doc_date      date,
  published_at  timestamptz not null,
  flag          text,                        -- (R) reapresentação · (C) cancelado · (N) norma/nota
  cvm_url       text,                        -- link do documento na CVM (ENET)
  is_newsworthy boolean not null default false,
  doc_title     text,                        -- 1ª linha do documento (o "assunto" real, ex.: "Vale informa nova composição…")
  doc_excerpt   text,                        -- início do texto do documento (≤ 1.500 caracteres), p/ o feed e p/ a IA
  updated_at    timestamptz not null default now()
);
alter table public.mw_filings enable row level security;
-- (idempotente p/ quem já criou a tabela antes destas colunas)
alter table public.mw_filings add column if not exists doc_title text;
alter table public.mw_filings add column if not exists doc_excerpt text;
create index if not exists mw_filings_company_idx on public.mw_filings (company, published_at desc);
create index if not exists mw_filings_pub_idx on public.mw_filings (published_at desc);

-- ───────────── 7) FLAG (nasce DESLIGADA: admin vê, cliente não) ─────────────
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('market_watch', 'Market Watch (aluguel, recompras, insiders, comunicados)', 97, false)
on conflict (key) do nothing;

-- ───────────── 8) LEITURA (anon+authenticated; hide-aware: empresa oculta some p/ o cliente) ─────
create or replace function public.get_mw_companies()
  returns setof public.mw_companies
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.mw_companies
  where is_visible or public.is_admin()
  order by display_order, ticker;
$$;
revoke all on function public.get_mw_companies() from public;
grant execute on function public.get_mw_companies() to anon, authenticated;

create or replace function public.get_mw_short_interest(p_company text, p_from date default null)
  returns setof public.mw_short_interest
  language sql stable security definer set search_path = public, pg_temp as $$
  select s.* from public.mw_short_interest s
  join public.mw_companies c on c.ticker = s.company
  where (c.is_visible or public.is_admin())
    and (p_company is null or s.company = p_company)
    and (p_from is null or s.ref_date >= p_from)
  order by s.ref_date, s.ticker;
$$;
revoke all on function public.get_mw_short_interest(text, date) from public;
grant execute on function public.get_mw_short_interest(text, date) to anon, authenticated;

-- último dia disponível de cada papel + variação vs 1 mês (visão geral)
create or replace function public.get_mw_short_latest()
  returns table (ticker text, company text, ref_date date, qty_total bigint, value_brl numeric,
                 avg_price numeric, rate_taker_avg numeric, qty_1m bigint, rate_1m numeric, days int)
  language sql stable security definer set search_path = public, pg_temp as $$
  with last as (
    select distinct on (s.ticker) s.ticker, s.company, s.ref_date, s.qty_total, s.value_brl, s.avg_price, s.rate_taker_avg
    from public.mw_short_interest s
    join public.mw_companies c on c.ticker = s.company
    where c.is_visible or public.is_admin()
    order by s.ticker, s.ref_date desc
  ),
  m1 as (
    select distinct on (s.ticker) s.ticker, s.qty_total as qty_1m, s.rate_taker_avg as rate_1m
    from public.mw_short_interest s
    join last l on l.ticker = s.ticker
    where s.ref_date <= l.ref_date - interval '30 days'
    order by s.ticker, s.ref_date desc
  ),
  n as (select ticker, count(*)::int as days from public.mw_short_interest group by ticker)
  select l.ticker, l.company, l.ref_date, l.qty_total, l.value_brl, l.avg_price, l.rate_taker_avg,
         m1.qty_1m, m1.rate_1m, coalesce(n.days, 0)
  from last l left join m1 on m1.ticker = l.ticker left join n on n.ticker = l.ticker
  order by l.company, l.ticker;
$$;
revoke all on function public.get_mw_short_latest() from public;
grant execute on function public.get_mw_short_latest() to anon, authenticated;

create or replace function public.get_mw_share_capital()
  returns setof public.mw_share_capital
  language sql stable security definer set search_path = public, pg_temp as $$
  select k.* from public.mw_share_capital k
  join public.mw_companies c on c.ticker = k.company
  where c.is_visible or public.is_admin();
$$;
revoke all on function public.get_mw_share_capital() from public;
grant execute on function public.get_mw_share_capital() to anon, authenticated;

create or replace function public.get_mw_buybacks(p_company text default null)
  returns setof public.mw_buyback_programs
  language sql stable security definer set search_path = public, pg_temp as $$
  select b.* from public.mw_buyback_programs b
  join public.mw_companies c on c.ticker = b.company
  where (c.is_visible or public.is_admin())
    and (p_company is null or b.company = p_company)
  order by b.decided_on desc nulls last, b.program_id desc;
$$;
revoke all on function public.get_mw_buybacks(text) from public;
grant execute on function public.get_mw_buybacks(text) to anon, authenticated;

create or replace function public.get_mw_insiders(p_company text default null, p_from date default null)
  returns setof public.mw_insider_moves
  language sql stable security definer set search_path = public, pg_temp as $$
  select m.* from public.mw_insider_moves m
  join public.mw_companies c on c.ticker = m.company
  where (c.is_visible or public.is_admin())
    and (p_company is null or m.company = p_company)
    and (p_from is null or m.ref_month >= p_from)
  order by m.ref_month desc, m.move_date desc nulls last, m.group_type, m.id;
$$;
revoke all on function public.get_mw_insiders(text, date) from public;
grant execute on function public.get_mw_insiders(text, date) to anon, authenticated;

create or replace function public.get_mw_filings(p_company text default null, p_limit int default 200)
  returns setof public.mw_filings
  language sql stable security definer set search_path = public, pg_temp as $$
  select f.* from public.mw_filings f
  join public.mw_companies c on c.ticker = f.company
  where (c.is_visible or public.is_admin())
    and (p_company is null or f.company = p_company)
  order by f.published_at desc
  limit greatest(1, least(coalesce(p_limit, 200), 2000));
$$;
revoke all on function public.get_mw_filings(text, int) from public;
grant execute on function public.get_mw_filings(text, int) to anon, authenticated;

-- ───────────── 9) ADMIN: esconder/mostrar uma empresa no Market Watch ─────────────
create or replace function public.admin_set_mw_company_visible(p_ticker text, p_visible boolean)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
    update public.mw_companies set is_visible = p_visible, updated_at = now() where ticker = p_ticker;
  end; $$;
revoke all on function public.admin_set_mw_company_visible(text, boolean) from public;
grant execute on function public.admin_set_mw_company_visible(text, boolean) to authenticated;

-- VERIFICAÇÃO:
--   select count(*) from public.get_mw_companies();          -- 11
--   select * from public.get_mw_short_latest();               -- vazio até o robô rodar
--   select key, enabled from public.dashboard_flags where key = 'market_watch';
-- =============================================================================
