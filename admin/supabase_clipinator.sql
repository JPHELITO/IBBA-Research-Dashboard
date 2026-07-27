-- =============================================================================
-- CLIPINATOR — geração do clipping diário (ÁREA EXCLUSIVA DO ADMIN)
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_admin_schema.sql (is_admin) + supabase_config_schema.sql (dashboard_flags).
-- Padrão (molde Executive Calendar): RLS habilitado SEM policy; acesso SÓ por RPC SECURITY DEFINER.
--   • Frontend (admin logado): RPCs guardadas por is_admin() (só authenticated).
--   • Backend (GitHub Actions): usa a SERVICE KEY, que IGNORA RLS → lê/atualiza a tabela direto
--     (não precisa de RPC). NENHUMA service key vai ao browser.
-- Esta área NUNCA é exposta ao cliente: a página exige is_admin() (a flag abaixo só controla o
-- link/menu; o portão de acesso é o admin, não a flag).
-- =============================================================================

-- ───────────── 1) TABELA DE JOBS (RLS on, SEM policy → acesso só pelas RPCs / service key) ─────────────
-- Um "job" = um pedido de clipping. O frontend enfileira (pending); o robô do Actions
-- reivindica (running), gera os arquivos, sobe no Storage e marca done/error.
create table if not exists public.clipping_jobs (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'pending',   -- pending | running | done | error
  ref_date      date not null default (now() at time zone 'America/Sao_Paulo')::date,
  -- payload = a seleção curada pelo admin: [{url,title,source_name,take,sector,pos}]
  --   take  ∈ '+','=','-'   ·   sector ∈ 'SM','PP','NR','CEMENT' (ou '' = auto-detect no motor)
  payload       jsonb not null default '[]'::jsonb,
  docx_path     text,                               -- caminho no Storage quando pronto
  eml_path      text,
  error         text,                               -- mensagem legível quando status='error'
  requested_by  uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  claimed_at    timestamptz,                        -- quando o robô reivindicou
  finished_at   timestamptz
);
alter table public.clipping_jobs enable row level security;
create index if not exists clipping_jobs_status_idx  on public.clipping_jobs (status);
create index if not exists clipping_jobs_created_idx on public.clipping_jobs (created_at desc);

-- ───────────── 2) FEATURE FLAG (nasce DESLIGADA; só controla o link no menu — acesso é por is_admin) ─────────────
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('clipinator', 'Clipinator (gerador de clipping — só admin)', 120, false)
on conflict (key) do nothing;

-- ───────────── 3) ENFILEIRAR (frontend admin → cria um job pending) ─────────────
-- p_payload: array JSON com a seleção curada. p_ref_date: data do clipping (default = hoje BRT).
create or replace function public.admin_enqueue_clipping(p_payload jsonb, p_ref_date date default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if jsonb_typeof(p_payload) is distinct from 'array' or jsonb_array_length(p_payload) = 0 then
      raise exception 'payload vazio ou inválido' using errcode='22023';
    end if;
    insert into public.clipping_jobs (status, ref_date, payload, requested_by)
    values ('pending',
            coalesce(p_ref_date, (now() at time zone 'America/Sao_Paulo')::date),
            p_payload, auth.uid())
    returning id into v_id;
    return v_id;
  end; $$;
revoke all on function public.admin_enqueue_clipping(jsonb, date) from public, anon;
grant execute on function public.admin_enqueue_clipping(jsonb, date) to authenticated;

-- ───────────── 4) LER JOBS (frontend admin → histórico + polling) ─────────────
create or replace function public.admin_get_clipping_jobs(p_limit int default 20)
  returns setof public.clipping_jobs
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.clipping_jobs
  where public.is_admin()
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 200));
$$;
revoke all on function public.admin_get_clipping_jobs(int) from public, anon;
grant execute on function public.admin_get_clipping_jobs(int) to authenticated;

-- um job específico (polling depois de "Gerar")
create or replace function public.admin_get_clipping_job(p_id uuid)
  returns setof public.clipping_jobs
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.clipping_jobs where public.is_admin() and id = p_id;
$$;
revoke all on function public.admin_get_clipping_job(uuid) from public, anon;
grant execute on function public.admin_get_clipping_job(uuid) to authenticated;

-- ───────────── 5) CANCELAR / LIMPAR (opcional — admin) ─────────────
create or replace function public.admin_delete_clipping_job(p_id uuid)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    delete from public.clipping_jobs where id = p_id;
  end; $$;
revoke all on function public.admin_delete_clipping_job(uuid) from public, anon;
grant execute on function public.admin_delete_clipping_job(uuid) to authenticated;

-- =============================================================================
-- (Fase 1 vai ADICIONAR aqui a RPC admin_get_clipping_candidates(p_hours) que lê
--  news_articles recentes com take_llm+sector — depois de confirmar o schema da tabela.)
--
-- FIM. Depois de rodar: a área já existe. A flag 'clipinator' pode ficar OFF —
-- o acesso é por is_admin(); a flag só controla a exibição do link no menu.
-- =============================================================================
