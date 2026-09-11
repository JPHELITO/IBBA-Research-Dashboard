# -*- coding: utf-8 -*-
"""Testes do cheat sheet trimestral (_shared/quarterly.py).

Fixtures = dado REAL da CVM recortado para 4 empresas, que cobrem os casos que importam:
  VALE3  normal — e o código da depreciação MUDA de um protocolo para o outro
  KLBN11 duas linhas de D&A (depreciação + exaustão de ativo biológico)
  SUZB3  tem "Amortização do custo de transação", que NÃO é D&A
  AURA33 não tem linha de depreciação nenhuma → EBITDA em branco, e isso é o certo
Nenhum teste toca a rede.

Rodar:  python -m pytest tests/test_quarterly.py -q
"""
import io
import os
import sys
import zipfile

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(BASE, "fixtures")
sys.path.insert(0, os.path.join(BASE, "..", "_shared"))
import quarterly as q  # noqa: E402

PARTES = ("DRE_con", "DFC_MI_con", "BPA_con", "BPP_con")


def _zip(prefixo: str) -> zipfile.ZipFile | None:
    """Remonta o zip da CVM a partir dos CSVs recortados — assim o teste exercita o
    mesmo caminho de leitura que a produção, e não um atalho."""
    buf = io.BytesIO()
    achou = False
    with zipfile.ZipFile(buf, "w") as z:
        for parte in PARTES:
            p = os.path.join(FIX, f"{prefixo}_{parte}.csv")
            if os.path.exists(p):
                z.writestr(f"cia_aberta_{parte}_x.csv", open(p, "rb").read())
                achou = True
    if not achou:
        return None
    buf.seek(0)
    return zipfile.ZipFile(buf)


@pytest.fixture(scope="module")
def fontes():
    """As três fontes, na mesma ordem da produção (mais recente primeiro)."""
    out = []
    for prefixo, doc in (("q_itr2026", "ITR"), ("q_dfp2025", "DFP"), ("q_itr2025", "ITR")):
        z = _zip(prefixo)
        if z is None:
            pytest.skip(f"fixture ausente: {prefixo}")
        dre, rot_dre = q._colher(z, "DRE_con", True)
        dfc, rot_dfc = q._colher(z, "DFC_MI_con", True)
        bpa, _ = q._colher(z, "BPA_con", False)
        bpp, _ = q._colher(z, "BPP_con", False)
        out.append({"dre": dre, "dfc": dfc, "bpa": bpa, "bpp": bpp,
                    "rot": {"dre": rot_dre, "dfc": rot_dfc}, "doc": doc})
    return out


@pytest.fixture(scope="module")
def linhas(fontes):
    return {(r["company"], r["quarter"]): r for r in q.montar(fontes)}


# ───────────────────────── utilidades ────────────────────────────────────────

def test_trimestre_pela_data_de_fechamento():
    assert q._tri("2026-06-30") == "2026Q2"
    assert q._tri("2025-12-31") == "2025Q4"
    assert q._tri("2026-03-31") == "2026Q1"
    # mês que não fecha trimestre não é trimestre (e não pode virar um)
    assert q._tri("2026-05-31") is None and q._tri("") is None


def test_tamanho_da_janela():
    assert q._meses("2026-04-01", "2026-06-30") == 3      # trimestre isolado
    assert q._meses("2026-01-01", "2026-06-30") == 6      # acumulado
    assert q._meses("2025-01-01", "2025-12-31") == 12     # ano


def test_folha_nao_soma_pai_e_filho():
    import re
    contas = {"6.01.01": -10.0, "6.01.01.02": -10.0}
    rot = {"6.01.01": "Adições de imobilizado", "6.01.01.02": "Adições de imobilizado"}
    achou = q._folhas(contas, re.compile("imobilizado"), None, "6.01", lambda c: rot.get(c, ""))
    assert achou == ["6.01.01"]          # o filho é detalhe do pai; somar os dois dobraria


# ───────────────────────── depreciação ───────────────────────────────────────

def test_da_soma_as_duas_linhas_da_klabin(fontes):
    """A Klabin separa a exaustão dos ativos biológicos numa linha própria — as duas contam."""
    itr = fontes[0]
    k = ("KLBN11", "2026-01-01", "2026-06-30")
    rot = itr["rot"]["dfc"][k]
    linhas_da = [ds for cd, ds in rot.items()
                 if cd.startswith("6.01") and ("preci" in ds or "xaust" in ds)]
    assert len(linhas_da) == 2, linhas_da
    assert q._da(itr["dfc"][k], lambda cd: rot.get(cd, "")) == sum(
        itr["dfc"][k][cd] for cd, ds in rot.items()
        if cd.startswith("6.01") and ("preci" in ds or "xaust" in ds))


def test_amortizacao_de_custo_de_transacao_nao_e_da():
    """"Amortização" também é palavra de dívida — a da Suzano é custo de transação."""
    rot = {"6.01.01.02": "Depreciação, Exaustão e Amortização",
           "6.01.01.11": "Amortização do custo de transação, ágio e deságio"}
    contas = {"6.01.01.02": 5_939_254.0, "6.01.01.11": 84_591.0}
    assert q._da(contas, lambda cd: rot.get(cd, "")) == 5_939_254.0


def test_aura_nao_tem_depreciacao_e_isso_fica_em_branco(linhas):
    """Falha ABERTA: sem a linha no fluxo de caixa, o EBITDA não é inventado nem zerado."""
    r = linhas[("AURA33", "2026Q2")]
    assert r["net_revenue"] and r["net_income"]      # o resto do resultado está lá
    assert r["d_a"] is None and r["ebitda"] is None


def test_rotulo_e_por_JANELA_nao_por_codigo(fontes):
    """⚠️ Regressão da armadilha que custou três rodadas: só o TOPO do plano de contas da
    CVM é fixo. Abaixo dele o código é livre e a companhia troca entre um protocolo e
    outro — na Vale a depreciação é 6.01.01.05 num e 6.01.01.06 noutro, e no 2º o
    6.01.01.06 é outra conta. Lendo o rótulo por código (e não por linha), o robô leu D&A
    de −2.198 num trimestre em que ela foi +4.603."""
    itr = fontes[0]
    q1 = ("VALE3", "2026-01-01", "2026-03-31")
    q2 = ("VALE3", "2026-01-01", "2026-06-30")
    cod1 = [cd for cd, ds in itr["rot"]["dfc"][q1].items() if "Deprecia" in ds]
    cod2 = [cd for cd, ds in itr["rot"]["dfc"][q2].items() if "Deprecia" in ds]
    assert cod1 and cod2 and cod1 != cod2, (cod1, cod2)     # o código MUDOU entre os dois
    da1 = q._da(itr["dfc"][q1], lambda cd: itr["rot"]["dfc"][q1].get(cd, ""))
    da2 = q._da(itr["dfc"][q2], lambda cd: itr["rot"]["dfc"][q2].get(cd, ""))
    assert da1 == 4_435_000 and da2 == 9_038_000
    assert da2 - da1 == 4_603_000                            # é o D&A do trimestre isolado


# ───────────────────────── a linha inteira ───────────────────────────────────

def test_vale_2t26(linhas):
    r = linhas[("VALE3", "2026Q2")]
    assert r["period_end"] == "2026-06-30" and r["source"] == "ITR"
    assert r["net_revenue"] == 53_012_000          # 3.01, do próprio ITR
    assert r["ebit"] == 11_342_000                 # 3.05
    assert r["net_income"] == 6_847_000            # 3.11.01 (atribuído ao controlador)
    assert r["d_a"] == 4_603_000                   # acumulado de 6 meses menos o de 3
    assert r["ebitda"] == 15_945_000               # = EBIT + D&A
    assert r["cash"] == 29_842_000                 # 1.01.01 + 1.01.02
    assert r["net_debt"] == r["debt"] - r["cash"]
    assert r["currency"] == "BRL" and r["scale"] == "MIL"


def test_o_quarto_trimestre_e_o_ano_menos_nove_meses(linhas, fontes):
    """Não existe ITR do 4º trimestre: ele é derivado, e é a conta mais delicada daqui."""
    r = linhas[("VALE3", "2025Q4")]
    assert r["source"] == "DFP"
    ano = fontes[1]["dre"][("VALE3", "2025-01-01", "2025-12-31")]["3.01"]
    nove = fontes[2]["dre"][("VALE3", "2025-01-01", "2025-09-30")]["3.01"]
    assert r["net_revenue"] == ano - nove


def test_subtracao_e_sobre_o_AGREGADO(linhas):
    """⚠️ O ITR e o DFP não usam a mesma abertura de contas. Subtraindo conta a conta, a
    linha de capex do DFP ficava inteira de um lado e a do ITR do outro, e o 'trimestre'
    saía com o capex do ANO — R$ 49 bi num trimestre de R$ 8 bi. Somar primeiro resolve."""
    q4 = linhas[("VALE3", "2025Q4")]["capex"]
    vizinhos = [linhas[("VALE3", t)]["capex"] for t in ("2025Q2", "2025Q3", "2026Q1")]
    assert q4 is not None and all(v is not None for v in vizinhos)
    assert q4 < 3 * min(vizinhos)          # 4º trimestre é maior, mas não é o ano inteiro


def test_sem_receita_nao_vira_linha(fontes):
    """Janela sem a conta 3.01 é janela que não serve — não entra como linha vazia."""
    vazio = [{"dre": {("VALE3", "2026-04-01", "2026-06-30"): {"3.05": 1.0}},
              "dfc": {}, "bpa": {}, "bpp": {},
              "rot": {"dre": {}, "dfc": {}}, "doc": "ITR"}]
    assert q.montar(vazio) == []


def test_cobertura_das_quatro_empresas(linhas):
    empresas = {c for c, _ in linhas}
    assert empresas == {"VALE3", "KLBN11", "SUZB3", "AURA33"}
    tris = sorted({t for _, t in linhas})
    assert "2026Q2" in tris and "2025Q4" in tris        # o mais recente e o derivado
    # toda linha tem receita (é o filtro de entrada) e o trimestre casa com a data de fim
    for (c, t), r in linhas.items():
        assert r["net_revenue"] is not None
        assert r["period_end"][:4] == t[:4] and r["quarter"] == t
