# -*- coding: utf-8 -*-
"""Testes do robô semanal da paridade de importação do aço (_shared/update_steel_parity.py).

Contexto (23/11/2026): a mesa de dados de M&M ganhou a paridade de importação de HRC e vergalhão (a conta da
planilha do analista). O histórico vem da planilha; o robô acrescenta a sexta-feira que fechou.

O que estes testes travam (números FICTÍCIOS — o repositório é público e o preço de agência é dado pago):
  1. "a sexta que fechou": numa sexta-feira a semana ainda está aberta; no sábado, domingo e segunda é a mesma;
  2. a série do banco ([[unix, valor]…]) vira um valor por dia, e o preço da sexta aceita o último dia útil
     anterior — mas preço velho demais NÃO é repetido (melhor um furo);
  3. a linha nova leva o FOB e o doméstico da semana, o câmbio passado, e frete/seguro/tarifa/AFRMM/porto da
     ÚLTIMA semana gravada;
  4. a conta do prêmio é a da planilha;
  5. PTAX: lê a venda; dia sem cotação (feriado) ou resposta ruim devolvem None, sem estourar;
  6. o robô inteiro: sem a tabela sai sem erro; com a semana já gravada não grava; grava só o que falta, com
     ignore-duplicates (nunca reescreve uma semana); --dry não grava;
  7. o workflow não roda em push (subir o arquivo não dispara nada) e a tabela só é lida por usuário logado.

Rodar:  python -m pytest tests/test_steel_parity.py -q
"""
import datetime as D
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_shared"))
import update_steel_parity as U  # noqa: E402

T0 = 1893456000  # 2030-01-01 00:00 UTC (terça)
LAST = {"product": "hrc", "week": "2029-12-28", "freight": 100.0, "insurance": 0.01, "tariff": 0.10, "afrmm": 0.20, "port": 30.0, "dom_brl": 3900.0}


def day(n):
    return D.date(2030, 1, 1) + D.timedelta(days=n)


def test_sexta_que_fechou():
    assert U.last_friday(D.date(2030, 1, 4)) == D.date(2029, 12, 28)      # sexta: a semana ainda está aberta
    for d in (5, 6, 7, 10):                                                # sábado, domingo, segunda, quinta
        assert U.last_friday(D.date(2030, 1, d)) == D.date(2030, 1, 4)


def test_serie_do_banco_e_preco_da_sexta():
    s = U.series([[T0, 10], [T0 + 3600, 11], [T0 + 2 * 86400, 12], [(T0 + 3 * 86400) * 1000, 13], [T0 + 4 * 86400, None], None])
    assert s == {day(0): 11.0, day(2): 12.0, day(3): 13.0}                 # um por dia (o último); milissegundos também
    assert U.at_or_before(s, day(3), 6) == (13.0, 0)
    assert U.at_or_before(s, day(5), 6) == (13.0, 2)                       # sexta sem preço: o último antes dela
    assert U.at_or_before(s, day(12), 6) == (None, None)                   # velho demais: não repete


def test_linha_da_semana():
    week = day(3)                                                          # sexta 04/01/2030
    fob, dom = {day(3): 500.0}, {day(1): 4000.0}
    r, why = U.build_row("hrc", week, LAST, fob, dom, 5.0)
    assert why is None
    assert r == {"product": "hrc", "week": "2030-01-04", "fob": 500.0, "freight": 100.0, "insurance": 0.01, "tariff": 0.10, "afrmm": 0.20,
                 "port": 30.0, "dom_brl": 4000.0, "fx": 5.0, "source": "robot"}
    assert abs(U.premium(r) - (800 / 716.6 - 1)) < 1e-12                   # CIF 606 + tarifa 60,6 + AFRMM 20 + porto 30 = 716,6
    # doméstico sem avaliação na semana: repete o da última semana gravada
    r2, _ = U.build_row("hrc", week, LAST, fob, {}, 5.0)
    assert r2["dom_brl"] == 3900.0
    # sem FOB da semana, ou sem câmbio: não grava
    assert U.build_row("hrc", week, LAST, {day(-10): 480.0}, dom, 5.0) == (None, "sem FOB na semana")
    assert U.build_row("hrc", week, LAST, fob, dom, None)[0] is None


def test_ptax():
    ok = json.dumps({"value": [{"cotacaoCompra": 5.10, "cotacaoVenda": 5.11, "dataHoraCotacao": "2030-01-04 13:05:00"}]})
    seen = []
    assert U.ptax(D.date(2030, 1, 4), fetch=lambda u: (seen.append(u), ok)[1]) == 5.11
    assert "01-04-2030" in seen[0]                                         # a API quer mês-dia-ano
    assert U.ptax(D.date(2030, 1, 1), fetch=lambda u: json.dumps({"value": []})) is None      # feriado
    assert U.ptax(D.date(2030, 1, 4), fetch=lambda u: "<html>erro</html>") is None

    def boom(u):
        raise OSError("sem rede")
    assert U.ptax(D.date(2030, 1, 4), fetch=boom) is None


class Fake:
    """banco de mentira: registra as chamadas e responde o combinado"""

    def __init__(self, parity, status=200):
        self.parity, self.status, self.calls = parity, status, []

    def __call__(self, method, path, body=None, prefer=None):
        self.calls.append((method, path.split("?")[0], body, prefer))
        if path.startswith("steel_parity") and method == "GET":
            return self.status, (self.parity if self.status == 200 else "not found")
        if path.startswith("commodities"):
            d = [[T0 + 3 * 86400, 500], [T0 + 10 * 86400, 510]]
            return 200, [{"code": c, "daily": (d if "BRAZIL" not in c else [[T0 + 9 * 86400, 4100]])} for c in ("HRC_CHINA", "HRC_BRAZIL", "REBAR_TURKEY", "REBAR_BRAZIL")]
        if path.startswith("macro_indicators"):
            return 200, [{"code": "USD_BRL", "value": 5.3}]
        return 201, None


def run(monkeypatch, fake, today, argv=(), ptax=5.2):
    class Now(D.datetime):
        @classmethod
        def now(cls, tz=None):
            return D.datetime(today.year, today.month, today.day, 15, 0, tzinfo=D.timezone.utc)
    monkeypatch.setattr(U.D, "datetime", Now)
    monkeypatch.setattr(U, "_call", fake)
    monkeypatch.setattr(U, "ptax", lambda d, fetch=None: ptax)
    return U.main(list(argv))


def test_robo_sem_tabela_sai_sem_erro(monkeypatch, capsys):
    f = Fake(None, status=404)
    assert run(monkeypatch, f, D.date(2030, 1, 12)) == 0
    assert [c[0] for c in f.calls] == ["GET"]
    assert "supabase_market_prices.sql" in capsys.readouterr().out


def test_robo_grava_so_o_que_falta(monkeypatch, capsys):
    rows = [dict(LAST, product="hrc", week="2030-01-11"), dict(LAST, product="rebar", week="2030-01-04")]   # hrc já tem a semana; rebar não
    f = Fake(rows)
    assert run(monkeypatch, f, D.date(2030, 1, 12)) == 0                   # sábado → a sexta que fechou é 11/01
    post = [c for c in f.calls if c[0] == "POST"]
    assert len(post) == 1 and post[0][1] == "steel_parity"
    assert "ignore-duplicates" in post[0][3]                               # nunca reescreve uma semana que já existe
    body = post[0][2]
    assert [(r["product"], r["week"], r["fob"], r["dom_brl"], r["fx"]) for r in body] == [("rebar", "2030-01-11", 510.0, 4100.0, 5.2)]
    assert body[0]["freight"] == 100.0 and body[0]["tariff"] == 0.10 and body[0]["source"] == "robot"
    assert "rebar: semana de 2030-01-11" in capsys.readouterr().out


def test_robo_semana_ja_gravada_e_simulacao(monkeypatch):
    f = Fake([dict(LAST, product="hrc", week="2030-01-11"), dict(LAST, product="rebar", week="2030-01-11")])
    assert run(monkeypatch, f, D.date(2030, 1, 13)) == 0
    assert [c[0] for c in f.calls] == ["GET"]                              # nada a buscar nem a gravar
    f = Fake([dict(LAST, product="hrc", week="2030-01-04"), dict(LAST, product="rebar", week="2030-01-04")])
    assert run(monkeypatch, f, D.date(2030, 1, 12), argv=["--dry"]) == 0
    assert not [c for c in f.calls if c[0] == "POST"]                      # --dry não grava


def test_robo_sem_ptax_usa_o_cambio_da_dashboard(monkeypatch):
    f = Fake([dict(LAST, product="hrc", week="2030-01-04"), dict(LAST, product="rebar", week="2030-01-11")])
    assert run(monkeypatch, f, D.date(2030, 1, 12), ptax=None) == 0        # feriado na sexta, robô rodando no sábado
    body = [c for c in f.calls if c[0] == "POST"][0][2]
    assert body[0]["fx"] == 5.3


def test_workflow_e_sql():
    wf = (ROOT / ".github" / "workflows" / "update_steel_parity.yml").read_text(encoding="utf-8")
    assert "push:" not in wf and "workflow_dispatch" in wf and "schedule" in wf
    assert "_shared/update_steel_parity.py" in wf and "SUPABASE_SERVICE_KEY" in wf
    sql = (ROOT / "admin" / "supabase_market_prices.sql").read_text(encoding="utf-8")
    assert "enable row level security" in sql and "to authenticated" in sql
    assert "from public, anon" in sql                                       # anônimo não chama a função
    assert "for insert" not in sql and "for update" not in sql and "for all" not in sql   # ninguém além da chave de serviço grava
    # o histórico diário (price_history) segue a mesma regra, e a função de leitura não é aberta ao anônimo
    assert "create table if not exists public.price_history" in sql and "price_history_read" in sql
    assert "get_price_history(text[]) from public, anon" in sql and "stable" in sql
