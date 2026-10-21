-- =============================================================================
-- RESUMO DA ÚLTIMA HORA NA HOME — a tabela que o robô preenche e a função que a Home lê
-- Rodar UMA vez no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente:
-- rodar de novo é seguro.
--
-- POR QUE ISTO EXISTE, em português
-- Desde 2026-10-21 o robô de notícias (news-hunter, hunter/digest.py) escreve, para cada hora
-- fechada entre 7h e 20h e uma vez para a madrugada (20h → 7h, às 7h10), um resumo de duas
-- frases das notícias mais relevantes daquela janela, feito por uma IA SÓ com os títulos, e
-- grava aqui. A coluna ao lado do feed da Home mostra o mais recente.
--
-- Cada linha é uma janela:
--   status 'ok'    → tem o resumo (summary) e as manchetes de onde ele saiu (items);
--   status 'list'  → a IA não respondeu a tempo: a Home mostra só as manchetes;
--   status 'quiet' → nada relevante na janela: a Home continua mostrando a anterior.
--
-- A tabela é FECHADA (RLS ligado, sem policy): só o robô, com a chave de serviço, grava e lê
-- direto. A Home chama a função get_news_digest, que entrega as últimas janelas SÓ para quem
-- está logado e, enquanto a flag home_digest estiver DESLIGADA, só para admin. Ligar a flag
-- no /admin (Funcionalidades → "Resumo da última hora") abre para os clientes.
--
-- Sem este arquivo rodado: o robô NÃO chama a IA (ele confere a tabela antes) e a Home não
-- mostra o bloco. Nada quebra.
-- =============================================================================

create table if not exists public.news_digest (
  slot_start  timestamptz primary key,
  slot_end    timestamptz not null,
  kind        text not null check (kind in ('hour', 'overnight')),
  status      text not null check (status in ('ok', 'list', 'quiet')),
  summary     text,
  items       jsonb not null default '[]'::jsonb,
  model       text,
  tokens_in   int,
  tokens_out  int,
  created_at  timestamptz not null default now()
);
alter table public.news_digest enable row level security;
revoke all on table public.news_digest from anon, authenticated;

comment on table public.news_digest is
  'Home (2026-10-21): resumo da última hora — uma linha por janela (7h–20h de hora em hora + madrugada). '
  'Escrita só pelo robô news-hunter (hunter/digest.py). Leitura pela função get_news_digest.';

create or replace function public.get_news_digest(p_limit int default 6)
  returns table(slot_start timestamptz, slot_end timestamptz, kind text, status text,
                summary text, items jsonb, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
  select d.slot_start, d.slot_end, d.kind, d.status, d.summary, d.items, d.created_at
    from public.news_digest d
   where auth.uid() is not null
     and (public.is_admin()
          or exists (select 1 from public.dashboard_flags f
                      where f.key = 'home_digest' and f.enabled))
   order by d.slot_start desc
   limit greatest(1, least(coalesce(p_limit, 6), 24));
$$;
revoke all on function public.get_news_digest(int) from public, anon;
grant execute on function public.get_news_digest(int) to authenticated;

comment on function public.get_news_digest(int) is
  'Home da dashboard (2026-10-21): as últimas janelas do resumo da última hora. Só para quem está logado; '
  'com a flag home_digest desligada, só para admin. Não devolve modelo nem tokens (ficam na tabela).';

-- Feature flag: nasce DESLIGADA (admin vê antes do cliente, uma semana de avaliação).
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('home_digest', 'Painel: Resumo da última hora (coluna do feed na home)', 33, false)
on conflict (key) do nothing;

-- Conferência depois de rodar (deve voltar a tabela vazia e a flag desligada):
--   select count(*) from public.news_digest;
--   select key, enabled from public.dashboard_flags where key = 'home_digest';
