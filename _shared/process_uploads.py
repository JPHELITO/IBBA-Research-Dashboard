#!/usr/bin/env python3
"""
process_uploads.py — processa os uploads do admin (fila `upload_jobs` no Supabase).

Roda na NUVEM (GitHub Actions). Para cada job 'pending':
  1) baixa o arquivo do Storage (bucket admin-uploads) com a SERVICE KEY;
  2) roda o processador certo conforme `kind` (ex.: 'pred_exports' -> reload_pred_exports.py);
  3) marca o job como 'done' ou 'error'.
A Action commita o .db SE algo mudou (UPLOADS_CHANGED=true no GITHUB_ENV).

Nenhum token sensível no navegador: o front só sobe o arquivo + enfileira; aqui é server-side.
Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
"""
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("Faltando dependência: pip install requests")

SUPA_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE  = os.environ["SUPABASE_SERVICE_KEY"]
H = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"}
REPO = Path(__file__).resolve().parent.parent
TMP  = REPO / "_upload_tmp"
BUCKET = "admin-uploads"


def jobs_pending():
    r = requests.get(f"{SUPA_URL}/rest/v1/upload_jobs?status=eq.pending&order=created_at.asc",
                     headers=H, timeout=60)
    r.raise_for_status()
    return r.json()


def patch_job(jid, **fields):
    requests.patch(f"{SUPA_URL}/rest/v1/upload_jobs?id=eq.{jid}",
                   headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
                   data=json.dumps(fields), timeout=60).raise_for_status()


def download(storage_path, dest):
    r = requests.get(f"{SUPA_URL}/storage/v1/object/{BUCKET}/{storage_path}", headers=H, timeout=180)
    r.raise_for_status()
    dest.write_bytes(r.content)


def run_reload_pred(xlsx):
    """Linha preta: reroda reload_pred_exports.py com o Excel enviado (atualiza steel_sm.db)."""
    subprocess.run([sys.executable, str(REPO / "Steel and Mining" / "reload_pred_exports.py"),
                    "--pred", str(xlsx)], check=True)


# kind -> função processadora (novos tipos de upload entram aqui)
PROCESSORS = {
    "pred_exports": run_reload_pred,
}
SOURCE_LABEL = {"pred_exports": "Linha preta (modelo)"}


def log_update(kind, fn):
    """Registra no update_log do Supabase (método 'manual' = upload do admin)."""
    try:
        requests.post(f"{SUPA_URL}/rest/v1/update_log",
                      headers={**H, "Content-Type": "application/json", "Prefer": "return=minimal"},
                      data=json.dumps({"source": SOURCE_LABEL.get(kind, kind),
                                       "method": "manual", "detail": fn}), timeout=30)
    except Exception:
        pass


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    pend = jobs_pending()
    print(f"{len(pend)} job(s) pendente(s).")
    TMP.mkdir(exist_ok=True)
    changed = False

    for j in pend:
        jid, kind, path = j["id"], j["kind"], j["storage_path"]
        fn = j.get("filename") or "upload.bin"
        print(f"-> job {jid} | kind={kind} | {fn}")
        try:
            patch_job(jid, status="processing")
            proc = PROCESSORS.get(kind)
            if not proc:
                raise RuntimeError(f"kind desconhecido: {kind}")
            dest = TMP / f"{jid}_{fn}"
            download(path, dest)
            proc(dest)
            patch_job(jid, status="done", message="processado",
                      processed_at=datetime.utcnow().isoformat())
            log_update(kind, fn)
            changed = True
            print("   OK")
        except Exception as e:
            msg = str(e)[:500]
            try:
                patch_job(jid, status="error", message=msg,
                          processed_at=datetime.utcnow().isoformat())
            except Exception:
                pass
            print("   ERRO:", msg)

    gh = os.environ.get("GITHUB_ENV")
    if gh:
        with open(gh, "a") as f:
            f.write(f"UPLOADS_CHANGED={'true' if changed else 'false'}\n")
    print("Concluído.")


if __name__ == "__main__":
    main()
