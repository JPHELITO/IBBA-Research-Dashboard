-- =============================================================================
-- A4.4 — CONFIG DOS GRUPOS DE COMMODITIES (carrossel da home; admin controla)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() (admin schema).
-- Mesmo padrão: RLS sem policy; leitura via RPC (hide-aware); escrita via is_admin().
-- =============================================================================

create table if not exists public.commodity_groups (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  codes       jsonb not null default '[]'::jsonb,   -- ordem dos códigos (ex.: ["IRON_ORE","IOPRM00",...])
  sort_order  int not null default 0,
  is_visible  boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.commodity_groups enable row level security;

-- seed dos 5 grupos atuais (só se vazia)
insert into public.commodity_groups (title, codes, sort_order)
select v.title, v.codes::jsonb, v.sort_order from (values
  ('Iron Ore + Pellet',  '["IRON_ORE","IOPRM00","IODFE00","IOMGD00","IOBFC04"]', 10),
  ('Brand assessments',  '["IOPBQ00","IOBBA00","IONHA00","IOMAA00","IOJBA00"]', 20),
  ('Freight + HCC',      '["IOFBC00","IOFAC00","MET_COAL","HCCAU00"]',           30),
  ('Forward Curve',      '["TSIPQ01","TSIPQ02","TSIPQ03","TSIPY01"]',            40),
  ('Steel + Other Ores', '["HRC_CHINA","REBAR_TURKEY","COPPER","GOLD"]',         50)
) as v(title, codes, sort_order)
where not exists (select 1 from public.commodity_groups);

-- leitura (hide-aware: cliente só vê visíveis; admin vê todos)
create or replace function public.get_commodity_groups()
  returns setof public.commodity_groups
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.commodity_groups where is_visible or public.is_admin() order by sort_order, title;
$$;
revoke all on function public.get_commodity_groups() from public;
grant execute on function public.get_commodity_groups() to anon, authenticated;

-- escrita (só admin)
create or replace function public.admin_upsert_commodity_group(
    p_id uuid, p_title text, p_codes jsonb, p_sort_order int, p_is_visible boolean)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if p_id is null then
      insert into public.commodity_groups (title, codes, sort_order, is_visible)
        values (p_title, coalesce(p_codes,'[]'::jsonb), coalesce(p_sort_order,0), coalesce(p_is_visible,true))
        returning id into v_id;
    else
      update public.commodity_groups set title=p_title, codes=coalesce(p_codes,'[]'::jsonb),
        sort_order=coalesce(p_sort_order,0), is_visible=coalesce(p_is_visible,true), updated_at=now()
      where id=p_id returning id into v_id;
    end if;
    return v_id;
  end; $$;
revoke all on function public.admin_upsert_commodity_group(uuid,text,jsonb,int,boolean) from public, anon;
grant execute on function public.admin_upsert_commodity_group(uuid,text,jsonb,int,boolean) to authenticated;

create or replace function public.admin_delete_commodity_group(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.commodity_groups where id=p_id;
  end; $$;
revoke all on function public.admin_delete_commodity_group(uuid) from public, anon;
grant execute on function public.admin_delete_commodity_group(uuid) to authenticated;
