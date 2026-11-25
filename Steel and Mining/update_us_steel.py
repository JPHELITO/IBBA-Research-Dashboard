# -*- coding: utf-8 -*-
"""
ROBÔ DOS EUA — mantém `Steel and Mining/us_steel.json`, o arquivo da seção "US market" da mesa de dados
(M&M › Steel › US market). Roda sozinho no GitHub (`.github/workflows/update_us_steel.yml`), como o SECEX.

O que ele faz a cada rodada (cada fonte é independente: se uma não responder, as outras seguem e o
número antigo dela fica onde está — avisando no log):

  importação   Census FT900A (microdado), país × produto, em t e US$ — revisita os últimos 14 meses
               (o Census REVISA mês passado) e confere cada mês contra o "Total Census Basis" publicado
  exportação   Census API, pela lista de produtos do AISI (total e semiacabados) — últimos 14 meses
  embarques    AISI, release mensal (vale a publicação mais recente: o AISI revisa)
  aço bruto    worldsteel, release mensal (Mt com uma casa) — últimos 6 meses
  utilização   Fed G.17 (utilização da capacidade de ferro e aço + índice de aço bruto) — série inteira
  semanal      AISI, a semana publicada agora (o site só mostra a semana corrente)

Só grava se algo mudou; o arquivo é escrito sempre do mesmo jeito (mesma ordem, mesmos números), então
"nada mudou" = arquivo idêntico = nada a commitar.

Uso:
  python update_us_steel.py --update                    (rodada normal)
  python update_us_steel.py --update --meses 24         (revisita mais meses)
  python update_us_steel.py --semear <imp.parquet> <prod.parquet> <semanal.parquet>
        (só uma vez: monta o histórico a partir das bases locais do analista; depois o robô mantém)
  python update_us_steel.py --resumo                    (mostra até quando vai cada série)

A chave da API do Census vem da variável CENSUS_API_KEY (secret do GitHub). Nunca no código.
"""

import os
import sys
import json
import argparse
import datetime as dt

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
ARQ = os.path.join(AQUI, "us_steel.json")

INICIO_COMERCIO = "2018-01"     # país × produto completo (microdado em todos os meses) e embarques do AISI
INICIO_LONGO = "2000-01"        # aço bruto e Fed

# Grupos de produto do AISI (FT900A) → nome curto em inglês e família. "Finished" = tudo menos semi.
GRUPOS = {
    "1A": ("Ingots & steel for castings", "semi"), "1B": ("Blooms, billets & slabs", "semi"),
    "3": ("Wire rods", "long"), "4": ("Heavy structural shapes", "long"), "5": ("Steel piling", "long"),
    "6A": ("Plates — cut lengths", "flat"), "6B": ("Plates — in coils", "flat"),
    "7": ("Rails — standard", "long"), "8": ("Rails — other", "long"), "9": ("Railroad accessories", "long"),
    "14": ("Bars — hot-rolled", "long"), "14A": ("Bars — light shaped", "long"), "15": ("Rebar", "long"),
    "16": ("Bars — cold-finished", "long"), "17": ("Tool steel", "long"),
    "18": ("Standard pipe", "pipe"), "19": ("Oil country goods (OCTG)", "pipe"), "20": ("Line pipe", "pipe"),
    "20A": ("Line pipe > 16 in.", "pipe"), "20B": ("Line pipe ≤ 16 in.", "pipe"), "20C": ("Line pipe — not specified", "pipe"),
    "21A": ("Mechanical tubing", "pipe"), "21B": ("Pressure tubing", "pipe"), "21C&D": ("Stainless pipe & tubing", "pipe"),
    "21E": ("Pipe & tubing — not classified", "pipe"), "22A": ("Structural pipe & tube", "pipe"), "22B": ("Pipe for piling", "pipe"),
    "23": ("Wire — drawn", "long"), "28": ("Black plate", "flat"), "29": ("Tin plate", "flat"), "29A": ("Tin-free steel", "flat"),
    "31": ("Sheets — hot-rolled", "flat"), "32": ("Sheets — cold-rolled", "flat"),
    "33A": ("Sheets & strip — hot-dip galvanized", "flat"), "33B": ("Sheets & strip — electrogalvanized", "flat"),
    "34": ("Sheets & strip — other metallic coated", "flat"), "35": ("Sheets & strip — electrical", "flat"),
    "36": ("Strip — hot-rolled", "flat"), "37": ("Strip — cold-rolled", "flat"), "41": ("Rails — used", "long"),
    "ND": ("Not specified by Census", "other"),
}

# nome do país como sai do FT900A (Schedule C, já normalizado) → como a dashboard escreve
PAIS_EN = {"Korea, South": "South Korea", "Korea, North": "North Korea", "Turkey": "Türkiye",
           "Taiwan": "Taiwan", "Hong Kong": "Hong Kong", "United Kingdom": "United Kingdom"}


def _pais(n):
    n = str(n).strip()
    return PAIS_EN.get(n, n)


def _r(v, casas=1):
    """número estável no arquivo: inteiro quando é inteiro, senão `casas` decimais."""
    if v is None:
        return None
    v = round(float(v), casas)
    return int(v) if v == int(v) else v


def _meses_ate(ultimo_ym, n):
    a, m = int(ultimo_ym[:4]), int(ultimo_ym[5:7])
    out = []
    for _ in range(n):
        out.append("%04d-%02d" % (a, m))
        m -= 1
        if m == 0:
            a, m = a - 1, 12
    return sorted(out)


def _mes_passado(hoje=None):
    hoje = hoje or dt.date.today()
    a, m = hoje.year, hoje.month - 1
    if m == 0:
        a, m = a - 1, 12
    return "%04d-%02d" % (a, m)


# ───────────────────────────────────────────────────────── arquivo

def vazio():
    return {"v": 1, "m": {"crude": {}, "ship_nt": {}, "ship_pub": {}, "exp_t": {}, "exp_semi_t": {}, "exp_usd": {},
                          "util": {}, "ipraw": {}},
            "w": [], "imp": {}}


def ler():
    if not os.path.exists(ARQ):
        return vazio()
    with open(ARQ, encoding="utf-8") as f:
        return json.load(f)


def asof(J):
    def mx(d):
        ks = [k for k, v in d.items() if v is not None]
        return max(ks) if ks else None
    m = J["m"]
    return {"imports": max(J["imp"]) if J["imp"] else None, "exports": mx(m["exp_t"]), "shipments": mx(m["ship_nt"]),
            "crude": mx(m["crude"]), "util": mx(m["util"]), "ipraw": mx(m["ipraw"]),
            "weekly": J["w"][-1][0] if J["w"] else None}


def escrever(J):
    """Sempre o mesmo texto para o mesmo dado: chaves em ordem, uma linha por mês na importação
    (o histórico do git só muda nas linhas dos meses que mudaram)."""
    J["asof"] = asof(J)
    J["groups"] = {k: list(v) for k, v in GRUPOS.items()}
    linhas = ["{",
              '"v": 1,',
              '"about": "US steel data for the IBBA data desk (Steel > US market). Sources: US Census Bureau (FT900A imports; '
              'International Trade API exports, AISI product list), AISI (mill shipments, weekly raw steel), worldsteel (crude steel), '
              'Federal Reserve G.17 (capacity utilization, raw steel index). Tonnes are metric unless the key ends in _nt (net tons). '
              'Built by Steel and Mining/update_us_steel.py - do not edit by hand.",',
              '"asof": %s,' % json.dumps(J["asof"], sort_keys=True, ensure_ascii=False),
              '"groups": %s,' % json.dumps(J["groups"], sort_keys=True, ensure_ascii=False),
              '"m": {']
    ms = []
    for k in sorted(J["m"]):
        d = {p: J["m"][k][p] for p in sorted(J["m"][k]) if J["m"][k][p] is not None}
        ms.append('  "%s": %s' % (k, json.dumps(d, ensure_ascii=False, separators=(",", ":"))))
    linhas.append(",\n".join(ms))
    linhas.append("},")
    linhas.append('"w": %s,' % json.dumps(J["w"], separators=(",", ":")))
    linhas.append('"imp": {')
    im = []
    for ym in sorted(J["imp"]):
        rows = sorted(J["imp"][ym], key=lambda r: (r[0], r[1]))
        im.append('  "%s": %s' % (ym, json.dumps(rows, ensure_ascii=False, separators=(",", ":"))))
    linhas.append(",\n".join(im))
    linhas.append("}")
    linhas.append("}")
    texto = "\n".join(linhas) + "\n"
    json.loads(texto)  # trava: nunca grava JSON quebrado
    antes = open(ARQ, encoding="utf-8").read() if os.path.exists(ARQ) else None
    if texto == antes:
        return False
    tmp = ARQ + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)
    os.replace(tmp, ARQ)
    return True


def linhas_importacao(df):
    """FT900A de um mês (microdado) → [[país, grupo, t, US$], ...] somando carbono/liga/inox."""
    nl = df[~df["is_agregado"].astype(bool)].copy()
    nl["pais_en"] = nl["pais_norm"].map(_pais)
    nl["grupo_cod"] = nl["grupo_cod"].fillna("ND").replace("", "ND")
    g = nl.groupby(["pais_en", "grupo_cod"], as_index=False)[["metric_tons", "valor_usd"]].sum(min_count=1)
    out = []
    for r in g.itertuples(index=False):
        t, usd = r.metric_tons, r.valor_usd
        if (t is None or t != t or t == 0) and (usd is None or usd != usd or usd == 0):
            continue
        out.append([r.pais_en, r.grupo_cod, _r(t if t == t else 0), _r(usd if usd == usd else 0, 0)])
    return out


# ───────────────────────────────────────────────────────── semente (uma vez, a partir das bases locais)

def semear(p_imp, p_prod, p_sem):
    import pandas as pd
    J = vazio()
    imp = pd.read_parquet(p_imp)
    imp = imp[(imp["mes"] >= pd.Timestamp(INICIO_COMERCIO + "-01"))]
    if (imp["fonte"] != "microdado").any():
        raise SystemExit("semente: há mês sem microdado depois de %s — conferir" % INICIO_COMERCIO)
    for mes, df in imp.groupby("mes"):
        J["imp"][pd.Timestamp(mes).strftime("%Y-%m")] = linhas_importacao(df)
    q = pd.read_parquet(p_prod)
    q["ym"] = q["mes"].dt.strftime("%Y-%m")
    for r in q.itertuples(index=False):
        ym = r.ym
        if ym >= INICIO_LONGO:
            if r.producao_bruta_kt == r.producao_bruta_kt:
                J["m"]["crude"][ym] = _r(r.producao_bruta_kt)
            if r.utilizacao_capacidade_pct == r.utilizacao_capacidade_pct:
                J["m"]["util"][ym] = _r(r.utilizacao_capacidade_pct, 4)
            if r.ip_aco_bruto_sa == r.ip_aco_bruto_sa:
                J["m"]["ipraw"][ym] = _r(r.ip_aco_bruto_sa, 4)
        if r.embarques_net_tons == r.embarques_net_tons:
            J["m"]["ship_nt"][ym] = _r(r.embarques_net_tons, 0)
            J["m"]["ship_pub"][ym] = "base"
        if r.exportacao_metric_tons == r.exportacao_metric_tons:
            J["m"]["exp_t"][ym] = _r(r.exportacao_metric_tons)
            J["m"]["exp_semi_t"][ym] = _r(r.exportacao_semiacabados_metric_tons)
            J["m"]["exp_usd"][ym] = _r(r.exportacao_valor_usd, 0)
    w = pd.read_parquet(p_sem).dropna(subset=["producao_net_tons"]).sort_values("semana_terminada")
    J["w"] = [[pd.Timestamp(r.semana_terminada).strftime("%Y-%m-%d"), _r(r.producao_net_tons, 0), _r(r.utilizacao_pct)]
              for r in w.itertuples(index=False)]
    mudou = escrever(J)
    print("semente gravada" if mudou else "semente: nada mudou", "->", ARQ)
    resumo(J)


# ───────────────────────────────────────────────────────── rodada normal

def avisar(msg):
    print("::warning::" + msg if os.environ.get("GITHUB_ACTIONS") else "AVISO: " + msg, flush=True)


def atualizar(n_meses=14, hoje=None):
    import us_steel_fontes as F
    J = ler()
    novos, revisados, falhas, conferencia = [], [], [], []
    alvo = _meses_ate(_mes_passado(hoje), n_meses)

    def marca(serie, ym, antes, depois, tol=0.0):
        if antes is None and depois is not None:
            novos.append("%s %s" % (serie, ym))
        elif antes is not None and depois is not None and abs(float(depois) - float(antes)) > tol:
            revisados.append("%s %s" % (serie, ym))

    # 1) importação — FT900A
    try:
        import us_steel_census as C
        for ym in alvo:
            if ym < INICIO_COMERCIO:
                continue
            a, m = int(ym[:4]), int(ym[5:7])
            df, log = C.coletar_mes(a, m, forcar=True)
            if df is None or not len(df):
                continue                                    # ainda não publicado
            if log.get("fonte") != "microdado":
                avisar("importação %s veio sem o microdado (%s) — mês não gravado" % (ym, log.get("fonte")))
                continue
            rows = linhas_importacao(df)
            soma = sum(r[2] for r in rows)
            tot, _usd = C.total_oficial(a, m)
            if tot is None or abs(soma - tot) > max(50.0, 0.0005 * tot):
                avisar("importação %s: soma %.0f t ≠ Total Census Basis %s — mês não gravado" % (ym, soma, tot))
                conferencia.append(ym)
                continue
            antes = J["imp"].get(ym)
            if antes != rows:
                if antes is None:
                    novos.append("importação %s" % ym)
                else:
                    sa = sum(r[2] for r in antes)
                    if abs(sa - soma) > 0.5 or sorted(antes) != sorted(rows):
                        revisados.append("importação %s" % ym)
                J["imp"][ym] = rows
    except Exception as e:
        avisar("importação (FT900A) falhou: %s" % str(e)[:160]); falhas.append("importação")

    # 2) exportação — Census API
    try:
        hs6, semi, _ano = F.codigos_aisi(hoje)
        chave = os.environ.get("CENSUS_API_KEY") or None
        for ym in alvo:
            r = F.exportacao_mes(ym, hs6, semi, chave)
            if r is None:
                continue
            t, ts, usd = _r(r[0]), _r(r[1]), _r(r[2], 0)
            marca("exportação", ym, J["m"]["exp_t"].get(ym), t, 0.5)
            J["m"]["exp_t"][ym], J["m"]["exp_semi_t"][ym], J["m"]["exp_usd"][ym] = t, ts, usd
    except Exception as e:
        avisar("exportação (Census API) falhou: %s" % str(e)[:160]); falhas.append("exportação")

    # 3) embarques — AISI (a publicação mais recente vale)
    try:
        for ym, (nt, pub) in F.embarques(F.posts_aisi(3)).items():
            if ym < "2017-01":
                continue
            antes, pub0 = J["m"]["ship_nt"].get(ym), J["m"]["ship_pub"].get(ym)
            if pub0 not in (None, "base") and pub < pub0:
                continue
            marca("embarques", ym, antes, nt, 0.5)
            J["m"]["ship_nt"][ym], J["m"]["ship_pub"][ym] = _r(nt, 0), pub
    except Exception as e:
        avisar("embarques (AISI) falhou: %s" % str(e)[:160]); falhas.append("embarques")

    # 4) aço bruto — worldsteel (últimos 6 meses)
    try:
        for ym in _meses_ate(_mes_passado(hoje), 6):
            v = F.worldsteel_mes(int(ym[:4]), int(ym[5:7]))
            if v is None:
                continue
            marca("aço bruto", ym, J["m"]["crude"].get(ym), v, 0.5)
            J["m"]["crude"][ym] = _r(v)
    except Exception as e:
        avisar("aço bruto (worldsteel) falhou: %s" % str(e)[:160]); falhas.append("aço bruto")

    # 5) Fed G.17 — a série inteira (o Fed reescreve o passado nas revisões anuais)
    try:
        fed = F.fed_g17()
        for nome in ("util", "ipraw"):
            for ym, v in fed[nome].items():
                if ym < INICIO_LONGO:
                    continue
                marca("Fed %s" % nome, ym, J["m"][nome].get(ym), _r(v, 4), 0.00005)
                J["m"][nome][ym] = _r(v, 4)
    except Exception as e:
        avisar("Fed G.17 falhou: %s" % str(e)[:160]); falhas.append("Fed")

    # 6) semanal — AISI (só a semana corrente existe no site)
    try:
        s = F.semana_atual()
        if s:
            d, nt, ut = s[0], _r(s[1], 0), _r(s[2])
            ix = {w[0]: i for i, w in enumerate(J["w"])}
            if d not in ix:
                J["w"].append([d, nt, ut]); J["w"].sort(key=lambda w: w[0]); novos.append("semanal %s" % d)
            elif J["w"][ix[d]] != [d, nt, ut]:
                J["w"][ix[d]] = [d, nt, ut]; revisados.append("semanal %s" % d)
        else:
            avisar("AISI semanal: frase da semana não encontrada na página")
    except Exception as e:
        avisar("AISI semanal falhou: %s" % str(e)[:160]); falhas.append("semanal")

    mudou = escrever(J)
    # ALARME (job vermelho DEPOIS do commit — o dado sobe primeiro): mês da importação que não bateu com o total
    # publicado, ou TODAS as fontes fora do ar (algo estrutural: rede, site mudou)
    alarme = bool(conferencia) or len(falhas) >= 6
    # recados para o passo de commit do workflow (título do commit)
    resumo_novo = "; ".join(_compactar(novos)) or ""
    resumo_rev = "; ".join(_compactar(revisados)) or ""
    gh = os.environ.get("GITHUB_ENV")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write("US_CHANGED=%s\n" % ("true" if mudou else "false"))
            f.write("US_NEW=%s\n" % resumo_novo.replace("\n", " ")[:300])
            f.write("US_REVISED=%s\n" % resumo_rev.replace("\n", " ")[:300])
            f.write("US_ALARM=%s\n" % ("true" if alarme else "false"))
    print("\n== resultado:", "ARQUIVO ATUALIZADO" if mudou else "nada mudou")
    if novos:
        print("novos:", resumo_novo)
    if revisados:
        print("revisados:", resumo_rev)
    if falhas:
        print("fontes com falha (número antigo mantido):", ", ".join(falhas))
    if conferencia:
        print("importação que NÃO bateu com o Total Census Basis (não gravada):", ", ".join(conferencia))
    resumo(J)
    return mudou, falhas, alarme


def _compactar(itens):
    """'importação 2026-09', 'importação 2026-10' → 'importação 2026-09..2026-10' (uma linha por série)."""
    por = {}
    for it in itens:
        s, ym = it.rsplit(" ", 1)
        por.setdefault(s, []).append(ym)
    return ["%s %s" % (s, v[0] if len(v) == 1 else "%s..%s (%d)" % (min(v), max(v), len(v))) for s, v in por.items()]


def resumo(J=None):
    J = J or ler()
    a = asof(J)
    print("até quando vai cada série:", ", ".join("%s %s" % (k, a[k]) for k in sorted(a)))
    print("importação: %d meses (%s a %s), %d linhas" % (len(J["imp"]), min(J["imp"]) if J["imp"] else "-",
          max(J["imp"]) if J["imp"] else "-", sum(len(v) for v in J["imp"].values())))
    print("tamanho do arquivo: %.0f KB" % (os.path.getsize(ARQ) / 1024 if os.path.exists(ARQ) else 0))


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--meses", type=int, default=14)
    ap.add_argument("--semear", nargs=3, metavar=("IMP", "PROD", "SEMANAL"))
    ap.add_argument("--resumo", action="store_true")
    a = ap.parse_args()
    if a.semear:
        semear(*a.semear)
    elif a.update:
        _m, _falhas, alarme = atualizar(a.meses)
        # fora do GitHub (rodada local) o alarme vira código de saída; no GitHub quem fica vermelho é o
        # ÚLTIMO passo do workflow, depois do commit (o dado não se perde por causa do alarme)
        if alarme and not os.environ.get("GITHUB_ACTIONS"):
            sys.exit(1)
    else:
        resumo()


if __name__ == "__main__":
    main()
