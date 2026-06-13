# Spec — Seletor de Range de Datas no Import de Movimento

**Feature**: import-range-datas  
**Short name**: `import-range-datas`  
**Status**: Draft  
**Criada em**: 2026-06-13  
**Autora**: agente-00c-feature-orchestrator (pipeline SDD)

---

## Contexto

No painel `app.moveelog.com.br`, o operador importa planilhas de movimento de motoristas. Atualmente, as colunas `dt_inicial` e `dt_final` devem ser preenchidas **por linha** na planilha. Se qualquer linha tiver data ausente ou inválida, o lote inteiro é rejeitado com erro — comportamento observado no smoke da feature gorjeta (3 linhas sem data → lote todo falhou).

Esta feature elimina esse ponto de falha: o operador informa o período **uma única vez** na interface, e o sistema aplica esse range a todas as linhas do lote.

---

## Decisões de Infraestrutura

> Decisões de infraestrutura: N/A (feature stateless, sem scheduling, sem DDL, sem criptografia de dados persistentes, sem mutex cross-pod). Deploy coordenado frontend + backend é requisito operacional (não de infraestrutura de software).

---

## User Scenarios & Testing

### P1 — Operador importa planilha com range de datas válido

**Como** operador do painel,  
**quero** informar o período do movimento (data inicial e data final) **uma vez** na interface ao importar a planilha,  
**para que** todas as linhas do lote sejam gravadas com o mesmo período, sem depender do preenchimento correto de cada linha da planilha.

**Acceptance Scenarios:**

- **Cenário A (caminho feliz):** operador escolhe arquivo, sistema abre diálogo com dois campos de data; preenche data inicial `2026-05-01` e data final `2026-05-31`; clica Enviar; sistema processa o lote e todas as linhas são gravadas com `dt_inicial = 2026-05-01` e `dt_final = 2026-05-31`.
- **Cenário B (planilha com colunas de data):** operador importa planilha que já tinha colunas `dt_inicial`/`dt_final` preenchidas (legado); sistema ignora os valores da planilha e usa o range informado na UI; lote processado normalmente.
- **Cenário C (linha sem data na planilha):** operador importa planilha onde algumas linhas não têm colunas de data; sistema não falha por ausência de data na linha — usa o range da UI para todas as linhas.
- **Cenário D (regressão):** valor do movimento, gorjeta e CNPJ do motorista seguem sendo processados como antes; nenhuma regressão nesses campos.

---

### P2 — Sistema rejeita range inválido antes de processar o lote

**Como** operador do painel,  
**quero** receber uma mensagem de erro clara quando o range de datas for inválido ou ausente,  
**para que** eu possa corrigir sem ter que reprocessar o arquivo inteiro.

**Acceptance Scenarios:**

- **Cenário A (data inicial > data final):** operador preenche data inicial `2026-06-01` e data final `2026-05-01`; botão Enviar permanece desabilitado na UI; se enviado via backend direto, retorna `400` com mensagem única em português indicando range inválido.
- **Cenário B (range ausente):** operador tenta enviar sem preencher as datas; botão permanece desabilitado na UI; se enviado via backend direto sem os campos, retorna `400` com mensagem clara.
- **Cenário C (apenas uma data):** operador preenche apenas data inicial ou apenas data final; botão Enviar permanece desabilitado; envio é bloqueado.

---

### P3 — Comportamento uniforme para todos os grupos (incluindo Movee)

**Como** sistema,  
**quero** aplicar o range de datas informado pelo operador a **todos os grupos** (incluindo o Movee),  
**para que** não haja caminhos de código distintos por tipo de grupo e o comportamento seja previsível.

**Acceptance Scenarios:**

- **Cenário A (grupo Movee):** operador do grupo Movee importa planilha; sistema usa o range da UI (idêntico ao comportamento dos demais grupos); o fallback anterior de `01/01/1982` não é mais utilizado.
- **Cenário B (grupos não-Movee):** comportamento igual ao P1 — sem validação per-row, sem falha por data ausente na linha.

---

## Requirements

### Functional Requirements

**FR-001 — Diálogo de range na UI de import:**  
O fluxo de importação de planilha deve incluir uma etapa de confirmação onde o operador informa data inicial e data final do período do movimento. Essa etapa é obrigatória antes do envio do arquivo.

**FR-002 — Validação de range na UI:**  
O sistema deve habilitar o botão de envio somente quando: (a) ambas as datas estiverem preenchidas e (b) a data inicial for menor ou igual à data final. Enquanto inválido, o botão permanece desabilitado.

**FR-003 — Transmissão do range ao backend:**  
A data inicial e a data final selecionadas na UI devem ser enviadas junto com o arquivo ao backend no mesmo request de upload.

**FR-004 — Validação de range no backend (uma vez):**  
O backend deve validar a presença e a consistência do range (`dt_inicial ≤ dt_final`) uma única vez no início do processamento do lote, antes de iterar as linhas. Range ausente ou inválido → resposta `400` com mensagem única em português.

**FR-005 — Aplicação do range a todas as linhas:**  
O backend deve aplicar o range informado a todas as linhas do lote, independentemente de as colunas `dt_inicial`/`dt_final` da planilha estarem preenchidas ou não.

**FR-006 — Colunas da planilha ignoradas:**  
Os valores das colunas `dt_inicial` e `dt_final` da planilha devem ser ignorados durante o processamento. A presença ou ausência dessas colunas não deve causar falha.

**FR-007 — Semântica de datas preservada:**  
A semântica de `dt_final` (meia-noite horário SP) deve ser mantida igual ao comportamento atual — apenas a fonte das datas muda (da planilha para o range da UI).

**FR-008 — Comportamento uniforme entre grupos:**  
O range informado na UI é aplicado uniformemente a todos os grupos (incluindo o grupo Movee). O fallback de data padrão por grupo (`01/01/1982`) é eliminado.

**FR-009 — Sem regressão nos demais campos:**  
Os campos `valor`, `gorjeta`, CNPJ do motorista e mensagens de envio devem continuar sendo processados com a mesma lógica existente, sem alterações.

**FR-010 — Deploy coordenado:**  
O frontend e o backend devem ser atualizados no mesmo ciclo de deploy para evitar janela de incompatibilidade onde o backend exige o range mas o frontend ainda não o envia.

---

### Key Entities

**Range de Datas do Lote:**
- `dt_inicial` — data de início do período do movimento (informada pelo operador na UI)
- `dt_final` — data de fim do período do movimento (informada pelo operador na UI)

**Regra de negócio:** `dt_inicial ≤ dt_final`; ambas obrigatórias; aplicadas uniformemente a todas as linhas do lote.

---

## Success Criteria

1. **Lote sem falha por data:** operador importa planilha com linhas sem data e o lote é processado com sucesso, usando o range informado na UI — zero rejeições `400` por ausência de data na linha.

2. **Feedback de erro antes do envio:** range inválido ou incompleto é sinalizado na própria interface antes do envio, sem necessidade de tentativa e erro com o servidor.

3. **Confirmação do período:** o operador escolhe o arquivo e confirma o período numa única interação (diálogo + dois campos de data), sem necessidade de editar a planilha linha a linha.

4. **Uniformidade:** o comportamento de importação é idêntico para todos os grupos de empresas — sem caminhos distintos por grupo visíveis ao operador.

5. **Sem regressão:** após o deploy, imports que antes funcionavam continuam funcionando; gorjeta, valor e CNPJ são gravados corretamente.

---

## Clarifications

> Decisões fechadas autonomamente pelo answerer (heurística score ≥ 2) com base no plano e na constitution:

1. **Range obrigatório para todos os grupos, incluindo Movee (FR-008):** SIM — eliminar o caminho per-row e o fallback `01/01/1982`; fonte única de datas é o range da UI. (score 3: plano §6.1 + §5.3 explicitam a decisão recomendada com justificativa de consistência.)

2. **Semântica de `dt_final` mantém meia-noite SP (FR-007):** SIM — apenas a origem das datas muda, não a semântica de conversão existente. (score 3: plano §6.2 recomenda explicitamente manter a semântica atual.)

3. **Colunas da planilha: ignorar se presentes (FR-006):** SIM — retrocompatibilidade; remoção do modelo de planilha é etapa de documentação separada. (score 3: plano §6.3 recomenda explicitamente ignorar para manter retrocompat.)

4. **Teto de range absurdo:** fora de escopo desta feature. (score 3: plano §6.4 declara explicitamente "sem teto, fora de escopo".)
