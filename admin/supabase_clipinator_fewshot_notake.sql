-- ─────────────────────────────────────────────────────────────────────────────────────
-- CONSERTO (2026-08-07): o few-shot dinâmico nunca aprendia a fronteira "=" × "no take"
--
-- SINTOMA: a IA marcava uma manchete de mercado legítima como "no take" (ex.: "Turkish rebar
-- exports hold as buyers resist higher prices", que pela regra de NEUTRALIZADORES do prompt é
-- "="). O analista puxava a notícia para o clipping e atribuía o take certo — e o sistema
-- DESCARTAVA essa correção silenciosamente, todas as vezes.
--
-- RAIZ: o filtro abaixo, em admin_enqueue_clipping:
--     where e->>'take_ai' in ('+','-','=')            <-- "no take" caía fora
-- Ou seja: exatamente a correção MAIS valiosa que existe — "a IA descartou, mas o analista
-- viu valor" — era a única que nunca chegava à tabela take_corrections.
-- (O front JÁ enviava take_ai='no take' certinho; o motor JÁ sabia usar. Só o SQL barrava.)
--
-- CORREÇÃO: aceitar 'no take' na cláusula. A linha entra com take_ai='no take',
-- take_analyst='=' (ou +/-) e changed=true → vira exemplo few-shot de PRIORIDADE (o bucket de
-- "erros" vem antes do de reforços em hunter/llm_take.py::_load_corrections).
--
-- LACUNA CONHECIDA (não coberta aqui): o caminho inverso — a IA deu +/-/= e o analista NÃO
-- incluiu a notícia no clipping — continua sem ser registrado, porque o payload só carrega os
-- itens SELECIONADOS. Ensinar "isto era no take" exigiria mandar também os candidatos
-- rejeitados. Medido em 2026-08-06, esse sentido é o raro: dos 111 takes corrigidos, 53 eram
-- "no take" que deveriam ter take e só 4 o contrário.
--
-- Idempotente: é um CREATE OR REPLACE. Rodar no SQL Editor do Supabase.
-- ─────────────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_enqueue_clipping(p_payload jsonb, p_ref_date date default null, p_config jsonb default null)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if jsonb_typeof(p_payload) is distinct from 'array' or jsonb_array_length(p_payload) = 0 then
      raise exception 'payload vazio ou inválido' using errcode='22023';
    end if;
    insert into public.clipping_jobs (status, ref_date, payload, config, requested_by)
    values ('pending',
            coalesce(p_ref_date, (now() at time zone 'America/Sao_Paulo')::date),
            p_payload, p_config, auth.uid())
    returning id into v_id;

    -- Onda 5: correções de take (IA sugeriu vs. analista escolheu) → few-shot dinâmico.
    -- 2026-08-07: 'no take' ENTRA na lista. Quando a IA descarta e o analista resgata, essa é a
    -- correção mais informativa que o sistema pode receber. URL é a chave (re-gerar = upsert).
    insert into public.take_corrections (url, headline, source_name, sector, take_ai, take_analyst, changed)
    select e->>'url', left(coalesce(e->>'title',''), 400), e->>'source_name', e->>'sector',
           e->>'take_ai', e->>'take',
           (e->>'take_ai') is distinct from (e->>'take')
    from jsonb_array_elements(p_payload) e
    where e->>'take_ai' in ('+','-','=','no take') and coalesce(e->>'url','') <> ''
    on conflict (url) do update set
      headline = excluded.headline, source_name = excluded.source_name, sector = excluded.sector,
      take_ai = excluded.take_ai, take_analyst = excluded.take_analyst,
      changed = excluded.changed, created_at = now(), used_in_fewshot = false;

    return v_id;
  end; $$;

revoke all on function public.admin_enqueue_clipping(jsonb, date, jsonb) from public, anon;
grant execute on function public.admin_enqueue_clipping(jsonb, date, jsonb) to authenticated;
