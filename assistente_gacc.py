# -*- coding: utf-8 -*-
"""assistente_gacc.py — atualiza o GACC (cavaco China) quase sozinho.

Por que não 100% sozinho: o portal da alfândega tem um CAPTCHA de puzzle (proteção anti-robô)
que EXIGE um humano. Este assistente NÃO burla nada — ele usa o SEU navegador normal pra
parte do puzzle (onde você já sabe passar) e automatiza TODO o resto:

  1. Baixa o pulp_paper.db atual e descobre quais meses faltam (dashboard → hoje).
  2. Abre o SEU navegador já na consulta do mês certo (códigos HS + Import + USD prontos).
  3. Você resolve o puzzle e clica em Download. O assistente FICA DE OLHO no Downloads.
  4. Assim que o CSV cai, ele monta o banco sozinho (troca só os meses, preserva tudo).
  5. Confere se não ficou buraco e abre a página de upload — você só arrasta o arquivo.

USO:  python assistente_gacc.py
"""
import datetime
import glob
import os
import sqlite3
import sys
import time
import webbrowser
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import montar_gacc as mg                      # reaproveita o processador (pivô, download, merge)

DOWNLOADS = Path.home() / "Downloads"
UPLOAD_URL = "https://github.com/JPHELITO/IBBA-Research-Dashboard/upload/main/Pulp%20and%20Paper"
# URL da consulta (HS de cavaco + Import + USD já embutidos; período entra por ano/mês)
QUERY = ("http://stats.customs.gov.cn/queryDataForEN/queryDataByWhereEn?iEType=1&currencyType=usd"
         "&monthFlag=1&codeLength=8&outerField1=CODE_TS&outerField2=ORIGIN_COUNTRY"
         "&outerValue1=44011100,44011200,44012100,44012200"
         "&year={ano}&startMonth={mi}&endMonth={mf}")


def _shift(y, m, d):
    i = y * 12 + (m - 1) + d
    return i // 12, i % 12 + 1


def _expected_latest():
    now = datetime.datetime.now()
    back = 1 if now.day >= 20 else 2         # China publica o detalhado ~dia 18-20 do mês seguinte
    y, m = _shift(now.year, now.month, -back)
    return y, m


def _missing_months(gmax):
    """Lista (ano,mês) de gmax+1 até o esperado disponível. Agrupada por ano."""
    if not gmax:
        return []
    ey, em = _expected_latest()
    y, m = _shift(int(gmax[:4]), int(gmax[5:7]), 1)
    out = []
    while y * 12 + (m - 1) <= ey * 12 + (em - 1):
        out.append((y, m)); y, m = _shift(y, m, 1)
    return out


def _snapshot_csvs():
    return {p: os.path.getmtime(p) for p in glob.glob(str(DOWNLOADS / "downloadData*.csv"))}


def _wait_new_csv(before, rotulo):
    """Espera aparecer um downloadData*.csv novo no Downloads. Devolve o caminho (ou None)."""
    print(f"      ⏳ aguardando o download de {rotulo}... (resolva o puzzle e clique em Download)")
    t0 = time.time()
    while True:
        agora = {p: os.path.getmtime(p) for p in glob.glob(str(DOWNLOADS / "downloadData*.csv"))}
        novos = [p for p, mt in agora.items() if p not in before or mt > before.get(p, 0)]
        if novos:
            novo = max(novos, key=os.path.getmtime)
            print(f"      ✓ peguei: {os.path.basename(novo)}")
            return novo
        if time.time() - t0 > 90:
            r = input("      (ainda nada) Enter = esperar mais · 'p' = pular este mês · 'x' = sair: ").strip().lower()
            if r == "x":
                sys.exit("\n  Cancelado.")
            if r == "p":
                return None
            t0 = time.time()
        time.sleep(2)


def main():
    print("=" * 70 + "\n  ASSISTENTE GACC (cavaco China) — atualização quase automática\n" + "=" * 70)

    # 1) banco atual + meses que faltam
    out = SCRIPT_DIR / "pulp_paper.db"
    print("\n  [1/4] Baixando o pulp_paper.db atual (API, sem token)...")
    try:
        sha = mg.baixar_db_atual(out); print(f"        ok — commit {sha}")
    except Exception as e:
        if not out.exists():
            sys.exit(f"  ✗ Não baixei o banco e não há um local aqui.\n     Erro: {e}")
        print(f"        ⚠ não baixei ({e}) — uso o pulp_paper.db que já está na pasta.")
    con = sqlite3.connect(f"file:{out}?mode=ro", uri=True)
    gmax = con.execute("SELECT MAX(period) FROM gacc_woodchips").fetchone()[0]; con.close()
    faltam = _missing_months(gmax)
    ey, em = _expected_latest()
    print(f"        dashboard tem GACC até {gmax} | esperado disponível: {ey}-{em:02d}")
    if not faltam:
        print("\n  ✅ Já está em dia — nada a baixar."); return
    print(f"        faltam: {', '.join(f'{y}-{m:02d}' for y, m in faltam)}")

    # 2-3) por ano (o portal não faz >1 ano por consulta): abre o navegador e vigia o download
    anos = {}
    for y, m in faltam:
        anos.setdefault(y, []).append(m)
    csvs = []
    for i, (y, meses) in enumerate(sorted(anos.items()), 1):
        mi, mf = min(meses), max(meses)
        rotulo = f"{y}-{mi:02d}" + (f"..{mf:02d}" if mf != mi else "")
        print(f"\n  [2/4] ({i}/{len(anos)}) Abrindo o portal p/ {rotulo} no seu navegador...")
        print(f"        Se o período não vier preenchido, selecione: ano {y}, meses {mi} a {mf}.")
        before = _snapshot_csvs()
        webbrowser.open(QUERY.format(ano=y, mi=mi, mf=mf))
        got = _wait_new_csv(before, rotulo)
        if got:
            csvs.append(got)
    if not csvs:
        print("\n  Nada baixado — nada a fazer."); return

    # 4) monta o banco (troca só os meses do CSV; preserva histórico + irmãs) + confere buraco
    print("\n  [3/4] Montando o banco com o(s) CSV baixado(s)...")
    agg, linhas = mg.ler_csvs([Path(c) for c in csvs])
    rows = mg.pivotar(agg)
    if not rows:
        sys.exit("  ✗ Não achei linhas de cavaco nos CSV (formato inesperado?).")
    antes, depois, g0, g1, periods, buracos = mg.merge_gacc(out, rows)
    print(f"        gacc_woodchips: {g0[2]} → {g1[2]}  (meses gravados: {', '.join(periods)})")
    mud = [t for t in depois if t != "gacc_woodchips" and antes.get(t) != depois.get(t)]
    print("        ⚠ outras tabelas mudaram: " + str(mud) if mud else "        tabelas irmãs preservadas ✓")

    if buracos:
        print("\n  ⚠⚠  Ainda falta(m): " + ", ".join(buracos) + " — rode de novo p/ baixar esse(s) mês(es).")
        print("      NÃO suba com buraco (o gráfico/MoM/YoY sairão errados).")
        return

    print("\n  [4/4] Pronto! Abrindo a página de upload — arraste o pulp_paper.db desta pasta:")
    print(f"        {out}")
    print(f"        {UPLOAD_URL}")
    try:
        webbrowser.open(UPLOAD_URL)
    except Exception:
        pass
    print('\n  Na página: arraste o pulp_paper.db → "Commit changes". A dashboard atualiza em ~1 min. ✅')


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n  Cancelado.")
