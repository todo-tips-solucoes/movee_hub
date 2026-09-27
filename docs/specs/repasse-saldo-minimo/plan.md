# Implementation Plan: Repasse — saldo mínimo carregado, aprovação restrita e identificador do motorista

**Feature**: `repasse-saldo-minimo` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)
**Fonte**: [`docs/plans/repasse-saldo-minimo/BRIEFING-AGENTE-00C.md`](../../plans/repasse-saldo-minimo/BRIEFING-AGENTE-00C.md)

## Summary

Três frentes independentes, cada uma com PR e deploy próprios, do menor ao maior risco:

- **F1 — Identificador no repasse (US1)**: o backend junta `Entregador.id_externo` (o
  "Identificador" da tela de Motoristas) às linhas do repasse, em lotes de 100, e o expõe
  na tela (componente `CopyableUuid` já existente) e como **primeira** coluna do CSV. Sem DDL.
- **F2 — Aprovação restrita (US2)**: migration `0097` cria o papel `financeiro_aprovador`
  (cópia do `financeiro` + `adiantamentos.pagamento_confirmar`), retira essa permissão de
  todos os outros papéis exceto `admin_plataforma`, e fecha o furo de escalonamento:
  políticas de `UsuarioEntidade` passam a recusar papel restrito para quem não é admin
  plataforma, e a rota de usuários recusa com `403 PAPEL_RESTRITO` auditado — nos **três**
  pontos que gravam vínculo. Nenhuma permissão nova; as três camadas de checagem existentes
  passam a valer sozinhas.
- **F3 — Saldo mínimo carregado (US3)**: migration `0098` acrescenta colunas nuláveis de
  saldo em `ApuracaoRepasseItem` (com `CHECK` de conservação), o piso por empresa em
  `AdiantamentoConfiguracao`, reescreve o fechamento a partir do corpo vigente (0092) com
  saldo anterior, inclusão de quem só tem saldo e ordem estrita de fechamento, e expõe os
  novos valores nas quatro RPCs de leitura, na tela/CSV do hub, na geração de notas (uma
  nota só) e no app do motorista.

Decisões e evidências: [research.md](./research.md). Modelo: [data-model.md](./data-model.md).
Contratos: [contracts/](./contracts/). Cenários: [quickstart.md](./quickstart.md).

## Technical Context

**Language/Version**: Node.js 20 (backend Express, imagem `node:20-alpine` via `Dockerfile.hub`); TypeScript 5 + Next.js App Router (frontend_v2 e frontend_motorista); SQL/PLpgSQL (PostgreSQL do hub)
**Primary Dependencies**: Express, PostgREST (JWT por requisição, `lib/hub-postgrest.js`), Base UI + shadcn + Tailwind 4 (UI)
**Storage**: PostgreSQL — tabelas do hub dentro do `chatmasterveloz` em produção (migration = rito integral); série `infra/hub/migrations/NNNN_*.sql` aplicada por `migrate.sh`
**Testing**: `node --test` (backend unit), vitest (frontends), drivers `infra/hub/testes/*.sh` + `infra/hub/testes/sql/*.sql` (integração/SQL), Playwright via container oficial (E2E hub e motorista)
**Target Platform**: Docker Swarm no VPSTodo (produção = "homologação"); testes só no ambiente isolado `hub-*`  (fonte: constitution V + CLAUDE.md)
**Project Type**: web-service + 2 web apps (monorepo `app_homologacao/`)
**Performance Goals**: repasse com ~1.021 motoristas/semana (medido): tela 1 consulta extra de uuid por página (20 linhas); CSV 11 lotes; fechamento com 1 join a mais
**Constraints**: nenhuma reescrita de apuração fechada (imutável por gatilho); `in.()` ≤ 100 ids por request; mudança de tipo de retorno de RPC exige DROP+CREATE+GRANT e `SIGUSR1` no `pgadmin_postgrest` (executado pelo operador)
**Scale/Scope**: 1 empresa operando o módulo (grupo Movee, `id_empresa = 6` fixo nas funções vigentes); 3 PRs

Nenhum `NEEDS CLARIFICATION` restante. Nenhum eixo estrutural é decidido aqui (stack,
persistência, arquitetura e plataforma são as já existentes).

## Constitution Check

*GATE: Deve passar antes do Phase 0. Re-checado após Phase 1 (abaixo).*

| Princípio | Status | Notas |
|---|---|---|
| I. Autenticação & segredos | PASS | Nenhuma mudança de token/cookie. Nenhum segredo novo. A trava impede escalonamento de privilégio que hoje existe (reforça I). |
| II. Isolamento multi-tenant | PASS | Escopo sempre do token (`hub_jwt_escopo_ids()`, claims do backend); busca de uuid usa os claims do chamador; piso por empresa na tabela já escopada. `id_empresa = 6` fixo é o padrão vigente das funções do módulo (não é id vindo do cliente). |
| III. Contratos de API & proxy | PASS | Tudo via proxy `/api/*`; campos novos só aditivos. SHOULD de README: atualizar `backend/README.md` nas rotas tocadas. |
| IV. Qualidade & revisão | PASS | Branch por fase `feat/repasse-<escopo>`; Conventional Commits; revisão OWASP (gate pós-plan) e revisão adversarial sobre o diff antes do PR de F2 e F3. |
| V. Deploy conteinerizado | PASS | Nenhum serviço novo; deploy por `docker service update --image` pelo rito de 5 gates, executado pelo operador. |

## Fases de entrega

Ordem de implementação/teste F1 → F2 → F3 (mantida abaixo). **Entrega ao operador
(decisão block-010/dec-093, 2026-09-27): PR único e deploy único** para as três fases —
não branch/PR/deploy separado por fase como esta seção previa originalmente (achado
4.1 da convergência, `tasks.md` FASE 4). Runbook vigente:
`docs/plans/repasse-saldo-minimo/RUNBOOK-DEPLOY.md`; os `RUNBOOK-DEPLOY-F<n>.md`
citados abaixo ficam como histórico de "o que muda"/gates por fase, não como runbook de
execução. **O agente não executa nada em produção.**

### F1 — Identificador (sem DDL)

1. Helper de busca `id_externo` por ids em lotes de 100 (backend `lib/`), com teste unit.
2. `GET /repasse` e `GET /repasse/exportar` (ao vivo e congelado) juntam `idExterno`.
3. `serializarCsvRemanescente`: coluna `Identificador` primeiro.
4. `RepasseItem.idExterno` em `lib/hub/adiantamentos-api.ts`; coluna "Identificador" com
   `CopyableUuid` em `repasse/page.tsx`.
5. PR avisa o financeiro da mudança de cabeçalho do CSV.

### F2 — Papel aprovador + trava

1. **Controle negativo primeiro**: teste que prova o furo — em 0096, `admin_entidade`
   consegue (a) atribuir `admin_plataforma` pela rota e direto no PostgREST, (b) trocar a
   senha/desativar um usuário com papel restrito por `PUT /usuarios/:id`, (c) inserir em
   `PapelPermissao` direto no PostgREST. Os três têm de **passar** em 0096.
2. Migration `0097_papel_financeiro_aprovador.sql` (idempotente, tudo por nome):
   helper `hub_papel_restrito`; políticas de `UsuarioEntidade` refeitas a partir de 0039;
   papel novo + cópia de permissões do `financeiro` + `pagamento_confirmar`; `DELETE` de
   `pagamento_confirmar` dos demais papéis; `REVOKE INSERT, UPDATE` em
   `Papel/PapelPermissao/Permissao/Modulo` `FROM authenticated` (operador, block-005; a
   escrita legítima segue pela RPC definer `hub_papel_permissao_set`, 0037); comentário da
   dívida (cópia do financeiro).
3. `0097-rollback.sql` + `0097-rollback.test.sql` (recusa se houver vínculo com o papel novo;
   devolve o `GRANT INSERT, UPDATE` de `0003:58` nas quatro tabelas).
4. Trava na rota: `POST /usuarios`, `POST /usuarios/:id/vinculos`,
   `PUT /usuarios/:id/vinculos/:vinculoId` e `PUT /usuarios/:id` (senha/nome/ativo de alvo
   com vínculo ativo de papel restrito — operador, block-005), 403 `PAPEL_RESTRITO` +
   auditoria `usuario_vinculo_negado`.
5. Seletor de papel sem os restritos para quem não é admin plataforma.
6. Nota da dívida no `CLAUDE.md` (seção de migrations do hub).
7. Testes: `hub-rbac-integration.sh` + `hub-papeis-integration.sh` + casos novos (quickstart F2.1–F2.6).

Ordem de deploy: backend (trava de rota) → migration 0097 (trava de banco + papel, na
mesma transação) → `SIGUSR1` → frontend_v2. Pré-requisitos do operador: confirmar que o
único `admin_plataforma` atual é quem deveria ser; avisar as 2 pessoas que perdem a
aprovação; 0 lote pendente no dia; fora da janela de fechamento; confirmar que, em
produção, `JWT_SECRET` (sessão, `routes/hub-auth.js:254`) e `PGRST_JWT_SECRET` (PostgREST,
`lib/hub-postgrest-jwt.js:123`) têm **valores diferentes** — o agente não acessa segredos
de produção; o REVOKE (S2) é defesa em profundidade sobre essa separação.

### F3 — Saldo mínimo carregado

1. Migration `0098_repasse_saldo_minimo.sql`: colunas (data-model), `CHECK` de conservação,
   `repasse_valor_minimo`; `hub_adiantamento_repasse_fechar` (de 0092) com saldo anterior,
   CTE `linhas` incluindo quem só tem saldo, regra de piso, D9, ordem estrita com advisory
   lock, `total = sum(valor_pago)`; `DROP`+`CREATE`+`GRANT` de `hub_adiantamento_repasse`
   (de 0088), `…_congelado` (de 0086), `…_repasse_motorista` (de 0088),
   `…_ultimo_fechado` (de 0086); `hub_adiantamento_configuracao_salvar` (de 0091) com o piso
   e a checagem de `pagamento_confirmar`.
2. `0098-rollback.sql` + `0098-rollback.test.sql` (recusa se houver saldo transportado pós-0098).
3. Driver `infra/hub/testes/hub-repasse-saldo-minimo.sh` + `sql/0098-saldo-minimo.test.sql`
   (9 casos + controles negativos, quickstart F3).
4. Backend: DTOs de `/repasse`, `/repasse/exportar` (3 colunas novas), `/configuracoes`,
   `/repasse/:periodo/fechar` (409 `APURACAO_FORA_DE_ORDEM`), `/repasse/:periodo/movimentos`
   (motivo `RETIDO`, soma dos componentes, lotes de 100), `/motorista/repasse`.
5. `planejarGeracao`: teste unit puro dos três casos (retido, pago com saldo, pré-regra).
6. Hub: colunas "Saldo anterior" e "A pagar", badge "Passou para a próxima semana" na
   coluna Observação existente; campo do piso no card "Repasse semanal".
7. App motorista: proposta de UI **precedida** do levantamento de onde cada número já
   aparece (repasse, home, movimento) — regra do `CLAUDE.md`.
8. Docs: Q-N4 em `docs/plans/adiantamento-motorista/PLANO.md:517` e o comentário "Negativo é só SINALIZADO" em
   `lib/adiantamento-remanescente.js:97-100`.
9. Migration `0099_apuracaorepassemovimento_insert_policy.sql`: correção de **defeito
   pré-existente da `0092`** (não pedida por nenhum FR desta spec — achado 4.6 da
   convergência) — `ApuracaoRepasseMovimento` tinha `ENABLE RLS` + `GRANT INSERT` **sem**
   policy de INSERT, então todo `POST /repasse/:periodo/movimentos` que gera nota falhava
   no INSERT da trilha (nota órfã + dedup nunca dispara). Precisa entrar antes do
   primeiro "Gerar notas" em produção; ver `RUNBOOK-DEPLOY.md`.

**Pré-condição operacional confirmada (block-006)**: o operador segura o botão "Fechar
apuração" em produção até a F3 estar implantada — ordem de deploy F1 → F2 → F3 mantida
rigorosamente. Não é uma trava de produto (não há requisito funcional para isso, FR-025a
cobre só o cálculo); é o operador controlando quando aciona o fechamento. Resolve
checklist `integridade-financeira.md` CHK021.

Recomendação de calendário (agora garantida pela pré-condição acima): F3 no ar **antes do
primeiro fechamento** (medido: 0 apurações fechadas; cada semana fechada antes da F3 é uma
semana sem transporte).

## Project Structure

### Documentation (this feature)

```
docs/specs/repasse-saldo-minimo/
├── spec.md
├── plan.md            # este arquivo
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── hub-repasse-api.md
    ├── hub-usuarios-trava.md
    └── motorista-repasse-api.md
docs/plans/repasse-saldo-minimo/
├── BRIEFING-AGENTE-00C.md
├── RUNBOOK-DEPLOY.md                        # runbook vigente (PR único, deploy único — block-010/dec-093)
└── RUNBOOK-DEPLOY-F1.md | -F2.md | -F3.md   # histórico por fase, não executar
```

### Source Code (paths reais tocados)

```
app_homologacao/backend/
├── routes/hub-adiantamentos.js          # F1, F3 (repasse, exportar, fechar, movimentos, configuracoes)
├── routes/hub-usuarios.js               # F2 (trava: :214, :325*, :397, :478)
├── routes/motorista-adiantamento.js     # F3 (GET /repasse :852)
├── lib/adiantamento-remanescente.js     # F1/F3 (CSV), F3 (comentário "Negativo é só SINALIZADO")
├── lib/adiantamento-geracao-movimento.js# F3 (planejarGeracao)
├── lib/<helper de lotes + PAPEIS_RESTRITOS>  # F1/F2 (nomes definidos no create-tasks)
└── tests/                               # unit node --test
app_homologacao/frontend_v2/
├── lib/hub/adiantamentos-api.ts         # tipos RepasseItem/Configuração
├── app/hub/dashboard/adiantamentos/repasse/page.tsx
├── app/hub/dashboard/adiantamentos/configuracoes/page.tsx
├── app/hub/dashboard/usuarios/page.tsx  # seletor de papel
└── components/hub/adiantamento-fechar-apuracao-dialog.tsx
app_homologacao/frontend_motorista/app/(app)/repasse/page.tsx
infra/hub/migrations/0097_papel_financeiro_aprovador.sql
infra/hub/migrations/0098_repasse_saldo_minimo.sql
infra/hub/migrations/0099_apuracaorepassemovimento_insert_policy.sql  # correção da 0092, ver F3 passo 9
infra/hub/testes/hub-repasse-saldo-minimo.sh
infra/hub/testes/hub-repasse-saldo-minimo-roundtrip-integration.sh
infra/hub/testes/hub-financeiro-aprovador-rbac-integration.sh
infra/hub/testes/hub-financeiro-aprovador-furo.sh
infra/hub/testes/sql/0097-*.sql, 0098-*.sql
```

**Structure Decision**: nenhuma camada nova. Lógica pura testável fica em `lib/` (padrão
do hub); regra de dinheiro e de permissão vive no banco (fonte da verdade) e é repetida na
rota só para mensagem clara e defesa em profundidade.

## Convenções de Borda

| Camada | Case style | Validação | Fonte da verdade |
|---|---|---|---|
| Colunas PostgreSQL / retorno de RPC | snake_case | `CHECK`, RLS, `RAISE EXCEPTION` com código | `infra/hub/migrations/0097_*.sql`, `0098_*.sql` |
| Backend DTO (Express) | camelCase | validação manual na rota (padrão existente) | `routes/hub-adiantamentos.js`, `routes/hub-usuarios.js`, `routes/motorista-adiantamento.js` |
| Frontend DTO (TS) | camelCase | tipos TS (sem Zod — padrão do projeto) | `frontend_v2/lib/hub/adiantamentos-api.ts`; tipos do app motorista |
| Payload API | camelCase; dinheiro como string `"0.00"` (padrão `dinheiro()`/`formatarCentavos`) | idem | `contracts/*.md` |
| Códigos de erro | `UPPER_SNAKE` em `{ erro }` | mapeamento `msg.includes(...)` na rota | `contracts/*.md` |
| URL | path params existentes (`:periodo` `YYYY-MM-DD`) | regex na rota | rotas existentes |
| CSV | rótulos em português, 1ª coluna `Identificador` | `serializarCsvRemanescente` (escape de injection existente) | `contracts/hub-repasse-api.md` |

**Mapper layer (DB ↔ DTO)**: manual, nas rotas (`rows.map(r => ({ entregadorId:
r.entregador_id, … }))`). Sem ORM.

## Riscos

| Risco | Mitigação |
|---|---|
| Partir de corpo antigo de função | Corpos vigentes fixados em research.md; reconferir com grep antes de escrever |
| F2 sem aprovador vinculado = só admin plataforma aprova | Medido: 1 admin plataforma com vínculo na empresa 6; atribuir o papel logo após o deploy |
| Duas pessoas perdem a aprovação (financeiro, admin_entidade) | Aviso do operador antes do deploy |
| Cabeçalho do CSV muda (F1, F3) | Aviso ao financeiro no PR |
| Fechamento concorrente de semanas consecutivas | Advisory lock transacional por empresa |
| Integração do adiantamento só passa aos domingos | Planejar a janela de verificação da F3 |
| Dívida: `financeiro_aprovador` é cópia do `financeiro` | Comentário na migration + nota no `CLAUDE.md` |

## Decisões do operador (block-005, respondido: ambos)

1. `PUT /usuarios/:id` entra na trava da F2 (research Decision 6).
2. `REVOKE INSERT, UPDATE` em `Papel/PapelPermissao/Permissao/Modulo` entra na migration
   0097 (research Decision 5).

## Revisão de segurança do desenho (gate owasp-security, 2026-09-26)

| # | Sev. | Categoria | Achado | Tratamento no plano |
|---|---|---|---|---|
| S1 | **high** | A01 / API5 (escalonamento) | `PUT /usuarios/:id` deixa `admin_entidade` trocar senha/desativar quem tem papel restrito → tomada da conta do aprovador/admin plataforma, contornando a trava de vínculo | F2: trava em `PUT /usuarios/:id` (block-005) + controle negativo F2.0 |
| S2 | **high** | A01 / A02 (privilégio de banco) | `Papel/PapelPermissao/Permissao/Modulo` com `INSERT, UPDATE` para `authenticated` e sem RLS (`0003:58`, `0006`) → pela camada de dados um `admin_entidade` se concede `pagamento_confirmar` | F2: `REVOKE` na 0097 (block-005). Exploração exige JWT do PostgREST (segredo só no backend), mas é o modelo de ameaça que FR-010/SC-004 exigem cobrir |
| S3 | medium | A10 (fail-closed) | Falha ao gravar a auditoria da negativa não pode virar permissão | Rota devolve 403 `PAPEL_RESTRITO` **antes/independente** do resultado de `registrarAuditoria` |
| S4 | medium | A01 (UPDATE silencioso) | `USING` reprovado → PATCH afeta 0 linhas sem erro | Rota confere a linha retornada; 0 linhas = recusa, nunca "sucesso" |
| S5 | medium | API1 (BOLA) | Saldo anterior no app do motorista | RPCs do motorista buscam saldo **só** dos `entregador_id` resolvidos pelas claims do motorista (mesmo filtro das RPCs vigentes); teste com 2 motoristas |
| S6 | low | A04/A06 (integridade de dinheiro) | Fechamentos concorrentes / fora de ordem | Advisory lock por empresa + `APURACAO_FORA_DE_ORDEM` + `CHECK` de conservação na tabela |
| S7 | low | A06 (abuso de configuração) | Piso alto demais retém todos indefinidamente | Escrita só por quem aprova (FR-026), versionada e auditada (`adiantamento.configuracao_alterada`); sem teto por decisão da spec (`> 0`) |
| S8 | low | A03 (injeção CSV) | Colunas novas no CSV | Reuso de `escaparCelulaCsvInjection` existente |

Sem achado `critical`. Os dois `high` são **anteriores** a esta feature e entram na F2
por decisão do operador (block-005).

## Re-check pós-design

Design não introduziu serviço, camada nem dependência nova. Colunas nuláveis (Decision 7)
e advisory lock (Decision 9) são o mínimo para FR-022 e FR-021. Princípios I–V seguem PASS.

## Complexity Tracking

Sem violações de constitution.
