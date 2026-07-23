# -*- coding: utf-8 -*-
"""process_customs_inbox.py — o "robô da caixa de entrada" (roda na NUVEM, não no seu PC).

Você baixa o arquivo e joga em `_inbox/customs/` (github.com, arrastar-e-soltar). O robô
(GitHub Action) identifica o tipo PELO NOME DO ARQUIVO e atualiza a dashboard sozinho:

  nome contém 'woodchip'    → cavaco China (HS 4401) → gacc_woodchips (pulp_paper.db)
  nome contém 'steelchina'  → aço China   (HS 72, portal customs, CSV) → pred_exports 'China'
  nome contém 'steelcoreia' → aço Coreia  (KITA, xlsx)                 → pred_exports 'Korea'
  (as duas últimas = a LINHA PRETA do modelo Steel & Mining)

Airbag: um CSV sem palavra no nome, se tiver HS 4401, ainda é reconhecido como cavaco. Aço
sem nome fica AMBÍGUO (China e Coreia têm o mesmo HS 72) → avisa p/ renomear.

Preserva histórico/irmãs/o outro país; proteção contra buraco no cavaco; arquiva em
`_inbox/processed/`. Sinais p/ o workflow: INBOX_CHANGED, PULP_CHANGED, STEEL_CHANGED, INBOX_SUMMARY.
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
        return float(str(s).replace(",", "").replace(" ", "").strip() or 0)
    except ValueError:
        return 0.0


def _sh6(v):
    try:
        return str(int(str(v).strip().split(".")[0]))[:6].zfill(6)
    except (TypeError, ValueError):
        return ""


def _months_between(a, b):
    ai = int(a[:4]) * 12 + int(a[5:7]) - 1
    bi = int(b[:4]) * 12 + int(b[5:7]) - 1
    return [f"{k // 12}-{k % 12 + 1:02d}" for k in range(ai + 1, bi)]


def detect(path):
    """Tipo do arquivo: 'woodchip' | 'steel_china' | 'steel_korea' | 'steel_ambiguous' | None.
    PELO NOME primeiro; p/ CSV sem nome, cai no conteúdo (cavaco é inequívoco; aço fica ambíguo)."""
    n = path.name.lower()
    if "woodchip" in n:
        return "woodchip"
    if "steelchina" in n:
        return "steel_china"
    if "steelcoreia" in n or "steelkorea" in n:
        return "steel_korea"
    if path.suffix.lower() == ".csv":                 # airbag p/ CSV sem palavra no nome
        wood = steel = 0
        try:
            with open(path, encoding="utf-8", errors="replace", newline="") as f:
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
        except Exception:
            return None
        if wood and wood >= steel:
            return "woodchip"
        if steel:
            return "steel_ambiguous"
    return None


def process_woodchip(paths):
    """CSV(s) de cavaco → gacc_woodchips. Devolve (periods, buracos, aviso)."""
    agg, _ = mg.ler_csvs([Path(p) for p in paths])
    rows = mg.pivotar(agg)
    if not rows:
        return None, [], "CSV de cavaco sem linhas."
    csv_min = min(r[0] for r in rows)
    con = sqlite3.connect(f"file:{PULP_DB}?mode=ro", uri=True)
    gmax = con.execute("SELECT MAX(period) FROM gacc_woodchips").fetchone()[0]
    con.close()
    falta = _months_between(gmax, csv_min) if gmax and csv_min > gmax else []
    if falta:
        return None, falta, f"não apliquei o cavaco: falta o(s) mês(es) {', '.join(falta)} antes de {csv_min}."
    _, _, _, _, periods, buracos = mg.merge_gacc(PULP_DB, rows)
    return periods, buracos, None


def _write_pred(country, agg):
    """Grava agg {(period,product):[value_usd,volume_kg]} em pred_exports p/ um país. Devolve periods."""
    if not agg:
        return None
    periods = sorted({k[0] for k in agg})
    now = datetime.utcnow().isoformat()
    conn = sqlite3.connect(STEEL_DB)
    conn.executemany("DELETE FROM pred_exports WHERE country=? AND period=?",
                     [(country, p) for p in periods])
    conn.executemany("INSERT OR REPLACE INTO pred_exports "
                     "(period,country,product,value_usd,volume_kg,updated_at) VALUES (?,?,?,?,?,?)",
                     [(per, country, prod, round(v[0], 2), round(v[1], 2), now)
                      for (per, prod), v in agg.items()])
    conn.commit(); conn.close()
    return periods


def process_steel_china(paths):
    """CSV(s) de aço China (portal customs, destino Brasil) → pred_exports 'China'."""
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
                a[0] += _num(r[13]); a[1] += _num(r[9])       # valor US$ (col13), volume kg (col9)
    return _write_pred("China", agg)


def process_steel_korea(paths):
    """XLSX(s) da KITA ('by H.S Code and Country', destino Brasil) → pred_exports 'Korea'.
    Cabeçalho na linha 'Period'; Export Value em US$ MIL (×1000); Export Weight em TON (×1000)."""
    try:
        import openpyxl
    except ImportError:
        print("  ⚠ falta openpyxl p/ ler o xlsx da Coreia."); return None
    agg = {}
    for p in paths:
        wb = openpyxl.load_workbook(p, data_only=True)      # full read (a KITA vem c/ dimensão malformada)
        rows = list(wb.active.iter_rows(values_only=True)); wb.close()
        hdr = next((i for i, r in enumerate(rows) if r and str(r[0]).strip() == "Period"), None)
        if hdr is None:
            print(f"  ⚠ {Path(p).name}: não achei o cabeçalho 'Period'."); continue
        for r in rows[hdr + 1:]:
            if not r or len(r) < 6:
                continue
            per = str(r[0]).strip()
            if "." not in per or str(r[3]).strip().lower() != "brazil":
                continue
            code = _sh6(r[1])
            if code not in AD_SH6:
                continue
            prod = _dict.sh6_subcategory(code, "steel")
            if not prod:
                continue
            try:
                y, m = per.split(".")[:2]; period = f"{int(y):04d}-{int(m):02d}"
            except ValueError:
                continue
            a = agg.setdefault((period, prod), [0.0, 0.0])
            a[0] += _num(r[5]) * 1000.0                       # Export Value (US$ mil) → US$
            a[1] += _num(r[4]) * 1000.0                       # Export Weight (ton) → kg
    return _write_pred("Korea", agg)


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
    files = sorted(list(INBOX.glob("*.csv")) + list(INBOX.glob("*.xlsx"))) if INBOX.exists() else []
    if not files:
        print("Caixa de entrada vazia — nada a fazer."); _gh(INBOX_CHANGED="false"); return

    groups = {"woodchip": [], "steel_china": [], "steel_korea": []}
    avisos = []
    for fp in files:
        t = detect(fp)
        if t in groups:
            groups[t].append(fp)
        elif t == "steel_ambiguous":
            avisos.append(f"⚠ '{fp.name}' é aço mas não sei China ou Coreia — renomeie com 'steelchina' ou 'steelcoreia'.")
        else:
            avisos.append(f"⚠ não reconheci '{fp.name}' — o nome precisa conter woodchip / steelchina / steelcoreia.")

    summary, aplicados = [], []
    pulp_changed = steel_changed = False

    if groups["woodchip"]:
        periods, buracos, aviso = process_woodchip(groups["woodchip"])
        if periods:
            pulp_changed = True; aplicados += groups["woodchip"]
            summary.append(f"cavaco (GACC): {', '.join(periods)}")
            if buracos:
                avisos.append(f"⚠ buraco na série do cavaco: falta {', '.join(buracos)}")
        if aviso:
            avisos.append("⚠ " + aviso)

    for kind, fn, label in [("steel_china", process_steel_china, "aço China"),
                            ("steel_korea", process_steel_korea, "aço Coreia")]:
        if groups[kind]:
            periods = fn(groups[kind])
            if periods:
                steel_changed = True; aplicados += groups[kind]
                summary.append(f"{label} (linha preta): {', '.join(periods)}")
            else:
                avisos.append(f"⚠ {label}: não extraí nada de {[f.name for f in groups[kind]]} (formato?).")

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
