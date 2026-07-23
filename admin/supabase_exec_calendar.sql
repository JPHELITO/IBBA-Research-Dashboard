-- =============================================================================
-- EXECUTIVE CALENDAR — eventos/categorias/janelas de dados (admin controla, cliente lê)
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin) + supabase_config_schema.sql (dashboard_flags).
-- Padrão (molde Stock Guide): RLS habilitado SEM policy; LEITURA via RPC SECURITY DEFINER
-- (anon+authenticated, hide-aware); ESCRITA via RPC SECURITY DEFINER guardada por is_admin()
-- (só authenticated). Nenhuma service key no browser.
-- =============================================================================

-- ───────────── 0) helper: troca strings vazias ("") por null (evita ''::date/::time/::int) ───
-- (cópia local do _sg_blanks_to_null p/ este arquivo ser auto-contido)
create or replace function public._cal_blanks_to_null(p jsonb)
  returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then null else coalesce(
    (select jsonb_object_agg(e.key,
       case when jsonb_typeof(e.value) = 'string' and (e.value #>> '{}') = '' then 'null'::jsonb
            else e.value end)
     from jsonb_each(p) e), '{}'::jsonb) end;
$$;

-- ───────────── 1) TABELAS (RLS on, SEM policy → acesso só pelas RPCs abaixo) ─────────────
create table if not exists public.exec_calendar_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text not null default '#FF5000',   -- hex
  kind        text,                               -- built-in estável: earnings|data_release|industry|ibba|company_public|holiday (custom = null)
  sort_order  int  not null default 0,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
alter table public.exec_calendar_categories enable row level security;

create table if not exists public.exec_calendar_events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category_id uuid references public.exec_calendar_categories(id) on delete set null,
  start_date  date not null,
  end_date    date,                               -- null = 1 dia; senão range/multi-dia
  all_day     boolean not null default true,
  start_time  time,                               -- null quando all_day
  end_time    time,
  company     text,                               -- ticker coberto (opcional)
  location    text,
  description text,
  links       jsonb not null default '[]'::jsonb, -- [{label,url}]
  recurrence  jsonb,                              -- null = único; senão {freq,interval,byweekday,bymonthday,bysetpos,until,count}
  is_visible  boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
alter table public.exec_calendar_events enable row level security;
create index if not exists exec_calendar_events_start_idx on public.exec_calendar_events (start_date);
create index if not exists exec_calendar_events_cat_idx   on public.exec_calendar_events (category_id);

create table if not exists public.exec_calendar_data_windows (
  id          uuid primary key default gen_random_uuid(),
  source_key  text unique not null,
  label       text not null,
  from_day    int  not null,                      -- dia-do-mês inicial da janela esperada
  to_day      int  not null,                      -- dia-do-mês final
  lag_months  int  not null default 1,            -- o dado é do mês (atual - lag)
  note        text,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);
alter table public.exec_calendar_data_windows enable row level security;

-- ───────────── 2) SEEDS ─────────────
-- Categorias built-in (só insere se a tabela estiver vazia — depois o admin manda)
insert into public.exec_calendar_categories (name, color, kind, sort_order)
select v.name, v.color, v.kind, v.sort_order from (values
  ('Earnings / Conf. Call', '#1565C0', 'earnings',       10),
  ('Data Release',          '#00838F', 'data_release',   20),
  ('Industry Event',        '#6A1B9A', 'industry',       30),
  ('IBBA Event',            '#FF5000', 'ibba',           40),
  ('Company Public Event',  '#2E7D32', 'company_public', 50),
  ('Bank Holiday',          '#C62828', 'holiday',        60)
) as v(name,color,kind,sort_order)
where not exists (select 1 from public.exec_calendar_categories);

-- Janelas de dados (transcrição do _shared/registry.py — editável no admin). idempotente por source_key.
insert into public.exec_calendar_data_windows (source_key, label, from_day, to_day, lag_months, note) values
  ('secex_steel', 'SECEX — Steel foreign trade',   1, 10, 1, 'MDIC/Comex Stat (~4º dia útil).'),
  ('secex_pulp',  'SECEX — Pulp (celulose)',       1, 12, 1, 'MDIC/Comex Stat.'),
  ('iabr',        'IABr — Brazil steel output',    8, 20, 1, 'Aço Brasil, 2ª/3ª semana.'),
  ('iba_paper',   'IBÁ — Paper',                   7, 13, 2, 'PDF imagem; lag ~2 meses.'),
  ('inda',        'INDA — Flat steel distribution',8, 15, 2, 'In Data; lag ~2 meses.'),
  ('empapel',     'Empapel — Corrugated (IBPO)',  12, 18, 1, 'Fastmarkets preliminar ~dia 15.'),
  ('gacc',        'GACC — China woodchips',       18, 31, 1, 'Alfândega China; sai ~fim do mês seguinte.'),
  ('pred_korea',  'Korea customs — steel to BR',  15, 31, 1, 'KITA; linha preta Coreia.')
on conflict (source_key) do nothing;

-- Feature flag (nasce DESLIGADA p/ rollout seguro; admin vê antes do cliente)
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('exec_calendar', 'Executive Calendar (nav + página + card na home)', 95, false)
on conflict (key) do nothing;

-- ───────────── 3) LEITURA (anon+authenticated; hide-aware) ─────────────
create or replace function public.get_exec_calendar_categories()
  returns setof public.exec_calendar_categories
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_categories order by sort_order, name;
$$;
revoke all on function public.get_exec_calendar_categories() from public;
grant execute on function public.get_exec_calendar_categories() to anon, authenticated;

-- eventos que intersectam [p_from,p_to] OU recorrentes (expandidos no cliente); ocultos só p/ admin
create or replace function public.get_exec_calendar_events(p_from date, p_to date)
  returns setof public.exec_calendar_events
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_events e
  where (e.is_visible or public.is_admin())
    and ( e.recurrence is not null
          or (e.start_date <= p_to and coalesce(e.end_date, e.start_date) >= p_from) )
  order by e.start_date, e.start_time nulls first;
$$;
revoke all on function public.get_exec_calendar_events(date, date) from public;
grant execute on function public.get_exec_calendar_events(date, date) to anon, authenticated;

create or replace function public.get_exec_calendar_data_windows()
  returns setof public.exec_calendar_data_windows
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_data_windows where is_active order by from_day, label;
$$;
revoke all on function public.get_exec_calendar_data_windows() from public;
grant execute on function public.get_exec_calendar_data_windows() to anon, authenticated;

-- ───────────── 4) LEITURA ADMIN (tudo, incl. ocultos/inativos — is_admin gate) ─────────────
create or replace function public.admin_get_exec_calendar_events()
  returns setof public.exec_calendar_events
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_events where public.is_admin()
  order by start_date desc, start_time nulls first;
$$;
revoke all on function public.admin_get_exec_calendar_events() from public, anon;
grant execute on function public.admin_get_exec_calendar_events() to authenticated;

create or replace function public.admin_get_exec_calendar_categories()
  returns setof public.exec_calendar_categories
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_categories where public.is_admin() order by sort_order, name;
$$;
revoke all on function public.admin_get_exec_calendar_categories() from public, anon;
grant execute on function public.admin_get_exec_calendar_categories() to authenticated;

create or replace function public.admin_get_exec_calendar_data_windows()
  returns setof public.exec_calendar_data_windows
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_data_windows where public.is_admin() order by from_day, label;
$$;
revoke all on function public.admin_get_exec_calendar_data_windows() from public, anon;
grant execute on function public.admin_get_exec_calendar_data_windows() to authenticated;

-- ───────────── 5) ESCRITA (só admin — is_admin() guard) ─────────────
-- categorias
create or replace function public.admin_upsert_exec_calendar_category(p_id uuid, p_data jsonb)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    p_data := public._cal_blanks_to_null(p_data);
    if p_id is null then
      insert into public.exec_calendar_categories (name, color, kind, sort_order, is_active, updated_by)
      values ( nullif(trim(p_data->>'name'),''),
               coalesce(nullif(trim(p_data->>'color'),''), '#FF5000'),
               nullif(trim(p_data->>'kind'),''),
               coalesce((p_data->>'sort_order')::int, 0),
               coalesce((p_data->>'is_active')::boolean, true), auth.uid() )
      returning id into v_id;
    else
      update public.exec_calendar_categories set
        name       = nullif(trim(p_data->>'name'),''),
        color      = coalesce(nullif(trim(p_data->>'color'),''), '#FF5000'),
        kind       = nullif(trim(p_data->>'kind'),''),
        sort_order = coalesce((p_data->>'sort_order')::int, 0),
        is_active  = coalesce((p_data->>'is_active')::boolean, true),
        updated_at = now(), updated_by = auth.uid()
      where id = p_id returning id into v_id;
    end if;
    return v_id;
  end; $$;
revoke all on function public.admin_upsert_exec_calendar_category(uuid, jsonb) from public, anon;
grant execute on function public.admin_upsert_exec_calendar_category(uuid, jsonb) to authenticated;

create or replace function public.admin_delete_exec_calendar_category(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.exec_calendar_categories where id = p_id;
  end; $$;
revoke all on function public.admin_delete_exec_calendar_category(uuid) from public, anon;
grant execute on function public.admin_delete_exec_calendar_category(uuid) to authenticated;

-- eventos
create or replace function public.admin_upsert_exec_calendar_event(p_id uuid, p_data jsonb)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare
    v_id     uuid;
    v_links  jsonb := case when jsonb_typeof(p_data->'links') = 'array' then p_data->'links' else '[]'::jsonb end;
    v_recur  jsonb := case when jsonb_typeof(p_data->'recurrence') = 'object' then p_data->'recurrence' else null end;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    p_data := public._cal_blanks_to_null(p_data);
    if p_id is null then
      insert into public.exec_calendar_events
        (title, category_id, start_date, end_date, all_day, start_time, end_time,
         company, location, description, links, recurrence, is_visible, updated_by)
      values (
        nullif(trim(p_data->>'title'),''),
        (p_data->>'category_id')::uuid,
        (p_data->>'start_date')::date,
        (p_data->>'end_date')::date,
        coalesce((p_data->>'all_day')::boolean, true),
        (p_data->>'start_time')::time,
        (p_data->>'end_time')::time,
        nullif(trim(p_data->>'company'),''),
        nullif(trim(p_data->>'location'),''),
        nullif(trim(p_data->>'description'),''),
        v_links, v_recur,
        coalesce((p_data->>'is_visible')::boolean, true), auth.uid() )
      returning id into v_id;
    else
      update public.exec_calendar_events set
        title       = nullif(trim(p_data->>'title'),''),
        category_id = (p_data->>'category_id')::uuid,
        start_date  = (p_data->>'start_date')::date,
        end_date    = (p_data->>'end_date')::date,
        all_day     = coalesce((p_data->>'all_day')::boolean, true),
        start_time  = (p_data->>'start_time')::time,
        end_time    = (p_data->>'end_time')::time,
        company     = nullif(trim(p_data->>'company'),''),
        location    = nullif(trim(p_data->>'location'),''),
        description = nullif(trim(p_data->>'description'),''),
        links       = v_links,
        recurrence  = v_recur,
        is_visible  = coalesce((p_data->>'is_visible')::boolean, true),
        updated_at  = now(), updated_by = auth.uid()
      where id = p_id returning id into v_id;
    end if;
    return v_id;
  end; $$;
revoke all on function public.admin_upsert_exec_calendar_event(uuid, jsonb) from public, anon;
grant execute on function public.admin_upsert_exec_calendar_event(uuid, jsonb) to authenticated;

create or replace function public.admin_delete_exec_calendar_event(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.exec_calendar_events where id = p_id;
  end; $$;
revoke all on function public.admin_delete_exec_calendar_event(uuid) from public, anon;
grant execute on function public.admin_delete_exec_calendar_event(uuid) to authenticated;

-- janelas de dados
create or replace function public.admin_upsert_exec_calendar_data_window(p_id uuid, p_data jsonb)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    p_data := public._cal_blanks_to_null(p_data);
    if p_id is null then
      insert into public.exec_calendar_data_windows
        (source_key, label, from_day, to_day, lag_months, note, is_active, updated_by)
      values (
        nullif(trim(p_data->>'source_key'),''),
        nullif(trim(p_data->>'label'),''),
        coalesce((p_data->>'from_day')::int, 1),
        coalesce((p_data->>'to_day')::int, 1),
        coalesce((p_data->>'lag_months')::int, 1),
        nullif(trim(p_data->>'note'),''),
        coalesce((p_data->>'is_active')::boolean, true), auth.uid() )
      returning id into v_id;
    else
      update public.exec_calendar_data_windows set
        source_key = nullif(trim(p_data->>'source_key'),''),
        label      = nullif(trim(p_data->>'label'),''),
        from_day   = coalesce((p_data->>'from_day')::int, 1),
        to_day     = coalesce((p_data->>'to_day')::int, 1),
        lag_months = coalesce((p_data->>'lag_months')::int, 1),
        note       = nullif(trim(p_data->>'note'),''),
        is_active  = coalesce((p_data->>'is_active')::boolean, true),
        updated_at = now(), updated_by = auth.uid()
      where id = p_id returning id into v_id;
    end if;
    return v_id;
  end; $$;
revoke all on function public.admin_upsert_exec_calendar_data_window(uuid, jsonb) from public, anon;
grant execute on function public.admin_upsert_exec_calendar_data_window(uuid, jsonb) to authenticated;

create or replace function public.admin_delete_exec_calendar_data_window(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.exec_calendar_data_windows where id = p_id;
  end; $$;
revoke all on function public.admin_delete_exec_calendar_data_window(uuid) from public, anon;
grant execute on function public.admin_delete_exec_calendar_data_window(uuid) to authenticated;

-- =============================================================================
-- FIM. Depois de rodar: ligue a flag em /admin (ou:
--   update public.dashboard_flags set enabled=true where key='exec_calendar';)
-- =============================================================================
