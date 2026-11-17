# assets/fonts — fontes dos relatórios HTML (Reports)

Embutidas (base64) em cada arquivo que a página `/reports.html` gera para o blast de
WhatsApp — o relatório abre offline, sem buscar nada na rede.

| Arquivo | Fonte | Uso | Licença |
|---|---|---|---|
| `unbounded.woff2` | Unbounded (variável, 200–900) | títulos, números grandes | SIL Open Font License 1.1 — https://github.com/googlefonts/unbounded |
| `manrope.woff2` | Manrope (variável, 200–800) | texto, tabelas | SIL Open Font License 1.1 — https://github.com/sharanda/manrope |

São os mesmos arquivos (recorte latino) do "The Weekly Brief" do time de Healthcare & Education,
para os relatórios do Itaú BBA em HTML terem a mesma família tipográfica.

⚠️ A Manrope troca "(c)" por "©" (alternativa contextual `calt`). O CSS dos relatórios desliga
o `calt` — por isso "(c) Working days" sai literal.
