# Research: Adiantamento pelo App, Dados Bancários e Exportação Transfeera

Documento do Phase 0 do `/plan`. **Não reprojeta** a feature: o desenho foi aprovado pelo
operador em 2026-09-17 em [`PLANO.md`](../../plans/adiantamento-motorista/PLANO.md)
§10–§26. Aqui ficam (a) a confirmação de que o Technical Context não tem
`NEEDS CLARIFICATION`, (b) os fatos do código que o desenho usa, com a fonte, e (c) as
decisões de implementação que o PLANO deixou em aberto ou que o código real obrigou a
ajustar. Cada ajuste tem Decisão auditada no estado da execução (`dec-NNN`).

Paths relativos à raiz do repositório. `B/` = `app_homologacao/backend/`,
`V2/` = `app_homologacao/frontend_v2/`, `APP/` = `app_homologacao/frontend_motorista/`,
`MIG/` = `infra/hub/migrations/`.

## Status dos unknowns

| Campo do Technical Context | Resultado | Fonte |
|---|---|---|
| Linguagem/runtime | Node 20 (imagem `Dockerfile.hub`), TypeScript nos frontends | CLAUDE.md; `B/Dockerfile.hub` |
| Dependências | as já instaladas; nenhuma nova | `B/package.json`; PLANO §15.1 |
| Persistência | Postgres do hub via PostgREST, série `MIG/0066+` | PLANO §12; `ls MIG` (0065 é a última) |
| Testes | `node --test`, vitest (V2), runner nativo (APP), drivers `infra/hub/testes/*.sh` | package.json dos três projetos |
| Plataforma | containers existentes (Swarm); sem serviço novo | CLAUDE.md; PLANO §17 |

**NEEDS CLARIFICATION restantes: 0.** Nenhum eixo estrutural (linguagem, stack,
arquitetura, persistência, ambiente-alvo, tier) é decidido aqui: a feature herda a stack
do projeto (dec-013).

---

## Decision 1: Stack herdada, sem dependência nova

**Decision**: backend Express 4 + PostgREST (JWT por requisição, RLS) + funções SQL
`SECURITY DEFINER`; `frontend_v2` (Next 16.2.3, React 19.2.4, Tailwind 4,
`@base-ui/react` ^1.3.0) para o hub; `frontend_motorista` (Next 16.2.3, Serwist 9) para o
app. Excel com o `xlsx` ^0.18.5 (SheetJS CE) que já está no backend.
**Rationale**: PLANO §15.1 provou o `xlsx` gravando o layout (aba `Página1`, mescla
`A1:L1`, texto preservando `033`/`0001`, moeda `"R$" #,##0.00`). O briefing §4 proíbe
dependência nova para isso. dec-013.
**Alternatives considered**: exceljs (dependência nova; rejeitada); cirurgia em XML de um
template (mais código; PLANO §15.1 deixou fora).

## Decision 2: Cálculo do dinheiro e fronteiras de horário em SQL

**Decision**: produção, bruto, taxa e líquido são calculados **dentro** da função que
muda o estado (`hub_adiantamento_processar`), em `numeric`, com
`bruto = round(producao * percentual / 100, 2)` e `liquido = bruto - taxa`. A decisão de
criar uma solicitação (dia habilitado, `abertura <= agora < corte`, D-1) também é do SQL,
com `now() AT TIME ZONE <timezone da versão>`. O Node (`lib/adiantamento-regras.js`)
reproduz a mesma regra com `Intl` apenas para montar o `GET /disponibilidade` (motivo,
próxima oportunidade, estimativa) e nunca decide a criação.
**Rationale**: PLANO §17 ("uma fonte só, sem ponto flutuante"). `round(numeric, 2)` no
Postgres arredonda empates para longe do zero; como bruto > 0, isso é "meio para cima"
(D-06): `129,345 → 129,35`, `129,344 → 129,34`. O container roda em UTC (PLANO §2.2),
então todo "hoje/ontem/agora" leva o fuso da configuração explicitamente.
**Testabilidade**: a regra de janela fica numa função SQL interna e pura
(`hub_adiantamento_janela(config, instante)`, sem `GRANT` a `authenticated`) chamada pela
RPC pública com `now()`. O driver de integração testa as fronteiras
(`08:59:59 ✗ · 09:00:00 ✓ · 14:59:59 ✓ · 15:00:00 ✗`, domingo desabilitado, virada de mês
e ano) chamando a função interna com instantes fixos, como superusuário do stack de teste.
Nenhuma RPC pública aceita "agora" do cliente (edge 27).
**Alternatives considered**: cálculo no Node com `Number` (rejeitado: ponto flutuante);
parâmetro `p_agora` na RPC pública (rejeitado: abriria manipulação de horário).

## Decision 3: Identidade do motorista nas RPCs

**Decision**: as rotas novas do app chamam as RPCs com claims
`{ motoristaCnpj: req.motorista.cnpjPrestador, escopo: <ids do grupo Movee> }`. O SQL
resolve `hub_jwt_motorista_cnpj() → "ContaMotorista".cnpj_prestador →
"Entregador".motorista_id` a cada chamada e confere que `Entregador.id_empresa` está no
escopo. O escopo do grupo é calculado no servidor com `mesmoGrupoQue(6, 6, cache)`
(`B/routes/grupo.js:903`), lendo `cache.ids` como faz `resolverContextoAvisos`
(`B/routes/hub-avisos.js:126`). Nenhum id de conta, entregador ou empresa vem do corpo.
**Rationale**: é o mecanismo do push já em produção
(`hub_aviso_para_motorista`, `MIG/0061_push_avisos.sql:313-334`). Não depende de
`entregadorUuid`, que o `POST /motorista/token/refresh` descarta
(`B/routes/motorista.js:490`) — a mesma classe de bomba da `entidade_ativa` descrita no
CLAUDE.md. Funciona com o login legado (tabela `Motorista`), que é o que roda em produção,
porque a chave é o CNPJ. dec-015.
**Consequências**: sem `ContaMotorista` para o CNPJ, ou sem `Entregador` vinculado, o
motivo é `NOT_LINKED` (Q-B6 decide quantos motoristas estão nessa situação em produção).
**Alternatives considered**: lookup no Node por requisição + ids passados à RPC (dois
caminhos para a mesma regra; rejeitado).

## Decision 4: Formato das rotas novas

**Decision**:
- **App**: novo `B/routes/motorista-adiantamento.js`, pendurado no router do motorista
  atrás de `authenticateMotorista`, no mesmo padrão do push
  (`motoristaRoutes.router.use('/', motoristaRoutes.authenticateMotorista, …)`,
  `B/server.js:2847`). Paths finais `/motorista/...`; o app chama `/api/motorista/...`
  pelo proxy `APP/app/api/[...path]/route.ts`. Erros no formato `{erro:'CODIGO', motivo?}`
  (como `B/routes/motorista-push.js`); JSON em camelCase; dinheiro em string decimal.
- **Hub**: novo `B/routes/hub-adiantamentos.js`, montado em `/api/v1/adiantamentos` no
  `server.js` (junto das montagens de `:2855-2914`). Cadeia de guarda
  `requireModuloAtivo('adiantamentos')` (`B/middleware/hub-require-modulo.js:23`) →
  `requirePermission('adiantamentos.<acao>')` (`B/middleware/hub-require-permission.js:40`)
  → `resolverContextoAdiantamentos` local (cópia deliberada do padrão
  `resolverContextoAvisos`, com `FORA_DO_GRUPO_MOVEE`). Paginação `page`/`pageSize`
  (padrão 20, máximo 100); datas `de`/`ate` (`YYYY-MM-DD`).
- **Listas**: `{itens,total,page,pageSize}` (PLANO §16.2; mesmo formato de `hub-avisos.js:256`).
  As outras rotas do hub usam `items`; a divergência é conhecida e registrada (dec-014).
**Rationale**: reaproveita a cadeia de guarda e o formato de erro mais recentes do mesmo
domínio (grupo Movee).
**Alternatives considered**: montar o router do app direto em `server.js` (duplicaria a
montagem de `authenticateMotorista`).

## Decision 5: Mensagem de erro no app (FR-054) e sessão ao abrir (FR-053)

**Decision**: `APP/lib/api-client.ts` passa a ler `body.erro` (código) além de
`message`/`error` (`:47` hoje) e traduz o código por um mapa pt-BR em
`APP/lib/erros-adiantamento.ts`. O guarda do grupo `(app)` (`APP/app/(app)/layout.tsx`)
tenta `POST /motorista/token/refresh` uma vez antes de redirecionar ao login quando o
`/verify-auth` responde 401. O `POST /motorista/logout` deixa de exigir access válido,
para conseguir limpar os cookies com o access expirado (PLANO §29 item 2; Q-N16).
**Rationale**: PLANO §29 itens 2 e 4 entram por Q-N16 (briefing §3).
**Alternatives considered**: timer de refresh mais curto (não resolve reabrir o app
depois de 15 min).

## Decision 6: Tick de corte em processo

**Decision**: `B/lib/adiantamento-worker.js` exporta `iniciarTickAdiantamentos(deps)`,
iniciado no bloco `if (process.env.POSTGREST_URL)` de `B/server.js` (`:2953`), com
`deps.agendarIntervalo` (= `setInterval`) como o `hub-push-worker.js:81`. A cada 60 s e no
boot: `rpc/hub_adiantamento_processar(p_limite => 200)`; cancelamento de lotes `GERANDO`
com mais de 5 min; e, uma vez por dia, expurgo dos bytes de arquivo com mais de 90 dias
após o lote concluir ou ser cancelado. As chamadas do worker usam uma claim nova,
`hub_adiantamento_worker` (entrada `adiantamentoWorker` em
`B/lib/hub-postgrest-jwt.js:77`, função SQL `hub_jwt_adiantamento_worker()` no padrão de
`hub_jwt_push_worker()` em `MIG/0061:32-37`).
**Rationale**: PLANO §17. `FOR UPDATE SKIP LOCKED` (padrão de `hub_push_reivindicar`,
`MIG/0061:584`) torna o tick seguro com mais de uma réplica. O `setInterval` do worker tem
guarda de reentrância (não inicia um ciclo se o anterior não terminou).
**Alternatives considered**: timer systemd no host (acopla o fluxo financeiro ao host,
fora do container; rejeitado pelo PLANO §17).

## Decision 7: "Produção disponível" (R-08)

**Decision**: para a data D-1 e a empresa do entregador, a produção está disponível
quando (a) existe ao menos uma linha da fonte naquela data para a empresa
(`FaturamentoLancamento.data_lancamento` ou `.data_referencia`, ou
`PerformanceTurno.data_periodo`) **e** (b) não existe `ImportacaoArquivo` do tipo
correspondente (`faturamento` ou `performance`) com `status IN
('pending','validating','processing')` para a empresa.
**Rationale**: a tabela real é `"ImportacaoArquivo"` (`MIG/0011_importacao_arquivo.sql`),
com `tipo IN ('faturamento','performance','envio_massa')` e o índice-mutex de importação
ativa em `('validating','processing')` (`:48-50`). `pending` também conta como "em
andamento" porque o arquivo já foi aceito e vai ser processado; um `pending` preso
aparece como pendência visível, resolvida por recálculo ou encerramento (Q-N14).
**Alternatives considered**: só `validating/processing` (calcularia com um dia que ainda
vai mudar).

## Decision 8: Fontes da produção e categorias

**Decision**:
- `financeiro_lancamento`/`financeiro_referencia`: `sum(valor)` de
  `FaturamentoLancamento` com `tipo = 'Credito'`, `descricao = ANY(categorias_producao)`,
  `entregador_id` do vínculo e a data escolhida = D-1. Débitos não reduzem a produção
  (Q-N10).
- `performance_taxas`: `sum(taxas_centavos) / 100` de `PerformanceTurno` do entregador em
  `data_periodo = D-1` (linhas gêmeas não deduplicadas — aviso na tela, PLANO §28).
- O snapshot guarda `producao_valor`, a quantidade de lançamentos e a soma por categoria
  (`producao_por_categoria` jsonb).
- `GET /configuracoes/categorias` lista os `descricao` distintos dos últimos 90 dias e
  marca os que só aparecem com `entregador_id` nulo ("sem motorista identificado").
**Rationale**: PLANO §2.4, R-07, D-01, D-02. Colunas confirmadas em
`MIG/0013_faturamento_lancamento.sql:14-43` (`valor numeric(12,2)`, `tipo`, `descricao`,
três datas) e `MIG/0014_performance_turno.sql:34` (`taxas_centavos int`). O `CHECK valor > 0`
foi removido em `MIG/0054:43`: a soma aceita o valor como está.

## Decision 9: Remanescente e fechamento

**Decision**:
- Janela W de 7 dias que começa no último dia `apuracao_dia_inicio` (0 = domingo) ≤ data;
  `fim = inicio + 6`; `data_repasse = fim + apuracao_dias_ate_repasse`. O período é
  identificado pela data de início (`?periodo=AAAA-MM-DD`).
- Por entregador: créditos (`tipo='Credito'`, `descricao = ANY(categorias_extrato)`,
  `apuracao_data_base ∈ W`) − (se ligado) `valor_bruto` das solicitações `PAGA` com
  `data_producao ∈ W` − (se ligado) `sum(abs(valor))` dos lançamentos `tipo='Debito'` com
  data base ∈ W (Q-N9; validar com o primeiro débito real).
- **Previsão** (hub e app): também desconta as `EXPORTADA` do período, marcadas como
  "em processamento" (Q-N3).
- **Fechamento**: grava `ApuracaoRepasse` + itens com o que está `PAGA`; o diálogo de
  confirmação mostra, só como informação, quantos adiantamentos do período ainda não
  estão pagos (dec-020). Período já fechado → `409 APURACAO_JA_FECHADA`.
- Negativo aparece com alerta e não acumula (Q-N4).
**Rationale**: PLANO §18, R-15, D-09..D-13, Q-N3, Q-N4, Q-N9. Fechamento é ação explícita
(FR-041/FR-049). A leitura "só aceita pagos = desconta só pagos" é a literal do texto
aprovado; ela está listada em "Pontos para confirmação" no `plan.md`.

## Decision 10: Excel Transfeera

**Decision**:
- `B/lib/adiantamento-transfeera-xlsx.js` exporta `montarPlanilhaTransfeera(itens)` e
  `validarPlanilhaTransfeera(buffer, contrato, esperado)`, funções puras. Colunas de texto
  com `t:'s'`; a coluna I com `t:'n'` e `z:'"R$" #,##0.00'`; `!merges` com `A1:L1`;
  `!cols` com as larguras do modelo.
- O contrato vive em `B/lib/fixtures/transfeera-contrato.json` (aba, texto da linha 1,
  12 cabeçalhos, mescla; sem dado pessoal), gerado por
  `B/scripts/extrair-contrato-transfeera.js` a partir do `modelo_transfeera.xlsx` local.
  Um teste compara fixture × modelo **só se** o modelo existir no disco.
- Os itens do lote guardam o snapshot já formatado (12 colunas em texto + `valor numeric`);
  o arquivo é gerado **uma vez** a partir desse snapshot.
- O validador confere a soma em **centavos inteiros** (a partir das strings), nunca
  somando `Number`s.
- Os bytes trafegam entre Node e PostgREST em base64 (`decode(p_arquivo,'base64')` na
  gravação; `encode(arquivo,'base64')` na leitura) e o sha256 é conferido no download.
- O ID integração usa `'ADV-' || lpad(id::text, 6, '0')` **só** enquanto `id < 1000000`;
  acima disso, `'ADV-' || id::text`. (`lpad` do Postgres **trunca** textos maiores que o
  tamanho pedido; o `padStart` do JS não trunca. A regra fica igual nos dois lados.)
- A Descrição Pix é cortada em 140 **caracteres** (pontos de código, `Array.from`), não
  em bytes.
**Rationale**: PLANO §7, §15, FR-028/FR-055, D-18..D-22. A leitura do buffer pelo
validador é de um arquivo gerado pelo próprio processo: as CVEs de leitura da 0.18.5
(PLANO §15.1) valem para arquivo de terceiros, que só aparece na F9 (fora desta rodada).
A fixture do repo não tem dado pessoal, porque o `modelo_transfeera.xlsx` real tem e hoje
está liberado pelo `.gitignore:15` (`!docs/documentos_apoio/modelo_*.xlsx`); a F0 fecha
essa brecha.
**Alternatives considered**: gravar o arquivo em disco no volume de uploads (mais uma
superfície de acesso; PLANO §15.2 escolheu o banco).

## Decision 11: Notificações (D-15)

**Decision**:
- `"Aviso"` ganha `origem` (`hub`/`sistema`, padrão `hub`) e `categoria`; `criado_por`
  passa a aceitar nulo **só** quando `origem = 'sistema'` (CHECK). Hoje é
  `int NOT NULL REFERENCES "Usuario"(id)` (`MIG/0061:64`).
- `"NotificacaoMotorista"` é chaveada por `cnpj_prestador` (`NOT NULL`), com
  `conta_motorista_id` opcional, índice `(cnpj_prestador, criada_em DESC)` e índice
  parcial `WHERE lida_em IS NULL` (dec-016). Motivo: a fonte de público dos avisos pode
  ser `legado` (tabela `Motorista`, sem `ContaMotorista`) — `B/routes/hub-avisos.js:295` —
  e o app identifica o motorista pela claim de CNPJ.
- `hub_aviso_criar` passa a gravar o histórico para **todo** o público (nova função de
  alcance que não exige `PushInscricao`) e as entregas de push só para quem tem inscrição.
  O erro `SEM_INSCRICOES_ATIVAS` (`MIG/0061:451-453`) deixa de valer quando há público sem
  push; público vazio passa a ser `SEM_DESTINATARIOS`. Aviso sem nenhuma entrega é criado
  já `concluido`.
- `hub_aviso_para_motorista` passa a autorizar pela linha de `NotificacaoMotorista`
  (hoje exige `AvisoEntrega`, `MIG/0061:313-334`).
- Eventos do sistema (8, PLANO §19) criam, na mesma transação da mudança de estado, o
  `Aviso(origem='sistema', modo 'individual')`, a notificação e as entregas de push; o
  worker de push existente entrega. EM_LOTE não notifica (dec-019; FR-013 alinhado).
- A retenção acompanha o `Aviso` (expurgo de 90 dias existente, `hub_push_expurgo`,
  `MIG/0061:651-665`) via `ON DELETE CASCADE`.
**Rationale**: PLANO §12.6, §19, D-15, Q-N6, Q-N7, Q-N8.

## Decision 12: Auditoria

**Decision**: `registrarAuditoria` (`B/lib/hub-auditoria.js:148`) para todos os eventos
da PLANO §22. A policy de INSERT de `"Auditoria"` (versão vigente em
`MIG/0063_auditoria_push_worker.sql:24-43`) ganha dois ramos: (a) ações
`adiantamento.solicitado`/`.cancelado` e `conta_bancaria.solicitada` com
`hub_jwt_motorista_cnpj()` não nulo e `id_empresa` igual à empresa do entregador daquele
CNPJ; (b) ações `adiantamento.calculado`/`.aguardando_producao`, `adiantamento.lote_cancelado`
(órfão) com `hub_jwt_adiantamento_worker()`. `detalhes` nunca leva documento, conta nem
bytes; o `scan-auditoria-sensivel.sh` (`infra/hub/scripts/`) roda no driver novo.
**Rationale**: PLANO §22 ("A F1 cobre isso"). dec-017.

## Decision 13: Testes do app motorista e E2E

**Decision**: o `frontend_motorista` não tem vitest nem Playwright; a lógica testável
(montagem de estado da tela de disponibilidade, validação do formulário bancário, máscara,
mapa de erros) vai para `APP/lib/*.ts` puros, testados pelo runner nativo já configurado
(`node --experimental-strip-types --test …`). O E2E do app segue o padrão do push:
`V2/playwright.config.motorista-adiantamento.ts` + `V2/tests/e2e-motorista-adiantamento/`
+ driver `infra/hub/testes/hub-motorista-adiantamento-e2e-browser.sh`. O E2E do hub:
`V2/playwright.config.hub-adiantamentos.ts` + `V2/tests/e2e-hub-adiantamentos/` + driver
`infra/hub/testes/hub-adiantamentos-e2e-browser.sh`.
**Rationale**: zero dependência nova; precedente dec-107 do push (config em `frontend_v2`
porque o `@playwright/test` e o `@axe-core/playwright` já estão lá). dec-018.

## Decision 14: Permissões, módulo e papel

**Decision**: migration no padrão da `MIG/0062_modulo_avisos.sql` (tudo
`ON CONFLICT DO NOTHING`): `"Modulo"(codigo='adiantamentos', nome='Adiantamentos',
ordem=35)`; 10 `"Permissao"(codigo, modulo_id)`; `"Papel"(nome='financeiro',
escopo='entidade', is_sistema=true)`; `"PapelPermissao"` para `financeiro`,
`admin_plataforma` e `admin_entidade`; `"ModuloEntidade"(modulo, 6, true)`; versão 1 da
configuração com D-04, D-05, D-21 e Q-N2, e os campos de Q-B2/Q-B3 nulos.
**Rationale**: colunas reais — `Papel` tem `nome` (não `codigo`), `Permissao` não tem
descrição (`MIG/0003_papel_permissao_modulo.sql:6-32`); ordem 35 livre
(`MIG/0007`: faturamento 30, performance 40). O rótulo pt-BR de cada permissão vai para
`V2/lib/hub/rotulo-permissao.ts` (o teste `rotulo-permissao.test.ts` exige).

## Decision 15: Achados de segurança herdados (registrar, não corrigir aqui)

- `authenticateMotorista` chama `jwt.verify(token, JWT_SECRET)` sem fixar `algorithms`
  (`B/routes/motorista.js:161`). Com `jsonwebtoken` ^8.5.1 e segredo HMAC, a troca de
  algoritmo não é explorável como no caso de chave pública, mas fixar `['HS256']` é
  defesa em profundidade. Fica listado em "Achados fora do escopo" do `plan.md`.
- Nenhuma resposta CSV do hub define `Cache-Control`; o download do Excel **define**
  `Cache-Control: no-store` (PLANO §20).
- O `console.log('[proxy-debug]')` do proxy do `frontend_v2` (PLANO §29 item 1, Q-N17)
  segue em PR separado.
