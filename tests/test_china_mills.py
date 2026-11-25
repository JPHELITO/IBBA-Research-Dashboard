# -*- coding: utf-8 -*-
"""Testes do robô semanal das usinas chinesas (_shared/update_china_mills.py).

Contexto (25/11/2026): a mesa de dados de M&M ganhou a aba Steel › China mills — a pesquisa semanal da Mysteel com 247
usinas (% com lucro, altos-fornos ligados, utilização da capacidade e gusa por dia). O histórico veio da planilha do
analista; o robô acrescenta o boletim de cada sexta, lendo a página pública da Mysteel.

O que estes testes travam (páginas e números FICTÍCIOS — o repositório é público e a Mysteel é agência paga):
  1. os quatro números saem do resumo do boletim, com ou sem espaço entre a palavra e o número, e a % que vem DEPOIS
     ("环比减少0.32个百分点") não é confundida com o nível;
  2. número fora da faixa plausível é descartado (melhor um furo que um número errado); o menu do site, que também
     tem "高炉开工率" sem número, não atrapalha;
  3. a lista da Mysteel vira [(data do boletim, link)], só com os boletins de altos-fornos, sem repetir data;
  4. a semana é a sexta-feira da mesma semana (boletim de quarta em feriado → a sexta seguinte);
  5. a gusa é gravada em kt/dia (万吨 × 10);
  6. o robô inteiro: sem a tabela sai sem erro; grava só o que é mais novo que o último boletim, com ignore-duplicates;
     --dry não grava; boletim sem a % de lucro não é gravado; sem nada novo e com o dado velho, avisa (código 1);
  7. o workflow não roda em push; a tabela não tem leitura direta e a função só responde a admin ou com a chave ligada.

Rodar:  python -m pytest tests/test_china_mills.py -q
"""
import datetime as D
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_shared"))
import update_china_mills as U  # noqa: E402

MENU = '<nav><a href="/x">高炉开工率</a><a href="/y">高炉铁水产量</a><a href="/z">盈利率</a></nav>'


def page(d="20300104", op="70.10", util="80.20", prof="50.30", hm="200.40", sp=" "):
    return (MENU + f'<h2 class="content-title" id="content-title">Mysteel数据：钢厂高炉检修调查统计（{d}）</h2>'
            f"<p>Mysteel调研247家钢厂高炉开工率{sp}{op}%，环比减少0.32个百分点；高炉炼铁产能利用率{util}%，环比增加1.5个百分点；"
            f"钢厂盈利率{prof}%，同比减少28.57个百分点；日均铁水产量{sp}{hm}万吨，环比减少1.18万吨。</p>")


def listing(items):
    return "<ul>" + "".join(f'<li><a href="{u}" target="_blank">{t}</a></li>' for t, u in items) + "</ul>"


def test_quatro_numeros():
    v = U.parse_bulletin(page())
    assert v == {"bf_operating_pct": 70.10, "bf_util_pct": 80.20, "profitable_pct": 50.30, "hot_metal_10kt": 200.40}
    assert U.parse_bulletin(page(sp="")) == v                       # sem espaço
    assert U.title_date(page()) == "2030-01-04"


def test_faixa_plausivel_e_menu():
    v = U.parse_bulletin(page(util="180.2", hm="20.4"))              # utilização > 100% e gusa absurda: fora
    assert "bf_util_pct" not in v and "hot_metal_10kt" not in v and v["profitable_pct"] == 50.30
    assert U.parse_bulletin(MENU) == {}                              # só o menu, sem número nenhum
    assert U.parse_bulletin(page(prof="0.87"))["profitable_pct"] == 0.87   # lucro quase zero é plausível (ago/2024 foi 1%)


def test_so_a_frase_das_247_usinas():
    """as outras pesquisas da MESMA página (minas, Tangshan, 163 usinas, borracha) não entram — eram os saltos de 2022–2023"""
    outras = ("<p>国内矿山产能利用率65.48%，高炉产能利用率90.14%</p>"                       # tabela: minas e uma linha sem amostra
              "<p>需求端唐山钢厂调研样本铁水产量环比上涨0.45万吨至36.8万吨，高炉开工率77.23%。</p>"   # Tangshan
              "<p>中国丁苯橡胶产能利用率64.55%。</p>")                                          # borracha
    v = U.parse_bulletin(outras + page())
    assert v == {"bf_operating_pct": 70.10, "bf_util_pct": 80.20, "profitable_pct": 50.30, "hot_metal_10kt": 200.40}
    assert U.parse_bulletin(outras) == {}                            # sem a frase das 247 usinas: nada
    velha = ("<p>Mysteel调研247家钢厂高炉开工率57.94%，环比下降21.74%；高炉炼铁产能利用率81.01%；日均铁水产量215.63万吨。"
             "Mysteel调研163家钢厂高炉开工率41.99%，产能利用率51.01%。</p>")
    assert U.parse_bulletin(velha) == {"bf_operating_pct": 57.94, "bf_util_pct": 81.01, "hot_metal_10kt": 215.63}
    # resumo do topo (IA) discordando do texto do boletim: vale o que aparece mais vezes; no empate, o texto (o último)
    resumo = "<p>Mysteel调研247家钢厂，高炉开工率71.00%，产能利用率80.20%。</p>"
    assert U.parse_bulletin(resumo + page())["bf_operating_pct"] == 70.10
    # a frase das COQUERIAS da mesma amostra (焦炭… 产能利用率) não é a utilização dos altos-fornos
    coque = "<p>本周Mysteel统计全国247家钢厂样本：焦炭日均产量46.55增0.40，产能利用率86.24%增0.74%。</p>"
    assert U.parse_bulletin(page() + coque)["bf_util_pct"] == 80.20
    # relatório que repete a frase da semana ANTERIOR (sem a % de lucro): manda a frase com o lucro conhecido
    antes = "<p>247家钢厂高炉开工率69.00%，环比上周增加0.73个百分点；日均铁水产量199.00万吨。</p>"
    v = U.parse_bulletin(page() + antes, expect=50.30)
    assert v["bf_operating_pct"] == 70.10 and v["hot_metal_10kt"] == 200.40
    outra_semana = page(op="69.00", prof="48.00", hm="199.00")       # a frase de outra semana COM lucro diferente: fora
    assert U.parse_bulletin(outra_semana + page(), expect=50.30)["bf_operating_pct"] == 70.10
    # palavra repetida antes do número ("高炉开工率高炉开工率76.25%") e o primeiro número fora da faixa
    assert U.parse_bulletin("<p>247家钢厂高炉开工率高炉开工率76.25%；高炉炼铁产能利用率180%；产能利用率81.08%。</p>") == {"bf_operating_pct": 76.25, "bf_util_pct": 81.08}


def test_lista():
    html = listing([("Mysteel数据：钢厂高炉检修调查统计（20300111）", "https://tks.mysteel.com/datas/a/30011108/AAA.html"),
                    ("Mysteel数据：进口铁矿石港口库存调查统计（20300111）", "https://tks.mysteel.com/datas/a/30011108/BBB.html"),
                    ("Mysteel数据：钢厂高炉检修调查统计（20300104）", "//tks.mysteel.com/datas/a/30010408/CCC.html"),
                    ("Mysteel数据：钢厂高炉检修调查统计（20300104）", "/datas/a/30010408/DDD.html")])
    assert U.parse_listing(html) == [("2030-01-04", "https://tks.mysteel.com/datas/a/30010408/CCC.html"),
                                     ("2030-01-11", "https://tks.mysteel.com/datas/a/30011108/AAA.html")]


def test_semana_e_gusa():
    assert U.friday_of("2030-01-04") == "2030-01-04"                 # sexta
    assert U.friday_of("2030-01-02") == "2030-01-04"                 # quarta (feriado) → a sexta da mesma semana
    assert U.friday_of("2030-01-05") == "2030-01-04"                 # sábado → a sexta anterior
    r = U.build_row("2030-01-02", "https://x", {"profitable_pct": 50.3, "hot_metal_10kt": 200.43})
    assert r["week"] == "2030-01-04" and r["obs_date"] == "2030-01-02" and r["hot_metal_kt"] == 2004.3
    assert r["bf_util_pct"] is None and r["source"] == "robot" and r["source_kind"] == "mysteel"


def test_decode_gbk():
    raw = ('<meta charset="gbk">' + page()).encode("gbk")
    assert U.parse_bulletin(U.decode(raw))["profitable_pct"] == 50.30


class Fake:
    def __init__(self, last, status=200):
        self.last, self.status, self.calls = last, status, []

    def __call__(self, method, path, body=None, prefer=None):
        self.calls.append((method, path, body, prefer))
        if method == "GET":
            return (self.status, [{"week": U.friday_of(self.last), "obs_date": self.last}] if self.last else []) if self.status == 200 else (self.status, "no table")
        return 201, None


def run(monkeypatch, fake, pages, today, argv=()):
    monkeypatch.setattr(U, "_call", fake)
    monkeypatch.setattr(U.time, "sleep", lambda s: None)
    monkeypatch.setattr(U, "LISTS", ["L"])

    def get(url, **k):
        if url not in pages:
            raise RuntimeError("sem resposta")
        return pages[url].encode("utf-8")
    monkeypatch.setattr(U, "fetch", get)
    monkeypatch.setattr(U.D, "datetime", type("FakeDT", (D.datetime,), {"now": classmethod(lambda c, tz=None: D.datetime(today.year, today.month, today.day, 12, tzinfo=D.timezone.utc))}))
    return U.main(list(argv))


PAGES = {"L": listing([("Mysteel数据：钢厂高炉检修调查统计（20300104）", "https://tks.mysteel.com/datas/a/3001/A1.html"),
                       ("Mysteel数据：钢厂高炉检修调查统计（20300111）", "https://tks.mysteel.com/datas/a/3001/B1.html"),
                       ("Mysteel数据：钢厂高炉检修调查统计（20300118）", "https://tks.mysteel.com/datas/a/3001/C1.html")]),
         "https://tks.mysteel.com/datas/a/3001/A1.html": page("20300104"), "https://tks.mysteel.com/datas/a/3001/B1.html": page("20300111", prof="40.1"), "https://tks.mysteel.com/datas/a/3001/C1.html": page("20300118", prof="30.2")}


def test_robo_grava_so_o_novo(monkeypatch):
    f = Fake("2030-01-04")
    assert run(monkeypatch, f, PAGES, D.date(2030, 1, 19)) == 0
    posts = [c for c in f.calls if c[0] == "POST"]
    assert len(posts) == 1 and posts[0][3] == "resolution=ignore-duplicates,return=minimal" and "on_conflict=week" in posts[0][1]
    assert [r["obs_date"] for r in posts[0][2]] == ["2030-01-11", "2030-01-18"]
    assert [r["profitable_pct"] for r in posts[0][2]] == [40.1, 30.2]


def test_robo_dry_sem_tabela_e_sem_lucro(monkeypatch):
    f = Fake("2030-01-04")
    assert run(monkeypatch, f, PAGES, D.date(2030, 1, 19), ["--dry"]) == 0
    assert not [c for c in f.calls if c[0] == "POST"]
    f = Fake(None, status=404)                                       # SQL não rodado
    assert run(monkeypatch, f, PAGES, D.date(2030, 1, 19)) == 0 and not [c for c in f.calls if c[0] == "POST"]
    sem = dict(PAGES, **{"https://tks.mysteel.com/datas/a/3001/C1.html": page("20300118").replace("盈利率", "利润")})
    f = Fake("2030-01-11")
    assert run(monkeypatch, f, sem, D.date(2030, 1, 19)) == 0       # dado em dia (8 dias): só aviso
    assert not [c for c in f.calls if c[0] == "POST"]


def test_lista_vazia_e_problema(monkeypatch):
    monkeypatch.setattr(U.time, "sleep", lambda s: None)
    monkeypatch.setattr(U, "LISTS", ["L"])
    rows, probs = U.new_rows("2030-01-04", get=lambda u, **k: b"<html>verifique que voce nao e um robo</html>")
    assert rows == [] and len(probs) == 1 and "sem nenhum boletim" in probs[0]


def test_robo_amostra_nova(monkeypatch):
    """se a Mysteel mudar a amostra (ex.: 250 usinas), o robô lê com a amostra nova e avisa"""
    monkeypatch.setattr(U.time, "sleep", lambda s: None)
    monkeypatch.setattr(U, "LISTS", ["L"])
    pages = {"L": PAGES["L"], "https://tks.mysteel.com/datas/a/3001/C1.html": page("20300118", prof="30.2").replace("247家", "250家")}
    get = lambda u, **k: pages[u].encode("utf-8") if u in pages else (_ for _ in ()).throw(RuntimeError("x"))
    rows, probs = U.new_rows("2030-01-11", get=get)
    assert [r["profitable_pct"] for r in rows] == [30.2] and any("250 usinas" in p for p in probs)


def test_robo_avisa_quando_o_dado_envelhece(monkeypatch):
    f = Fake("2030-01-18")
    assert run(monkeypatch, f, {"L": "<html>fora do ar</html>"}, D.date(2030, 1, 23)) == 0    # 5 dias: normal
    assert run(monkeypatch, f, {}, D.date(2030, 2, 2)) == 1                                   # 15 dias sem boletim novo: erro


def test_workflow_e_sql():
    wf = (ROOT / ".github" / "workflows" / "update_china_mills.yml").read_text(encoding="utf-8")
    assert "push:" not in wf and "workflow_dispatch" in wf and "schedule" in wf
    assert "_shared/update_china_mills.py" in wf and "SUPABASE_SERVICE_KEY" in wf
    sql = (ROOT / "admin" / "supabase_china_mills.sql").read_text(encoding="utf-8")
    assert "enable row level security" in sql and "create policy" not in sql            # sem leitura direta para ninguém
    assert "get_china_mills() from public, anon" in sql and "public.is_admin()" in sql
    assert "key = 'china_mills' and enabled" in sql and "('china_mills'" in sql and "false)" in sql   # a chave nasce desligada
