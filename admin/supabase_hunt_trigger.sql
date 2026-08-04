-- =============================================================================
-- CLIPPING — BOTÕES "ATUALIZAR AGORA" (dispara o run do news-hunter sob demanda)
-- Os 2 botões da aba Clipping chamam admin_trigger_hunt(p_which) → dispara o workflow
-- do GitHub (workflow_dispatch) via pg_net, reusando o MESMO PAT do clipping
-- (secure_config.clipping_github_pat, que já tem Actions: Read and write no news-hunter).
--   p_which='playwright' → hunt-playwright.yml  (Platts + Fastmarkets)
--   p_which='rss'        → hunt-loop.yml         (Valor, Mining.com, Portal Celulose…)
-- Espelha admin/supabase_trigger.sql::admin_trigger_processing.
-- REQUER: supabase_clipinator_trigger.sql já rodado (cria secure_config + guarda o PAT).
-- Rodar no SQL Editor do Supabase. Idempotente (create-or-replace).
-- =============================================================================

create extension if not exists pg_net;

create or replace function public.admin_trigger_hunt(p_which text)
  returns text language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_pat text; v_wf text;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;

    -- WHITELIST: só os 2 workflows do news-hunter (nunca dispatch arbitrário)
    v_wf := case p_which
              when 'playwright' then 'hunt-playwright.yml'   -- Platts + Fastmarkets
              when 'rss'        then 'hunt-loop.yml'          -- fontes RSS
              else null end;
    if v_wf is null then
      raise exception 'workflow invalido (use "playwright" ou "rss")' using errcode='22023';
    end if;

    select value into v_pat from public.secure_config where key = 'clipping_github_pat';
    if coalesce(v_pat,'') = '' then
      raise exception 'Token do GitHub nao configurado (rode o setup do supabase_clipinator_trigger.sql).';
    end if;

    perform net.http_post(
      url := 'https://api.github.com/repos/JPHELITO/news-hunter/actions/workflows/' || v_wf || '/dispatches',
      headers := jsonb_build_object(
        'Authorization',        'Bearer ' || v_pat,
        'Accept',               'application/vnd.github+json',
        'Content-Type',         'application/json',
        'User-Agent',           'ibba-clipping',
        'X-GitHub-Api-Version', '2022-11-28'),
      body := '{"ref":"master"}'::jsonb
    );
    return 'disparado';
  end; $$;
revoke all on function public.admin_trigger_hunt(text) from public, anon;
grant execute on function public.admin_trigger_hunt(text) to authenticated;

-- =============================================================================
-- Uso: os botões "Atualizar Platts + FM" / "Atualizar RSS" na aba Clipping chamam
-- rpc('admin_trigger_hunt', {p_which:'playwright'|'rss'}). O PAT é o MESMO do "Gerar"
-- (secure_config.clipping_github_pat) — se o "Gerar clipping" já dispara, estes botões
-- também disparam, sem token novo. Ambos os workflows têm workflow_dispatch + actions:write.
-- =============================================================================
