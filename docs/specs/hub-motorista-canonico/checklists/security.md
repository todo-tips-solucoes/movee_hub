# Security Checklist: Motorista canônico do hub

**Purpose**: Validar que os mandatos de hardening do gate OWASP (Phase 0,
`research.md` §Segurança) e os requisitos de segurança da spec (autenticação,
multi-tenant, auditoria) estão especificados com precisão suficiente para virar
tarefas verificáveis em `create-tasks` — não testa a implementação (ainda
inexistente), testa se o REQUISITO/mandato está bem definido.
**Created**: 2026-07-12
**Feature**: [spec.md](../spec.md)

## Injection / Validação de Entrada (S1)

- [x] CHK001 - O mandato S1 (busca por nome) especifica um mecanismo concreto de
  parametrização, não apenas "validar o tamanho"? [Spec §S1, Research §Decision 3]
  {auto} — research.md é explícito: "NUNCA concatenar o termo cru em querystring/
  SQL... a segurança vem da parametrização", citando dois caminhos concretos (RPC
  `hub_motoristas_busca` ou `encodeURIComponent` via `hubPostgrestRequest`).
- [x] CHK002 - O mandato distingue claramente validação de tamanho (`termoBuscaValido`)
  de sanitização/segurança (parametrização)? [Clareza, Research §S1] {auto} —
  "`termoBuscaValido` só valida tamanho (≥3), não sanitiza" é uma frase dedicada a
  evitar a confusão comum entre os dois conceitos.
- [ ] CHK003 - Existe critério de aceite explícito e testável (ex.: teste com
  caractere `%`/`_`/aspas no termo de busca) para confirmar que a parametrização
  foi de fato aplicada, e não apenas citada como intenção? [Gap, Mensurabilidade]
  {humano} — nenhum artefato (research/plan/quickstart) define um caso de teste
  específico para injeção (ex.: buscar por `'; DROP TABLE--` ou `%`); recomenda-se
  que `create-tasks` inclua explicitamente esse caso no gate de fechamento da
  Fase B, não apenas o teste de happy-path do combobox.

## Mass Assignment / BOPLA (S2)

- [x] CHK004 - O mandato S2 define uma allowlist explícita de campos aceitos no
  `POST /motoristas`? [Spec §S2, Contract §Request JSON body] {auto} — research.md
  lista exatamente `nome` + `idExterno`; contract confirma os mesmos dois campos
  na tabela de Request, sem campos adicionais.
- [x] CHK005 - O mandato proíbe explicitamente que `id_empresa` venha do body do
  cliente? [Spec §S2, Research §Decision (Princípio II)] {auto} — "`id_empresa`
  SEMPRE do contexto do token (`resolverContextoEntidade`), nunca do body".
- [x] CHK006 - O mandato proíbe explicitamente campos sensíveis de escalonamento
  (`ativo`, `motorista_id`, `id`) vindos do cliente no cadastro? [Spec §S2] {auto}
  — "NUNCA aceitar `ativo`/`motorista_id`/`id` do cliente" é enumerado
  nominalmente, não apenas "validar o body".
- [x] CHK007 - A allowlist dos endpoints de credencial está definida por endpoint,
  evitando que um campo válido em um endpoint vaze para outro? [Consistência,
  Spec §S2, Contract §Credencial] {auto} — research.md separa "Credencial: só
  `cnpj_prestador`/`senha_inicial`/`ativo` conforme o endpoint"; o contract
  detalha por endpoint (`POST /credencial` aceita `cnpj_prestador`/`senha_inicial`;
  `PATCH /credencial` aceita só `ativo`) — sem sobreposição indevida.
- [x] CHK008 - O contrato existente `PATCH /motoristas/:id` (allowlist já em
  produção via `validarPatchMotorista`) é reusado em vez de recriado, evitando
  duas superfícies de validação divergentes? [Consistência, Contract §PATCH
  /motoristas/:id, Plan §Structure] {auto} — contract marca esse endpoint como
  "EXISTENTE — inalterado", plan.md lista `validarPatchMotorista` como reuso, não
  nova implementação.

## Autenticação / Criptografia (S3)

- [x] CHK009 - O mandato especifica um custo mínimo mensurável para o bcrypt, não
  apenas "usar bcrypt"? [Mensurabilidade, Spec §S3] {auto} — "bcrypt **cost ≥ 12**"
  é um número verificável em code review/teste.
- [x] CHK010 - O mandato de token de reset especifica as três propriedades
  necessárias (single-use, expiração curta, alta entropia) ou deixa alguma
  implícita? [Clareza, Spec §S3] {auto} — as três propriedades são enumeradas
  explicitamente na mesma frase do mandato.
- [ ] CHK011 - "Expiração curta" e "alta entropia" estão quantificadas com valores
  concretos (minutos, bits), ou ficam como termos qualitativos a critério de quem
  implementa? [Ambiguity, Spec §S3] {auto} — nenhum artefato define um número (ex.:
  "15 minutos", "≥128 bits"); **[Gap]** — recomenda-se que `create-tasks`
  espelhe os valores já usados no fluxo de reset de senha existente do hub
  (`recuperarSenha`/`/api/v1/auth/recuperar-senha`, citado em Research Decision 2)
  em vez de introduzir uma política nova, mas isso não está explicitado como
  requisito.
- [x] CHK012 - O mandato garante que a senha nunca é exposta em leitura (DTO/SELECT),
  não apenas "protegida na escrita"? [Spec §S3, Data-Model §ContaMotorista] {auto}
  — "`senha` nunca retornada em DTO/SELECT de leitura (já garantido em
  data-model)" e data-model.md confirma: "a coluna `senha` NUNCA é exposta em
  DTO/SELECT de leitura — só lida internamente na autenticação".
- [x] CHK013 - O mandato preserva explicitamente a lição do incidente histórico de
  rate-limit/trust-proxy no login do app motorista, evitando reintroduzir a
  regressão? [Spec §S3, MEMORY "fix login motorista 429 trust-proxy"] {auto} —
  "Preservar `rate-limit` + `trust proxy` no login do app motorista (histórico do
  incidente 429/trust-proxy) ao embutir o `entregador_uuid`" cita o incidente
  nominalmente.

## Logging / Auditoria (S4)

- [x] CHK014 - O mandato S4 proíbe explicitamente vazar segredos (senha, token de
  reset) no log de auditoria, e não apenas exige "registrar auditoria"? [Spec §S4]
  {auto} — "**nunca** o valor da senha nem o token de reset" é uma proibição
  explícita, distinta da exigência positiva de registrar quem/quando/ação.
- [x] CHK015 - O mandato cobre tanto vazamento de segredo em log quanto vazamento
  de detalhe interno em resposta de erro (A10)? [Completude, Spec §S4] {auto} —
  "Erros mapeados (409/422) sem vazar internals (A10)" está no mesmo mandato,
  cobrindo as duas superfícies (log e resposta HTTP).
- [x] CHK016 - Todos os endpoints de escrita novos (cadastro, credencial: criar/
  reset/ativar-desativar) têm requisito de auditoria individualmente, ou apenas
  um requisito genérico? [Cobertura, Spec §FR-021, Contract] {auto} — FR-021 cobre
  "criação, edição, redefinição de senha ou mudança de situação de motorista ou de
  credencial" — os quatro tipos de escrita citados no contrato (POST /motoristas,
  POST /credencial, POST /reset-senha, PATCH /credencial) estão cobertos pela
  enumeração de FR-021 sem lacuna.

## Multi-Tenant / BOLA (A01/API1)

- [x] CHK017 - Todo endpoint (leitura e escrita) tem requisito explícito de escopo
  por `id_empresa`? [Spec §FR-007/FR-020, Contract (todos os endpoints)] {auto} —
  contract.md abre com "escopo por `id_empresa` via `resolverContextoEntidade`"
  como regra transversal, repetida implicitamente em cada endpoint.
- [x] CHK018 - O padrão de resposta para recurso de outra empresa está definido
  (404 vs. 403) e é consistente com a decisão de segurança do S5 anterior (evitar
  enumeração)? [Consistência, Contract §intro, Research §S4/A01] {auto} —
  "404-fora-do-escopo é o padrão (Decision 11 do S5)... nunca 403 que vaze
  existência", citado tanto no contrato quanto no mandato A01 do research.
- [x] CHK019 - A unicidade do identificador único (`id_externo`) está corretamente
  escopada por empresa (não global), evitando que o 409 de duplicidade vaze
  existência de uuid em outra empresa? [Spec §FR-013, Research §A01] {auto} —
  "uuid único **por empresa**... o 409 de duplicidade não vaza uuid de outra
  empresa" é afirmado explicitamente como consequência da constraint
  `UNIQUE (id_empresa, id_externo)`.

## Integridade / Rotas Legadas Inertes (A08)

- [x] CHK020 - O requisito de inércia em produção (FR-023) está ancorado num
  padrão já auditado e aprovado (não uma proposta nova não testada)? [Spec
  §FR-023, Research §Decision 7, MEMORY "issue #62 RESOLVIDA"] {auto} — research
  cita "o padrão do `envio-gate.js` já é a referência aprovada (issue #62)"; a
  memória do projeto confirma que esse padrão já foi validado em produção com
  E2E dedicado.
- [x] CHK021 - Existe um cenário de validação dedicado a confirmar que a env
  condicional realmente resulta em comportamento idêntico em produção (não apenas
  a afirmação textual do requisito)? [Cobertura, Quickstart §Scenario 9] {auto} —
  Scenario 9 exige confirmação de "nenhuma env nova... nenhuma migration aplicada
  em chatmasterveloz... tela legada inalterada" como passo de validação explícito.

## Notes

- Items `{auto}` já vêm resolvidos pelo agente (`[x]` com citação, ou marcador
  `[Gap]`/`[Ambiguity]`).
- Items `{humano}` ficam `[ ]` aguardando decisão do dono do produto/segurança.
- 2 gaps reais identificados: CHK003 (falta caso de teste explícito de injeção
  no gate de fechamento da Fase B) e CHK011 (expiração/entropia do token de reset
  não quantificadas). Nenhum é `critical`/`high` novo além dos 4 mandatos S1-S4 já
  levantados pelo gate `owasp-security` na onda-003 (research.md confirma
  "Resultado: PASS — nenhum finding critical/high"); ambos são refinamentos de
  mensurabilidade dos mandatos MEDIUM/LOW já aceitos, recomendados para
  `create-tasks` incluir como critério de aceite explícito das tasks de WS-B e
  WS-C (credencial), não para reabrir o gate.
