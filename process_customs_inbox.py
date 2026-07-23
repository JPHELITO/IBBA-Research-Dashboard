# -*- coding: utf-8 -*-
"""process_customs_inbox.py — o "robô da caixa de entrada" (roda na NUVEM, não no seu PC).

Você baixa o CSV do portal do customs chinês e joga em `_inbox/customs/` (pelo github.com,
arrastar-e-soltar). Este robô (GitHub Action) detecta o tipo pelo código HS e atualiza a
dashboard sozinho:
  • CAVACO   (HS 4401xx)     → gacc_woodchips        (pulp_paper.db)
  • AÇO p/ Brasil (HS 72xx)  → pred_exports 'China'  = a LINHA PRETA (steel_sm.db + web gz)

Preserva tudo o mais (histórico, tabelas irmãs, a linha da Coreia). Arquiva os CSV
processados em `_inbox/processed/`. NADA fica rodando no seu PC.

Sinais p/ o workflow (GITHUB_ENV): INBOX_CHANGED, PULP_CHANGED, STEEL_CHANGED, INBOX_SUMMARY.
"""
import csv
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "_shared"))
import montar_gacc as mg                 # motor do cavaco (ler_csvs/pivotar/merge_gacc)
import dictionary as _dict               # dicionário SH6 (linha preta = mesmos 55 antidumping)

INBOX = HERE / "_inbox" / "customs"
PROCESSED = HERE / "_inbox" / "processed"
PULP_DB = HERE / "Pulp and Paper" / "pulp_paper.db"
STEEL_DB = HERE / "Steel and Mining" / "steel_sm.db"
AD_SH6 = _dict.antidumping_sh6_set()


def _num(s):
    try:
        return float(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _sh6(v):
    try:
        return str(int(str(v).strip().split(".")[0]))[:6].zfill(6)
    except (TypeError, ValueError):
        return ""


def _months_between(a, b):
    """Meses estritamente entre a e b (exclusivos), 'AAAA-MM'. Vazio se contíguos."""
    ai = int(a[:4]) * 12 + int(a[5:7]) - 1
    bi = int(b[:4]) * 12 + int(b[5:7]) - 1
    return [f"{k // 12}-{k % 12 + 1:02d}" for k in range(ai + 1, bi)]


def detect(csv_path):
    """Olha os códigos HS → 'woodchip' | 'steel' | None."""
    wood = steel = 0
    with open(csv_path, encoding="utf-8", errors="replace", newline="") as f:
        rd = csv.reader(f); next(rd, None)
        for i, r in enumerate(rd):
            if i > 60:
                break
            if len(r) < 2:
                continue
            code = str(r[1]).strip()
            if code.startswith("4401"):
                wood += 1
            elif code.startswith("72"):
                steel += 1
    if wood and wood >= steel:
        return "woodchip"
    if steel and steel > wood:
        return "steel"
    return None


def process_woodchip(paths):
    """CSV(s) de cavaco → gacc_woodchips. Devolve (periods_gravados, buracos, aviso)."""
    agg, _ = mg.ler_csvs([Path(p) for p in paths])
    rows = mg.pivotar(agg)
    if not rows:
        return None, [], "CSV de cavaco sem linhas."
    csv_min = min(r[0] for r in rows)
    con = sqlite3.connect(f"file:{PULP_DB}?mode=ro", uri=True)
    gmax = con.execute("SELECT MAX(period) FROM gacc_woodchips").fetchone()[0]
    con.close()
    # pré-check: não abrir buraco à esquerda (mês faltando entre o dashboard e o CSV)
    falta = _months_between(gmax, csv_min) if gmax and csv_min > gmax else []
    if falta:
        return None, falta, f"não apliquei o cavaco: falta o(s) mês(es) {', '.join(falta)} antes de {csv_min}."
    _, _, _, _, periods, buracos = mg.merge_gacc(PULP_DB, rows)
    return periods, buracos, None


def process_steel(paths):
    """CSV(s) de aço (China→Brasil) → pred_exports 'China'. Devolve periods gravados."""
    agg = {}
    for p in paths:
        with open(p, encoding="utf-8", errors="replace", newline="") as f:
            rd = csv.reader(f); next(rd, None)
            for r in rd:
                if len(r) < 14:
                    continue
                try:
                    ym = int(str(r[0]).strip())
                except ValueError:
                    continue
                if str(r[4]).strip().lower() != "brazil":
                    continue
                code = _sh6(r[1])
                if code not in AD_SH6:
                    continue
                prod = _dict.sh6_subcategory(code, "steel")
                if not prod:
                    continue
                per = f"{ym // 100}-{ym % 100:02d}"
                a = agg.setdefault((per, prod), [0.0, 0.0])
                a[0] += _num(r[13]); a[1] += _num(r[9])   # valor US$ (col13), volume kg (col9)
    if not agg:
        return None
    periods = sorted({k[0] for k in agg})
    now = datetime.utcnow().isoformat()
    conn = sqlite3.connect(STEEL_DB)
    conn.executemany("DELETE FROM pred_exports WHERE country='China' AND period=?",
                     [(p,) for p in periods])
    conn.executemany("INSERT OR REPLACE INTO pred_exports "
                     "(period,country,product,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)",
                     [(per, "China", prod, round(v[0], 2), round(v[1], 2), now)
                      for (per, prod), v in agg.items()])
    conn.commit(); conn.close()
    return periods


def _gh(**kv):
    gh = os.environ.get("GITHUB_ENV")
    if gh:
        with open(gh, "a") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    csvs = sorted(INBOX.glob("*.csv")) if INBOX.exists() else []
    if not csvs:
        print("Caixa de entrada vazia — nada a fazer."); _gh(INBOX_CHANGED="false"); return

    wood, steel, unknown = [], [], []
    for c in csvs:
        t = detect(c)
        (wood if t == "woodchip" else steel if t == "steel" else unknown).append(c)

    summary, avisos = [], []
    pulp_changed = steel_changed = False
    aplicados = []

    if wood:
        periods, buracos, aviso = process_woodchip(wood)
        if periods:
            pulp_changed = True; aplicados += wood
            summary.append(f"cavaco (GACC): {', '.join(periods)}")
            if buracos:
                avisos.append(f"⚠ buraco na série do cavaco: falta {', '.join(buracos)}")
        if aviso:
            avisos.append("⚠ " + aviso)     # não arquiva os CSV de cavaco (ficam p/ reprocessar)

    if steel:
        periods = process_steel(steel)
        if periods:
            steel_changed = True; aplicados += steel
            summary.append(f"aço China (linha preta): {', '.join(periods)}")

    for c in unknown:
        avisos.append(f"⚠ não reconheci '{c.name}' (nem cavaco nem aço) — deixei na caixa.")

    # arquiva SÓ os que aplicaram de fato
    if aplicados:
        PROCESSED.mkdir(parents=True, exist_ok=True)
        for c in aplicados:
            shutil.move(str(c), str(PROCESSED / c.name))

    changed = pulp_changed or steel_changed
    _gh(INBOX_CHANGED="true" if changed else "false",
        PULP_CHANGED="true" if pulp_changed else "false",
        STEEL_CHANGED="true" if steel_changed else "false",
        INBOX_SUMMARY=" | ".join(summary + avisos) or "nada processado")
    print("\n".join(summary + avisos) or "Nada processado.")


if __name__ == "__main__":
    main()
