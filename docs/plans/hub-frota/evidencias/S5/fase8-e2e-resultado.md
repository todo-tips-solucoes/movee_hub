# FASE 8 — E2E hub-motoristas contra hub-homolog (evidências)

Execução: onda-012 do `/feature-00c` (short_name `hub-motoristas`), 2026-07-08.
Ambiente: hub-homolog ISOLADO e PERSISTENTE (`https://hub-homolog.todo-tips.com:8443`),
recursos `hub-*`/`hub_*` (exceção G1). Produção `envio-massa-homologacao_*` conferida
1/1 (4 serviços) ANTES e DEPOIS de todo o trabalho — nenhuma mudança.

## 0. Deploy (pré-requisito)

Achado: `hub_homolog_backend`/`hub_homolog_frontend` rodavam imagem **sem** as
rotas/telas do S5 (FASES 1-7 nunca haviam sido deployadas no ambiente
persistente — só testadas em `hub-test-*` efêmero). Migrations 0019-0024 já
estavam aplicadas no banco (confirmado via `SchemaMigration`).

- `DOCKER_BUILDKIT=0 docker compose ... build --memory=2g backend` +
  `dc up -d --wait backend` → `routes/hub-motoristas.js` presente, rota
  `/:id/vinculo` confirmada via grep no container.
- `DOCKER_BUILDKIT=0 docker compose ... build --memory=2g frontend` +
  `dc up -d --wait frontend` → build do Next lista `/hub/dashboard/motoristas`
  e `/hub/dashboard/motoristas/[id]` entre as rotas geradas.
- `ModuloEntidade` (modulo `motoristas`, id=2) ativado para empresa 9001 e 9002
  (nav do shell — backend não gateia por módulo, só permissão RBAC).
- Produção (`envio-massa-homologacao_*`) 4/4 serviços 1/1 antes e depois;
  smoke `/hub/login` = 200 antes e depois do deploy.

## 1. Seeds

- Reimport real via `POST /importacoes` (empresa 9001, QA
  `qa.importacoes@moveelog.local`): 208 linhas de faturamento válidas → 207
  `Entregador` novos (200 "fillers" com subpraça cíclica entre 4 valores +
  7 especiais: multi-área, Adriano Cardoso Kfouri, 2º candidato a vínculo,
  Roberto Nunes Ferreira, par editado/controle p/ reimportação, roundtrip).
- +2 `Entregador` sem nenhum fato via INSERT direto (SQL) — total **209**
  `Entregador` na empresa 9001 (Cenário 1: "≥200 ... alguns sem nenhum fato").
- `ContaMotorista`/`EmpresaGrupoMovee` já vinham da FASE 2
  (`infra/hub/scripts/gen-seeds.py`, `hub_motoristas_seed.sql`) — 12 variantes
  do alvo "Adriano Cardoso Kfouri", 6 ruído, 2 quase-idênticos entre si.
- 2 usuários QA novos (persistentes, mesmo padrão `qa.*@moveelog.local`):
  `qa.motoristas.leitura@moveelog.local` (papel `leitura`, empresa 9001) e
  `qa.motoristas.outraempresa@moveelog.local` (papel `admin_entidade`, empresa
  **9002**, deliberadamente FORA de `EmpresaGrupoMovee` — Cenário 9/10).

## 2. Resultado dos cenários (API real via HTTPS, TLS self-signed)

Todos os PASS abaixo são chamadas HTTP reais contra
`https://hub-homolog.todo-tips.com:8443/api/v1`, sem mock.

```
PASS: C1: filtro nome retorna so correspondencias (items<=pageSize)
PASS: C1: total reflete contagem real no servidor (200 fillers)
PASS: C1: pageSize respeitado
PASS: C1: comVinculo=false -> maioria (209, nenhum vinculado ainda)
PASS: C1: termo inexistente -> items vazio
PASS: C1: termo inexistente -> total 0
PASS: C2: area=Zona Sul encontra o entregador multi-area
PASS: C2: area=Centro TAMBEM encontra o mesmo entregador
PASS: C2: detalhe lista as 2 areas
PASS: C2 (corrigido): Centro primeiro nas areas
PASS: C3: PATCH nome -> 200
PASS: C3: nomeEditadoManualmente true
PASS: C3: GET subsequente reflete novo nome
PASS: C3: PATCH ativo -> 200
PASS: C3: some do ativo=true, aparece em ativo=false
PASS: C3: PATCH com usuario leitura -> 403
PASS: C3: nome NAO foi alterado pela tentativa 403
PASS: C4: PATCH nome -> 200 / flag vira true
PASS: C4: nome editado manualmente SOBREVIVE a reimportacao (trigger 0019)
PASS: C4 (controle): SEM edicao previa, reimportacao ATUALIZA nome normalmente
PASS: C5: entidadeElegivel true / items<=10 (top N) / conta alvo presente
PASS: C6: leitura de /sugestoes NAO cria vinculo (efeito colateral zero)
PASS: C6: POST vinculo com conta sugerida -> 200 / vinculo gravado
PASS: C7: busca manual (com entregadorId) encontra conta por termo
PASS: C7: entregadorId ausente -> 422
PASS: C7: confirmar vinculo via busca manual -> 200
PASS: C8: POST vinculo duplicado -> 409 conta_ja_vinculada / B continua NULL
PASS: C8: substituicao de vinculo em uma unica acao -> 200 (sem desvincular antes)
PASS: C8: DELETE em Entregador sem vinculo -> 204 idempotente (CHK006)
PASS: C9: sugestoes fora do grupo -> 200, entidadeElegivel:false, items:[]
PASS: C9: contas-elegiveis fora do grupo -> 200 (sem erro), items:[]
PASS: C9: POST vinculo forcado fora do grupo -> 422 entidade_fora_do_grupo
PASS: C10: empresa 9002 acessando entregador da 9001 -> 404
PASS: C10: empresa 9002 listando -> total 0 (RLS + filtro backend)
PASS: C11: shape camelCase (nomeEditadoManualmente, sem snake_case)
PASS: DESVINC: DELETE vinculo real -> 204 / GET volta vinculo:null
```

Auditoria (`Auditoria`, ações `motorista.*`) — contagem final consistente
1-para-1 com as ações confirmadas acima:

```
motorista.editado      | 3   (PATCH nome roundtrip, PATCH ativo roundtrip, PATCH nome cenario 4)
motorista.vinculado    | 3   (Adriano inicial, Adriano substituicao, Roberto/Beatriz)
motorista.desvinculado | 1   (Adriano desvinculo final; o DELETE idempotente em
                               quem nunca teve vinculo NAO gerou entrada — SC correta)
```

**Nota de higiene de dados (autodetectada, não é bug de produto)**: o 1º
rascunho do script de reimportação do Cenário 4 calculou o UUID sintético
errado (`uuid(9002)` em vez de `uuid(9006)`), colidindo com o `id_externo` do
Entregador "Adriano Cardoso Kfouri" (id 305) e sobrescrevendo seu nome
temporariamente. Identificado ao revisar a screenshot do Cenário 12
(nome inesperado no detalhe), corrigido via UPDATE direto (nome restaurado)
— o mecanismo de proteção do trigger em si foi corretamente validado com o
par 308/309 no 2º rascunho (UUIDs corretos), então o achado não invalida a
prova do Cenário 4.

## 3. Cenário 11 — roundtrip real (shape)

`PATCH /motoristas/:id` → `GET /motoristas/:id`: campo `nomeEditadoManualmente`
presente (camelCase), campo `nome_editado_manualmente` (snake_case) ausente —
sem drift PostgREST↔API. `GET /motoristas/contas-elegiveis` confirma
`cnpjPrestadorMascarado` mascarado (`62.***.***/6284-**`) mesmo para o dono
`admin_entidade`.

## 4. Cenário 12 — branding claro/escuro

Screenshots reais (Playwright, `tests/e2e-hub-cenario12/`, login inline QA
`qa.importacoes@moveelog.local`) em `docs/plans/hub-frota/evidencias/S5/`:

- `cenario12-lista-light.png` / `cenario12-lista-dark.png` — lista paginada
  (209 registros, "Página 1 de 11"), filtros nome/situação/área/vínculo,
  banner "HOMOLOGAÇÃO — dados fictícios".
- `cenario12-detalhe-light.png` / `cenario12-detalhe-dark.png` — detalhe com
  indicadores (lançamentos/turnos/atividade), painel "Conta de acesso
  vinculada" com botão Vincular.

Paleta EntreGô 2.0 em ambos os temas, sem cor hardcoded visível, tema
alternado via `localStorage.theme` antes da navegação (mesmo mecanismo do
Cenário 11 da S4).

## 5. SC-007 / FR-015 / FR-016 — zero impacto na base do app motorista

Verificado por arquitetura (não só ausência de chamada no código):
`hub_homolog_backend` só fala com seu próprio PostgREST interno
(`POSTGREST_URL=http://postgrest:3000`, rede `hub_internal`); nenhuma
referência a `chatmasterveloz`/`pgadmin_db` em `infra/hub/compose.hub.homolog.yml`
nem em `routes/hub-motoristas.js`/`lib/hub-motoristas-*.js` (grep vazio). O
hub usa a tabela própria `ContaMotorista` (schema `hub_homolog`), distinta e
desconectada da tabela `Motorista` de `chatmasterveloz` usada pelo app
motorista real — nenhum caminho de rede ou de código liga um ao outro.

## 6. Pendências (ver tasks.md 8.2.4)

Achado de produto (não corrigido nesta onda, escalado — `block-004`): o
trigger `trg_entregador_protege_nome` (migration 0019) bloqueia um 2º `PATCH`
de nome do próprio operador após a 1ª edição manual, não só a reimportação
automática (confirmado empiricamente no Cenário 4 acima). Decisão de produto
pendente do operador antes de qualquer mudança de schema.
