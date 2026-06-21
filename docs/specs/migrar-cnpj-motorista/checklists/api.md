# API Checklist: migrar-cnpj-motorista

**Purpose**: Validar a qualidade dos requisitos de contrato da rota `PATCH /update-envio-massa/:id` — códigos de resposta, ordem de operações, idempotência, normalização e regressão.
**Created**: 2026-06-21
**Feature**: [spec.md](../spec.md) · [contrato](../contracts/patch-update-envio-massa.md)
**Domínios**: api (primário)

---

## 1. Completude do Contrato de Respostas

- [x] CHK017 - São todos os códigos de resposta relevantes (200/400/403/404/409/500) especificados com body, condição de disparo e semântica distintos? [Completude, contrato §Respostas] {auto}
  > *Evidência*: tabela §Respostas do contrato cobre 200, 400, 403, 404, 409, 500 — cada linha tem "Quando", "Body" e notas de semântica. Sem código faltante para os fluxos descritos na spec.

- [x] CHK018 - É a condição de disparo do 400 (CNPJ inválido) especificada com critério verificável — não apenas "inválido"? [Clareza, contrato §[B], §Respostas] {auto}
  > *Evidência*: contrato §[B] — "validar cnpjNovo (400 se inválido)"; §Respostas — "CNPJ inválido (≠ 14 dígitos após normalizar)". Critério: 14 dígitos numéricos após `onlyDigits`. Verificável objetivamente.

- [x] CHK019 - É a condição de disparo do 409 especificada para **dois** subcasos — pré-check [E1] e race TOCTOU — com mapeamento explícito de "UNIQUE violation → 409, não 500"? [Clareza, contrato §Respostas, SEC-04] {auto}
  > *Evidência*: tabela §Respostas — linha 409 lista ambos os subcasos entre parênteses e inclui a nota "Uma violação de UNIQUE NÃO cai aqui [500]: é 409 (SEC-04)".

- [x] CHK020 - É o body do 200 especificado de forma compatível com o shape atual da rota (sem quebrar clientes existentes)? [Consistência, contrato §Respostas, plan.md §Não regredir] {auto}
  > *Evidência*: contrato §Respostas — 200 body `{ message: "Registro atualizado com sucesso!" }` seguido de "(ou shape atual da rota)". plan.md §Não regredir — "semântica de `enviado/men1/men2/tipo` inalterada". O contrato reconhece explicitamente a compatibilidade.

---

## 2. Ordem de Operações e Invariantes

- [x] CHK021 - É a ordem das operações [A]..[H] especificada de forma que nenhuma escrita ocorra antes da validação completa ([A]→[B]→[C]→[D]→[E]→[E1]→[F]→[G]→[H])? [Completude, contrato §Ordem das operações] {auto}
  > *Evidência*: contrato §Ordem das operações documenta a sequência [A]..[H] com setas explícitas; [E1] (pré-check de conflito) precede [F] (escrita). Sem escrita antes de validação.

- [x] CHK022 - É o requisito de execução da migração de motorista **somente após** os movimentos OK (FR-010) representado na ordem de operações de forma verificável? [Mensurabilidade, Spec §FR-010, contrato §[F]] {auto}
  > *Evidência*: FR-010 — "somente após a atualização bem-sucedida dos movimentos — nunca antes"; contrato §[F] — `migrarCnpjMotorista(...)` listada logo abaixo do PATCH em lote, com comentário "(FR-010: SÓ após [F]-movimentos OK)".

- [x] CHK023 - É a semântica de no-op (CNPJ novo == CNPJ antigo após normalização) especificada com destino explícito na ordem de operações — sem ambiguidade sobre qual passo ocorre a seguir? [Clareza, contrato §[D], Spec §Edge Cases] {auto}
  > *Evidência*: contrato §[D] — "se cnpjNovo === cnpjAntigo → NO-OP de CNPJ, ir para [G]" (demais campos continuam sendo salvos). Edge Cases da spec confirma. Sem ambiguidade.

---

## 3. Normalização de CNPJ

- [x] CHK024 - É o requisito de normalização (FR-009) especificado com critério verificável — "remover pontuação, manter apenas dígitos" — e aplicado consistentemente em comparação E persistência? [Clareza, Spec §FR-009] {auto}
  > *Evidência*: FR-009 — "normalizar o CNPJ (remover pontuação, manter apenas dígitos) antes de qualquer comparação ou persistência". Contrato §[B] aplica normalização antes de validar. Spec §US4-AC3 confirma: "apenas os 14 dígitos são enviados ao servidor".

- [x] CHK025 - É a função de normalização (`onlyDigits`) identificada como reuso de código existente — evitando divergência de implementação entre rotas? [Consistência, plan.md §Reuso] {auto}
  > *Evidência*: plan.md §Backend §3 — "Reuso (não reinventar): `onlyDigits`, `isCNPJ14`". Sem requisito novo; o reuso é explicitado.

---

## 4. Idempotência

- [x] CHK026 - É a idempotência da função `migrarCnpjMotorista` especificada de forma mensurável — re-executar com CNPJ já migrado produz estado final idêntico? [Mensurabilidade, data-model.md §Motorista §Idempotência] {auto}
  > *Evidência*: data-model.md §Idempotência — "re-rodar com o CNPJ já migrado → PATCH cnpj=eq.{ANTIGO} afeta 0 linhas (o registro já está em NOVO); cnpjNovo===cnpjAntigo → no-op total". Comportamento especificado, verificável em teste.

- [x] CHK027 - A idempotência do PATCH em lote de movimentos é coberta nos requisitos — o que ocorre se o lote já foi aplicado (0 linhas afetadas)? [Cobertura, Spec §FR-002, Edge Cases] {auto}
  > *Evidência*: edge case "CNPJ antigo e novo iguais após normalização" → no-op detectado em [D]. O caso "CNPJ já migrado em execução anterior" é coberto pela semântica do PATCH do PostgREST (atualiza 0 linhas sem erro), e `migrarCnpjMotorista` é idempotente conforme data-model.md. Requisito implícito mas rastreável.

---

## 5. Regressão e Campos Existentes

- [x] CHK028 - É o requisito de não-regressão (campos `enviado`, `men1`, `men2`, `tipo`) especificado de forma que a tarefa de implementação não possa omiti-lo? [Completude, plan.md §Não regredir, contrato §Invariantes §Sem regressão] {auto}
  > *Evidência*: plan.md §Backend §4 — "Não regredir: semântica de `enviado/men1/men2/tipo` inalterada". Contrato §Invariantes — "Sem regressão: `enviado/men1/men2/tipo` mantêm semântica atual". O requisito está materializado em dois artefatos.

- [x] CHK029 - São os campos que o endpoint **não** deve tocar (ex.: `id`, `id_empresa`, `created_at`) especificados ou inferíveis sem ambiguidade do contrato? [Clareza, data-model.md §EnvioMassa] {auto}
  > *Evidência*: data-model.md §EnvioMassa lista todos os campos; o contrato detalha quais são escritos em [F] (`cnpj_prestador`) e [G] (`enviado/mensagem/tipo`). Campos de chave/empresa/auditoria não aparecem como alvo de escrita — imutabilidade é inferível. Sem gap explícito, mas sem FR dedicado. Aceitável para feature de escopo cirúrgico.

---

## 6. Observabilidade e Diagnóstico

- [x] CHK030 - É o requisito de logging de inconsistência (500 parcial) especificado com informação suficiente para diagnóstico — o que deve constar no log? [Clareza, Spec §FR-011, contrato §SEC-05] {auto}
  > *Evidência*: FR-011 — "registrar a inconsistência em log (sem expor segredos)"; contrato §SEC-05 — "nunca logar o objeto `Motorista` completo no catch do 500 (carrega hash de senha)". O **quê** logar (cnpjAntigo, cnpjNovo, idEmpresa, mensagem de erro) não está explicitado além da restrição negativa.
  >
  > [Ambiguity] — O requisito especifica o que **não** logar (senha), mas não o que **deve** constar. Um implementador pode logar apenas "erro ao migrar motorista" sem contexto diagnóstico. Recomenda-se clarificar ou aceitar o risco de log opaco.

- [ ] CHK031 - São os requisitos de rastreabilidade de chamada (ex.: request-id, correlação entre log do backend e log do PostgREST) especificados? [Cobertura, Gap] {humano}
  > *Gap*: nenhum FR especifica propagação de request-id ou correlation-id entre o backend Node e o PostgREST. Em caso de falha parcial (500), correlacionar o log do Node com o log do PostgREST pode ser difícil sem um identificador compartilhado. **Decisão do operador: é suficiente logar sem correlação para este escopo?**

---

## Notes

- Items `{auto}` resolvidos com `[x]` incluem citação da evidência nos artefatos.
- Items `{humano}` aguardam decisão do operador antes de `execute-task`.
- CHK030 tem marcador `[Ambiguity]` — recomenda-se aceitar o risco (log mínimo seguro é suficiente para escopo) ou clarificar o que deve constar.
- CHK031 é gap de observabilidade — baixo impacto para MVP, mas relevante em produção.
