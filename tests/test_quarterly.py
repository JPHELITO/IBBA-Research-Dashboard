# -*- coding: utf-8 -*-
"""Testes do cheat sheet trimestral (_shared/quarterly.py).

Fixtures = dado REAL da CVM recortado. As demonstrações, para 4 empresas que cobrem os casos que importam:
  VALE3  normal — e o código da depreciação MUDA de um protocolo para o outro
  KLBN11 duas linhas de D&A (depreciação + exaustão de ativo biológico)
  SUZB3  tem "Amortização do custo de transação", que NÃO é D&A
  AURA33 não tem linha de depreciação nenhuma → EBITDA em branco, e isso é o certo
A composição do capital e o índice de entregas, para as 11 da cobertura (é onde moram os erros de
digitação e a troca de escala). Nenhum teste toca a rede.

Rodar:  python -m pytest tests/test_quarterly.py -q
"""
import datetime as dt
import io
import os
import sys
import zipfile

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(BASE, "fixtures")
sys.path.insert(0, os.path.join(BASE, "..", "_shared"))
import quarterly as q  # noqa: E402

PARTES = ("DRE_con", "DFC_MI_con", "BPA_con", "BPP_con", "composicao_capital")

# ações pelo Formulário de Referência (mw_share_capital, set/2026) — dado público, é a referência da escala
ANCORAS = {"VALE3": 4_439_159_764, "CMIN3": 5_432_044_538, "BRAP4": 393_096_610, "CSNA3": 1_326_093_947,
           "GGBR4": 1_978_018_049, "GOAU4": 1_322_688_048, "USIM5": 1_253_079_108, "KLBN11": 6_241_478_850,
           "SUZB3": 1_264_117_615, "RANI3": 230_501_219, "AURA33": 72_398_525}


def _zip(prefixo: str, doc: str, ano: int) -> zipfile.ZipFile | None:
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
        p = os.path.join(FIX, f"{prefixo}_indice.csv")
        if os.path.exists(p):            # o índice leva o nome do arquivo real: é por ele que o robô o acha
            z.writestr(f"{doc.lower()}_cia_aberta_{ano}.csv", open(p, "rb").read())
    if not achou:
        return None
    buf.seek(0)
    return zipfile.ZipFile(buf)


@pytest.fixture(scope="module")
def fontes():
    """As três fontes, na mesma ordem da produção (mais recente primeiro)."""
    out = []
    for prefixo, doc, ano in (("q_itr2026", "ITR", 2026), ("q_dfp2025", "DFP", 2025), ("q_itr2025", "ITR", 2025)):
        z = _zip(prefixo, doc, ano)
        if z is None:
            pytest.skip(f"fixture ausente: {prefixo}")
        out.append(q.ler_zip(z, doc))
    return out


@pytest.fixture(scope="module")
def linhas(fontes):
    return {(r["company"], r["quarter"]): r for r in q.montar(fontes, ANCORAS)}


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
    """Falha ABERTA: a Aura não traz o fluxo de caixa indireto (onde mora a depreciação) — o EBITDA não é
    inventado nem zerado, e as colunas do fluxo de caixa nem entram na gravação."""
    r = linhas[("AURA33", "2026Q2")]
    assert r["net_revenue"] and r["net_income"]      # o resto do resultado está lá
    assert r.get("d_a") is None and r.get("ebitda") is None and "ocf" not in r


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


# ───────────────────────── ações (composição do capital) ─────────────────────

@pytest.fixture(scope="module")
def acoes(fontes):
    descartes = []
    return q.acoes(fontes, ANCORAS, descartes), descartes


def test_escala_das_acoes_muda_de_formulario_para_formulario(acoes):
    """Vale e Bradespar informam em milhares, a CSN em unidades — e a Suzano trocou no meio de 2025."""
    a, _ = acoes
    assert a[("VALE3", "2026Q2")]["shares_total"] == 4_255_763_000
    assert a[("BRAP4", "2026Q2")]["shares_total"] == 393_097_000
    assert a[("CSNA3", "2026Q2")]["shares_total"] == 1_326_093_947
    assert a[("AURA33", "2026Q2")]["shares_total"] == 83_836_843
    assert a[("SUZB3", "2025Q1")]["shares_total"] == 1_264_117_615     # unidades…
    assert a[("SUZB3", "2025Q2")]["shares_total"] == 1_264_118_000     # …milhares no formulário seguinte
    assert a[("SUZB3", "2025Q2")]["shares_treasury"] == 28_209_000


def test_escala_sem_o_formulario_de_referencia_da_o_mesmo(fontes, acoes):
    """Sem a referência, o piso de 10 mi de ações decide — e nas 11 da cobertura dá igual."""
    a, _ = acoes
    sem = q.acoes(fontes, None)
    assert {k: v["shares_total"] for k, v in sem.items()} == {k: v["shares_total"] for k, v in a.items()}


def test_zero_a_mais_na_contagem_e_descartado(acoes):
    """O DFP 2025 da CSN Mineração diz 54,3 bi de ações, entre 5,49 bi (3T25) e 5,43 bi (1T26)."""
    a, descartes = acoes
    assert a[("CMIN3", "2025Q4")]["shares_total"] is None and a[("CMIN3", "2025Q4")]["shares_out"] is None
    assert a[("CMIN3", "2025Q3")]["shares_total"] == 5_485_338_835
    assert a[("CMIN3", "2026Q1")]["shares_total"] == 5_432_044_538
    assert any(d.startswith("CMIN3 2025Q4") for d in descartes)


def test_digito_a_mais_na_tesouraria_e_descartado(acoes):
    """1T26 da Suzano: 280 mi em tesouraria entre 28 mi e 31 mi."""
    a, _ = acoes
    r = a[("SUZB3", "2026Q1")]
    assert r["shares_treasury"] is None and r["shares_out"] is None
    assert r["shares_total"] == 1_264_117_615          # o total do mesmo formulário está certo e fica
    r = a[("SUZB3", "2026Q2")]
    assert r["shares_treasury"] == 30_980_893 and r["shares_out"] == 1_264_117_615 - 30_980_893


def test_cancelamento_e_recompra_nao_sao_erro(acoes):
    """Tesouraria que zera e volta a subir é movimento de verdade (Metalúrgica Gerdau, CSN Mineração)."""
    a, _ = acoes
    assert a[("GOAU4", "2026Q1")]["shares_treasury"] == 0
    assert a[("GOAU4", "2026Q2")]["shares_treasury"] == 2_033_400
    assert a[("CMIN3", "2026Q2")]["shares_treasury"] == 29_609_100
    assert a[("GGBR4", "2026Q2")]["shares_out"] == 1_985_156_149 - 21_975_510


def test_linha_leva_as_acoes(linhas):
    r = linhas[("VALE3", "2026Q2")]
    assert r["shares_total"] == 4_255_763_000 and r["shares_treasury"] == 183_397_000
    assert r["shares_out"] == 4_072_366_000


def test_trimestre_sem_composicao_nao_leva_as_colunas(linhas):
    """O ano anterior chega só como comparação dentro do ITR, sem a composição do capital. Se a linha
    levasse as colunas vazias, o upsert apagaria as ações que a carga de histórico gravou."""
    sem = [k for k, r in linhas.items() if k[1] < "2025Q1"]
    assert sem, "a fixture tem trimestres de 2024 (comparação)"
    assert all("shares_total" not in linhas[k] and "shares_out" not in linhas[k] for k in sem)


def test_trimestre_sem_balanco_na_rodada_nao_apaga_o_do_banco(linhas):
    """⚠️ Regressão medida em set/2026: o ITR só traz o balanço do fim do próprio trimestre e do fim do ano
    anterior. Na rodada diária (3 anos), os trimestres de comparação do ano mais antigo chegavam sem
    balanço e o upsert gravava caixa e dívida VAZIOS por cima do histórico — 1T23 a 3T23 das 11 empresas."""
    r = linhas[("VALE3", "2024Q2")]
    assert "cash" not in r and "debt" not in r and "net_debt" not in r
    assert r["ocf"] is not None and "ebitda" in r         # o fluxo de caixa do ano anterior vem no ITR: fica
    assert linhas[("VALE3", "2024Q4")]["cash"] is not None  # o fim do ano anterior vem no balanço: fica


def test_rodada_grava_uma_leva_por_conjunto_de_colunas(monkeypatch, fontes):
    """O PostgREST exige as mesmas chaves no lote inteiro; num lote só, a coluna ausente viraria vazio."""
    levas = []
    monkeypatch.setattr(q, "colher_ano", lambda ano, doc: {("ITR", 2026): fontes[0], ("DFP", 2025): fontes[1],
                                                           ("ITR", 2025): fontes[2]}.get((doc, ano)))
    monkeypatch.setattr(q, "ancoras_de_acoes", lambda: ANCORAS)
    monkeypatch.setattr(q, "upsert", lambda tabela, rows, conflito, dry=False: levas.append(rows) or len(rows))
    monkeypatch.setattr(q, "notificar", lambda *a, **k: 0)
    n = q.run([2025, 2026], dry=True)
    assert n == sum(len(l) for l in levas) and len(levas) >= 3
    for leva in levas:
        assert len({tuple(sorted(r)) for r in leva}) == 1


def test_indice_guarda_a_primeira_entrega(fontes):
    itr = fontes[0]
    assert itr["receb"][("VALE3", "2026-06-30")] == dt.date(2026, 7, 30)   # 3 versões: 30/07, 30/07, 31/07
    assert itr["receb"][("SUZB3", "2026-03-31")] == dt.date(2026, 4, 29)
    assert fontes[1]["receb"][("CMIN3", "2025-12-31")] == dt.date(2026, 3, 11)


# ───────────────────────── gatilho ───────────────────────────────────────────

def test_gatilho_so_olha_as_gravacoes_da_cvm(monkeypatch):
    """⚠️ A SEC grava na mesma tabela. Sem o filtro, a gravação da Southern Copper escondia o zip novo da CVM."""
    pedidos = []

    def falso_rest_get(path, params=""):
        pedidos.append(params)
        return [{"updated_at": "2026-09-01T12:00:00+00:00"}]

    class Resposta:
        def __init__(self, lm):
            self.headers = {"last-modified": lm}

    monkeypatch.setattr(q, "rest_get", falso_rest_get)
    monkeypatch.setattr(q.requests, "head", lambda url, **k: Resposta("Mon, 31 Aug 2026 10:00:00 GMT"))
    assert q.ha_novidade([2026]) is False
    assert "source=in.(ITR,DFP)" in pedidos[0]
    monkeypatch.setattr(q.requests, "head", lambda url, **k: Resposta("Wed, 02 Sep 2026 10:00:00 GMT"))
    assert q.ha_novidade([2026]) is True


# ───────────────────────── câmbio ────────────────────────────────────────────

def test_ptax_media_e_fim_so_de_trimestre_fechado():
    dados = [{"data": "31/03/2026", "valor": "5.30"}, {"data": "02/01/2026", "valor": "5.10"},
             {"data": "13/02/2026", "valor": "5.20"}, {"data": "01/04/2026", "valor": "5.40"},
             {"data": "30/06/2026", "valor": "5.1766"}, {"data": "01/07/2026", "valor": "5.00"}]
    out = q.ptax_trimestres(dados, dt.date(2026, 7, 15))
    assert [r["quarter"] for r in out] == ["2026Q1", "2026Q2"]       # o 3T26 ainda corre: fica de fora
    assert out[0]["avg_rate"] == 5.2 and out[0]["eop_rate"] == 5.3  # fim = o último DIA, não o último da lista
    assert out[1]["eop_rate"] == 5.1766 and out[1]["ccy"] == "BRL" and out[1]["source"] == "PTAX"


# ───────────────────────── aviso por e-mail ──────────────────────────────────

def test_aviso_so_para_trimestre_recem_entregue():
    hoje = dt.date(2026, 10, 31)
    linhas = [{"company": c, "quarter": t, "source": "ITR"} for c, t in (
        ("VALE3", "2026Q3"),    # entregou ontem, modelo publicado até o 2T26 → AVISA
        ("VALE3", "2026Q2"),    # trimestre de julho
        ("AURA33", "2026Q3"),   # o modelo está com o ticker do Stock Guide (AUGO) → AVISA
        ("BRAP4", "2026Q3"),    # sem modelo publicado: não há o que subir
        ("KLBN11", "2026Q3"),   # o analista já subiu o 3T26
        ("SUZB3", "2026Q3"),    # sem data de entrega
        ("GGBR4", "2023Q3"),    # carga de histórico
    )]
    recebidos = {("VALE3", "2026Q3"): dt.date(2026, 10, 30), ("VALE3", "2026Q2"): dt.date(2026, 7, 30),
                 ("AURA33", "2026Q3"): dt.date(2026, 10, 20), ("BRAP4", "2026Q3"): dt.date(2026, 10, 29),
                 ("KLBN11", "2026Q3"): dt.date(2026, 10, 28), ("GGBR4", "2023Q3"): dt.date(2023, 10, 31)}
    modelos = {"VALE3": "2026Q2", "AUGO": "2026Q2", "KLBN11": "2026Q3", "GGBR4": "2026Q2", "SUZB3": "2026Q2"}
    out = q.trimestres_a_avisar(linhas, recebidos, modelos, hoje)
    assert [(l["company"], l["quarter"]) for l in out] == [("AURA33", "2026Q3"), ("VALE3", "2026Q3")]


def test_texto_do_aviso():
    l = {"company": "AURA33", "quarter": "2026Q3", "source": "ITR", "currency": "BRL",
         "net_revenue": 3_012_345.0, "ebitda": None, "net_income": -12_700.0}
    assunto, corpo = q.texto_do_aviso(l, "Aura Minerals", dt.date(2026, 11, 5), "2026Q2", "à CVM")
    assert assunto == "📊 Aura Minerals entregou o 3T26 — hora de subir o modelo"
    assert "Aura Minerals (AUGO) entregou o ITR do 3T26 à CVM em 05/11/2026." in corpo
    assert "Receita líquida: R$ 3.012 mi" in corpo and "Lucro líquido: R$ -13 mi" in corpo
    assert "EBITDA contábil" not in corpo            # sem D&A no formulário: a linha some, não vira zero
    assert "vai até o 2T26" in corpo and "quarterly.html#co/AUGO" in corpo
