# Security Checklist: Enriquecimento automático de entregadores novos

**Purpose**: Gate de qualidade dos requisitos de segurança/privacidade (spec.md) antes de `create-tasks` — valida se os requisitos estão bem escritos e rastreáveis, não se o código está seguro (isso já foi coberto pelo gate `owasp-security` na fase `plan`, `block-003`/`dec-022`, veredito "aprovado com ressalvas": 0 critical, 2 high, 4 medium, 3 low — todos resolvidos ou corrigidos).
**Created**: 2026-09-08
**Feature**: [spec.md](../spec.md)

## AuthN/Z — Resolução de escopo multi-tenant

- [x] CHK001 - FR-009 cobre as três operações desta feature (enfileiramento automático, consulta de desfecho, gravação de desfecho) sem deixar nenhuma delas implícita? [Completude, Spec §FR-009] {auto}
  Evidência: "Toda operação desta feature (enfileiramento automático, consulta e gravação do desfecho de tentativa) MUST ter seu escopo de empresa/tenant resolvido a partir do contexto autenticado da sessão" — as 3 operações nomeadas explicitamente cobrem write automático (trigger), read e write manual (PATCH).
- [x] CHK002 - FR-009 exclui explicitamente a alternativa insegura (escopo vindo do corpo/parâmetro da requisição) em vez de só afirmar a forma positiva? [Clareza, Spec §FR-009] {auto}
  Evidência: "...nunca de um valor informado livremente na requisição" — negativa explícita, mesmo padrão já confirmado no contrato técnico (`contracts/entrego-desfecho.md`: "O `id_empresa` nunca vem do corpo").
- [x] CHK003 - A spec declara que nenhum mecanismo de autenticação/autorização NOVO é introduzido por esta feature, evitando ambiguidade sobre se um novo endpoint/rota de auth precisa ser especificado? [Não-Funcional, Spec §linhas 235-238] {auto}
  Evidência: nota de decisões de infraestrutura reutiliza "a autenticação já existente" sem introduzir mecanismo novo; plan.md confirma (Constitution Check, Princípio I: "Nenhum mecanismo de auth novo. O PATCH continua autenticando pelo cookie httpOnly `hub_accessToken`").

## Proteção de dados / PII

- [ ] CHK004 - A spec (ou uma nota de escopo dela) define o prazo de retenção/expurgo de CPF/RG/CNH coletados pelo enriquecimento, já que FR-013 torna essa definição pré-condição do cutover de produção? [Privacidade, Gap, Spec §FR-013] {humano}
  Duplicado do CHK020 de `requirements.md` — repetido aqui pela lente de segurança/privacidade porque é o único requisito desta feature com um HIGH de segurança (H1) diretamente dependente dele. FR-013 menciona a condição mas não define o prazo nem aponta para onde ele será definido (nova spec? ADR? runbook?). Decisão do dono do produto.
- [x] CHK005 - FR-013 declara explicitamente que esta feature MUST NOT ampliar a coleta de PII além do que já é coletado hoje pelo fluxo manual? [Clareza, Spec §FR-013] {auto}
  Evidência: "Não ampliar a coleta de PII agora (FR-013)" — restrição explícita dentro do próprio enunciado da FR, não apenas inferida do contexto.
- [x] CHK006 - O requisito de "não ligar em produção" (H1/FR-013) é redigido de forma objetivamente verificável (existência ou ausência de uma ação concreta), e não como intenção vaga ("ter cuidado com PII")? [Mensurabilidade, Spec §FR-013] {auto}
  Evidência: "Ligar o enfileiramento automático para uma empresa MUST ser um ato explícito, reversível e auditável, separado do deploy do código e da aplicação da mudança de esquema" — verificável por inspeção (existe ou não existe uma linha `ativo=true` na tabela de habilitação, aplicada fora do deploy).
- [ ] CHK007 - O padrão mínimo de "auditável" exigido por FR-013 (quem habilitou, quando, por quê) está definido na spec com precisão suficiente para diferenciar "satisfeito" de "não satisfeito", dado que o design (fora da spec) resolveu isso como "a própria linha da tabela + registro no runbook", sem linha formal em `"Auditoria"`? [Ambiguity, Spec §FR-013] {humano}
  Mesmo achado de `requirements.md` CHK008/CHK023, reafirmado aqui como item de segurança porque é a salvaguarda humana que substitui o auto-enfileiramento (H1). Decisão do dono do produto: o padrão atual é aceito como "auditável" para efeito de release, ou a spec precisa de um critério mais específico antes do cutover?

## Rate limiting / disponibilidade da fila

- [x] CHK008 - O teto de enfileiramento automático (FR-010) é redigido como requisito quantificável e configurável, e não como constante mágica ou meta aspiracional? [Mensurabilidade, Spec §FR-010] {auto}
  Evidência: "MUST respeitar um teto de pedidos automáticos por empresa, cujo valor é configurável por empresa e MUST NOT ser uma constante embutida no código" com valor inicial numérico justificado (100) e cálculo de tempo de dreno explícito.
- [x] CHK009 - A spec define o que acontece com o excedente do teto (perdido vs. preservado), fechando a ambiguidade que motivou o achado H2 do gate `owasp-security`? [Completude, Spec §FR-010] {auto}
  Evidência: "O excedente MUST NOT ser descartado nem perdido: permanece elegível (FR-002) e é enfileirado numa importação seguinte, respeitando o mesmo teto."
- [x] CHK010 - FR-011 (pedido manual fura a fila) define o critério de desempate de forma objetivamente implementável, sem depender de interpretação (ex.: "processado com prioridade" sem dizer sobre o quê)? [Clareza, Spec §FR-011] {auto}
  Evidência: "MUST ser servido pelo processamento antes de qualquer pedido criado pelo enfileiramento automático, independentemente de quando cada um entrou na fila" — ordena explicitamente contra a fila automática, sem ambiguidade de "antes de quem".
- [x] CHK011 - FR-012 (habilitação nega-por-padrão) evita a starvation permanente descrita no achado M2 (tenant sem robô acumulando fila) ao restringir o enfileiramento à condição de habilitação, e essa relação causa-efeito está explícita na spec (não só inferida do desenho técnico)? [Consistência, Spec §FR-012] {auto}
  Evidência: "Isso impede que uma empresa cujo consumo da fila não está configurado acumule uma fila permanente que nunca drena" — a própria FR nomeia o problema (M2) que resolve, dentro do texto da spec, não só no plano técnico.
- [ ] CHK012 - Existe requisito (FR ou SC) para o cenário em que o teto é reduzido enquanto há mais pendentes automáticos que o novo valor — especificamente pela lente de disponibilidade (o excedente fica preso indefinidamente até drenar, sem meta de tempo)? [Não-Funcional, Gap, Spec §FR-010] {humano}
  Mesmo Gap de `requirements.md` CHK003, reafirmado aqui pela lente de segurança/disponibilidade: sem requisito, não há como testar se o comportamento de redução de teto é aceitável sob a ótica de "fila que não drena" (o mesmo risco do M2, mas causado por reconfiguração em vez de ausência de habilitação).

## Sanitização de input / integridade de auditoria

- [ ] CHK013 - Existe um requisito funcional (FR) ou critério de aceite (SC) rastreável na spec para o achado M4 do gate `owasp-security` (dado bruto controlado por serviço externo não pode ir sem limite/sanitização para o log de auditoria), ou essa proteção existe apenas como correção pontual documentada no plano técnico, sem virar requisito testável da feature? [Completude, Gap, Plan §Achados owasp-security M4] {humano}
  Plan.md registra M4 como "Corrigido — grava o valor mapeado; length <= 64; motivoFalha truncado" mas nenhuma FR/SC da spec exige esse comportamento (diferente de H1, H2, M1, M2, que viraram FR-010–FR-013). Decisão do dono do produto: M4 é um detalhe de implementação que não precisa de FR própria (aceitável, já que é herança de uma allowlist já existente no código, `ACOES_PERMITIDAS`), ou deveria virar um SC mensurável para não depender só de revisão de código?
- [x] CHK014 - FR-006 (4 valores mutuamente exclusivos do desfecho) é redigido de forma que qualquer input externo tenha que mapear para um dos 4 valores válidos, sem deixar espaço para um quinto valor não-especificado entrar na coluna? [Consistência, Spec §FR-006] {auto}
  Evidência: "os quatro valores MUST ser mutuamente exclusivos e distinguíveis sem ambiguidade" — fechado por construção; o mapeamento total do sinal externo (`contracts/entrego-desfecho.md`: "todo input produz um dos 4 valores válidos") é a implementação consistente dessa exigência, não uma extrapolação dela.

## Fail-closed / postura padrão

- [x] CHK015 - As três condições de negação do enfileiramento automático (fora do escopo de importação, empresa não habilitada, teto excedido) são todas expressas na spec como "nada acontece" (fail-closed) e não como erro/exceção que precisaria de tratamento adicional? [Não-Funcional, Spec §FR-001, FR-012] {auto}
  Evidência: FR-001 subordina o enfileiramento a FR-012 e FR-010 que "adiam, mas nunca cancelam"; FR-012 é "nega-por-padrão"; nenhuma das três condições é descrita como caminho de erro — todas resultam em continuar sem enfileirar, sem falhar a importação em curso (consistente com data-model.md: "Falha fecha... o modo de falha do gatilho é não coletar PII").
- [x] CHK016 - A spec evita introduzir qualquer novo mecanismo de retry/scheduler/lock que ampliaria a superfície de segurança além do que já existe hoje no processamento sob-demanda? [Não-Funcional, Spec §linhas 235-244] {auto}
  Evidência: "Não introduz política de retry nova... N/A para scheduling/rotação de chave/mutex multi-pod/backup" — escopo de segurança explicitamente contido ao que já existe.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com evidência citada, ou `[Gap]`/`[Ambiguity]` quando a checagem automática revela lacuna real).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto — nenhum foi auto-marcado.
- CHK004/CHK007/CHK012 duplicam (por design, lente diferente) os Gaps CHK020/CHK008/CHK023/CHK003 de `requirements.md` — o mesmo gap real não precisa de duas tarefas distintas em `create-tasks`, mas fica registrado nos dois domínios porque afeta tanto qualidade geral do requisito quanto a superfície de segurança.
- O gate `owasp-security` já rodou na fase `plan` (`block-003`) sobre o DESENHO da feature — este checklist audita apenas se as decisões daquele gate estão corretamente refletidas como REQUISITOS rastreáveis na spec, não repete a análise de código/arquitetura.
