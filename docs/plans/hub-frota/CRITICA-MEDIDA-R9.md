# Crítica medida — estado do hub após a rodada 8

**Data:** 2026-08-10 · **Alvo:** `frontend_v2:hub-impeccable-r8-5a02651` (o mesmo código que está
em produção) · **Ambiente:** hub-homolog isolado, Chromium via container oficial do Playwright ·
**Papel:** `admin_entidade`

## Por que este documento existe

O placar 33/40 das rodadas 3 e 4 foi **derivado** — estimado a partir do diff, sem medir. Quando
enfim se mediu, na rodada 5, deu **25/40**. Oito pontos de ficção. Desde então vale a regra:
nenhum score sai daqui sem ter sido lido do DOM real.

Este documento é o resultado de três passos executados no browser:

| Passo | O que fez | Evidência |
|---|---|---|
| 1 | 12 rotas × 3 sondas (foco, estrutura, linguagem) + 12 em 390px + 24 pares de contraste | `evidencias/S3/medicao-r9-passo1.log` |
| 2 | **verificação** dos sinais do passo 1 — hipótese inocente vs. defeito | `evidencias/S3/medicao-r9-passo2-verificacao.log` |
| 3 | frequência do único sinal intermitente + contexto textual de cada ocorrência | `evidencias/S3/medicao-r9-passo3-frequencia.log` |

O passo 2 existe porque a lição da rodada 5 é literal: **verificar o achado antes de virar código.**
Ele derrubou 3 dos 5 sinais.

## O que a rodada 8 fechou (comparação com a medição anterior)

| Dimensão | Medição pré-r8 | Agora |
|---|---|---|
| Título de aba | **1 título** para 13 rotas, nomeando o produto legado | **10 títulos distintos** em 12 rotas |
| Alcance do conteúdo por teclado | 14–16 Tab de pedágio, **sem saída**; `/usuarios/papeis` inalcançável | skip link em **12/12**, conteúdo a **1 Tab** |
| Alvos < 44px em `/hub/dashboard` (390px) | 3 | **0** |
| Contraste AA (axe `color-contrast`) | reprovava em `--destructive` e `--muted-foreground` | **0 violações em 24 pares** rota × tema |
| Rolagem horizontal em 390px | — | **0 overflow em 12/12** |

## Sinais que a verificação derrubou

Registrados porque quase viraram trabalho:

- **133 "controles sem nome" em `/usuarios/papeis`** → **falso positivo**. O Base UI renderiza um
  `<input>` proxy invisível ao lado do `<button role="checkbox">`; a sonda contou o proxy. Medindo
  o dono do papel acessível: **0 controles reais mudos**, e o primeiro checkbox devolve
  `"dashboard.consultar para Administrador da plataforma"`. Mesma causa para o "1 INPUT mudo" que
  aparecia em quase toda rota e para os "focos sem indicador".
- **`usuarios(12×)` sem acento em `/usuarios/papeis`** → **falso positivo**. São códigos de
  permissão (`usuarios.gerenciar`), identificadores técnicos que não levam acento.
- **Título de `/hub/dashboard/envio_massa` sem o nome do módulo** → **não reproduzido**. Ocorreu
  1× no passo 1; em **10 recarregamentos dirigidos deu 0/10**. O risco residual é conhecido e vem
  do desenho: `TituloDaRota` só escreve depois que `modulos` resolve. Fica registrado, não vira
  item de trabalho sem nova ocorrência.

## Achados confirmados — pauta da rodada 9

| # | Achado (medido) | Onde | Peso |
|---|---|---|---|
| A1 | 3 botões com **32px** de altura em 390px: `Validar` (90×32), o seletor `Empresa #950101` (358×32) e um sem rótulo (32×32) | `/hub/dashboard/validacao_xml` | P2 |
| A2 | 10 alvos de **37px** na matriz papel×permissão em 390px | `/hub/dashboard/usuarios/papeis` | P3 |
| A3 | Cabeçalhos de tabela sem acento: `Numero`, `Data Emissao`, `Acoes` — a r8 corrigiu o *placeholder* do filtro e passou ao lado da coluna | `/hub/dashboard/envio_massa` | P2 |
| A4 | Prosa sem acento: `H1 "Validacao XML NFSe"` e `"Selecione arquivos XML de NFSe para validacao em lote."` | `/hub/dashboard/validacao_xml` | P2 |
| A5 | **Dois `h1`** na mesma tela (`CardTitle as="h1"` somado ao título da página) | `/hub/dashboard/validacao_xml` | P2 |
| A6 | Título de aba diz **"Painel Geral"** em telas que não são o painel — não existe módulo `/me` para elas, e o casamento por prefixo mais longo cai em `/hub/dashboard` | `/hub/dashboard/admin`, `/hub/dashboard/perfil` | P2 |
| A7 | A matriz exibe **códigos crus de permissão** ao usuário (`usuarios.gerenciar`) em vez de rótulo legível | `/hub/dashboard/usuarios/papeis` | P3 |

## Placar

**35/40.** A rubrica está declarada abaixo — 8 dimensões × 5 pontos, pontuadas com os números
medidos acima.

| Dimensão | Nota | Base |
|---|---|---|
| Orientação (título por rota) | 4 | 10 títulos distintos, mas A6 mente em 2 rotas |
| Alcance por teclado | 5 | skip link 12/12, conteúdo a 1 Tab |
| Foco visível | 5 | 0 controles reais sem indicador |
| Contraste AA | 5 | 0 violações em 24 pares |
| Alvos de toque (390px) | 3 | 10/12 rotas limpas; A1 e A2 abertos |
| Rolagem horizontal (390px) | 5 | 0 overflow em 12/12 |
| Nomes acessíveis | 5 | 0 mudos reais, incl. a matriz de 133 checkboxes |
| Linguagem e copy | 3 | A3, A4 e A7 abertos |

⚠️ **Este 35/40 NÃO é comparável ao 25/40 da rodada 5.** A rubrica daquela medição não está
versionada no repositório, então a série "25→35" não significa nada. O que é comparável são os
números absolutos da tabela "o que a rodada 8 fechou" — esses foram medidos do mesmo jeito nas
duas vezes.

## Metodologia, para quem for repetir

A medição roda como spec Playwright temporário em `tests/e2e-hub-browser/`, executado pelo driver
`infra/hub/testes/hub-shell-e2e-browser.sh`, e é **removida depois** — não é gate, não afirma nada,
só imprime linhas `MEDIDA_*` lidas do DOM. Os logs acima são a evidência; o spec não fica no repo
para não virar suíte que ninguém lê.

Duas armadilhas que esta medição encontrou e que a próxima deve evitar:

1. **Contar elementos em vez de controles.** Bibliotecas headless (Base UI) duplicam cada controle
   num par `<button role>` + `<input>` proxy invisível. Toda sonda de acessibilidade tem que medir
   o dono do papel acessível, nunca a tag crua.
2. **Regex de acentuação não distingue prosa de identificador.** Sem imprimir a frase ao redor, um
   `usuarios.gerenciar` legítimo entra no relatório como erro de português.
