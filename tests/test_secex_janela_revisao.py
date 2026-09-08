# -*- coding: utf-8 -*-
"""Testes da JANELA DE REVISÃO do SECEX (updater_sm.py).

Contexto (08/09/2026): o updater gravava só o mês novo (`only_after=latest_in_db`), então
toda revisão do MDIC em mês já publicado era descartada em silêncio — a dash congelava no
1º número divulgado. Medido: a exportação de revestidos p/ a Argentina em 2026-04 estava
69,84 kt na dash contra 25,88 kt na fonte (−63%).

O que estes testes travam:
  1. mês novo entra;
  2. número que MUDOU na fonte é regravado (a revisão que antes se perdia);
  3. número IGUAL não é tocado — nem o `updated_at`. Isso importa de verdade: reescrever
     linha igual mudaria o .db a cada rodada e o robô commitaria todos os dias à toa;
  4. linha que sumiu da fonte sai do banco (não fica número fantasma);
  5. --reconcile (dry_run) não escreve NADA, só relata.

Rodar:  python -m pytest tests/test_secex_janela_revisao.py -q
"""
import os
import sqlite3
import sys

import pytest

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, "..", "Steel and Mining"))
import updater_sm as U  # noqa: E402


def _linha(period, direction, cat, country, kt, usd):
    """Linha no formato que _aggregate_df devolve (com o carimbo de tempo no fim)."""
    return (period, direction, cat, country, kt, usd, U.NOW)


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    U.init_tables(c)
    return c


def _grava(c, *linhas):
    U.upsert_country(c, [(*l[:6], "2026-01-01T00:00:00") for l in linhas])


def _le(c, period, direction, cat, country):
    return c.execute(
        "SELECT volume_ktons, revenue_usd_mn, updated_at FROM secex_country "
        "WHERE period=? AND direction=? AND category=? AND country=?",
        (period, direction, cat, country)).fetchone()


class TestSincronizaCountry:
    def test_mes_novo_entra(self, conn):
        _grava(conn, _linha("2026-07", "imp", "crc", "China", 21.2, 16.0))
        novas, revs, rem, mexidos = U._sincroniza_country(conn, [
            _linha("2026-07", "imp", "crc", "China", 21.2, 16.0),
            _linha("2026-08", "imp", "crc", "China", 46.9, 32.3),
        ], "imp")
        assert (novas, revs, rem) == (1, 0, 0)
        assert mexidos == {"2026-08"}
        assert _le(conn, "2026-08", "imp", "crc", "China")[0] == 46.9

    def test_revisao_em_mes_ja_publicado_e_aplicada(self, conn):
        """O caso Argentina: a fonte corrigiu o número de um mês antigo."""
        _grava(conn, _linha("2026-04", "exp", "coated", "Argentina", 69.839511, 60.0))
        novas, revs, rem, mexidos = U._sincroniza_country(conn, [
            _linha("2026-04", "exp", "coated", "Argentina", 25.882, 22.0),
        ], "exp")
        assert (novas, revs, rem) == (0, 1, 0)
        assert mexidos == {"2026-04"}
        assert _le(conn, "2026-04", "exp", "coated", "Argentina")[0] == 25.882

    def test_numero_igual_nao_e_tocado(self, conn):
        """Sem isto o .db mudaria toda rodada e o robô commitaria diariamente à toa."""
        _grava(conn, _linha("2026-07", "imp", "crc", "China", 21.2, 16.0))
        antes = _le(conn, "2026-07", "imp", "crc", "China")[2]
        novas, revs, rem, mexidos = U._sincroniza_country(conn, [
            _linha("2026-07", "imp", "crc", "China", 21.2, 16.0),
        ], "imp")
        assert (novas, revs, rem, mexidos) == (0, 0, 0, set())
        assert _le(conn, "2026-07", "imp", "crc", "China")[2] == antes

    def test_diferenca_so_na_receita_tambem_conta_como_revisao(self, conn):
        _grava(conn, _linha("2026-07", "imp", "crc", "China", 21.2, 16.0))
        _, revs, _, _ = U._sincroniza_country(conn, [
            _linha("2026-07", "imp", "crc", "China", 21.2, 18.5),
        ], "imp")
        assert revs == 1

    def test_linha_que_sumiu_da_fonte_sai_do_banco(self, conn):
        # 20 países p/ o sumiço de 1 ficar sob a trava de sumiço em massa (ver a classe
        # TestTravaSumicoEmMassa) — com 2 linhas, apagar 1 seria 50% e a trava barraria.
        base = [_linha("2026-07", "imp", "crc", f"P{i}", 1.0, 1.0) for i in range(19)]
        _grava(conn, *base, _linha("2026-07", "imp", "crc", "Fantasma", 5.0, 4.0))
        novas, revs, rem, mexidos = U._sincroniza_country(conn, base, "imp")
        assert (novas, revs, rem) == (0, 0, 1)
        assert _le(conn, "2026-07", "imp", "crc", "Fantasma") is None
        assert mexidos == {"2026-07"}

    def test_nao_encosta_em_periodo_fora_da_janela(self, conn):
        """A janela é definida pelos períodos que chegam em `rows`; o resto é intocável."""
        _grava(conn, _linha("2019-05", "imp", "crc", "China", 99.0, 80.0))
        U._sincroniza_country(conn, [_linha("2026-08", "imp", "crc", "China", 46.9, 32.3)], "imp")
        assert _le(conn, "2019-05", "imp", "crc", "China")[0] == 99.0

    def test_outra_direcao_nao_e_afetada(self, conn):
        _grava(conn, _linha("2026-07", "exp", "crc", "China", 7.0, 6.0))
        U._sincroniza_country(conn, [_linha("2026-07", "imp", "crc", "China", 21.2, 16.0)], "imp")
        assert _le(conn, "2026-07", "exp", "crc", "China")[0] == 7.0

    def test_dry_run_nao_escreve_nada(self, conn):
        """É o modo --reconcile: relata a divergência sem mexer na base."""
        enchimento = [_linha("2026-04", "exp", "coated", f"P{i}", 1.0, 1.0) for i in range(18)]
        _grava(conn, *enchimento,
               _linha("2026-04", "exp", "coated", "Argentina", 69.839511, 60.0),
               _linha("2026-04", "exp", "coated", "Fantasma", 1.0, 1.0))
        novas, revs, rem, _ = U._sincroniza_country(conn, enchimento + [
            _linha("2026-04", "exp", "coated", "Argentina", 25.882, 22.0),
            _linha("2026-04", "exp", "coated", "Peru", 3.0, 2.0),
        ], "exp", dry_run=True)
        assert (novas, revs, rem) == (1, 1, 1)          # relata os três casos
        assert _le(conn, "2026-04", "exp", "coated", "Argentina")[0] == 69.839511
        assert _le(conn, "2026-04", "exp", "coated", "Peru") is None
        assert _le(conn, "2026-04", "exp", "coated", "Fantasma") is not None

    def test_forcar_reescreve_ate_o_que_esta_igual(self, conn):
        _grava(conn, _linha("2026-07", "imp", "crc", "China", 21.2, 16.0))
        novas, revs, rem, mexidos = U._sincroniza_country(conn, [
            _linha("2026-07", "imp", "crc", "China", 21.2, 16.0),
        ], "imp", forcar=True)
        assert (novas, revs, rem) == (0, 0, 0)
        assert mexidos == {"2026-07"}                    # gravou mesmo sem mudança
        assert _le(conn, "2026-07", "imp", "crc", "China")[2] == U.NOW


class TestSincronizaImportPrediction:
    def test_revisao_na_linha_laranja(self, conn):
        U.upsert_import_prediction(conn, [("2026-04", "CRC", "China", 1_000.0, 500.0, "x")])
        novas, revs, mexidos = U._sincroniza_import_prediction(
            conn, [("2026-04", "CRC", "China", 1_200.0, 600.0, U.NOW)])
        assert (novas, revs) == (0, 1)
        assert mexidos == {"2026-04"}
        assert conn.execute(
            "SELECT value_usd FROM import_prediction WHERE period='2026-04'").fetchone()[0] == 1200.0

    def test_igual_nao_e_tocado(self, conn):
        U.upsert_import_prediction(conn, [("2026-04", "CRC", "China", 1_000.0, 500.0, "x")])
        novas, revs, mexidos = U._sincroniza_import_prediction(
            conn, [("2026-04", "CRC", "China", 1_000.0, 500.0, U.NOW)])
        assert (novas, revs, mexidos) == (0, 0, set())
        assert conn.execute(
            "SELECT updated_at FROM import_prediction WHERE period='2026-04'").fetchone()[0] == "x"


class TestJanelaAnos:
    def test_padrao_pega_o_ano_corrente_e_o_anterior(self):
        anos = U._janela_anos()
        assert len(anos) == U.REVISE_YEARS
        assert anos[-1] == U.datetime.utcnow().year
        assert anos == sorted(anos)

    def test_janela_explicita(self):
        assert U._janela_anos(4)[-1] == U.datetime.utcnow().year
        assert len(U._janela_anos(4)) == 4


class TestTravaSumicoEmMassa:
    """Um CSV cortado no meio não pode APAGAR as linhas boas do resto do ano.

    O MDIC corta a conexão em arquivo grande (visto em 08/09/2026: 13,5 MB de 120 MB
    no IMP_2026). A conferência de Content-Length pega o caso comum; esta trava é a
    segunda linha de defesa, para o CSV que chega truncado E ainda assim é parseável.
    """

    def test_sumico_grande_nao_apaga_nada(self, conn):
        _grava(conn, *[_linha("2026-07", "imp", "crc", f"P{i}", 1.0, 1.0) for i in range(20)])
        novas, revs, rem, _ = U._sincroniza_country(conn, [
            _linha("2026-07", "imp", "crc", "P0", 1.0, 1.0),
        ], "imp")
        assert rem == 0                                   # recusou apagar
        assert conn.execute("SELECT COUNT(*) FROM secex_country").fetchone()[0] == 20

    def test_sumico_pequeno_apaga_normalmente(self, conn):
        _grava(conn, *[_linha("2026-07", "imp", "crc", f"P{i}", 1.0, 1.0) for i in range(20)])
        vivos = [_linha("2026-07", "imp", "crc", f"P{i}", 1.0, 1.0) for i in range(19)]
        novas, revs, rem, _ = U._sincroniza_country(conn, vivos, "imp")
        assert rem == 1                                   # 5% <= 10%: apaga
        assert conn.execute("SELECT COUNT(*) FROM secex_country").fetchone()[0] == 19


class TestFalhaDeDownloadNaoViraAprovacao:
    """--reconcile sem conseguir baixar o CSV NÃO pode dizer "está tudo certo".

    Foi o defeito pego no próprio smoke test desta rodada: com os 4 downloads
    falhando, o modo auditoria imprimia "dash idêntica ao MDIC" e saía 0 — silêncio
    virando aprovação, exatamente o padrão que este updater existe para matar.
    """

    def test_reconcile_falha_quando_o_mdic_nao_entrega(self, conn, monkeypatch):
        monkeypatch.setattr(U, "_download_mdic_year", lambda *a, **k: None)
        monkeypatch.setattr(U, "fetch_pais_lookup", lambda: {})
        monkeypatch.setattr(U, "fetch_urf_lookup", lambda: {})
        diverge, _ = U.update_from_mdic(conn, anos=[2026], dry_run=True)
        assert diverge is True          # -> main() sai 1 -> job VERMELHO

    def test_update_com_falha_parcial_nao_derruba(self, conn, monkeypatch, capsys):
        """No modo de gravar, o que baixou já foi gravado e PRECISA ser commitado."""
        monkeypatch.setattr(U, "_download_mdic_year", lambda *a, **k: None)
        monkeypatch.setattr(U, "fetch_pais_lookup", lambda: {})
        monkeypatch.setattr(U, "fetch_urf_lookup", lambda: {})
        mudou, _ = U.update_from_mdic(conn, anos=[2026])
        assert mudou is False
        assert "::warning::" in capsys.readouterr().out


class TestJanelaDeArmazenagemDasSH6:
    """As duas janelas são diferentes DE PROPÓSITO — e o cliente não depende de nenhuma.

    Medido em 08/09/2026: secex_sh6_country + secex_sh6_urf pesavam 12,8 MB dos 47,5 MB
    do arquivo (27%) e ninguém as desenha. Encurtar a janela de armazenagem de 6 para 3
    anos devolveu 5,6 MB — o .db saiu de 47,5 para 41,9, com o portão do sql.js em 50.
    """

    def test_armazenagem_e_mais_curta_que_a_janela_do_top15(self):
        # Se alguém igualar as duas, o arquivo volta a crescer 5,6 MB sem querer.
        assert U.SH6_FROM > U.RECENT_FROM

    def test_top15_continua_lendo_seis_anos(self):
        """Janela longa mantém a lista de países ESTÁVEL: país que entra e sai do top-15
        faz o _sincroniza_sh6 reescrever a janela inteira e engorda o arquivo à toa."""
        assert int(U.RECENT_FROM[:4]) == U.datetime.utcnow().year - 6

    def test_o_cliente_nao_recebe_as_tabelas_sh6(self):
        """É isto que torna o encurtamento grátis: elas não vão no banco do cliente."""
        import importlib.util
        import os
        caminho = os.path.join(os.path.dirname(U.__file__), "build_web_db.py")
        spec = importlib.util.spec_from_file_location("build_web_db", caminho)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        assert "secex_sh6_country" not in mod.WEB_TABLES
        assert "secex_sh6_urf" not in mod.WEB_TABLES
