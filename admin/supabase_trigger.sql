-- =============================================================================
-- A4 Fase 2 — DISPARO 1-CLIQUE (admin clica no painel → Supabase dispara a Action)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin().
-- Usa pg_net p/ chamar a API do GitHub (workflow_dispatch). O token do GitHub fica
-- guardado em private_config (RLS sem policy → só funções SECURITY DEFINER leem).
-- Você cola o token PELO PRÓPRIO PAINEL (aba Atualizar dados → Configuração).
-- =============================================================================

create extension if not exists pg_net;

create table if not exists public.private_config (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table public.private_config enable row level security;   -- sem policy: só definer lê/escreve

-- admin salva uma config (ex.: o token do GitHub)
create or replace function public.admin_set_config(p_key text, p_value text)
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    insert into public.private_config (key, value, updated_at) values (p_key, p_value, now())
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end; $$;
revoke all on function public.admin_set_config(text,text) from public, anon;
grant execute on function public.admin_set_config(text,text) to authenticated;

-- diz se uma chave está setada (sem revelar o valor)
create or replace function public.admin_config_isset(p_key text)
  returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_admin() and exists (select 1 from public.private_config where key = p_key and coalesce(value,'') <> '');
$$;
revoke all on function public.admin_config_isset(text) from public, anon;
grant execute on function public.admin_config_isset(text) to authenticated;

-- dispara a Action "Process Admin Uploads" no GitHub (workflow_dispatch via pg_net)
create or replace function public.admin_trigger_processing()
  returns text language plpgsql security definer set search_path = public, pg_temp as $$
  declare pat text;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    select value into pat from public.private_config where key = 'github_pat';
    if coalesce(pat,'') = '' then
      raise exception 'Token do GitHub nao configurado (aba Atualizar dados -> Configuracao do robo).';
    end if;
    perform net.http_post(
      url := 'https://api.github.com/repos/JPHELITO/IBBA-Research-Dashboard/actions/workflows/process_uploads.yml/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || pat,
        'Accept', 'application/vnd.github+json',
        'User-Agent', 'ibba-admin',
        'X-GitHub-Api-Version', '2022-11-28'),
      body := jsonb_build_object('ref', 'main')
    );
    return 'disparado';
  end; $$;
revoke all on function public.admin_trigger_processing() from public, anon;
grant execute on function public.admin_trigger_processing() to authenticated;
