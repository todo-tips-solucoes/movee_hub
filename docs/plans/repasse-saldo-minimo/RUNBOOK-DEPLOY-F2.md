# Runbook de deploy — F2: aprovação restrita e trava de papel restrito

> ⚠️ **HISTÓRICO — não seguir como runbook de execução.** O operador decidiu
> (2026-09-27, block-010/dec-093) entregar F1+F2+F3 num **PR único e um deploy único**.
> A ordem de deploy e o rollback vigentes estão em
> [`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md). Este documento fica só pelo valor histórico
> de "o que muda"/gates/revisão adversarial/decisões de F2 — **não execute a "Ordem de
> deploy" abaixo**.

Feature: [`repasse-saldo-minimo`](../../specs/repasse-saldo-minimo/spec.md), FASE 2
(`docs/specs/repasse-saldo-minimo/tasks.md`). Migration com trava de banco (RLS +
`REVOKE`) e papel novo (`financeiro_aprovador`) — a execução em produção é **sempre do
operador**, ou do agente só com autorização explícita **por passo** (uma etapa não
autoriza a seguinte), sob os 5 gates de [`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md).

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge clientes
> reais (`app.moveelog.com.br`). As tabelas do hub em produção vivem **dentro do
> `chatmasterveloz`** (container `pgadmin_db`) — a migration deste runbook roda no
> banco de produção, não num ambiente isolado `hub-*`.

## O que muda

- **Permissão `adiantamentos.pagamento_confirmar`** deixa de pertencer a `financeiro` e
  `admin_entidade` — passa a existir **só** em `admin_plataforma` e no papel novo
  `financeiro_aprovador` (0097). Efeito direto: `POST /repasse/:periodo/fechar`,
  `POST /repasse/:periodo/movimentos`, `POST /lotes/:id/confirmacao`,
  `POST /lotes/:id/retorno` passam a recusar 403 `PERMISSAO_NEGADA` para quem hoje é só
  `financeiro`/`admin_entidade` — **essas duas pessoas perdem a capacidade de aprovar
  pagamento/fechar apuração no ar** até receberem o papel `financeiro_aprovador`
  (CHK023, ver pré-condições).
- **Papel novo `financeiro_aprovador`** (escopo `entidade`): cópia das permissões
  vigentes de `financeiro` + `adiantamentos.pagamento_confirmar`. Quem hoje é
  `financeiro` e deve continuar aprovando precisa GANHAR este papel (trocar de papel ou
  ganhar um segundo vínculo — decisão do operador, não deste runbook).
- **Papéis restritos** (`lib/hub-papeis-restritos.js` + `hub_papel_restrito()` SQL):
  `admin_plataforma` e `financeiro_aprovador` só podem ser concedidos, alterados ou
  desativados no vínculo de OUTRO usuário por quem já é `admin_plataforma`. Vale nas 4
  rotas de escrita de vínculo (`POST /usuarios`, `PUT /usuarios/:id`,
  `POST /usuarios/:id/vinculos`, `PUT /usuarios/:id/vinculos/:vinculoId`) e na RLS de
  `UsuarioEntidade` (defesa que vale de verdade — a checagem Node é early-exit de UX).
  Toda recusa grava `usuario_vinculo_negado` na Auditoria.
- **`REVOKE INSERT, UPDATE ON "Papel", "PapelPermissao", "Permissao", "Modulo" FROM
  authenticated`** — a matriz RBAC só muda por migration ou por
  `rpc/hub_papel_permissao_set` (SECURITY DEFINER), nunca por escrita direta com o JWT
  de um usuário comum.
- **UI** (`app/hub/dashboard/usuarios/page.tsx`): o seletor de papel esconde
  `admin_plataforma`/`financeiro_aprovador` de quem não é `admin_plataforma`.
- **Sem mudança de shape de resposta** nas rotas de repasse/usuários — só o veredito de
  autorização muda. Nenhuma tela nova.

## Gates do rito do ciclo git (antes do PR — CLAUDE.md "Rito do ciclo git")

Ver `RUNBOOK-DEPLOY-F1.md` — os gates completos (tsc, suíte unit, `next build`, lint vs.
baseline) são medidos **uma vez para a feature inteira** (F1+F2+F3 num PR só). Específico
de F2, medido na onda-020 (2026-09-27) e RE-MEDIDO na onda-022 (2026-09-27) pós-correção
do achado crítico de 2.5.7 (block-009/dec-075/dec-077):

| Gate | Comando | Resultado |
|---|---|---|
| Integração RBAC (driver novo) | `infra/hub/testes/hub-financeiro-aprovador-rbac-integration.sh` | onda-020: 33 PASS / 0 FAIL (2.5.1/2.5.2/2.5.4/2.5.5). **onda-022 (com o bloco CROSS-TENANT novo)**: 42 PASS / 0 FAIL, reproduzido 2× (2.5.1/2.5.2/2.5.4/2.4.4-cross-tenant/2.5.5) |
| Integração CRUD geral (regressão) | `node --test tests/hub-usuarios.test.js` (`hub-usuarios-integration.sh`) | onda-022: 1/1 PASS, sem regressão pós-correção |
| Controle negativo (furo, antes/depois 0097) | `infra/hub/testes/hub-financeiro-aprovador-furo.sh` | furo demonstrado ANTES da 0097 (HTTP 201/409 "passa"), bloqueado DEPOIS (HTTP 4xx) |
| Unit da trava | `node --test tests/hub-usuarios-trava-unit.test.js` | onda-020: 15/15 (guard ligado); 7/15 falhas com o guard stubado (prova do furo original). **onda-022 (+ 4 testes CROSS-TENANT)**: 19/19 PASS com a correção; controle negativo — revertendo só a trava para a regra antiga, 16 PASS / **3 FAIL** nos 3 asserts CROSS-TENANT (prova que os testes pegam a regressão) |
| Unit geral (`npm test`) | `npm test` | onda-022: 1622 PASS / 0 FAIL (sem regressão em nenhuma outra suíte por tocar `lib/hub-rbac-cache.js`) |
| Revisão adversarial do diff (2.5.7) | subagente independente sobre os 3 pontos de escrita, `USING` sem erro, `REVOKE` | ver seção "Revisão adversarial" abaixo |
| Revisão adversarial da CORREÇÃO (onda-022) | subagente independente, sem contexto, só sobre o diff desta correção | ver seção "Revisão adversarial da correção (onda-022)" abaixo |
| `next build`/suíte completa/lint | — | cobertos pelo gate único da feature inteira (ver RUNBOOK-DEPLOY-F1.md) |

## Revisão adversarial (tasks.md 2.5.7)

Rodada nesta onda via subagente independente (sem contexto desta execução), focando
exatamente nos 3 pontos pedidos pela task: os três pontos de escrita (2.4), a recusa
`USING` sem erro (linha intacta, não 403) e o `REVOKE` (2.2.6) sem quebrar seed/RPC
legítima. **Preencher aqui o veredito e os achados antes de abrir o PR** — se o veredito
for `achado-critico-permissao`, o achado é bloqueio humano e este runbook não avança até
ele ser resolvido (registrar a resolução nesta seção).

> **Veredito (onda-021, 2026-09-27): `achado-critico-permissao`. Este deploy NÃO deve
> avançar até o achado abaixo ser corrigido e re-testado (bloqueio humano `block-009`/
> `dec-075`, aguardando resposta do operador).**
>
> **Achado crítico**: `PUT /usuarios/:id` (`hub-usuarios.js:385-419`) detecta se o
> ALVO tem vínculo ativo com papel restrito usando uma query filtrada pela **entidade
> ativa do CHAMADOR** (`filtroEscopo = ctx.isAdminPlataforma ? '' :
> &empresa_id=eq.${ctx.entidadeAtiva}`). Um `admin_entidade` da Entidade B só enxerga
> os vínculos do alvo NA ENTIDADE B — se esse mesmo alvo tem, em OUTRA entidade (A),
> um vínculo **ativo** `admin_plataforma`/`financeiro_aprovador`, a trava não dispara e
> a senha é trocada por quem não deveria poder. `FR-012a` (spec.md) não tem ressalva de
> entidade — a implementação (2.4.4) diverge do requisito. `Usuario` não tem RLS: essa
> checagem Node é a **única** defesa deste caminho (diferente dos outros 3 pontos de
> escrita, também protegidos pela RLS da 0097). **Este deploy fica bloqueado até 2.4.4
> ser corrigido** (query de detecção de papel restrito precisa olhar TODOS os vínculos
> ativos do alvo, não só os da entidade ativa do chamador) e 2.5.4 re-testado com um
> cenário cross-tenant.
>
> Achados não-críticos (baixo, não bloqueiam): (1) `usuarios/page.tsx:594` usa
> `permissoes.includes('admin.gerenciar')` como proxy para decidir se esconde papéis
> restritos no seletor, em vez da claim real `admin_plataforma` — só UX, sem risco de
> segurança; (2) `PUT .../vinculos/:vinculoId` pode devolver 404 em vez de 403 num caso
> teórico de a RLS filtrar 0 linhas mesmo após a trava Node já ter passado — falha
> fechada, sem risco, só semântica de erro imprecisa.
>
> Sem achado: os outros 3 pontos de escrita (`POST /usuarios`, `POST /:id/vinculos`,
> `PUT /:id/vinculos/:vinculoId`), a recusa `USING` sem erro (confirmado: filtra
> silenciosamente 0 linhas, quem levanta `42501` é o `WITH CHECK`; o Node trata
> `atualizados[0] === undefined` como falha, nunca confunde com sucesso), e o `REVOKE`
> 2.2.6 (sem outro `INSERT`/`UPDATE` cru encontrado em `Papel`/`PapelPermissao`/
> `Permissao`/`Modulo`; `hub-papeis.js` só escreve via `rpc/hub_papel_permissao_set`;
> `0097-rollback.sql` recusa com vínculo ativo `financeiro_aprovador`).

> **RESOLVIDO (onda-022, 2026-09-27)**: correção aplicada e re-testada — ver seção
> "Revisão adversarial da correção (onda-022)" abaixo para o veredito independente
> sobre o diff da correção em si, e a tabela de gates acima para os números
> (unit/integração/controle negativo). Os 2 achados não-críticos acima permanecem
> registrados aqui, sem correção obrigatória (decisão do operador ao responder
> `block-009`).

## Revisão adversarial da correção (onda-022)

Rodada nesta onda via um SEGUNDO subagente independente (sem contexto desta execução,
sem ver o veredito de 2.5.7 acima), focado SÓ no diff desta correção: a nova função
`alvoTemPapelRestritoAtivo` (`lib/hub-rbac-cache.js`), seu uso em `PUT /usuarios/:id`
(`routes/hub-usuarios.js`), os testes unit `CROSS-TENANT` novos, e o bloco "2.4.4
CROSS-TENANT" do driver de integração.

> **Veredito (onda-022, 2026-09-27, dec-082): `clean`** — nenhum achado crítico de
> permissão. O subagente confirmou, lendo os arquivos e as migrations diretamente
> (não só a descrição da tarefa):
> - A correção fecha o furo: bateu `alvoTemPapelRestritoAtivo` contra a policy REAL
>   `usuarioentidade_select_proprio` (`0006_rls_policies.sql:74-76`,
>   `USING (usuario_id = sub::int)`) e confirmou que ela devolve os vínculos do alvo em
>   QUALQUER empresa; `usuarioId` já passa por `Number.isInteger` antes de chegar na
>   função (sem risco de injeção); erro de rede sobe sem `catch` e cai no try/catch da
>   rota → 500 (fail-closed de verdade, não fail-open); usuário sem nenhum vínculo
>   segue sem bloquear (comportamento inalterado, correto).
> - Nenhum problema novo introduzido: o padrão `sub=alvo` já existia em
>   `usuarioEhAdminPlataforma`; a claim fica confinada à função, não vaza para
>   auditoria/cache; decisão de não cachear é a direção certa (cache seria fail-open
>   aqui). Único ponto de atenção (não crítico): 1 consulta extra ao PostgREST por
>   `PUT /usuarios/:id` — latência desprezível numa rota administrativa.
> - Concorda que os outros 3 pontos de escrita não têm o furo: confirmou no banco que
>   `0097_papel_financeiro_aprovador.sql:99-126` cria RLS real
>   (`usuarioentidade_insert_admin`/`usuarioentidade_update_admin`) para eles, e que
>   `Usuario` (a tabela do furo original) não tem `ENABLE ROW LEVEL SECURITY` em
>   nenhuma migration — por isso a checagem em Node de `PUT /:id` é mesmo a única
>   defesa.
> - Testes convincentes, não são "vitórias fáceis": o mock em
>   `hub-usuarios-trava-unit.test.js` reflete fielmente o comportamento real (ignora
>   empresa, filtra só por `ativo`+papel restrito) e as asserções checam status 403 E
>   que o PATCH em `Usuario` nunca foi chamado; a integração monta o isolamento real
>   via Postgres/RLS/PostgREST com build real do backend.
> - **1 achado não-crítico (baixo)**: `hub-usuarios.js` (bloco `auditarPapelRestrito`
>   de `PUT /usuarios/:id`) não preenche `papelAtualId`/qual entidade tinha o vínculo
>   restrito (fica `null`) — diferente das rotas de vínculo, que preenchem esses
>   campos. Não é falha de segurança (a negação e o registro acontecem corretamente),
>   só reduz a forense pós-fato de "qual papel/entidade disparou a trava". **Registrado
>   aqui, sem correção obrigatória** (mesmo tratamento dos 2 achados baixos da 2.5.7
>   acima — decisão do operador).

## Pré-condições operacionais (confirmar com o operador antes do deploy)

1. **CHK022 — o único `admin_plataforma` atual é quem deveria ser.** Conferir com
   `SELECT u.email FROM "UsuarioEntidade" ue JOIN "Usuario" u ON u.id=ue.usuario_id
   JOIN "Papel" p ON p.id=ue.papel_id WHERE p.nome='admin_plataforma' AND ue.ativo;`
   no `chatmasterveloz` — se houver mais de uma pessoa ou alguém inesperado, resolver
   ANTES do deploy (essa pessoa passa a ser a ÚNICA que pode conceder papel restrito).
2. **CHK022 (parte 2) — quem recebe `financeiro_aprovador` no go-live.** O operador
   decide quem, hoje `financeiro`/`admin_entidade`, deve continuar aprovando
   pagamento/fechamento — essa pessoa precisa de um vínculo com `financeiro_aprovador`
   concedido pelo `admin_plataforma` **logo após** a migration (a concessão em si só
   funciona depois que 0097 cria o papel).
3. **CHK023 — as pessoas que perdem `adiantamentos.pagamento_confirmar` foram
   avisadas.** Quem hoje é `financeiro`/`admin_entidade` e usa essa permissão vai
   receber 403 nas 4 rotas de aprovação a partir do deploy, até ganhar
   `financeiro_aprovador` (passo 2). Avisar antes — não depois que alguém tentar fechar
   a apuração e falhar.
4. **CHK021 — `JWT_SECRET` ≠ `PGRST_JWT_SECRET` em produção**, sem expor os valores —
   ex. comparação de hashes (`sha256sum` de cada um, nunca o valor em texto):
   ```
   docker exec <container-backend> sh -c 'echo -n "$JWT_SECRET" | sha256sum'
   docker exec <container-postgrest-ou-pgadmin_db> sh -c 'echo -n "$PGRST_JWT_SECRET" | sha256sum'
   ```
   Os dois hashes devem ser **diferentes** — se forem iguais, a defesa RLS de
   `UsuarioEntidade` (que depende do backend assinar claims que o PostgREST valida com
   segredo distinto) está comprometida; parar e escalar antes de aplicar 0097.
5. **0 lote pendente no dia e fora da janela de fechamento** — nenhuma apuração sendo
   fechada nem lote de pagamento em processamento no momento do deploy (mesmo cuidado
   de F3 — `SELECT * FROM "AdiantamentoLote" WHERE status IN ('EXPORTADO')` e conferir
   se há fechamento em andamento).

## Ordem de deploy (tasks.md 2.6.1)

**Backend primeiro** (trava de rota) — se o backend novo (com `papelEhRestrito`) subir
ANTES da migration 0097, a trava Node já funciona (ela não depende de schema: é uma
constante hardcoded), mas a defesa de verdade (RLS) só entra com a migration; um
backend velho rodando DEPOIS da 0097 continua funcionando (a RLS só restringe quem já
não deveria poder, não quebra ninguém autorizado) — então a ordem correta minimiza a
janela sem a defesa de banco:

1. **Backend** (imagem com `lib/hub-papeis-restritos.js` + as 4 rotas travadas):
   ```
   docker service update --with-registry-auth --image <nova-imagem> envio-massa-homologacao_backend_homologacao
   ```
2. **Migration `0097_papel_financeiro_aprovador.sql`** no `chatmasterveloz`
   (trava de banco + papel novo, **mesma transação** — o arquivo já é uma migration
   única, não precisa split):
   ```
   CID=$(docker ps -qf name=pgadmin_db | head -1)
   docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
     < infra/hub/migrations/0097_papel_financeiro_aprovador.sql
   docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0097_papel_financeiro_aprovador.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
   ```
   (`SchemaMigration` pode mentir se a migration não passou por aqui — conferir que o
   papel `financeiro_aprovador` realmente existe e que a permissão saiu de
   `financeiro`/`admin_entidade`, não só o registro — ver smoke test.)
3. **`SIGUSR1` no PostgREST de produção** (⚠️ há DOIS PostgREST no host — o de
   produção é o `pgadmin_postgrest`, nunca o do hub isolado):
   ```
   docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest | head -1)
   ```
4. **`frontend_v2`** (seletor de papel escondendo papéis restritos):
   ```
   docker service update --with-registry-auth --image <nova-imagem> envio-massa-homologacao_frontend_v2_homologacao
   ```
5. **Imediatamente após** — conceder `financeiro_aprovador` à pessoa decidida na
   pré-condição 2 (pela tela de Usuários, logado como o `admin_plataforma` único).

## Plano de rollback (tasks.md 2.6.3)

1. **Antes de aplicar**: `pg_dump -t` de `PapelPermissao` e `UsuarioEntidade` (estado
   RBAC, para poder auditar o que mudou se algo der errado):
   ```
   CID=$(docker ps -qf name=pgadmin_db | head -1)
   docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"PapelPermissao\"" -t "\"UsuarioEntidade\""' \
     > ~/rbac-antes-0097.sql
   ```
2. **Rollback de banco**: `infra/hub/testes/sql/0097-rollback.sql` (task 2.3.1) — remove
   o papel `financeiro_aprovador`, devolve as policies ao corpo `0039`, devolve
   `GRANT INSERT, UPDATE` de `0003:58` nas quatro tabelas. ⚠️ **Recusa** (mensagem
   clara) se existir vínculo ATIVO com `financeiro_aprovador` — nesse caso, o
   `admin_plataforma` precisa desativar/trocar esses vínculos antes de rodar o
   rollback (decisão humana, não automática — testado em `0097-rollback.test.sql`,
   2.3.3).
3. **Rollback de imagem**: anotar a imagem anterior ANTES de atualizar —
   `docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'`
   — e `docker service update --with-registry-auth --image <anterior> <serviço>` para
   backend e/ou frontend_v2, o que tiver sido atualizado.
4. Depois de qualquer rollback de SQL, repetir o `SIGUSR1` no `pgadmin_postgrest`.
5. **Se o rollback do backend for feito SEM o rollback do SQL** (ex.: só a imagem deu
   problema): a RLS/REVOKE de 0097 continuam valendo — um backend antigo sem
   `papelEhRestrito` ainda é protegido pela RLS (defesa em profundidade), mas
   `financeiro`/`admin_entidade` seguem sem `adiantamentos.pagamento_confirmar` até o
   rollback de banco também rodar.

## Smoke test pós-deploy (tasks.md 2.6.4)

1. **`financeiro` (ou `admin_entidade`) puro tenta fechar apuração** —
   `POST /api/v1/adiantamentos/repasse/<periodo>/fechar {"confirmacao":true}` —
   esperado **403 `PERMISSAO_NEGADA`**.
2. **`financeiro_aprovador` (a pessoa da pré-condição 2) tenta a mesma chamada** —
   esperado **2xx ou erro de negócio** (nunca `PERMISSAO_NEGADA`/403 por autorização).
3. **Tela de Usuários**: logado como `admin_entidade`, confirmar que o seletor de papel
   NÃO lista `admin_plataforma`/`financeiro_aprovador`; logado como `admin_plataforma`,
   confirmar que lista os dois.
4. **Auditoria**: se algum teste do passo 1/3 tentar uma ação restrita de propósito,
   confirmar a linha `usuario_vinculo_negado`/motivo relevante na tela de Auditoria.
5. Prova de bundle do `frontend_v2` (CLAUDE.md "Prova" — HTTP 200 não prova nada):
   buscar no bundle servido da tela de Usuários uma string desta entrega (ex.: ausência
   das opções restritas no `<select>` para o usuário de teste `admin_entidade`, via DOM
   real — não screenshot).

## Os 5 gates de produção

1. **Autorização explícita** do operador para este deploy específico.
2. **Janela combinada** — fora de qualquer fechamento de apuração em andamento
   (pré-condição 5) e depois de as pessoas afetadas (CHK023) terem sido avisadas.
3. **Plano de rollback** — seção acima, com `pg_dump -t` feito ANTES de aplicar.
4. **Aplicar**: `docker service update --with-registry-auth --image ...`. **Nunca**
   `docker stack deploy`.
5. **Smoke test** — seção acima, antes de declarar OK.

## Referências

- [spec.md](../../specs/repasse-saldo-minimo/spec.md) — FR-006..FR-012b
- [contracts/hub-api.md](../../specs/repasse-saldo-minimo/contracts/hub-api.md)
- [quickstart.md](../../specs/repasse-saldo-minimo/quickstart.md) — cenários F2.0..F2.6
- [checklists/security.md](../../specs/repasse-saldo-minimo/checklists/security.md) — CHK021/CHK022/CHK023
- [tasks.md](../../specs/repasse-saldo-minimo/tasks.md) FASE 2
- [EVIDENCIA-2.5-F2-RBAC-INTEGRATION.md](EVIDENCIA-2.5-F2-RBAC-INTEGRATION.md)
- [EVIDENCIA-F2-CONTROLE-NEGATIVO.md](EVIDENCIA-F2-CONTROLE-NEGATIVO.md)
- [RUNBOOK-DEPLOY-F1.md](RUNBOOK-DEPLOY-F1.md) / [RUNBOOK-DEPLOY-F3.md](RUNBOOK-DEPLOY-F3.md) (mesma feature)
