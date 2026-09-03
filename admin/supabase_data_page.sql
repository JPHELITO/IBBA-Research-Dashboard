-- =============================================================================
-- PÁGINA "DATA" (fontes + frescor + glossário) e "WHAT'S NEW" (novidades na home)
--
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin) + supabase_config_schema.sql (dashboard_flags).
-- Padrão: RLS on SEM policy; leitura via RPC SECURITY DEFINER (anon+authenticated); escrita
-- do robô com a SERVICE KEY (data_source_status) ou por RPC guardada por is_admin() (changelog).
--
-- Vem do raio-X do hub (2026-09-02): a dashboard de Oil & Gas publica uma tabela com QUANDO cada
-- fonte foi atualizada (inclusive as paradas) e a de Real Estate tem um glossário de 100
-- indicadores; a de Transportation tem uma caixa "Novidades" na home. Aqui é a nossa versão.
--
-- DESFAZER: drop function if exists public.get_data_source_status(), public.get_changelog(int),
--   public.admin_upsert_changelog(bigint,jsonb), public.admin_delete_changelog(bigint);
--   drop table if exists public.data_source_status, public.dashboard_changelog;
--   delete from public.dashboard_flags where key in ('data_page','whats_new');
-- =============================================================================

-- ───────────── 1) FRESCOR DAS FONTES (o robô _shared/status_digest.py --publish escreve) ─────
create table if not exists public.data_source_status (
  key             text primary key,           -- chave do _shared/registry.py
  label           text not null,              -- nome p/ o cliente (inglês)
  client_desc     text not null default '',   -- o que é / de onde vem
  client_cadence  text not null default '',   -- cadência esperada
  sector          text,                       -- steel | pulp | live
  cadence         text,                       -- monthly | live
  how_pulled      text,                       -- como o dado entra (texto do registro)
  auto            boolean not null default true,
  state           text not null default 'grey',   -- green | amber | red | grey
  status_text     text,                       -- "em dia (12d)" / "vivo (há 3 min)" …
  last_period     text,                       -- '2026-06' (mensal) ou '02/09 14:10 UTC' (vivo)
  next_expected   text,                       -- '2026-07' ou 'contínuo'
  checked_at      timestamptz,                -- quando o robô mediu
  updated_at      timestamptz not null default now()
);
alter table public.data_source_status enable row level security;

create or replace function public.get_data_source_status()
  returns setof public.data_source_status
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.data_source_status
  order by case sector when 'steel' then 1 when 'pulp' then 2 else 3 end, label;
$$;
revoke all on function public.get_data_source_status() from public;
grant execute on function public.get_data_source_status() to anon, authenticated;

-- ───────────── 2) NOVIDADES (What's new) — admin escreve, home mostra ─────────────
create table if not exists public.dashboard_changelog (
  id            bigserial primary key,
  published_on  date not null default current_date,
  title         text not null,
  body          text not null default '',
  link          text,                          -- ex.: '/market-watch.html'
  is_visible    boolean not null default true,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);
alter table public.dashboard_changelog enable row level security;

-- primeira novidade (só se a tabela estiver vazia)
insert into public.dashboard_changelog (published_on, title, body, link)
select current_date, 'Market Watch is live',
       'Securities lending (short interest), buyback programs, insider trading and official filings for the covered companies — public B3 and CVM data. Official filings now also appear in the news feed with a PRIMARY tag.',
       '/market-watch.html'
where not exists (select 1 from public.dashboard_changelog);

create or replace function public.get_changelog(p_limit int default 5)
  returns setof public.dashboard_changelog
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.dashboard_changelog
  where is_visible or public.is_admin()
  order by published_on desc, id desc
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;
revoke all on function public.get_changelog(int) from public;
grant execute on function public.get_changelog(int) to anon, authenticated;

create or replace function public.admin_upsert_changelog(p_id bigint, p_data jsonb)
  returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id bigint;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
    if p_id is null then
      insert into public.dashboard_changelog (published_on, title, body, link, is_visible, updated_by)
      values (coalesce((p_data->>'published_on')::date, current_date), p_data->>'title',
              coalesce(p_data->>'body',''), nullif(p_data->>'link',''), coalesce((p_data->>'is_visible')::boolean, true), auth.uid())
      returning id into v_id;
    else
      update public.dashboard_changelog set
        published_on = coalesce((p_data->>'published_on')::date, published_on),
        title        = coalesce(p_data->>'title', title),
        body         = coalesce(p_data->>'body', body),
        link         = nullif(p_data->>'link',''),
        is_visible   = coalesce((p_data->>'is_visible')::boolean, is_visible),
        updated_at   = now(), updated_by = auth.uid()
      where id = p_id;
      v_id := p_id;
    end if;
    return v_id;
  end; $$;
revoke all on function public.admin_upsert_changelog(bigint, jsonb) from public;
grant execute on function public.admin_upsert_changelog(bigint, jsonb) to authenticated;

create or replace function public.admin_delete_changelog(p_id bigint)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
    delete from public.dashboard_changelog where id = p_id;
  end; $$;
revoke all on function public.admin_delete_changelog(bigint) from public;
grant execute on function public.admin_delete_changelog(bigint) to authenticated;

-- ───────────── 3) FLAGS (nascem DESLIGADAS: admin vê antes do cliente) ─────────────
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('data_page', 'Página Data (fontes, frescor e glossário)', 98, false),
  ('whats_new', 'Home: faixa "What''s new" (novidades)',     99, false)
on conflict (key) do nothing;

-- VERIFICAÇÃO:
--   select key, state, last_period, checked_at from public.get_data_source_status();   -- vazio até o robô publicar
--   select id, published_on, title from public.get_changelog(5);
-- =============================================================================
