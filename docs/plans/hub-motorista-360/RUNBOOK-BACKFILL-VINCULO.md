# Runbook — backfill retroativo do vínculo automático de credencial

Executa `app_homologacao/backend/scripts/backfill-vinculo-motorista.js` (feature
`hub-motorista-360`, FASE 3, tasks.md 3.2, FR-012) contra o banco `chatmasterveloz`
(container `pgadmin_db`, host VPSTodo) via o backend já deployado (container
`envio-massa-homologacao_backend_homologacao`).

⚠️ **Isto é o banco do cliente, e o script ESCREVE** (cria/atualiza linhas em
`ContaMotorista` e `Entregador`) — não é leitura. Rito dos 5 gates do `CLAUDE.md`
obrigatório. O agente **não executa** nenhum passo daqui — entrega o comando
pronto; o operador cola com `!`. Execução ÚNICA (não é um job recorrente).

⚠️ **Pré-requisitos, na ordem**:
1. As migrations `0057_entregador_entrego_enriquecimento.sql`,
   `0058_rpc_motoristas_candidatos_por_conta.sql` e
   `0059_seed_permissao_motoristas_dados_sensiveis.sql` (série do hub,
   `infra/hub/migrations/`) já aplicadas em produção (FASE 2 desta feature) —
   o script depende da RPC `hub_motoristas_candidatos_por_conta` e falha (erro
   de PostgREST claro, 404 na RPC) se a migration 0058 não estiver aplicada.
2. O deploy do backend desta feature (FASE 3, hook `POST /motorista/register` +
   `lib/hub-motorista-vinculo-automatico.js` + este script) já em produção — a
   imagem do backend em produção precisa CONTER
   `app_homologacao/backend/scripts/backfill-vinculo-motorista.js`. Confira
   antes:
   ```
   ! docker exec envio-massa-homologacao_backend_homologacao \
       test -f scripts/backfill-vinculo-motorista.js && echo "script presente"
   ```
3. `EmpresaGrupoMovee` (migration 0022) seedada com pelo menos a empresa Movee
   (id 6) em produção — sem isso o script processa tudo como
   `sem_grupo_elegivel` (não é erro, mas não vincula ninguém).

## Gate 1 — autorização
Autorização explícita do operador para **esta** execução específica. Não vale
a validação isolada em `hub-homolog` nem qualquer autorização anterior desta
feature (migrations da FASE 2, deploy da FASE 3).

## Gate 2 — janela
Impacto esperado: cria/atualiza linhas em `ContaMotorista` (find-or-create por
`cnpj_prestador`) e em `Entregador.motorista_id` (só quando há exatamente 1
candidato com similaridade de nome >= 0.9 — nunca em massa por adivinhação,
FR-012). Não afeta login/sessões em curso, não faz DDL, não apaga nada. Rodar
fora do horário de pico se possível (execução única, não crítica em latência).

## Gate 3 — rollback à mão ANTES de aplicar

Backup das 2 tabelas tocadas:

```
! docker exec pgadmin_db sh -c 'pg_dump -U "$POSTGRES_USER" -d chatmasterveloz \
    -t "\"ContaMotorista\"" -t "\"Entregador\"" --data-only' \
    > ~/backup-hub-motorista-360-backfill-$(date +%Y%m%d-%H%M%S).sql
```

Confira que o arquivo não saiu vazio antes de seguir:

```
! ls -la ~/backup-hub-motorista-360-backfill-*.sql | tail -1
```

**Rollback** (só se necessário): restaurar o dump acima. O script em si é
idempotente (reexecutar não piora nada, FR-011 — tasks.md 3.2.4), então na
prática só se justifica um rollback se um vínculo automático tiver sido
incorreto (falso positivo de similaridade) — nesse caso o mais simples é usar
`DELETE /:id/vinculo` (já existe na UI do hub, botão "Vincular"/desvincular)
no(s) motorista(s) específico(s), sem precisar restaurar o dump inteiro.

## Gate 4 — aplicar

Rodar DENTRO do container do backend (reusa as variáveis de ambiente já
injetadas no serviço — `POSTGREST_URL`, `POSTGREST_API_KEY`, `PGRST_JWT_SECRET`
— nenhum segredo precisa ser colado manualmente):

```
! docker exec envio-massa-homologacao_backend_homologacao \
    node scripts/backfill-vinculo-motorista.js
```

Esperado no output: um JSON `{ "totalProcessados": N, "totalVinculados": M,
"totalAmbiguos": K }` (M + K <= N; a diferença são motoristas já vinculados
antes, ou fora do grupo elegível). Guarde este JSON no PR/registro da execução
— é o relatório final exigido por FR-012/tasks.md 3.2.2. Sem dado pessoal no
output (nenhum CNPJ/nome é impresso, só os totais).

## Gate 5 — smoke test

**5.1 — exit code 0** (o `docker exec` acima retorna 0; um exit 1 indica erro
fatal — variável de ambiente ausente no container, ou falha ao ler `Motorista`
— e MUST ser investigado antes de considerar a execução concluída).

**5.2 — o caso relatado do briefing (print em
`arquivos_complementares/hub-motorista-360-evidencias/`) passa a exibir o
vínculo na UI**: abrir a tela de detalhe do motorista específico no hub e
confirmar que os cards "Conta de acesso vinculada" e "Credencial de acesso"
deixaram de estar vazios (Scenario 3 do `quickstart.md`). Se esse motorista em
particular caiu em `totalAmbiguos` (sem candidato único >= 0.9), ele continua
disponível para vínculo manual (botão "Vincular") — não é uma falha da
execução, é o comportamento correto de FR-010.

## Depois

Reexecutar este script no futuro (ex.: depois de uma nova importação grande)
é seguro e no-op para quem já está vinculado — mas não é necessário rodar de
novo rotineiramente: o vínculo automático de FASE 3 (`POST /register`) já
cobre todo cadastro NOVO a partir do deploy desta feature. Este runbook é só
para o backlog retroativo (motoristas já cadastrados ANTES do deploy).
