# Campanha tipo "Melhor extrato" (soma do faturamento dos turnos válidos)

> Status: **APROVADO pelo operador em 23/11/2026** (telas 10–12, E1–E10, inclusive a E7). Janela de deploy a combinar.
> Origem: áudio da operação (Anne, 23/11/2026), em `docs/documentos_apoio/audioAnne.ogg`. O pedido:
> "se no turno o entregador cumprir os critérios (ex.: 70% / 90% de tempo online), o valor que ele
> produziu naquele turno conta para o melhor extrato. Soma todos os turnos que cumpriram os requisitos,
> e quem tiver a maior soma fica no pódio."
> Mesmo rito do [PLANO.md](PLANO.md): decidir tudo aqui (Opus), executar com plano fechado (Sonnet).
> Pilares: **deduplicação · escalabilidade · segurança · performance**.

## 1. Medido antes de propor (produção, empresa 6, somente leitura, 23/11)

| Fato | Número | Consequência |
|---|---|---|
| Linhas de crédito do faturamento com turno que casam com um turno da Performance por **(entregador, `data_referencia` = `data_periodo`, turno)** | **79.128 de 79.330 (99,7%)**, 97,3% do valor | O valor vem do faturamento e o critério da Performance, sem perda relevante. |
| Grafia dos turnos nas duas fontes | idêntica (`ALMOCO 11H30-15H29`, `JANTAR CPS 18H30-21H29`…) | Casamento por `upper(btrim(periodo))`, igual ao filtro de turno que já existe. |
| Linhas de faturamento por turno | 1 a 9 (uma por categoria) | Valor do turno = **soma** das linhas das categorias escolhidas. |
| Percentuais no próprio faturamento | só a categoria "Percentual atingido de rotas completas" (3.487 linhas) | Os critérios do turno **vêm da Performance** (`mv_performance_dia`), como pedido pelo operador. |
| Categorias sem turno | Gorjeta (3.937 linhas, 0 com turno), `PROMOTION_FRANCHISE`, parte de "Promocao entregador" | Não podem ser atribuídas a um turno: **ficam fora da lista** de categorias da campanha. |
| Atraso do faturamento (dia do turno → chegada ao hub) | 83,8% do valor em 1 dia, **95,8% em 2**, 96,9% em 3, 97,3% em 4; ~2,6% chegou com 15+ dias, concentrado em 17–18 dias (reimportação pontual) | Fechamento automático **3 dias depois do fim** (E5). |
| Débitos com turno | **nenhum** em 30 dias | Valor do turno = soma dos **créditos**. |
| Turnos de 30 dias / linhas de faturamento de 30 dias | ~75 mil / ~100 mil | Orçamento de performance medido com esse volume ×3 (campanha de 92 dias). |

**Onde estas informações já aparecem hoje** (regra "mostrar antes onde a informação já aparece"):
- **Indicadores por turno:** na tela Performance do hub. No app, aparecem só na campanha.
- **Faturamento por categoria:** no módulo Financeiro do hub e na produção do adiantamento, onde as
  categorias são escolhidas em Configurações (seletor com as famílias "Promoção" e "Missões", migration 0087).
- **App:** o card do movimento na Início mostra `VALOR DA NOTA FISCAL` / `GORJETA` / `TOTAL PRODUZIDO`,
  que vem da planilha (`EnvioMassa`). O valor da campanha **não** é esse número: é a soma, só dos
  turnos válidos, nas categorias escolhidas. Por isso o rótulo é "Seu extrato na campanha", com o nome
  que a operação já usa ("melhor extrato"), e não "total produzido", para não criar um segundo
  significado para o mesmo rótulo.

## 2. Decisões do operador (23/11)

- **X1** O valor do turno vem do **faturamento** (`FaturamentoLancamento`), não da Performance. O período
  é filtrado pela **`data_referencia`** (data do período de referência).
- **X2** No app, o ranking (pódio e top 10) mostra **só o nome abreviado e a posição**. O valor dos outros
  motoristas nunca aparece.
- **X3** O mínimo de turnos é **configurável**: conta turnos válidos ou turnos trabalhados.
- **X4** Os critérios do turno são **os mesmos 4 indicadores** da campanha atual (aceitação, conclusão,
  tempo disponível, pedidos concluídos), todos parametrizáveis como hoje. Quem lança escolhe quais valem
  e o mínimo de cada um, conferido **em cada turno**.

## 3. Propostas para aprovar junto com as telas

| # | Proposta | Por quê |
|---|---|---|
| E1 | **Tipo da campanha** escolhido no topo do formulário: "Nota ponderada" (o que existe) ou "Melhor extrato". O resto continua igual: praças, turnos, modal, prêmios, rascunho → lançar imutável, cancelar, avisos, entrega e planilha de prêmio. | Um motor só e um formulário só (deduplicação). O tipo também fica imutável depois de lançar. |
| E2 | **Turno válido** = cumpre **todos** os critérios marcados naquele turno. Leitura ausente (ex.: 0 corridas ofertadas, pedidos sem dado) **não** cumpre. É preciso marcar **pelo menos 1** critério. | "Cumprir os critérios" é o pedido. Fail-closed: zero inventado nunca valida turno (mesma regra P1 da nota). |
| E3 | **Valor do turno** = soma dos créditos do faturamento do motorista naquele dia (`data_referencia`) e turno, nas **categorias marcadas** (pelo menos 1, nenhuma marcada por padrão). O seletor é **o mesmo** das Configurações do adiantamento, com famílias. A família "Promoção" inclui as campanhas futuras. | Quem lança decide o que é "extrato" (só corridas? com hora online? com promoções?). Reaproveita a regra de família da 0087, assim tela e cálculo nunca discordam. |
| E4 | **Turno sem faturamento ainda** aparece como "aguardando faturamento", não como inválido. Linha de faturamento sem turno correspondente na Performance (0,3%) **não conta**, porque não há como conferir o critério. | Não punir o motorista pelo atraso da origem. |
| E5 | **Fecha sozinha 3 dias depois do fim** (fim + 3, a importação daquele dia entra). O botão "fechar com os dados que existem" também libera em fim + 3. | 96,9% do valor já chegou em 3 dias. Esperar mais atrasa o prêmio por 0,4%. |
| E6 | **Ordem do ranking:** valor somado ↓, depois turnos válidos ↓, depois o id do entregador. A posição é sempre única. **Classificado** = atingiu o mínimo de turnos, na base escolhida. Senão fica "sem o mínimo". "Sem modal" continua como hoje. | Faixa de prêmio sem ambiguidade (A6). |
| E7 | **O motorista vê o próprio valor somado** e a lista dos **próprios turnos**: ✓ válido, com o valor; ✕ não valeu, com o motivo ("Tempo online 65% (mínimo 70%)") e o valor que deixou de somar; … aguardando faturamento. **Sem** "faltam R$ X para passar o da frente". | **Confirmar.** É o dado do próprio motorista e o que engaja (o próximo turno conta). A diferença em R$, somada ao próprio valor, revelaria o valor do outro e violaria a X2. |
| E8 | **Hub:** o detalhe mostra turnos válidos, trabalhados e valor somado, com nome completo (tela 11). O CSV do ranking ganha essas colunas. A lista de campanhas mostra o selo do tipo. | O hub já vê nomes completos (D3). |
| E9 | O recálculo das campanhas ativas roda também **ao fim da importação de faturamento**, não só da de Performance. | O valor chega pelo faturamento, um dia depois da Performance. |
| E10 | **A tela de criar ganha só o seletor de tipo, o bloco "Valor do turno" e a base do mínimo de turnos.** O bloco de indicadores troca "Peso + Corte mínimo" por "Mínimo no turno" quando o tipo é extrato. | Sem formulário paralelo. |

## 4. Modelo de dados (migration `0129_campanhas_extrato.sql`, aditiva e idempotente)

```
Campanha  + tipo             text NOT NULL DEFAULT 'nota'   CHECK IN ('nota','extrato')
          + categorias       text[] NULL                    nomes exatos OU tokens de família (0087)
          + min_turnos_base  text NOT NULL DEFAULT 'trabalhados' CHECK IN ('trabalhados','validos')
  CHECKs trocados (DROP CONSTRAINT IF EXISTS + ADD; as linhas existentes são todas 'nota' e passam):
   - pesos:  tipo='nota' → soma = 100 (como hoje) · tipo='extrato' → todos os pesos = 0
   - cortes: tipo='nota' → como hoje (corte só com peso > 0)
             tipo='extrato' → faixas iguais às de hoje, sem exigir peso, e pelo menos 1 corte não nulo
   - categorias: tipo='nota' → NULL · tipo='extrato' → 1..60 itens, cada um 1..200 caracteres, sem NULL
   - min_turnos_base: tipo='nota' → 'trabalhados'
  Gatilho de imutabilidade: coluna nova nasce IMUTÁVEL (v_livres da 0127 não muda), sem alteração.

CampanhaRanking + turnos_validos int NULL, + valor_centavos bigint NULL   (preenchidos só no tipo extrato)
  situacao do extrato: 'classificado' | 'sem_minimo' | 'sem_modal' ('abaixo_corte' não se aplica)
```

## 5. Cálculo: uma função para a regra do turno, dois chamadores

`hub_campanha_turnos_extrato(p_c "Campanha", p_entregador_id int DEFAULT NULL)` → uma linha por
turno do público (filtros de período, turno, praça e modal **idênticos** aos da 0127):
`entregador_id, data_periodo, periodo, aceitacao, conclusao, tempo, pedidos, valor_centavos,
tem_valor, valido, motivo text[]`.
- Indicadores do turno saem da linha da `mv_performance_dia`, com as mesmas fórmulas (aceitas ÷ ofertadas,
  completadas ÷ aceitas, `LEAST(online ÷ período, 1)`, pedidos).
- Valor: `sum(valor)` de `FaturamentoLancamento` com `tipo='Credito'`,
  `hub_adiantamento_categoria_casa(descricao, p_c.categorias)` (função da 0087, reaproveitada),
  `entregador_id` igual, `data_referencia = data_periodo` e `upper(btrim(periodo))` igual, como
  **pré-agregação por (entregador, dia, turno)** em CTE, com `LEFT JOIN`. Nada de subconsulta correlacionada.
- `motivo` usa os mesmos códigos da nota (`aceitacao`, `conclusao`, `tempo`, `pedidos`).

Quem chama:
1. **`hub_campanha_recalcular_interno`** ganha um ramo `IF v_c.tipo = 'extrato'`: agrega a função
   (turnos, turnos_validos, Σ valor dos válidos), classifica (E6) e grava no mesmo `INSERT … ON CONFLICT`.
   `dados_ate` = `LEAST(max data_periodo da MV, max data_referencia do faturamento)` da empresa, até `data_fim`.
   A regra da `posicao_anterior` é a mesma.
2. **`hub_motorista_campanha_turnos(p_campanha_id)`**: só o entregador da sessão (mesma resolução das RPCs
   do motorista na 0127), últimos turnos primeiro, até 300 linhas.

Fechamento (`hub_campanhas_recalcular_ativas`): para o tipo extrato, a condição passa a ser
`max(data_periodo) >= data_fim` **e** `hoje >= data_fim + 3`. O resto do fechamento (vencedores,
aviso, planilha) não muda.

`hub_campanha_categorias()`: mesma consulta de `hub_adiantamento_categorias`, mas exigindo **ao menos
uma linha com turno** (`count(periodo) > 0`) e devolvendo a família. Com isso a Gorjeta nem aparece.
A forma de retorno é igual, para o mesmo componente de tela consumir.

## 6. API

| Onde | Mudança |
|---|---|
| `POST/PUT /hub/campanhas` | aceitam `tipo`, `categorias`, `minTurnosBase`; validação em `lib/campanha-dto.js` (E2/E3) e de novo no banco |
| `GET /hub/campanhas/categorias` | novo, `campanhas.gerir`; chama `hub_campanha_categorias` |
| `POST /hub/campanhas/:id/lancar` | recusa categoria salva que não existe mais na lista (mesma regra das praças e turnos) |
| `GET /hub/campanhas/:id`, `/ranking`, `/ranking.csv` | devolvem `tipo`, `turnosValidos`, `valorCentavos` |
| `GET /motorista/campanhas/:id` | no tipo extrato, `top10` e `podio` saem **só com `posicao` e `nomeAbreviado`**, e a montagem é **no servidor**. `minhaLinha` traz o próprio valor e os turnos válidos (E7). |
| `GET /motorista/campanhas/:id/turnos` | novo, carregado sob demanda pela tela; mesma autenticação e limitador |
| `lib/hub-import-processor.js` | o gancho de recálculo vale para `performance` **e** `faturamento` (E9) |

## 7. Pilares, verificáveis

**Deduplicação**
- A regra do turno vive numa função SQL só, usada pelo ranking e pela tela do motorista.
- Filtros de público, imutabilidade, prêmios, avisos e fechamento: reaproveitados da 0127.
- Casamento de categoria: `hub_adiantamento_categoria_casa` (0087).
- Seletor de categorias: o `SeletorCategorias`, hoje local em `adiantamentos/configuracoes/page.tsx`,
  é **extraído** para `components/hub/seletor-categorias.tsx` e usado nas duas telas, com o mesmo `montarItensCategoria`.

**Escalabilidade**
- O ranking continua materializado 3×/dia. O teto de 10 campanhas ativas e de 92 dias continua valendo.
- A lista de turnos do motorista é por entregador, pelos índices `(id_empresa, entregador_id, data_periodo)`
  da MV e `(id_empresa, entregador_id, data_referencia)` do faturamento.

**Segurança**
- **O valor de outro motorista nunca sai para o app.** O DTO do top 10 do extrato não tem campo de valor,
  e um teste afirma a ausência de `valor`/`centavos` no payload.
- Identidade só pela sessão. RLS e GRANT como na 0127. Gate `owasp-security` antes do PR.

**Performance (orçamento no hub-test, com volume sintético de 900 mil turnos e 300 mil linhas de faturamento)**
- Recálculo de uma campanha extrato de 30 dias: ≤ 2 s.
- `GET /motorista/campanhas/:id`: ≤ 50 ms no banco. `…/turnos` (92 dias): ≤ 50 ms.
- Ranking do hub paginado: ≤ 100 ms (inalterado).

## 8. Execução (depois da aprovação)

Worktree `.claude/worktrees/campanhas-extrato`, branch `feat/campanhas-melhor-extrato`. Execução em Sonnet.

| Onda | Agente (Sonnet) | Entrega | Gate |
|---|---|---|---|
| W1 | `database-architect` | 0129 + função do turno + ramo do recálculo + fechamento + RPCs; driver `hub-campanhas-db.sh` estendido | prova **em banco**: turno válido/inválido/pendente, categoria por família, privacidade, fechamento em fim+3, imutabilidade das colunas novas; orçamento medido |
| W2 | `fullstack-developer` | DTO, rotas, gancho do faturamento | `npm test`, suíte do hub, integração |
| W3a ∥ W3b | `fullstack-developer` ×2 | hub (seletor extraído, formulário, detalhe, CSV) · app (tela extrato + turnos) | `tsc` 0, vitest, `next build` ×2, impeccable 0, lint ≤ baseline |
| W4 | `fullstack-developer` | E2E: criar extrato → lançar → ranking no hub → app sem valor alheio → turnos | E2E verde pelo driver; `package-lock.json` revertido |
| W5 | revisão independente (`owasp-security` + `code-review`) | achados | cada um **medido** antes de aceitar |
| W6–W7 | Opus | PR → merge → build `<rótulo>-<sha7>` → 0129 → deploy → prova de bundle | rito git + 5 gates |

## 9. Pendências do operador

1. Aprovar as telas 10–12 e as propostas E1–E10, **em especial a E7** (motorista vê o próprio valor).
2. Janela de deploy (gate 2).

## 10. Fora do escopo, de propósito

Critério por turno vindo dos percentuais do próprio faturamento (só existem numa categoria) ·
débitos no valor do turno (não existem com turno) · ver a lista de turnos de um motorista no hub
(o CSV traz os totais) · meta em R$ por turno.
