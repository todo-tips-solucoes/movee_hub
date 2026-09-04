# Contract: Vínculo automático de credencial (FR-009..FR-012)

Não é uma interface HTTP externa nova — é uma extensão de comportamento
**interna** a um handler já existente, mais um script de backfill único.
Documentado aqui (não em `data-model.md`) porque tem contrato de
entrada/saída próprio (idempotência, casos de erro).

## Extensão: POST /motorista/register (já existente, comportamento novo)

`app_homologacao/backend/routes/motorista.js:372` — **request/response
inalterados** (continua `{ cnpjPrestador, nome, senha }` → 201/400/409/500,
mesmas mensagens anti-enumeração). Efeito colateral novo, best-effort, após
o `PATCH` de ativação (linha 411-421) ter sucesso:

1. Buscar `ContaMotorista` por `cnpj_prestador = cnpjNorm` via
   `hubPostgrestRequest` (`lib/hub-postgrest.js`).
2. Se não existir: criar (`POST ContaMotorista`, mesmos campos do fluxo
   manual em `routes/hub-motoristas.js:1024` — `cnpj_prestador`, `nome`,
   `ativo: true`; **sem** `senha` própria do hub — a credencial de acesso
   ao hub e a credencial do app motorista são o mesmo conceito de "conta
   vinculada" já usado hoje pelo card "Vincular", que só referencia, não
   duplica senha).
3. **Idempotência (FR-011)**: se já existe `Entregador.motorista_id`
   apontando para essa `ContaMotorista` (join reverso), não fazer nada.
4. Buscar candidatos `Entregador` por **similaridade de nome** — RPC nova
   `hub_motoristas_candidatos_por_conta(p_conta_motorista_id)` `[PROPOSTA]`,
   simétrica à já existente `hub_motoristas_candidatos(p_entregador_id)`
   (migration 0023), mesmo `hub_normaliza_nome`/`pg_trgm`/escopo
   `EmpresaGrupoMovee` (research.md Decision 12). **`Entregador` não tem
   coluna de CNPJ** — o casamento nunca é por CNPJ, só por nome.
5. Vincula automaticamente **somente** quando há exatamente 1 candidato
   com `similaridade >= 0.9` (limiar mais estrito que o 0.3 usado nas
   "sugestões" para revisão humana — research.md Decision 12): `PATCH
   Entregador.motorista_id`. Em qualquer outro caso (0 candidatos,
   múltiplos acima do limiar, ou único candidato abaixo de 0.9): **não
   vincula automaticamente** (Acceptance Scenario 3 da User Story 1 — "não
   vincula silenciosamente a um motorista errado"), fica disponível para
   vínculo manual (`Vincular`/`Criar credencial`, já existentes, que usam
   o limiar 0.3 para sugerir candidatos a um humano escolher).

**Falha não bloqueia o cadastro**: se a etapa hub (2-4) falhar (rede,
PostgREST fora do ar), a resposta 201 do `/register` já foi decidida pelo
sucesso do PATCH legado (passo 1) — o efeito colateral roda em
`try/catch` isolado, logado, sem propagar erro 500 para o motorista que só
queria criar a senha dele. Consequência: a **retomada** de um vínculo que
falhou aqui é coberta pelo mesmo backfill do item abaixo (idempotente, pode
rodar de novo sem duplicar).

**Auditoria (gate `owasp-security`, achado A09)**: passo 5, quando vincula
com sucesso, MUST chamar `registrarAuditoria()` (`lib/hub-auditoria.js`,
já existente — mesma função usada por `DELETE /:id/vinculo`, linha 879 de
`hub-motoristas.js`), com `acao: 'motorista.vinculado_automaticamente'`,
`recurso: 'Entregador'`, `recursoId: <id>`,
`detalhes: { contaMotoristaId, similaridade }` — **sem** `usuarioId` humano
(ação do sistema, não de um usuário logado; `claims` reflete o contexto de
serviço). Nenhum mecanismo de auditoria novo — reuso do já existente.

**Reversão de falso positivo (gate `owasp-security`, achado A06 — risco
residual de similaridade)**: mesmo a 0.9 + candidato único, um vínculo
automático errado é possível (nomes muito parecidos). O endpoint
`DELETE /:id/vinculo` **já existe** (idempotente, já audita
`motorista.desvinculado`) e é a via de correção — nenhum endpoint novo
necessário. `create-tasks` MUST garantir que a UI já exibe esse botão
mesmo para vínculos com `vinculoCredencialAutomatico: true` (não é um caso
especial — reusa a ação "Vincular"/desvincular já existente).

## Script: backfill retroativo único (FR-012, US1)

**Não é rota HTTP.** Script standalone (`infra/hub/scripts/` ou
`app_homologacao/backend/scripts/`, exato TBD em `create-tasks`), aplicado
manualmente pelo operador (rito de produção, CLAUDE.md — esta pipeline
nunca escreve em produção).

### Entrada

Nenhuma (lê `Motorista` legado inteiro via PostgREST).

### Comportamento

```
PARA CADA linha em Motorista WHERE senha IS NOT NULL:
  reusa a MESMA lógica dos passos 1-4 acima (função compartilhada,
  não duplicada)
REPORTA: total processado, total vinculado, total sem candidato único
  (para revisão manual via Vincular/Criar credencial)
```

**Idempotente**: reexecutar é seguro — passo 3 já checa vínculo existente
antes de agir.

### Saída (relatório em stdout, não persistido em tabela nova)

| Campo | Description |
|-------|-------------|
| totalProcessados | linhas de `Motorista` com `senha` preenchida |
| totalVinculados | novos `Entregador.motorista_id` setados |
| totalAmbiguos | 0 ou >1 candidato — ficam para vínculo manual |
