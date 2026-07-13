# Research: Motorista canônico do hub + correções de navegação e filtros

Documento produzido no Phase 0 do `/plan`. Resolve os pontos técnicos abertos do
Technical Context antes do design. Cada decisão está ancorada em evidência verificada
no código em 2026-07-12. Não há `NEEDS CLARIFICATION` pendente — as 5 perguntas de
clarify foram integradas à spec e as decisões D-A0..D-C7 foram fechadas pelo operador.

## Decision 1: Correção do 404 de "Painel Geral" (WS-A / FR-001, FR-002)

**Decision**: adicionar caso especial em `moduloParaRota()`
(`app_homologacao/frontend_v2/lib/hub/module-nav.ts:104-105`): quando
`codigo === 'dashboard'`, retornar `/hub/dashboard` (a home real, 200); demais
códigos mantêm a convenção `/hub/dashboard/${codigo}`. Ajustar o cálculo de item
ativo (`pathname === moduloParaRota(codigo)`) para casar a home, e o card
"Painel Geral" da home (`app/hub/dashboard/page.tsx`), que também consome
`moduloParaRota`.

**Rationale**: evidência verificada — a função é convenção pura sem exceções, então
o módulo `dashboard` (tabela `Modulo`, `codigo='dashboard'`) gera hoje
`/hub/dashboard/dashboard`, rota inexistente (404). Dois consumidores são atingidos:
o item da sidebar (`components/hub/module-nav.tsx`) e o card da home. Correção
mínima, sem tocar o banco.

**Alternatives considered**: renomear `codigo` na tabela `Modulo` — rejeitada
(D-A0): quebraria RBAC/seeds/auditoria que referenciam `dashboard` sem nenhum ganho.

## Decision 2: Perfil em modal reusando o miolo da página (WS-A / FR-003..FR-005)

**Decision**: criar `components/hub/perfil-dialog.tsx` no idioma do
`motorista-detalhe-dialog.tsx` (hook `usePerfilDialog` + `Dialog` Base UI). Extrair
o conteúdo atual da página de perfil (`app/hub/dashboard/perfil/page.tsx` — exibe
`usuario.nome` + `usuario.email` de `/me` e ação "Trocar senha" via
`recuperarSenha(usuario.email)` → POST `/api/v1/auth/recuperar-senha`) para um
componente compartilhado `PerfilCard`. O item "Meu perfil" do `AccountMenu`
(`components/hub/account-menu.tsx`) passa a abrir o modal; a rota
`/hub/dashboard/perfil` **permanece viva** (D-A1, FR-005) renderizando o mesmo
`PerfilCard` (zero duplicação).

**Rationale**: a rota `/perfil` já responde 200 hoje; o pedido do operador é
eliminar a navegação, não remover a rota. Reusar o miolo garante que modal e página
mostrem exatamente a mesma informação e a mesma ação de troca de senha, com feedback
de sucesso/erro (FR-004).

**Alternatives considered**: remover a rota `/perfil` e deixar só o modal —
rejeitada: quebraria deep-links e o fallback de FR-005.

## Decision 3: Busca de entregador server-side por nome (WS-B / FR-006..FR-010)

**Decision**: dois endpoints aditivos —
`GET /api/v1/faturamento/entregadores?busca=<termo>` (gate `faturamento.listar`) e
`GET /api/v1/performance/entregadores?busca=<termo>` (gate `performance.listar`).
Validar `termo` com `termoBuscaValido` (`lib/hub-motoristas-similaridade.js:90`,
mínimo 3 caracteres); filtrar por `ILIKE` sobre `hub_normaliza_nome(nome)` (SQL
IMMUTABLE, migration 0021, com índice trgm), escopo `id_empresa` via
`resolverContextoEntidade`; limite **20**; retorno `{ items: [{ id, nome }] }`. No
front, `entregador-combobox.tsx` compartilhado (Popover + Command, idioma do
`EntidadeCombobox` do admin), debounce **300 ms**, estados: digitando <3 caracteres,
carregando, vazio, erro. O item selecionado exibe o **nome** e envia `entregadorId`.

**Rationale**: a infra de busca por nome já existe (`unaccent` + `pg_trgm`,
`hub_normaliza_nome()`, índice trgm em `ContaMotorista`; `Entregador` tem índice
`(id_empresa, nome)` na 0010). O backend do faturamento já usa filtros PostgREST
(`entregador_id=eq.${f.entregadorId}` em `routes/hub-faturamento.js:109`), então o
novo endpoint é aditivo e não altera o filtro existente. Escopo por empresa satisfaz
o Princípio II e FR-007; limite 20 satisfaz FR-007.

**Alternatives considered**: busca client-side (carregar todos e filtrar no browser)
— rejeitada: não escala e vaza entregadores de outras empresas. Fallback em input de
texto livre por nome em caso de 5xx — rejeitada (D-B1): degrada para o **input
numérico atual** (menor superfície), preservando o comportamento existente (FR-010).

## Decision 4: Motorista canônico = `Entregador`, sem tabela nova (WS-C / FR-011..FR-016)

**Decision**: promover a entidade `Entregador` (hub, migration 0010) a motorista
canônico. Seu `id_externo uuid` (o uuid da planilha de performance/faturamento) é a
chave imutável de correlação de todas as atividades, único por empresa (constraint
`UNIQUE (id_empresa, id_externo)` já existe). Expor `idExterno` (uuid) em
`mapMotoristaListItem`/`mapMotoristaDetalhe` (DTOs em
`hub-motoristas.js:46-48`), visível e copiável na lista e no detalhe (FR-016).
`ContaMotorista` (migration 0021) passa a ser a **credencial de acesso** do
motorista, sempre subordinada ao `Entregador` (FK física + índice único parcial já
existem).

**Rationale**: reuso de infra existente (constraint de unicidade por empresa, FK
`Entregador.motorista_id → ContaMotorista`), atendendo FR-011/FR-013/FR-016 sem DDL
estrutural em `Entregador`. Correlação sempre e só por uuid (FR-014).

**Alternatives considered**: criar tabela `motorista_canonico` nova — rejeitada
(D-C0): duplicaria a dimensão `Entregador`, exigiria migração de dados e sync,
aumentando risco sem ganho.

## Decision 5: Cadastro manual com uuid obrigatório + 409 amigável (WS-C / FR-012..FR-014)

**Decision**: `POST /api/v1/motoristas` cria um `Entregador` com `nome` +
`id_externo` **informado obrigatoriamente** (D-C6). Validar formato com `uuidValido`
(`lib/hub-import-normalizer.js:233`); mapear a violação de
`UNIQUE (id_empresa, id_externo)` para **HTTP 409** com mensagem clara ("uuid já em
uso nesta empresa"); formato inválido → **HTTP 422/400** com motivo. Sem geração
automática de uuid; sem merge automático por nome — importação
(`lib/hub-import-processor.js`, upsert `on_conflict=id_empresa,id_externo`) casa
sempre e só por uuid (FR-014). Uma planilha cujo uuid ainda não existe no cadastro
registra a atividade normalmente e fica sem correlação até o motorista ser cadastrado
(clarify Q4 / edge case).

**Rationale**: o uuid vem da planilha; exigi-lo elimina duplicidade e desencontro
(FR-004/SC-004). A constraint existente já garante a unicidade — o backend só precisa
traduzir o erro para uma resposta amigável.

**Alternatives considered**: gerar uuid no cadastro manual — rejeitada (D-C6, fechada
pelo operador): quebraria a correlação com a planilha.

## Decision 6: Credencial de acesso com senha bcrypt no `ContaMotorista` (WS-C / FR-017..FR-020)

**Decision**: migration 0042 adiciona `ContaMotorista.senha text NULL` (D-C5, bcrypt).
Endpoints: `POST /motoristas/:id/credencial` (criar conta+senha inicial/reset por
token, ou vincular conta existente), `POST /motoristas/:id/credencial/reset-senha`
(invalida a senha anterior imediatamente — FR-019), `PATCH /motoristas/:id/credencial`
(ativar/desativar). **Duas permissões granulares separadas** (clarify Q1, FR-020):
reusar a existente **`motoristas.editar`** para cadastro/edição de motorista, e criar
uma **nova `motoristas.credencial`** para as ações de credencial (seed aditivo,
migration 0043). Um usuário pode ter uma sem a outra. Leitura (lista/detalhe/atividades)
**não** exige essas permissões — usa `motoristas.consultar`/`motoristas.listar`, no
mesmo nível das telas de faturamento/performance (qualquer usuário autenticado da
empresa). A situação (ativo/inativo) do motorista é **independente** do status da
credencial (clarify Q3, FR-015/FR-018): inativar motorista NÃO desativa a credencial.

**Rationale**: as permissões `motoristas.listar/consultar/editar` já existem em
`hub-motoristas.js`; só falta a de credencial. bcrypt + reset por token espelha o
legado (`app/dashboard/motoristas/page.tsx`), satisfazendo o Princípio I. A
independência situação↔credencial reproduz as ações independentes da tela legada.

**Alternatives considered**: permissão única para motorista+credencial — rejeitada
(clarify Q1, fechada): o operador exigiu duas permissões granulares independentes.
Nova permissão `motoristas.criar` distinta de `motoristas.editar` (proposta D-C1) —
reconciliada: reusar `motoristas.editar` para criar+editar reduz seeds novos e mantém
o mapeamento "duas permissões" (cadastro/edição vs. credencial) exigido pelo clarify.

## Decision 7: uuid nas atividades do app motorista — aditivo e inerte em produção (WS-C / FR-022, FR-022A, FR-023)

**Decision**: o login do app motorista (`routes/motorista.js`) resolve e embute
`entregador_uuid` no token (cnpj → `ContaMotorista` → `Entregador` vinculado). Novas
gravações de atividade (validação de NF, gorjeta, etc. em `server.js` /
`routes/motorista.js`) registram o uuid junto às chaves atuais — **aditivo**: coluna
`entregador_uuid uuid NULL` onde fizer sentido, sem reescrever chaves existentes (cnpj
continua funcionando). Toda mudança nas rotas legadas fica **atrás de condição de
ambiente** que, sem env nova definida, é inerte em produção — mesmo espírito do
`lib/envio-gate.js` (produção sem `ENVIO_*`/env nova = comportamento byte-a-byte
idêntico). No hub, a seção "Atividades" do detalhe correlaciona por uuid
(faturamento, performance, validações recentes), read-only (D-C7, FR-022), ordenada
da mais recente para a mais antiga, sem limite fixo de período/quantidade (clarify Q5)
— **paginação técnica** por cursor/offset definida na implementação.

**Rationale**: FR-023/SC-007 exigem produção inalterada; o padrão do `envio-gate.js`
já é a referência aprovada (issue #62) para mudança aditiva inerte em produção. A
migration/coluna de atividade só é aplicada no `hub_homolog_db` (D-C3).

**Alternatives considered**: reescrever as chaves de atividade existentes para uuid —
rejeitada (D-C2): quebraria produção e o histórico legado (edge case: dados
pré-feature continuam visíveis pelos caminhos atuais, sem reconstrução retroativa).

## Decision 8: DDL só no hub_homolog_db, migrations 0042+ idempotentes (WS-C / FR-023, Constitution V)

**Decision**: novas migrations `0042_conta_motorista_senha.sql` e
`0043_seed_permissao_motoristas_credencial.sql` (numeração após a última existente,
`0041`), idempotentes (`ADD COLUMN IF NOT EXISTS`; seed protegido por
`WHERE NOT EXISTS`/`ON CONFLICT DO NOTHING`), aplicadas **apenas** no `hub_homolog_db`
via `infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml` (registra
`SchemaMigration` + envia SIGUSR1 ao PostgREST). A coluna de atividade
(`entregador_uuid`) segue o mesmo padrão idempotente.

**Rationale**: paridade com todas as migrations do hub (0021, 0041 etc.), que são
idempotentes e restritas ao hub. Cutover para produção é decisão futura do operador
com rito de 5 gates — fora do escopo desta feature.

**Alternatives considered**: aplicar DDL diretamente / em produção — rejeitada
(cláusula pétrea + D-C3): proibido.

## Segurança — resultado do gate OWASP (Phase 0, mandatos para create-tasks)

Gate `owasp-security` sobre a arquitetura proposta (OWASP Top 10:2025 / API
Security Top 10:2023 / ASVS 5.0). **Resultado: PASS** — nenhum finding
critical/high; 4 mandatos de hardening (medium/low) a carregar para as tasks. O
desenho já se apoia em padrões seguros existentes; os mandatos abaixo são
condições de aceitação de código, não bloqueios de plano.

| # | Categoria | Finding | Severidade | Mandato para execute-task |
|---|-----------|---------|-----------|---------------------------|
| S1 | A05 Injection / A03 SQL | Busca de entregador por nome (WS-B) recebe termo livre | LOW (padrão seguro já existe) | **Reusar o padrão parametrizado do codebase**: RPC no banco (estilo `hub_motoristas_busca`, migration 0023, que recebe `p_termo` como parâmetro) OU filtro PostgREST com `encodeURIComponent(termo)` via `hubPostgrestRequest`. NUNCA concatenar o termo cru em querystring/SQL. `termoBuscaValido` só valida tamanho (≥3), não sanitiza — a segurança vem da parametrização. |
| S2 | API3 BOPLA / Mass assignment | `POST /motoristas` e endpoints de credencial recebem JSON do cliente | MEDIUM | **Allowlist explícita do body** (espelhar `validarPatchMotorista`): aceitar só `nome` + `idExterno` no cadastro; `id_empresa` SEMPRE do contexto do token (`resolverContextoEntidade`), nunca do body; NUNCA aceitar `ativo`/`motorista_id`/`id` do cliente. Credencial: só `cnpj_prestador`/`senha_inicial`/`ativo` conforme o endpoint. |
| S3 | A07 Auth / A04 Crypto | Credencial bcrypt + reset por token; login do app motorista alterado | LOW | bcrypt **cost ≥ 12**; token de reset **single-use + expiração curta + alta entropia**; `senha` nunca retornada em DTO/SELECT de leitura (já garantido em data-model). Preservar `rate-limit` + `trust proxy` no login do app motorista (histórico do incidente 429/trust-proxy) ao embutir o `entregador_uuid`. |
| S4 | A09 Logging | `registrarAuditoria` em todas as escritas | LOW | Auditoria registra quem/quando/ação (FR-021) mas **nunca** o valor da senha nem o token de reset. Erros mapeados (409/422) sem vazar internals (A10); 404-fora-do-escopo evita enumeração cross-tenant. |

**A01/API1 BOLA (multi-tenant)**: PASS — todo endpoint (leitura e escrita) escopa
por `id_empresa` via `resolverContextoEntidade`, deny-by-default com
`requirePermission`, 404-fora-do-escopo (Decision 11 S5). uuid único **por empresa**
(constraint `(id_empresa, id_externo)`) → o 409 de duplicidade não vaza uuid de outra
empresa. Duas permissões granulares (`motoristas.editar` vs `motoristas.credencial`),
leitura separada da escrita — satisfaz o Princípio II e FR-020.

**A08 Integrity (rotas legadas inertes)**: PASS — o padrão env-condicional do
`lib/envio-gate.js` é fail-safe por default (sem env nova = comportamento de produção
idêntico, byte-a-byte); FR-023/SC-007 preservados.

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| `reconcile-wave` promover `concluida` cedo em fases multi-tarefa (execute→review) | Verificar entregáveis reais (arquivos + testes verdes) antes de avançar o ponteiro; guardar o ponteiro após cada onda (gotcha de memória do projeto). |
| review-task confabular/estagnar em haiku | review-task **nunca** em haiku (4 overrides históricos). |
| Build pesado derrubar o Swarm (starvation) | Rebuild só sob rito anti-starvation (swap conferido, `--memory=2g`, `DOCKER_BUILDKIT=0`). |
| Mudança em `routes/motorista.js`/`server.js` vazar para produção | Toda mudança atrás de condição de ambiente inerte (padrão `envio-gate.js`); E2E confirma `bloqueado`/inércia; nenhuma env nova em serviço de produção. |
| Nome do arquivo de DTO de motorista não confirmado | Confirmar o path exato do `require` em `hub-motoristas.js:46-48` no início do WS-C. |
