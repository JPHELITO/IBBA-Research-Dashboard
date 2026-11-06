-- =============================================================================
-- HISTÓRICO DE RECOMENDAÇÕES — regra "SÓ SE MUDAR" (decisão do usuário, 2026-11-06)
-- Rodar UMA vez no SQL Editor do Supabase, DEPOIS do supabase_market_ratings.sql. Idempotente.
--
-- O QUE MUDA, em português
-- Antes: cada upload do Stock Guide virava evento quando a data da E2 ("Last Model Update Release")
-- mudava — mesmo que a recomendação e o preço-alvo continuassem iguais (ex.: revisão de resultado).
-- Agora: o upload só grava evento quando a RECOMENDAÇÃO ou o PREÇO-ALVO forem diferentes do ÚLTIMO
-- evento do histórico daquela empresa. Mudar só a data não conta.
--
-- E duas travas para não desfazer o que foi corrigido à mão no /admin:
--   · Stock Guide com data ANTERIOR ao último evento do histórico não reescreve o passado;
--   · subir o mesmo arquivo de novo continua não gravando nada.
-- Só a função muda — a tabela, os dados já gravados e o gatilho (que chama esta função) ficam como estão.
-- =============================================================================
create or replace function public._sg_capture_rating() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_last public.stock_guide_rating_history%rowtype;
begin
  -- renomeou a empresa (botão "Renomear" do /admin, ou VALE3 → VALE no upload): o histórico acompanha
  if tg_op = 'UPDATE' and new.ticker is distinct from old.ticker then
    update public.stock_guide_rating_history h set ticker = new.ticker
     where h.ticker = old.ticker
       and not exists (select 1 from public.stock_guide_rating_history x
                        where x.ticker = new.ticker and x.effective_date = h.effective_date);
    delete from public.stock_guide_rating_history where ticker = old.ticker;
  end if;
  -- sem data ou sem recomendação não há evento (nunca inventar "hoje")
  if new.last_update is null or new.recommendation is null then return new; end if;
  -- regravou igual (o mesmo arquivo de novo): nada a registrar
  if tg_op = 'UPDATE'
     and new.ticker         is not distinct from old.ticker
     and new.last_update    is not distinct from old.last_update
     and new.recommendation is not distinct from old.recommendation
     and new.target_price   is not distinct from old.target_price then
    return new;
  end if;
  -- SÓ SE MUDAR: compara com o ÚLTIMO evento do histórico (que pode ter sido corrigido à mão no /admin)
  select * into v_last from public.stock_guide_rating_history h
   where h.ticker = new.ticker
   order by h.effective_date desc limit 1;
  if found then
    if v_last.rating is not distinct from new.recommendation
       and v_last.target_price is not distinct from new.target_price then
      return new;                                   -- mesma recomendação e mesmo alvo: só a data mudou
    end if;
    if new.last_update < v_last.effective_date then
      return new;                                   -- Stock Guide atrás do histórico: não reescreve o passado
    end if;
  end if;
  insert into public.stock_guide_rating_history as h
         (ticker, effective_date, rating, target_price, currency, listing, source, updated_by)
  values (new.ticker, new.last_update, new.recommendation, new.target_price,
          new.trade_ccy, new.yahoo_symbol, 'stock_guide', auth.uid())
  on conflict (ticker, effective_date) do update
     set rating       = excluded.rating,
         target_price = excluded.target_price,
         currency     = coalesce(excluded.currency, h.currency),
         listing      = coalesce(excluded.listing, h.listing),
         updated_at   = now(),
         updated_by   = excluded.updated_by;   -- a nota escrita à mão fica
  return new;
end $$;

-- conferência (opcional): deve listar a função com o texto "SÓ SE MUDAR"
--   select prosrc like '%SÓ SE MUDAR%' as regra_nova from pg_proc where proname = '_sg_capture_rating';
