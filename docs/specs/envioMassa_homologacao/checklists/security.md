# SECURITY Checklist: Notificações push no app do motorista

**Purpose**: validar a qualidade dos requisitos de segurança — autenticação/escopo,
segredos, cobertura testável dos 10 achados do gate `owasp-security` (onda-006), rate
limit, privacidade e auditoria. Não repete o gate: verifica se os achados já viraram
requisito/mitigação verificável, não reexecuta a revisão de superfície de ataque.
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md), [plan.md](../plan.md) §Achados do gate owasp-security

## Autenticação e Escopo

- [x] CHK001 - O vínculo da inscrição de push ao motorista da sessão (ignorando
  identificador do corpo/query) está expresso como MUST com cenário de teste associado?
  [Completude/Mensurabilidade, Spec §FR-003, Acceptance Scenario US1.3] {auto}
- [x] CHK002 - O critério de escopo do grupo Movee (`mesmoGrupoQue(idEmpresa,6,cache)`,
  nunca `id_empresa===6` estrito) está aplicado de forma consistente em todos os pontos
  de decisão citados no plan, inclusive no modo `toda_base` que não tem coluna de
  empresa nativa? [Consistência, Spec §FR-015/FR-016, Plan §S4] {auto}
- [x] CHK003 - A recusa por falta de permissão dedicada ou escopo fora do grupo Movee é
  exigida tanto pela rota HTTP quanto citada como cenário de teste explícito (chamada
  direta ao servidor)? [Cobertura, Spec §FR-014, Acceptance Scenarios US2.2/US2.3] {auto}

## Segredos e chave VAPID

- [x] CHK004 - Existe requisito explícito proibindo a chave privada VAPID em log,
  resposta de API, bundle e imagem, com teste de varredura associado antes da entrega?
  [Completude/Mensurabilidade, Spec §FR-025, SC-009, Plan Quickstart 19] {auto}
- [x] CHK005 - O comportamento de chave ausente/inválida (recusa com mensagem clara,
  nunca "em andamento" silencioso) está coberto tanto no fluxo normal de disparo quanto
  no edge case de rotação de chave? [Cobertura de Edge Case, Spec §Edge Cases, FR-025/
  FR-026] {auto}

## Achados do gate owasp-security como requisitos testáveis

- [x] CHK006 - Cada um dos 10 achados (S1-S10) tem, na coluna Mitigação, uma ação de
  código verificável (REVOKE, validação de bytes, resolução de URL, filtro de conta,
  etc.), não apenas uma descrição do risco? [Mensurabilidade, Plan §Achados] {auto}
- [x] CHK007 - Os achados que citam cenário de teste explícito no texto da mitigação
  (S1: chamada `/rpc/` sem JWT; S3: lista de inputs `//x`/`/\x`/TAB/LF/`javascript:`;
  S4: conta só com `Entregador` fora do grupo; S5: teste de unidade das demais rotas)
  descrevem entrada→saída esperada de forma executável? [Mensurabilidade, Plan §S1/S3/
  S4/S5] {auto}
- [ ] CHK008 - Os achados S6 (allowlist SSRF), S7 (Unicode bidi), S8 (rate limit de
  alcance/busca), S9 (log de recusa/transferência) e S10 (claims do worker) não citam
  cenário de teste explícito na coluna Mitigação — só descrevem a correção de código.
  [Gap, Plan §S6-S10] — recomendar que `create-tasks` associe um teste a cada um desses
  5 achados, não apenas a mudança de código. {auto}
- [x] CHK009 - O teto de inscrições por CNPJ do achado S2 foi confirmado pelo operador em
  10, removendo a mais antiga por `atualizado_em` (dec-043/block-004). [Ambiguity
  resolvida, Plan §S2] {auto}

## Rate limiting e abuso

- [x] CHK010 - Os dois limites de taxa declarados (30/15min por `cnpjPrestador` no app
  motorista, 10/15min por usuário no disparo do hub) estão associados a um requisito
  funcional e a uma resposta de erro sem efeito colateral? [Completude, Spec §FR-027,
  Plan §NFRs Abuso, Contracts motorista-push.md§Convenções, hub-avisos.md POST] {auto}
- [ ] CHK011 - `GET /api/v1/avisos/alcance` e a busca de motoristas/destinatários
  (achado S8) não têm limite de taxa refletido em nenhum FR da spec — `FR-027` cobre só
  "registro de inscrição e disparo de aviso". [Gap, Spec §FR-027, Plan §S8] —
  recomendar ampliar o FR ou garantir que a tarefa do S8 fique rastreável mesmo sem FR
  correspondente. {auto}

## Privacidade e dado pessoal

- [x] CHK012 - O requisito de payload do push sem PII está quantificado com a lista
  exata de campos permitidos (`avisoId`, `titulo`, `corpo`), não apenas "sem dado
  pessoal" de forma vaga? [Clareza, Spec §FR-012, Contracts motorista-push.md§Payload]
  {auto}
- [x] CHK013 - O alerta de que o texto trafega por serviço de terceiro (tela de
  criação) está definido como requisito funcional testável, não apenas nota de UX solta?
  [Mensurabilidade, Spec §FR-021] {auto}

## Auditoria

- [x] CHK014 - O conflito entre a retenção de 90 dias dos dados novos e os 12 meses já
  existentes na trilha de auditoria do hub tem uma regra de desempate explícita para o
  caso em que ambos se aplicam (registro de auditoria gravado na trilha existente), sem
  deixar a decisão implícita? [Consistência, Spec §FR-030] {auto}
- [x] CHK015 - Toda ação de auditoria (criação, disparo, rotação de chave) tem os
  4 campos mínimos (autor, momento, aviso, escopo de destinatários) confirmados tanto na
  spec quanto na tabela de NFRs do plan? [Consistência, Spec §FR-029, Plan §NFRs
  Observabilidade] {auto}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto.
- **Resolução**: 13 `{auto}` resolvidos (`[x]`), 2 `[Gap]` abertos (CHK008, CHK011),
  0 `{humano}` pendente — CHK009 resolvido nesta onda (dec-043/block-004).
