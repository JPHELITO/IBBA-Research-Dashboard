-- =============================================================================
-- STOCK GUIDE — RENOMEAR TICKER (botão no /admin) + a troca da Aura (AURA33 → AUGO)
--
-- POR QUE ISSO EXISTE: no Stock Guide o ticker não é um rótulo — é a IDENTIDADE da
-- empresa (chave primária de stock_guide_companies, e o texto que amarra a empresa
-- ao mesh de cenários e às sensibilidades). O /admin sabia criar, editar, esconder e
-- excluir empresa, mas NÃO renomear — por isso trocar um ticker virava SQL na mão.
--
-- Esta rodada resolve as duas coisas de uma vez:
--   PARTE 1 — cria a RPC admin_rename_stock_guide_company() → o /admin ganha o botão
--             "Renomear" na lista de empresas. Da próxima vez, é clique, não SQL.
--   PARTE 2 — renomeia a Aura AURA33 → AUGO (o caso de hoje), uma única vez.
--
-- Idempotente (pode rodar de novo). Rodar no SQL Editor do Supabase, DEPOIS de
-- admin/supabase_stock_guide.sql. Não cria nem altera tabela: só uma função nova
-- e uma troca de valor.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE 1 — RPC de renomear (é o que o botão do /admin chama)
--
-- Troca o ticker nos 3 lugares que o carregam: a empresa, o mesh de cenários e as
-- sensibilidades (array `companies` + o JSON da definição + o título). No JSON só
-- troca quando o ticker é o VALOR INTEIRO entre aspas ("AURA33"), e no título só
-- quando é a PALAVRA inteira (\m…\M) — nunca pedaço de outra palavra.
-- Guardada por is_admin() (42501), como todas as escritas de admin.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_rename_stock_guide_company(p_from text, p_to text)
  returns text language plpgsql security definer set search_path = public, pg_temp as $$
  declare
    v_from text := nullif(trim(p_from), '');
    v_to   text := nullif(trim(p_to), '');
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    if v_from is null or v_to is null then
      raise exception 'ticker_required' using errcode='22023'; end if;
    -- só letras e números: o ticker entra em regex (\m…\M) e em chave JSON mais abaixo
    if v_from !~ '^[A-Za-z0-9]{1,12}$' or v_to !~ '^[A-Za-z0-9]{1,12}$' then
      raise exception 'invalid_ticker_format (só letras e números, até 12): % -> %', v_from, v_to
        using errcode='22023'; end if;
    if v_from = v_to then return v_to; end if;   -- nada a fazer (idempotente)
    if not exists (select 1 from public.stock_guide_companies where ticker = v_from) then
      raise exception 'company_not_found: %', v_from using errcode='22023'; end if;
    if exists (select 1 from public.stock_guide_companies where ticker = v_to) then
      raise exception 'ticker_already_exists: %', v_to using errcode='23505'; end if;

    update public.stock_guide_companies
       set ticker = v_to, updated_at = now(), updated_by = auth.uid()
     where ticker = v_from;

    update public.stock_guide_scenario_grid
       set ticker = v_to
     where ticker = v_from;

    update public.stock_guide_sensitivities
       set companies  = array_replace(companies, v_from, v_to),
           definition = replace(definition::text, '"' || v_from || '"', '"' || v_to || '"')::jsonb,
           title      = regexp_replace(title, '\m' || v_from || '\M', v_to, 'g'),
           updated_at = now(), updated_by = auth.uid()
     where v_from = any(companies)
        or definition::text like '%"' || v_from || '"%'
        or title like '%' || v_from || '%';

    return v_to;
  end; $$;
revoke all     on function public.admin_rename_stock_guide_company(text, text) from public;
revoke execute on function public.admin_rename_stock_guide_company(text, text) from anon;
grant  execute on function public.admin_rename_stock_guide_company(text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- PARTE 2 — a troca de hoje: Aura AURA33 → AUGO
--
-- AURA33 é o BDR (negocia em R$). O modelo lista preço/mkt cap na linha AUGO
-- (Nasdaq, US$) — que já era o yahoo_symbol e já é a moeda dos múltiplos. Só o
-- rótulo estava errado.
--
-- Feito com UPDATE direto, e NÃO chamando a RPC acima de propósito: no SQL Editor
-- não existe usuário logado (auth.uid() é nulo), então is_admin() daria false e a
-- RPC responderia "forbidden". A RPC é para o botão do /admin, onde há sessão.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

update public.stock_guide_companies
   set ticker = 'AUGO', updated_at = now()
 where ticker = 'AURA33'
   and not exists (select 1 from public.stock_guide_companies where ticker = 'AUGO');

-- se um upload novo do .xlsm já tiver criado a linha AUGO, some com a AURA33 duplicada
delete from public.stock_guide_companies
 where ticker = 'AURA33'
   and exists (select 1 from public.stock_guide_companies where ticker = 'AUGO');

update public.stock_guide_scenario_grid   set ticker = 'AUGO' where ticker = 'AURA33';

update public.stock_guide_sensitivities
   set companies  = array_replace(companies, 'AURA33', 'AUGO'),
       definition = replace(definition::text, '"AURA33"', '"AUGO"')::jsonb,
       title      = regexp_replace(title, '\mAURA33\M', 'AUGO', 'g'),
       updated_at = now()
 where 'AURA33' = any(companies)
    or definition::text like '%"AURA33"%'
    or title like '%AURA33%';

commit;

-- VERIFICAÇÃO (a 1ª tem que devolver AUGO | Aura | AUGO; as outras duas, zero):
--   select ticker, company_name, yahoo_symbol, trade_ccy, is_visible, display_order
--     from public.stock_guide_companies where ticker in ('AUGO','AURA33');
--   select count(*) from public.stock_guide_scenario_grid where ticker = 'AURA33';
--   select count(*) from public.stock_guide_sensitivities where 'AURA33' = any(companies);
-- =============================================================================
