-- =============================================================================
-- A4.3 (seguro) — CONFIG DO HEATMAP (esconder tickers + cobertura padrão)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin().
-- Frontend, fail-safe: a tabela começa VAZIA → heatmap mantém o comportamento atual.
--   is_hidden=true   → some do heatmap (universo + filtro + exibição).
--   in_coverage=true → entra na COBERTURA PADRÃO (o que aparece por default).
-- (Adicionar um ticker TOTALMENTE novo precisa do back-end buscar o preço — fase futura.)
-- =============================================================================

create table if not exists public.heatmap_tickers (
  symbol      text primary key,
  is_hidden   boolean not null default false,
  in_coverage boolean not null default false,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.heatmap_tickers enable row level security;

-- leitura pública: o cliente PRECISA das linhas (inclusive as escondidas) p/ aplicar
create or replace function public.get_heatmap_tickers()
  returns setof public.heatmap_tickers
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.heatmap_tickers order by sort_order, symbol;
$$;
revoke all on function public.get_heatmap_tickers() from public;
grant execute on function public.get_heatmap_tickers() to anon, authenticated;

-- escrita (só admin)
create or replace function public.admin_upsert_heatmap_ticker(
    p_symbol text, p_is_hidden boolean, p_in_coverage boolean, p_sort_order int)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    insert into public.heatmap_tickers (symbol, is_hidden, in_coverage, sort_order)
      values (upper(trim(p_symbol)), coalesce(p_is_hidden,false), coalesce(p_in_coverage,false), coalesce(p_sort_order,0))
    on conflict (symbol) do update set
      is_hidden=excluded.is_hidden, in_coverage=excluded.in_coverage,
      sort_order=excluded.sort_order, updated_at=now();
  end; $$;
revoke all on function public.admin_upsert_heatmap_ticker(text,boolean,boolean,int) from public, anon;
grant execute on function public.admin_upsert_heatmap_ticker(text,boolean,boolean,int) to authenticated;

create or replace function public.admin_delete_heatmap_ticker(p_symbol text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.heatmap_tickers where symbol = upper(trim(p_symbol));
  end; $$;
revoke all on function public.admin_delete_heatmap_ticker(text) from public, anon;
grant execute on function public.admin_delete_heatmap_ticker(text) to authenticated;
