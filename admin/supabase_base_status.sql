-- =============================================================================
-- A4 Fase B — STATUS POR BASE (como/quando cada base foi atualizada)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() + update_log
-- (criado no supabase_metrics.sql). Retorna a ÚLTIMA atualização de cada fonte.
-- =============================================================================

create or replace function public.get_base_status()
  returns table(source text, method text, detail text, last_update timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
  select distinct on (source) source, method, detail, created_at
  from public.update_log
  where public.is_admin()
  order by source, created_at desc;
$$;
revoke all on function public.get_base_status() from public, anon;
grant execute on function public.get_base_status() to authenticated;

-- A "última data do dado" de cada base é lida no navegador direto dos .db (já no painel).
-- O 'method' (manual/auto) vem do update_log: uploads do admin gravam 'manual'
-- (process_uploads.py); os robôs de cron podem gravar 'auto' depois (1 passo por workflow).
