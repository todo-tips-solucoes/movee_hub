# Runbook de deploy — F3: saldo mínimo carregado (retenção e transporte)

> ⚠️ **HISTÓRICO — não seguir como runbook de execução.** O operador decidiu
> (2026-09-27, block-010/dec-093) entregar F1+F2+F3 num **PR único e um deploy único**.
> A ordem de deploy e o rollback vigentes estão em
> [`RUNBOOK-DEPLOY.md`](RUNBOOK-DEPLOY.md) (inclui a `0099`, ausente deste documento —
> ver `tasks.md` 4.2). Este documento fica só pelo valor histórico de "o que
> muda"/pré-condições/decisões de F3 — **não execute a "Ordem de deploy" abaixo**.

Feature: [`repasse-saldo-minimo`](../../specs/repasse-saldo-minimo/spec.md), FASE 3
(`docs/specs/repasse-saldo-minimo/tasks.md`). Migration com `DROP FUNCTION`+`CREATE`
em 4 RPCs (mudança de assinatura/tipo de retorno) — a execução em produção é **sempre
do operador**, ou do agente só com autorização explícita **por passo** (uma etapa não
autoriza a seguinte), sob os 5 gates de [`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md).

> **O ambiente chamado "homologação" É produção.** Todo comando aqui atinge clientes
> reais (`app.moveelog.com.br` e `app.motorista.moveelog.com.br`). As tabelas do hub em
> produção vivem **dentro do `chatmasterveloz`** (container `pgadmin_db`) — a migration
> deste runbook roda no banco de produção, não num ambiente isolado `hub-*`.

## O que muda

- **Schema** (`infra/hub/migrations/0098_repasse_saldo_minimo.sql`): colunas novas
  nuláveis em `ApuracaoRepasseItem` (`saldo_anterior*`, `valor_pago`,
  `valor_transportado*`) com `CHECK apuracaorepasseitem_saldo_conserva`; coluna
  `repasse_valor_minimo numeric(14,2) NOT NULL DEFAULT 5.50 CHECK (> 0)` em
  `AdiantamentoConfiguracao`; coluna `piso_aplicado` (nulável) em `ApuracaoRepasse`.
- **4 RPCs recriadas com `DROP FUNCTION` + `CREATE` + `GRANT`** (mudança de tipo de
  retorno, `OR REPLACE` não serve): `hub_adiantamento_repasse`,
  `hub_adiantamento_repasse_congelado`, `hub_adiantamento_repasse_motorista`,
  `hub_adiantamento_repasse_motorista_ultimo_fechado`. Reescreve também
  `hub_adiantamento_repasse_fechar` (mantém assinatura — `CREATE OR REPLACE` basta) e
  `hub_adiantamento_configuracao_salvar` (exige
  `hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar')` para alterar o
  piso → `PERMISSAO_NEGADA_PISO`).
- **Backend**: `GET /repasse`, `GET /repasse/exportar`, `POST /repasse/:periodo/fechar`
  (novo `409 APURACAO_FORA_DE_ORDEM`), `POST /repasse/:periodo/movimentos`,
  `GET`/`PUT /configuracoes`, `GET /motorista/repasse` — todos com os campos novos
  (`saldoAnterior`, `aPagar`, `transportado`, `retido`, `previsaoTotal`,
  `abaixoDoMinimo`, `repasseValorMinimo`).
- **CSV** (`serializarCsvRemanescente`): 3 colunas novas no fim —
  `Saldo anterior,A pagar,Passou para a próxima semana`. ⚠️ **Quebra leitura por
  posição** de quem consome o CSV hoje (financeiro) — mesmo aviso de F1, repetir antes
  do deploy.
- **UI hub** (`repasse/page.tsx`): colunas "Saldo anterior"/"A pagar"; badge
  "Passou para a próxima semana" na coluna Observação. `configuracoes/page.tsx`: campo
  "Valor mínimo para repasse", desabilitado sem `adiantamentos.pagamento_confirmar`.
- **UI app motorista** (`frontend_motorista/app/(app)/repasse/page.tsx`): linha "Saldo
  da semana anterior" (só quando `saldoAnterior > 0`); linha final usa
  `previsaoTotal ?? remanescente`; aviso "abaixo do valor mínimo para repasse" quando
  `abaixoDoMinimo`; card da semana fechada retida mostra "Passou para a próxima semana:
  R$ X,XX" (valor = `transportado`, sem data) no lugar de "Valor a receber: R$ 0,00".
  Texto e posição aprovados pelo operador em 2026-09-26 (block-007/dec-047 — ver
  [`checklists/integridade-financeira.md`](../../specs/repasse-saldo-minimo/checklists/integridade-financeira.md)
  CHK020).
- **Vocabulário**: o termo "Retido" saiu de toda UI/rótulo visível (hub, CSV, app). Só
  nomes internos de código (campo `retido`, `transportado`, motivo `'RETIDO'`)
  continuam existindo — não altera contrato de dados, só rótulo.

## Gates do rito do ciclo git (antes do PR — CLAUDE.md "Rito do ciclo git")

Números medidos nesta onda, escopo de arquivos tocados por F3 (restrição de recurso:
swap do host perto do limite — ver nota):

| Gate | Comando | Resultado nesta onda |
|---|---|---|
| Unit backend (arquivos tocados) | `node --test tests/adiantamento-remanescente-unit.test.js tests/hub-adiantamentos-rotas-unit.test.js tests/motorista-adiantamento-rotas-unit.test.js tests/adiantamento-dto-unit.test.js tests/adiantamento-geracao-movimento-unit.test.js tests/hub-postgrest-lotes-unit.test.js tests/hub-usuarios-trava-unit.test.js` | 32+133+72+29+23+7+15 = 311/311 (23 = correção block-008/dec-055, ver abaixo) |
| Unit frontend_v2 (arquivos tocados) | `npx vitest run app/hub/dashboard/adiantamentos/repasse/page.test.tsx lib/hub/adiantamentos-api.test.ts` | 10/10 + 13/13 |
| Types (`tsc --noEmit`) | — | **pendente** — não rodado nesta onda (restrição de memória) |
| `npm test` completo (backend) | — | **pendente** — não rodado nesta onda |
| `next build` (frontend_v2 e frontend_motorista) | — | **pendente** — proibido nesta onda (restrição de memória) |
| Lint vs. baseline | `npm run lint` | **pendente** |
| Integração (`npm run test:hub:integration`) | — | **pendente** — exige ambiente `hub-test-*` (tasks.md 3.8.6) |
| E2E (`npm run test:e2e:hub`, cenário F3.12) | — | **pendente** — exige container Playwright (tasks.md 3.6.4/3.8.6) |

Nota: onda rodou sob restrição de recurso (swap perto do limite, RAM disponível
~2,5 GB) — `next build`/suíte completa/integração/E2E ficaram fora do escopo
permitido. Conferir os pendentes numa janela com ambiente disponível **antes de abrir
o PR** — não é bloqueio de negócio, é pendência de ambiente.

## Pré-condições operacionais (confirmar com o operador antes do deploy)

1. **Nenhuma apuração foi fechada em produção ainda com o código antigo desta janela**
   — medido nesta onda: **0 apurações fechadas em produção desde que a regra do saldo
   mínimo existe**. F3 precisa entrar no ar **antes** do primeiro fechamento real; até
   lá, o operador segura o botão "Fechar apuração" em produção (tasks.md 3.10.2).
2. **Texto do aviso no app do motorista aprovado** — ✅ feito (block-007/dec-047,
   2026-09-26; CHK020 marcado).
3. **Assimetria da revisão adversarial (3.9.1) resolvida** — ✅ feito (block-008/dec-055,
   2026-09-27; CHK022 marcado). `remanescente<0` com saldo carregado nunca foi/é
   "retido": a produção nota-elegível da semana negativa gera a nota da PRÓPRIA semana
   (como sempre fez uma semana negativa sem saldo), e o saldo antigo segue carregado
   intocado para a nota futura. Corrigido em `lib/adiantamento-geracao-movimento.js`
   (o `retido` só se aplica com `remanescente>=0`, mesma fórmula já documentada em
   data-model.md/research.md Decision 8) — **a migration 0098 não mudou** (a assimetria
   era só na implementação do app, não no SQL).
4. **Confirmar que não há apuração aberta na janela do deploy** (nenhum fechamento em
   andamento no momento do `docker service update` + migration).
5. Avisar o financeiro da mudança de cabeçalho do CSV (mesmo aviso de F1 — 3 colunas
   novas no fim desta vez).

## Ordem de deploy (tasks.md 3.10.1)

1. **Backend** (imagem com a trava de rota/DTOs novos) — sobe primeiro; as RPCs
   antigas ainda respondem no formato antigo até a migration rodar, então o backend
   novo pode quebrar temporariamente se ler campos que as RPCs antigas não têm. Se as
   duas imagens (backend + migration) não puderem ser aplicadas juntas na mesma janela,
   preferir uma janela curta de indisponibilidade parcial do repasse a deixar o backend
   velho ler RPCs novas incompatíveis.
2. **Migration `0098_repasse_saldo_minimo.sql`** no `chatmasterveloz` (container
   `pgadmin_db`):
   ```
   CID=$(docker ps -qf name=pgadmin_db | head -1)
   docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' \
     < infra/hub/migrations/0098_repasse_saldo_minimo.sql
   docker exec "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('"'"'0098_repasse_saldo_minimo.sql'"'"') ON CONFLICT (nome) DO NOTHING;"'
   ```
   (`SchemaMigration` pode mentir se a migration não passou por aqui — conferir que as
   4 funções realmente mudaram, não só o registro.)
3. **`SIGUSR1` no PostgREST de produção** (⚠️ há DOIS PostgREST no host — o de produção
   é o `pgadmin_postgrest`, nunca o do hub isolado):
   ```
   docker kill -s SIGUSR1 $(docker ps -qf name=pgadmin_postgrest | head -1)
   ```
4. **`frontend_v2`** (`docker service update --with-registry-auth --image ... envio-massa-homologacao_frontend_v2_homologacao`).
5. **`frontend_motorista`** (`docker service update --with-registry-auth --image ... envio-massa-homologacao_frontend_motorista_homologacao`).

## Plano de rollback (tasks.md 3.10.4)

1. **Antes de aplicar**: `pg_dump -t` de `ApuracaoRepasse` e `ApuracaoRepasseItem`
   (dado financeiro):
   ```
   CID=$(docker ps -qf name=pgadmin_db | head -1)
   docker exec "$CID" sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz -t "\"ApuracaoRepasse\"" -t "\"ApuracaoRepasseItem\"" --data-only' \
     > ~/apuracaorepasse-antes-0098.sql
   ```
2. **Rollback de banco**: `infra/hub/testes/sql/0098-rollback.sql` (task 3.2) — volta os
   4 corpos de função vigentes (`0088`/`0086`/`0092`/`0091`... conferir números atuais
   antes de aplicar, migrations podem ter avançado) e remove as colunas novas.
   ⚠️ **Recusa** (com mensagem clara) se existir apuração pós-0098 com
   `valor_transportado > 0` — nesse caso não dá para simplesmente reverter sem perder
   o saldo devido ao motorista; qualquer decisão aí é humana, não automática.
3. **Rollback de imagem**: anotar a imagem anterior ANTES de atualizar —
   `docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'`
   — e `docker service update --with-registry-auth --image <anterior> <serviço>` para
   backend, frontend_v2 e frontend_motorista, o que tiver sido atualizado.
4. Depois de qualquer rollback de RPC, repetir o `SIGUSR1` no `pgadmin_postgrest`.

## Smoke test pós-deploy (tasks.md 3.10.5)

1. `GET /api/v1/adiantamentos/repasse?periodo=<semana atual>` autenticado — confere
   `saldoAnterior`/`aPagar` presentes sem erro 500.
2. `GET /api/v1/adiantamentos/configuracoes` — confere `repasseValorMinimo` presente.
3. Tela de Repasse semanal no hub: colunas "Saldo anterior"/"A pagar" renderizam;
   badge "Passou para a próxima semana" aparece em item retido (se houver algum no
   momento) ou confirmar visualmente no código do bundle servido (prova de bundle,
   CLAUDE.md "Prova" — HTTP 200 não prova nada).
4. `GET /motorista/repasse` (app do motorista, usuário de teste) — confere
   `abaixoDoMinimo`/`previsaoTotal` presentes; abrir a tela e checar que nenhum texto
   visível contém a palavra "Retido".
5. Exportar o CSV do repasse e confirmar o cabeçalho novo (3 colunas no fim,
   `Passou para a próxima semana` como última).

## Os 5 gates de produção

1. **Autorização explícita** do operador para este deploy específico.
2. **Janela combinada** — fora do horário de fechamento de apuração e das janelas do
   robô EntreGô (11h/13h/14h, não relacionadas a esta feature mas compartilham o
   mesmo host) é prudente; mais importante aqui: fora de qualquer fechamento de
   apuração em andamento (pré-condição 3 acima).
3. **Plano de rollback** — seção acima, com `pg_dump -t` feito ANTES de aplicar.
4. **Aplicar**: `docker service update --with-registry-auth --image ...`. **Nunca**
   `docker stack deploy`.
5. **Smoke test** — seção acima, antes de declarar OK.

## Referências

- [spec.md](../../specs/repasse-saldo-minimo/spec.md) — FR-014..FR-026, FR-039/FR-040
- [contracts/hub-repasse-api.md](../../specs/repasse-saldo-minimo/contracts/hub-repasse-api.md)
- [quickstart.md](../../specs/repasse-saldo-minimo/quickstart.md) — cenários F3.10..F3.15
- [checklists/integridade-financeira.md](../../specs/repasse-saldo-minimo/checklists/integridade-financeira.md)
- [tasks.md](../../specs/repasse-saldo-minimo/tasks.md) FASE 3
- [RUNBOOK-DEPLOY-F1.md](RUNBOOK-DEPLOY-F1.md) (mesma feature, F1)
