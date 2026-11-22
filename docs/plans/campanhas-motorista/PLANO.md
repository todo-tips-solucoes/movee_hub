# Campanhas do motorista: ranking gamificado por indicadores de performance

> Status: **APROVADO PELO OPERADOR em 2026-11-22** (telas + A1–A12; A12 = `admin_entidade` e
> `financeiro`; acréscimo D6 = filtro por modal). Execução liberada.
> Protótipo das 9 telas: canvas "Campanhas do Motorista" (link no PR/conversa).
> Regra vigente: decidir tudo aqui (Opus), executar com plano fechado (Sonnet), pilares
> **deduplicação · escalabilidade · segurança · performance** em toda onda.

## 1. O que foi medido antes de propor (não refazer)

| Fato | Onde | Consequência para o desenho |
|---|---|---|
| Os 4 indicadores já existem por turno | `PerformanceTurno` (0014) → `mv_performance_dia` (0051), grão `(empresa, dia, período, entregador)` | A campanha **não recalcula indicador**: lê a MV. Fórmulas vigentes em `hub_performance_turnos` (0051). |
| Fórmulas vigentes | aceitação = aceitas ÷ ofertadas · conclusão = completadas ÷ aceitas · tempo = `online_epoch ÷ periodo_epoch` (teto na duração, 0050) · pedidos = soma | Mesmas fórmulas, mesma unidade (fração 0..1 para taxas, como `lib/hub-performance-meta.js`). |
| A MV é atualizada a cada importação | `hub-import-processor.js:838` → `rpc/hub_performance_refresh_mv` (robô EntreGô 11h/13h/14h, dado D-1) | Ranking é **"atualizado até ontem"**, não tempo real. O recálculo da campanha pega carona nesse mesmo gancho. |
| `pedidos_concluidos` é ANULÁVEL | 0051: "ausência de leitura nunca vira zero" | Decisão P1 abaixo, depois da consulta de cobertura (§9). |
| Praça não está na MV | a MV soma as praças do turno | Filtro de praça = semi-join `IN (subconsulta)` em `PerformanceTurno`, mesmo padrão e mesmo índice `(id_empresa, subpraca, data_periodo)` da 0051 (o `EXISTS` correlacionado foi medido a 1,5 s e recusado). |
| Nomes de turno variam | ex.: `JANTAR 18H-22H` e `JANTAR 18H00-21H59` | As opções de turno vêm dos valores reais (`GET /performance/areas`, que já existe), em seleção múltipla. |
| Motorista ↔ entregador | `Entregador.motorista_id`; o app resolve pela claim `motorista_cnpj` (padrão do adiantamento) | Identidade **só pela sessão**, nunca por parâmetro (constitution II). |
| Onde os indicadores aparecem hoje | Hub: tela Performance (cards "Taxa de aceitação", "Taxa de conclusão", "Tempo disponível médio do turno") e Metas. **App do motorista: em lugar nenhum.** | Primeira superfície do motorista. Rótulos reaproveitados da Performance, sem vocabulário novo. |
| Início do app | saudação → adiantamento (gradiente quente) → notas pendentes → notificações → movimento (gradiente azul); barra inferior = grade de 4 colunas | A campanha entra como **card na Início**, abaixo do adiantamento, em marinho + dourado. **Sem 5ª aba** (rótulo não cabe a 320 px). |
| "Promoção" já é outra coisa | categorias "Promoção - …" do adiantamento (0087/0088), vindas do portal | O módulo se chama **Campanhas**, para não criar um segundo significado para "Promoção". |
| Prêmio em dinheiro | Lançamento externo (0117) é **importação de planilha** de 5 colunas; tipos `ADIANTAMENTO` (−1) e `AJUSTE_CREDITO` (+1); "tipo novo = INSERT, sem DDL" | Sem caminho de dinheiro novo: o hub **gera a planilha no layout do importador** e o financeiro importa pelo fluxo existente, com todas as guardas dele. Tipo novo `PREMIO_CAMPANHA` (+1) por INSERT. |
| Avisos/push | avisos do sistema nascem `na_fila` no banco (padrão `hub_adiantamento_notificar`, 0068); varredura de 60 s entrega (PR #319) | Aviso de início/fim da campanha pelo mesmo mecanismo. Sem timer novo. |

## 2. Decisões fechadas pelo operador (2026-11-22)

- **D1 Pontuação:** nota ponderada. Cada indicador marcado vira uma nota de 0 a 100 e quem lança define o peso (soma = 100).
  **Corte mínimo opcional por indicador**: abaixo dele, o motorista sai do ranking ("abaixo do corte").
- **D2 Prêmio:** descrito por faixa de posição, de tipo **objeto** (bag, moto, celular…) ou **dinheiro**. Objeto: entrega registrada no hub. Dinheiro: planilha para o Lançamento externo.
- **D3 Privacidade:** o motorista vê o pódio e o top 10 com **nome + inicial** ("Juliana P."), mais a própria posição. O hub vê os nomes completos.
- **D4 Público:** quem lança escolhe **quais praças** (ou todas), **quais turnos** (ou todos) e um **mínimo de turnos** para entrar no ranking.
- **D5 Imutável após lançar**, com diálogo de confirmação (caixa "revisei e entendo" + botão que só habilita com ela marcada).
- **D6 Modal como filtro da campanha** (acréscimo do operador na aprovação). O modal é o tipo de
  veículo que vem do enriquecimento da EntreGô: `Entregador.dados_entrego_json → informacoesEntrega.modal`
  (`modalName` do portal, ver `infra/robo-entrego/src/busca-pessoa-entrego.js:81`). Nenhuma tela do hub
  filtra por ele hoje.
  - Seleção múltipla ou "todos"; as opções são os valores distintos que existem na entidade.
    São texto livre do portal, por isso nada fica fixo no código.
  - **Sem modal no cadastro (não enriquecido) = fora da campanha filtrada, com aviso.** A confirmação
    e o acompanhamento mostram quantos ficaram de fora e quem é (situação `sem_modal`). Se o motorista
    for enriquecido durante a campanha, entra na atualização seguinte.
  - Vale o modal **atual** a cada recálculo; no fechamento, o resultado fica congelado.
- **A12 resolvida:** `admin_entidade` e `financeiro`. Como a 0115 manteve `financeiro_aprovador`
  idêntico a `financeiro` **de propósito** ("NÃO limpe um dos dois"), ele recebe as mesmas
  permissões. Se ficasse de fora, os dois papéis divergiriam (o gotcha do CLAUDE.md).
- **P1 resolvida sem consulta manual:** o formulário mede a cobertura de `pedidos_concluidos`
  nas praças e turnos escolhidos (últimos 30 dias) e bloqueia o indicador abaixo de 95%, com
  o número na tela. Zero inventado nunca entra na nota.

## 3. Decisões que proponho e que o operador aprova junto com as telas

| # | Proposta | Por quê |
|---|---|---|
| A1 | **Rascunho** editável → **Lançar** (imutável). | "Não pode ser modificada depois de lançada" fica natural. Sem rascunho, um erro de digitação obriga a cancelar. |
| A2 | Depois de lançada, **só cancelar**, com motivo obrigatório e auditado. A campanha cancelada some do app e fica no hub. | Imutável ≠ irrevogável. Um prêmio errado precisa ter saída. |
| A3 | Situação derivada das datas: Rascunho · Agendada · Em andamento · Apurando · Encerrada · Cancelada. | "Apurando" = já terminou, mas o dado do último dia ainda não chegou (D-1). |
| A4 | **Fecha sozinha** quando a importação cobrir o último dia; botão "fechar com os dados que existem" liberado 3 dias após o fim. | Sem fechamento manual obrigatório, sem ficar "apurando" para sempre se um dia não vier. |
| A5 | Pedidos concluídos viram nota **relativa ao líder** entre os classificados (quem fez mais = 100). | Pedido é contagem, não taxa. |
| A6 | **Desempate:** pedidos concluídos, depois tempo disponível, depois o id do entregador. Posição sempre única. | A faixa de prêmio não pode ficar ambígua. |
| A7 | Engajamento calculado, sem configuração extra: variação de posição desde a atualização anterior · "faltam X pontos para passar o de cima" · "onde você ganha mais pontos" · para quem está abaixo do corte, **"sua nota seria N, daria o Mº lugar"** e **"aceite as próximas K corridas"** (`K = ⌈(c·ofertadas − aceitas) ÷ (1 − c)⌉`). | É o que transforma ranking em jogo: mostra o próximo passo concreto. |
| A8 | Aviso push opcional (marcado por padrão) **no início** e **no resultado final** ("veja sua posição"). | Reaproveita os avisos do sistema. |
| A9 | Foto do prêmio **opcional**: JPEG/PNG/WebP até 500 KB, conferindo os bytes iniciais do arquivo, guardada **no banco** (`bytea`, entra no backup diário do `chatmasterveloz`) e servida com `Content-Type` fixo e `nosniff`. Sem foto, aparece o ícone do tipo. | O volume `envio_massa_hub_uploads` **não tem backup** (D3a do plano da Performance). Não há `sharp` no runtime para reprocessar a imagem. |
| A10 | O motorista vê as campanhas da empresa dele. Se a campanha filtra praça, só aparece para quem rodou numa praça selecionada nos últimos 60 dias ou já está no ranking. | Não mostrar campanha de Campinas para quem só roda em São Paulo. |
| A11 | Teto de **10 campanhas lançadas e não encerradas por entidade**. | Limita o custo do recálculo a cada importação (escalabilidade). |
| A12 | Permissões novas no módulo `campanhas`: `campanhas.consultar`, `campanhas.gerir` (criar, lançar, cancelar), `campanhas.entregar` (registrar entrega e baixar planilha). Por padrão para `admin_entidade`. **Quais outros papéis recebem?** → operador. | Matriz papel×permissão. Lembrar o gotcha `financeiro`/`financeiro_aprovador` do CLAUDE.md. |

## 4. Modelo de dados (migration `0127_campanhas.sql`, aditiva e idempotente)

```
Campanha
  id, id_empresa, nome (≤120), descricao (≤1000)
  data_inicio date, data_fim date             CHECK fim >= inicio, duração ≤ 92 dias
  pracas text[] NULL, turnos text[] NULL      NULL = todas/todos
  modais text[] NULL                          NULL = todos (D6); comparação canônica (trim + upper)
  min_turnos smallint ≥ 1
  peso_aceitacao, peso_conclusao, peso_tempo, peso_pedidos  smallint 0..100
     CHECK soma = 100 e pelo menos um > 0
  corte_aceitacao, corte_conclusao, corte_tempo numeric(5,4) NULL (fração 0..1)
  corte_pedidos int NULL
  avisar boolean
  criada_por, criada_em, lancada_por, lancada_em NULL
  cancelada_por, cancelada_em, motivo_cancelamento NULL
  fechada_em NULL, dados_ate date NULL, aviso_inicio_em NULL, aviso_fim_em NULL
  ⇒ GATILHO: com lancada_em preenchido, recusa UPDATE de qualquer coluna de regra
    (só aceita cancelamento, fechamento, dados_ate e marcas de aviso) e recusa DELETE.
    A imutabilidade mora no BANCO, não na tela.

CampanhaPremio      (campanha_id, posicao_de, posicao_ate, tipo 'objeto'|'dinheiro',
                     descricao, valor_centavos NULL, foto bytea NULL, foto_mime NULL)
                     faixas sem sobreposição (EXCLUDE ou checagem na RPC de lançar); mesma imutabilidade

CampanhaRanking     PK (campanha_id, entregador_id)
                     turnos, ofertadas, aceitas, completadas, pedidos, online_epoch, periodo_epoch,
                     nota numeric(6,2), nota_hipotetica, posicao, posicao_anterior,
                     situacao 'classificado'|'abaixo_corte'|'sem_minimo'|'sem_modal', motivo_corte text[]
                     modal text NULL (o valor usado no recálculo)
                     INDEX (campanha_id, situacao, posicao)

CampanhaVencedor    (campanha_id, posicao, entregador_id, premio_id,
                     entregue_em, entregue_por, observacao, exportado_em)
                     gravado UMA vez no fechamento; só os campos de entrega/exportação mudam
```

RLS por `id_empresa` (escopo do JWT) em todas as tabelas. GRANT mínimo, com a lição da 0052:
conferir o GRANT por coluna, porque `has_table_privilege` engana nesse caso. `PREMIO_CAMPANHA`
(+1) entra em `LancamentoExternoTipo` por INSERT.

## 5. Cálculo (uma RPC, um caminho)

`hub_campanha_recalcular(p_campanha_id)` (SECURITY DEFINER, plpgsql):

1. Agrega `mv_performance_dia` no período, filtrando turno por `periodo = ANY(turnos)` e
   praça por semi-join em `PerformanceTurno`. O turno conta inteiro se tocou uma praça
   selecionada (mesma semântica da Performance, D1 da 0051).
2. Com `modais` definido: sem modal → `sem_modal`; modal diferente dos escolhidos → fora (nem gravado).
   `sem_minimo` se turnos < `min_turnos`; `abaixo_corte` se algum indicador com peso > 0
   ficou abaixo do corte (guardando quais em `motivo_corte`).
3. Notas: taxa × 100; tempo = min(online ÷ período, 1) × 100; pedidos ÷ máx(pedidos dos classificados) × 100.
4. `nota = Σ peso × nota_indicador ÷ 100`; posição por `row_number()` com o desempate A6.
   Para quem está abaixo do corte: `nota_hipotetica` e posição hipotética contra os classificados.
5. `posicao_anterior` = posição antes deste recálculo. Grava com `INSERT … ON CONFLICT DO UPDATE` numa transação só.

Quem chama:
- o **gancho de importação** (logo depois de `hub_performance_refresh_mv`):
  `hub_campanhas_recalcular_ativas(id_empresa)` roda as campanhas lançadas, não canceladas
  e não fechadas, com início ≤ maior dia importado. Se a importação já cobre `data_fim`, a
  mesma chamada **fecha** a campanha: recálculo final, `fechada_em`, gravação de
  `CampanhaVencedor` e aviso de resultado (`na_fila`);
- a **varredura de 60 s** dos avisos: `hub_campanhas_avisar_inicio()`, idempotente por
  `aviso_inicio_em`. Ela só insere aviso `na_fila`; a mesma varredura entrega.

## 6. API

Hub (`routes/hub-campanhas.js`, `requireModuloAtivo('campanhas')` + permissão; lógica pura em `lib/campanha-dto.js`):

| Método | Rota | Permissão |
|---|---|---|
| GET | `/campanhas?situacao=` | consultar |
| GET | `/campanhas/opcoes?pracas=&turnos=` → praças, turnos (mesma consulta de `/performance/areas`), modais distintos, cobertura de pedidos e alcance (quantos rodaram, quantos sem modal) | gerir |
| POST / PUT | `/campanhas`, `/campanhas/:id` (só rascunho) | gerir |
| POST | `/campanhas/:id/lancar` com `{ confirmo: true }` | gerir |
| POST | `/campanhas/:id/cancelar` com `{ motivo }` | gerir |
| POST | `/campanhas/:id/fechar` (A4, a partir de fim + 3 dias) | gerir |
| GET | `/campanhas/:id`, `/campanhas/:id/ranking?situacao=&pagina=` | consultar |
| GET | `/campanhas/:id/ranking.csv` | consultar |
| GET | `/campanhas/:id/premios-dinheiro.xlsx` | entregar |
| POST | `/campanhas/:id/vencedores/:posicao/entrega` | entregar |
| PUT / GET | `/campanhas/:id/premios/:pid/foto` | gerir / consultar |

App (`routes/motorista-campanhas.js`, mesma autenticação e limitador do `motorista-adiantamento.js`):
`GET /motorista/campanhas` (ativas + encerradas há até 30 dias) e `GET /motorista/campanhas/:id`
(minha linha + top 10 + prêmios + regras). O nome abreviado é **montado no servidor**: o
nome completo de outro motorista nunca sai para o app.

Toda escrita é auditada (`lib/hub-auditoria.js`): criar, editar rascunho, lançar, cancelar, fechar, registrar entrega, exportar planilha.

## 7. Pilares: o que cada um exige, verificável

**Deduplicação**
- Indicadores: só da `mv_performance_dia`, sem segunda fórmula. Unidade com o mesmo critério de `hub-performance-meta.js`.
- Praças/turnos: `GET /performance/areas`, que já existe.
- Planilha de prêmio: cabeçalho **importado** de `lib/lancamento-externo.js` (`CABECALHO_ESPERADO`, exportado), nunca redigitado.
- CSV: `lib/hub-csv.js` (já neutraliza injeção de fórmula). Avisos: mecanismo `na_fila` existente. Auditoria, RBAC e limitador: os existentes.
- UI: `KpiCard`, `PageHeader`, `FilterBar`, `EmptyState`, `PeriodFilter` do hub; `glass` e tokens do app. Rótulos iguais aos da Performance.

**Escalabilidade**
- O ranking é **materializado** a cada importação (3×/dia): a leitura do app é busca por PK mais o top 10 pelo índice. Custo constante por motorista, qualquer que seja o tamanho da base.
- Teto A11 (10 ativas por entidade) e duração máxima de 92 dias limitam o recálculo.

**Segurança**
- Imutabilidade por gatilho no banco; o `{ confirmo: true }` é só a segunda trava.
- Identidade do motorista só pela claim; escopo multi-tenant só pelo token (constitution I–III); RLS em tudo.
- Validação na fronteira (`campanha-dto.js`): tamanhos, datas, soma dos pesos, faixas sem sobreposição, praças/turnos ⊂ valores conhecidos.
- Foto: bytes iniciais conferidos, 500 KB, `Content-Type` fixo, `nosniff`, sem SVG.
- Nome abreviado no servidor; gate `owasp-security` antes do PR.

**Performance (orçamento, medido no hub-test com volume sintético de 900 mil turnos, como na 0051)**
- `hub_campanha_recalcular`: ≤ 2 s por campanha de 30 dias.
- `GET /motorista/campanhas/:id`: ≤ 50 ms no banco. Ranking do hub paginado: ≤ 100 ms.
- Sem `count(*) OVER ()` na consulta paginada (lição da 0051: 366 ms contra 0,8 ms); joins depois do `LIMIT`.

## 8. Execução: rito agêntico com agentes especialistas (depois da aprovação)

Worktree `.claude/worktrees/campanhas-motorista`, branch `feat/campanhas-motorista`. Plano fechado; a execução é em Sonnet.

| Onda | Agente (Sonnet) | Entrega | Gate da onda |
|---|---|---|---|
| W1 | `database-architect` | 0127 + RPCs + gatilho + GRANT/RLS + driver `infra/hub/testes/campanhas-db.sh` | migrate no hub-test; **prova em banco** de imutabilidade, RLS e fechamento (stub não vê gatilho); orçamento de 2 s medido |
| W2 | `fullstack-developer` (backend) | rotas hub + app, `campanha-dto.js`, XLSX, foto | `npm test` verde; suíte do hub; integração |
| W3a / W3b em paralelo | `fullstack-developer` ×2 | telas do hub (5) · telas do app (4) | `tsc` 0, vitest, `next build` dos 2 frontends, **detector impeccable 0 achados**, lint ≤ baseline |
| W4 | `fullstack-developer` | E2E Playwright (lançar → confirmar → editar recusado → ranking no app → fechar → entrega) pelo driver | E2E verde pelo driver; `package-lock.json` revertido |
| W5 | revisão **independente** sobre o diff: `owasp-security` + `code-review` (camadas) | lista de achados | cada achado **medido** antes de aceitar (regra do rito 1b) |
| W6 | Opus | commit → PR → merge (aviso) | rito git completo |
| W7 | Opus | build `<rótulo>-<sha7>`, migration, deploy, **prova de bundle** por string | 5 gates de produção |

Decisão que surgir no meio da execução **volta para o Opus**; o subagente não decide.
Onde o "não parar por nada" esbarra no que já foi acordado:
- o envio ao remoto (push) é sempre bloqueado: deixo o comando pronto para você colar com `!`;
- o deploy segue a autorização standing de 30/09 (não destrutivo), com **janela a confirmar** (§9);
- se o classificador bloquear o merge ou o `service update`, não contorno: entrego o comando.

## 9. Pendências do operador

1. ~~Aprovar telas e A1–A12~~ ✅ 2026-11-22.
2. ~~A12~~ ✅ `admin_entidade` + `financeiro` (+ `financeiro_aprovador`, pela 0115).
3. ~~Consulta de cobertura~~: dispensada. A P1 é medida na hora pelo formulário (§2).
4. **Janela de deploy** (gate 2): só é necessária na W7, e a execução não espera por ela.

## 10. Fora do escopo (v1), de propósito

Atualização em tempo real (a origem é D-1) · conquistas/selos permanentes entre campanhas ·
pagamento automático do prêmio · 5ª aba no app · campanha por equipe · editar campanha lançada.
