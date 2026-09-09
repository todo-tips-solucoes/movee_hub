# Implementation Plan: Enriquecimento automático de entregadores novos

**Feature**: `hub-enriquecimento-automatico` | **Date**: 2026-09-08 | **Spec**: [spec.md](./spec.md)

## Summary

Hoje todo entregador criado por uma importação nasce fora da fila de
enriquecimento e só entra nela se um operador abrir a tela e clicar — por isso
o número de entregadores novos sem dados cresce continuamente (67 → 75 em uma
hora — observação do operador na descrição da feature, reproduzida em
`spec.md` SC-003; não é medição deste agente). Esta feature faz o entregador
**novo** entrar na fila sozinho, e torna o desfecho da última tentativa consultável em 4 valores
distintos.

Abordagem técnica em uma frase: **a distinção "entregador novo" é delegada ao
banco**, onde ela é nativa. O upsert de importação é um
`INSERT ... ON CONFLICT DO UPDATE`; um gatilho `BEFORE … FOR EACH ROW` carimba
`dados_entrego_solicitado_em` nas linhas que são de fato novas — sem
tocar em `lib/hub-import-processor.js`, sem round-trip extra e sem janela de
corrida. O gatilho é condicionado à claim `origem_importacao`, já emitida
exclusivamente pelo pipeline de importação, para que a criação **manual** de
motorista não seja alcançada.

> **Atualização da onda-005 (respostas de `block-003`)**: as quatro mitigações
> aprovadas pelo operador (teto configurável, prioridade do pedido manual,
> habilitação por empresa e cutover condicionado à retenção de PII) mudaram o
> desenho em dois pontos concretos: o gatilho continua `BEFORE … FOR EACH ROW`
> (dec-017 intacta) mas passa a cobrir também o evento `UPDATE` — é o que faz
> o excedente do teto entrar na importação seguinte —, e a feature passou a ter
> **uma tabela nova** de habilitação por empresa (`research.md` Decision 9).
>
> Todo o comportamento do gatilho (teto exato dentro do lote, excedente que
> volta, empresa não habilitada, retroatividade excluída, custo) foi **medido
> em `postgres:13.23`** antes de virar artefato — tabela completa em
> `data-model.md` §Evidência empírica. A medição refutou a hipótese que quase
> virou desenho (a de que um gatilho de linha não enxerga as linhas irmãs do
> mesmo `INSERT`) e evitou um gatilho de statement com *transition table*,
> `row_number()` e guarda de recursão que seriam complexidade comprada com uma
> premissa falsa.

Tamanho real da mudança: **1 migration** (`0060`: duas colunas em
`"Entregador"`, uma tabela de habilitação, um índice parcial, um backfill, uma
função e **um** gatilho), **~20 linhas** em `routes/hub-robo-entrego.js`,
**~1 linha** em `routes/hub-motoristas.js` e **~4 linhas** em dois arquivos do
robô. Nenhum worker novo, nenhum scheduler novo, nenhuma rota nova, nenhuma
mudança de frontend.

## Decisões referenciadas (glossário)

As referências `dec-NNN` neste e nos demais artefatos apontam para o registro
de decisões da execução autônoma, que vive em
`.claude/feature-00c-state/hub-enriquecimento-automatico/` — diretório
**gitignored** (`.gitignore:51`). Para que o repositório versionado seja
autocontido, o conteúdo de cada uma está reproduzido aqui:

| Ref | Onde nasceu | Conteúdo |
|-----|-------------|----------|
| `dec-010` | Clarify desta feature (Session 2026-09-08, registrada em `spec.md` §Clarifications) | O campo de desfecho tem **4 valores distintos e consultáveis** — `nunca-tentado`, `pessoa-não-encontrada`, `outra-falha`, `sucesso`. A redundância entre o valor `sucesso` e `dados_entrego_enriquecidos_em` é **aceita e deliberada** porque os dois são gravados no MESMO PATCH |
| `dec-011` | Clarify desta feature (mesma sessão, em `spec.md` §Clarifications) | Escopo **somente backend**; UI no `frontend_v2` fica para feature futura |
| `dec-017` | Phase 0 desta feature (research.md Decision 1) | Distinguir INSERT de UPDATE via **trigger `BEFORE` de linha escopado pela claim `origem_importacao`**, não por pré-`SELECT` nem por `DEFAULT`. **Intacta na onda-005**: o gatilho segue `BEFORE … FOR EACH ROW` com a mesma claim; só passou a cobrir também o evento `UPDATE`, exigido pela resposta H2 do operador (research.md Decision 8) |
| `dec-022` | Resposta do operador ao `block-003` (gate `owasp-security`, onda-005) | As 4 mitigações aprovadas: **(H1)** implementar e testar sem ligar em produção; o gatilho **não** é criado no `chatmasterveloz` nesta entrega e o cutover fica condicionado à definição prévia do prazo de retenção/expurgo de CPF/RG/CNH; não ampliar a coleta de PII agora. **(H2)** teto de **100** novos enfileirados por importação/dia, **configurável**, com o excedente preservado para a importação seguinte. **(M1)** o pedido manual **fura a fila** dos auto-enfileirados. **(M2)** enfileiramento **condicionado a empresa habilitada** (hoje só a Movee, empresa 6). Reproduzido integralmente em `spec.md` §Clarifications e virou FR-010..FR-013 |
| `dec-038` | Feature `hub-motorista-360` | Retenção/expurgo da PII enriquecida é **dívida assumida**, sem prazo definido — permanece aberta e fora do escopo desta feature |
| — (sem `dec` lida) | Achado H2 do gate `owasp-security` desta fase | O robô compartilha a mesma conta/sessão EntreGô entre importação e enriquecimento, e uma execução por vez (lock `flock -n`, `infra/robo-entrego/src/index.js:485`; acoplamento login↔enriquecimento anotado em `:364`). O gate referiu esse fato como "dec-039"; **o agente não leu esse registro** e o afirma apenas na parte verificável no código. Confirmar o id com o operador antes de citá-lo como fonte |

As duas primeiras estão integralmente citadas em `spec.md` §Clarifications, que
**é** versionado — nenhuma decisão desta feature depende exclusivamente do
state gitignored.

## Technical Context

**Language/Version**: Node.js 20 (`node:20-alpine`, imagem de produção via
`Dockerfile.hub`; confirmado por `docker run --rm <imagem> node --version` →
`v20.20.2`, registrado no CLAUDE.md) + SQL (PostgreSQL/PL-pgSQL)
**Primary Dependencies**: Express (backend), **PostgREST** como camada de
persistência (sem ORM), `jsonwebtoken` para o JWT por requisição
(`lib/hub-postgrest-jwt.js`), Playwright no robô
**Storage**: PostgreSQL. Hub isolado = `hub_homolog_db`; **em produção as
tabelas do hub vivem dentro do `chatmasterveloz`**
**Testing**: `node --test` (backend: `npm test`, `npm run test:hub:unit`,
`npm run test:hub:integration`) e `node --test` no robô
(`infra/robo-entrego/test/`). Sem vitest/Playwright nesta feature (backend-only)
**Target Platform**: Docker Swarm no VPSTodo, atrás de Traefik
**Project Type**: web-service (backend Express) + worker externo (robô systemd)
**Performance Goals**: nenhuma meta nova. A feature **remove** trabalho do
caminho de importação (zero requisição adicional por lote); o custo é um
gatilho `BEFORE` por linha tocada — medido em **19,0 ms** para um lote de 500
(`data-model.md` §Evidência empírica)
**Constraints**: migration expand-only e idempotente; `infra/robo-entrego/`
roda do diretório vivo (exige worktree); aplicação em produção sob os 5 gates
do rito
**Scale/Scope**: lotes de importação de até 500 linhas; fila consumida em
blocos de 20 (`LOTE_ENRIQUECIMENTO_DEFAULT`, `routes/hub-robo-entrego.js:44`).
**O total de `Entregador` em produção não é conhecido por este agente** e por
isso não é afirmado aqui — sai da consulta do operador no `quickstart.md`
Cenário 6, junto com o número que de fato importa. **Quantos desses já têm
`dados_entrego_enriquecidos_em` preenchido — e portanto quantos o backfill da
`0060` toca — não é conhecido pelo agente** (sem acesso a produção): sai da
consulta do operador no `quickstart.md` Cenário 6

**NEEDS CLARIFICATION**: nenhum (ver `research.md` §NEEDS CLARIFICATION
restantes).

## Constitution Check

*GATE: passou antes do Phase 0. Re-checado após Phase 1 (ETAPA 7) — sem
mudança de status.*

| Princípio | Status | Notas |
|-----------|--------|-------|
| **I. Segurança de Autenticação & Segredos** (NON-NEGOTIABLE) | **PASS** | Nenhum mecanismo de auth novo. O `PATCH` continua autenticando pelo cookie httpOnly `hub_accessToken`. Nenhum segredo novo. O campo novo (`sinalFalha`) é um enum curto, **não** PII, e é o único dado novo que entra em log/auditoria — `detalhes` continua proibido de conter `dados` (payload sensível) |
| **II. Isolamento Multi-Tenant** (NON-NEGOTIABLE) | **PASS** | FR-009 satisfeita sem código novo: o `id_empresa` segue vindo de `payload.entidade_ativa` do token → claims → JWT do PostgREST → RLS (`0015`). Nenhum caminho novo lê tenant do corpo. O trigger roda **dentro** da transação já escopada pela RLS, e a claim `origem_importacao` que ele lê é assinada pelo backend (`lib/hub-postgrest-jwt.js`) — cliente nenhum consegue forjá-la. A tabela nova (`"EnriquecimentoAutomatico"`) é **chaveada por empresa** e lida **só** de dentro do gatilho, que já roda na transação escopada — nenhum caminho novo lê tenant do corpo, e ela não recebe grant de escrita para `authenticated` |
| **III. Contratos de API & Proxy de Cookies** | **PASS** | Mudança é aditiva num endpoint existente (campo opcional). Nenhuma chamada cross-site nova. Sem frontend nesta feature. Contrato documentado em `contracts/entrego-desfecho.md`; atualizar `backend/README.md` no mesmo PR (SHOULD do princípio) |
| **IV. Qualidade e Revisão de Mudanças** | **PASS** | Branch dedicada, Conventional Commits, PR pequeno. Toca fluxo de dados pessoais ⇒ passa por gate `owasp-security` (SHOULD do princípio, e obrigatório nesta execução) |
| **V. Deploy Conteinerizado e Convivência** (NON-NEGOTIABLE) | **PASS** | Nenhum serviço, porta ou container novo. Migration é aditiva. `ADD COLUMN NOT NULL DEFAULT <const>` é operação de metadado no PG ≥ 11 (sem reescrita de tabela), então não bloqueia a tabela viva |

Nenhum FAIL. Nenhuma exceção a documentar.

## Project Structure

### Documentation (this feature)

```
docs/specs/hub-enriquecimento-automatico/
├── spec.md
├── plan.md                        # This file
├── research.md                    # Phase 0
├── data-model.md                  # Phase 1
├── quickstart.md                  # Phase 1
└── contracts/
    └── entrego-desfecho.md        # Phase 1
```

### Source Code (paths reais, verificados)

```
infra/hub/migrations/
└── 0060_entregador_enfileira_novo_e_desfecho.sql   # NOVO — única migration
                                   #   2 colunas em "Entregador" + backfill
                                   #   tabela "EnriquecimentoAutomatico" + GRANT SELECT
                                   #   índice parcial da fila
                                   #   1 função + 1 gatilho (BEFORE INSERT OR UPDATE, FOR EACH ROW)

app_homologacao/backend/
├── routes/
│   ├── hub-robo-entrego.js        # ALTERADO — mapeia sinalFalha -> desfecho no PATCH;
│   │                              #   zera solicitado_manual; ordena manual-primeiro (FR-011)
│   └── hub-motoristas.js          # ALTERADO — POST manual grava solicitado_manual=true
│                                  #   (segue sem a claim origem_importacao)
├── lib/
│   ├── hub-import-processor.js    # INALTERADO — é o ponto da decisão técnica
│   ├── hub-postgrest.js           # INALTERADO
│   └── hub-postgrest-jwt.js       # INALTERADO
└── tests/
    ├── hub-robo-entrego-enriquecimento-unit.test.js  # ALTERADO — 4 desfechos + ordem manual-primeiro
    └── hub-motoristas-*.test.js                      # ALTERADO — POST manual marca solicitado_manual

infra/robo-entrego/                # ⚠️ mudança exige git worktree
├── src/
│   ├── enriquecimento.js          # ALTERADO — envia sinalFalha: e.sinal
│   ├── hub-client.js              # ALTERADO — anexa sinalFalha ao corpo do PATCH
│   └── entrego-portal.js          # INALTERADO — já define o sinal
└── test/
    └── hub-client.test.js         # ALTERADO — asserção do corpo enviado
```

**Structure Decision**: nenhuma estrutura nova. A feature adere ao layout já
estabelecido — migrations em série única `infra/hub/migrations/NNNN_*.sql`,
rotas do hub em `routes/hub-*.js`, robô isolado em `infra/robo-entrego/`. A
regra de negócio "entregador novo entra na fila" mora **no banco**, ao lado da
regra irmã de `0025` que já protege `nome` no mesmo upsert e na mesma tabela —
proximidade deliberada, não dispersão.

## Convenções de Borda

Esta feature atravessa **duas** bordas: DB ↔ backend e backend ↔ robô. Não há
borda backend ↔ frontend (escopo backend-only, dec-011).

| Camada | Case style | Validação | Fonte da verdade |
|--------|------------|-----------|------------------|
| Colunas do PostgreSQL | `snake_case` | `CHECK` constraint na coluna + migration | `infra/hub/migrations/0060_*.sql` |
| Resposta do PostgREST (linha crua) | `snake_case` (espelha a coluna) | — (PostgREST não transforma) | `infra/hub/migrations/*.sql` |
| Corpo do PATCH robô → hub | `camelCase` (`sinalFalha`, `motivoFalha`, `sucesso`, `modo`) | allowlist fechada **no servidor**, mapeamento total | `contracts/entrego-desfecho.md §1` |
| Valores do enum de desfecho | `kebab-case` (`pessoa-nao-encontrada`) | `CHECK` de 4 valores | `data-model.md` |
| Valores do sinal do robô | `snake_case` (`pessoa_nao_encontrada`) | classe de erro | `infra/robo-entrego/src/entrego-portal.js:80-86` |

> ⚠️ **Divergência deliberada de case entre o sinal e o desfecho**: o robô
> emite `pessoa_nao_encontrada` (snake_case, vem do `this.sinal` da classe de
> erro) e a coluna guarda `pessoa-nao-encontrada` (kebab-case, vocabulário da
> spec/dec-010). **Não** são o mesmo token e não devem ser "unificados" por
> conveniência: o mapeamento explícito entre os dois é justamente o ponto de
> desacoplamento que impede o vocabulário interno do robô de virar contrato de
> banco. A tabela de mapeamento é a fonte da verdade
> (`contracts/entrego-desfecho.md §1`).

**Mapper layer (DB ↔ DTO)**: não há ORM neste projeto (persistência é HTTP
para o PostgREST). O mapeamento acontece explicitamente em
`routes/hub-robo-entrego.js` ao montar o `patchBody`. ORM auto-mapping: **NÃO**.

**Validação**: sem Zod neste backend. A validação é manual no handler
(`typeof sucesso !== 'boolean'` ⇒ `422`) + a allowlist fechada do
`sinalFalha` + o `CHECK` do banco como backstop. Três camadas, a última
inviolável.

## Ordem de implementação (dependências)

1. **Migration `0060`** — 2 colunas + `CHECK` + backfill + tabela de
   habilitação + índice + função + 1 gatilho. Independente; nada depende de
   código de aplicação. **Não liga nada por si só** (nega-por-padrão).
2. **Backend** — `PATCH` grava `dados_entrego_desfecho` e zera
   `dados_entrego_solicitado_manual`; `GET` da fila ganha a chave de
   ordenação; `POST` manual marca `solicitado_manual = true`. Depende de (1)
   para as colunas existirem. Tolera `sinalFalha` ausente desde o primeiro dia
   (mapeamento total ⇒ `outra-falha`), então **não** depende do robô.
3. **Robô** (worktree) — passa a enviar `sinalFalha`. Depende de (2) apenas
   semanticamente; enviar o campo antes de (2) existir é inofensivo (o
   handler ignora campos desconhecidos).
4. **Habilitação da empresa** (`INSERT` em `"EnriquecimentoAutomatico"`) —
   **fora desta entrega em produção**. É o cutover, e depende da decisão de
   retenção de PII (H1/dec-022).

A ordem 1 → 2 → 3 é *forward-compatible* em cada passo: nenhum deles quebra o
anterior se o deploy for parcial. Isso importa porque o robô é atualizado por
merge (≠ deploy do backend) e os dois não sobem juntos.

> ⚠️ **A única ordem que NÃO é livre é 1 antes de 2**: o backend passa a
> enviar duas colunas novas no `PATCH`; contra um PostgREST cujo schema não as
> tem, o PostgREST responde erro e o enriquecimento **manual** quebraria — uma
> regressão numa funcionalidade que hoje funciona. Em produção, ou sobem os
> dois (migration primeiro) ou não sobe nenhum.

## Achados do gate `owasp-security` (fase plan)

Veredito: **aprovado com ressalvas** — 0 critical, **2 high**, 4 medium, 3 low.
Nenhum bloqueio para implementar e testar em `hub_homolog`. **H1, H2, M1 e M2
eram decisões do operador; foram respondidas em `block-003`/`dec-022`
(2026-09-08) e estão RESOLVIDAS** — cada uma virou requisito (FR-010..FR-013),
desenho (`data-model.md`) e cenário de verificação (`quickstart.md`). Nenhum
achado do gate segue em aberto.

O gate confirmou no **código** (não no texto do plano) que:
a claim `origem_importacao` **não é forjável por cliente** (JWT HS256 assinado
com `PGRST_JWT_SECRET` pelo backend; o browser nunca fala com o PostgREST); a
RLS **cobre o INSERT** que dispara o trigger
(`entregador_insert_por_escopo … WITH CHECK (id_empresa = ANY(hub_jwt_escopo_ids()))`,
`0015:26-29`, nega-por-padrão sem claim); e `sinalFalha` **não injeta nem
viola o CHECK** (mapeamento total, valor bruto nunca chega à coluna).

| # | Sev | Achado | Estado |
|---|-----|--------|--------|
| H1 | high | O auto-enfileiramento remove o **único ponto de decisão humana** antes de coletar CPF/RG/CNH de terceiros. O volume de PII — que **não tem prazo de expurgo** (dívida `dec-038`) — passa a ser ditado pelo tamanho do arquivo importado | **RESOLVIDO** (`dec-022`) — implementar e testar **sem ligar em produção**: a `0060` não é aplicada no `chatmasterveloz` nesta entrega; mesmo se fosse, o gatilho é inerte sem linha de habilitação; ligar é ato explícito do runbook, **condicionado à definição prévia do prazo de retenção/expurgo**. FR-013 + `research.md` Decision 11 + `quickstart.md` Scenario 12 |
| H2 | high | Nenhum teto ao que uma importação enfileira, e o consumidor drena 20/rodada a 60 s **na mesma sessão/conta EntreGô da importação diária** — um bloqueio antibot derruba também a importação | **RESOLVIDO** (`dec-022`) — teto **configurável por empresa**, valor inicial **100**, excedente preservado para a importação seguinte. FR-010 + `data-model.md` §Trigger + `quickstart.md` Scenario 10 |
| M1 | medium | Starvation do sob-demanda: a fila é `order=solicitado_em.asc`; milhares de auto-enfileirados entram à frente e o clique manual do operador passa a esperar dias | **RESOLVIDO** (`dec-022`) — pedido manual **fura a fila**, via coluna `dados_entrego_solicitado_manual` + uma chave a mais no `order`. FR-011 + `contracts/entrego-desfecho.md §2` + `quickstart.md` Scenario 11 |
| M2 | medium | Enfileiramento é multi-tenant, consumo **não**: o trigger dispara para qualquer tenant que importe, mas o robô consome com uma única `entidade_ativa`/credencial EntreGô. Tenant sem robô acumula fila que nunca drena | **RESOLVIDO** (`dec-022`) — enfileiramento **condicionado a empresa habilitada**, nega-por-padrão. FR-012 + `data-model.md` §`EnriquecimentoAutomatico` + `quickstart.md` Scenario 12 |
| M3 | medium | Backfill reescreve linhas e segura lock em tabela viva | **Corrigido** — loteamento condicionado à medição (research.md Decision 4; quickstart 6.1) |
| M4 | medium | `sinalFalha` bruto (atacante-controlado, sem limite de tamanho) iria para `Auditoria.detalhes`; `scrubDetalhes` não pega nome/RG/CNH | **Corrigido** — grava o valor **mapeado**; `length <= 64`; `motivoFalha` truncado (contracts §1) |
| L1 | low | Função do trigger sem `SECURITY INVOKER`/`search_path` explícitos | **Corrigido** — data-model.md §Trigger |
| L2 | low | Se a função existir em prod com corpo divergente, o trigger fica **inerte em silêncio** e FR-001 falha sem alarme | **Corrigido** — prova pós-deploy no quickstart |
| L3 | low | A garantia de que o POST manual não enfileira é a **ausência** da claim; um futuro caller que espalhe `job.claims` reintroduz o efeito sem quebrar teste | **Corrigido** — teste de regressão no quickstart |

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| **Amplificação de fila por importação grande (H2)** | Teto por empresa (`EnriquecimentoAutomatico.teto`, inicial 100), aplicado no próprio gatilho. Fechado em `dec-022`/FR-010 |
| **PII coletada sem prazo de expurgo, em volume ditado pela importação (H1)** | Nesta entrega **nada é ligado em produção**. O cutover permanece **condicionado à definição do prazo de retenção/expurgo de CPF/RG/CNH** — pendência do operador, herdada de `0057` (`dec-038`). Fechado em `dec-022`/FR-013 quanto ao mecanismo; a decisão de retenção segue aberta e **é o gate do cutover** |
| **Starvation do pedido manual (M1)** | `dados_entrego_solicitado_manual` + `order=…_manual.desc,…_em.asc`. Fechado em `dec-022`/FR-011 |
| **Tenant sem robô acumula fila que nunca drena (M2)** | Habilitação por empresa, nega-por-padrão. Fechado em `dec-022`/FR-012 |
| **Recursão do gatilho** | Não existe neste desenho: um gatilho `BEFORE` altera `NEW` e não emite comando algum, logo não pode disparar a si mesmo. Foi um dos motivos de descartar o desenho `AFTER … FOR EACH STATEMENT` (research.md Decision 8) |
| **Coexistência com `trg_entregador_protege_nome`** (agora os dois são `BEFORE UPDATE` de linha) | Escrevem campos disjuntos (`dados_entrego_solicitado_em` vs `nome`) e são encadeados pelo PG em ordem de nome; a ordem é indiferente ao resultado (`data-model.md` §Convivência) |
| **O evento `UPDATE` do gatilho varrer o passivo histórico** (retroatividade, que foi bloqueio humano em `hub-motorista-360`) | `criado_em >= EnriquecimentoAutomatico.desde`. Provado em `quickstart.md` Scenario 13 |
| **Deploy do backend sem a `0060`** ⇒ `PATCH` com colunas inexistentes ⇒ enriquecimento manual quebra | Acoplamento declarado em §Ordem de implementação: migration e backend sobem juntos ou não sobem |
| `hub_jwt_origem_importacao()` não existir em produção ⇒ trigger quebrado | Verificação ao vivo obrigatória antes de aplicar (`quickstart.md` Cenário 6). Bloqueante |
| PostgREST não recarregar o schema cache ⇒ `400` ao selecionar a coluna nova | `migrate.sh` envia `SIGUSR1`; conferir pela contagem de funções no log, **não** por sonda HTTP em `/rpc/` |
| Backfill marcar como `nunca-tentado` linhas já enriquecidas | O backfill da `0060` deriva `sucesso` de `dados_entrego_enriquecidos_em IS NOT NULL` (Decision 4) |
| Falhas históricas não reconstruíveis | Limitação declarada e aceita (Decision 4) — subnotificação honesta, corrige-se na primeira tentativa nova |
| Alguém "simplificar" removendo `desfecho` ou `enriquecidos_em` por parecerem redundantes | Proibido pela spec em nota destacada; enunciado com precisão em `data-model.md` §Invariante e testado no `quickstart.md` Cenário 5 |
| Mudar `infra/robo-entrego/` na working tree principal altera o que roda em produção antes do merge | Worktree obrigatório; suíte provada **no diretório vivo** após o merge |

## Fora de escopo (explicitamente)

- **UI no frontend_v2** — dec-011. Exposição visual do desfecho é feature
  futura com escopo próprio.
- **Retroatividade**: enfileirar entregadores **já cadastrados** que nunca
  foram enriquecidos. Foi bloqueio humano na feature irmã `hub-motorista-360`
  e não pode ser reaberto aqui.
- **Política de retry nova** — a spec é explícita: comportamento de nova
  tentativa permanece o que já está em vigor.
- **Retenção/expurgo da PII enriquecida** — dívida assumida desde `0057`
  (dec-038), continua aberta e **fora** desta feature.
- **Aplicação em produção** — o plano entrega a migration como artefato. A
  aplicação no `chatmasterveloz` é rito integral dos 5 gates, com autorização
  por etapa que **não** foi concedida. Por `dec-022` (H1), nesta entrega a
  `0060` é aplicada e provada **somente** no `hub_homolog`.
- **Cutover de produção** (aplicar a `0060` + habilitar a empresa 6) —
  **condicionado à definição prévia do prazo de retenção/expurgo da PII**
  (CPF/RG/CNH), decisão pendente do operador. Enquanto ela não existir, o
  enfileiramento automático não é ligado para nenhuma empresa em produção.
- **Rota administrativa para ligar/desligar a habilitação** — deliberadamente
  ausente (`research.md` Decision 9). Habilitar é `INSERT`/`UPDATE` de runbook,
  o que **é** a separação entre deploy e ativação exigida por FR-013.
- **Alerta de fila parada** (fila com pendentes e nenhum consumo) —
  observabilidade legítima, mas fora desta feature: a habilitação
  nega-por-padrão já elimina a causa levantada em M2 (empresa sem robô
  acumulando fila).

## Complexity Tracking

Nenhuma violação de constitution a justificar. Registro de complexidade
deliberadamente **evitada**:

| Complexidade evitada | Por quê |
|---|---|
| Tabela de fila dedicada | A coluna de `0057` já é a fila, por desenho declarado |
| Rota administrativa de habilitação | `research.md` Decision 9 — `GRANT SELECT` só, ativação por runbook |
| Contador de enfileirados por importação | Teto de fila **pendente** é mais forte e não tem estado (`data-model.md` §"O teto é de fila pendente") |
| Gatilho `AFTER … FOR EACH STATEMENT` com *transition table*, `row_number()` e guarda `pg_trigger_depth()` | Foi escrito e **medido — funcionava**. Descartado ao medir que o gatilho de linha já resolve: a premissa que o justificava era falsa (`research.md` Decision 8) |
| Fila separada para pedidos manuais | Uma chave de ordenação resolve FR-011 (`research.md` Decision 10) |
| Tabela de histórico de tentativas | FR-007 pede apenas a tentativa mais recente |
| Pré-`SELECT` + paginação de `in.()` no processador de importação | Substituído por um trigger; zero requisição extra e zero janela de corrida (research.md Decision 1) |
| Tipo `enum` nativo no PostgreSQL | `text` + `CHECK` é expand-only e mais barato de evoluir (Decision 3) |
| Parser de `motivoFalha` no backend | Sinal estruturado já existe no robô (Decision 5) |

Complexidade **aceita** nesta onda, com justificativa (nenhuma delas existia
na versão anterior do plano; todas vêm das respostas de `dec-022`):

| Complexidade aceita | Requisito que a exige | Alternativa mais simples e por que falha |
|---|---|---|
| Tabela nova `"EnriquecimentoAutomatico"` (5 colunas) | FR-010 (teto configurável) + FR-012 (habilitação) + FR-013 (ativar ≠ deployar) | Reusar `"ModuloEntidade"` cobre só FR-012 e polui a navegação com módulo sem tela; constante no SQL viola "nunca constante mágica"; GUC de banco exige reiniciar o PostgREST (`research.md` Decision 9) |
| Evento `UPDATE` no gatilho (antes era só `INSERT`) | FR-010, 2ª metade ("o excedente entra na importação seguinte") | Sem ele o excedente nunca voltaria: na importação seguinte aquelas linhas caem no ramo `DO UPDATE`, e um gatilho de `INSERT` não as vê |
| Coluna `dados_entrego_solicitado_manual` | FR-011 | Hoje manual e automático escrevem na mesma coluna; sem discriminador a prioridade é inexprimível (`research.md` Decision 10) |
| Índice parcial da fila | Desempenho das duas leituras quentes que a feature cria | A `0057` não criou índice; agora o gatilho conta pendentes uma vez por linha tocada pela importação, e o consumidor lê a fila a cada 5 min. É o índice que faz o lote de 500 custar 19,0 ms |
