-- =============================================================================
-- CALENDÁRIO: categoria própria para CONFERENCE CALL (2026-10-29)
-- Rodar UMA vez no SQL Editor do Supabase, numa consulta NOVA ("New query"). Idempotente.
--
-- Por quê: o analista cria DOIS eventos por empresa a cada trimestre — o resultado e a conference
-- call — e os dois caíam na mesma categoria "Earnings / Conf. Call". A Home passou a contar os
-- resultados da semana na etiqueta do cartão de eventos ("This week · 5 earnings") e a dar BMO/AMC
-- aos resultados com hora; com tudo na mesma categoria a call duplicava a contagem.
--
-- O que faz: (1) cria a categoria "Conference Call" (kind = conf_call) se ela não existir;
-- (2) move para ela os eventos da categoria de resultados cujo título diz "conference call",
-- "conf. call" ou "webcast". O robô da B3 continua gravando os RESULTADOS na categoria earnings
-- (ele a acha pelo kind). Daqui em diante, ao cadastrar uma call, escolher "Conference Call".
-- =============================================================================
insert into public.exec_calendar_categories (name, color, kind, sort_order, is_active)
select 'Conference Call', '#5B8DEF', 'conf_call', 15, true
 where not exists (select 1 from public.exec_calendar_categories where kind = 'conf_call');

update public.exec_calendar_events e
   set category_id = (select id from public.exec_calendar_categories where kind = 'conf_call' limit 1)
 where e.category_id in (select id from public.exec_calendar_categories where kind = 'earnings')
   and e.title ~* '(conference|conf\.?)\s*call|webcast';

-- conferir: quantos ficaram em cada categoria
select c.name, c.kind, count(e.id) as eventos
  from public.exec_calendar_categories c
  left join public.exec_calendar_events e on e.category_id = c.id
 where c.kind in ('earnings', 'conf_call')
 group by c.name, c.kind order by c.kind;
