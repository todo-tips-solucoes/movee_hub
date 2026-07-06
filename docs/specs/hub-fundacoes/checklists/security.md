# Security Checklist: Fundações — Contas, Papéis e Trilha de Auditoria do Hub

**Purpose**: Unit tests para os REQUISITOS (não a implementação) da feature `hub-fundacoes` — qualidade, clareza, consistência e completude de auth, RBAC, auditoria e isolamento multi-tenant.
**Created**: 2026-07-05
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [data-model.md](../data-model.md) · [contracts/](../contracts/)
**Domain**: security (+ requirements)
**Gate**: pré-`create-tasks` (onda-004)

## Completude de Requisitos

- [x] CHK001 - Os requisitos de migração de login cobrem todas as origens de conta e suas exclusões? [Completude, Spec §FR-001–005] {auto} — cobertos: contas ativas migradas (FR-001), vínculo à mesma entidade (FR-002), fluxo legado preservado (FR-003), operação segura/idempotente (FR-004), exclusão de contas sem meio de autenticar (FR-005) + Edge Case correspondente.
- [x] CHK002 - Os requisitos de RBAC (papéis, permissões nomeadas, troca de entidade) estão definidos? [Completude, Spec §FR-006–013] {auto} — papéis multi (FR-006), matriz capacidade×ação (FR-007), ≥4 papéis seed (FR-008), resolução de múltiplos papéis (FR-009), troca de entidade (FR-010/011), auditoria de ação (FR-012), reflexão de mudança (FR-013); entidades em data-model (`Papel`/`Permissao`/`PapelPermissao`/`Modulo`).
- [x] CHK003 - Os requisitos de autenticação e proteção de conta estão completos? [Completude, Spec §FR-014–022] {auto} — login e-mail/senha (FR-014), anti-enumeração (FR-015), rate-limit (FR-016), bloqueio temporário (FR-017), logout revoga sessão (FR-018), recuperação (FR-019), resposta idêntica (FR-020), token com expiração (FR-021), revogação total no reset (FR-022).
- [x] CHK004 - Os requisitos de auditoria estão definidos (o quê registrar, imutabilidade, proteção de dados)? [Completude, Spec §FR-023–025] {auto} — registrar todo login sucesso/falha (FR-023), imutabilidade após gravação (FR-024), sem dados sensíveis em texto aberto (FR-025); contrato GET /api/v1/auditoria.
- [x] CHK005 - Os requisitos de isolamento entre entidades (defesa em profundidade) estão especificados quanto a cobertura e postura de falha? [Completude, Spec §FR-026–028] {auto} — reforço além de FR-012 (FR-026), cobre dados NOVOS da fundação (FR-027), postura nega-por-padrão quando entidade ausente/inverificável (FR-028).
- [x] CHK006 - Os quatro papéis-seed obrigatórios estão definidos com escopo? [Completude, Spec §FR-008, data-model §Papel] {auto} — `is_sistema=true` marca os 4 papéis obrigatórios; escopo `global`/`entidade`; módulos enumerados (`atendimento, performance, importacoes, envio_massa, usuarios, auditoria, admin`).

## Clareza e Quantificação

- [x] CHK007 - O bloqueio de conta por tentativas está quantificado (nº de falhas e janela)? [Clareza, Spec §FR-017/SC-006] {auto} — 5 falhas consecutivas / 15 min; data-model `bloqueado_ate = now() + 15min` na 5ª falha.
- [x] CHK008 - A reflexão de mudança de papel/vínculo está quantificada temporalmente? [Clareza, Spec §SC-004/FR-013] {auto} — ≤60 s; plan define cache RBAC in-memory com TTL 60 s.
- [x] CHK009 - As janelas de expiração de sessão (access/refresh) estão quantificadas? [Clareza, Plan §Constitution I] {auto} — access 15 min / refresh 7 dias, cookies `httpOnly` `sameSite=Strict`.
- [ ] CHK010 - A expiração do token de recuperação de senha está quantificada com valor concreto? [Ambiguity, Spec §FR-021] {auto} — **GAP**: FR-021 diz apenas "tempo limitado"; `data-model.token_recuperacao_expira` não tem valor; research Decision 9 descreve o mecanismo (hash-only/single-use) mas NÃO fixa duração. Destino: `/create-tasks` (definir TTL concreto na task de recuperar-senha) ou `/clarify`.
- [x] CHK011 - O limite de taxa por origem (FR-016) teve sua indefinição resolvida? [Clareza, Spec §Clarifications] {auto} — resolvido no clarify (score 2): threshold por origem é decisão de implementação (reusa `express-rate-limit` de `server.js:83`); a spec quantifica apenas o bloqueio por conta (FR-017); rate-limit também estendido a `recuperar-senha` (research Decision 14).
- [x] CHK012 - A postura "nega por padrão" está definida sem ambiguidade para claim de entidade ausente/inverificável? [Clareza, Spec §FR-028] {auto} — clarify score 3: nega sempre que a entidade não for presente/verificável; risco de quebra eliminado porque cobre só dados novos (expand-only).

## Consistência de Requisitos

- [x] CHK013 - A resposta anti-enumeração é consistente entre login e recuperação de senha? [Consistência, Spec §FR-015 ↔ §FR-020] {auto} — ambas exigem resposta indistinguível/idêntica; contract auth.md formaliza `CREDENCIAIS_INVALIDAS` idêntico e resposta única de recuperação.
- [x] CHK014 - A imutabilidade da auditoria é consistente entre camada de aplicação e camada de dados? [Consistência, Spec §FR-024, block-001] {auto} — nenhum endpoint expõe edição/remoção + `REVOKE UPDATE,DELETE` ao role do PostgREST + trigger bloqueador (data-model); coerente com nega-por-padrão (defesa em profundidade).
- [x] CHK015 - O RLS é descrito como reforço adicional e não substituto da checagem de permissão (FR-012)? [Consistência, Spec §FR-026, Plan §Constitution II] {auto} — FR-026 é "além da verificação de permissão"; plan afirma RLS não substitui `requirePermission`; escopo resolvido server-side a partir do token.

## Qualidade dos Critérios de Aceite

- [x] CHK016 - Cada User Story tem Independent Test e Acceptance Scenarios verificáveis? [Mensurabilidade, Spec §User Stories 1–5] {auto} — as 5 US têm Independent Test + Acceptance Scenarios em formato Given/When/Then.
- [x] CHK017 - Os Success Criteria são objetivamente mensuráveis? [Mensurabilidade, Spec §SC-001–009] {auto} — usam alvos verificáveis: 100% das contas (SC-001), ≤60 s (SC-004), 5 falhas/15 min (SC-006), 100% sessões revogadas (SC-007), zero linhas cross-entidade (SC-008), 100% eventos disponíveis (SC-009).

## Cobertura de Cenários e Edge Cases

- [x] CHK018 - A idempotência da migração está especificada e testável? [Cobertura, Spec §FR-004/SC-002, Edge Cases] {auto} — repetir a operação não duplica nem re-executa efeitos; cada conta de origem gera no máximo uma conta no hub.
- [x] CHK019 - O comportamento para conta sem senha e para pessoa sem vínculo ativo está definido? [Edge Case, Spec §FR-005, Edge Cases] {auto} — conta sem senha não vira conta utilizável (não cria conta "quebrada"); autenticar sem vínculo não concede acesso a nada.
- [x] CHK020 - A perda de vínculo com sessão aberta reflete na próxima ação sensível? [Edge Case, Spec §FR-013, Edge Cases] {auto} — desativar o único vínculo ativo reflete na próxima ação sensível (não só no próximo login); coerente com teto ≤60 s (SC-004).
- [x] CHK021 - Pedidos de recuperação repetidos e falha do serviço de e-mail estão cobertos? [Edge Case, Spec §Edge Cases, Research Decision 11] {auto} — apenas o pedido mais recente é válido (sobrescreve o anterior); falha de e-mail não vaza existência de conta; mock de e-mail para teste (Decision 11).
- [x] CHK022 - A revogação de todas as sessões após redefinição de senha está especificada e testável? [Cobertura, Spec §FR-022/SC-007, Quickstart Scenario 8] {auto} — reset invalida todas as sessões anteriores; quickstart Scenario 8 valida resposta idêntica + sessões revogadas.

## Requisitos Não-Funcionais de Segurança

- [x] CHK023 - Segredos e algoritmo de assinatura de token estão especificados (sem hardcode, alg-pinning)? [NFR-Security, Plan §Constitution I, Research owasp] {auto} — segredos em `/var/lib/hub_secrets` (fora do git); remediação owasp: alg-pinning JWT HS256 explícito.
- [x] CHK024 - A não-exposição de senhas está especificada (hash preservado, nunca texto aberto)? [NFR-Security, Plan §Constitution I, Spec §FR-025] {auto} — senhas em `bcrypt` com hash copiado da migração (ninguém troca senha); tokens armazenados hash-only sha256 (Decision 9); auditoria sem dados sensíveis (FR-025).

## Dependências e Premissas

- [x] CHK025 - Os limites de escopo (o que fica de fora) estão explicitados? [Assumption, Spec §Clarifications] {auto} — fora: base de login do app de entregadores, criação/convite de novos usuários (S3+), MFA/SSO; evolução expand-only; migração cobre só login do painel.
- [x] CHK026 - As premissas de ambiente e localização das migrations estão documentadas? [Assumption, Research §Decision 1] {auto} — ambiente isolado do hub (S1) como base; migrations em `infra/hub/migrations/` (0002–0007), não em `app_homologacao/backend/db/`; aplicadas por `infra/hub/scripts/migrate.sh` (idempotente/2×=no-op).
- [ ] CHK027 - O conjunto de 4 papéis-seed e seus mapeamentos de permissão default refletem o modelo de acesso pretendido pelo negócio? [Risco, Spec §FR-008] {humano} — a EXISTÊNCIA e estrutura estão definidas (CHK006); se os 4 papéis concretos e suas permissões default correspondem ao apetite/organização do produto é julgamento do dono do produto, a validar antes de `execute-task`.

## Notes

- Items `{auto}` já resolvidos pelo agente (`[x]` com citação da evidência, ou marcador `[Ambiguity]`/`[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- Rastreabilidade: 27/27 items com referência (100%).

## Resolução

- **{auto} resolvidos**: 25 (`[x]` com evidência citada)
- **{humano} aguardando decisão**: 1 (CHK027)
- **Gaps/Ambiguidades abertos**: 1 (CHK010 — TTL do token de recuperação não quantificado)

## Follow-up obrigatório (gaps viram ação)

| Item | Marcador | Destino |
|------|----------|---------|
| CHK010 | [Ambiguity] | `/create-tasks` — a task de recuperar-senha DEVE fixar um TTL concreto para `token_recuperacao_expira` (ou `/clarify` se for decisão de negócio) |
| CHK027 | {humano} | dono do produto valida os 4 papéis-seed + permissões default antes de `/execute-task` |

Gate: **PASSA** para `create-tasks`. Os 2 items abertos não bloqueiam a decomposição — CHK010 vira tarefa explícita de definição de TTL; CHK027 é validação de negócio paralela.
