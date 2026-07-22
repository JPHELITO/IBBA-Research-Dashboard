# -*- coding: utf-8 -*-
"""montar_gacc.py — monta o pulp_paper.db com o GACC (cavaco China) a partir do CSV do customs.

O QUE FAZ (só você baixar o CSV do portal da alfândega — o resto é automático)
  1. Baixa o pulp_paper.db ATUAL do GitHub (só leitura, API /contents — funciona na rede do
     banco, SEM token).
  2. Lê o(s) CSV(s) que você baixou do customs (downloadData*.csv no Downloads) e PIVOTA em
     código: HW=44012200, SW=44012100; volume=kg/1e9; receita=US$/1e6; países Vietnã/Austrália
     destacados, resto='Others', +Total. (Dispensa o Excel e o pivô manual.)
  3. TROCA só os meses do CSV na tabela gacc_woodchips — preserva o histórico e TODAS as outras
     tabelas (IBÁ, Empapel, SECEX celulose...). Grava o pulp_paper.db nesta pasta.

DEPOIS (publicar — você, pelo navegador, sem script):
  Suba o pulp_paper.db pelo github.com (arrastar e soltar; ~350 KB):
    https://github.com/JPHELITO/IBBA-Research-Dashboard/upload/main/Pulp%20and%20Paper
  → arraste o pulp_paper.db → "Commit changes". A dashboard atualiza em ~1 min.

USO
  python montar_gacc.py                 (acha o(s) downloadData*.csv sozinho)
  python montar_gacc.py "caminho\\arquivo.csv" ["outro.csv" ...]
  PULP_DB=<caminho>  → usa um banco local em vez de baixar (p/ teste)
"""
import base64
import csv
import glob
import json
import os
import sqlite3
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

OWNER, REPO, BRANCH = "JPHELITO", "IBBA-Research-Dashboard", "main"
DB_REL = "Pulp and Paper/pulp_paper.db"
OUT_NAME = "pulp_paper.db"
UA = "ibba-montar-gacc"
SCRIPT_DIR = Path(__file__).resolve().parent
DOWNLOADS = Path.home() / "Downloads"

FIBRE = {44012200: "HW", 44012100: "SW"}          # HW=não-conífera, SW=conífera (chips)
COUNTRIES = ("Total", "Vietnam", "Australia", "Others")


# ── achar os CSV do customs ───────────────────────────────────────────────────
def achar_csvs(args):
    if args:
        return [Path(a) for a in args if Path(a).exists()]
    cand = []
    for d in (DOWNLOADS, SCRIPT_DIR):
        if d.exists():
            cand += glob.glob(str(d / "downloadData*.csv"))
    return sorted({Path(c) for c in cand}, key=lambda p: p.stat().st_mtime, reverse=True)


# ── ler + pivotar o CSV bruto do customs ──────────────────────────────────────
def _num(s):
    if s is None:
        return 0.0
    s = str(s).replace(",", "").replace('"', "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def _grp(p):
    p = str(p).strip()
    return "Vietnam" if p in ("Viet Nam", "Vietnam") else ("Australia" if p == "Australia" else "Others")


def ler_csvs(paths):
    """Lê os CSV e devolve {period: {(fibre,country): [kg, usd]}} + os meses vistos."""
    agg = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    linhas = 0
    for path in paths:
        with open(path, encoding="utf-8", errors="replace", newline="") as f:
            rd = csv.reader(f)
            header = next(rd, None)
            if not header:
                continue
            H = [str(h).strip().lower() for h in header]
            def col(cands, default):
                for i, h in enumerate(H):
                    if any(h == c or (c in h and "code" not in h) for c in cands):
                        return i
                return default
            iD = col(["date of data", "date"], 0); iHS = col(["commodity code"], 1)
            iP = col(["trading partner"], 4); iQ = col(["quantity"], 9); iV = col(["us dollar", "value"], 13)
            for row in rd:
                if len(row) <= iV:
                    continue
                try:
                    hs = int(str(row[iHS]).strip().strip('"'))
                    ym = int(str(row[iD]).strip().strip('"'))
                except ValueError:
                    continue
                if hs not in FIBRE or ym < 190000:
                    continue
                per = f"{ym // 100}-{ym % 100:02d}"; fib = FIBRE[hs]; c = _grp(row[iP])
                kg = _num(row[iQ]); usd = _num(row[iV])
                for cc in (c, "Total"):
                    a = agg[per][(fib, cc)]; a[0] += kg; a[1] += usd
                linhas += 1
    return agg, linhas


def pivotar(agg):
    """{period: {...}} -> lista de linhas gacc_woodchips (grade cheia 2 fibras × 4 países)."""
    out = []
    for per in sorted(agg):
        y, m = int(per[:4]), int(per[5:7])
        for fib in ("HW", "SW"):
            for c in COUNTRIES:
                kg, usd = agg[per].get((fib, c), [0.0, 0.0])
                out.append((per, y, m, fib, c, round(kg / 1e9, 9), round(usd / 1e6, 6)))
    return out


# ── baixar o banco atual (API /contents, sem token) ───────────────────────────
def baixar_db_atual(destino):
    from urllib.parse import quote
    url = f"https://api.github.com/repos/{OWNER}/{REPO}/contents/{quote(DB_REL)}?ref={BRANCH}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github+json",
                                               "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        d = json.loads(resp.read())
    destino.write_bytes(base64.b64decode(d["content"]))
    return d.get("sha", "")[:7]


# ── gravar (troca só os meses do CSV; preserva o resto) ───────────────────────
def merge_gacc(db_path, rows):
    periods = sorted({r[0] for r in rows})
    con = sqlite3.connect(str(db_path)); cur = con.cursor()
    def contar():
        ts = [t for (t,) in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        return {t: cur.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in ts}
    antes = contar()
    g0 = cur.execute("SELECT COUNT(*), MIN(period), MAX(period) FROM gacc_woodchips").fetchone()
    cur.executemany("DELETE FROM gacc_woodchips WHERE period=?", [(p,) for p in periods])
    cur.executemany("INSERT INTO gacc_woodchips (period,year,month,fibre,country,volume_bdmt,revenue_usd_mn) "
                    "VALUES (?,?,?,?,?,?,?)", rows)
    con.commit()
    g1 = cur.execute("SELECT COUNT(*), MIN(period), MAX(period) FROM gacc_woodchips").fetchone()
    depois = contar()
    # detecta BURACOS na série (mês faltando) — a série é contígua, então só aparece se pulou mês
    ps = [p for (p,) in cur.execute("SELECT DISTINCT period FROM gacc_woodchips ORDER BY period")]
    def enc(p):  # ano*12 + (mês-1) → decodável: ano=k//12, mês=k%12+1
        return int(p[:4]) * 12 + (int(p[5:7]) - 1)
    faltando = []
    for i in range(1, len(ps)):
        for k in range(enc(ps[i-1]) + 1, enc(ps[i])):
            faltando.append(f"{k // 12}-{k % 12 + 1:02d}")
    con.close()
    return antes, depois, g0, g1, periods, faltando


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    print("=" * 70 + "\n  MONTAR GACC (cavaco China) -> pulp_paper.db\n" + "=" * 70)

    csvs = achar_csvs(args)
    if not csvs:
        sys.exit(f"\n  ✗ Não achei nenhum 'downloadData*.csv' em {DOWNLOADS} nem aqui.\n"
                 f"    Baixe o CSV do customs primeiro, ou passe o caminho: python montar_gacc.py arquivo.csv")
    print("\n  CSV(s) do customs:")
    for c in csvs:
        print(f"    - {c.name}  ({c.stat().st_size/1024:,.0f} KB)  [{c.parent}]")

    agg, linhas = ler_csvs(csvs)
    rows = pivotar(agg)
    if not rows:
        sys.exit("\n  ✗ Não achei linhas de cavaco (HS 44012100/44012200) nos CSV. Formato inesperado?")
    meses = sorted({r[0] for r in rows})
    print(f"\n  Li {linhas:,} linhas de cavaco → meses: {', '.join(meses)}")

    # banco atual
    local = os.environ.get("PULP_DB")
    if local:
        out = Path(local); print(f"\n  [1/3] Teste: mexendo no próprio banco local {out}")
    else:
        out = SCRIPT_DIR / OUT_NAME
        print("\n  [1/3] Baixando o pulp_paper.db atual do GitHub (via API, sem token)...")
        try:
            sha = baixar_db_atual(out); print(f"        ok — commit {sha}")
        except Exception as e:
            if out.exists():
                print(f"        ⚠ não baixei ({e}). USANDO o pulp_paper.db que já está na pasta.")
            else:
                sys.exit(f"\n  ✗ Não baixei o banco atual e não há um local aqui.\n     Erro: {e}")

    print("  [2/3] Trocando só os meses do CSV na tabela gacc_woodchips...")
    antes, depois, g0, g1, periods, faltando = merge_gacc(out, rows)

    print("\n  [3/3] Pronto:")
    print(f"        gacc_woodchips: {g0[0]} linhas ({g0[1]}→{g0[2]})  ->  {g1[0]} linhas ({g1[1]}→{g1[2]})")
    print(f"        meses atualizados: {', '.join(periods)}")
    mud = [t for t in depois if t != "gacc_woodchips" and antes.get(t) != depois.get(t)]
    if mud:
        print(f"        ⚠ ATENÇÃO: outras tabelas mudaram ({mud}) — não era esperado!")
    else:
        print(f"        tabelas preservadas ({len(depois)-1}: {', '.join(t for t in sorted(depois) if t!='gacc_woodchips')}).")
    print(f"\n  Arquivo gravado: {out}  ({out.stat().st_size/1024:,.0f} KB)")

    if faltando:
        print("\n  ⚠⚠  BURACO NA SÉRIE — falta(m) o(s) mês(es): " + ", ".join(faltando))
        print("      Baixe também esse(s) mês(es) no customs e rode de novo (pode passar todos os CSV")
        print("      juntos). NÃO suba com buraco — o gráfico e os cálculos (MoM/YoY) sairão errados.")
    print("\n  ── PARA PUBLICAR (pelo navegador, sem script) ─────────────────────────")
    print("  1) Abra:  https://github.com/JPHELITO/IBBA-Research-Dashboard/upload/main/Pulp%20and%20Paper")
    print("  2) Arraste o pulp_paper.db desta pasta para a página.")
    print('  3) "Commit changes". A dashboard atualiza em ~1 min.')
    print("  " + "-" * 68)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Cancelado.")
