# Security Checklist: migrar-cnpj-motorista

**Purpose**: Validar a qualidade dos requisitos de segurança — isolamento multi-tenant, gate de grupo, IDOR, TOCTOU, falha parcial e logging seguro.
**Created**: 2026-06-21
**Feature**: [spec.md](../spec.md) · [contrato](../contracts/patch-update-envio-massa.md)
**Domínios**: security (primário), multi-tenant, auth

---

## 1. Isolamento Multi-Tenant / Gate de Grupo

- [x] CHK001 - São os requisitos de gate de grupo (`mesmoGrupoQue`) definidos de forma não-ambígua, distinguindo o critério de grupo do critério de ID fixo? [Completude, Spec §FR-003] {auto}
  > *Evidência*: FR-003 exige "verificado via critério de grupo (não por ID fixo de empresa)"; contrato §[E] especifica `mesmoGrupoQue(idEmp,6,cache)` como guard-clause explícita antes de qualquer acesso à tabela Motorista.

- [x] CHK002 - É o gate de grupo especificado como guard-clause **antes** do pré-check de conflito [E1], e não apenas dentro de `migrarCnpjMotorista`? [Clareza, contrato §[E]] {auto}
  > *Evidência*: contrato §[E] precede §[E1] na ordem [A]..[H]; invariante SEC-03 confirma "guard-clause OBRIGATÓRIA antes de [E1]". FR-013 reitera que nenhum SELECT/PATCH/POST em Motorista ocorre fora do gate.

- [x] CHK003 - É o requisito de isolamento (FR-013) mensurável — pode-se verificar objetivamente que empresas fora do grupo jamais consultam a tabela Motorista? [Mensurabilidade, Spec §FR-013] {auto}
  > *Evidência*: FR-013 define critério testável ("empresas fora do grupo nunca consultam a tabela de motoristas") + o contrato §[E] materializa o guard via `if (!mesmoGrupoQue(...)) pular [E1] e Motorista`. Teste de unidade C2 do plan.md cobre o cenário.

- [x] CHK004 - São os requisitos consistentes entre a spec (FR-003, FR-013) e o contrato (SEC-03) quanto ao escopo do gate? Não há contradição entre "só Movee" e "filiais futuras"? [Consistência, Spec §FR-003, contrato §SEC-03] {auto}
  > *Evidência*: ambos usam `mesmoGrupoQue(_, 6)` — a spec cita explicitamente "critério de grupo (não ID fixo)" para cobrir filiais futuras; o contrato espelha o mesmo critério. Sem contradição.

- [ ] CHK005 - É o comportamento do gate quando `mesmoGrupoQue` retorna erro (ex.: falha de cache/BD) especificado nos requisitos? [Cobertura de Edge Cases, Gap] {humano}
  > *Gap*: spec/contrato cobrem os caminhos happy path e o caso "fora do grupo", mas não definem o que ocorre se a própria chamada `mesmoGrupoQue(idEmp, 6, cache)` lançar exceção (timeout do cache, BD indisponível). Deve o sistema: (a) falhar fechado (403/500), (b) falhar aberto (pular o gate)? O padrão do projeto sugere falhar fechado, mas não há FR explícito. **Decisão do operador antes de `execute-task`.**

---

## 2. IDOR — Troca em Lote

- [x] CHK006 - É o requisito anti-IDOR (filtro `id_empresa` no PATCH em lote) especificado de forma não-ambígua na spec/contrato? [Completude, contrato §[F] nota anti-IDOR] {auto}
  > *Evidência*: contrato §[F] inclui nota explícita "Nota anti-IDOR (Princípio II / OWASP API4): o PATCH em lote [F] filtra **sempre** por `id_empresa=eq.${idEmp}`". FR-002 + FR-012 cobrem o escopo do lote; data-model.md §Confirmação confirma coluna `id_empresa` presente.

- [x] CHK007 - O requisito de escopo do lote (FR-002 + FR-012) cobre explicitamente movimentos `enviado=true` para evitar buracos de cobertura? [Completude, Spec §FR-012] {auto}
  > *Evidência*: FR-012 — "independentemente do status `enviado` (incluindo movimentos já finalizados)". Edge Cases da spec confirma: "Movimentos já finalizados (`enviado=true`) também têm o CNPJ atualizado".

- [x] CHK008 - É o requisito de escopo de tenant (só empresa-alvo resolvida server-side) consistente entre spec e contrato — o `id_empresa` nunca vem do body cru? [Consistência, contrato §[A], Princípio II constitution] {auto}
  > *Evidência*: contrato §[A] `resolveEmpresaAlvo → idEmp`; plan.md §Constitution Check "Escopo resolvido server-side, nunca do body cru". Sem contradição.

---

## 3. Conflito de Unicidade / TOCTOU

- [x] CHK009 - É o pré-check de conflito 409 ([E1]) especificado como operação **antes** de qualquer escrita, tornando o requisito de atomicidade-lógica verificável? [Clareza, Spec §FR-006, contrato §[E1]] {auto}
  > *Evidência*: FR-006 — "sem modificar nenhum dado"; contrato §[E1] precede §[F] na ordem; §SEC-04 define a barreira TOCTOU via `UNIQUE NOT NULL`.

- [x] CHK010 - É a barreira TOCTOU (UNIQUE NOT NULL em `Motorista.cnpj_prestador`) especificada como requisito de dados — não apenas como detalhe de implementação — para que a tarefa de `execute-task` não possa omiti-la? [Mensurabilidade, data-model.md §Motorista, contrato §SEC-04] {auto}
  > *Evidência*: data-model.md lista `cnpj_prestador | text UNIQUE NOT NULL` com nota "identidade de login"; contrato §SEC-04 — "fechada pelo UNIQUE NOT NULL de Motorista.cnpj_prestador". O requisito está nos artefatos de especificação, não apenas no código.

- [x] CHK011 - É o mapeamento "violação de UNIQUE no POST → 409 (não 500)" especificado explicitamente para evitar que o implementador trate como erro genérico? [Clareza, contrato §Respostas, SEC-04] {auto}
  > *Evidência*: tabela de Respostas — linha 409 inclui "(race TOCTOU, SEC-04)" e nota "Uma violação de UNIQUE NÃO cai aqui [500]: é 409 (SEC-04)".

---

## 4. Falha Parcial e Logging Seguro

- [x] CHK012 - É o comportamento de falha parcial (movimentos OK, Motorista falha) especificado de forma não-ambígua — sem reversão, com 500 + log? [Completude, Spec §FR-011] {auto}
  > *Evidência*: FR-011 — "retornar erro (HTTP 500) com mensagem clara e registrar a inconsistência em log (sem expor segredos), SEM tentar reverter os movimentos". Contrato §Respostas confirma o corpo do 500. Edge Cases da spec confirma.

- [x] CHK013 - É o requisito de logging seguro (sem expor segredos/senha) especificado explicitamente, e pode ser verificado objetivamente na implementação? [Completude, Spec §FR-011, contrato §SEC-05] {auto}
  > *Evidência*: FR-011 — "registrar a inconsistência em log (sem expor segredos)"; contrato §SEC-05 — "nunca logar o objeto `Motorista` completo no catch do 500 (carrega hash de senha)". Critério verificável: grep no log por campos de senha.

- [ ] CHK014 - São os requisitos de monitorabilidade/alerta para o estado inconsistente (movimentos trocados, Motorista não migrado) especificados? [Cobertura, Gap] {humano}
  > *Gap*: FR-011 exige "registrar inconsistência em log", mas não especifica se deve haver alerta operacional (ex.: metric counter, Slack, e-mail) para casos onde o admin precise intervir manualmente. Para um sistema de produção com clientes reais, a descoberta passiva via log pode ser insuficiente. **Decisão do operador: log puro é suficiente, ou precisa de alerta ativo?**

---

## 5. Preservação de Credenciais na Migração

- [x] CHK015 - É o requisito de preservação de `senha`, `nome` e `ativo` (FR-005) especificado de forma completa — todos os campos sensíveis estão listados? [Completude, Spec §FR-005, data-model.md] {auto}
  > *Evidência*: FR-005 — "preservando `nome`, `senha` e `ativo`"; data-model.md §Motorista lista todos os campos: `id` (bigserial), `cnpj_prestador`, `senha`, `nome`, `ativo`, `created_at`. O único campo não explicitado em FR-005 é `created_at` — que por semântica correria risco de ser redefinido num POST, mas o path é PATCH (FR-005), logo preservado automaticamente. Sem gap.

- [x] CHK016 - O requisito de `senha=null` no pré-cadastro (FR-007) é consistente com o modelo de dados existente (`senha nullable`) e não conflita com FR-005 (migração preserva senha)? [Consistência, Spec §FR-005 vs FR-007, data-model.md] {auto}
  > *Evidência*: data-model.md — `senha | text nullable | NULL = pré-cadastro sem senha (migração 008). Preservada na migração de CNPJ (FR-005)`. FR-007 aplica-se ao caminho "não existe Motorista com CNPJ antigo" → POST com senha=null. FR-005 aplica-se ao caminho "existe" → PATCH preserva senha existente. Sem conflito; caminhos mutuamente exclusivos.

---

## Notes

- Items `{auto}` resolvidos com `[x]` incluem citação da evidência nos artefatos.
- Items `{humano}` aguardam decisão do operador antes de `execute-task`.
- CHK005 e CHK014 são os dois gaps abertos — ambos de baixo impacto para o happy path, mas relevantes para operação em produção.
