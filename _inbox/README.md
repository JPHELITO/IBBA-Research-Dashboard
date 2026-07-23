# 📥 Caixa de entrada do customs (cavaco + aço China + aço Coreia)

**Baixe o arquivo, renomeie pra conter uma destas palavras, e arraste para a pasta
[`customs/`](customs/)** aqui pelo github.com. Um robô (GitHub Action) cuida do resto.

### O robô decide pelo NOME do arquivo
| Se o nome contém… | O robô atualiza… | Fonte / formato |
|---|---|---|
| **woodchip** | o gráfico do **GACC** (`gacc_woodchips`) | portal customs China (CSV) |
| **steelchina** | a **linha preta — China** (`pred_exports`) | portal customs China (CSV) |
| **steelcoreia** | a **linha preta — Coreia** (`pred_exports`) | KITA (xlsx) |

Exemplos: `woodchip 202606.csv`, `steelchina.csv`, `steelcoreia_202606.xlsx`.
Maiúscula/minúscula não importa — só precisa **conter** a palavra em algum lugar do nome.

Em ~1-2 min a dashboard atualiza sozinha; o arquivo bruto é **descartado** após processar
(a política do repo é não guardar fonte proprietária) e você recebe um e-mail de confirmação.
O registro do que rodou fica no histórico de commits. **Nada precisa rodar no seu PC.**

### Passo a passo
1. Baixe o arquivo e **renomeie** (ex.: `steelcoreia_202606.xlsx`).
2. No github.com, pasta **`customs/`** → **Add file → Upload files** → arraste → **Commit**.

> **Por que aço precisa do nome:** China e Coreia exportam o mesmo tipo de aço (HS 72), então
> o robô não consegue distinguir pelo conteúdo — o nome resolve. (Cavaco, HS 4401, é
> reconhecido mesmo sem a palavra.) Pode subir vários arquivos de uma vez.
