-- =============================================================================
-- CELULOSE (Fastmarkets PIX) — 2 grupos novos no carrossel de commodities da home
-- Rodar no SQL Editor do Supabase. Idempotente (roda quantas vezes quiser).
--
-- Por que um arquivo separado: o seed de `commodity_groups` em
-- supabase_config_commodities.sql só roda com a tabela VAZIA ("where not exists"),
-- e em produção ela já tem os 5 grupos de aço/minério. Este script acrescenta os
-- de celulose sem tocar nos existentes.
--
-- Os preços em si são gravados pelo robô (news-hunter: fastmarkets_scraper →
-- update_fastmarkets_commodities), na mesma tabela `commodities` do Platts. Este
-- SQL só decide COMO eles aparecem no carrossel.
-- =============================================================================

-- Grupo 1 — China: o índice PIX (net, CFR) + o RESALE doméstico, ambos em US$.
-- Ordem pedida pelo analista: Net e Resale da MESMA fibra lado a lado, BHKP primeiro.
-- (EUCA = BHKP/hardwood, RADIATA = NBSK/softwood — o code guarda a espécie, o nome a fibra.)
insert into public.commodity_groups (title, codes, sort_order)
select 'Pulp China (PIX)',
       '["PULP_BHKP_CHINA","PULP_NBSK_CHINA","PULP_EUCA_RESALE_CN","PULP_RADIATA_RESALE_CN"]'::jsonb,
       60
where not exists (select 1 from public.commodity_groups where title = 'Pulp China (PIX)');

-- ⚠️ O insert acima NAO re-aplica em base ja semeada (mesma armadilha do
-- `on conflict do nothing`). Este update e' quem corrige a ORDEM de quem ja existe.
update public.commodity_groups
   set codes = '["PULP_BHKP_CHINA","PULP_NBSK_CHINA","PULP_EUCA_RESALE_CN","PULP_RADIATA_RESALE_CN"]'::jsonb,
       updated_at = now()
 where title = 'Pulp China (PIX)'
   and codes <> '["PULP_BHKP_CHINA","PULP_NBSK_CHINA","PULP_EUCA_RESALE_CN","PULP_RADIATA_RESALE_CN"]'::jsonb;

-- Grupo 2 — Europa, só em US$ (as linhas em EUR da aba são o mesmo preço noutra moeda).
-- Mesma convenção da China: BHKP primeiro.
insert into public.commodity_groups (title, codes, sort_order)
select 'Pulp Europe (PIX)',
       '["PULP_BHKP_EUROPE","PULP_NBSK_EUROPE"]'::jsonb,
       70
where not exists (select 1 from public.commodity_groups where title = 'Pulp Europe (PIX)');

update public.commodity_groups
   set codes = '["PULP_BHKP_EUROPE","PULP_NBSK_EUROPE"]'::jsonb,
       updated_at = now()
 where title = 'Pulp Europe (PIX)'
   and codes <> '["PULP_BHKP_EUROPE","PULP_NBSK_EUROPE"]'::jsonb;

-- Conferência: deve listar os 5 de aço/minério + os 2 de celulose, nesta ordem.
select sort_order, title, is_visible, codes from public.commodity_groups order by sort_order, title;
