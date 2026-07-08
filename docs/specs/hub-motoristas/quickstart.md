# Quickstart — Cenários de teste (hub-motoristas)

Ambiente: **hub-homolog ISOLADO** (VPSTodo, recursos `hub-*`). NUNCA produção.
`ContaMotorista`/`EmpresaGrupoMovee` populadas por seed sintético
(`infra/hub/scripts/gen-seeds.py`, extensão desta fase) — nunca dado real de
`Motorista`/`chatmasterveloz`. `Entregador`/fatos herdam os seeds já usados na
S4.

---

## Cenário 1 — Localizar e revisar (US1)

1. Seed: ≥ 200 `Entregador` para a entidade ativa, com `FaturamentoLancamento`/
   `PerformanceTurno` associados variando `subpraca`, alguns sem nenhum fato.
2. `GET /motoristas?nome=<trecho>` → **Expected**: `items` só com
   correspondências; `total`/`page`/`pageSize` refletem o total real no
   servidor (não o carregado na tela).
3. `GET /motoristas?comVinculo=false` → **Expected**: maioria dos registros
   (estado normal logo após a S4), sem aviso incômodo.
4. `GET /motoristas/:id` de um Entregador com fatos em 2 `subpraca` distintas
   → **Expected**: `resumo.totalFaturamento`/`totalPerformance` batem com a
   contagem real (all-time); `areas` lista as 2 subpraças, a mais recente
   primeiro.
5. `GET /motoristas?nome=<termo-inexistente>` → **Expected**: `items: []`,
   `total: 0` — estado vazio claro, não erro.

## Cenário 2 — Múltiplas áreas de atuação (Clarification Q2 / FR-002 / FR-003)

1. Seed: 1 `Entregador` com fatos em `subpraca="Zona Sul"` (mais antigo) e
   `subpraca="Centro"` (mais recente).
2. `GET /motoristas?area=Zona Sul` → **Expected**: o Entregador aparece
   (casamento por qualquer área distinta, não só a mais recente).
3. `GET /motoristas?area=Centro` → **Expected**: o MESMO Entregador também
   aparece.
4. `GET /motoristas/:id` → **Expected**: `areas` traz as 2, `Centro` primeiro
   (destaque da mais recente).

## Cenário 3 — Editar nome e situação, sem afetar histórico (US2)

1. `PATCH /motoristas/:id` `{ nome: "Nome Corrigido" }` com papel que tem
   `motoristas.editar`.
   → **Expected**: `200`; `nomeEditadoManualmente: true`; `GET /motoristas/:id`
   subsequente já reflete o novo nome; `Auditoria` ganha `motorista.editado`.
2. `PATCH /motoristas/:id` `{ ativo: false }`.
   → **Expected**: some do filtro `ativo=true`, aparece em `ativo=false`;
   contagens de `resumo` (fatos históricos) **inalteradas**.
3. Repetir 1/2 com papel `leitura` (só `motoristas.consultar`/`.listar`).
   → **Expected**: `403 PERMISSAO_NEGADA`; nenhum controle de edição visível
   na tela (verificação de UI, não só API).
4. Forçar `PATCH` diretamente (contornando a UI) com o mesmo papel `leitura`.
   → **Expected**: `403`, nenhuma alteração ocorre.

## Cenário 4 — Edição manual sobrevive à reimportação (Clarification Q5 / FR-004)

1. `Entregador` com `nome="Nome Antigo"`, `nomeEditadoManualmente=false`.
   `PATCH /motoristas/:id` `{ nome: "Nome Corrigido Manualmente" }`.
   → **Expected**: `200`; flag vira `true`.
2. Rodar novamente o pipeline S4 (`POST /importacoes` reimportando um CSV cujo
   `id_externo` casa com este Entregador, trazendo `recebedor`/
   `pessoa_entregadora` = `"Nome Que Veio Do CSV"`, diferente do editado).
   → **Expected**: `GET /motoristas/:id` continua mostrando `"Nome Corrigido
   Manualmente"` — a reimportação NÃO sobrescreveu (trigger `hub_protege_nome_
   editado_entregador`). Verificar direto no banco (`SELECT nome FROM
   "Entregador" WHERE id=...`) para confirmar que não foi um cache de API.
3. Controle: repetir 1–2 em um Entregador **sem** edição manual prévia.
   → **Expected**: a reimportação atualiza `nome` normalmente (comportamento
   herdado da S4, inalterado).

## Cenário 5 — Sugestão de vínculo por nome (US3 / FR-007 / SC-003)

1. Seed `EmpresaGrupoMovee` com o `id_empresa` da entidade ativa (elegível).
   Seed `ContaMotorista` com uma conta de nome igual/quase-igual a um
   `Entregador` sem vínculo (variando acento/caixa/espaçamento, ex.: Entregador
   `"José da Silva"` vs conta `"jose  da silva"`).
2. `GET /motoristas/:id/sugestoes` → **Expected**: `entidadeElegivel: true`;
   a conta correta está entre `items` (SC-003 — 100% dos casos testados),
   `similaridade` alta, `jaVinculadoA: null`.
3. Seed adicional: várias contas com nomes vagamente parecidos, todas abaixo do
   limiar `0.3`.
   → **Expected**: `items` não inclui essas (corte por limiar mínimo,
   Clarification Q4/block-002), mesmo que isso deixe a lista com menos de 10
   itens.
4. Seed com > 10 contas acima do limiar.
   → **Expected**: `items.length <= 10` (top N — Clarification Q4/block-002),
   ordenado por `similaridade` decrescente.

## Cenário 6 — Confirmação humana obrigatória (US3 / FR-008)

1. A partir do Cenário 5, **não** chamar `POST .../vinculo`.
   → **Expected**: `Entregador.motorista_id` continua `NULL` mesmo após várias
   chamadas a `GET .../sugestoes` (nenhum efeito colateral de leitura).
2. `POST /motoristas/:id/vinculo` `{ contaMotoristaId }` com a conta sugerida.
   → **Expected**: `200`; `Auditoria` ganha `motorista.vinculado`; SOMENTE
   agora `motorista_id` é gravado.
3. Auditar (`GET /auditoria` ou consulta direta) uma bateria dos passos 1–2
   sobre várias pessoas.
   → **Expected**: zero linhas `motorista.vinculado` sem confirmação explícita
   correspondente (SC-004).

## Cenário 7 — Busca manual (US3 / FR-009)

1. Seed uma conta com nome bem diferente do Entregador (sugestão automática
   não a encontraria).
2. `GET /motoristas/contas-elegiveis?q=<termo>` (termo que casa com a conta).
   → **Expected**: a conta aparece, paginada normalmente (sem corte por
   similaridade).
3. Confirmar vínculo via `POST .../vinculo` com o `contaMotoristaId`
   encontrado manualmente.
   → **Expected**: `200`, mesmo fluxo do Cenário 6.

## Cenário 8 — Conflito de vínculo duplo (FR-012)

1. Vincular `contaMotoristaId=X` ao `Entregador A` (`POST .../vinculo`).
2. Tentar vincular o MESMO `contaMotoristaId=X` ao `Entregador B`.
   → **Expected**: `409 CONFLITO` `{ motivo: "conta_ja_vinculada", vinculadaA:
   { entregadorId: A, nome } }`; `Entregador B.motorista_id` permanece `NULL`.
3. Substituir o vínculo do `Entregador A` diretamente por `contaMotoristaId=Y`
   (sem desvincular antes).
   → **Expected**: `200` em uma única ação (FR-013); `A.motorista_id = Y`.
4. `DELETE /motoristas/B/vinculo` (Entregador que nunca teve vínculo).
   → **Expected**: `204`, no-op idempotente, sem erro, sem entrada de
   auditoria vazia.

## Cenário 9 — Entidade fora do grupo Movee (FR-010 / FR-011)

1. Autenticar com uma entidade **ausente** de `EmpresaGrupoMovee`.
2. `GET /motoristas/:id/sugestoes` e `GET /motoristas/contas-elegiveis?q=x`.
   → **Expected**: `200` em ambos, `entidadeElegivel: false`, `items: []` —
   **sem erro**; a tela comunica claramente a ausência de candidatos, mas a
   capacidade de vínculo continua presente na interface.
3. `POST /motoristas/:id/vinculo` forçando um `contaMotoristaId` válido mesmo
   assim.
   → **Expected**: `422 INVALIDO { motivo: "entidade_fora_do_grupo" }` — a
   tentativa é recusada mesmo que a conta exista no banco.

## Cenário 10 — Isolamento multi-tenant (Constitution II)

1. `Entregador` criado no escopo da empresa A. Autenticar como empresa B (fora
   do escopo).
   → **Expected**: `GET /motoristas/:id` de A retorna `404` para B; `GET
   /motoristas` de B não lista o registro de A. Reforçado por RLS
   (`id_empresa = ANY(hub_jwt_escopo_ids())`, herdada de `0015`) + filtro do
   backend.

## Cenário 11 — Roundtrip End-to-End (contrato real, não mock)

1. Chamada REAL ao backend hub: `PATCH /motoristas/:id` seguido de `GET
   /motoristas/:id`, capturando o payload de resposta.
   → **Expected**: shape do JSON casa exatamente o contrato em
   `contracts/motoristas-api.md` (camelCase: `nomeEditadoManualmente`,
   `dataMaisRecente`, `cnpjPrestadorMascarado`), sem drift snake_case↔camelCase
   entre PostgREST e a API.
2. Repetir para `POST /motoristas/:id/vinculo` → `GET /motoristas/:id`.
   → **Expected**: `vinculo.contaMotoristaId`/`vinculo.nome` presentes e
   corretos na resposta do `GET` subsequente (não só no `POST`).

## Cenário 12 — Branding / dark-light das telas novas (SC-008)

1. Autenticar no hub com papel que tem `motoristas.consultar`/`.listar`
   (usuário sintético dedicado, sem tocar dados de outros cenários). Semear
   Entregadores com e sem vínculo, com e sem múltiplas áreas, para dar
   conteúdo real às telas.
2. Alternar o tema via `next-themes` (mesmo mecanismo do Cenário 11 da S4 —
   `attribute="class"`, injetado antes da navegação).
3. Capturar `/hub/dashboard/motoristas` (lista) e
   `/hub/dashboard/motoristas/:id` (detalhe, incluindo o painel de
   sugestões/vínculo) em `light` e `dark`.
   → **Expected**: as 4 telas renderizam na paleta EntreGô 2.0 correta do tema
   ativo; 0 hex/`rgb()`/`hsl()`/`style` inline fora do design system;
   `cnpjPrestadorMascarado` visível mascarado em ambos os temas (nunca CNPJ
   bruto).

**Execução**: mesmo driver/rito do Cenário 11 da S4 (Playwright em imagem
oficial, `--network host`, anti-starvation, verificação de produção
`envio-massa-homologacao_*` antes/depois, cleanup em `trap`). Evidência:
`docs/plans/hub-frota/evidencias/S5/cenario12-{lista,detalhe}-{light,dark}.png`.
