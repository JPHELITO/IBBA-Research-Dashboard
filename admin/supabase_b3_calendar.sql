-- =============================================================================
-- CRONOGRAMA B3 → EXECUTIVE CALENDAR (+ calendário .ics para o Outlook)
-- Rodar no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- REQUER: admin/supabase_exec_calendar.sql (tabelas do calendário) já rodado
--         + admin/supabase_clipinator_trigger.sql (cria a tabela secure_config).
--
-- O QUE ISTO FAZ, em português:
--   1) marca de onde veio cada evento (nada = você criou à mão; 'b3' = o robô importou);
--   2) impede o robô de duplicar o mesmo earnings toda vez que rodar;
--   3) mantém um contador que faz o Outlook ACEITAR mudança de data (item 2 abaixo);
--   4) cria a pasta pública onde o arquivo do calendário do Outlook vai morar;
--   5) sorteia UMA vez o código secreto que vai no endereço desse arquivo.
--
-- O robô escreve com a service key (que ignora RLS), igual a todos os outros
-- ingestores do projeto — as RPCs admin_* exigem um usuário logado e recusariam.
--
-- DESFAZER TUDO o que o robô criou (a curadoria manual fica intacta):
--   delete from public.exec_calendar_events where source = 'b3';
-- =============================================================================

-- ───────────── 1) ORIGEM DO EVENTO + CONTADOR DO OUTLOOK ─────────────────────
-- exec_calendar_events só tinha o id uuid como chave. Sem uma chave "natural" o
-- robô não consegue dizer "este earnings eu já criei" → duplicaria a cada run.
alter table public.exec_calendar_events
  add column if not exists source      text,
  add column if not exists external_id text,
  add column if not exists ics_seq     int not null default 0;

comment on column public.exec_calendar_events.source is
  'null = criado à mão no admin; ''b3'' = importado do cronograma de eventos corporativos da B3';
comment on column public.exec_calendar_events.external_id is
  'chave natural na origem. Formato B3: b3:<ticker>:<ano>:<tipo>, ex.: b3:KLBN11.SA:2026:ITR3';
comment on column public.exec_calendar_events.ics_seq is
  'SEQUENCE do evento no .ics. O Outlook IGNORA uma alteração se este número não subir.';

-- ⚠️ Índice único SIMPLES, NÃO parcial. Um índice parcial (`where source is not null`)
-- parece mais elegante, mas o PostgREST monta `on conflict (source, external_id)` SEM
-- repetir o predicado → o Postgres não consegue inferir o índice e devolve 42P10.
-- Simples funciona igual: no Postgres NULL é distinto de NULL para unicidade, então
-- quantos eventos manuais você quiser (source e external_id nulos) continuam cabendo.
create unique index if not exists exec_calendar_events_src_ext_uidx
  on public.exec_calendar_events (source, external_id);
create index if not exists exec_calendar_events_source_idx
  on public.exec_calendar_events (source);

-- ───────────── 2) O CONTADOR SOBE SOZINHO QUANDO A DATA MUDA ─────────────────
-- Regra do iCalendar: mesmo evento (mesmo UID) com o mesmo SEQUENCE = "já tenho isso",
-- e o Outlook descarta a atualização — o evento fica na data velha PARA SEMPRE.
-- Fica no banco (e não no Python) para valer também quando VOCÊ arrastar uma data no
-- admin, ou mexer direto por SQL: qualquer caminho de escrita sobe o contador.
create or replace function public._cal_bump_ics_seq()
  returns trigger language plpgsql set search_path = public, pg_temp as $$
  begin
    if ( new.title, new.start_date, new.end_date, new.all_day,
         new.start_time, new.end_time, new.is_visible, new.location )
       is distinct from
       ( old.title, old.start_date, old.end_date, old.all_day,
         old.start_time, old.end_time, old.is_visible, old.location )
    then new.ics_seq := old.ics_seq + 1;
    else new.ics_seq := old.ics_seq;   -- nunca deixa um update cru zerar o contador
    end if;
    return new;
  end; $$;

drop trigger if exists exec_calendar_events_ics_seq on public.exec_calendar_events;
create trigger exec_calendar_events_ics_seq
  before update on public.exec_calendar_events
  for each row execute function public._cal_bump_ics_seq();

-- ───────────── 3) RECRIAR AS DUAS RPCs DE LEITURA ────────────────────────────
-- Elas são `returns setof public.exec_calendar_events` com corpo `select *`. Como o
-- corpo é texto, o Postgres o re-expande e as colunas novas entram sozinhas — mas
-- recriar é barato e tira qualquer dúvida de descompasso entre a query e o tipo de
-- retorno. Corpo IDÊNTICO ao de supabase_exec_calendar.sql: nada de comportamento muda.
-- ⚠️ REGRA PERMANENTE: toda coluna nova em exec_calendar_events vem acompanhada
--    destes dois `create or replace`.
create or replace function public.get_exec_calendar_events(p_from date, p_to date)
  returns setof public.exec_calendar_events
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_events e
  where (e.is_visible or public.is_admin())
    and ( e.recurrence is not null
          or (e.start_date <= p_to and coalesce(e.end_date, e.start_date) >= p_from) )
  order by e.start_date, e.start_time nulls first;
$$;
revoke all on function public.get_exec_calendar_events(date, date) from public;
grant execute on function public.get_exec_calendar_events(date, date) to anon, authenticated;

create or replace function public.admin_get_exec_calendar_events()
  returns setof public.exec_calendar_events
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.exec_calendar_events where public.is_admin()
  order by start_date desc, start_time nulls first;
$$;
revoke all on function public.admin_get_exec_calendar_events() from public, anon;
grant execute on function public.admin_get_exec_calendar_events() to authenticated;

-- ───────────── 4) PASTA PÚBLICA DO ARQUIVO .ics ───────────────────────────────
-- Precisa ser público: o Outlook busca o endereço sem login nenhum (e o middleware.js
-- da dashboard barraria qualquer coisa servida pela Vercel). A privacidade vem do
-- código secreto no nome do arquivo (item 5) — mesmo esquema do Google Calendar.
-- Sem policy de escrita: só a service key (que ignora RLS) publica.
insert into storage.buckets (id, name, public)
  values ('calendars', 'calendars', true)
  on conflict (id) do update set public = true;

-- ───────────── 5) CÓDIGO SECRETO DO ENDEREÇO ──────────────────────────────────
-- Sorteado UMA vez e nunca mais — o endereço que você assinar no Outlook continua
-- valendo para sempre. Re-rodar este arquivo NÃO troca o código (o `where not exists`
-- protege). Para invalidar o link antigo: delete a linha e rode de novo.
insert into public.secure_config (key, value)
  select 'b3_ics_slug', replace(gen_random_uuid()::text, '-', '')
  where not exists (select 1 from public.secure_config where key = 'b3_ics_slug');

-- ───────────── 6) O BOTÃO "ASSINAR" DA AGENDA PRECISA DO ENDEREÇO ────────────
-- secure_config é service-key-only, então o navegador não lê direto. Esta RPC
-- devolve o endereço montado só para quem é admin.
create or replace function public.admin_get_ics_url()
  returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case when public.is_admin() then
    'https://mmhkqkpjrvyxovpihnio.supabase.co/storage/v1/object/public/calendars/earnings-'
    || (select value from public.secure_config where key = 'b3_ics_slug') || '.ics'
  end;
$$;
revoke all on function public.admin_get_ics_url() from public, anon;
grant execute on function public.admin_get_ics_url() to authenticated;

-- ───────────── 7) PostgREST enxergar as colunas novas na hora ────────────────
notify pgrst, 'reload schema';

-- ───────────── 8) CONFERÊNCIA (o resultado aparece na aba Results) ───────────
-- O endereço do calendário sai pronto aqui embaixo, é só copiar para o Outlook
-- (Adicionar calendário → Assinar da Web). Ele só existe DEPOIS do primeiro run
-- do robô — até lá o endereço responde "não encontrado", o que é normal.
select 'https://mmhkqkpjrvyxovpihnio.supabase.co/storage/v1/object/public/calendars/earnings-'
       || value || '.ics' as endereco_do_calendario
  from public.secure_config where key = 'b3_ics_slug';
