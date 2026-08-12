# Crítica medida do hub — estado pós-rodada 20

**Data:** 2026-08-12 · **Alvo:** `hub-frontend:homolog` buildado de `main@50f37d2`
(= produção, `:hub-impeccable-r20-50f37d2`) · **Placar: 35/40** (era 31/40)

## Método

Medição no Chromium real (390px e 1440px, 11 rotas) via
`tests/e2e-hub-browser/medicao-r21.spec.ts` (temporário, removido após esta
crítica; log em `evidencias/S3/fase6-browser-run-20260812T012102Z.log`), mais
leitura de código nos pontos que a sonda apontou.

**As sondas foram corrigidas pelas lições das medições anteriores**, e isso
muda o que elas enxergam:

- **alvo de toque** mede a hit-area REAL com `elementFromPoint` — a sonda por
  `getBoundingClientRect` não enxerga o `after:` e, na medição passada,
  reprovou 265 alvos corretos;
- **`title=`** só conta quando o elemento não tem texto visível nem
  `aria-label` — senão os botões de período viram falso positivo (aconteceu);
- **região viva** só conta quando de fato anuncia: `aria-live="off"` é
  conteúdo marcado como status, decisão tomada nas r17/r20.

**Viés declarado:** agente único, mesma limitação da crítica anterior. A base
de teste segue vazia — nenhuma tela foi medida com tabela cheia, e nenhum
disparo real foi observado.

## Design Health Score

| # | Heurística | Antes | Agora | O que a medição mostrou |
|---|-----------|-------|-------|--------------------------|
| 1 | Visibilidade do estado | 3 | **4** | O disparo anunciava ~46× em 10 min; agora são 2 marcos (r17). Regiões vivas por rota caíram de 3–4 para 2–3, e as ativas são legítimas |
| 2 | Correspondência com o mundo real | 4 | 4 | Domínio bem falado; achado novo pequeno abaixo (dois vocabulários de vazio) |
| 3 | Controle e liberdade | 3 | 3 | Sem mudança desde a r14: 3 KPIs ainda filtram ao toque sem desfazer |
| 4 | Consistência e padrões | 2 | **4** | Larguras: 5 classes sem critério → 3 valores COM regra nomeada e gate (r18); `<select>` nativos: 12 → **4**, e os 4 restantes são do painel legado embutido (r19) |
| 5 | Prevenção de erros | 4 | 4 | Disparo e fechamento simétricos desde a r11 |
| 6 | Reconhecimento vs. memorização | 3 | 3 | Seleção multipágina ainda só aparece no texto de um botão |
| 7 | Flexibilidade e eficiência | 3 | 3 | Ordenação em 3 das 7 listas; faltam usuários, auditoria, faturamento, performance — e nenhum atalho de teclado |
| 8 | Estética e minimalismo | 3 | 3 | Mediana de **30 controles/rota**; `usuarios/papeis` **280 — 9,3× a mediana** |
| 9 | Diagnóstico e recuperação | 3 | **4** | O fim do ciclo semanal deixou de ser um toast de 4s (r20). A falha de envio segue sem motivo |
| 10 | Ajuda e documentação | 3 | 3 | O formato da planilha está na tela (r13); os demais fluxos seguem sem ajuda |
| **Total** | | **31** | **35/40** | **Good** |

Trajetória com a mesma rubrica: 26 → 31 → **35**, em dez rodadas.

## O que a medição confirma como resolvido

- **Alvo de toque: 0 abaixo de 44px em 11/11 rotas**, com 121 alvos medidos
  pela hit-area real. É o número que a sonda ingênua errava nos dois sentidos.
- **`overflow-x` = 0** em 11/11 rotas nos dois viewports.
- **1 `<h1>` por rota** em 11/11.
- **Informação exclusiva em `title=`: zero.**
- Todas as listas em **1200px**; o perfil em 512px, por regra.

## Achados

### [P2] `usuarios/papeis` concentra 280 controles — 9,3× a mediana

Inalterado desde a crítica anterior, e agora com a razão pior porque as outras
telas ficaram mais enxutas (mediana subiu de 25 para 30). São 34 permissões ×
4 papéis. A r10 melhorou os rótulos e a r12 os alvos; a densidade em si nunca
foi enfrentada. A tela continua pedindo que se leia uma grade de 132 caixas
para responder "o operador pode fechar movimento?".

### [P3] `validacao_xml` é a única tela de trabalho sem container

Medido: largura efetiva indefinida (`space-y-4 p-4 sm:p-6`, sem `mx-auto
max-w-*`), enquanto as outras seis listas estão em 1200px. O gate da r18
permite "nenhuma largura" — foi decisão declarada, para telas que herdam o
layout —, mas o resultado visual é uma tela que estica sozinha em monitor
largo. Ou ela é uma tela de lista (e usa `LARGURA_LISTA`), ou a exceção merece
estar nomeada como as outras.

### [P3] Duas mensagens de vazio, dois vocabulários, na mesma tela

Em faturamento e performance convivem "Sem dados para os filtros atuais."
(`bar-chart.tsx`) e "Nenhum lançamento no período selecionado" / "Nenhum
registro de turno no período selecionado" (o `EmptyState` da tela). Gráfico e
tabela dizem a mesma coisa de dois jeitos, lado a lado.

### [P3] Nenhuma das 3 tabelas tem `<caption>`

Inalterado. Não é violação de axe — o `<h1>` dá contexto —, mas uma tabela sem
legenda obriga quem navega por tabelas a inferir do entorno.

## Sem regressão

As quatro rodadas desde a última medição não introduziram: alvo pequeno,
overflow, `h1` duplicado, `title` exclusivo ou largura fora da regra. A suíte
E2E completa passou **132/132** no mesmo run.

## Perguntas de produto (do operador)

Seguem sem resposta e continuam mudando o que vale construir: por que a falha
de envio não tem motivo (o n8n devolve algo); o que acontece com um movimento
depois de fechado — a r20 deu um recibo de sessão, não um histórico
consultável; se a conferência é no Excel de propósito; e se `/hub/dashboard`
deveria ser o estado do ciclo em vez de um menu que a sidebar já tem.
