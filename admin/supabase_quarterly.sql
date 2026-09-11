-- =============================================================================
-- CHEAT SHEET TRIMESTRAL — os números do resultado, empresa por empresa, direto da CVM.
--
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin), supabase_config_schema.sql
--         (dashboard_flags) e admin/supabase_market_watch.sql (mw_companies — a lista
--         das empresas da cobertura mora lá, e não se duplica aqui).
--
-- PADRÃO (o mesmo do Market Watch / Stock Guide / Calendário): RLS habilitado SEM policy
-- → ninguém lê a tabela direto; LEITURA por RPC SECURITY DEFINER (anon+authenticated,
-- hide-aware); ESCRITA só pelo robô `_shared/quarterly.py` com a SERVICE KEY.
--
-- FONTE: CVM Dados Abertos, formulários que as próprias companhias entregam.
--   ITR (1º/2º/3º trimestres)  https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/ITR/DADOS/
--   DFP (ano fechado)          https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/
--   ⚠️ O 4º trimestre não existe em lugar nenhum: é o ano inteiro menos os nove meses.
--
-- ⚠️ O QUE ESTES NÚMEROS SÃO: o resultado CONTÁBIL consolidado, do jeito que foi entregue
--    ao regulador. O EBITDA aqui é EBIT + depreciação/amortização/exaustão — NÃO é o
--    "EBITDA ajustado" que a companhia publica no release (a Vale, por exemplo, exclui
--    Brumadinho do ajustado). Volume vendido, preço realizado e custo caixa não estão na
--    demonstração financeira e por isso não estão aqui. A tela diz isso ao cliente.
--
-- Valores em MILHARES de reais (`scale='MIL'`), como a CVM publica.
--
-- DESFAZER TUDO:
--   drop function if exists public.get_quarterly_kpis();
--   drop table if exists public.quarterly_kpis;
--   delete from public.dashboard_flags where key = 'quarterly';
-- =============================================================================

create table if not exists public.quarterly_kpis (
  company      text not null,             -- ticker principal (= mw_companies.ticker)
  quarter      text not null,             -- '2026Q2'
  period_end   date not null,             -- 2026-06-30
  net_revenue  numeric,                   -- 3.01 receita líquida
  cogs         numeric,                   -- 3.02 custo dos bens/serviços (negativo)
  gross_profit numeric,                   -- 3.03 resultado bruto
  ebit         numeric,                   -- 3.05 resultado antes do financeiro e dos tributos
  d_a          numeric,                   -- depreciação + amortização + exaustão (fluxo de caixa)
  ebitda       numeric,                   -- ebit + d_a (contábil — ver o aviso acima)
  net_income   numeric,                   -- 3.11.01 lucro atribuído ao controlador
  ocf          numeric,                   -- 6.01 caixa líquido das atividades operacionais
  capex        numeric,                   -- saída de caixa p/ imobilizado+intangível (positivo)
  cash         numeric,                   -- 1.01.01 + 1.01.02
  debt         numeric,                   -- 2.01.04 + 2.02.01 (empréstimos e financiamentos)
  net_debt     numeric,                   -- debt − cash
  currency     text not null default 'BRL',
  scale        text not null default 'MIL',
  source       text not null default 'ITR',   -- ITR | DFP (o 4º trimestre vem do DFP)
  updated_at   timestamptz not null default now(),
  primary key (company, quarter)
);
alter table public.quarterly_kpis enable row level security;
create index if not exists quarterly_kpis_quarter_idx on public.quarterly_kpis (quarter);

-- `updated_at` de verdade: o upsert do robô é INSERT ... ON CONFLICT DO UPDATE, e o DEFAULT
-- só vale no INSERT — sem o gatilho a coluna congelaria na data do primeiro semeio.
create or replace function public._quarterly_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists quarterly_kpis_touch on public.quarterly_kpis;
create trigger quarterly_kpis_touch before insert or update on public.quarterly_kpis
  for each row execute function public._quarterly_touch();

-- ───────────── leitura (cliente) ─────────────
-- Junta com mw_companies p/ nome/setor/ordem e p/ respeitar o `is_visible` do admin —
-- mesma regra do Market Watch. Empresa escondida lá some daqui também.
drop function if exists public.get_quarterly_kpis();
create function public.get_quarterly_kpis()
returns table (
  company text, name text, sector text, display_order int,
  quarter text, period_end date,
  net_revenue numeric, cogs numeric, gross_profit numeric,
  ebit numeric, d_a numeric, ebitda numeric, net_income numeric,
  ocf numeric, capex numeric, cash numeric, debt numeric, net_debt numeric,
  currency text, scale text, source text, updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select q.company, c.name, c.sector, c.display_order,
         q.quarter, q.period_end,
         q.net_revenue, q.cogs, q.gross_profit,
         q.ebit, q.d_a, q.ebitda, q.net_income,
         q.ocf, q.capex, q.cash, q.debt, q.net_debt,
         q.currency, q.scale, q.source, q.updated_at
    from public.quarterly_kpis q
    join public.mw_companies c on c.ticker = q.company
   where c.is_visible
   order by c.display_order, q.quarter;
$$;
grant execute on function public.get_quarterly_kpis() to anon, authenticated;

-- ───────────── flag (nasce DESLIGADA: admin vê antes do cliente) ─────────────
insert into public.dashboard_flags (key, enabled) values ('quarterly', false)
on conflict (key) do nothing;
