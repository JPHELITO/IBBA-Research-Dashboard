#!/usr/bin/env python3
"""log_update.py — registra uma atualização no update_log do Supabase (painel de admin).

Chamado pelos robôs (GitHub Actions) ao final, quando publicam dado novo, p/ o painel
mostrar "quando + como (auto)". Server-side (usa a service key). Falha silenciosa: NUNCA
derruba o workflow.

Uso:  python _shared/log_update.py <source> <method> [detail]
      ex.: python _shared/log_update.py "SECEX" auto "cron MDIC"
Env:  SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
import json
import os
import sys

try:
    import requests
except ImportError:
    sys.exit(0)

url = os.environ.get("SUPABASE_URL", "").rstrip("/")
key = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not url or not key or len(sys.argv) < 3:
    print("log_update: faltam SUPABASE_URL/KEY ou argumentos — ignorado.")
    sys.exit(0)

src, method = sys.argv[1], sys.argv[2]
detail = sys.argv[3] if len(sys.argv) > 3 else None
try:
    requests.post(
        f"{url}/rest/v1/update_log",
        headers={"apikey": key, "Authorization": f"Bearer {key}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"},
        data=json.dumps({"source": src, "method": method, "detail": detail}),
        timeout=20,
    )
    print(f"update_log: {src} ({method})")
except Exception as e:
    print(f"log_update falhou (ignorado): {e}")
sys.exit(0)
