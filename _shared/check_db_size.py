#!/usr/bin/env python3
"""
check_db_size.py — PORTÃO de tamanho dos .db servidos no navegador (sql.js).

Os bancos são baixados INTEIROS pelo navegador do cliente (sql.js). Se crescerem
demais (ex.: explosão de granularidade SH6×País×URF), a dashboard fica lenta.
Este script falha (exit 1) se algum .db passar do teto — usado no CI antes do commit.

  python _shared/check_db_size.py                       # checa os 2 bancos do repo
  python _shared/check_db_size.py caminho/para/x.db ...  # checa caminhos específicos

Limiares (override por env): DB_FAIL_MB (default 50), DB_WARN_MB (default 45).
"""
import os
import sys

FAIL_MB = float(os.environ.get("DB_FAIL_MB", "50"))
WARN_MB = float(os.environ.get("DB_WARN_MB", "45"))


def main(argv) -> int:
    paths = argv[1:]
    if not paths:
        here = os.path.dirname(os.path.abspath(__file__))
        root = os.path.dirname(here)
        paths = [os.path.join(root, "Steel and Mining", "steel_sm.db"),
                 os.path.join(root, "Pulp and Paper", "pulp_paper.db")]
    bad = False
    for p in paths:
        if not os.path.exists(p):
            print(f"  (ignorado, nao existe) {p}")
            continue
        mb = os.path.getsize(p) / 1e6
        flag = "OK  "
        if mb > FAIL_MB:
            flag, bad = "FAIL", True
        elif mb > WARN_MB:
            flag = "WARN"
        print(f"  {flag}  {mb:7.1f} MB  {p}")
    if bad:
        print(f"FALHOU: algum .db passou de {FAIL_MB:.0f} MB (limite do sql.js no navegador).")
        return 1
    print(f"OK: todos os .db abaixo de {FAIL_MB:.0f} MB.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
