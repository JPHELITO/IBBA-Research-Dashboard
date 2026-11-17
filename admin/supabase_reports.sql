-- =============================================================================
-- REPORTS (blast de WhatsApp em HTML) — rascunhos dos textos do analista
-- Rodar UMA vez no SQL Editor do Supabase. Seguro rodar de novo (idempotente).
--
-- O que guarda: SÓ o que é TEXTO do analista (título, manchete, takeaways, time,
-- link do relatório). Os NÚMEROS e os gráficos NÃO são salvos: saem do banco da
-- dashboard a cada geração — o rascunho nunca "congela" um dado velho ou revisado.
--
-- Chave = (tipo do relatório, mês de referência): 'iabr' + '2026-09', 'secex' +
-- '2026-10'. Um rascunho por edição; abrir uma edição antiga traz o texto dela.
--
-- Segurança: tabela com RLS ligado e SEM policy (ninguém lê/escreve direto);
-- tudo passa pelas 3 funções abaixo, que exigem is_admin(). Cliente nunca vê.
--
-- Sem este SQL a página /reports.html funciona igual, mas guarda o rascunho só
-- no navegador (e avisa na tela).
--
-- DESFAZER:
--   drop function if exists public.admin_get_report_draft(text, text);
--   drop function if exists public.admin_save_report_draft(text, text, jsonb);
--   drop function if exists public.admin_list_report_drafts(text);
--   drop table if exists public.report_drafts;
-- =============================================================================

create table if not exists public.report_drafts (
  kind        text        not null check (kind ~ '^[a-z_]{2,20}$'),
  period      text        not null check (period ~ '^(\d{4}-\d{2}|-)$'),
  draft       jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid        default auth.uid(),
  primary key (kind, period)
);
alter table public.report_drafts enable row level security;   -- sem policy de propósito

-- lê o rascunho de UMA edição (null se não existir)
create or replace function public.admin_get_report_draft(p_kind text, p_period text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (select d.draft || jsonb_build_object('_updated_at', d.updated_at)
            from public.report_drafts d
           where d.kind = p_kind and d.period = p_period);
end;
$$;

-- grava (substitui) o rascunho de UMA edição; devolve a hora gravada
create or replace function public.admin_save_report_draft(p_kind text, p_period text, p_draft jsonb)
  returns timestamptz
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare v_ts timestamptz;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if pg_column_size(p_draft) > 512000 then
    raise exception 'rascunho grande demais (%s bytes)', pg_column_size(p_draft) using errcode = '22023';
  end if;
  insert into public.report_drafts (kind, period, draft, updated_at, updated_by)
  values (p_kind, p_period, coalesce(p_draft, '{}'::jsonb) - '_updated_at', now(), auth.uid())
  on conflict (kind, period) do update
    set draft      = excluded.draft,
        updated_at = now(),
        updated_by = auth.uid()
  returning updated_at into v_ts;
  return v_ts;
end;
$$;

-- lista as edições que já têm rascunho (p/ o seletor marcar "editado")
create or replace function public.admin_list_report_drafts(p_kind text default null)
  returns table (kind text, period text, updated_at timestamptz)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select d.kind, d.period, d.updated_at
      from public.report_drafts d
     where p_kind is null or d.kind = p_kind
     order by d.kind, d.period desc;
end;
$$;

revoke all on function public.admin_get_report_draft(text, text) from public, anon;
revoke all on function public.admin_save_report_draft(text, text, jsonb) from public, anon;
revoke all on function public.admin_list_report_drafts(text) from public, anon;
grant execute on function public.admin_get_report_draft(text, text) to authenticated;
grant execute on function public.admin_save_report_draft(text, text, jsonb) to authenticated;
grant execute on function public.admin_list_report_drafts(text) to authenticated;

comment on table public.report_drafts is
  'Textos do analista dos relatórios HTML (IABr/SECEX) — 1 linha por edição. Números não ficam aqui.';

notify pgrst, 'reload schema';
