-- =============================================================================
-- CLIPPING — BOTÕES "BUSCAR NOVAS AGORA" (dispara o run do news-hunter sob demanda)
--
-- ⚠️ VERSÃO 2 (2026-08-06) — CONSERTA "o botão não faz nada".
-- A v1 disparava hunt-loop.yml / hunt-playwright.yml, que são CORRENTES contínuas:
-- cada run ocupa o concurrency group por ~5h55min e não se cancela. O run nascido
-- do clique nascia PENDING atrás da corrente e era CANCELADO pelo cron seguinte
-- SEM EXECUTAR NENHUM JOB (comprovado na API do GitHub: run 31053028225 → 0 jobs).
-- Agora dispara **hunt-once.yml** (workflow one-shot, concurrency group PRÓPRIO),
-- que roda 1 ciclo e sai — não espera a corrente e não interfere nela.
--
--   p_which='rss'        → hunt-once.yml  inputs.mode=rss         (Valor, Mining.com, Portal Celulose…)
--   p_which='playwright' → hunt-once.yml  inputs.mode=playwright  (Platts + Fastmarkets + RSS)
--
-- Também passa a devolver o **id da requisição pg_net**, para o front confirmar
-- que o GitHub aceitou de verdade (204) via admin_check_hunt() — antes a RPC
-- devolvia 'disparado' mesmo se o GitHub recusasse (pg_net é assíncrono).
--
-- REQUER: supabase_clipinator_trigger.sql já rodado (cria secure_config + guarda o PAT).
-- Rodar no SQL Editor do Supabase. Idempotente (create-or-replace).
-- =============================================================================

create extension if not exists pg_net;

create or replace function public.admin_trigger_hunt(p_which text)
  returns text language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_pat text; v_mode text; v_req bigint;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;

    -- WHITELIST: só os 2 modos conhecidos (nunca input arbitrário no workflow)
    v_mode := case p_which
                when 'playwright' then 'playwright'   -- Platts + Fastmarkets (+ RSS)
                when 'rss'        then 'rss'          -- só as fontes abertas
                else null end;
    if v_mode is null then
      raise exception 'modo invalido (use "playwright" ou "rss")' using errcode='22023';
    end if;

    select value into v_pat from public.secure_config where key = 'clipping_github_pat';
    if coalesce(v_pat,'') = '' then
      raise exception 'Token do GitHub nao configurado (rode o setup do supabase_clipinator_trigger.sql).';
    end if;

    select net.http_post(
      url := 'https://api.github.com/repos/JPHELITO/news-hunter/actions/workflows/hunt-once.yml/dispatches',
      headers := jsonb_build_object(
        'Authorization',        'Bearer ' || v_pat,
        'Accept',               'application/vnd.github+json',
        'Content-Type',         'application/json',
        'User-Agent',           'ibba-clipping',
        'X-GitHub-Api-Version', '2022-11-28'),
      body := jsonb_build_object('ref', 'master', 'inputs', jsonb_build_object('mode', v_mode))
    ) into v_req;

    return v_req::text;   -- id da requisição → admin_check_hunt(id) diz se o GitHub aceitou
  end; $$;
revoke all on function public.admin_trigger_hunt(text) from public, anon;
grant execute on function public.admin_trigger_hunt(text) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- CONFERE O DISPARO: lê a resposta que o pg_net guardou (net._http_response).
-- pg_net é ASSÍNCRONO — o http_post só enfileira. Sem isto, um 404 (workflow
-- inexistente) ou 403 (PAT sem Actions:write) passava como sucesso na tela.
--   state='pendente'     → o worker do pg_net ainda não respondeu (chame de novo em 1-2s)
--   state='ok'           → GitHub aceitou (204 No Content) — o run foi criado
--   state='erro'         → veio status de erro; 'status'/'body' dizem qual
--   state='indisponivel' → não deu p/ ler a tabela de respostas (não é falha do disparo)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_check_hunt(p_id bigint)
  returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
  declare v jsonb;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if p_id is null then return jsonb_build_object('state','indisponivel'); end if;
    begin
      select jsonb_build_object(
               'state',  case when r.status_code between 200 and 299 then 'ok' else 'erro' end,
               'status', r.status_code,
               'error',  coalesce(r.error_msg, ''),
               'body',   left(coalesce(r.content, ''), 300))
        into v
        from net._http_response r
       where r.id = p_id;
    exception when others then
      return jsonb_build_object('state','indisponivel','error', SQLERRM);
    end;
    return coalesce(v, jsonb_build_object('state','pendente'));
  end; $$;
revoke all on function public.admin_check_hunt(bigint) from public, anon;
grant execute on function public.admin_check_hunt(bigint) to authenticated;

-- =============================================================================
-- Uso: os botões "↻ Platts + FM" / "↻ RSS" da aba Clipping chamam
--   rpc('admin_trigger_hunt', {p_which:'playwright'|'rss'})  → devolve o id
--   rpc('admin_check_hunt',   {p_id: <id>})                  → confirma o 204
-- O PAT é o MESMO do "Gerar" (secure_config.clipping_github_pat) — se o "Gerar
-- clipping" dispara, estes também disparam, sem token novo.
--
-- ⚠️ hunt-once.yml precisa existir no branch master do repo news-hunter (senão o
--    GitHub responde 404 e o admin_check_hunt mostra isso na tela).
-- =============================================================================
