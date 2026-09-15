-- =============================================================================
-- TUTORIAL (tours guiados) — flag de lançamento.   Rodar 1× no SQL Editor do Supabase.
--
-- O botão "Tutorial" da barra de cima (e o convite da 1ª visita na Home) só aparece
-- para o CLIENTE com esta flag LIGADA. O admin vê sempre, para revisar antes.
-- Depois de rodar, liga/desliga em /admin → Funcionalidades (sem SQL de novo).
-- Idempotente: rodar outra vez não muda nada (on conflict do nothing).
-- Motor: tour-lib.js · textos: tour-content.js · recado p/ o menu: ibba_tour_on (index.html)
-- =============================================================================
insert into public.dashboard_flags (key, label, sort_order, enabled) values
  ('tutorial', 'Tutorial (tours guiados + convite na 1ª visita)', 100, false)
on conflict (key) do nothing;
