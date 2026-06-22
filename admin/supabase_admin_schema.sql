-- =============================================================================
-- FUNDAÇÃO DE AUTH DE ADMIN — IBBA-Research-Dashboard
-- Rodar 1x no SQL Editor do Supabase (projeto mmhkqkpjrvyxovpihnio). Idempotente.
-- Padrão de segurança (do prompt Stock Guide): RLS habilitado, SEM policies; leitura
-- via funções SECURITY DEFINER; mutações de admin gated por is_admin().
-- =============================================================================

-- 1) Tabela de perfis: 1 linha por usuário, com o papel.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  role        text not null default 'client' check (role in ('client','admin')),
  created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;
-- Sem CREATE POLICY → leitura direta retorna 0 linhas; acesso só via RPC abaixo.

-- 2) is_admin(): true se o usuário logado tem papel 'admin'. SECURITY DEFINER
--    (lê profiles, que tem RLS — uma policy que consultasse profiles recursaria).
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- 3) get_my_role(): o painel admin chama p/ decidir o que mostrar ('client' por padrão).
create or replace function public.get_my_role() returns text
  language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'client');
$$;
revoke all on function public.get_my_role() from public;
grant execute on function public.get_my_role() to anon, authenticated;

-- 4) Trigger: cria o profile automaticamente quando um usuário novo é criado.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
  begin
    insert into public.profiles (id, email) values (new.id, new.email)
    on conflict (id) do nothing;
    return new;
  end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5) Backfill: cria profile p/ usuários que já existem (ex.: a conta compartilhada).
insert into public.profiles (id, email)
  select id, email from auth.users on conflict (id) do nothing;

-- =============================================================================
-- 6) TORNAR VOCÊ ADMIN  (faça depois de criar SEU usuário próprio no Supabase Auth):
--    a) Supabase → Authentication → Users → "Add user" (seu e-mail + senha forte).
--       (Mantenha a conta compartilhada 'ibba@ibba.internal' como 'client' — os
--        clientes continuam usando ela; o admin é a SUA conta nova.)
--    b) Rode o comando abaixo trocando pelo SEU e-mail:
--
--    update public.profiles set role = 'admin' where email = 'SEU_EMAIL_AQUI';
--
--    c) (Opcional, recomendado pela auditoria A-3) habilite MFA/TOTP no seu usuário:
--       Supabase → Authentication → Providers → habilitar MFA; depois faça o enroll
--       no primeiro login (a página de login pode pedir o código do app autenticador).
-- =============================================================================
