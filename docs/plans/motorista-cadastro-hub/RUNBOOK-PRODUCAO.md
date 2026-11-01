# Runbook de produção — cadastro do motorista no hub (0120–0124)

**Artefato preparado pelo agente. Nada aqui foi executado em produção.** A execução é do
operador, sob os 5 gates de [`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md). Plano e
decisões em [`BRIEFING.md`](BRIEFING.md).

> "Homologação" É produção. As tabelas do hub vivem dentro do `chatmasterveloz`
> (container `pgadmin_db`). `psql` de produção é `-U chatmasterveloz`. Há dois PostgREST no
> host: o de produção é o `pgadmin_postgrest`.

## O que muda

| Peça | Mudança |
|---|---|
| `0120` | `envio_massa.aprovar` para `financeiro` e `financeiro_aprovador` (passam a fechar movimento). |
| `0121` | Reconciliação aditiva de `ContaMotorista` × `Motorista`. No ensaio: 195 senhas legado→hub, 2 hub→legado, 3 linhas legadas criadas (conta com senha sem legado, grupo Movee), 3 contas criadas (legado com senha sem conta). Casos ambíguos **não** são tocados (listas no Passo 6). |
| `0122` | CHECK de 14 dígitos nas duas tabelas, `Motorista.atualizado_em`, toque de `atualizado_em`, índice único parcial do token de reset, correção da `hub_motorista_vincular_por_base_motorista` (CNPJ normalizado). |
| `0123` | Gatilhos de sincronia G1–G4 (ver CLAUDE.md, seção de migrations). |
| `0124` | RPC `hub_motorista_trocar_cnpj` (modos `estrito` e `envio_massa`). |
| backend | Remove os espelhos em código; credencial com gate Movee, vínculo antes da senha e recusa de sobrescrita; `/register` recusa CNPJ com reset em curso; rota `PATCH /motoristas/:id/credencial/cnpj`; `PATCH /update-envio-massa/:id` usa a RPC; `/me` com `permissoesEntidadeAtiva`; `DUMMY_HASH` único. |
| frontend_v2 | Erro legível (fim do "[object Object]"); botões do envio em massa escondidos por permissão da entidade ativa; "Alterar CNPJ" no card da conta vinculada. |
| frontend_motorista | **Não muda.** Não rebuildar. |

## Ordem obrigatória: `0120` → `0121` → `0122` → `0123` → `0124` → backend → frontend_v2

- O backend ANTIGO convive com 0120–0124: os espelhos antigos viram escrita redundante, e a
  troca de CNPJ antiga é levada à conta pelo G4.
- O backend NOVO **sem** a 0123 reabre o defeito C (sem espelho em código), e sem a 0124
  a troca de CNPJ dá 500. Por isso as migrations vêm antes do código.
- ⚠️ **Janela de risco entre a 0123 e o backend novo:** com o gatilho ativo, o reset do hub
  zera o legado, e o `/register` antigo não tem a recusa nova. **Não use "Redefinir senha" no
  hub entre o Passo 3 e o Passo 4.** Faça o Passo 4 logo em seguida.

## Passo 0 — só leitura

```bash
df -h / ; free -h                 # >= 20 GB livres ANTES de buildar; swap ativa
docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'
#   anote: no preparo (31/10) backend e frontend_v2 estavam em :repasse-movimento-ca279f2  -> é o ROLLBACK
docker run --rm registry.todo-tips.com/envio-massa-backend:repasse-movimento-ca279f2 node --version   # v20.x
# dono das tabelas (as funções SECURITY DEFINER dependem de ser o dono): esperado chatmasterveloz
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -Atc \
  "select relname, pg_get_userbyid(relowner) from pg_class where relname in ('Motorista','ContaMotorista','Entregador','EnvioMassa');"
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -Atc 'select max(nome) from "SchemaMigration"'   # 0119
```

## Passo 1 — backup das tabelas tocadas

```bash
docker exec <pgadmin_db> pg_dump -U chatmasterveloz -t '"Motorista"' -t '"ContaMotorista"' -t '"PapelPermissao"' \
  chatmasterveloz > ~/bkp-motorista-0120-0124-$(date +%F).sql
ls -lh ~/bkp-motorista-0120-0124-*.sql
```

`EnvioMassa` e `Entregador` não são alterados pelas migrations (só pelo uso da RPC, depois).

## Passo 2 — diagnóstico ANTES (só leitura)

```bash
docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' <pgadmin_db> \
  psql -U chatmasterveloz -d chatmasterveloz -At -F' | ' -v ON_ERROR_STOP=1 \
  < infra/hub/scripts/diagnostico-motorista-sync.sql > ~/diag-motorista-antes-$(date +%F).txt
```

No ensaio com o backup de 31/10: D3 "só legado" = 195, "só hub" = 2, D2 = 3, D6 = 3,
senhas diferentes = 8, ativo divergente = 1, reset em curso = 15. Número muito diferente: PARE.

## Passo 3 — migrations (arquivo a arquivo, transação única, registrar)

Produção não usa o `migrate.sh`. `--single-transaction` é obrigatório (os arquivos não têm
BEGIN/COMMIT; `SET LOCAL lock_timeout = '5s'` da 0122/0123 só vale dentro dela). Depois de
cada arquivo, registre na `"SchemaMigration"` como nas anteriores.

```bash
for m in 0120 0121 0122 0123 0124; do
  f=$(ls infra/hub/migrations/${m}_*.sql)
  docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz --single-transaction -v ON_ERROR_STOP=1 < "$f" || { echo "PAROU em $m"; break; }
  docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -v ON_ERROR_STOP=1 \
    -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('$(basename "$f")') ON CONFLICT DO NOTHING;"
done
docker kill -s SIGUSR1 <pgadmin_postgrest>     # Motorista ganhou coluna e há RPC nova
```

Se o `lock_timeout` estourar (`canceling statement due to lock timeout`), nada foi
aplicado daquele arquivo: espere e reaplique. Os arquivos são idempotentes (provado: md5
das duas tabelas idêntico ao reaplicar as cinco).

Verificação:

```sql
select string_agg(pa.nome, ',' order by pa.nome) from "PapelPermissao" pp join "Papel" pa on pa.id=pp.papel_id
  join "Permissao" p on p.id=pp.permissao_id where p.codigo='envio_massa.aprovar';
  -- admin_entidade,admin_plataforma,financeiro,financeiro_aprovador
select tgname from pg_trigger where tgname in ('trg_conta_adota_senha_legado','trg_conta_para_legado',
  'trg_entregador_vinculo_legado','trg_legado_para_conta') order by 1;            -- 4 linhas
select pg_get_userbyid(proowner), prosecdef from pg_proc where proname='hub_motorista_garante_legado';  -- chatmasterveloz | t
select has_function_privilege('authenticated','hub_motorista_trocar_cnpj(text,text,int,text)','EXECUTE');  -- t
select has_function_privilege('hub_web_anon','hub_motorista_trocar_cnpj(text,text,int,text)','EXECUTE');   -- f
select array(select hub_empresas_grupo_movee());                                    -- {6}
```

## Passo 4 — backend

Build a partir da **main já mergeada**, tag `<rótulo>-<sha7>`, com `df -h /` e swap
conferidos antes. Nunca `image prune` durante o build.

```bash
cd app_homologacao/backend
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub -t registry.todo-tips.com/envio-massa-backend:<tag> .
docker run --rm registry.todo-tips.com/envio-massa-backend:<tag> node --version      # v20.x
# envio ao registry (operador), anotar o digest
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:<tag> envio-massa-homologacao_backend_homologacao
```

Rollback: `docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:repasse-movimento-ca279f2 envio-massa-homologacao_backend_homologacao`
(o backend antigo funciona com os gatilhos: ver "Ordem").

## Passo 5 — frontend_v2

```bash
cd app_homologacao/frontend_v2
grep -n BACKEND_URL Dockerfile*          # conferir o destino antes de buildar
DOCKER_BUILDKIT=0 docker build --memory=2g -t registry.todo-tips.com/envio-massa-frontend-v2:<tag> .
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:<tag> envio-massa-homologacao_frontend_v2_homologacao
```

Rollback: mesma linha com `:repasse-movimento-ca279f2`.

## Passo 6 — smoke e prova de bundle (só leitura)

```bash
infra/producao/smoke-deploy.sh -t backend=<tag> -t frontend_v2=<tag> -t frontend_motorista=repasse-movimento-ca279f2
```

As strings desta entrega estão em `infra/producao/smoke-deploy.strings`: `hub_motorista_trocar_cnpj`
(backend, tag `cadastro-motorista-b8aaa8d`), `permissoesEntidadeAtiva` (frontend_v2, mesma tag) e,
para o app motorista que não muda, `recebeu por fora abatido` (tag `repasse-movimento-ca279f2`).
Controle negativo medido nas imagens: 3 e 8 ocorrências nas imagens novas, 0 nas de rollback; a do
app motorista, 2 em `ca279f2` e 0 em `pagos-por-fora-1bda5b3`.

> Correção pós-deploy (2026-11-01): a primeira versão deste runbook dizia isso sem que as linhas
> tivessem sido adicionadas ao arquivo. No deploy, o smoke rodou com um arquivo avulso
> (`-s ~/smoke-cadastro-motorista.strings`) e deu 12/12. A linha do `frontend_motorista` também
> estava vencida (apontava `ajuda-3-entregas-f3ffeba`, mas o ar está em `repasse-movimento-ca279f2`),
> então o smoke padrão falharia nela. As três linhas agora valem para o que está no ar.

Um `000` logo depois do deploy pode ser timing do Traefik: ver CLAUDE.md antes de concluir.

Rotas novas vivas, sem login (o esperado é 401, não 404):

```bash
curl -sk -o /dev/null -w '%{http_code}\n' -X PATCH https://app.moveelog.com.br/api/api/v1/motoristas/1/credencial/cnpj   # 401
curl -sk -o /dev/null -w '%{http_code}\n' -X POST  https://app.moveelog.com.br/api/close-movimento                     # 401
```

Diagnóstico DEPOIS (mesmo comando do Passo 2, arquivo `-depois`). Esperado pelo ensaio: D3
"só legado" 0, "só hub" 0, D2 0, D6 0; senhas diferentes 8, ativo divergente 1 e reset em
curso 15 **sem mudança** (vão para decisão).

Validação funcional pelo operador, na tela:
1. Entrar como usuário **financeiro**: Envio em Massa mostra "Fechar movimento". Um usuário
   **leitura** não vê o botão; se forçar, a mensagem é legível.
2. Motoristas → um dos 5 da lista R (abaixo) → Redefinir senha → definir a nova → o motorista
   entra no app com ela.
3. Desativar e reativar uma credencial de teste e conferir o 403 e o 200 no app.

## Listas para decisão do operador (saem do Passo 2/6)

| Lista | No ensaio | Ação sugerida |
|---|---|---|
| **R** — conta vinculada sem senha em lugar nenhum, reset vencido | 5 | Refazer "Redefinir senha" no hub. São motoristas que hoje **não entram** no app. |
| **Reset em curso/expirado** (inclui R) | 23 | Os demais 18 seguem entrando com a senha do legado. Refazer o reset só se o objetivo for cortar a senha antiga. |
| **C3b** — senha diferente nos dois lados | 8 | O login usa a do legado. Decidir caso a caso; o próximo reset/definir no hub iguala. |
| **C3d** — `ativo` divergente | 1 | Decidir se fica ativo ou inativo e aplicar pelo hub. |
| **C2** — Entregador vinculado a CNPJ ≠ do último movimento | 22 | Para cada um: se já existe conta com o CNPJ novo, "Trocar" o vínculo (caso do Thiago); se não existe, "Alterar CNPJ". |

## Rollback completo

1. frontend_v2 e backend para `:repasse-movimento-ca279f2` (Passos 4 e 5).
2. Banco, **só se necessário** e só depois do código: `0124` antes da `0123` (a RPC usa
   `hub_empresas_grupo_movee`). Os comandos estão no cabeçalho de cada migration. Os dados da
   `0121` são cópias do valor que já existia do outro lado, e a reversão é pelo `pg_dump` do
   Passo 1.
3. ⚠️ Não reverter a `0123` mantendo o backend novo: sem gatilho e sem espelho em código, o
   defeito C volta.
4. A `0120` se reverte removendo as duas linhas de `PapelPermissao` (DELETE: autorização explícita).
