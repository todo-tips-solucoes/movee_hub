# Security Checklist: Adiantamento pelo App, Dados Bancários e Exportação Transfeera

**Purpose**: Validar a qualidade dos requisitos de segurança (autenticação/autorização,
proteção de dados bancários/PII, injeção, auditoria, sessão, consumo de recursos) antes
de `/create-tasks`. Não testa implementação — testa se o requisito está claro, completo
e verificável.
**Created**: 2026-09-17
**Feature**: [spec.md](../spec.md) · [plan.md §Segurança](../plan.md) · gate `owasp-security` já rodado no `plan` (dec-022/023/024, 0 critical/high, 3 medium tratados no desenho)

## Autenticação e Sessão

- [x] CHK001 - O requisito de restauração silenciosa de sessão define o gatilho exato (qualquer tela do adiantamento) e a ordem de tentativa antes de pedir novo login? [Completude, Spec §FR-053] {auto}
- [x] CHK002 - O requisito de mensagens de erro específicas distingue explicitamente erro de negócio (4xx com `detail`) de erro de infraestrutura (timeout/5xx), evitando mascarar um como o outro? [Clareza, Spec §FR-054, CLAUDE.md "Regras de domínio"] {auto}
- [ ] CHK003 - O requisito de restauração de sessão cobre o caso em que o refresh token também expirou (não só o access token)? [Gap, Spec §FR-053] {auto}

## Autorização e RBAC

- [x] CHK004 - Cada capacidade tem uma permissão própria e distinta, sem duas capacidades compartilhando o mesmo código? [Completude, Spec §FR-045, contracts/hub-api.md §Permissões — 10 códigos distintos] {auto}
- [x] CHK005 - O requisito de concessão de permissões define explicitamente o papel padrão (financeiro + admins) e nega a qualquer outro papel por padrão (fail-closed)? [Clareza, Spec §FR-046] {auto}
- [x] CHK006 - O plano define uma segunda barreira de autorização no SQL (não só no Node) para as RPCs que movem dinheiro ou expõem dado bancário completo, cobrindo o cenário de um JWT do PostgREST usado sem passar pelo middleware? [Consistência, plan.md §Segurança S1, dec-023, sql-rpc.md `hub_adiantamento_tem_permissao`] {auto}
- [x] CHK007 - O escopo de "grupo inteiro" nas consultas está restrito à empresa-pai (id=6), com filial vendo apenas a própria empresa, em vez de reusar cegamente o padrão de avisos existente? [Consistência, plan.md §Segurança S2, dec-022, CLAUDE.md "grupo Movee"] {auto}
- [ ] CHK008 - A prioridade relativa entre "endurecer no SQL" (dec-023) e o custo de manutenção de duas camadas de RBAC (Node + SQL) reflete o apetite de risco do produto para este módulo financeiro, ou caberia reavaliar se todo módulo novo deveria seguir o mesmo padrão? [Risco] {humano}

## Proteção de dados bancários e PII

- [x] CHK009 - O requisito de mascaramento define precisamente onde os dados completos NUNCA aparecem (listas) e onde aparecem (ação de revisão dedicada), com registro da visualização completa? [Mensurabilidade, Spec §FR-019] {auto}
- [x] CHK010 - O plano proíbe explicitamente `SELECT` direto em `ContaBancariaMotorista` e nos bytes do arquivo de exportação, forçando acesso só por RPC com mascaramento no SQL? [Completude, plan.md §Segurança S3, dec-023] {auto}
- [x] CHK011 - O requisito de auditoria exclui explicitamente documento completo, número de conta bancária e conteúdo do arquivo do detalhe registrado, para toda ação auditável? [Clareza, Spec §FR-047] {auto}
- [x] CHK012 - Existe um requisito específico para o cenário de troca de conta bancária aprovada entre a liberação de uma solicitação e a criação do lote (possível desvio de pagamento por sessão comprometida), com pendência e ação explícita do financeiro? [Cobertura de Edge Cases, Spec §FR-036, plan.md S4] {auto}
- [x] CHK013 - A chave PIX do cadastro está explicitamente excluída do arquivo de exportação, reduzindo a superfície de dado bancário sensível em trânsito para o parceiro de pagamento? [Completude, Spec §FR-055] {auto}
- [ ] CHK014 - O requisito de retenção de 90 dias do arquivo de exportação (FR-052) define o que acontece se o financeiro precisar do arquivo após o descarte para fins de conciliação/auditoria fiscal — é aceitável perder o arquivo, mantendo só o retrato das linhas? [Ambiguity, Spec §FR-052] {humano}

## Validação de entrada e injeção

- [x] CHK015 - O requisito do modelo de descrição do pagamento restringe os placeholders aceitos a um conjunto fechado (`{data_producao}`, `{nome}`), recusando qualquer outro, prevenindo injeção via configuração? [Clareza, plan.md §Segurança S5] {auto}
- [x] CHK016 - Os requisitos de validação de dados bancários (FR-016) cobrem dígito verificador do documento, banco pertencente à lista oficial e formato dos demais campos — os três eixos estão presentes, não só um? [Completude, Spec §FR-016] {auto}
- [x] CHK017 - O plano define que a fonte da produção é resolvida por ramos estáticos no SQL (não SQL dinâmico), fechando o vetor de injeção via configuração de fonte/categoria? [Consistência, plan.md §Segurança S5] {auto}
- [ ] CHK018 - O requisito FR-016 quantifica o "formato dos demais campos" (ex.: máscara de agência com 4 dígitos citada em FR-055) de forma suficiente para implementar sem decisão adicional, ou falta uma referência cruzada explícita entre FR-016 e FR-055? [Ambiguity, Spec §FR-016, §FR-055] {auto}

## Atribuição em massa e limites de payload

- [x] CHK019 - O plano restringe explicitamente `PUT /configurações` e `POST /conta-bancaria/solicitações` a copiar apenas os campos definidos no contrato, prevenindo mass assignment (API3)? [Completude, plan.md §Segurança S6] {auto}
- [x] CHK020 - Existe um teto explícito e numérico para o tamanho de um lote de pagamento, alinhado ao limite do parceiro, com recusa de tentativas que o excedam? [Mensurabilidade, Spec §FR-032, plan.md §Segurança S8 — `ids` ≤ 5.000] {auto}
- [x] CHK021 - O requisito de consumo de recursos (S8) define limitadores por CNPJ e por `sub`, não apenas um limite global compartilhado que um único ator poderia esgotar sozinho? [Clareza, plan.md §Segurança S8] {auto}

## Concorrência e idempotência (segurança operacional)

- [x] CHK022 - O requisito de idempotência (FR-050) define a chave de idempotência como fornecida pelo cliente, e o contrato SQL (`hub_adiantamento_solicitar`) trata reenvio com a mesma chave devolvendo o registro existente em vez de erro? [Consistência, Spec §FR-050, sql-rpc.md `reutilizado = true`] {auto}
- [x] CHK023 - O requisito de serialização de concorrência (FR-051) garante no máximo um vínculo de lote ativo por solicitação sob ações simultâneas, e o plano cita o mecanismo de trava (`FOR UPDATE`) usado para a corrida análoga entre cancelamento e corte (S7)? [Consistência, Spec §FR-051, plan.md §Segurança S7] {auto}

## Auditoria e logging sensível

- [x] CHK024 - O requisito de auditoria (FR-047) enumera exaustivamente as ações que mudam estado e precisam de entrada de auditoria, sem uma categoria de mutação ficando de fora (ex.: alteração de configuração está coberta)? [Completude, Spec §FR-047, §FR-024] {auto}
- [x] CHK025 - O plano cita um mecanismo automatizado (`scan-auditoria-sensivel.sh`) para detectar vazamento de dado sensível em log/auditoria, em vez de depender só de revisão manual? [Mensurabilidade, plan.md §Segurança S9] {auto}
- [x] CHK026 - O requisito de payload de push (S9) garante que a notificação nunca carrega dado bancário ou documento no título/corpo, e que o transporte é cifrado ponta a ponta? [Clareza, plan.md §Segurança S9 — RFC 8291] {auto}

## Achados pré-existentes fora do escopo (S11)

- [ ] CHK027 - A decisão de deixar `jwt.verify` sem `algorithms` explícito (`routes/motorista.js:161`) fora do escopo desta feature está justificada por não ser uma regressão introduzida por ela, mas o risco residual (confusão de algoritmo) foi comunicado ao operador para priorização futura? [Assumption, plan.md §Segurança S11, §Achados fora do escopo] {humano}
- [ ] CHK028 - O vazamento parcial de claims via `[proxy-debug]` (120 primeiros caracteres do cookie) tem um destino de correção decidido (Q-N17, PR separado) e uma janela alvo, ou fica indefinidamente pendente? [Gap, plan.md §Segurança S11] {humano}

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador `[Gap]`/`[Ambiguity]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto (financeiro/operador).
- Gate determinístico `requirement-coverage.sh` sobre spec.md: 55/55 requisitos cobertos por cenário, 0 findings (rodado nesta onda).
