#!/usr/bin/env python3
"""
update_iba_detector.py — VIGIA do IBÁ (papel). NÃO baixa dado (o PDF do IBÁ é imagem
escaneada, sem texto extraível) — apenas DETECTA quando sai um DadosPapel novo e avisa,
p/ você atualizar manualmente (resolve o "não percebi que saiu").

Página: https://iba.org/publicacoes/dados-papel/ (arquivos DadosPapel-AAAA-MM.pdf).
Compara o mês mais novo no site vs o que a dashboard (iba_paper) já tem.

Modos:
  python update_iba_detector.py --check    # mostra site vs dashboard
  python update_iba_detector.py --notify    # idem + grava GITHUB_ENV p/ o workflow alertar
PULP_DB=<caminho> p/ testar em cópia. (Só leitura — nunca escreve no banco.)
"""
import argparse
import os
import re
import sqlite3
import sys
import warnings

warnings.filterwarnings("ignore")
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("PULP_DB") or os.path.join(HERE, "pulp_paper.db")
PAGE = "https://iba.org/publicacoes/dados-papel/"
UA = {"User-Agent": "Mozilla/5.0"}


def site_latest():
    html = requests.get(PAGE, headers=UA, timeout=60, verify=False).text
    hits = re.findall(r"DadosPapel[-_](\d{4})[-_](\d{2})", html)
    return f"{max(hits)[0]}-{max(hits)[1]}" if hits else None


def dash_latest():
    if not os.path.exists(DB_PATH):
        return None
    c = sqlite3.connect(DB_PATH)
    try:
        r = c.execute("SELECT MAX(period) FROM iba_paper").fetchone()
        return r[0] if r and r[0] else None
    finally:
        c.close()


def _gh(new, site, dash):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"IBA_NEW={new}\n")
        if site:
            f.write(f"IBA_SITE={site}\n")
        if dash:
            f.write(f"IBA_DASH={dash}\n")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Detector de mês novo do IBÁ (papel)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--notify", action="store_true")
    ap.parse_args()

    site = site_latest()
    dash = dash_latest()
    novo = bool(site and (dash is None or site > dash))
    print(f"IBÁ no site: {site} | dashboard (iba_paper): {dash} => "
          f"{'MÊS NOVO disponível' if novo else 'em dia'}")
    if novo:
        print("  >> Atualize o iba_paper manualmente (PDF é imagem; não automatizável com segurança).")
    _gh("true" if novo else "false", site, dash)


if __name__ == "__main__":
    main()
