-- =============================================================================
-- A4.5 — UPLOADS  (admin sobe arquivo → robô do GitHub processa + publica)
-- Rodar no SQL Editor do Supabase. Idempotente. Requer is_admin() (admin schema).
-- Fluxo seguro: o navegador SÓ sobe o arquivo (Storage) + enfileira um job; quem
-- processa é a GitHub Action (com a service key, server-side) — nenhum token sai do front.
-- =============================================================================

-- 1) Bucket de Storage (privado) p/ os uploads do admin
insert into storage.buckets (id, name, public)
  values ('admin-uploads', 'admin-uploads', false)
  on conflict (id) do nothing;

-- 2) Política: só admin (authenticated + is_admin) pode SUBIR no bucket.
--    (A Action lê com a service key, que ignora RLS — não precisa de policy de leitura.)
drop policy if exists "admin upload to admin-uploads" on storage.objects;
drop policy if exists "admin rw admin-uploads" on storage.objects;
create policy "admin rw admin-uploads" on storage.objects
  for all to authenticated
  using (bucket_id = 'admin-uploads' and public.is_admin())
  with check (bucket_id = 'admin-uploads' and public.is_admin());

-- 3) Fila de jobs de processamento
create table if not exists public.upload_jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,           -- 'pred_exports' (Excel da linha preta); novos kinds depois
  storage_path  text not null,           -- caminho no bucket admin-uploads
  filename      text,
  status        text not null default 'pending' check (status in ('pending','processing','done','error')),
  message       text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);
alter table public.upload_jobs enable row level security;

-- 4) admin enfileira um job (depois de subir o arquivo no Storage)
create or replace function public.admin_enqueue_upload(p_kind text, p_storage_path text, p_filename text)
  returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
  declare v_id uuid;
  begin
    if not public.is_admin() then raise exception 'forbidden' using errcode='42501'; end if;
    insert into public.upload_jobs (kind, storage_path, filename)
      values (p_kind, p_storage_path, p_filename) returning id into v_id;
    return v_id;
  end; $$;
revoke all on function public.admin_enqueue_upload(text,text,text) from public, anon;
grant execute on function public.admin_enqueue_upload(text,text,text) to authenticated;

-- 5) admin lê o histórico/status dos jobs
create or replace function public.get_upload_jobs()
  returns setof public.upload_jobs
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.upload_jobs where public.is_admin() order by created_at desc limit 50;
$$;
revoke all on function public.get_upload_jobs() from public;
grant execute on function public.get_upload_jobs() to authenticated;

-- A Action atualiza o status com a SERVICE KEY (server-side, ignora RLS) — sem RPC.
