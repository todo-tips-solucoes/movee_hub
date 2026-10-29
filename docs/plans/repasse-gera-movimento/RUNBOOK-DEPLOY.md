# Runbook de deploy — repasse-gera-movimento ("Gerar do repasse")

Feature: [`repasse-gera-movimento`](../../specs/repasse-gera-movimento/spec.md). **Este documento é um ARTEFATO preparado pelo agente. Nada aqui foi executado em produção.**
A execução é **sempre do operador**, sob os 5 gates de [`docs/RITO-PRODUCAO.md`](../../RITO-PRODUCAO.md) (autorização para ESTA mudança, janela, rollback à mão, `docker service update --image` — nunca `stack deploy` —, smoke).

> **"Homologação" É produção.** As tabelas do hub em produção vivem **dentro do `chatmasterveloz`** (container `pgadmin_db`); a `0118` roda no banco do cliente. `psql` de produção é `-U chatmasterveloz`, **não** `postgres`.

## O que muda

- **Banco (`0118_repasse_nota_a_emitir.sql`)**: coluna aditiva `ApuracaoRepasseItem.nota_a_emitir`; reescreve `hub_adiantamento_repasse_fechar`, a prévia e o congelado (a nota passa a ser líquida do pago por fora; o excedente vira `transportado_nota` negativo); cria `hub_repasse_alocar_envio_id()` (`SECURITY INVOKER`, `REVOKE ... FROM PUBLIC`, `GRANT ... TO authenticated`).
- **Banco (`0119_repasse_lote_nota_zero.sql`)**: `CREATE OR REPLACE` de `hub_repasse_lote_avaliar` (mesma assinatura, GRANT preservado) para que o movimento **só-gorjeta** (`nota_a_emitir = 0`, nada a emitir) **não** fique `NOTA_PENDENTE` eterno no lote de pagamento. **Depende da `0118`** e vai junto com ela — ver Passo 2b.
- **Backend**: `POST /repasse/:periodo/movimentos` fecha-se-não-existir, pré-flight de pendências (`409 ADIANTAMENTOS_PENDENTES`), laço S1 (id alocado → trilha → `EnvioMassa` com o mesmo id), filtro de tenant. `POST .../fechar` **não mudou**.
- **Frontend_v2**: botão único "Gerar do repasse" (tela de Repasse + as duas telas de Envio em Massa); "Fechar apuração" e "Gerar notas da semana" deixam de existir. Ajuda do hub e do app atualizadas.

## Ordem (obrigatória): `0118` → `0119` → backend → frontend_v2

O código ANTIGO funciona com a `0118` aplicada (coluna aditiva, funções só ganham uma coluna no fim). Backend novo sem a `0118` **não** funciona (não existe `hub_repasse_alocar_envio_id`). O frontend novo exige o backend novo (rota/409 novos). A `0119` lê a coluna da `0118`, então vem **depois** dela — e **antes** de qualquer uso real do lote de pagamento, senão o movimento só-gorjeta trava como nota pendente.

## Passo 0 — somente leitura, ANTES de tudo

```bash
# imagens que estão no ar (anote: ela é o rollback) e a versão do node
docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'
docker run --rm <imagem-backend-em-producao> node --version     # esperado v20.x

# O mecanismo S1 foi provado só no espelho hub_homolog. Confirme em PRODUÇÃO (somente leitura):
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -c '\d "EnvioMassa"'
#   -> a coluna id tem de aceitar valor explícito (NÃO "GENERATED ALWAYS AS IDENTITY"); default nextval('"EnvioMassa_id_seq"'...)
#   ✅ JÁ MEDIDO em 28/10 (revisão adversarial levantou isto como o único bloqueio possível antes do deploy):
#      information_schema.columns -> is_identity=YES, identity_generation=BY DEFAULT, column_default=(null), tipo=bigint.
#      BY DEFAULT aceita id explícito. Se fosse ALWAYS, TODO POST EnvioMassa falharia com 428C9 (não 23505),
#      `violacaoUnica` seria falso e a geração deixaria uma reserva órfã por motorista. Reconfirme, é 1 comando.
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -c \
  "SELECT has_sequence_privilege('authenticated','\"EnvioMassa_id_seq\"','USAGE');"
#   -> t. Se vier f, ou o nome da sequência for outro: PARE. A 0118 não funcionaria e a semana seria fechada à toa.
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -c \
  "SELECT id, versao, vigente_desde, (mensagem1_modelo IS NOT NULL AND btrim(mensagem1_modelo) <> '') AS tem_modelo FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=6 ORDER BY versao DESC LIMIT 3;"
#   -> a versão vigente tem de ter tem_modelo = t ANTES de gerar (Passo 5). Em 28/10 é NULA em produção.

# ⚠️ QUANTOS MOTORISTAS JÁ TÊM MOVIMENTO ABERTO — este check FALTAVA e sem ele o dia 1 parece defeito.
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -c \
  "WITH g AS (SELECT id FROM \"Grupo\" WHERE id_empresa_pai=6),
        grupo AS (SELECT 6 AS id UNION SELECT e.id FROM \"Empresa\" e JOIN g ON e.id_grupo=g.id)
   SELECT count(DISTINCT cnpj_prestador) AS motoristas, count(*) AS linhas
     FROM \"EnvioMassa\" WHERE mov_fechado=false AND id_empresa IN (SELECT id FROM grupo);"
#   -> MEDIDO em 28/10: 937 motoristas, 937 linhas. Cada um desses CNPJs será RECUSADO com `MOVIMENTO_ABERTO`
#      ("provavelmente da planilha") na primeira geração — isso NÃO é bug, é a guarda que impede pagar duas vezes.
#      Para gerar de verdade, os movimentos da semana anterior precisam estar FECHADOS (o "Fechar movimento" da tela
#      de Envio em Massa). Histórico medido: 53.988 fechados contra 937 abertos, ou seja a operação já fecha 98,3% —
#      os 937 são a semana corrente. Se o número vier muito acima disso, PARE e entenda antes de gerar.
```

Verificação: os resultados acima anotados. Rollback: n/a (só leitura).

## Passo 1 — backup das tabelas tocadas e disco

```bash
df -h / ; free -h      # >= 20 GB livres e swap ativa (incidentes 2026-06-11 e 2026-08-30)
docker exec <pgadmin_db> pg_dump -U chatmasterveloz -t '"ApuracaoRepasseItem"' -t '"ApuracaoRepasseMovimento"' chatmasterveloz > ~/bkp-0118-$(date +%F).sql
```

## Passo 2 — migration (aplicar o arquivo e registrar na `SchemaMigration`)

A `SchemaMigration` de produção já mentiu fora do `migrate.sh`: aplique o arquivo e **registre** na `"SchemaMigration"` como nas migrations anteriores.

```bash
# --single-transaction é OBRIGATÓRIO aqui: nem a 0118 nem a 0119 têm BEGIN/COMMIT próprios
# (0 ocorrências nos dois arquivos), e o cabeçalho da 0118 (`:8`) só vale para o `migrate.sh`,
# que aplica com `psql_exec -1` (`infra/hub/scripts/migrate.sh:70`). Produção NÃO usa o
# migrate.sh — sem `--single-transaction` cada statement autocommita e um erro no meio deixa
# a prévia do repasse (`:278`/`:280`) ou o congelado (`:457`/`:459`) DROPADOS sem versão nova.
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz --single-transaction -v ON_ERROR_STOP=1 < infra/hub/migrations/0118_repasse_nota_a_emitir.sql
# recarregar o schema do PostgREST de PRODUÇÃO (há DOIS PostgREST no host; o de produção é o pgadmin_postgrest):
docker kill -s SIGUSR1 <pgadmin_postgrest>
```

Verificação:

```sql
SELECT count(*) FROM information_schema.columns WHERE table_name='ApuracaoRepasseItem' AND column_name='nota_a_emitir';  -- 1
SELECT has_function_privilege('anon','hub_repasse_alocar_envio_id()','EXECUTE');                                          -- f
SELECT has_function_privilege('authenticated','hub_repasse_alocar_envio_id()','EXECUTE');                                 -- t
```

**Rollback do banco**: a coluna fica (nula, inofensiva). Reaplique a `0117_lancamento_externo.sql` inteira (idempotente; caminho exercitado em `hub-lancamento-externo-rollback.sh`, 37 PASS) e `SIGUSR1` no PostgREST.

⚠️ **O rollback da `0118` NÃO é limpo — corrigido na onda-013.** A versão anterior deste runbook
afirmava que o `transportado_nota` negativo "o código antigo ignora". **É falso, e medido**: o
código em `HEAD` lê essa coluna — `lib/adiantamento-geracao-movimento.js:155`
(`num(item.valor_nota) + (negativo ? 0 : num(item.saldo_anterior_nota))`) e `:157`
(`if (valor <= 0) recusar('VALOR_ZERO')`). Logo uma **dívida de nota** carregada reduz a nota da
semana seguinte e pode recusar o motorista. Pior: o `fechar` da `0117` **não tem** a cláusula de
inclusão que a `0118` adiciona (`0118:182`, `OR COALESCE(sa.transportado_nota,0) <> 0`), então
quem carrega **só** dívida de nota **não ganha item** na semana seguinte — e, para quem é pago, a
`0117` escreve `transportado_nota = 0`, **apagando a dívida em silêncio**.

**Antes do próximo fechamento após qualquer rollback da `0118`**, levantar e acertar à mão:

```sql
SELECT apuracao_id, entregador_id, transportado_nota
  FROM "ApuracaoRepasseItem" WHERE transportado_nota < 0;
```

⚠️ **Armadilha da `0117` (reaplicação não relacionada)**: a `0117` §9 (`:1369`) é ela mesma um
`CREATE OR REPLACE` de `hub_repasse_lote_avaliar`. Com a `0119` aplicada, **qualquer** reaplicação
da `0117` inteira — inclusive esta, usada como rollback da `0118` — **reverte a `0119` de carona** e
a gorjeta volta a ficar presa. Depois de reaplicar a `0117` por qualquer motivo, **reaplique a
`0119`** (Passo 2b) ou confirme no `prosrc` que o predicado de `nota_a_emitir` ainda está lá.

## Passo 2b — migration `0119_repasse_lote_nota_zero.sql` (DEPOIS da `0118`, na mesma janela)

**Não é opcional e não pode ficar para depois.** A `0118` passa a gerar o movimento **só-gorjeta** (nota R$ 0, nada a emitir — FR-022/`dec-054`). Sem a `0119`, o lote de pagamento devolveria esse movimento como `NOTA_PENDENTE` **para sempre** (`aprovadas 0 < total 1`) e o motorista **nunca** seria pago. Aplicar a `0118` sozinha deixa a frente meio-deployada.

Depende da `0118` (lê a coluna `nota_a_emitir`). Ordem obrigatória: `0118` → `0119`.

```bash
docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz --single-transaction -v ON_ERROR_STOP=1 < infra/hub/migrations/0119_repasse_lote_nota_zero.sql
# registrar na "SchemaMigration" (ela já mentiu fora do migrate.sh), e recarregar o schema do PostgREST de PRODUÇÃO:
docker kill -s SIGUSR1 <pgadmin_postgrest>
```

Verificação:

```sql
-- a função passou a considerar a coluna da 0118 (é CREATE OR REPLACE: mesma assinatura, GRANT preservado)
SELECT prosrc LIKE '%nota_a_emitir%' FROM pg_proc WHERE proname = 'hub_repasse_lote_avaliar';          -- t
SELECT has_function_privilege('authenticated','hub_repasse_lote_avaliar(bigint[],integer[])','EXECUTE'); -- t
SELECT has_function_privilege('anon','hub_repasse_lote_avaliar(bigint[],integer[])','EXECUTE');          -- f
```

**Rollback do banco**: reaplicar a versão da função que está na `0117_lancamento_externo.sql` **seção 9** (`:1352`; a função em `:1369`) — ou a `0117` inteira, que é idempotente (mesmo caminho do rollback da `0118`, exercitado em `hub-lancamento-externo-rollback.sh`, 37 PASS) — e `SIGUSR1` no PostgREST. Reverter só a `0119` (mantendo a `0118`) **ressuscita a gorjeta presa**: o movimento só-gorjeta volta a ficar `NOTA_PENDENTE` eterno. Se precisar reverter, reverta as **duas**.

## Passo 3 — backend (imagem do `Dockerfile.hub`, node:20)

Build a partir da **main já mergeada**, tag `<rótulo>-<sha7>`; `df -h /` e swap ANTES; nunca `image prune` durante o build.

```bash
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub -t registry.todo-tips.com/envio-massa-backend:gera-movimento-<sha7> app_homologacao/backend
docker run --rm registry.todo-tips.com/envio-massa-backend:gera-movimento-<sha7> node --version     # v20.x ANTES de entregar
# enviar ao registry (ato do operador) e anotar o digest
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-backend:gera-movimento-<sha7> envio-massa-homologacao_backend_homologacao
```

Rollback: `docker service update --with-registry-auth --image <imagem anotada no Passo 0> envio-massa-homologacao_backend_homologacao`.
Prova (interrogar o processo vivo, não o HTTP 200): `docker exec <tarefa-backend-atual> grep -c hub_repasse_alocar_envio_id /app/routes/hub-adiantamentos.js` ≥ 1 (`docker service logs` agrega tarefas antigas — filtre pela tarefa atual).

## Passo 4 — frontend_v2

Idem Passo 3 (df/swap, `--memory=2g`, Dockerfile do frontend_v2; conferir o `ENV BACKEND_URL` antes de buildar).

```bash
docker service update --with-registry-auth --image registry.todo-tips.com/envio-massa-frontend-v2:gera-movimento-<sha7> envio-massa-homologacao_frontend_v2_homologacao
```

Rollback: `--image <imagem anterior anotada>`.
**Prova de bundle (cláusula 8 do rito)**: buscar no artefato servido uma string que só existe nesta entrega — `Gerar do repasse` — e a ausência de `Fechar apuração` no chunk da tela de Repasse. HTTP 200 prova que o serviço subiu, não que subiu o código certo.
Smoke (HTTP, sem expor segredos): login do hub → 200; `GET /api/v1/adiantamentos/repasse?periodo=<segunda>` → 200.

## Passo 5 — ROTEIRO DE VALIDAÇÃO (primeiro uso real)

1. **Cadastrar `mensagem1_modelo` (e `mensagem2_modelo`) pela tela de Configurações do adiantamento — ANTES de qualquer tentativa de gerar.** Sem ele toda a geração é recusada (`MODELO_MENSAGEM_AUSENTE`) — por desenho, para nunca inventar o texto que o motorista lê sobre dinheiro. O diálogo de "Gerar do repasse" também avisa quando o modelo falta.
2. Abrir Repasse na **semana imediatamente anterior à corrente** (a corrente sempre recusa `PERIODO_EM_ABERTO`; a tela diz a partir de quando).
3. Se houver adiantamento pendente, a tela nomeia quem trava (até 20) e **nada é fechado**.
4. Clicar **Gerar do repasse** e confirmar (com remanescente negativo, marcar a caixa). **Fechar é irreversível.**
5. Conferir o resultado: gerados/recusados no aviso; abrir 2-3 motoristas no Envio em Massa e comparar `valor` (nota líquida) e `gorjeta`.
6. Repetir o clique: tudo deve voltar como "já gerado" (idempotência), sem duplicata.
7. **Se a semana tiver algum motorista cuja nota zerou por dedução do pago por fora e que ainda tem gorjeta** (o caso da `0119`): conferir que ele saiu em **`gerados`** com `valor = 0` e `gorjeta > 0`, que o **lote de pagamento o aceita** (não aparece como nota pendente) e que o **app do motorista não pede nota** dele. Se aparecer como nota pendente, a `0119` não foi aplicada — volte ao Passo 2b.
   ⚠️ **Essa linha nasce FECHADA** (`mov_fechado = true`, correção da revisão de 28/10), então ela **não aparece na lista de movimentos abertos** da tela de Envio em Massa nem no CSV do `/export-envio-massa` (que filtra abertos). Para vê-la, consulte por CNPJ incluindo fechados. Isso é deliberado: não há nota a emitir, logo nada pendente do motorista — aberta, a linha travaria a geração da semana seguinte daquele CNPJ com `MOVIMENTO_ABERTO`, e o motorista não teria como fechá-la (o app esconde valor 0).
8. **Se for reimportar uma planilha exportada**: o `/export-envio-massa` agora traz a coluna **`gorjeta`** (antes não). Reimportar o arquivo exportado preserva a gorjeta; e uma planilha **sem** a coluna `gorjeta` não é mais recusada por ter linha de valor 0 — antes o `/upload`, que é tudo-ou-nada, derrubava o arquivo inteiro nesse caso.

## ✅ Achados da revisão adversarial — TODOS CORRIGIDOS (não bloqueiam o deploy)

Os três achados da onda-013 foram corrigidos e decididos pelo operador; nenhum está vivo:

1. **WhatsApp de R$ 0,00** — o disparo filtra `valor > 0` (`lib/disparo-alvo.js`), então nenhum WhatsApp de NF de R$ 0,00 sai. A geração ainda GRAVA `mensagem1`/`mensagem2` com "R$ 0,00" e o painel as exibe (dívida M2, em `deferred-work.md`).
2. **Dispensa de nota pendente da `0119`** — restringida (ver `0119`).
3. **Chaves divergentes "nada a emitir"** — alinhadas: a **leitura** usa `valor > 0` nas 4 rotas do app, no lote, no disparo e (desde 28/10) também no `/validate-xml-batch` do painel; a **entrada** (`/upload` e a tela de correção) recusa apenas quando **não há nada a pagar nem a emitir** (`valor <= 0` **e** sem gorjeta) **e a planilha traz a coluna `gorjeta`** — sem a coluna não se pode concluir "não há gorjeta", e o `/upload` é tudo-ou-nada. `valor 0 + gorjeta` é linha legítima e importa.

**Medição pré-deploy (impacto do importador)** — rodar no `chatmasterveloz`; leitura apenas. Esperado: poucas linhas zeradas por semana (medido em 28/10: 1 a 4 por semana, todas com gorjeta, todas da Movee). Linha zerada **sem** gorjeta passa a ser recusada pelo `/upload` (que é tudo-ou-nada) — **mas só quando a planilha traz a coluna `gorjeta`**; sem a coluna nada é recusado por esse motivo (correção de 28/10, senão reimportar o arquivo exportado derrubava a planilha toda):

```sql
SELECT date_trunc('week', dt_inicial) AS semana,
       count(*) FILTER (WHERE COALESCE(valor,0) <= 0) AS zeradas, count(*) AS linhas_do_lote
FROM "EnvioMassa" WHERE dt_inicial > now() - interval '6 months'
GROUP BY 1 HAVING count(*) FILTER (WHERE COALESCE(valor,0) <= 0) > 0 ORDER BY 1 DESC;
```

**Grant da sequência (`0118`)**: em produção a `EnvioMassa` é a tabela legada (coluna IDENTITY, sequência sem ACL); o `nextval` explícito de `hub_repasse_alocar_envio_id` precisa de `GRANT USAGE, SELECT ON SEQUENCE "EnvioMassa_id_seq" TO authenticated`, que a `0118` agora contém. Conferir após aplicar: `SELECT has_sequence_privilege('authenticated','"EnvioMassa_id_seq"','USAGE');` deve dar `t`.

## ✅ Revisão adversarial de 3 camadas sobre o commit final (28/10) — 2 ALTOS, corrigidos

Blind Hunter (só o diff) · Edge Case Hunter (diff + projeto) · Acceptance Auditor (diff + spec), em
paralelo e sem contexto da sessão. As 16 ondas de auto-verificação **não** pegaram os dois; as três
camadas convergiram neles. Decisões do operador, já aplicadas no commit:

1. **`/upload` recusava o ARQUIVO INTEIRO por uma linha de valor 0, e o movimento só-gorjeta não
   sobrevivia ao round trip exportar→reimportar** — porque o `/export-envio-massa` não trazia a
   coluna `gorjeta`. Corrigido: a guarda exige `temColunaGorjeta` e o export passou a incluir
   `gorjeta`. **Afetava todos os tenants**, não só a Movee.
2. **O movimento só-gorjeta nascia ABERTO, era invisível ao motorista e travava a geração da semana
   seguinte** daquele CNPJ. Corrigido: nasce `mov_fechado = true` (ver Passo 5, item 7).
   Custo declarado: a correção pela tela pula movimento fechado, então a saída para essa linha é
   **apagar** (que segue disponível).

Mais um patch: **`/validate-xml-batch`** (`server.js:2528`) casava o movimento aberto sem
`valor=gt.0`, ao contrário das 4 rotas do app — um `erro_validacao` numa linha só-gorjeta
bloquearia o lote de pagamento. Corrigido.

**Sete achados refutados por medição primeira-mão** (não reinvestigar — detalhe em
`docs/specs/repasse-gera-movimento/spec.md` §Review Findings): `identity_generation` é **BY
DEFAULT**, não `ALWAYS` · `0117:75` já tem `CHECK (valor > 0)` · `lancamentos_externos` é `NOT NULL
DEFAULT 0` · a operação **já fecha** 98,3% dos movimentos (53.988 contra 937) · o ramo da `0109` na
`0119` está byte a byte idêntico, não exclui planilha · as 4 rotas do app são as certas · "apuração
fechada sem movimento" não é deadlock (o botão não depende do estado do período).

## Limites conhecidos (declarar ao financeiro)

- **Semana só-gorjeta: o motorista não vê NADA no card da home** (nem gorjeta, nem total) — o card depende de `valor > 0`. O financeiro vai ouvir "não apareceu nada no app". O pagamento ocorre normalmente; só a tela não mostra (dívida M5).

- ✅ **Gorjeta presa quando o pago por fora zera a nota — RESOLVIDO** (era achado ALTO da revisão adversarial; decidido pelo operador em 28/10, `dec-054`). **Não é mais limite conhecido; não declarar ao financeiro como pendência.** Comportamento de hoje: se o pago por fora zera a nota mas havia produção e sobrou gorjeta (`nota_a_emitir = 0`, `base_nota > 0`, `gorjeta > 0`), a geração **cria o movimento só-com-gorjeta** — `EnvioMassa` com `valor = 0`, `gorjeta > 0`, `total = gorjeta`, contado em **`gerados`** (FR-022; `lib/adiantamento-geracao-movimento.js:172`–`:173`). A `0119` faz o lote de pagamento **não** marcar esse movimento como `NOTA_PENDENTE` (nada a emitir), então ele é pago normalmente. O app do motorista **não** pede nota dele (filtro `valor=gt.0`, FR-023). `VALOR_ZERO` só recusa agora quando a base já era zero (o motorista não produziu) **ou** não há gorjeta — nos dois casos não há nada a pagar nem a emitir. **Exige as duas migrations**: só a `0118` deixa o movimento preso em nota pendente (ver Passo 2b).
- **O CSV e a tela continuam mostrando a nota BRUTA** ("Valor da nota fiscal da semana"); o movimento sai LÍQUIDO. A diferença é o pago por fora abatido. O app do motorista mostra a nota bruta no extrato e a líquida no card.
- **Apagar um movimento gerado** (`DELETE /envio-massa/:id`) não impede a próxima geração: ela o recria com o mesmo id.
- `EMPRESA_SEM_CNPJ` é checado depois do fechamento implícito (retomável: cadastre o CNPJ e gere de novo).
- Se a resposta HTTP se perder depois de gravar, o texto de falha pode dizer "nada foi gravado"; repetir é seguro (converge sem duplicar).
- Lista de pendências com `limit=5000`: se `PGRST_DB_MAX_ROWS` de produção for menor, o total mostrado subestima — a decisão de recusar continua correta.
- ✅ **E2E de browser: RODOU em 29/10 e está verde** — `hub-adiantamentos-e2e-browser.sh`, **15/15 em três rodadas
  consecutivas** (13,1s/13,2s/13,4s), depois de liberar disco (19 → 21 GiB). `package-lock.json` intacto.
  A primeira rodada deu 3 falhas e **nenhuma era defeito de produção**: eram stubs do próprio spec omitindo campo
  obrigatório do contrato (invisível ao `tsc`) e locator ambíguo em strict mode.
  - ⏳ **Resta o `hub-shell-e2e-browser.sh`**, e não é disco: ele roda contra as imagens do `hub-homolog` de **14/10**,
    sem bind mount do código, então validaria código anterior a esta entrega. Gatilho: rebuildar
    `hub-frontend:homolog` + `hub-backend:homolog` (~2 GB cada) e aplicar a **0119** no `hub_homolog` (ele tem só a
    0118). Não feito por iniciativa própria porque o disco que sobra é o que você precisa para os 3 builds do deploy.
