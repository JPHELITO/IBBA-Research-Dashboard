-- =============================================================================
-- CLIPINATOR — AUTO-DISPARO SOB DEMANDA
-- Ao enfileirar um job (clicar "Gerar"), dispara o workflow generate_clipping.yml no GitHub.
-- Sem loop 24/7: o gerador só roda quando há um clique. Um AFTER INSERT em clipping_jobs
-- chama a API do GitHub (workflow_dispatch) via pg_net.
-- REQUER: supabase_clipinator.sql já rodado.  Rode ESTE arquivo DEPOIS de guardar o PAT (rodapé).
-- =============================================================================

create extension if not exists pg_net;

-- guarda o GitHub PAT fora do alcance do browser (RLS on, sem policy → só postgres / SECURITY DEFINER)
create table if not exists public.secure_config (key text primary key, value text not null);
alter table public.secure_config enable row level security;

create or replace function public._clipping_dispatch() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_pat text;
  begin
    select value into v_pat from public.secure_config where key = 'clipping_github_pat';
    if v_pat is null or v_pat = '' then
      return new;                       -- PAT ainda não configurado → não dispara (silencioso)
    end if;
    perform net.http_post(
      url := 'https://api.github.com/repos/JPHELITO/news-hunter/actions/workflows/generate_clipping.yml/dispatches',
      body := '{"ref":"master"}'::jsonb,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_pat,
        'Accept',        'application/vnd.github+json',
        'Content-Type',  'application/json',
        'User-Agent',    'supabase-clipinator'
      )
    );
    return new;
  end; $$;

drop trigger if exists clipping_jobs_dispatch on public.clipping_jobs;
create trigger clipping_jobs_dispatch
  after insert on public.clipping_jobs
  for each row execute function public._clipping_dispatch();

-- =============================================================================
-- SETUP (uma vez só):
--   1) Crie um GitHub PAT fine-grained (github.com → Settings → Developer settings →
--      Fine-grained tokens): Repository = JPHELITO/news-hunter, Permissions → Actions:
--      "Read and write".
--   2) Guarde o PAT (rode no SQL editor, trocando o valor):
--        insert into public.secure_config(key, value)
--        values ('clipping_github_pat', 'COLE_O_SEU_PAT_AQUI')
--        on conflict (key) do update set value = excluded.value;
--   3) Rode este arquivo. Pronto — clicar "Gerar" na dashboard dispara o gerador.
--
--   (Sem o PAT, o gerador ainda roda pelo cron diário de segurança, ou manualmente em
--    Actions → "Clipinator — gerar clipping" → Run workflow.)
-- =============================================================================
