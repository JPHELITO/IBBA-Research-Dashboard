-- =============================================================================
-- A4.1 — CAMADA DE CONFIGURAÇÃO DA DASHBOARD  (admin controla, cliente lê ao vivo)
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER a fundação do admin já aplicada (admin/supabase_admin_schema.sql — is_admin()).
-- Padrão (do prompt Stock Guide): RLS habilitado SEM policy; LEITURA via RPC
-- SECURITY DEFINER (anon+authenticated, hide-aware); ESCRITA via RPC SECURITY DEFINER
-- guardada por is_admin() (só authenticated).
-- =============================================================================

-- ───────────── 1) FEATURE FLAGS (liga/desliga abas, setores, painéis) ─────────────
create table if not exists public.dashboard_flags (
  key         text primary key,
  enabled     boolean not null default true,
  label       text,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.dashboard_flags enable row level security;

insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('sector_steel',  'Setor: Steel & Mining (card na home)',   10, true),
  ('sector_pp',     'Setor: Pulp & Paper (card na home)',      20, true),
  ('market',        'Aba: Market (terminal de ações)',         25, false),
  ('market_pulse',  'Painel: Market Pulse',                    30, true),
  ('commodities',   'Painel: Commodities (carrossel)',         40, true),
  ('news_feed',     'Painel: News Hunter (feed de notícias)',  50, true),
  ('research_team', 'Painel: Research Team (analistas)',       60, true),
  ('heatmap',       'Painel: Heatmap de cotações',             70, true),
  ('pred_model',    'Steel: Modelo Preditivo (aba Imports)',   80, true)
on conflict (key) do nothing;

-- ───────────── 2) TEAM / ANALISTAS ─────────────
create table if not exists public.team_members (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  role        text not null default 'Analyst',
  photo       text,           -- ex.: 'assets/team-joao.jpg' (caminho do repo) ou URL
  email       text,
  whatsapp    text,
  sort_order  int not null default 0,
  is_visible  boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.team_members enable row level security;

-- seed dos 4 analistas atuais (só se a tabela estiver VAZIA; e-mail/whats você completa pelo painel)
insert into public.team_members (name, role, photo, sort_order)
select v.name, v.role, v.photo, v.sort_order from (values
  ('Daniel Sasson',      'Head',    'assets/team-daniel.jpg',  10),
  ('Edgard Pinto Souza', 'Analyst', 'assets/team-edgard.jpg',  20),
  ('Marcelo Furlan',     'Analyst', 'assets/team-marcelo.jpg', 30),
  ('João Paulo Helito',  'Analyst', 'assets/team-joao.jpg',    40)
) as v(name,role,photo,sort_order)
where not exists (select 1 from public.team_members);

-- ───────────── 3) LEITURA (pública; team é hide-aware) ─────────────
create or replace function public.get_dashboard_flags()
  returns setof public.dashboard_flags
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.dashboard_flags order by sort_order, key;
$$;
revoke all on function public.get_dashboard_flags() from public;
grant execute on function public.get_dashboard_flags() to anon, authenticated;

create or replace function public.get_team()
  returns setof public.team_members
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.team_members
  where is_visible or public.is_admin()      -- cliente só vê visíveis; admin vê todos
  order by sort_order, name;
$$;
revoke all on function public.get_team() from public;
grant execute on function public.get_team() to anon, authenticated;

-- ───────────── 4) ESCRITA (só admin — is_admin() guard) ─────────────
create or replace function public.admin_set_flag(p_key text, p_enabled boolean)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    update public.dashboard_flags set enabled = p_enabled, updated_at = now() where key = p_key;
  end; $$;
revoke all on function public.admin_set_flag(text, boolean) from public, anon;
grant execute on function public.admin_set_flag(text, boolean) to authenticated;

create or replace function public.admin_upsert_team_member(
    p_id uuid, p_name text, p_role text, p_photo text, p_email text,
    p_whatsapp text, p_sort_order int, p_is_visible boolean)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if p_id is null then
      insert into public.team_members (name, role, photo, email, whatsapp, sort_order, is_visible)
        values (p_name, coalesce(p_role,'Analyst'), p_photo, p_email, p_whatsapp,
                coalesce(p_sort_order,0), coalesce(p_is_visible,true))
        returning id into v_id;
    else
      update public.team_members set
        name=p_name, role=coalesce(p_role,'Analyst'), photo=p_photo, email=p_email,
        whatsapp=p_whatsapp, sort_order=coalesce(p_sort_order,0),
        is_visible=coalesce(p_is_visible,true), updated_at=now()
      where id = p_id returning id into v_id;
    end if;
    return v_id;
  end; $$;
revoke all on function public.admin_upsert_team_member(uuid,text,text,text,text,text,int,boolean) from public, anon;
grant execute on function public.admin_upsert_team_member(uuid,text,text,text,text,text,int,boolean) to authenticated;

create or replace function public.admin_delete_team_member(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.team_members where id = p_id;
  end; $$;
revoke all on function public.admin_delete_team_member(uuid) from public, anon;
grant execute on function public.admin_delete_team_member(uuid) to authenticated;
