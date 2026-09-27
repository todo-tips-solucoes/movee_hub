# Evidência 2.5.1/2.5.2/2.5.4/2.5.5 — F2 RBAC (repasse-saldo-minimo)

Onda-020, 2026-09-27. Driver novo: `infra/hub/testes/hub-financeiro-aprovador-rbac-integration.sh`
(padrão de `hub-rbac-integration.sh`: `db`+`postgrest`+`mailpit-mock`+`backend`
efêmeros, build real via `DOCKER_BUILDKIT=0 --memory=2g`, `migrate.sh` completo
— inclusive `0097`+`0098`). Projeto `hub-test-*` removido ao final (`--rmi local`),
0 resíduo de container/imagem, `package-lock.json` intacto nos dois projetos.

**Resultado: 33 PASS / 0 FAIL** (duas rodadas — a 1ª achou um defeito de
seed do próprio teste, corrigido; ver nota no fim).

## 2.5.1 (Cenário F2.1) — `financeiro` e `admin_entidade` puros recusados

4 rotas via backend real (`financeiro` e `admin_entidade`, cada um só com o
próprio papel, sem `admin_plataforma`/`financeiro_aprovador`):

| Rota | financeiro | admin_entidade |
|---|---|---|
| `POST /repasse/:periodo/fechar` | 403 `PERMISSAO_NEGADA` | 403 `PERMISSAO_NEGADA` |
| `POST /repasse/:periodo/movimentos` | 403 `PERMISSAO_NEGADA` | 403 `PERMISSAO_NEGADA` |
| `POST /lotes/:id/confirmacao` | 403 `PERMISSAO_NEGADA` | 403 `PERMISSAO_NEGADA` |
| `POST /lotes/:id/retorno` | 403 `PERMISSAO_NEGADA` | 403 `PERMISSAO_NEGADA` |

Confirmado por leitura de código (`middleware/hub-require-permission.js`) que
o gate roda **antes** de qualquer lógica de negócio — por isso `periodo`/`id`
fake não interferem no resultado.

2 RPCs diretas no PostgREST (JWT gerado via `lib/hub-postgrest-jwt.js`, sem
passar pelo backend):

| RPC | financeiro | admin_entidade |
|---|---|---|
| `rpc/hub_adiantamento_repasse_fechar` | HTTP 400, corpo com `PERMISSAO_NEGADA` | idem |
| `rpc/hub_adiantamento_lote_confirmar` | HTTP 400, corpo com `PERMISSAO_NEGADA` | idem |

`RAISE EXCEPTION 'PERMISSAO_NEGADA'` em PL/pgSQL não tem SQLSTATE dedicado →
PostgREST mapeia para HTTP 400 (nunca 403) — confirmado no corpo (`message`/
texto), nunca pelo status isolado.

## 2.5.2 (Cenário F2.2) — `financeiro_aprovador` e `admin_plataforma` passam do gate

Mesmas 6 chamadas, nenhuma delas resultou em `PERMISSAO_NEGADA`:

| Chamada | financeiro_aprovador | admin_plataforma |
|---|---|---|
| fechar | 409 `APURACAO_JA_FECHADA`-família (ordem de fechamento, ver nota) | 409 |
| movimentos | 409 | 409 |
| confirmacao | 404 `NAO_ENCONTRADO` (lote fake) | 404 |
| retorno | 400 `DADOS_INVALIDOS` (corpo fake sem `csvBase64`) | 400 |
| RPC repasse_fechar | 400 `APURACAO_NAO_CONFIGURADA` | 400 `APURACAO_NAO_CONFIGURADA` |
| RPC lote_confirmar | 400 `NAO_ENCONTRADA` (lote fake) | 400 `NAO_ENCONTRADA` |

Todas as 12 verificações confirmam "passou do gate" (erro de negócio, nunca
autorização) — exatamente o que a tarefa pede.

## 2.5.4 (Cenário F2.4) — rotas restritas de usuários pós-0097 (build real)

`admin_entidade` tentando (a) `POST /usuarios/:id/vinculos` com
`papelId=admin_plataforma` e (b) `PUT /usuarios/:id` trocando a senha de um
alvo que **já tem** vínculo ativo `admin_plataforma`:

- (a) 403 `PAPEL_RESTRITO`
- (b) 403 `PAPEL_RESTRITO`
- Auditoria (consulta direta ao banco): 2 linhas `usuario_vinculo_negado`
  com `detalhes->>'motivo' = 'PAPEL_RESTRITO'` para a empresa de teste.

`admin_plataforma` repetindo as duas operações: `201` (vínculo criado) e
`200` (senha trocada).

## 2.5.5 (Cenário F2.5) — papéis comuns sem regressão

`admin_entidade` cria usuário novo com papel `operador` (`201`), troca o
vínculo para `leitura` (`200`), desativa o vínculo (`200`) — nenhuma das três
operações passa pela trava `PAPEL_RESTRITO` (papéis não-restritos).

## Nota sobre 2.1.3 (fecha nesta onda)

`2.1.3` pede rodar `PUT /api/v1/usuarios/:id` (senha de alvo com vínculo
`admin_plataforma`) e "registrar que passa", no contexto da seção "2.1
Controle negativo do furo — roda ANTES da migration 0097". Diferente de
`2.1.2` (RLS direta no PostgREST, que É gated pela migration 0097 — antes
dela a policy não restringe, depois restringe), a trava desta rota é
**`lib/hub-papeis-restritos.js`**, uma constante Node hardcoded
(`PAPEIS_RESTRITOS = ['admin_plataforma', 'financeiro_aprovador']`) que **não
depende de nenhuma migration** — está presente no código a partir do momento
em que a task 2.2.2/2.4.4 foi implementada, independente do schema aplicado.
Rodar `migrate.sh -t 0096` não desliga essa trava (ela nem consulta o banco
para decidir se `admin_plataforma` é restrito — é uma lista fixa no código),
então não existe um estado real "antes" observável por integração para esta
rota específica sem reverter o próprio código da trava.

A prova real do furo (o que existiria SEM a task 2.4 implementada) já foi
feita das duas formas que fazem sentido:
- **PostgREST direto** (a defesa que vale, RLS): `2.1.2`/`2.1.5`, via
  `hub-financeiro-aprovador-furo.sh` — furo demonstrado ANTES da 0097,
  bloqueado DEPOIS.
- **Rota/unit com o guard stubado**: `tests/hub-usuarios-trava-unit.test.js`
  — 7/15 falhas com a trava desligada, 15/15 com a trava ligada (evidência em
  `EVIDENCIA-F2-CONTROLE-NEGATIVO.md`).

O que esta onda acrescenta e que faltava (a integração REAL, com backend
buildado, contra o código ATUAL): confirmado acima em `2.5.4` — a MESMA rota
`PUT /usuarios/:id`, com o mesmo cenário (senha de alvo com vínculo
`admin_plataforma`), responde `403 PAPEL_RESTRITO` de ponta a ponta contra um
Postgres/PostgREST reais. `2.1.3` fecha com essa evidência (não como "passa",
que seria o comportamento pré-fix nunca reproduzível por integração sem
reverter código, mas como "a trava real, de ponta a ponta, está no ar e
funciona").

## Defeito do próprio teste (1ª rodada, corrigido antes da 2ª)

Na 1ª rodada, o alvo usado para `POST /usuarios/:id/vinculos` (concessão de
vínculo **novo**) já tinha, por engano do seed, um vínculo `operador`
pré-existente na mesma entidade — a chamada de `admin_plataforma` (que passa
da trava `PAPEL_RESTRITO` e chega no check de "vínculo já existe") retornou
`409 VINCULO_JA_EXISTE` em vez de `201`. Corrigido removendo o vínculo
pré-seedado desse usuário-alvo (ele existe só como `Usuario` sem vínculo até
o teste criar um). Não é um achado sobre o produto — é um ajuste de dado de
teste.
