# Campanhas — ajustes de parametrização (2026-11-26)

Pedido do operador em 2026-11-25. Decisões de produto tomadas por ele **antes** da execução (regra
"decidir tudo antes", memória `modelo-por-etapa-dev`). Pilares: deduplicação, segurança, performance,
escalabilidade. Migration única: **0133**.

## Estado medido antes (definições vivas)

| Tema | Hoje | Onde |
|---|---|---|
| "Praça" da campanha | É `PerformanceTurno.subpraca`. Linha com subpraça vazia some das opções e nunca casa com o filtro. Nenhuma regra usa `origem` | `hub_campanha_opcoes` 0127:843-860; semi-join 0130:59-64, 0129:189-193; visibilidade 0132:83-88 |
| Subpraça no resto do hub | Performance/Faturamento mostram `subpraca ?? '-'`; filtro exato `pt.subpraca = p_subpraca`; view `hub_areas_por_entregador` usa `subpraca IS NOT NULL` | 0051:174-180/246-252/407-413/442-481; 0024:19-28; `performance/page.tsx:319-331`; `faturamento/page.tsx:704-745`; `hub-motoristas-dto.js:87` |
| Escolha de lançamento (descrição) | Existe só no tipo **extrato** (`Campanha.categorias`); a nota exige `categorias IS NULL` | 0129:27-48; `hub_adiantamento_categoria_casa` 0131:58-71 |
| Turno curto zerado | Nunca é descartado; `online_epoch` em segundos na MV | 0051:76-104; 0130:46-92 |
| Lançar com início no passado | Recusado (`INICIO_NO_PASSADO`); lançar não recalcula o ranking | 0131:490-492 |
| Data do prêmio | Não existe. Dinheiro: `data_pagamento` = dia da 1ª exportação; objeto: `entregue_em = now()`. O app diz "aparece no seu repasse" / "a equipe combina a entrega" | 0127:1555-1611, 1521-1553; app `campanhas/[id]/page.tsx:643-646, 752` |

## Decisões

### D1 — Subpraça efetiva no hub inteiro (operador: "Hub inteiro")
- Regra única no banco: `hub_subpraca_efetiva(subpraca text, origem text) RETURNS text IMMUTABLE`
  = `COALESCE(NULLIF(btrim(subpraca),''), NULLIF(btrim(origem),''), 'LIVRE')`.
  Nenhuma reimplementação em JS/TS: backend e frontend recebem o valor já resolvido.
- Usada em **todo** ponto que hoje lê `subpraca` para opção, filtro, agrupamento ou exibição:
  campanhas (opções, semi-join da nota e do extrato, visibilidade, validação no lançar), RPCs de
  performance da 0051, `pracas` jsonb do detalhe do turno, view `hub_areas_por_entregador`
  (Faturamento + Performance), e o que o faturamento/motoristas exibem. A campanha mantém o
  `upper()` que já aplica por cima.
- Performance: índice de expressão `(id_empresa, hub_subpraca_efetiva(subpraca, origem), data_periodo)`
  em `PerformanceTurno`, para substituir o papel do índice `(id_empresa, subpraca, data_periodo)` no
  semi-join (o `EXISTS` correlacionado já foi medido a 1,5 s e recusado — 0127). Mesmo critério para
  `FaturamentoLancamento` se algum filtro dele usar a coluna. Medir com `EXPLAIN` no hub-test com
  volume (900 mil turnos, padrão das ondas anteriores): orçamento igual ao da 0127.
- Campanha já lançada com praça gravada continua casando: valores não vazios não mudam.

### D2 — Descarte de turno curto zerado (operador: regra 1, parametrizável por campanha, vale para as já lançadas com 5)
- Coluna `Campanha.descarte_turno_min smallint NOT NULL DEFAULT 5`, CHECK 0..60 (0 = desliga).
  `ADD COLUMN … DEFAULT 5` preenche as existentes sem UPDATE (o gatilho de imutabilidade não
  dispara) — é assim que as lançadas ganham os 5 min, por decisão do operador.
- Turno descartado ⇔ `online_epoch IS NOT NULL AND online_epoch <= descarte_turno_min*60`
  **E** `corridas_ofertadas = 0 AND corridas_aceitas = 0 AND corridas_completadas = 0
  AND COALESCE(pedidos_concluidos,0) = 0`. Online sem leitura **não** descarta (conservador).
- Descartado não entra em nada: nem nos indicadores, nem na contagem de turnos trabalhados/válidos,
  nem no extrato. Um predicado só, escrito uma vez (função SQL ou CTE comum) e reusado por nota e extrato.
- Campo no formulário (minutos, preenchido com 5); congela ao lançar como as demais regras.
- As lançadas mudam de ranking na próxima importação (efeito aceito pelo operador).

### D3 — Escolha de lançamentos na campanha de Nota (operador: "Quero na campanha de Nota")
- A nota passa a aceitar `categorias` (o mesmo campo e o mesmo seletor do extrato; o CHECK que
  exige NULL na nota é relaxado). `NULL` = comportamento atual (todos os turnos).
- Com categorias: o turno só conta se houver crédito em `FaturamentoLancamento` com descrição/família
  que casa (`hub_adiantamento_categoria_casa`, reuso) em `(entregador, data_referencia, upper(btrim(periodo)))`
  — o mesmo casamento do extrato (99,7% medido em 23/11).
- Como o faturamento atrasa até 3 dias, a nota **com categorias** herda as regras do extrato:
  fechamento só a partir de fim+3 com faturamento importado desde fim+3, e congelamento por
  `criado_em <= fechada_em`. Nota sem categorias segue fechando em fim+1.
- O recálculo após importação de faturamento já roda para todas as ativas (E9 da 0129).

### D4 — Lançar campanha em andamento (operador: "início no passado, fim futuro")
- `hub_campanha_lancar`: `INICIO_NO_PASSADO` só quando `data_fim < hub_hoje_sp()` (renomear o código
  para `FIM_NO_PASSADO`; o DTO e o front mapeiam a mensagem).
- O lançamento chama o recálculo da campanha na mesma transação quando `data_inicio <= hoje`, para o
  ranking nascer pronto (antes só a importação recalculava).
- Diálogo de lançar: aviso "Esta campanha começou em DD/MM; o ranking já considera os dias desde
  então." O formulário remove a validação "o início precisa ser hoje ou depois".
- O aviso push de início segue a regra atual (08h, só com `visivel_app` ligado; a campanha nasce oculta).

### D5 — Data de pagamento/entrega por campanha, editável e auditada
- Coluna `Campanha.data_premio date NULL` (opcional; NULL = comportamento atual). Entra na lista de
  colunas que o gatilho de imutabilidade **permite** mudar após lançar, até o fechamento + pagamento.
  Alteração pós-lançamento por RPC dedicada `hub_campanha_alterar_data_premio`, com auditoria
  (antes/depois) e permissão `campanhas.gerir`. Recusa se a campanha estiver cancelada ou se todos os
  prêmios já foram pagos/entregues.
- Planilha de dinheiro: `data_pagamento` passa a ser `GREATEST(data_premio, hoje)` na 1ª exportação
  (data no passado → paga já) e fica **gravada** em `CampanhaVencedor.data_pagamento` (coluna nova,
  liberada no gatilho junto com `exportado_em`), para o re-download reproduzir a mesma data mesmo se
  `data_premio` mudar depois. Sem `data_premio`, segue o dia da 1ª exportação.
- Colisão com a chave do Lançamento externo `UNIQUE (id_empresa, cnpj, data_pagamento, tipo)` (0117:72):
  se o mesmo CNPJ já tem prêmio exportado nessa data (outra campanha), mantém a regra atual de adiar
  para o dia seguinte, com o aviso que a tela já mostra (`X-Premios-Adiados`).
- Exibição: hub (formulário, detalhe, vencedores) e app do motorista. No app, onde hoje está
  "Aparece no seu repasse" / "A equipe Movee combina a entrega com você" (`campanhas/[id]/page.tsx:643-646`,
  nota de rodapé `:752`), passa a "Pagamento previsto em DD/MM" / "Entrega prevista em DD/MM" quando
  houver data; sem data, o texto atual. Mesma regra no selo do card só se ele já falar de prêmio
  (`card-campanha.tsx:96,111` — não ganha texto novo).

## Fora do escopo
- Editar outras regras de campanha lançada (continua imutável, exceto `data_premio`).
- Mudar o importador: a subpraça efetiva é derivada na leitura; o dado bruto continua como veio.
- Data por faixa de prêmio (operador escolheu uma data por campanha).

## Ondas (execução em Sonnet; plano fechado)

| Onda | Agente | Entrega | Gate |
|---|---|---|---|
| W1 | database-architect | 0133: função de subpraça + índices, colunas `descarte_turno_min`/`data_premio`/`CampanhaVencedor.data_pagamento`, redefinição das funções vivas (opções, recálculo nota/extrato, visibilidade, lançar, salvar, gatilho, marcar_exportado, RPCs de performance e view de áreas), RPC de alterar data | Driver `hub-campanhas-db.sh` + casos novos (subpraça vazia/origem/LIVRE, descarte nos 2 tipos e borda de 5 min, nota com categorias, lançar com início passado, data editável e congelada na exportação, colisão de CNPJ); controles negativos; EXPLAIN com 900 mil turnos; drivers de performance/adiantamentos/avisos sem regressão |
| W2 | fullstack-developer | Backend (DTO, rotas, mensagens) + hub (formulário, diálogo de lançar, detalhe, vencedores) + app (textos de data) | npm test; tsc; vitest; lint = baseline; next build (df ≥ 20 GB + swap); detector impeccable 0 |
| W3 | fullstack-developer | E2E pelo driver `hub-campanhas-e2e-browser.sh` com os cenários novos; `package-lock.json` revertido | E2E verde |
| — | revisor independente | Revisão adversarial sobre o diff inteiro antes do PR | achados medidos |
