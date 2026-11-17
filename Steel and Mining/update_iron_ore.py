#!/usr/bin/env python3
"""
update_iron_ore.py — Comércio exterior de MINÉRIO DE FERRO do Brasil, AO VIVO do MDIC.

Alimenta DUAS tabelas do steel_sm.db a partir do MESMO download — por isso as duas fecham
no mesmo total, mês a mês e produto a produto:

  secex_iron_ore       (period, direction, product, country)  exportação + importação, por país
  secex_iron_ore_port  (period, product, port)                só exportação, por PORTO

  product = Fines (SH6 260111) | Pellets (260112), do dicionário (_shared/dictionary_codes.csv)
  country = NO_PAIS do MDIC (PAIS.csv)
  port    = URF do MDIC normalizada por _shared/ports.py — os MESMOS nomes do aço (secex_sh6_urf)
            e da celulose: 'IRF SAO LUIS' → 'São Luís', 'PORTO DE ITAGUAI' → 'Itaguaí',
            'PORTO DE VITORIA' → 'Vitória', 'IRF CAMPOS DOS GOYTACAZES' (o Porto do Açu) →
            'Campos Dos Goytacazes', 'ALF - CORUMBÁ' → 'Corumbá'. A base guarda TODOS os portos,
            como a fonte publica; juntar os pequenos em "Others" é coisa da tela/relatório.
  volume_ktons = KG_LIQUIDO / 1e6 · revenue_usd_mn = VL_FOB / 1e6 (somados em kg e US$ inteiros,
            divididos só no fim — é o que deixa porto × país fechar com diferença zero)

Janela rolante de ~6 anos (RECENT_FROM), a mesma nas duas tabelas.

JANELA DE REVISÃO (2026-11-17): o --update reconfere o ano corrente + o anterior INTEIROS
(SECEX_REVISE_YEARS — o mesmo botão do updater_sm.py) e grava SÓ onde o número mudou: a regra do
aço (2026-09-08) e da celulose (2026-09-30). Até aqui o minério gravava só o mês novo e congelava
no 1º número divulgado — o 3T26 exportado estava em 108.892 kt na base contra 108.488 kt no MDIC
(jul −209, ago −82, set −113). Linha que some da fonte sai do banco, mas sumiço de mais de 10%
numa rodada é CSV cortado, não revisão → não apaga nada.

Modos:
  python update_iron_ore.py --check                          # há mês novo no MDIC?
  python update_iron_ore.py --update [--force] [--anos A B]  # mês novo + revisões (as duas tabelas)
  python update_iron_ore.py --backfill [--start-year YYYY]   # recarga das duas (padrão: ~6 anos)
  python update_iron_ore.py --reconcile [--anos A B]         # NÃO grava: base × MDIC e porto × país;
                                                             # sai 1 se divergir (alarme do dia 15)
Com a tabela de porto vazia (1ª rodada depois de publicar), o --update faz a carga completa sozinho.

SECEX_DB=<caminho> p/ testar em cópia.
"""
import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
DB_PATH = Path(os.environ.get("SECEX_DB") or (HERE / "steel_sm.db"))
sys.path.insert(0, str(HERE.parent / "_shared"))
import dictionary as _dict   # noqa: E402
import mdic                  # noqa: E402

IRON_SH6 = _dict.sh6_set("iron_ore")               # 260111 (Fines), 260112 (Pellets)
RECENT_FROM = f"{datetime.utcnow().year - 6}-01"   # janela rolante ~6 anos (as duas tabelas)
REVISE_YEARS = int(os.environ.get("SECEX_REVISE_YEARS", "2"))   # mesma janela do aço
MAX_SUMICO_FRAC = 0.10   # >10% das linhas "sumindo" numa rodada = CSV cortado → não apaga nada
TENTATIVAS = 3           # o MDIC corta a conexão em arquivo grande (EXP/IMP têm ~100 MB)

# Chave de cada tabela (as duas guardam volume_ktons e revenue_usd_mn depois da chave).
CHAVES = {
    "secex_iron_ore":      ("period", "direction", "product", "country"),
    "secex_iron_ore_port": ("period", "product", "port"),
}


def _product(sh6: str) -> str:
    return _dict.sh6_subcategory(str(sh6).zfill(6), "iron_ore") or "other"  # Fines/Pellets


def ensure_tables(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS secex_iron_ore (
        period TEXT, direction TEXT, product TEXT, country TEXT,
        volume_ktons REAL, revenue_usd_mn REAL,
        PRIMARY KEY (period, direction, product, country)) WITHOUT ROWID""")
    conn.execute("""CREATE TABLE IF NOT EXISTS secex_iron_ore_port (
        period TEXT, product TEXT, port TEXT,
        volume_ktons REAL, revenue_usd_mn REAL,
        PRIMARY KEY (period, product, port)) WITHOUT ROWID""")
    conn.commit()


def _latest(conn, tabela="secex_iron_ore"):
    r = conn.execute(f"SELECT MAX(period) FROM {tabela}").fetchone()
    return r[0] if r and r[0] else None


def _janela_anos(n=None) -> list:
    """Anos que o --update reconfere: o corrente e os (n-1) anteriores (ver docstring do módulo)."""
    n = n or REVISE_YEARS
    atual = datetime.utcnow().year
    return list(range(atual - n + 1, atual + 1))


# ─────────────────────────────────────────────────────────────────────────────
# DOWNLOAD + AGREGAÇÃO (um download, duas tabelas)
# ─────────────────────────────────────────────────────────────────────────────
def _aggregate(df, direction):
    """df do MDIC → (por_pais, por_porto) em kg e US$ BRUTOS, das MESMAS linhas.

    por_pais[(period, direction, product, country)] · por_porto[(period, product, port)] — este
    só na exportação. Somar em kg/US$ inteiros e dividir no fim (_em_kt) é o que faz as duas
    tabelas fecharem exato.
    """
    by_country, by_port = {}, {}
    for _, r in df.iterrows():
        period = str(r["period"]).strip()
        if period < RECENT_FROM:
            continue
        sh6 = str(r["sh6"]).strip()
        if sh6 not in IRON_SH6:
            continue
        prod = _product(sh6)
        kg, usd = float(r["kg"] or 0), float(r["usd"] or 0)
        a = by_country.setdefault((period, direction, prod, str(r["country"]).strip() or "Outros"),
                                  [0.0, 0.0])
        a[0] += kg
        a[1] += usd
        if direction == "exp":
            b = by_port.setdefault((period, prod, str(r["port"]).strip() or "Outros"), [0.0, 0.0])
            b[0] += kg
            b[1] += usd
    return by_country, by_port


def _em_kt(agg):
    """{chave: [kg, usd]} → {chave: (kt, US$ mn)}, arredondados como o banco guarda."""
    return {k: (round(v[0] / 1e6, 6), round(v[1] / 1e6, 6)) for k, v in agg.items()}


def _baixa(ano, direcao, pais_map, port_map):
    """Um CSV do MDIC, com até TENTATIVAS tentativas. None = não veio (e NUNCA vira 'zero')."""
    for t in range(1, TENTATIVAS + 1):
        df = mdic.download_mdic_year(ano, direcao, IRON_SH6, pais_map=pais_map, port_map=port_map)
        if df is not None:
            return df
        if t < TENTATIVAS:
            print(f"    tentativa {t}/{TENTATIVAS} falhou ({direcao.upper()}_{ano}); "
                  f"de novo em {5 * t}s")
            time.sleep(5 * t)
    print(f"::warning::{direcao.upper()}_{ano} não veio do MDIC — esse ano fica de fora desta rodada")
    return None


def fetch(years, pais_map, port_map, direcoes=("exp", "imp")):
    """Baixa e agrega. Devolve (por_pais, por_porto, ok) — ok = {(ano, direção)} que vieram.
    Quem grava só mexe no que está em `ok`: um ano que não baixou não pode virar 'apagar tudo'."""
    agg_c, agg_p, ok = {}, {}, set()
    for y in years:
        for d in direcoes:
            df = _baixa(y, d, pais_map, port_map)
            if df is None:
                continue
            ok.add((y, d))
            c, p = _aggregate(df, d)
            for dst, src in ((agg_c, c), (agg_p, p)):
                for k, v in src.items():
                    a = dst.setdefault(k, [0.0, 0.0])
                    a[0] += v[0]
                    a[1] += v[1]
    return agg_c, agg_p, ok


# ─────────────────────────────────────────────────────────────────────────────
# GRAVAÇÃO — só o que mudou, ano a ano
# ─────────────────────────────────────────────────────────────────────────────
def _sincroniza(conn, tabela, live, ano, direcao=None, dry_run=False, forcar=False,
                apagar_em_massa=False):
    """Deixa `tabela` igual à fonte no ANO (e direção, na tabela por país), tocando SÓ no que mudou.

    `live` = {chave: (kt, US$ mn)} (pode trazer outros anos: só o `ano` pedido é olhado).
    Reescrever linha igual faria o .db mudar a cada rodada e o robô commitar todo dia à toa.
    Devolve (novas, revisadas, removidas, meses_mexidos). Com dry_run não escreve nada.
    """
    cols = CHAVES[tabela]
    i_dir = cols.index("direction") if direcao is not None else None
    live = {k: v for k, v in live.items()
            if k[0][:4] == str(ano) and (i_dir is None or k[i_dir] == direcao)}
    onde, params = "substr(period,1,4)=?", [str(ano)]
    if direcao is not None:
        onde += " AND direction=?"
        params.append(direcao)
    banco = {tuple(r[:-2]): (round(r[-2] or 0.0, 6), round(r[-1] or 0.0, 6))
             for r in conn.execute(f"SELECT {', '.join(cols)}, volume_ktons, revenue_usd_mn "
                                   f"FROM {tabela} WHERE {onde}", params)}
    novas = [k for k in live if k not in banco]
    revisadas = [k for k in live if k in banco and banco[k] != live[k]]
    sumidas = [k for k in banco if k not in live]
    # ⚠️ TRAVA: CSV cortado no meio (o MDIC corta a conexão) que ainda parseie vira "meio ano de
    # dados" e apagaria as linhas boas do resto do ano, calado. Sumiço em massa = fonte incompleta.
    if (sumidas and not apagar_em_massa and not dry_run
            and len(sumidas) > MAX_SUMICO_FRAC * len(banco)):
        print(f"::warning::{tabela} {ano}{' ' + direcao if direcao else ''}: {len(sumidas)} de "
              f"{len(banco)} linhas sumiriam da fonte — parece CSV cortado. Nada foi apagado.")
        sumidas = []
    gravar = novas + revisadas
    if forcar:
        gravar += [k for k in live if k in banco and banco[k] == live[k]]
    if not dry_run:
        conn.executemany(
            f"INSERT OR REPLACE INTO {tabela} ({', '.join(cols)}, volume_ktons, revenue_usd_mn) "
            f"VALUES ({', '.join('?' * (len(cols) + 2))})", [(*k, *live[k]) for k in gravar])
        conn.executemany(f"DELETE FROM {tabela} WHERE " + " AND ".join(f"{c}=?" for c in cols),
                         sumidas)
        conn.commit()
    return len(novas), len(revisadas), len(sumidas), {k[0] for k in novas + revisadas + sumidas}


def sincroniza_tudo(conn, agg_c, agg_p, ok, dry_run=False, forcar=False, apagar_em_massa=False):
    """Aplica a fonte nas DUAS tabelas, só nos (ano, direção) que baixaram.
    Devolve ({tabela: [novas, revisadas, removidas]}, {tabela: meses_mexidos})."""
    live = {"secex_iron_ore": _em_kt(agg_c), "secex_iron_ore_port": _em_kt(agg_p)}
    resumo = {t: [0, 0, 0] for t in CHAVES}
    meses = {t: set() for t in CHAVES}
    kw = dict(dry_run=dry_run, forcar=forcar, apagar_em_massa=apagar_em_massa)
    for ano, direcao in sorted(ok):
        partes = [("país", "secex_iron_ore", direcao)]
        if direcao == "exp":                         # o porto só existe na exportação
            partes.append(("porto", "secex_iron_ore_port", None))
        txt = []
        for rotulo, tabela, d in partes:
            n, r, s, m = _sincroniza(conn, tabela, live[tabela], ano, d, **kw)
            resumo[tabela][0] += n
            resumo[tabela][1] += r
            resumo[tabela][2] += s
            meses[tabela] |= m
            txt.append(f"{rotulo} {n} novas | {r} REVISADAS | {s} removidas")
        print(f"  {direcao.upper()} {ano}: " + " · ".join(txt))
    return resumo, meses


# ─────────────────────────────────────────────────────────────────────────────
# CONFERÊNCIA — porto × país (tem de dar ZERO)
# ─────────────────────────────────────────────────────────────────────────────
def confere_porto_x_pais(conn):
    """Soma dos portos × soma dos países na EXPORTAÇÃO, mês a mês e produto a produto, em kg e
    US$ INTEIROS (o banco guarda kt/US$ mn com 6 casas = o kg e o dólar exatos).
    Devolve (meses_conferidos, divergências) — cada divergência é
    (period, product, kg_porto, usd_porto, kg_pais, usd_pais)."""
    sql = ("SELECT period, product, SUM(CAST(ROUND(volume_ktons * 1000000) AS INTEGER)), "
           "SUM(CAST(ROUND(revenue_usd_mn * 1000000) AS INTEGER)) FROM {t} {w} "
           "GROUP BY period, product")
    porto = {(p, pr): (kg, usd) for p, pr, kg, usd in
             conn.execute(sql.format(t="secex_iron_ore_port", w=""))}
    pais = {(p, pr): (kg, usd) for p, pr, kg, usd in
            conn.execute(sql.format(t="secex_iron_ore", w="WHERE direction='exp'"))}
    chaves = sorted(set(porto) | set(pais))
    div = [(p, pr, *porto.get((p, pr), (0, 0)), *pais.get((p, pr), (0, 0)))
           for p, pr in chaves if porto.get((p, pr), (0, 0)) != pais.get((p, pr), (0, 0))]
    return len({p for p, _ in chaves}), div


def _relata_porto_x_pais(conn) -> bool:
    meses, div = confere_porto_x_pais(conn)
    if not div:
        print(f"  porto × país: {meses} meses conferidos, diferença ZERO em todos (kg e US$)")
        return True
    print(f"::warning::minério — porto × país NÃO fecha em {len({d[0] for d in div})} de {meses} "
          f"meses (as duas tabelas deveriam sair do mesmo download)")
    for p, pr, kgp, usdp, kgc, usdc in div[:24]:
        print(f"    {p} {pr:8s} porto {kgp / 1e6:12.3f} kt × país {kgc / 1e6:12.3f} kt "
              f"(dif {(kgp - kgc) / 1e6:+.3f} kt · US$ {(usdp - usdc) / 1e6:+.3f} mn)")
    return False


def _gh(new, period):
    gh = os.environ.get("GITHUB_ENV")
    if not gh:
        return
    with open(gh, "a") as f:
        f.write(f"IRON_NEW_DATA={new}\n")
        if period:
            f.write(f"IRON_LATEST={period}\n")


# ─────────────────────────────────────────────────────────────────────────────
def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        description="secex_iron_ore (país) + secex_iron_ore_port (porto), ao vivo do MDIC")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--update", action="store_true",
                    help="Reconfere a janela no MDIC e aplica mês novo + revisões")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--reconcile", action="store_true",
                    help="Só confere base × MDIC e porto × país (não grava); sai 1 se divergir")
    ap.add_argument("--force", action="store_true",
                    help="--update regrava a janela mesmo onde o número não mudou")
    ap.add_argument("--start-year", type=int, default=datetime.utcnow().year - 6)
    ap.add_argument("--anos", type=int, nargs="+", metavar="ANO",
                    help=f"Janela explícita p/ --update/--reconcile (padrão: os últimos "
                         f"{REVISE_YEARS} anos)")
    args = ap.parse_args()

    now = datetime.utcnow()
    conn = sqlite3.connect(DB_PATH)
    ensure_tables(conn)
    latest = _latest(conn)
    print(f"DB: {DB_PATH} | secex_iron_ore até {latest} | secex_iron_ore_port até "
          f"{_latest(conn, 'secex_iron_ore_port')} | SH6 {sorted(IRON_SH6)}")
    if not (args.check or args.update or args.backfill or args.reconcile):
        print("Use --check, --update, --backfill ou --reconcile.")
        conn.close()
        return

    try:
        pais_map = mdic.fetch_pais_lookup()
        port_map = mdic.build_port_map(mdic.fetch_urf_lookup())
    except Exception as e:   # sem as tabelas de nomes não dá p/ gravar nem conferir nada
        print(f"::warning::tabelas de país/URF do MDIC não vieram ({e}) — minério fica para a "
              f"próxima rodada")
        _gh("false", None)
        conn.close()
        sys.exit(1 if args.reconcile else 0)   # no --update não pode derrubar o commit do aço

    if args.check:
        agg_c, _, _ = fetch([now.year], pais_map, port_map)
        avail = max((k[0] for k in agg_c), default=None)
        print(f"MDIC tem até {avail} | DB {latest} => "
              f"{'HÁ MÊS NOVO' if (avail and (latest is None or avail > latest)) else 'sem novidade'}")
        conn.close()
        return

    if args.reconcile:
        anos = args.anos or _janela_anos()
        print(f"\n[RECONCILE] {anos[0]}-{anos[-1]} no MDIC (sem gravar)...")
        agg_c, agg_p, ok = fetch(anos, pais_map, port_map)
        faltou = [f"{d.upper()} {y}" for y in anos for d in ("exp", "imp") if (y, d) not in ok]
        resumo, meses = sincroniza_tudo(conn, agg_c, agg_p, ok, dry_run=True)
        bate = _relata_porto_x_pais(conn)
        diverge = any(sum(v) for v in resumo.values())
        if diverge:
            quais = sorted(set().union(*meses.values()))
            print(f"\n  [X] DIVERGE do MDIC nos meses {quais}: " + " · ".join(
                f"{t}: {v[0]} faltando, {v[1]} desatualizadas, {v[2]} sobrando"
                for t, v in resumo.items()))
        if faltou:
            # Sem o CSV não dá para certificar nada: falta de dado é FALHA, não aprovação.
            print(f"\n  [X] NÃO DEU PARA CONFERIR: o MDIC não entregou {', '.join(faltou)}.")
        if not (diverge or faltou) and bate:
            print("\n  [OK] minério idêntico ao MDIC na janela e porto × país fechando.")
        conn.close()
        sys.exit(1 if (diverge or faltou or not bate) else 0)

    # --update / --backfill. Tabela vazia (1ª rodada depois de publicar) = carga completa.
    porto_vazio = _latest(conn, "secex_iron_ore_port") is None
    em_massa = args.backfill or latest is None or porto_vazio
    if em_massa:
        anos = list(range(max(args.start_year, int(RECENT_FROM[:4])), now.year + 1))
        motivo = "--backfill" if args.backfill else "tabela vazia → carga completa"
    elif args.update:
        anos = args.anos or _janela_anos()
        motivo = "janela de revisão"
    print(f"\n[{'BACKFILL' if em_massa else 'UPDATE'}] {anos[0]}-{anos[-1]} ({motivo}) — "
          f"grava só o que mudou")
    agg_c, agg_p, ok = fetch(anos, pais_map, port_map)
    resumo, meses = sincroniza_tudo(conn, agg_c, agg_p, ok, forcar=args.force,
                                    apagar_em_massa=em_massa)
    poda = sum(conn.execute(f"DELETE FROM {t} WHERE period < ?", (RECENT_FROM,)).rowcount
               for t in CHAVES)                       # janela rolante (~6 anos)
    conn.commit()
    tocados = set().union(*meses.values())
    if em_massa and (tocados or poda):
        conn.execute("VACUUM")    # apagar+regravar deixa páginas soltas no arquivo
    # "Revisão" = número que JÁ estava publicado e mudou. Na carga de uma tabela vazia todo mês
    # é linha nova dela, não revisão do MDIC — por isso o porto só conta se já existia antes.
    revisaveis = meses["secex_iron_ore"] | (set() if porto_vazio else meses["secex_iron_ore_port"])
    novos = sorted(m for m in tocados if latest is None or m > latest)
    revistos = sorted(m for m in revisaveis if latest is not None and m <= latest)
    for t, (n, r, s) in resumo.items():
        print(f"  {t}: {n} novas | {r} REVISADAS | {s} removidas")
    if porto_vazio and meses["secex_iron_ore_port"]:
        mp = sorted(meses["secex_iron_ore_port"])
        print(f"  secex_iron_ore_port: tabela nova, carregada de {mp[0]} a {mp[-1]} ({len(mp)} meses)")
    if poda:
        print(f"  poda da janela rolante (< {RECENT_FROM}): {poda} linhas")
    print(f"  mês novo: {', '.join(novos) or '—'} | meses já publicados que mudaram (revisão do "
          f"MDIC): {', '.join(revistos) or '—'}")
    _relata_porto_x_pais(conn)
    mudou = bool(tocados) or bool(poda)
    _gh("true" if mudou else "false", _latest(conn) if mudou else None)
    conn.close()
    print("Concluído." if mudou else "Nada mudou (nem mês novo, nem revisão). Concluído.")


if __name__ == "__main__":
    main()
