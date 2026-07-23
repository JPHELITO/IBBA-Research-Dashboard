# 📥 Caixa de entrada do customs (cavaco + aço China)

**Para atualizar a dashboard: baixe o CSV no portal do customs chinês e arraste o arquivo
para a pasta [`customs/`](customs/) — aqui pelo github.com.** Um robô (GitHub Action) cuida do resto.

### Como o robô decide o que fazer (pelo código HS do arquivo)
| Se o CSV tem… | O robô atualiza… |
|---|---|
| **HS 4401xx** (cavaco/woodchips) | o gráfico do **GACC** (`gacc_woodchips`) |
| **HS 72xx** com destino **Brazil** (aço) | a **linha preta / China** do modelo Steel & Mining (`pred_exports`) |

Em ~1-2 min a dashboard atualiza sozinha. O CSV processado é movido para `processed/`
(fica de arquivo). Você recebe um e-mail de confirmação. **Nada precisa rodar no seu PC.**

### Passo a passo
1. No github.com, abra a pasta **`customs/`**.
2. **Add file → Upload files** → arraste o `downloadData (NN).csv`.
3. **Commit changes**. Pronto — o robô faz o resto.

> Dica: pode subir vários meses de uma vez (ex.: maio **e** junho do cavaco juntos), pra não
> deixar buraco na série. Se faltar um mês, o robô avisa e não publica aquele pedaço.
