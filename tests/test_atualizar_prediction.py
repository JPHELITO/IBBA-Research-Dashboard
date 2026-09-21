# -*- coding: utf-8 -*-
"""Testes do atualizar_prediction.py — as partes que NÃO precisam do Excel (COM).

Contexto (21/09/2026). A planilha chegou atualizada à mão com três defeitos que o
script não pegaria:
  1. jan-mar/2026 da KOREA e jan-abr/2026 da CHINA contados DUAS vezes: o download
     novo (jan-ago) foi colado por cima de só PARTE do bloco antigo de 2026. O script
     só perguntava "o mês já existe?" — diria "nada novo" e publicaria a linha preta
     da dashboard inflada (Coreia jan/26: 56.931 t no lugar de 28.466);
  2. o arquivo novo da KITA vinha com a <dimension> do XML errada, e o leitor em
     modo read_only enxergava UMA linha — o arquivo seria descartado, calado;
  3. a fonte tinha revisado meses já colados (China fev/26, Coreia fev/26), e só dava
     para regravar um mês por rodada.

O que estes testes travam:
  • o --refazer entende mês, ano, lista e intervalo — e recusa o que não entende;
  • a conferência aba × fonte separa DUPLICADO (bloqueia) de revisão (só avisa);
  • linha repetida (mesma chave) é contada por mês;
  • o leitor da Coreia lê o arquivo com a dimensão errada inteiro;
  • a escolha do melhor pull por mês devolve também os meses que a aba já tem
    (é contra eles que se confere) e os meses do arquivo mais NOVO;
  • a conferência da data da SECEX (ordem dia/mês do Windows) pega data trocada.

Rodar:  python -m pytest tests/test_atualizar_prediction.py -q
"""
import os
import re
import sys
import time
import zipfile
from datetime import datetime

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, ".."))
import atualizar_prediction as AP  # noqa: E402


# ─────────────────────────── --refazer ───────────────────────────
class TestInterpretaRefazer:
    def test_vazio_nunca_refaz(self):
        f = AP.interpreta_refazer(None)
        assert not f("2026-07")

    def test_um_mes(self):
        f = AP.interpreta_refazer("2026-07")
        assert f("2026-07") and not f("2026-08") and not f("2025-07")

    def test_ano_inteiro(self):
        f = AP.interpreta_refazer("2026")
        assert all(f(f"2026-{m:02d}") for m in range(1, 13))
        assert not f("2025-12") and not f("2027-01")

    def test_lista(self):
        f = AP.interpreta_refazer("2026-01, 2026-03")
        assert f("2026-01") and f("2026-03") and not f("2026-02")

    def test_intervalo_inclui_as_pontas(self):
        f = AP.interpreta_refazer("2025-11..2026-02")
        assert [m for m in ("2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03")
                if f(m)] == ["2025-11", "2025-12", "2026-01", "2026-02"]

    @pytest.mark.parametrize("ruim", ["jul/26", "2026-7", "26", "2026-01..fev", "2026.07"])
    def test_recusa_o_que_nao_entende(self, ruim):
        with pytest.raises(SystemExit):
            AP.interpreta_refazer(ruim)

    def test_resumo_meses(self):
        assert AP.resumo_meses(["2026-02", "2026-01"]) == "2026-01, 2026-02"
        assert AP.resumo_meses([f"2026-{m:02d}" for m in range(1, 9)]) == \
            "2026-01 → 2026-08 (8 meses)"


# ─────────────────────────── aba × fonte ───────────────────────────
class TestConferirContraFonte:
    def test_igual_nao_acusa_nada(self):
        aba = {"2026-04": {"720916": 100.0, "721030": 50.0}}
        dup, dif = AP.conferir_contra_fonte("X", aba, aba, ["2026-04"])
        assert dup == [] and dif == []

    def test_colagem_dupla_vira_duplicado(self):
        # o caso real: Coreia jan/26 — 56.931 t na aba × 28.466 na fonte
        aba = {"2026-01": {"720916": 56931.0}}
        fonte = {"2026-01": {"720916": 28465.5}}
        dup, dif = AP.conferir_contra_fonte("KOREA", aba, fonte, ["2026-01"])
        assert [m for m, _, _ in dup] == ["2026-01"] and dif == []

    def test_sobra_parcial_de_colagem_tambem_bloqueia(self):
        # China abr/26: 58.608 × 32.869 (1,78×) — metade do bloco velho ficou
        dup, _ = AP.conferir_contra_fonte("CHINA", {"2026-04": {"x": 58608.3}},
                                          {"2026-04": {"x": 32869.4}}, ["2026-04"])
        assert dup

    def test_revisao_da_fonte_so_avisa(self):
        # China fev/26: a fonte REVISOU para baixo (86.610 → 77.214) — não é dup
        dup, dif = AP.conferir_contra_fonte("CHINA", {"2026-02": {"x": 86610.5}},
                                            {"2026-02": {"x": 77214.2}}, ["2026-02"])
        assert dup == [] and [m for m, _, _ in dif] == ["2026-02"]

    def test_diferenca_desprezivel_passa(self):
        # MDIC: revisões de poucos kg num mês de 200 mil t não são assunto
        dup, dif = AP.conferir_contra_fonte("SECEX", {"2026-01": {"x": 313293.40}},
                                            {"2026-01": {"x": 313293.61}}, ["2026-01"])
        assert dup == [] and dif == []

    def test_so_confere_os_meses_pedidos(self):
        aba = {"2025-01": {"x": 999.0}, "2026-01": {"x": 10.0}}
        fonte = {"2025-01": {"x": 1.0}, "2026-01": {"x": 10.0}}
        dup, dif = AP.conferir_contra_fonte("X", aba, fonte, ["2026-01"])
        assert dup == [] and dif == []

    def test_fonte_sem_brasil_nao_e_duplicado(self):
        dup, dif = AP.conferir_contra_fonte("X", {"2026-05": {"x": 10.0}}, {"2026-05": {}},
                                            ["2026-05"])
        assert dup == [] and len(dif) == 1


def test_repetidas_por_mes():
    from collections import Counter
    c = Counter({("2026-01", "721030", "Brazil"): 2, ("2026-01", "720916", "Chile"): 1,
                 ("2026-02", "721030", "Brazil"): 3})
    assert AP._repetidas_por_mes(c) == {"2026-01": 1, "2026-02": 2}


def test_hist_com_novos_troca_o_mes_inteiro():
    h = AP._hist_com_novos({"2026-01": {"a": 20.0, "b": 5.0}, "2025-12": {"a": 1.0}},
                           {"2026-01": {"a": 10.0}})
    assert h == {"2026-01": {"a": 10.0}, "2025-12": {"a": 1.0}}


# ─────────────────────────── Coreia: arquivo com a dimensão errada ───────────────────────────
def _xlsx_kita(caminho, linhas, dimensao_errada=True):
    """Monta um 'by H.S Code and Country' no layout da KITA; opcionalmente reproduz o
    defeito do download de 21/09/2026: <dimension ref="A1"/> no XML da planilha."""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "by H.S Code and Country"
    ws.append(["by H.S Code and Country"])
    ws.append([])
    ws.append(["Search condition H.S. Code : ..., Country : ALL, Inquiry Period : 202601 ~ 202608"])
    ws.append([None] * 8 + ["Unit:Thousand Dollar(USD), TON"])
    ws.append(["Period", "H.S Code", "Items", "Country", "Export Weight", "Export Value",
               "Import Weight", "Import Value", "Balance of Trade"])
    ws.append(["TOTAL", "", "", "", "   9,999.0", "   9,999", "0.0", "0", "9,999"])
    for lin in linhas:
        ws.append(lin)
    wb.save(caminho)
    if not dimensao_errada:
        return
    tmp = str(caminho) + ".tmp"
    with zipfile.ZipFile(caminho) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            dados = zin.read(item.filename)
            if item.filename.startswith("xl/worksheets/sheet"):
                dados = re.sub(rb'<dimension ref="[^"]*"/>', b'<dimension ref="A1"/>', dados)
            zout.writestr(item, dados)
    os.replace(tmp, caminho)


LINHAS_KITA = [
    ["2026.08", "721030", "Electrolytically plated", "Brazil", "   1,234.5", "   2,000", "0.0", "0", "2,000"],
    ["2026.08", "721030", "Electrolytically plated", "Algeria", "      12.0", "      20", "0.0", "0", "20"],
    ["2026.07", "720916", "Of a thickness exceeding 1 mm", "Brazil", "      50.0", "      40", "0.0", "0", "40"],
    ["2026.08", "999999", "fora do escopo da planilha", "Brazil", "1.0", "1", "0.0", "0", "1"],
]


def test_fixture_reproduz_o_defeito_do_read_only(tmp_path):
    """Prova de que a fixture é o caso real: em read_only o openpyxl vê 1 linha só.
    (Se um dia o openpyxl parar de confiar na <dimension>, este teste avisa que a
    fixture deixou de reproduzir o defeito — o conserto continua valendo.)"""
    import openpyxl
    p = tmp_path / "by H.S Code and Country_20260921.xlsx"
    _xlsx_kita(p, LINHAS_KITA)
    wb = openpyxl.load_workbook(p, read_only=True)
    n = sum(1 for _ in wb[wb.sheetnames[0]].iter_rows(values_only=True))
    wb.close()
    assert n == 1


@pytest.mark.parametrize("dimensao_errada", [True, False])
def test_leitor_da_coreia_le_o_arquivo_inteiro(tmp_path, dimensao_errada):
    p = tmp_path / "by H.S Code and Country_20260921.xlsx"
    _xlsx_kita(p, LINHAS_KITA, dimensao_errada=dimensao_errada)
    por_mes, fora = AP._korea_um_arquivo(p, {"721030", "720916"})
    assert sorted(por_mes) == ["2026-07", "2026-08"]
    assert len(por_mes["2026-08"]) == 2 and fora == {"999999"}
    # volume/valor entram como NÚMERO (blindam o NUMBERVALUE do separador decimal)
    bra = [lin for lin in por_mes["2026-08"] if lin[3] == "Brazil"][0]
    assert bra[:2] == ["2026.08", "721030"] and bra[4] == 1234.5 and bra[5] == 2000.0
    assert AP.vol_korea(por_mes) == {"2026-07": {"720916": 50.0}, "2026-08": {"721030": 1234.5}}


def test_korea_linhas_devolve_novos_todos_e_meses_do_mais_novo(tmp_path):
    velho = tmp_path / "by H.S Code and Country_20260723.xlsx"
    novo = tmp_path / "by H.S Code and Country_20260921.xlsx"
    _xlsx_kita(velho, [LINHAS_KITA[2]], dimensao_errada=False)             # só 2026-07
    _xlsx_kita(novo, LINHAS_KITA)                                          # 2026-07 e 08
    agora = time.time()
    os.utime(velho, (agora - 3600, agora - 3600))
    os.utime(novo, (agora, agora))
    hs = {"721030", "720916"}

    novos, todos, recentes, consulta = AP.korea_linhas([novo, velho], hs, ja_na_aba={"2026-07"})
    assert sorted(novos) == ["2026-08"]                 # julho a aba já tem
    assert sorted(todos) == ["2026-07", "2026-08"]      # mas entra na conferência
    assert recentes == {"2026-07", "2026-08"}           # meses do arquivo mais novo

    novos, _, _, _ = AP.korea_linhas([novo, velho], hs, ja_na_aba={"2026-07"},
                                  refaz=AP.interpreta_refazer("2026"))
    assert sorted(novos) == ["2026-07", "2026-08"]      # --refazer 2026 traz julho de volta


# ─────────────────────────── China ───────────────────────────
CAB_GACC = ('"Date of data","Commodity code","Commodity","Trading partner code",'
            '"Trading partner","Customs Regime code","Customs Regime",'
            '"Locations of importers and exporters code",'
            '"Locations of importers and exporters","Quantity","Unit",'
            '"Supplementary Quantity","Supplementary Unit","US dollar",')


def _csv_gacc(caminho, linhas):
    with open(caminho, "w", encoding="latin-1", newline="") as f:
        f.write(CAB_GACC + "\n")
        for per, cod, qtd, usd, parceiro in linhas:
            f.write(f'"{per}","{cod}","desc","410","{parceiro}","10","Ordinary Trade",'
                    f'"13","Hebei Province","{qtd}","Kilogram","0","?","{usd}",\n')


def test_china_linhas_brasil_so_escopo_e_sem_agregar(tmp_path):
    p = tmp_path / "downloadData (88).csv"
    _csv_gacc(p, [("202608", "72091691", "5454600", "2,706,248", "Brazil"),
                  ("202608", "72091691", "197400", "106,793", "Brazil"),   # outra província
                  ("202608", "72091691", "1000", "500", "Chile"),          # outro parceiro
                  ("202608", "72104990", "9999", "9,999", "Brazil")])      # fora do escopo
    novos, todos, recentes, consulta = AP.china_linhas([p], {"720916"}, ja_na_aba=set())
    assert list(novos) == ["2026-08"] and recentes == {"2026-08"}
    linhas = novos["2026-08"]
    assert len(linhas) == 2                             # bruto, uma por província
    assert linhas[0][:2] == [202608, 72091691] and linhas[0][5] == 5454600
    assert linhas[0][9] == 2706248                      # US$ sem a vírgula de milhar
    assert AP.vol_china(novos) == {"2026-08": {"720916": pytest.approx(5652.0)}}


def test_vol_secex_por_mes_e_sh6():
    lin = [2026, "08. Agosto", 72091600, "d", 720916, "d", "China", 100, 2_500_000]
    assert AP.vol_secex([lin, lin]) == {"2026-08": {"720916": 5000.0}}


# ─────────────────────────── data da SECEX (ordem dia/mês) ───────────────────────────
def test_confere_datas_secex_pega_mes_e_dia_trocados():
    amostra = {
        2: (2026, "08. Agosto", datetime(2026, 8, 1)),          # certo
        3: (2026, "08. Agosto", datetime(2026, 1, 8)),          # 01/08 lido como 8 de janeiro
        4: (2025, "12. Dezembro", -2146826273),                 # #VALOR! chega como número
        5: (None, None, None),                                  # linha vazia: ignora
    }
    ruins = AP.Planilha._confere_datas_secex(amostra)
    assert [r[0] for r in ruins] == [3, 4]


def test_consulta_e_o_arquivo_inteiro_e_silencia_zero_verdadeiro(tmp_path, capsys):
    """Pull de VÁRIOS meses: código que aparece em algum mês do arquivo estava na
    consulta — a ausência dele em outro mês é zero de verdade, não buraco. Sem isso,
    o pull de jan-ago/2026 da China disparava 36 avisos de 'código sumido'."""
    p = tmp_path / "downloadData (88).csv"
    _csv_gacc(p, [("202607", "72091691", "3000000", "1,500,000", "Brazil"),
                  ("202608", "72081000", "1000000", "480,000", "Brazil")])
    novos, _, _, consulta = AP.china_linhas([p], {"720916", "720810"}, ja_na_aba=set())
    assert consulta["2026-08"] == {"720916", "720810"}
    # histórico: 720916 vinha forte nos 6 meses anteriores e sumiu em agosto
    hist = {f"2026-{m:02d}": {"720916": 3000.0} for m in range(1, 8)}
    AP.avisar_codigos_sumidos("CHINA", hist, "2026-08", consulta["2026-08"])
    assert "720916" not in capsys.readouterr().out          # estava na consulta: zero real
    AP.avisar_codigos_sumidos("CHINA", hist, "2026-08", {"720810"})
    assert "720916" in capsys.readouterr().out              # fora da consulta: avisa
