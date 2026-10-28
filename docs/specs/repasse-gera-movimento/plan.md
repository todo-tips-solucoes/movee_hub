# Implementation Plan — `repasse-gera-movimento`

**Feature**: `repasse-gera-movimento` · **Data**: 2026-10-28 · **Fase**: plan concluída
**Spec**: `docs/specs/repasse-gera-movimento/spec.md`
**Briefing (fonte autoritativa de requisito)**: `docs/plans/repasse-gera-movimento/BRIEFING.md` — D1–D12, **nenhum item a definir**
**Constitution**: `docs/constitution.md`
**Artefatos irmãos**: `research.md` (M1–M14 + Decisions 1–8) · `data-model.md` · `contracts/hub-repasse-gerar-movimentos.md` · `contracts/ui-gerar-do-repasse.md` · `quickstart.md`

> Prefixos: `BK = app_homologacao/backend` · `FE = app_homologacao/frontend_v2` · `MIG = infra/hub/migrations`.
> Todo `path:linha` neste plano vem de leitura direta do repositório (medições M1–M14 em `research.md`). Nada é suposto (Constitution VI).

---

## Summary

A dedução dos valores pagos por fora está em produção e **sem efeito**, porque depende do fechamento da apuração — passo que a operação nunca executa (medido: `ApuracaoRepasse` com **0 linhas** na história). A correção pedida é que **o repasse passe a preencher o Envio em Massa**, e daí em diante o fluxo seja o que já roda.

A frente é um **desacoplamento**, não uma construção: as seis peças do mecanismo já existem e estão testadas (BRIEFING §3). Mas o levantamento desta fase achou **uma sétima peça que falta de verdade** e que o briefing atribuía a D3: **a dedução do pago por fora hoje não alcança a nota** (`research.md` M5 — ela entra só no `remanescente`, enquanto `valor_nota` é gravado bruto). Sem corrigir isso, o desacoplamento entregaria a nota **cheia** e a frente continuaria sem efeito, por outro motivo. É por isso que existe migration `0118`.

**Abordagem técnica**, em quatro frases:

1. A rota `POST /repasse/:periodo/movimentos` passa a **fechar a apuração se ela não existir** e segue gerando na mesma requisição, tornando-se **re-entrante** — porque não existe transação entre chamadas HTTP PostgREST e **rollback de apuração é impossível** (imutabilidade por `REVOKE` + trigger). A garantia entregue é **retrato atômico + geração idempotente, nunca um beco sem saída**.
2. A migration **`0118`** congela, dentro da transação do fechamento, **uma** coluna nova — `nota_a_emitir` — com a nota já líquida da dedução; o **excedente** vai para `transportado_nota` **negativo**, único caminho que não exige alterar um CHECK de conservação de dinheiro.
3. O pré-flight de **pendências de adiantamento** passa a rodar **sempre** e a **nomear** quem trava, com cap de 20 e sem expor CNPJ.
4. **Um** componente de UI, montado em duas telas: tela de Repasse (recebe a semana por prop) e tela de Envio em Massa (traz o próprio seletor, porque ali não existe semana na tela).

---

## 🔴 O problema arquitetural de D1, e a decisão

D1 diz *"fecha a apuração **e** gera num passo só, **em transação**"*. Medido:

| Fato | Onde |
|---|---|
| O backend fala com o banco por **PostgREST, via HTTP**. Cada `hubPostgrestRequest` é uma requisição independente — **não existe transação entre duas chamadas HTTP** | `BK/routes/hub-adiantamentos.js:2177` em diante (~10 chamadas + N inserts) |
| O fechamento **já é** uma transação única completa (permissão, advisory lock, 5 recusas nomeadas, INSERT da apuração + de todos os itens) | `MIG/0117_lancamento_externo.sql:708` |
| A geração **já é** não-atômica por motorista, **por desenho declarado**: *"Insere um a um: um CNPJ que falhe não pode derrubar a rodada inteira"* | `BK/routes/hub-adiantamentos.js:2402`–`:2405` (comentário reescrito pelo S1; a ordem única e "um CNPJ que falhe não derruba a rodada" seguem lá) |
| **Rollback de apuração é impossível**: `REVOKE UPDATE, DELETE` + trigger `hub_bloqueia_alteracao_apuracao()` que faz `RAISE EXCEPTION` | `MIG/0066_adiantamento_tabelas.sql:460`–`:461` (REVOKE) · `:463`,`:470`–`:478` (trigger) |

**Decisão: opção (b)** — fechar e gerar em sequência, com recuperação idempotente e **re-entrante**. Justificativa completa em `research.md` Decision 1. O resumo:

- **(a) função SQL única** exigiria portar para `plpgsql` o `planejarGeracao` (lógica de **dinheiro**, pura, **8** ramos de recusa, testada) **e** o `renderizarMensagem`. Reescrever lógica de dinheiro que funciona é exatamente a lição que o BRIEFING §9 cobra (*"4 das 15 correções criaram defeito novo; as duas mais elegantes foram as mais caras"*). E teria de escrever na `EnvioMassa` por `SECURITY DEFINER` — tabela legada **sem RLS alguma**, onde o isolamento de tenant é mais frágil.
- **(c) função SQL que recebe as linhas já planejadas em `jsonb`** compra atomicidade do **lote** — contrariando o desenho de `:2306`, que prefere perder um CNPJ a perder a rodada — ao custo de um **caminho novo de escrita de dinheiro em SQL**, quando a trilha já torna a repetição segura. **YAGNI.**
- **Nenhuma** das três entrega "o estado volta ao anterior", porque o rollback não existe no banco.

**Reinterpretação declarada de FR-002 / Acceptance Scenario 3 / SC-003** — e a autoridade para fazê-la: a própria spec delega, em `spec.md:173`, *"Concorrência/falha parcial: coberto por FR-002/FR-017 e Edge Cases (transação única + idempotência); **detalhe técnico é do plan**"*.

| Letra da spec | O que é alcançável, medido | Onde |
|---|---|---|
| FR-002 *"mesma operação atômica"* | O **retrato** é atômico (o RPC é uma transação). A **geração** não é, e já não era | `MIG/0117:708` · `BK/.../hub-adiantamentos.js:2402` |
| AS-3 *"o estado volta ao anterior"* | **Não volta — continua.** `ApuracaoRepasse` é imutável; não existe desfazer | `MIG/0066:460`–`:461`, `:470`–`:478` |
| SC-003 *"0 casos de apuração fechada sem movimento após uma geração com falha"* | **Inatingível como escrito.** O que se mede no lugar: **0 casos de apuração fechada sem movimento que sejam TERMINAIS** — ou seja, toda apuração fechada sem movimento é **retomável** por um novo acionamento, e a retomada não duplica | `quickstart.md` C3 |

A metade que importa, e que o operador pediu em D4 (*"evita o estado 'apuração fechada sem movimento', que travaria a geração sem caminho de volta pela tela"*), é entregue integralmente: removido o `409 APURACAO_NAO_FECHADA` de `:2193`, **a própria rota é o caminho de volta**.

✅ **A spec FOI emendada** (`dec-028`, autorizada pelo operador na resposta ao `block-001`): `spec.md` SC-003 agora lê *"0 casos **terminais**"*, com a justificativa e as âncoras no próprio critério. O plano **deixou** de contradizer a letra da spec — não há mais divergência silenciosa para o `/analyze` apontar aqui. Âncora exata: `MIG/0066:460`–`:461` (`REVOKE UPDATE, DELETE`) e `:463` + `:470`–`:478` (trigger `hub_bloqueia_alteracao_apuracao()` com `RAISE EXCEPTION`).

⚠️⚠️ **E a trilha, hoje, NÃO é uma reserva** — ver §Gate `owasp-security` abaixo (achado S1). A re-entrância deste plano **depende** de ela passar a ser, e isso não é verdade no código atual. **Esta frente corrige** (decisão do operador, `dec-026`): §S1 traz o **único** mecanismo: id da `EnvioMassa` pré-alocado, reserva gravada com esse id, conclusão re-postando o **mesmo** id (`dec-038`, autorizado em `block-002` → `dec-040`).

---

## Technical Context

| Campo | Valor | Fonte |
|---|---|---|
| Linguagem/runtime (backend) | Node **20** (Alpine), Express, **sem ORM** | `BK/Dockerfile.hub`; `CLAUDE.md` |
| Persistência | PostgreSQL via **PostgREST**, funções `SECURITY DEFINER`; hub em banco próprio (`hub_homolog`) com RLS e JWT por requisição | `BK/lib/hub-postgrest.js`, `BK/lib/hub-postgrest-jwt.js` |
| Frontend | Next.js 16 App Router, React, Tailwind 4, **Base UI** (não Radix), shadcn | `FE/package.json`; `CLAUDE.md` |
| Testes | `node --test` (backend), **vitest** (frontend_v2), **Playwright** (E2E do hub, via drivers em `infra/hub/testes/*.sh`) | `CLAUDE.md` |
| Migrations | série única `MIG/NNNN_*.sql`, aplicada por `infra/hub/scripts/migrate.sh` em **uma transação** (logo nada `CONCURRENTLY`); registra em `"SchemaMigration"` | `MIG/0117:10`–`:11` |
| Migration desta frente | **`0118`** — ⚠️ nunca editar a `0117` | `data-model.md` |
| **Target Platform** | Linux x86-64 em **Docker Swarm** no host `VPSTodo`, atrás do Traefik: serviços `envio-massa-homologacao_backend_homologacao` (`node:20-alpine`, via `Dockerfile.hub`) e `envio-massa-homologacao_frontend_v2_homologacao` (Next.js standalone). ⚠️ Esse ambiente **é produção** — é o que os clientes usam | `CLAUDE.md` §Rito de produção |
| Ambiente de teste | `hub-homolog` isolado (Docker Compose, projeto `hub-homolog`); `preflight.sh` **obrigatório** antes do primeiro `up` | `infra/hub/RUNBOOK.md` |
| NEEDS CLARIFICATION | **0** — as 12 decisões do operador foram tomadas antes da especificação (BRIEFING §10) e as 8 decisões técnicas estão em `research.md` | — |

---

## Constitution Check

*GATE: passa antes do Phase 0 e re-checado após o Phase 1.*

| Princípio | Status | Notas |
|---|---|---|
| **I. Segurança de Autenticação & Segredos** (NON-NEGOTIABLE) | **PASS** | Nenhum segredo novo. JWT em cookies `httpOnly` inalterado. ⚠️ Montar `HubAuthProvider` no painel legado **não** cria fluxo de login novo nem toca cookie — só lê `/me` pelo proxy existente (`contracts/ui-gerar-do-repasse.md`) |
| **II. Isolamento Multi-Tenant por Empresa** (NON-NEGOTIABLE) | **FAIL — ver S2 e S7** | ⚠️ Duas falhas **pré-existentes** medidas: **S2** (permissão na entidade ativa, escrita na Movee) e **S7** (a consulta de "movimento aberto" na `EnvioMassa` **não tem filtro de `id_empresa` nenhum`). Como o princípio é NON-NEGOTIABLE, **aceitar risco não é opção disponível ao agente** — daí `block-001` |
| **III. Contratos de API & Proxy de Cookies** | **PASS** | Nenhuma rota nova. O browser continua falando só com `/api/*`; `GerarDoRepasseButton` usa `lib/hub/adiantamentos-api`, que vai pelo proxy |
| **IV. Qualidade e Revisão de Mudanças** | **PASS** | Branch dedicada, Conventional Commits, gates com números (§Gates). ⚠️ Entrega de agente deste tamanho exige **revisão adversarial sobre o diff antes do PR** — na frente `corrigir-valor`, 16 ondas verdes não pegaram 3 bloqueantes que a revisão independente achou |
| **V. Deploy Conteinerizado e Convivência** (NON-NEGOTIABLE) | **PASS** | Nada de novo serviço. ⚠️ A `0118` é **artefato**; aplicar em produção é ato do operador sob os 5 gates |
⚠️ **Não existe "Princípio VI" em `docs/constitution.md`** — o arquivo (v1.1.0) define **I a V**. A disciplina de veracidade de dados / zero fabricação que este plano segue vem do **contrato do agente que o gerou**, não da constitution do projeto. Uma versão anterior deste plano listava um "VI" como se fosse principio do projeto: fabricação, corrigida (dec-022).

**Re-check pós-Phase 1**: nenhuma camada, serviço ou dependência nova; Complexity Tracking **vazio**. ⚠️ O re-check **reprovou** o Princípio II por S2 e S7. **Disposição** (`dec-026`, opção B do operador): **S7 é corrigido nesta frente** (F2) e **S2 fica deferido com gatilho medido** — decisão explícita do operador sobre um achado NON-NEGOTIABLE, com a medição que a sustenta em `deferred-work.md` §S2. O Princípio II segue **reprovado por S2**, de forma **declarada e autorizada**, não silenciosa.

---

## As questões que este plano tinha de fechar

### 1 · D3 — o excedente vira saldo: onde entra, e o que prova que chega

O CHECK `apuracaorepasseitem_saldo_conserva` (`MIG/0098:71`–`:81`) é a medição que decide:

- `valor_transportado >= 0` ⇒ **transporte negativo no caixa é proibido**;
- com `remanescente < 0`, o CHECK **exige** `valor_transportado = saldo_anterior` ⇒ o negativo do caixa é hoje **descartado por contrato**;
- `transportado_nota` / `transportado_fora` **não aparecem** no CHECK ⇒ aceitam negativo **sem tocar restrição nenhuma**.

**Desenho**: o excedente é transportado no **livro da nota** (`transportado_nota` negativo), que é onde D2 colocou a dedução. Na semana seguinte ele chega como `saldo_anterior_nota` negativo e **reduz** a nota. Levá-lo ao livro do **caixa** exigiria alterar um CHECK de conservação de dinheiro em tabela imutável — que a própria `0117:682`–`:685` se recusou a tocar, pelo mesmo motivo. A assimetria está declarada, não escondida (`research.md` Decision 3 · dívida nomeada).

⚠️ **O buraco que precisa ser fechado na mesma migration**: a CTE `linhas` do fechamento só inclui o motorista quando ele tem atividade na semana **ou** `COALESCE(sa.valor_transportado, 0) > 0` (`MIG/0117:866`–`:867`). Um motorista com **apenas** `transportado_nota` negativo e `valor_transportado = 0` **não entraria** na semana seguinte, e a dívida se perderia em silêncio. O predicado precisa ganhar `OR COALESCE(sa.transportado_nota, 0) <> 0`. Sem isso, FR-007 e SC-005 falham no caso **mais comum** de D3.

**O que prova que chega** (FR-007 exige controle negativo): teste de duas semanas consecutivas no **driver** `infra/hub/testes/hub-lancamento-externo-integration.sh` (banco real; o `.test.js` homônimo usa RPC mockada), motorista com dedução > nota na semana N e **nenhuma produção** na semana N+1 (o caso do buraco acima). Mede-se a nota de N+1 **com** e **sem** o transporte; sem ele o valor sai **maior**. Rodar o teste **antes** da `0118` tem de falhar — se passar nas duas, o teste é oco (BRIEFING §9).

### 2 · D2 — dedução quando `valor_nota`/`valor_fora_nota` são `NULL`

`valor_nota` e `valor_fora_nota` são `NULL` quando `categorias_nota` não está configurada; o motivo `SEM_DIVISAO` já existe (`BK/lib/adiantamento-geracao-movimento.js:13`, recusa em `:142`).

**Comportamento definido**: sem `categorias_nota` **não existe parte-da-nota de onde deduzir**. Então — não se inventa divisão; **não se gera movimento** (`SEM_DIVISAO`, comportamento de hoje, preservado); e **não se transporta excedente nenhum** no livro da nota. A `0118` grava `nota_a_emitir = NULL` (**não** `0`, que colidiria com o diagnóstico `VALOR_ZERO`). A dedução no **caixa** (`0117`) continua valendo exatamente como hoje.

Uma feature que depende da divisão **recusa** quando a divisão não existe — não arbitra um rateio.

### ⚠️ 2.bis · Correção material: `valor_nota = NULL` **não** significa "sem `categorias_nota`" — e isso atinge o caso central de D3

Achado da auditoria de veracidade (dec-024). Uma versão anterior deste plano afirmava a equivalência `valor_nota IS NULL ⟺ categorias_nota não configurada`. **A inversão é falsa no item gravado**:

- `MIG/0117:792`–`:795` usa `sum(f.valor) FILTER (WHERE v_config.categorias_nota IS NOT NULL AND ...)`, que é **`NULL` quando nenhuma linha casa** — não só quando a config falta.
- `MIG/0117:857` faz `LEFT JOIN creditos`, então quem não tem crédito algum na semana vem `NULL`.
- `MIG/0117:909`–`:910` grava `r.total_nota, r.total_fora` **cru, sem `COALESCE`**.

⚠️ **A prévia e o fechamento estão inconsistentes hoje**, e a prévia **documenta a semântica que o fechamento viola** — `MIG/0117:1035`–`:1037`, comentário literal: *"0 (e não NULL) quando configurado mas sem crédito na semana; NULL só quando `categorias_nota` não está configurada"*, implementado com `CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(c.total_nota, 0) END`. O fechamento **não** faz isso.

**Por que é material e não cosmético**: `planejarGeracao` recusa `SEM_DIVISAO` em `valor_nota == null` (`BK/lib/adiantamento-geracao-movimento.js:142`). O motorista da semana N+1 **sem produção, só com excedente carregado** — que é **exatamente** o caso central de D3 e o cenário C5 do `quickstart.md` — cairia em `SEM_DIVISAO` e **nunca** receberia a nota reduzida. A feature falharia precisamente onde foi feita para funcionar.

**Correção exigida na `0118`**: aplicar no `INSERT` do fechamento o **mesmo** `CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(..., 0) END` que a prévia já usa, para `valor_nota`, `valor_fora_nota` **e** `nota_a_emitir`. Assim `NULL` passa a significar **só** "sem `categorias_nota`" — a semântica que todo o resto do desenho pressupõe. **Teste**: motorista sem produção em N+1 com excedente carregado **gera** movimento com a nota reduzida, e **não** `SEM_DIVISAO`.

### 3 · D8 — qual componente, e onde é montado

**[PROPOSTA]** `FE/components/hub/gerar-do-repasse-button.tsx`. **Uma** prop decide a diferença entre as duas montagens em código (`periodo?: string`); não há `variant` nem flag de tela. ⚠️ `action-bar.tsx` é **compartilhado** com a tela de Envio em Massa do **hub**, logo são **três telas** (Repasse, Envio em Massa legada, Envio em Massa do hub) e **duas** montagens em código; o `action-bar` **não** repassa a sua `periodo` (texto `DD/MM/AAAA`) — o botão usa seletor próprio ISO, com default na **semana anterior à corrente** (P8).

| Montagem | Onde | Semana |
|---|---|---|
| Tela de Repasse | `FE/app/hub/dashboard/adiantamentos/repasse/page.tsx`, substituindo o botão inline `~:245`–`:259` | **vem por prop** (`h.periodo`) — D9: gera os números que o financeiro está vendo |
| Telas de Envio em Massa (legada e hub) | `FE/components/action-bar.tsx`, ao lado do `<ImportButton>` (`:109`) | **do próprio seletor** — ali **não existe semana na tela**: o período é estado local do `ImportButton` (`FE/components/import-button.tsx:65`–`:66`), digitado no diálogo de upload |

> **Onda-009 (estado final)**: o botão inline (`~:245`–`:259`) e o `FecharApuracaoDialog` foram REMOVIDOS; as âncoras `page.tsx:~245` e `adiantamento-fechar-apuracao-dialog.tsx` neste e nos demais artefatos são HISTÓRICAS. Vigentes: `components/hub/gerar-do-repasse-button.tsx`, `components/action-bar.tsx` (botão ao lado do `<ImportButton>`), `app/dashboard/layout.tsx` (`HubAuthProvider` sem guard).

**FR-016 no painel legado**: montar `HubAuthProvider` em `FE/app/dashboard/layout.tsx` **sem** o `HubSessionGuard`. Medido: o provider **não** redireciona — o redirect vive no guard, componente **irmão** (`FE/app/hub/layout.tsx:44`). Sem sessão de hub, `permissoes` vem `[]` e o botão **não renderiza**. Zero mecanismo novo. O import cruzado legado→hub já tem precedente (`FE/components/data-table.tsx:8`, `FE/app/layout.tsx:9`).

Detalhe completo em `contracts/ui-gerar-do-repasse.md`.

### 4 · D5 — a recusa que nomeia quem trava (116 pendentes hoje)

`409 ADIANTAMENTOS_PENDENTES` com `{ total, porStatus, motoristas[], motoristasOmitidos }`, **lista capada em 20**, **sem CNPJ, telefone, conta ou valor** (gate de privacidade de 01/10). Nome + status + `entregadorId` bastam para destravar.

Duas razões para o pré-flight ser **da rota** e não do RPC:
1. A checagem `APURACAO_COM_PENDENCIAS` vive **dentro** do fechamento (`MIG/0117:759`–`:771`) e portanto **não roda** quando a apuração já existe — mas FR-008 é sobre a **semana**: um adiantamento pode ser liberado depois do fechamento.
2. O RPC devolve só `jsonb_object_agg(status, qtd)` — **contagem**, nunca nomes, que FR-009 exige.

O front **renderiza a lista de verdade** (não só toast), reusando a exibição de `pendencias` do diálogo que D4 aposenta — deleção líquida. Contrato completo em `contracts/hub-repasse-gerar-movimentos.md`.

### 5 · As recusas que **não** desaparecem com D1

⚠️ `hub_adiantamento_repasse_pode_fechar` (`MIG/0067:1891`) exige `now() >= ((periodo_fim + 1) + horario_corte) AT TIME ZONE timezone`. **Uma semana ainda em curso, ou encerrada antes do corte do dia seguinte, não pode ser gerada** — `PERIODO_EM_ABERTO`. Isso **não é** o `periodoAberto` da tela: medido, `situacao` é `apuracao ? 'fechado' : 'aberto'` (`BK/routes/hub-adiantamentos.js:1962`), ou seja *"sem apuração fechada"*, sem relação com o corte D-1.

D1 remove o **passo manual**, não as regras do fechamento. `PERIODO_EM_ABERTO`, `APURACAO_FORA_DE_ORDEM`, `APURACAO_NAO_CONFIGURADA` e `PERIODO_DESALINHADO` continuam recusando e **cada um precisa do seu texto na tela** — mostrar o botão habilitado e devolver recusa sem explicação é o modo de falha que o BRIEFING §7 nomeia para D5. O mapeamento é **reusado** da rota `/fechar` (`:2110`–`:2135`), extraído para helper compartilhado, **não duplicado**.

---

## Fases de implementação (ordem de aplicação **segura**)

A ordem não é preferência: cada fronteira é uma janela que, invertida, deixa dinheiro passar errado.

### F0 — Baseline medida (antes de tocar em nada)

Rodar e **anotar os números** de todos os gates de §Gates. Baseline que não foi medida no início não serve de comparação no fim. Inclui `git status` lido arquivo a arquivo e `package-lock.json` sem diff.

**Não gera código.** Sem esta fase, "0 regressões" é afirmação sem lastro.

### F1 — Migration `0118` (artefato; **antes** do código)

`MIG/0118_repasse_nota_a_emitir.sql`. Ordem estabelecida na casa: **migration antes do código**, com DDL aditiva e default neutro, de modo que o código **antigo** siga funcionando (a `0117:6`–`:8` registra essa mesma política).

1. `ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS nota_a_emitir numeric(12,2);` + `COMMENT ON COLUMN`.
2. `CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_fechar(date)` — corpo da versão **viva** (`0117:708`) byte a byte, mais **só** estas quatro mudanças:
   a. a **dedução aplicada na parte da nota** — é o coração da entrega (§Summary): hoje `valor_nota` é gravado como divisão **bruta** dos créditos e a dedução entra **só** no `remanescente`, então **a dedução não alcança a nota**;
   b. a gravação de `nota_a_emitir`, com o `CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(…, 0) END` de §2.bis (`dec-024`) aplicado a `valor_nota`, `valor_fora_nota` **e** `nota_a_emitir` — sem isso o caso **central** de D3 cai em `SEM_DIVISAO`;
   c. o excedente em `transportado_nota` negativo;
   d. `OR COALESCE(sa.transportado_nota, 0) <> 0` no predicado da CTE `linhas` (`0117:867`) — sem isso a dívida se perde em silêncio (§1).

   Tipo de retorno **não muda** ⇒ `CREATE OR REPLACE` preserva os GRANT.
3. `DROP FUNCTION` + `CREATE FUNCTION` + `GRANT EXECUTE ... TO authenticated` para a prévia `hub_adiantamento_repasse` e o congelado `hub_adiantamento_repasse_congelado` (tipo de retorno **ganha** coluna ⇒ `CREATE OR REPLACE` é recusado). Caminho e a armadilha da ACL estão documentados em `0117:690`–`:707`: **cada `CREATE` seguido do seu `GRANT`**.
4. **`CREATE OR REPLACE FUNCTION hub_repasse_alocar_envio_id() RETURNS bigint`** — `LANGUAGE sql`, **`SECURITY INVOKER`**, corpo `SELECT nextval('"EnvioMassa_id_seq"')` (§S1, `dec-038`). `authenticated` **já** tem `USAGE, SELECT` na sequência (`MIG/0033:197`): **nenhum privilégio novo**. Função **nova**: não há ACL antiga; mesmo sem `DEFINER`, recebe o par `REVOKE`/`GRANT` do item 5 (consistência e S5).
5. **ACL de todas as funções criadas/recriadas** (S5, obrigatório): `REVOKE ALL ON FUNCTION … FROM PUBLIC;` + `GRANT EXECUTE ON FUNCTION … TO authenticated;` para as **três** novas/recriadas (prévia, congelado, `hub_repasse_alocar_envio_id`) — e, por segurança idempotente, também para `hub_adiantamento_repasse_fechar`. Padrão `MIG/0067:2278`–`:2279`.
6. **NÃO tocar**: as duas funções do app do motorista; `hub_adiantamento_repasse_pode_fechar`; o CHECK `apuracaorepasseitem_saldo_conserva`; os bloqueios de imutabilidade (`MIG/0066:460`–`:461`, `:470`–`:478`); o `GRANT` do cliente na trilha (`0092:63` continua **sem** `UPDATE`/`DELETE`, e `envio_massa_id` continua `NOT NULL`, `0092:44` — **zero** DDL na trilha).

**Aplicação**: no isolado `hub-homolog`, via `infra/hub/scripts/migrate.sh`, **depois** do `preflight.sh`. ⚠️ `SchemaMigration` mente fora do `migrate.sh` — aplicar arquivo a arquivo pelo script, nunca à mão. Depois: `SIGUSR1` no PostgREST para recarregar o schema cache.

### F1b — Migration `0119` (artefato; declarada retroativamente na FASE 8 — `dec-054`)

`MIG/0119_repasse_lote_nota_zero.sql`. **Por que existe**: o movimento só-com-gorjeta (FR-022: nota zerada por dedução, com gorjeta) nunca terá nota validada; sem a `0119` o lote o devolveria `NOTA_PENDENTE` para sempre (aprovadas 0 < total 1) — **medido**, não suposto (`evidencias.md` §dec-054). **O que faz**: só `CREATE OR REPLACE FUNCTION hub_repasse_lote_avaliar(bigint[], int[])` (versão viva: `0117` §9), com `nota_a_emitir` no `SELECT` e `NOTA_PENDENTE` não valendo quando `nota_a_emitir = 0`. `NULL` (item pré-`0118` ou sem `categorias_nota`) → `IS DISTINCT FROM 0` → comportamento anterior intacto. Assinatura e retorno iguais ⇒ `CREATE OR REPLACE` preserva o `GRANT`. **Ordem**: `0118` → `0119` → código (a `0119` lê a coluna da `0118`). **Rollback**: reaplicar a função da `0117` §9. **Aplicar em produção é ato do operador**, sob os 5 gates, com `pg_dump -t` antes, aplicada **arquivo a arquivo** por `migrate.sh`. Prova: driver do lote **89/0** (apta; controle "nota devida" segue pendente; controle negativo com o corpo da `0117` mostrando o defeito).

### F1c — Rotas do app do motorista: o filtro de valor emitível (FR-023 · `dec-056`)

Mudança de comportamento em **caminho vivo do app do motorista** — fora de `plan.md` até a FASE 8. `routes/motorista.js:146` define `VALOR_EMITIVEL = 'valor=gt.0'` (`EnvioMassa.valor` é `double precision` **nullable**, `MIG/0033:132`: `gt.0` exclui `0`, negativo e `NULL`). Aplicada em `/movimento-aberto` (`:712`), `/validar-nota` (`:830`), `/notas-pendentes` (`:1066`) e `/notas-pendentes/:id/validar` (`:1146`). Listagem **e** envio, de propósito: a tela e o envio têm de resolver a **mesma** linha. Prova: `tests/motorista-integration.test.js` (bloco `dec-056`, 4 testes) e `tests/motorista-notas-pendentes-unit.test.js` (bloco `dec-056` + o 404 sem chamar a FastAPI), cada um com controle negativo por rota. Sem migration, sem deploy de banco.

**Gate desta fase**: a `0118` aplica **sem erro** no isolado, é **idempotente** (aplicar duas vezes não falha) **e** passa o teste de ACL de §S5 (`has_function_privilege('anon', …) = false` para as três funções).

### F2 — Backend: pré-flight de pendências (**antes** de remover o 409)

1. Helper compartilhado de mapeamento dos erros do RPC de fechamento, extraído de `:2110`–`:2135` — **com a suíte verde antes e depois da extração** (rede de não-regressão antes de mudar comportamento).
2. Pré-flight de pendências na rota de geração, **sempre**, com o contrato `409 ADIANTAMENTOS_PENDENTES`.
3. `planejarGeracao` passa a ler `item.nota_a_emitir` como `valor`; gorjeta **inalterada**; **sem** ramo de fallback (não existe apuração legada).
4. **S7 (obrigatório, `dec-026`)**: a consulta de "movimento aberto" (`:2250`–`:2251`) ganha `id_empresa=in.(<ids do grupo>)`, com os ids resolvidos **uma vez** por `mesmoGrupoQue(GRUPO_MOVEE_ID, GRUPO_MOVEE_ID, cache)` e reusados pela consulta de histórico (`:2282`), que já filtra. Com o cenário negativo de C11b rodando **antes** da correção (tem de falhar).
5. **S1 (obrigatório, `dec-026`/`dec-038`)**: pré-filtro separa `jaGerados` de `reservados` (trilha sem `EnvioMassa`); o laço passa a **alocar o id** (`rpc/hub_repasse_alocar_envio_id`) → `POST ApuracaoRepasseMovimento` **com o id** → `POST EnvioMassa` **com o mesmo `id`**; a trilha deixa de ser gravada **depois**; violação do UNIQUE ⇒ `JA_GERADO`, violação da PK ⇒ `JA_GERADO`; o `catch` distingue as falhas de §S1 com o texto verdadeiro de cada uma. ⚠️ Esta é a mudança que a **re-entrância da F3 pressupõe** — por isso vem **antes** dela, não depois.

⚠️ **Esta fase vem antes da F3 obrigatoriamente.** Remover o 409 antes do pré-flight existir abre uma janela em que a geração roda sem a proteção de D5 — com 116 adiantamentos pendentes medidos hoje, isso é pagar duas vezes.

### F3 — Backend: fechar-se-não-existir + remoção do 409

1. Remover `:2193` (`409 APURACAO_NAO_FECHADA`).
2. Chamar `rpc/hub_adiantamento_repasse_fechar` quando a apuração não existir; mapear erros pelo helper da F2.
3. `APURACAO_JA_FECHADA` **deixa de ser erro** nesta rota: significa que a apuração passou a existir (corrida) ⇒ **relê e segue** para a geração. ⚠️ **Só é seguro porque a F2 já instalou a reserva de §S1**: é exatamente aqui que duas requisições convergem, e sem a reserva este passo seria o que **amplia** S1 (duplicação de nota fiscal).
4. Auditoria: registrar **as duas** ações quando ambas ocorrem (`adiantamento.repasse_fechado` + `adiantamento.movimentos_gerados`), para a trilha não perder o fechamento implícito.

### F4 — Frontend: o componente único e as duas montagens

1. `FE/components/hub/gerar-do-repasse-button.tsx`.
2. Tela de Repasse: entra o componente; **saem** o botão "Fechar apuração", o `<FecharApuracaoDialog>` e o botão inline de gerar. ⚠️ `fecharRepasse()` no client e a rota `/fechar` no backend **permanecem** (FR-013 literal).
3. Diálogo de recusa por pendências (herda a exibição do diálogo aposentado).
4. `FE/components/action-bar.tsx`: monta o componente ao lado do `<ImportButton>`.
5. `FE/app/dashboard/layout.tsx`: `HubAuthProvider` **sem** `HubSessionGuard`.
6. Tipo `AdiantamentosPendentes` no client.

### F5 — Testes e cenário de ponta a ponta no `hub_homolog`

Inclui a **fixture própria com `mensagem1_modelo` configurado** — ⚠️ hoje é **NULL** no `hub_homolog` (BRIEFING §7), e sem a fixture o teste do caminho feliz passaria pelo ramo de recusa de D10 **sem exercitar nada**. Detalhe em `quickstart.md`.

### F6 — Ajuda nas duas centrais (FR-021)

Editar os **JSON versionados** de cada central: `FE/lib/hub/ajuda-conteudo.json` (hub) e `app_homologacao/frontend_motorista/lib/ajuda-conteudo.json` (app). Os HTMLs compartilháveis são **gerados** deles — ⚠️ nunca editar o HTML publicado. ⚠️ `ajuda.test.ts` (um em cada app) **quebra** se o JSON ganhar bloco que a tela não renderiza.

### F7 — Revisão adversarial sobre o diff, **antes** do PR

Obrigatória (memória do projeto + BRIEFING §9): na frente `corrigir-valor`, 16 ondas verdes não pegaram 3 bloqueantes que a revisão independente achou. Foco: os dois caminhos de dinheiro (dedução na nota, transporte do excedente), o predicado da CTE `linhas`, e os testes que passariam **sem** a correção.

---

## Riscos e o que os contém

| Risco (BRIEFING §7) | O que o fecha | Onde |
|---|---|---|
| 🔴 **Caminho do dinheiro** — a rota passa a fechar apuração **e** criar movimento que gera nota fiscal | Fechamento atômico (RPC) + geração re-entrante por trilha; **controle negativo da dedução**: rodar o teste de nota líquida **sem** a `0118` e provar que a nota sai **bruta** (é M5 que torna isso obrigatório); cenário de ponta a ponta no `hub_homolog` | `BK/tests/adiantamento-geracao-movimento-unit.test.js` (ampliado) · driver `infra/hub/testes/hub-adiantamentos-integration.sh` · `quickstart.md` |
| 🔴 **`EnvioMassa` sem RLS alguma** — o filtro de `id_empresa` é a única proteção de tenant | Filtro explícito em **toda** query nova; grupo por `mesmoGrupoQue(_, 6)`, nunca `id_empresa === 6`; teste que prova que movimento de outra empresa **não** entra na contagem de "movimento aberto" | `hub-adiantamentos-integration` · driver `rls-importacoes` como baseline a não regredir |
| 🔴 **D3 cria caminho novo de saldo** — hoje o transporte só recebe valor retido por mínimo | Teste de **duas semanas consecutivas** provando o excedente chegando e reduzindo a nota de N+1, **com controle negativo** (sem o transporte, o valor de N+1 sai maior); e o caso do motorista **sem produção** em N+1, que é o que o predicado da CTE deixava escapar | driver `infra/hub/testes/hub-lancamento-externo-integration.sh` |
| ⚠️ **`mensagem1_modelo` é NULL no `hub_homolog`** — o teste do caminho feliz passaria pelo ramo de recusa | **Fixture própria** com modelo configurado; e um teste que prova que **sem** modelo a recusa acontece (D10), para os dois ramos ficarem cobertos | `hub-adiantamentos-integration` · `quickstart.md` |
| ⚠️ **116 adiantamentos pendentes hoje** — com D5 o financeiro não gera até resolver | A recusa **nomeia**: contagem, status e nomes (cap 20 + omitidos), renderizada em diálogo e não em toast | `contracts/hub-repasse-gerar-movimentos.md` · `gerar-do-repasse-button.test.tsx` |
| ⚠️ **Dois botões, um recurso** — duplicar a chamada duplica a chance de divergir | **Um** componente, **uma** função de client, **uma** rota; teste de montagem única provando `gerarMovimentos` chamada **uma** vez por acionamento | `contracts/ui-gerar-do-repasse.md` |
| ⚠️ **A prévia devolve ZERO sem a claim de escopo** — parece defeito e não é | Nomeado nos contratos e no `quickstart.md`; todo teste de integração assina JWT **com** escopo; diagnóstico de "tela vazia" checa a claim antes do cálculo | `research.md` Decision 5 |
| ⚠️ **App do motorista mostra nota bruta, hub mostra líquida** | **Dívida nomeada**, não paga: app fora de escopo (BRIEFING §5). Já registrada em `research.md` §Dívidas nomeadas. Unificar vocabulário exige **abrir a tela do app** primeiro (lição de 23/09) | `research.md` §Dívidas nomeadas |
| 🛑 **S1 — corrida duplica nota fiscal** (gate owasp) | A trilha é gravada **depois** do `EnvioMassa` ⇒ não é reserva. **Corrigido nesta frente** (`dec-026` opção B): id pré-alocado por `nextval` (RPC `SECURITY INVOKER`), reserva **com** o id, conclusão com o **mesmo** id; corridas fecham pelo `UNIQUE` da trilha e pela PK da `EnvioMassa`, **nunca por tempo** (`dec-038`/`dec-040`) | `plan.md` §S1 · `quickstart.md` C10/C10b |
| ⏸️ **S2 — permissão na entidade ativa, escrita na Movee** (gate owasp) | Sem guard de pertencimento ao grupo; apuração errada **trava a semana real sem volta**. **DEFERIDO com gatilho medido** (`dec-026`): 5 portadores da permissão, todos na empresa 6 — o furo está aberto e ninguém tem a chave | `plan.md` §S2 · `deferred-work.md` §S2 |
| ⚠️ **Build no host** | `df -h /` (abortar com < ~20 GB) **e** swap conferidos antes de qualquer `next build`/`docker build`; `--memory=2g` | `CLAUDE.md` §Comandos |

---

## Convenções de Borda

| Camada | Case | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas PostgreSQL | `snake_case` | migration + CHECKs existentes | `MIG/*.sql` |
| Retorno de função SQL | `snake_case` | `RETURNS TABLE` explícito | `MIG/0118_*.sql` |
| Payload da API (req/resp) | `camelCase` | mapeamento **explícito à mão** na rota (sem ORM, sem automapeamento) | `contracts/hub-repasse-gerar-movimentos.md` |
| Tipos TS do client | `camelCase` | tipagem em `FE/lib/hub/adiantamentos-api.ts` | o próprio arquivo |
| Path param `:periodo` | `'YYYY-MM-DD'` | regex na rota + `<input type="date">` | rota + `FE/lib/hub/periodo.ts` |
| Dinheiro no payload | string formatada por `dinheiro()` nos campos já existentes; **inteiros** em contagens | — | `BK/routes/hub-adiantamentos.js` |

**Mapper layer**: não existe camada dedicada — a rota faz `apuracao_id → apuracaoId` à mão. **ORM auto-mapping: NÃO.** O 409 novo segue a mesma convenção (`porStatus`, `motoristasOmitidos`, `entregadorId`).

**Validação Zod**: não usada nesta borda (o projeto não a adota aqui). A validação é a regex do path + a checagem de `confirmacao === true` na rota, e a tipagem TS no client.

⚠️ **Fuso**: `dataLocal()` em `BK/lib/adiantamento-geracao-movimento.js:29` existe porque *"sem isso um `dt_final` às 23:59 -03 viraria o dia seguinte em UTC"*. Toda data nova desta frente passa pelo mesmo tratamento — o fuso 03:00 UTC já foi armadilha nesta base.

---

## Project Structure

### Documentação (esta feature)

```
docs/specs/repasse-gera-movimento/
├── spec.md                                  (já existe)
├── plan.md                                  este arquivo
├── research.md                               M1–M14 + Decisions 1–8
├── data-model.md                             0118: uma coluna + 3 funções
├── quickstart.md                             cenários, incl. roundtrip e controles negativos
└── contracts/
    ├── hub-repasse-gerar-movimentos.md       rota: ordem, 409s, idempotência, tenant
    └── ui-gerar-do-repasse.md                componente único, duas montagens
```

### Código (árvore real — todos os paths conferidos)

```
infra/hub/migrations/
└── 0118_repasse_nota_a_emitir.sql                      NOVO (artefato; aplicar = ato do operador)

app_homologacao/backend/
├── routes/hub-adiantamentos.js                         ALTERA (:2110-:2135 extrai helper; :2177 rota; remove :2193)
├── lib/adiantamento-geracao-movimento.js               ALTERA (:114 passa a ler nota_a_emitir)
└── tests/
    ├── adiantamento-geracao-movimento-unit.test.js     ALTERA
    ├── hub-adiantamentos-rotas-unit.test.js            ALTERA (:357 já mocka o RPC de fechar)
    └── (nenhum teste de integração aqui: hub-lancamento-externo-integration.test.js usa RPC MOCKADA e não prova nada de banco)

infra/hub/testes/                                       (DRIVERS bash — banco real, stack efêmero hub-test-*)
├── hub-adiantamentos-integration.sh                    ALTERA (geração, S1/C10/C10b, pendências, S7, ACL)
└── hub-lancamento-externo-integration.sh               ALTERA (duas semanas + controle negativo de D3)

app_homologacao/frontend_v2/
├── components/hub/gerar-do-repasse-button.tsx          NOVO
├── components/hub/gerar-do-repasse-button.test.tsx     NOVO
├── components/action-bar.tsx                           ALTERA (monta ao lado do ImportButton, :109)
├── app/dashboard/layout.tsx                            ALTERA (HubAuthProvider sem HubSessionGuard)
├── app/hub/dashboard/adiantamentos/repasse/page.tsx    ALTERA (sai Fechar apuração; entra o componente)
├── app/hub/dashboard/adiantamentos/repasse/page.test.tsx  ALTERA
├── lib/hub/adiantamentos-api.ts                        ALTERA (tipo AdiantamentosPendentes)
└── lib/hub/adiantamentos-api.test.ts                   ALTERA

app_homologacao/frontend_v2/lib/hub/ajuda-conteudo.json  ALTERA (central do HUB)
app_homologacao/frontend_v2/lib/hub/ajuda.test.ts        ALTERA
app_homologacao/frontend_motorista/lib/ajuda-conteudo.json  ALTERA (central do APP)
app_homologacao/frontend_motorista/lib/ajuda.test.ts     ALTERA
```

⚠️ **Centrais de ajuda**: cada uma vem do seu **JSON versionado** (paths acima, conferidos); os HTMLs compartilháveis são **gerados** deles — **nunca editar o HTML publicado**. O teste (`ajuda.test.ts`, um em cada app) **quebra** se o JSON ganhar bloco que a tela não renderiza, então bloco novo exige a tela acompanhar.

**Não toca**: `components/import-button.tsx` · `app/dashboard/page.tsx` (fora do layout) · a FastAPI de validação · as duas funções SQL do app do motorista · `hub_adiantamento_repasse_pode_fechar` · o CHECK de conservação · a emissão e a validação de XML · **"Fechar movimento"** (D12, literalmente intocado).

⚠️ **O upload de planilha e o disparo SAEM desta lista** (corrigido em 28/10, revisão adversarial): a decisão do operador em `block-004` autorizou alterá-los — *"Inclui recusar valor<=0 em envio-massa-correcao.js e no /upload"* — e o código os altera de fato (`server.js:1340` troca o alvo do disparo por `selecionarAlvoDisparo`; `server.js:1962` recusa linha sem valor nem gorjeta; `envio-massa-correcao.js:162` idem). A frase anterior dizia o oposto do código e sobreviveu à decisão que a invalidou. FR-020 em `spec.md` também não foi emendado — ao contrário de FR-022/FR-023, que nasceram de decisões do mesmo dia.

---

## Gate `owasp-security` — achados e o que fazer

Rodado sobre a arquitetura proposta. **Veredito original: fail** — 2 high (S1, S2) + 1 high achado pela auditoria de veracidade (S7), 2 medium, 2 low. Os três `high` foram **reconferidos no código, linha a linha**, pelo orquestrador (não são achados de leitura do gate apenas), e **todos são defeitos PRÉ-EXISTENTES que esta frente AMPLIA**.

**Disposição decidida pelo operador** (`block-001` → `dec-026`, opção **B**):

| Achado | Severidade | Disposição |
|---|---|---|
| **S1** trilha não é reserva | 🔴 high | ✅ **corrigir nesta frente** (F1 + F2/F3) — mecanismo único em §S1 |
| **S7** `EnvioMassa` sem filtro de tenant | 🔴 high | ✅ **corrigir nesta frente** (F2) |
| **S5** ACL após `DROP FUNCTION` | 🟢 low | 🔴 **obrigatório na `0118`** — não deferível (PostgREST público) |
| **S2** permissão na entidade ativa × escrita na Movee | 🔴 high | ⏸️ **deferido com gatilho medido** — `deferred-work.md` §S2 |
| **S3** sem rate limit | 🟡 medium | ⏸️ deferido — `deferred-work.md` §S3 |
| **S4** identidade dupla na tela legada | 🟡 medium | ⏸️ deferido — `deferred-work.md` §S4 |
| **S6** amarras do PII no 409 | 🟢 low | ⏸️ deferido — `deferred-work.md` §S6 |

⚠️ Com essa disposição, o gate **permanece em `fail` por S2** — e isso é **esperado e autorizado**: `dec-026` é a decisão explícita do operador sobre um achado que reprova o Princípio II (NON-NEGOTIABLE), com a medição que a sustenta e o gatilho de reabertura. **Não é bloqueio a reabrir.**

### S1 · 🔴 high — a trilha não é reserva: corrida duplica nota fiscal

`A06 Insecure Design` / `CWE-362`.

**Medido**: no laço de geração, o `POST EnvioMassa` (`:2311`) vem **antes** do `POST ApuracaoRepasseMovimento` (`:2313`), ambos no **mesmo** `try` (`BK/routes/hub-adiantamentos.js:2310`–`:2322`). `jaGerados` é lido **uma vez**, no começo da requisição. `EnvioMassa` não tem UNIQUE nem RLS. O advisory lock cobre **só** o RPC de fechamento, **não** o laço JS.

**Consequências, duas**:
1. **Duplicata**: duplo clique ou dois financeiros leem a trilha vazia e **ambos** criam o movimento ⇒ **nota fiscal e pagamento em dobro**. Viola SC-004 diretamente. Este plano **agrava** ao transformar `APURACAO_JA_FECHADA` em "segue para a geração" (F3), que é justamente onde duas requisições convergem.
2. **Órfão com mensagem falsa** — ⚠️ **estado ANTERIOR a esta frente, já CORRIGIDO** (FASE 3; não é bug vivo): se o insert da trilha falhasse depois do `EnvioMassa` ter gravado, o `catch` devolvia `FALHA_AO_GRAVAR` com o texto literal *"Não foi possível criar o movimento; nada foi gravado para este motorista."* — **falso**: a linha de `EnvioMassa` existia e ficava órfã. O retry então **duplicava**, porque não havia trilha para recusar. A âncora citada nesta frente era `:2321` na **numeração de antes da correção** (hoje essa linha é outra coisa). Hoje: a reserva vem primeiro e `TEXTO_FALHA` (`lib/adiantamento-geracao-movimento.js:253`–`:256`) dá um texto **verdadeiro por modo de falha** — `NADA_GRAVADO` só quando nada foi gravado mesmo.

⚠️ **Precedente desta base, exatamente neste par de tabelas**: a `MIG/0099_apuracaorepassemovimento_insert_policy.sql:28` já registra o sintoma — *"fica órfã (sem registro em `ApuracaoRepasseMovimento`)"*. A policy de `INSERT` ausente foi corrigida; **a ordem das escritas não**.

### ✅ S1 — CORREÇÃO DESTA FRENTE: id pré-alocado, reserva com o id, conclusão com o MESMO id (`dec-026` opção B · `dec-038` · autorizada em `block-002` → `dec-040`)

> **Este é o ÚNICO mecanismo de S1.** Os outros dois desenhos que circularam (`dec-030`, `dec-034`) e a heurística de 5 minutos de `dec-035` foram **refutados por medição** e ficam só como referência histórica (§O mecanismo da reserva do S1, ao final). Nenhuma outra seção deste plano, nem `data-model.md`, nem os contratos, nem `quickstart.md`, descreve outro.

O operador decidiu corrigir, por duas razões que ele nomeou: o furo é explorável **hoje** por duplo clique, e **a re-entrância deste plano depende dessa trilha** — sem a correção, o desenho não fecha.

#### Por que a inversão literal da ordem **não** funciona, e por que os outros dois desenhos também não (medido)

| Fato medido | Onde | Consequência |
|---|---|---|
| `envio_massa_id bigint NOT NULL` | `MIG/0092:44` | não há como gravar a reserva **antes** da linha de `EnvioMassa` **sem ter o id** |
| `GRANT SELECT, INSERT` — e **nada mais** (sem `UPDATE`, sem `DELETE`) | `MIG/0092:63` · `MIG/0099:41`–`:44` | o `PATCH` de `dec-030` é **impossível** sem DDL e `GRANT` novos; o cliente também não pode apagar reserva |
| `GRANT USAGE, SELECT ON SEQUENCE "EnvioMassa_id_seq" TO authenticated` **já existe** | `MIG/0033:197` | o cliente **já pode** alocar o id — o terceiro desenho **não pede privilégio novo** |
| `EnvioMassa.id` é `bigserial PRIMARY KEY`; os três índices não são `UNIQUE` | `MIG/0033:126`, `:150`–`:156` | a **PK** é a única chave que serializa duas gravações da mesma nota — e só serve se o id for **conhecido antes** |
| advisory *xact* lock morre no fim da RPC e não cobre o round-trip HTTP seguinte | `MIG/0011:7`–`:9` (limitação já documentada nesta casa) | qualquer "liberar a órfã" (`dec-034`) apaga reserva **viva** de outra requisição |

**Descartados**: `dec-030` (`PATCH`: impossível pelas duas primeiras linhas, e o `NULL` não distingue "nota não criada" de "nota criada e id perdido"); `dec-034` (`DELETE … NOT EXISTS`: não distingue órfã de em andamento); **heurística de "reserva com menos de 5 min" — DESCARTADA**: fecha a janela por sorte e, passada, volta a permitir duplicata, num caminho que emite nota fiscal.

#### O mecanismo — duas corridas, ambas fechadas por **integridade**, nunca por tempo

**Peça nova no banco** (`0118`): uma função de **uma linha**, `SECURITY INVOKER`:

```sql
CREATE OR REPLACE FUNCTION hub_repasse_alocar_envio_id() RETURNS bigint
  LANGUAGE sql SECURITY INVOKER AS $$ SELECT nextval('"EnvioMassa_id_seq"') $$;
```

`SECURITY INVOKER` (não `DEFINER`): roda com o privilégio do próprio `authenticated`, que **já** tem `USAGE, SELECT` na sequência (`0033:197`). **Zero** `SECURITY DEFINER` novo, **zero** `GRANT` novo na trilha, **zero** policy nova, **zero** `ALTER` na trilha, **zero** `DELETE`. A RPC existe porque o PostgREST não chama `nextval` direto — não por falta de permissão. (Nome e forma exata: **[PROPOSTA]**, validar na T 2.x contra o `hub-homolog`; o que é contrato é o comportamento.)

**Fluxo da rota, por motorista a gerar**:

```
pré-filtro (uma vez, antes do laço):
  trilha  = ApuracaoRepasseMovimento?apuracao_id=eq.<id>            (RLS por escopo)
  existem = EnvioMassa?id=in.(<envio_massa_id da trilha>)&id_empresa=in.(<grupo>)&select=id   (em lotes)
  jaGerados  = trilha cujo envio_massa_id ∈ existem        → JA_GERADO (como hoje)
  reservados = trilha cujo envio_massa_id ∉ existem        → "reserva sem movimento" (id, valor, gorjeta)

por motorista em aGerar:
  1. se NÃO está em reservados:  id := rpc/hub_repasse_alocar_envio_id
                                 POST ApuracaoRepasseMovimento { …, envio_massa_id: id, valor, gorjeta }
                                   └─ violação do UNIQUE (apuracao_id, entregador_id) ⇒ JA_GERADO
                                      (o concorrente chegou antes; NADA foi escrito em EnvioMassa)
     se ESTÁ em reservados:      id := o id já reservado; valor/gorjeta da trilha têm de bater com os recomputados
                                 (divergência ⇒ FALHA_AO_GRAVAR com texto próprio; nunca conclui com valor diferente)
  2. POST EnvioMassa { ...alvo.linha, id }                        ← o MESMO id, explícito
       └─ violação da PK ⇒ outra requisição já concluiu esta nota ⇒ JA_GERADO (não é erro)
       └─ outra falha     ⇒ FALHA_AO_GRAVAR (texto verdadeiro abaixo); a reserva FICA
```

**Por que fecha** — as duas corridas, cada uma por um `UNIQUE` que **já existe**:

| Corrida | Quem barra | Por quê é íntegro |
|---|---|---|
| Duas requisições reservam o mesmo motorista | `UNIQUE (apuracao_id, entregador_id)` da trilha (`MIG/0092:49`) | a segunda recebe a violação **antes** de qualquer escrita em `EnvioMassa` |
| Duas requisições **concluem** a mesma reserva (a retomada vs. a original ainda em voo) | `PRIMARY KEY` de `EnvioMassa` | as duas postam o **mesmo** id; só uma grava; a outra vê a violação e responde `JA_GERADO`. **Não há tempo envolvido**: se a original estiver só lenta, ela é quem perde |

A retomada **conclui** a reserva (re-posta o mesmo id); **nunca** a apaga e recomeça. É o que `dec-034` não tinha: ali a liberação precisava adivinhar se a reserva estava viva.

**O payload puro não muda**: `alvo.linha` (`BK/lib/adiantamento-geracao-movimento.js:177`–`:191`) não tem campo `id`; supri-lo é um *spread* no ponto do `POST`. `planejarGeracao` continua pura — só o pré-filtro passa a separar `jaGerados` de `reservados`.

**Tenant** (Constitution §II): a leitura de `EnvioMassa` por `id` leva `id_empresa=in.(<ids do grupo>)` — a tabela **não tem RLS**. A escrita da reserva continua sob a policy de `INSERT` por escopo que já existe (`MIG/0099:49`–`:52`): o caminho novo **não** cria escrita cross-tenant e **não** amplia S2.

**Limite conhecido, declarado**: a conclusão trata *"reserva cujo `envio_massa_id` não existe em `EnvioMassa`"* como movimento a concluir. Se alguém **apagar** uma linha de `EnvioMassa` já gerada, a próxima geração a **recria**. Medido em 2026-10-28: **nenhum** caminho do backend faz `DELETE` em `EnvioMassa` (`grep` em `routes/` e `lib/`), embora a tabela conceda `DELETE` (`0033:192`). A tarefa de varredura (P6) reconfere isso e registra o resultado.

#### A mensagem do `catch` — o texto **e** o estado

`:2321` afirma hoje *"nada foi gravado para este motorista"* para **qualquer** falha do par. Com a reserva, as falhas ficam distinguíveis e cada uma recebe o texto **verdadeiro**:

| Onde falhou | Estado real | O que a rota responde |
|---|---|---|
| Alocação do id, ou `POST` da reserva (que **não** seja violação do UNIQUE) | Nada gravado (um número de sequência consumido é lacuna inofensiva) | `FALHA_AO_GRAVAR` com o texto de hoje, **agora verdadeiro** |
| Violação do UNIQUE da reserva | Já havia reserva; nada novo gravado | `JA_GERADO` (`BK/lib/adiantamento-geracao-movimento.js:15`) — com `detalhe` dizendo que, se o movimento não aparecer, é só acionar de novo |
| Reserva OK, `POST EnvioMassa` falhou (não-PK) | Reserva **sem** movimento: o motorista **não tem nota** | `FALHA_AO_GRAVAR` — *"A reserva foi registrada e o movimento **não** foi criado: este motorista não recebeu nota. Tentar de novo é seguro — a próxima geração conclui este movimento com a mesma reserva."* |
| `POST EnvioMassa` com violação de PK | Outra requisição concluiu | `JA_GERADO` |
| Reserva existente com valor/gorjeta diferentes dos recomputados | Inconsistência | `FALHA_AO_GRAVAR` nomeando a divergência; **não** conclui |

O modo de falha muda de lado, e é o lado recuperável: de **nota emitida sem trilha** (que o retry **duplica**) para **trilha sem nota** (que o retry **conclui**, sem duplicar).

**Testes obrigatórios** (`quickstart.md` C10 e C10b), todos **com controle negativo**: (a) duas requisições paralelas — a mesma rodada contra o código de hoje **tem** de duplicar, senão o teste é oco; (b) falha forçada do `POST EnvioMassa` — mensagem verdadeira **e** reacionamento sem duplicar; (c) duas **conclusões** concorrentes da mesma reserva — exatamente **uma** linha de `EnvioMassa`; (d) controle negativo da conclusão: concluir com um id **novo** em vez do reservado **duplica** — prova que é o *mesmo id* que entrega a garantia.

### S2 · 🔴 high — a permissão é checada na entidade ativa, mas a escrita é na Movee

`A01 Broken Access Control` / Constitution §II (**NON-NEGOTIABLE**) / `CWE-639`.

**Medido**: `resolverContextoAdiantamentos` valida a permissão **na entidade ativa do usuário** e, quando `entidadeAtiva !== GRUPO_MOVEE_ID`, apenas define `escopo = [entidadeAtiva]` e **retorna com sucesso — sem 403**. A rota então usa `GRUPO_MOVEE_ID` (= `6`, `:79`) para a `ApuracaoRepasse`, e o RPC grava `id_empresa = 6` **hardcode** (`MIG/0117:776`).

**Consequência**: quem tem `adiantamentos.pagamento_confirmar` em **outra** entidade com o módulo ativo fecha uma apuração **da Movee**. Pior, o `INSERT` dos itens é `SELECT v_apuracao_id, 6, r.entregador_id, ...` (`MIG/0117:909`) sobre entregadores de `e.id_empresa = ANY(v_escopo)` ⇒ **entregadores de outra empresa são gravados como itens de uma apuração Movee** (mistura cross-tenant em tabela de dinheiro). E como `ApuracaoRepasse` é **imutável**, essa apuração errada **avança o "último fechado"** e **trava a semana real** com `APURACAO_FORA_DE_ORDEM`, **sem caminho de volta**.

A afirmação deste plano de que "o escopo vem sempre do token" **não vale** para essas escritas — vale para as leituras.

⚠️ **Correção de veracidade**: uma versão anterior deste parágrafo dizia *"não é hipotético: existem logins QA de outra entidade (empresa 9001) nesta base"*. Os logins QA de empresa 9001 são do ambiente **isolado `hub-homolog`**, não da base do cliente — a frase confundia os dois ambientes. A medição que vale é a do operador, abaixo.

### ⏸️ S2 — DEFERIDO com gatilho medido (`dec-026`, autorização do operador)

**Medição do operador em produção, 2026-10-28**: a permissão `adiantamentos.pagamento_confirmar` existe em **5 usuários, todos na empresa 6**. **Zero** portadores fora da Movee — embora existam vínculos ativos em **8 empresas**. Ou seja: **o furo está aberto e ninguém tem a chave.** A exploração exige um portador da permissão fora da empresa 6, e hoje não há nenhum.

**Gatilho para reabrir** (não é prazo, é condição): **o primeiro vínculo fora da empresa 6 com papel que carregue `adiantamentos.pagamento_confirmar`**. ⚠️ Lembrete da casa que aumenta a chance desse gatilho disparar sem ninguém notar: `financeiro_aprovador` (`MIG/0097`) nasceu como **cópia** de `financeiro` e **não** tem vínculo vivo com ele — permissão nova dada a `financeiro` depois da `0097` **não** se propaga, e o inverso também vale para auditar quem carrega o quê.

⚠️ **`POST /repasse/:periodo/fechar` NÃO é tocado nesta frente** — está em produção e sai do escopo aprovado (instrução explícita do operador). A mitigação (403 por `mesmoGrupoQue` antes do pré-flight + asserção `6 = ANY(hub_jwt_escopo_ids())` dentro do RPC, com teste negativo de JWT de outra empresa **que tenha** a permissão) está registrada em `deferred-work.md` §S2.

⚠️ **O que esta frente faz para não ampliar S2**: o caminho novo da geração só **escreve** a reserva sob a policy de `INSERT` por escopo que já existe (`MIG/0099:49`–`:52`, `id_empresa = ANY (hub_jwt_escopo_ids())`) e lê `EnvioMassa` com `id_empresa=in.(<grupo>)` — sem `SECURITY DEFINER` novo que pudesse ignorar a RLS. Não adiciona escrita cross-tenant. S2 permanece exatamente do tamanho que já tinha.

### S7 · 🔴 high — a consulta de "movimento aberto" lê a `EnvioMassa` de **todos** os tenants

`A01 Broken Access Control` / Constitution §II (**NON-NEGOTIABLE**).

⚠️ **Achado da auditoria de veracidade, não do gate** — e corrige uma afirmação **errada** de uma versão anterior deste plano, que dizia que esta query já filtrava tenant. **Não filtra** (dec-023).

**Medido**: `BK/routes/hub-adiantamentos.js:2250`–`:2251` é
`buscarEmLotes('EnvioMassa?mov_fechado=eq.false&select=cnpj_prestador', cnpjs, { campoId: 'cnpj_prestador', claims })` — **sem `id_empresa`**. E `BK/lib/hub-postgrest-lotes.js:39` só acrescenta `${campoId}=in.(...)`, nada mais. A `EnvioMassa` **não tem RLS**. Só a consulta de **histórico** (`:2282`) filtra por grupo — e ela roda apenas dentro de `if (comSaldoIds.length)`.

**Consequência dupla**:
1. **Leitura cross-tenant** de uma tabela sem RLS.
2. **Funcional, e inverte o comportamento esperado**: um motorista com movimento aberto em **outra** empresa cliente é recusado aqui com `MOVIMENTO_ABERTO` — embora aquele movimento não tenha nada a ver com o repasse da Movee. O mesmo CNPJ pode emitir para outra empresa (é o que o comentário `:2265`–`:2267` reconhece **para a outra query**). Resultado: motorista legítimo **não recebe nota**, sem motivo real.

### ✅ S7 — CORREÇÃO DESTA FRENTE (`dec-026`, opção B)

Aplicar na query de "abertos" o **mesmo** filtro que a de histórico já usa — `id_empresa=in.(<ids do grupo>)` com os ids de `mesmoGrupoQue(GRUPO_MOVEE_ID, GRUPO_MOVEE_ID, cache)`, resolvido **uma vez** e reusado pelas duas. Entra na **F2** (é um parâmetro a mais numa query, não um caminho novo).

**Teste negativo obrigatório**: mesmo CNPJ com movimento aberto **fora** do grupo Movee ⇒ **não** recusa (`quickstart.md` C11b, que já existe para FR-018). Rodar **antes** da correção tem de falhar — se passar nas duas, o cenário não está exercitando o filtro.

### S3 · 🟡 medium — sem rate limit nesta rota

`API4 Unrestricted Resource Consumption`. As rotas irmãs têm limiter (`lancamentoExternoRateLimiter`, `exportarRepasseRateLimiter`); esta e a `/fechar` não. A rota passa a fazer ~10 chamadas PostgREST + N inserts **e escreve dinheiro**.
**⏸️ DEFERIDO** (`dec-026`) — registrado em `deferred-work.md` §S3. Mitigação quando entrar: limiter por **usuário** (chave `sub` + entidade), faixa 5–10 req/15 min. ⚠️ **Nunca por IP** — rate limit por IP é bug em produto multi-operador, precedente desta base. **Soma-se** a S1, não a substitui — e **não** é pré-requisito dela: com a reserva de S1, repetição deixa de duplicar dinheiro, o que rebaixa S3 a consumo de recurso.

### S4 · 🟡 medium — identidade dupla na tela legada

`A01/A07`, confusão de sessão hub↔legado (incidente PR #87). `HubAuthProvider` sem guard é **só controle de UI** e o servidor segue autoritativo — o risco real é outro: o botão age com a identidade do **cookie do hub** enquanto a página mostra o usuário **legado**; e o `GET /me` extra passa pelo proxy, que **renova ou limpa cookies** ao ver `accessToken` ausente.
**⏸️ DEFERIDO** (`dec-026`) — registrado em `deferred-work.md` §S4. Mitigação quando entrar: diálogo de confirmação exibindo **nome do usuário e entidade do hub** antes de gerar. Teste: sessão só-legado ⇒ `/me` 401, `permissoes=[]`, **nenhum** `Set-Cookie`, **nenhum** refresh em laço, login legado **intacto**.

### 🔴 S5 · OBRIGATÓRIO na `0118` (severidade low, **não deferível**)

`A05 Misconfiguration`. O `DROP`+`CREATE` das duas funções `SECURITY DEFINER` **zera a ACL**, e o default deixa `EXECUTE` aberto a `PUBLIC`. ⚠️ **O PostgREST de produção é público** — `SECURITY DEFINER` sem `REVOKE` abre a função a `anon`. Por isso o operador classificou S5 como **obrigatório e não deferível** (`dec-026`), apesar da severidade `low` do gate.

A `0118` precisa de **`REVOKE ALL ... FROM PUBLIC` seguido do `GRANT EXECUTE ... TO authenticated`** para **cada** função que ela cria ou recria — **três**, não duas: `hub_adiantamento_repasse` (prévia), `hub_adiantamento_repasse_congelado` **e** a nova `hub_repasse_alocar_envio_id` de §S1 (`SECURITY INVOKER` — o `REVOKE ALL ... FROM PUBLIC` vale igual, por consistência). Padrão literal da casa: `MIG/0067_adiantamento_funcoes.sql:2278`–`:2279`. ⚠️ `hub_adiantamento_repasse_fechar` é `CREATE OR REPLACE` (preserva a ACL) — mas repetir o par `REVOKE`/`GRANT` nela é inócuo e idempotente, então **repetir** é mais seguro que lembrar da exceção.

**Teste de ACL** (gate desta fase, não observação): `has_function_privilege('anon', '<assinatura>', 'EXECUTE') = false` para as três, e `proacl` conferido antes/depois. ⚠️ Lembrete da casa ao ler `proacl`: `PUBLIC` aparece como `=X/` — **sem papel antes do `=`**.
⚠️ `SET search_path = public, pg_temp` está **correto** (`pg_temp` por último) e é o padrão do repo — não mexer.

### S6 · 🟢 low — PII no 409, aceitável com três amarras

O 409 com nome + status + `entregadorId` (cap 20, sem CNPJ/telefone/conta/valor) é aceitável: exige permissão e a consulta vai filtrada por escopo. As três amarras — (a) `id_empresa=in.(escopo)` **obrigatório** na consulta de pendências; (b) **log só com contagens**, nunca nomes; (c) front renderiza nomes como **texto**, sem HTML — ficam **⏸️ DEFERIDAS** (`dec-026`), registradas em `deferred-work.md` §S6. ⚠️ A amarra (a) **não** se confunde com S7: aquela é a consulta de *movimento aberto* na `EnvioMassa` (corrigida nesta frente), esta é a de *pendências de adiantamento*, outra query.

---

## Gates (números a reconferir, baseline de 2026-10-28)

| Gate | Baseline | Regra |
|---|---|---|
| backend `npm test` | **2136 / 0** | 0 falhas |
| `npm run test:hub:unit` | **1426 / 0** | 0 falhas |
| `tsc --noEmit` (frontend_v2 **e** motorista) | limpo nos dois | 0 erros |
| vitest `frontend_v2` | **981 / 0** | 0 falhas + os testes novos |
| app motorista | **126 / 0** | ⚠️ `node --test`, **não** vitest |
| lint | **28 (5/23)** = baseline | erro pré-existente não bloqueia; **erro novo bloqueia** |
| `hub-adiantamentos-integration` | **231 / 0** | 0 falhas |
| `hub-lancamento-externo-integration` | **150 / 0** | 0 falhas |
| `hub-repasse-lote-integration` | **86 / 0** | 0 falhas |
| roundtrip | **57 / 0** | 0 falhas |
| rollback | **37 PASS** | 0 falhas |
| perf | **APROVADO** | sem regressão |
| E2E do hub | ⚠️ `failed` **já é regressão** (PR #262: flaky distinguido de failed) | rodar pelo driver `infra/hub/testes/*.sh`, nunca browser no host |
| `package-lock.json` | **sem diff** | ⚠️ o container do Playwright o reescreve a cada E2E — **conferir e reverter antes de commitar** |
| impeccable (se tocar UI) | 0 achados | o componente novo é UI |
| `0118` no isolado | — | aplica sem erro **e** é idempotente |

**Relatar com números**, não com adjetivos (`CLAUDE.md` §Rito do ciclo git, etapa 1).

---

## Produção — o que esta frente **não** faz

⚠️ **"Homologação" É produção**: é o que os clientes usam.

- **Nunca** `docker service update`, **nunca** `docker stack deploy`, **nunca** escrita em `chatmasterveloz`, **nunca** stacks do Swarm. Leitura para diagnóstico é permitida; recursos `hub-*`/`hub_*` são liberados pela exceção escopada.
- A **`0118` é artefato**. Aplicar em produção é ato do operador, sob os 5 gates, com `pg_dump -t` antes.
- Esta fase **não commita**, **não** usa `git add`, **nunca** `git stash`.
- Deploy, quando autorizado: **merge antes do build**, tag `<rótulo>-<sha7>`, `df -h /` e swap conferidos antes, e **prova de bundle** por string servida — HTTP 200 prova que o serviço subiu, não que subiu o código certo.

---

## Correções da auditoria de veracidade (dec-022 a dec-025)

Um subagente read-only auditou os 5 artefatos contra o código e devolveu **11 afirmações sem âncora**. As quatro materiais já estão corrigidas em linha acima (§Gate S7, §2.bis, §Constitution Check). As demais, por honestidade de registro:

| Afirmação errada | O que a fonte diz |
|---|---|
| Árvore do §Project Structure: `backend/tests/hub-adiantamentos-integration.test.js` | **Não existe.** `hub-adiantamentos-integration` é **driver bash** (`infra/hub/testes/hub-adiantamentos-integration.sh`, stack efêmero `hub-test-*`). `tests/hub-lancamento-externo-integration.test.js` existe, mas seu cabeçalho diz *"roundtrip XLSX → leitor → RPC (mockada)"* — o teste de duas semanas com controle negativo precisa de **banco real**, logo é no **driver** `infra/hub/testes/hub-lancamento-externo-integration.sh`, não nele. ✅ **Aplicada na árvore** (§Project Structure e §Riscos) |
| *"8 ramos de recusa"* em `planejarGeracao` | **Eram 7 na data da auditoria; hoje são 8** (`NOTA_LIQUIDA_AUSENTE` nasceu com a `0118`/P4). Âncoras **re-medidas na FASE 8** em `BK/lib/adiantamento-geracao-movimento.js`: `:142` RETIDO, `:144` SEM_CNPJ, `:147` SEM_DIVISAO, `:163` NOTA_LIQUIDA_AUSENTE, `:173` VALOR_ZERO (com a exceção `soGorjetaPorDeducao`, FR-022), `:178` JA_GERADO, `:179` MOVIMENTO_ABERTO, `:180` MOVIMENTO_LEGADO_EM_SEMANA_RETIDA. As sete âncoras originais (`:137`…`:164`) derivaram +5…+16 e **não valem mais**. `FALHA_AO_GRAVAR` é emitido pela **rota** (`:2415`, `:2435`, `:2449`), não por `planejarGeracao`. `MOTIVOS` é `:11`–`:30`, não `:11`–`:28` |
| *"`express.json()` de 100 KB — o BRIEFING §restrições o nomeia"* | O BRIEFING tem §1–§10 e **nenhuma** "§restrições"; `express.json` não aparece nele, no `CLAUDE.md` nem na constitution. Veio do **prompt de invocação / memória do projeto** — atribuição corrigida. Continua sendo verdadeiro que é limite de **request** e não afeta a resposta |
| *"gate de privacidade de 01/10"*, *"PR #87"*, *"PR #262"*, *"corrigir-valor: 16 ondas / 3 bloqueantes"* | Vêm da **memória do projeto**, não do BRIEFING/`CLAUDE.md`/constitution. São contexto legítimo, mas a atribuição aqui era a fonte errada. O que **está** no BRIEFING §9 é *"4 das 15 correções criaram defeito novo"* |
| *"`adiantamentos-api.test.ts` tem 15 testes"* | 15 ocorrências textuais de `it(`, mas 2 estão num `for` sobre 2 casos ⇒ o vitest executa **17**. `page.test.tsx` = 19 **confere**. A ausência de teste de `gerarMovimentos` **confere** nos dois |

**Deriva de linha** (todas dentro de ±15 linhas, âncora textual correta; **reconferida na FASE 8**: `0117`/`0098` seguem nas linhas abaixo, as âncoras de `BK/routes/hub-adiantamentos.js` derivaram para `:2402`–`:2449` pelo S1 e as de `BK/lib/adiantamento-geracao-movimento.js` estão na linha de recusas acima): `0117:869-871`→`:867` ✅ já corrigido no corpo (predicado da CTE), `0117:768-777`→`:759-771`, `0117:825-836`→`:818-827`, `0117:741`→`:738-740`, `0098:51`→`:50`, `:2305`→`:2306`, laço `:2306-2322`→`:2309-2323`.
⚠️ Uma correção de substância escondida na deriva: *"as leituras do fechamento usam `hub_jwt_escopo_ids()`"* vale **só em parte** — as leituras de `ApuracaoRepasse` usam `id_empresa = 6` (`0117:738`, `:742`, `:788`). Isso **reforça** S2.

### Reconciliação da onda-007 (P1) — o que foi aplicado na árvore, não só registrado

| Item | Aplicação |
|---|---|
| **U1** path fabricado | árvore de §Project Structure e §Riscos agora apontam os **drivers** `infra/hub/testes/hub-adiantamentos-integration.sh` e `hub-lancamento-externo-integration.sh`; nenhum `.test.js` de integração em `backend/tests/` |
| **U2** (dinheiro) `PATCH` descartado no contrato | removido de `contracts/hub-repasse-gerar-movimentos.md` §Idempotência; o fluxo vigente é o único descrito |
| **U3** rótulo "fail-closed" | retirado; a guarda migra como **"informado, não bloqueado"** (P9) |
| **U4** "(ids 1–8)" | removido; a medição do operador diz **8 empresas**, sem ids |
| **D6** imutabilidade | `MIG/0066:460`–`:461` (REVOKE) + `:463` (função) + `:470`–`:478` (triggers) em plan, data-model, quickstart, research, contratos |
| **D1** predicado da CTE | `MIG/0117:866`–`:867` (não `:869`–`:871`) |
| demais derivas | `0117:768-777`→`:759-771`; `0117:825-836`→`:818-827`; `0098:51`→`:50`; `:2305`→`:2306`; laço `:2306-2322`→`:2309-2323` — propagadas aos 5 artefatos |
| aviso de `plan.md` sobre S1 | substituído: o banner de "conflito aberto" e a descrição de `dec-034` saíram; §S1 descreve **só** `dec-038` |
| contagem do S5 | três funções **criadas/recriadas** (prévia, congelado, `hub_repasse_alocar_envio_id`) + `fechar` por idempotência |

### Três correções de desenho que a auditoria trouxe (não são veracidade, são projeto)

1. ⚠️ **`components/action-bar.tsx` é COMPARTILHADO** — `app/hub/dashboard/envio_massa/page.tsx:49` também o monta, dentro de `HubAuthProvider` + `HubSessionGuard`. Montar o botão ali cria uma **terceira** montagem, não duas. **E há notícia boa**: `action-bar.tsx:30` já tem a prop `periodo?: string | null`, e a tela do hub já calcula um período (`envio_massa/page.tsx:214`–`:221`) — porém como texto `'DD/MM/AAAA a DD/MM/AAAA'`, **não** ISO. O §D8 precisa ser refeito: decidir se são 2 ou 3 montagens e como normalizar esse período.
2. ⚠️ **O default do seletor próprio está errado**: `inicioDaSemanaApuracao(new Date(), dia)` (`FE/lib/hub/periodo.ts:46`) devolve a semana **corrente**, que por `MIG/0067:1899` **sempre** recusa com `PERIODO_EM_ABERTO`. O default tem de ser a **última semana fechável**, senão o botão nasce recusando.
3. ⚠️ **Remover o `FecharApuracaoDialog` perde mais do que a exibição de pendências**: ele também contém a **confirmação explícita de remanescente negativo**, que a política do próprio código declara **"informado, não bloqueado"** (`FE/components/hub/adiantamento-fechar-apuracao-dialog.tsx:54`–`:56`: *"fechar é irreversível e a operação fecha na segunda — recusar o fechamento travaria o repasse"*; implementação em `:93`–`:135`) e o `AvisoLancamentoExterno`, com **5 testes** cobrindo a guarda (`repasse/page.test.tsx:193`–`:250`). O plano migrava só as pendências. **Essa guarda precisa ir para o componente novo**, ou D4 remove uma proteção de dinheiro em silêncio. ⚠️ **Preservar exatamente a semântica vigente — "informado, não bloqueado"**: a caixa de confirmação é **exigida** (quando `qtdNegativo > 0` **ou** quando o resumo é desconhecido — carregando, erro, campo ausente: `:96`–`:100`), mas o operador **sempre pode confirmar e prosseguir**; a guarda **nunca recusa** o fechamento. Migrá-la como *bloqueio* mudaria comportamento de dinheiro que está no ar. Rótulo "fail-closed" **não** descreve a política e foi retirado; o que é "fechado" no código é só a leitura do **resumo desconhecido** (exige a caixa em vez de assumir 0) — e isso também migra intacto.

---

## Bloqueios RESOLVIDOS — `block-001` (opção B) e `block-002` (terceiro desenho do S1), 2026-10-28

> Registro literal em `.human_blocks[0].human_answer`. Esta seção substitui a pergunta; a tabela de opções ficou abaixo apenas como histórico do que foi apresentado.

| Achado | Decisão do operador | O que entra nesta frente |
|---|---|---|
| **S1** (corrida duplica nota) | **Corrigir nesta frente** | A trilha passa a ser **reserva gravada ANTES** do `EnvioMassa` — *"ou equivalente que garanta idempotência real"*. **E** consertar a mensagem do `catch`, que hoje afirma falsamente *"nada foi gravado para este motorista"* quando o `EnvioMassa` **já gravou** |
| **S2** (permissão na entidade ativa × escrita na Movee) | **DEFERIDO, com gatilho medido** | ⚠️ **NÃO tocar `/repasse/:periodo/fechar` nesta frente.** Medido em produção 2026-10-28: `adiantamentos.pagamento_confirmar` existe em **5 usuários, todos na empresa 6** (zero portadores fora da Movee), ainda que haja vínculos ativos em 8 empresas. **Gatilho de reabertura: o primeiro vínculo fora da empresa 6 com papel que carregue essa permissão torna S2 bloqueante.** Registrado em `deferred-work.md` |
| **S5** (ACL após `DROP FUNCTION`) | **OBRIGATÓRIO, não deferível** | `REVOKE ALL ... FROM PUBLIC` após cada `DROP`+`CREATE` na `0118` |
| **S3**, **S4**, **S6** | Deferidos | `deferred-work.md` |

### S7 — incluído nesta frente por aplicação do critério do operador (dec-026)

S7 foi descoberto **depois** de `block-001` ser registrado, então o operador não o viu. Não invento consentimento: aplico o **critério que ele próprio enunciou** — *corrigir o que é explorável hoje nesta rota; deferir o que exige tocar `/fechar`*.

- S7 é **explorável hoje sem atacante nenhum**: é defeito **funcional** (motorista com movimento aberto em outra empresa cliente é recusado e **não recebe nota**).
- S7 está **na própria rota desta frente** (`:2250`–`:2251`), **não** em `/fechar` ⇒ respeita a restrição explícita do operador.
- A justificativa do deferimento de S2 **não transfere**: ela se apoia em "zero portadores da permissão fora da empresa 6", e o dano de S7 não depende de quem tem permissão.
- Custo: **um filtro**, reusando o padrão que a query de histórico da mesma função já usa.

⚠️ **Vetável**: se o operador preferir deferir S7 também, é uma linha a remover da F2.

### O mecanismo da reserva do S1 — RESOLVIDO (`block-002` → `dec-040`): histórico dos três desenhos

O operador escolheu o **terceiro desenho** (`dec-038`) em 2026-10-28; o `data-veracity-verifier` o confirmou por medição independente. O desenho vigente está em §S1 e **só lá**. Fica aqui apenas o registro do que foi refutado e por quê, para ninguém reabrir:

| | `dec-030` (PATCH) | `dec-034` (liberar órfã) | **`dec-038` (vigente)** |
|---|---|---|---|
| Fluxo | reserva com `envio_massa_id NULL` → `POST EnvioMassa` → `PATCH` | RPC `DEFINER` aloca id, **apaga** órfã, grava reserva | RPC `INVOKER` aloca id → reserva **com** id → `POST EnvioMassa` **com o mesmo id** |
| Por que refutado | `0092:63` dá só `SELECT, INSERT` e `0092:44` é `NOT NULL`: o `PATCH` é **impossível** sem DDL + `GRANT` novos; e o `NULL` não distingue "nota não criada" de "criada e id perdido" (sem chave natural: `0033:126`, índices `:150`–`:156` não são `UNIQUE`) | o `DELETE … NOT EXISTS` não distingue órfã de **em andamento**: o advisory *xact* lock não cobre o round-trip HTTP (`MIG/0011:7`–`:9`) ⇒ B apaga a reserva viva de A e **as duas** gravam nota | — |
| DDL na trilha | 3 comandos | nenhum | **nenhum** |
| Privilégio novo | `UPDATE (envio_massa_id)` | `SECURITY DEFINER` novo | **nenhum** (`0033:197` já concede `USAGE, SELECT` na sequência) |
| Fecha a corrida por | — | tempo/adivinhação | **integridade**: `UNIQUE` da trilha + PK da `EnvioMassa` |

**Heurística de "reserva jovem < 5 min = `JA_GERADO`" (`dec-035`): DESCARTADA.** Fecha a janela por sorte e, passada, volta a permitir duplicata, num caminho que emite nota fiscal.

⚠️ Aviso que continua valendo no repositório: grant **por coluna** faz `has_table_privilege` mentir (`0052`/rls-importacoes). Não se aplica aqui — não há grant por coluna — mas vale ao escrever o teste de ACL.

---

## Histórico — a pergunta que `block-001` apresentou

O gate `owasp-security` reprovou com **2 achados `high`**, e a auditoria de veracidade acrescentou um **terceiro** (S7) — todos no caminho do dinheiro (S1, S2, S7 acima), **todos reconferidos linha a linha no código** e **todos pré-existentes**: esta frente os **amplia**, não os cria. Corrigi-los extrapola o escopo do briefing: S1 inverte uma ordem de escrita deliberada (`:2307`) e S2 **toca a rota `/fechar`, em produção**.

⚠️ **S2 e S7 reprovam o Princípio II da constitution, que é NON-NEGOTIABLE** — logo "aceitar risco" **não é opção disponível ao agente**. Só o operador pode decidir sobre eles.

Por isso a pipeline **para aqui** e pergunta, em vez de decidir sozinha. As opções apresentadas ao operador:

| Opção | O que significa |
|---|---|
| **A — corrigir S1, S2 e S7 nesta frente** (recomendada) | Entram na F2/F3 como pré-requisito. Custo: ~1 fase extra + testes de corrida e de tenant negativo. Benefício: a frente não vai ao ar sobre um caminho que pode emitir nota em dobro, travar a semana real ou recusar motorista legítimo por movimento de outro tenant |
| **B — corrigir só S1 e S7** | S1 viola SC-004 e é o mecanismo que a re-entrância deste plano **pressupõe**; S7 é um `grep`-de-uma-linha com efeito funcional imediato. S2 fica como risco aceito **registrado**, com o agravante de que D4 remove o botão manual e a geração passa a ser o único caminho |
| **C — seguir sem corrigir, risco aceito** | ⚠️ **Indisponível para S2/S7 sem decisão sua**: ambos reprovam o Princípio II, NON-NEGOTIABLE. E nada aqui é reversível — `ApuracaoRepasse` é imutável e nota fiscal emitida não se desfaz |
| **D — corrigir S1/S2/S7 em frente própria, antes desta** | Separa a correção de segurança da feature. Atrasa o efeito que o operador pediu, mas mantém cada entrega com um assunto |

Recomendação do agente na época: A. **Resposta do operador: B** (ver seção acima) — S1 corrigido aqui, S2 deferido com gatilho medido em produção, `/fechar` intocada.

⚠️ **Além do bloqueio, quatro pré-requisitos de `/create-tasks`** permanecem válidos sob a opção B:
1. §2.bis — a `0118` precisa do `CASE`/`COALESCE` no fechamento, senão o **caso central de D3** cai em `SEM_DIVISAO` (dec-024).
2. `components/action-bar.tsx` é **compartilhada** — a tela de Envio em Massa do **hub** também a monta ⇒ refazer D8 para 2 ou 3 montagens (dec-025).
3. O default de semana do seletor é a semana **corrente**, que **sempre** recusa `PERIODO_EM_ABERTO` (dec-025).
4. Remover o `FecharApuracaoDialog` levaria embora a **confirmação explícita de remanescente negativo — "informado, não bloqueado"** (5 testes) — migrar essa guarda **preservando** essa semântica (dec-025, U3).

As medium/low (S3 rate limit, S4 identidade dupla, S5 ACL da `0118`, S6 amarras do PII) **não** bloqueiam e entram como itens de `/create-tasks` — exceto **S5, que é obrigatório** na `0118` por ser `REVOKE`/`GRANT` de função `SECURITY DEFINER`.

---

## Próximos passos

1. ✅ **`block-001`** → `dec-026`, opção **B** (S1 + S7 + S5 corrigidos aqui; S2/S3/S4/S6 em `deferred-work.md`).
2. ✅ **`block-002`** → `dec-040`: mecanismo único do S1 = terceiro desenho (`dec-038`). Artefatos reconciliados na onda-007 (P1).
3. `/create-tasks` — `tasks.md` com as fases F0–F7, P1–P9 e as regras de ordenação (migration antes do código; S5 como item de aceite; controle negativo por correção; preferir restringir a generalizar).
4. `/analyze` — consistência cross-artifact (spec × plan × tasks), com atenção à **reinterpretação declarada de FR-002/AS-3** (`research.md` Decision 1): se o analyze a marcar como divergência, ela é **deliberada e justificada por M3**, não achado.
