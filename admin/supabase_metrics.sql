-- =============================================================================
-- A4 Fase 3 — MÉTRICAS (acessos + uso das IAs + log de atualizações)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin().
-- =============================================================================

-- ───────────── 1) ACESSOS ─────────────
create table if not exists public.page_visits (
  id bigserial primary key,
  path text,
  created_at timestamptz not null default now()
);
alter table public.page_visits enable row level security;
create index if not exists page_visits_created_idx on public.page_visits(created_at);

-- registra uma visita (a home chama no load; qualquer um pode INSERIR, ninguém lê direto)
create or replace function public.log_visit(p_path text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin insert into public.page_visits(path) values (left(coalesce(p_path,'/'),200)); end; $$;
revoke all on function public.log_visit(text) from public;
grant execute on function public.log_visit(text) to anon, authenticated;

-- estatísticas (só admin)
create or replace function public.get_visit_stats()
  returns table(today bigint, last7 bigint, last30 bigint, total bigint)
  language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) filter (where created_at >= date_trunc('day', now())),
         count(*) filter (where created_at >= now() - interval '7 days'),
         count(*) filter (where created_at >= now() - interval '30 days'),
         count(*)
  from public.page_visits where public.is_admin();
$$;
revoke all on function public.get_visit_stats() from public, anon;
grant execute on function public.get_visit_stats() to authenticated;

-- ───────────── 2) USO DAS IAs (news hunter) ─────────────
-- agrega news_articles por take_llm_model (provedor/modelo) + take_llm_at (quando classificou)
create or replace function public.get_ai_usage()
  returns table(model text, last24 bigint, last7 bigint, total bigint)
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(take_llm_model,'(desconhecido)'),
         count(*) filter (where take_llm_at >= now() - interval '24 hours'),
         count(*) filter (where take_llm_at >= now() - interval '7 days'),
         count(*)
  from public.news_articles
  where take_llm_model is not null and public.is_admin()
  group by take_llm_model order by count(*) desc;
$$;
revoke all on function public.get_ai_usage() from public, anon;
grant execute on function public.get_ai_usage() to authenticated;

-- ───────────── 3) LOG DE ATUALIZAÇÕES (manual × automático) ─────────────
create table if not exists public.update_log (
  id bigserial primary key,
  source     text,             -- ex.: 'linha preta', 'SECEX', 'IABr'
  method     text,             -- 'manual' (upload do admin) ou 'auto' (robô/cron)
  detail     text,
  created_at timestamptz not null default now()
);
alter table public.update_log enable row level security;

create or replace function public.get_update_log()
  returns setof public.update_log
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.update_log where public.is_admin() order by created_at desc limit 30;
$$;
revoke all on function public.get_update_log() from public, anon;
grant execute on function public.get_update_log() to authenticated;
-- Quem ESCREVE no update_log é server-side (process_uploads.py com a service key → 'manual';
-- os robôs de cron podem inserir 'auto' depois — um passo curtinho por workflow).
