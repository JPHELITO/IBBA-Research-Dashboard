# Stock Guide — contrato de upload do modelo de equity research (.xlsm)

> Como a dashboard ingere o arquivo **"Stock Guide - Natural Resources 2026.xlsm"** para
> manter um Stock Guide dinâmico: **estimativas** vêm do upload, **preço/múltiplos** são
> recalculados AO VIVO no navegador com a cotação da aba **Market** (`quotes`).
>
> Validado contra o arquivo real (jun/2026): recomputar EV/EBITDA · Net Debt/EBITDA · P/CE ·
> Div Yield a partir dos campos abaixo **reproduz exatamente** a aba "Summary" do modelo nas
> 14 empresas cobertas. Script de prova: ver histórico da sessão (extract+validate → ALL GREEN).

## 1. Universo (14 abas → tickers da aba Market)

| Aba no Excel | yahoo_symbol (`quotes`) | Setor | Moeda negociação |
|---|---|---|---|
| VALE | VALE3.SA | iron_ore | BRL |
| CSN | CSNA3.SA | steel | BRL |
| CSN MINERACAO | CMIN3.SA | iron_ore | BRL |
| GERDAU | GGBR4.SA | steel | BRL |
| USIMINAS | USIM5.SA | steel | BRL |
| KLABIN | KLBN11.SA | pulp_paper | BRL |
| SUZANO | SUZB3.SA | pulp_paper | BRL |
| IRANI | RANI3.SA | pulp_paper | BRL |
| AURA | AUGO | gold | USD |
| SOUTHERN COPPER | SCCO | copper | USD |
| TERNIUM | TX | steel | USD |
| CMPC | CMPC.SN | pulp_paper | CLP |
| COPEC | COPEC.SN | pulp_paper | CLP |
| GRUPO MEXICO | GMEXICOB.MX | copper | MXN |

**CBA fica de fora** (alumínio não é cobertura). Abas de Cement, Peers, BBG* e os índices são ignoradas.

## 2. Onde cada campo está em CADA aba de empresa

A estrutura é **idêntica** nas 14 abas. Endereçar pelos **rótulos da coluna B** (robusto a
inserção de linhas), com a regra de bloco abaixo. Anos: estimativas em colunas FIXAS
**T (20) = 2026E** e **U (21) = 2027E** (mesmo no Copec, que começa em 2013 sem desalinhar).

### Bloco-cabeçalho (linhas ~5–11), valor na coluna C
| Campo dashboard | Rótulo (col B) começa com |
|---|---|
| ticker (local) | `Stock Ticker` |
| recommendation | `Analyst Recommend` (OP/MP/UP) |
| target_price (moeda local) | `Target Price` |
| price_local (snapshot do modelo) | `Share Price` |
| shares_outstanding | `Shares Outstanding` |
| mktcap_base (snapshot, moeda-base) | `Market Capitaliz` **no bloco-série (linhas 13–20)** |

### Estimativas — bloco de ABSOLUTOS (linhas 36–41), colunas T/U
> ⚠️ Buscar SÓ neste bloco (linha > 35). Antes dele há as RAZÕES — "EV/EBITDA (x)",
> "Net Debt/EBITDA (x)", "OCF Yield (%)" — que NÃO devem ser lidas como absolutos.

| Campo dashboard | Rótulo (col B, linha > 35) começa com |
|---|---|
| net_revenues_y1/y2 | `Net Revenues` |
| ebitda_y1/y2 | `EBITDA` |
| net_income_y1/y2 | `Net Income` |
| net_debt_y1/y2 | `Net Debt` |
| ocf_y1/y2 | `OCF` |
| capex_y1/y2 | `CAPEX` |

### Estimativas — bloco-série (linhas 13–27), colunas T/U
| Campo dashboard | Rótulo (col B) começa com |
|---|---|
| cash_earnings_y1/y2 (numerador do P/CE) | `Cash Earnings` |
| dividends_y1/y2 (total, p/ Div Yield) | `Dividend` (linha 13–27 = "Dividends/Int. on Capital") |
| ev_adjustment_y1/y2 (ponte p/ EV) | `Adjustments` |

## 3. Moeda — sem hardcode: 2 fatores capturados do modelo

Alguns nomes negociam em BRL/CLP/MXN mas o modelo reporta em **USD** (Vale, Copec, CMPC,
Grupo México). Em vez de adivinhar, capturamos do próprio arquivo:

```
fx_to_base = mktcap_base_modelo / (price_local × shares)     # = 1 quando base == negociação
fx_to_usd  = mktcap_usd_modelo  / (price_local × shares)     # p/ a coluna "Mkt Cap US$mn"
```
`mktcap_usd_modelo` vem da aba **Stock Guide** (linha "Market Capitalization (USD million)"),
ou do bloco de câmbio dela (linha 8: BRL/USD, CLP/USD, MXN/USD…). `base_ccy`/`trade_ccy` são
rótulos cosméticos.

## 4. Recompute AO VIVO (no navegador, a cada preço novo)

```
preço            = quotes[yahoo_symbol].price          # aba Market
mktcap_base      = preço × shares × fx_to_base
mktcap_usd       = preço × shares × fx_to_usd
EV_base          = mktcap_base + net_debt + ev_adjustment
EV/EBITDA        = EV_base / ebitda
Net Debt/EBITDA  = net_debt / ebitda                   # SEM preço → 100% estimativa
P/CE             = mktcap_base / cash_earnings
Dividend Yield   = dividends / mktcap_base             # ≡ DPS / preço
Upside           = target_price / preço − 1
Performance 1M/3M/1Y = da própria aba Market (quotes.daily/intraday)
```
**Resolução do símbolo** tolerante a `.SA` (helper `_short`): aceita 'VALE3' ou 'VALE3.SA'.

(Opcional futuro: sobrescrever `fx` com o **USD/BRL ao vivo** de `macro_indicators` p/ Vale +
coluna US$ dos nomes BRL. CLP/MXN seguem no snapshot até o backend adicionar esses pares.)

## 5. Tratamento de erros e quirks (o parser DEVE)
- `#REF!`, `#VALUE!`, `#N/A`, `n.a.`, vazio → **null** (não quebrar a empresa).
- Target Price gravado como **texto com vírgula** ("7,000" / "1,110" no Copec/CMPC) → limpar
  vírgula e ler como número (senão upside fica −99,9%, bug que a Summary carrega hoje).
- **Aura**: o mktcap em US$ do modelo parece estar em BRL (≈R$5.309mn, não US$). Os múltiplos
  validam (consistência interna), mas a coluna "Mkt Cap US$" da Aura precisa de conferência.
- Preserva `is_visible` (o upload nunca muda visibilidade — só o admin via toggle dedicado).

## 6. Fluxo do usuário (analista)
1. Atualiza o modelo como sempre. 2. Salva o `.xlsm` (Excel recalcula no save → valores em cache).
3. /admin → Stock Guide → **arrasta o arquivo**. 4. Pré-visualiza o diff → confirma →
`admin_bulk_upsert_stock_guide_companies` grava as 14 de uma vez. 5. Página fica ao vivo.

## 7. Banco
Schema base: `admin/supabase_stock_guide.sql`. Colunas novas + RPCs de upload:
`admin/supabase_stock_guide_v2_upload.sql` (rodar depois; aditivo/idempotente).
