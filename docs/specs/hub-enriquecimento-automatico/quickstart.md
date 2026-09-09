# Quickstart: Enriquecimento automático de entregadores novos

Cenários que validam a implementação. Ambiente alvo de **todos** os cenários
(1–5 e 8–17): **`hub-homolog` isolado** (`infra/hub/compose.hub.homolog.yml`,
banco `hub_homolog_db`) — nunca produção. O cenário 6 é a única exceção: é a
verificação de pré-requisito que o **operador** roda antes de qualquer
aplicação em produção, e é leitura. O cenário 15 roda num container
descartável, sem tocar ambiente algum.

> Nesta entrega **nada é ligado em produção** (`dec-022`, resposta H1): a
> `0060` é aplicada e provada somente no `hub_homolog`, e o cutover fica
> condicionado à definição do prazo de retenção/expurgo da PII (`spec.md`
> FR-013, nota de pendência de cutover — CHK004/CHK020). Os comandos de
> habilitação por empresa (§Pré-condição comum, abaixo, e
> `contracts/entrego-desfecho.md` §4) ficam documentados para uso futuro do
> operador — nenhum deles é executado por este backlog.

> Ambiente de teste e credenciais de QA do hub-homolog estão no runbook
> (`infra/hub/RUNBOOK.md`). O hub-homolog usa cert self-signed.

> ### Pré-condição comum a todos os cenários de enfileiramento (FR-012)
>
> Depois de aplicar a `0060`, **habilitar a empresa de teste** — sem esta
> linha nada é enfileirado, por desenho (nega-por-padrão):
>
> ```sql
> INSERT INTO "EnriquecimentoAutomatico" (empresa_id, ativo, teto, desde)
> VALUES (<empresa_teste>, true, 100, now())
> ON CONFLICT (empresa_id) DO UPDATE
>    SET ativo = true, teto = EXCLUDED.teto, desde = now(), atualizado_em = now();
> ```
>
> `desde = now()` é o recorte de retroatividade: entregador criado **antes**
> desta linha nunca é alcançado (Scenario 13 prova).

---

## Scenario 1: Entregador novo entra na fila sozinho (US1 / FR-001 / SC-001) — happy path

1. Aplicar a `0060` no hub-homolog:
   `infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog`
1b. Habilitar a empresa de teste (Pré-condição comum, acima).
2. Anotar o conjunto atual de `id_externo` da empresa de teste:
   `SELECT id_externo FROM "Entregador" WHERE id_empresa = <empresa_teste>;`
3. Importar uma planilha contendo pelo menos um `id_externo` (uuid) **nunca
   visto** para essa empresa, pelo fluxo normal de importação do hub.
4. Consultar a linha criada:
   `SELECT id_externo, dados_entrego_solicitado_em, dados_entrego_desfecho FROM "Entregador" WHERE id_externo = '<uuid novo>';`
5. **Expected**:
   - `dados_entrego_solicitado_em` **preenchido** (carimbado pelo trigger), sem
     nenhuma ação manual;
   - `dados_entrego_desfecho = 'nunca-tentado'`;
   - o entregador aparece em
     `GET /api/v1/robo-entrego/motoristas-para-enriquecer?modo=sob-demanda`.

---

## Scenario 2: Reimportação NÃO mexe no estado de fila (US1 cenário 2 / FR-002) — o cenário que mais importa

Este é o cenário que prova a decisão técnica central. Rodar nas **duas**
variantes.

### 2a — entregador preexistente FORA da fila

1. Escolher um `Entregador` já existente com
   `dados_entrego_solicitado_em IS NULL` e `dados_entrego_enriquecidos_em`
   preenchido (já enriquecido no passado).
2. Anotar `dados_entrego_solicitado_em`, `dados_entrego_desfecho`,
   `dados_entrego_enriquecidos_em` e `nome`.
3. Reimportar uma planilha que contenha esse mesmo `id_externo` **com nome
   diferente** (para provar que o UPDATE de fato ocorreu).
4. **Expected**:
   - `nome` mudou ⇒ prova que o ramo `DO UPDATE` executou;
   - `dados_entrego_solicitado_em` **continua `NULL`** — não foi forçado à
     fila;
   - `dados_entrego_desfecho` e `dados_entrego_enriquecidos_em` **inalterados**.

### 2b — entregador preexistente DENTRO da fila

1. Escolher/forçar um `Entregador` com `dados_entrego_solicitado_em`
   preenchido com um timestamp T conhecido.
2. Reimportar planilha contendo esse `id_externo`.
3. **Expected**: `dados_entrego_solicitado_em` **ainda é exatamente T** — não
   foi removido da fila nem re-carimbado. (Se tivesse sido re-carimbado, a
   ordenação `.asc` da fila mudaria e o item perderia sua posição.)

---

## Scenario 3: `id_externo` repetido no mesmo lote conta como uma criação (US1 cenário 3 / FR-003)

1. Montar uma planilha com **duas ou mais linhas** do mesmo `id_externo` novo,
   em datas diferentes.
2. Importar.
3. **Expected**:
   - exatamente **uma** linha em `"Entregador"` para esse `id_externo`
     (`SELECT count(*) … = 1`);
   - `dados_entrego_solicitado_em` preenchido uma única vez;
   - o item aparece **uma vez só** no `GET …/motoristas-para-enriquecer`.

---

## Scenario 4: Os 4 desfechos são distinguíveis (US2 / FR-005 / FR-006 / SC-002)

Exercitar o `PATCH /api/v1/robo-entrego/motoristas/:id/entrego-enriquecimento`
com as 4 combinações e conferir a coluna resultante:

| # | Corpo enviado | `dados_entrego_desfecho` esperado |
|---|---|---|
| 4.1 | (nenhum PATCH — linha recém-criada) | `nunca-tentado` |
| 4.2 | `{ "sucesso": false, "sinalFalha": "pessoa_nao_encontrada", "motivoFalha": "...", "modo": "sob-demanda" }` | `pessoa-nao-encontrada` |
| 4.3 | `{ "sucesso": false, "sinalFalha": "relatorio_sem_dados", "modo": "sob-demanda" }` | `outra-falha` |
| 4.4 | `{ "sucesso": false, "modo": "sob-demanda" }` (sem `sinalFalha`) | `outra-falha` |
| 4.5 | `{ "sucesso": true, "dados": {...}, "modo": "sob-demanda" }` | `sucesso` |

**Expected adicional em 4.5**: `dados_entrego_enriquecidos_em` foi preenchido
**no mesmo PATCH** (invariante dec-010) e `dados_entrego_solicitado_em` voltou
a `NULL` (saiu da fila).

**Expected adicional em 4.2/4.3/4.4**: `dados_entrego_solicitado_em` voltou a
`NULL`, e o valor de `dados_entrego_desfecho` é distinguível por consulta
direta: `?dados_entrego_desfecho=eq.pessoa-nao-encontrada`.

### 4.6 — Error case: `sinalFalha` desconhecido não derruba o endpoint

1. `PATCH` com `{ "sucesso": false, "sinalFalha": "valor_que_nao_existe_123" }`.
2. **Expected**: `200 { ok: true }` e `dados_entrego_desfecho = 'outra-falha'`.
   **Nunca** `422` e **nunca** `500` por violação de `CHECK`. (Perder o PATCH
   significaria perder trabalho já feito no portal.)

### 4.7 — Verificação repetida de SC-004 (janela de 7 dias)

1. Após 4.2 (entregador em `pessoa-nao-encontrada`), deixar o consumidor
   automático rodar normalmente pelo menos **7 dias corridos** no ambiente
   de teste (ou observar em produção pós-cutover), sem nenhuma ação
   manual sobre esse entregador.
2. A cada execução do consumidor nessa janela, checar
   `dados_entrego_desfecho` do entregador.
3. **Expected**: em nenhuma execução o valor volta sozinho a
   `nunca-tentado` — permanece `pessoa-nao-encontrada` até uma nova
   tentativa (automática ou manual) de fato rodar e produzir um desfecho
   diferente (SC-004).

---

## Scenario 5: Falha posterior não descarta sucesso anterior (FR-007 + FR-008 juntos)

O cenário que impede uma futura "simplificação" de quebrar o invariante.

1. Enriquecer um entregador com sucesso (4.5 acima). Anotar
   `dados_entrego_json` e `dados_entrego_enriquecidos_em`.
2. Re-enfileirá-lo manualmente:
   `POST /api/v1/motoristas/:id/entrego-enriquecimento` ⇒ `202 pendente`.
3. Enviar `PATCH` com
   `{ "sucesso": false, "sinalFalha": "pessoa_nao_encontrada" }`.
4. **Expected**:
   - `dados_entrego_desfecho = 'pessoa-nao-encontrada'` (FR-007 — vence a
     tentativa mais recente);
   - `dados_entrego_json` **preservado**, idêntico ao passo 1 (FR-008);
   - `dados_entrego_enriquecidos_em` **preservado**, idêntico ao passo 1.
   - Ou seja: `desfecho = 'pessoa-nao-encontrada'` **com**
     `enriquecidos_em` preenchido é um estado **válido e esperado**. Um teste
     que afirme a bicondicional `sucesso ⟺ enriquecidos_em` está errado.
5. Repetir o passo 2 e agora enviar `{"sucesso": true, "dados": {...}}`.
6. **Expected**: `dados_entrego_desfecho` volta a `sucesso` — a marca
   `pessoa-nao-encontrada` **não** é permanente (US2 cenário 4).

---

## Scenario 6: Verificação de pré-requisito em produção — **rodar ANTES de aplicar a `0060` no `chatmasterveloz`**

Executado **pelo operador** (o agente não acessa produção). É leitura pura,
não escreve nada.

1. No banco `chatmasterveloz`:
   ```sql
   SELECT p.proname
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname IN ('hub_jwt_claims', 'hub_jwt_origem_importacao');
   ```
2. **Expected**: **as duas** funções retornam. A `0060` depende de
   `hub_jwt_origem_importacao()`, que por sua vez depende de
   `hub_jwt_claims()`.
3. **Se qualquer uma faltar**: **NÃO aplicar a `0060`**. Devolver ao operador
   — significa que a série de migrations em produção divergiu do que o
   documento de cutover registra, e o trigger seria criado apontando para uma
   função inexistente.

> **Por que este cenário existe**: a evidência de que a `0025` foi aplicada em
> produção é **documental**
> (`docs/plans/hub-frota/G3-CUTOVER-STATUS-E-RETOMADA.md:43` — "série
> 0000–0046 aplicada"), e o cabeçalho da própria `0025:40-42` afirma o
> contrário para a época em que foi escrita. Somado ao fato conhecido de que
> **`SchemaMigration` mente quando uma migration é aplicada fora do
> `migrate.sh`**, documento não basta: só a consulta ao vivo prova.

### 6.1 — Dimensionar o backfill (leitura, antes de aplicar)

1. No banco alvo:
   ```sql
   SELECT count(*) FILTER (WHERE dados_entrego_enriquecidos_em IS NOT NULL) AS vira_sucesso,
          count(*)                                                          AS total
     FROM "Entregador";
   ```
2. **Expected**: `vira_sucesso` é exatamente o número de linhas que o backfill
   da `0060` marcará como `sucesso`; as demais ficam `nunca-tentado`. Anotar
   os dois números **antes** de aplicar, para conferir depois.
3. Após aplicar, reconferir:
   `SELECT dados_entrego_desfecho, count(*) FROM "Entregador" GROUP BY 1;`
   ⇒ `sucesso` deve bater com `vira_sucesso` do passo 1.

> Este número **não** é o mesmo que os 471 vínculos de credencial do backfill
> da feature `hub-motorista-360` — aquele mede `motorista_id` preenchido por
> similaridade de nome, não enriquecimento pela EntreGô.

### 6.2 — Após aplicar a `0060` em qualquer ambiente

1. Confirmar que o PostgREST recarregou o schema cache (a `0060` adiciona uma
   coluna; sem reload, o PostgREST responde `400` para
   `?select=dados_entrego_desfecho`). O `migrate.sh` envia `SIGUSR1`.
2. **Expected**: `GET …/Entregador?select=id,dados_entrego_desfecho&limit=1`
   responde `200` com o campo presente.

> ⚠️ Sonda HTTP em `/rpc/` **não** prova reload do PostgREST — conferir pela
> contagem de funções no log do container, gotcha já registrado no projeto.

---

### 6.3 — Prova pós-deploy de que o trigger NÃO ficou inerte (gate `owasp-security`, L2)

Passar no Cenário 6 prova que a função **existe**, não que o trigger
**funciona**. Se `hub_jwt_origem_importacao()` existir em produção com corpo
divergente (gotcha conhecido: **`SchemaMigration` mente quando a migration é
aplicada fora do `migrate.sh`**), o trigger não dispara e **FR-001 falha em
silêncio** — nenhum erro, nenhum alarme, só entregadores que nunca entram na
fila.

1. Após a primeira importação real pós-deploy, contar quantas linhas criadas
   por ela entraram na fila:
   ```sql
   SELECT count(*) FROM "Entregador"
    WHERE criado_em > <timestamp do início da importação>
      AND dados_entrego_solicitado_em IS NOT NULL;
   ```
2. **Expected**: `>= 1` sempre que a importação tiver criado ao menos um
   entregador novo. Resultado `0` **com** entregadores novos criados ⇒ trigger
   inerte ⇒ investigar o corpo da função em produção antes de declarar a
   feature entregue.

> Este é o mesmo padrão de "prova com controle" já adotado no projeto: HTTP 200
> prova que o serviço subiu, não que subiu o comportamento certo.

---

## Scenario 7: Roundtrip real robô ↔ hub (borda de 2 camadas)

Esta feature não tem borda backend↔frontend (escopo backend, dec-011). A borda
real é **robô ↔ hub**, e é ela que precisa de roundtrip empírico — não mock.

1. Em git **worktree** separado (nunca no diretório vivo), aplicar a mudança de
   `infra/robo-entrego/src/hub-client.js` + `enriquecimento.js`.
2. Rodar a suíte do robô no worktree: `node --test infra/robo-entrego/test/`.
3. Apontar o robô para o hub-homolog e provocar uma falha
   `ErroPessoaNaoEncontradaNoPortal` real (ou injetada no fake do portal).
4. Capturar o corpo HTTP **de fato enviado** ao hub e comparar campo a campo
   com `contracts/entrego-desfecho.md §1`:
   - `sinalFalha` presente e com o valor `pessoa_nao_encontrada`;
   - `dados` **ausente** no ramo de falha (regra existente preservada);
   - `motivoFalha` continua presente.
5. Conferir no banco: `dados_entrego_desfecho = 'pessoa-nao-encontrada'`.
6. **Expected**: zero divergência entre o corpo real, o contrato declarado e a
   coluna gravada.

> Após o merge, a suíte precisa ser provada **no diretório vivo**
> (`infra/robo-entrego/`), porque é de lá que o `ExecStart` do systemd roda —
> merge equivale a deploy para esse componente.

---

## Scenario 8: Regressão — criação MANUAL não enfileira (gate `owasp-security`, L3)

A garantia de que o `POST /motoristas` não enfileira é a **ausência** da claim
`origem_importacao`. Isso é frágil por omissão: um futuro caller que espalhe
`job.claims` (padrão usado várias vezes no processador de importação)
reintroduz o efeito **sem quebrar nenhum teste existente**. Este cenário torna
a omissão observável.

1. Criar um motorista pela API: `POST /api/v1/motoristas` com `nome` e
   `idExterno` (uuid novo) ⇒ `201`.
2. Consultar a linha criada.
3. **Expected**: `dados_entrego_solicitado_em IS NULL` e
   `dados_entrego_desfecho = 'nunca-tentado'`. O motorista **não** aparece em
   `GET …/motoristas-para-enriquecer?modo=sob-demanda`.
4. Como controle (prova de que o teste consegue falhar): repetir o Cenário 1
   e confirmar que **ali** a coluna é preenchida. Um teste que passa nos dois
   casos não está medindo nada.

---

## Scenario 9: Medição de SC-003 — o número que motivou a feature

SC-003 é o critério que justifica a feature ("hoje esse número cresce
continuamente sem intervenção manual: 67 → 75 em 1 hora medido em produção") e
precisa de uma forma de medição explícita, senão não há como afirmar que foi
atingido.

**Métrica**: entregadores criados nas últimas 24 h que **não** têm nenhuma
tentativa **e** estão **fora** da fila.

```sql
SELECT count(*) AS sc003
  FROM "Entregador"
 WHERE criado_em > now() - interval '24 hours'
   AND dados_entrego_desfecho = 'nunca-tentado'
   AND dados_entrego_solicitado_em IS NULL;
```

1. **Antes** de ativar o trigger: rodar a consulta duas vezes com ~1 h de
   intervalo, num dia em que houve importação. **Expected**: número > 0 e
   **crescendo** — é a linha de base que reproduz o problema relatado.
2. **Depois** de ativar o trigger, repetir nas mesmas condições.
3. **Expected**: o número **tende a zero** e para de crescer. Entregadores
   criados por importação passam a ter `dados_entrego_solicitado_em`
   preenchido, então saem do numerador por construção.

> **Cuidado de interpretação**: um resultado `0` **sem** a medição de linha de
> base do passo 1 não prova nada — pode significar apenas que nenhuma
> importação criou entregadores naquele período. A medição só tem valor com o
> controle (mesma disciplina do Cenário 8).

> Entregadores criados **manualmente** (Cenário 8) contam legitimamente para
> essa métrica e **não** são zerados por esta feature — o escopo de FR-001 é
> criação por importação.

---

## Scenario 10: O teto segura a importação grande, e o excedente não se perde (FR-010 / SC-005)

Prova a resposta H2 do operador. Rodar com um teto **pequeno** para não
precisar de planilha de 250 linhas.

1. Baixar o teto da empresa de teste:
   `UPDATE "EnriquecimentoAutomatico" SET teto = 3, atualizado_em = now() WHERE empresa_id = <empresa_teste>;`
2. Garantir fila vazia:
   `UPDATE "Entregador" SET dados_entrego_solicitado_em = NULL, dados_entrego_solicitado_manual = false WHERE id_empresa = <empresa_teste>;`
3. Importar uma planilha com **7** `id_externo` novos.
4. Contar:
   `SELECT count(*) FROM "Entregador" WHERE id_empresa = <empresa_teste> AND dados_entrego_solicitado_em IS NOT NULL;`
5. **Expected**: exatamente **3** — nunca 7. Os outros 4 estão com
   `dados_entrego_solicitado_em IS NULL` e `dados_entrego_desfecho =
   'nunca-tentado'` (ficaram **sem enfileirar**, não foram perdidos).
6. Reimportar **a mesma planilha** (agora todas as 7 linhas caem no ramo
   `ON CONFLICT DO UPDATE`).
7. **Expected**: a contagem continua **3** — o teto ainda está cheio, nada
   novo entra. Isso prova que o teto é de fila pendente, não por importação.
8. Simular o consumo, esvaziando a fila:
   `UPDATE "Entregador" SET dados_entrego_solicitado_em = NULL WHERE id_empresa = <empresa_teste> AND dados_entrego_solicitado_em IS NOT NULL;`
   e marcar os 3 consumidos como já tentados
   (`dados_entrego_desfecho = 'outra-falha'`) para que não voltem à fila.
9. Reimportar a mesma planilha pela terceira vez.
10. **Expected**: mais **3** enfileirados — os que haviam sobrado. É o
    "excedente entra na importação seguinte" (FR-010, segunda metade),
    entregue pelo evento `UPDATE` do gatilho.
11. Restaurar `teto = 100`.

> **Error case a conferir no mesmo passo**: com o teto cheio, a importação
> MUST concluir normalmente (nenhum `500`, nenhuma linha rejeitada). O teto
> nunca falha a importação — ele só deixa de carimbar.

---

## Scenario 11: O pedido manual fura a fila (FR-011 / SC-006)

Prova a resposta M1 do operador.

1. Enfileirar automaticamente **5** entregadores (importação com 5
   `id_externo` novos), com `teto >= 5`.
2. Conferir que todos têm `dados_entrego_solicitado_manual = false`.
3. **Depois** disso, disparar um pedido manual para um sexto entregador (que
   já existia e não estava na fila):
   `POST /api/v1/motoristas/<id>/entrego-enriquecimento` ⇒ `202`.
4. Conferir a coluna:
   `SELECT dados_entrego_solicitado_manual, dados_entrego_solicitado_em FROM "Entregador" WHERE id = <id>;`
   ⇒ `true`, carimbo **mais recente** que os 5 automáticos.
5. Chamar a fila:
   `GET /api/v1/robo-entrego/motoristas-para-enriquecer?modo=sob-demanda`.
6. **Expected**: o **primeiro** item da resposta é o do pedido manual, apesar
   de ter sido o último a entrar. Os 5 automáticos vêm depois, em FIFO entre
   si.
7. Fechar o ciclo: `PATCH .../entrego-enriquecimento` com `sucesso: true` para
   esse id e conferir que `dados_entrego_solicitado_manual` voltou a `false`
   junto com `dados_entrego_solicitado_em = NULL` (mesmo PATCH).

---

## Scenario 12: Empresa não habilitada não enfileira nada (FR-012 / FR-013 / SC-007)

Prova as respostas M2 e H1 — e é o cenário que garante que aplicar a `0060`
em produção, sozinha, **não** liga coleta de PII nenhuma.

1. Escolher uma segunda empresa de teste **sem** linha em
   `"EnriquecimentoAutomatico"` (ou com `ativo = false`).
2. Importar para ela uma planilha com `id_externo` novos.
3. **Expected**:
   - as linhas são criadas normalmente (importação não falha);
   - **nenhuma** tem `dados_entrego_solicitado_em` preenchido;
   - a fila dessa empresa permanece vazia;
   - nenhum erro/aviso no log do PostgREST — o gatilho simplesmente não
     encontra linha de habilitação para ela.
4. Ligar (`ativo = true, desde = now()`), reimportar a **mesma** planilha e
   conferir que agora os entregadores **não** entram — porque `criado_em <
   desde` (é o Scenario 13). Para vê-los entrar, importar `id_externo` novos.
5. Desligar de novo (`ativo = false`) e conferir que uma nova importação com
   `id_externo` novos volta a não enfileirar — **reversão sem deploy**
   (FR-013).

---

## Scenario 13: Retroatividade continua fora — o recorte `desde` (FR-002)

O evento `UPDATE` do gatilho (necessário para o excedente do teto)
poderia, sem o recorte, varrer o passivo histórico de entregadores nunca
enriquecidos. Este cenário prova que não varre.

1. Antes de habilitar, criar (ou identificar) um entregador com
   `dados_entrego_solicitado_em IS NULL`, `dados_entrego_enriquecidos_em IS
   NULL` e `dados_entrego_desfecho = 'nunca-tentado'` — o perfil exato do
   passivo que motivou a feature.
2. Anotar seu `criado_em`.
3. Habilitar a empresa com `desde = now()` (portanto **posterior** ao
   `criado_em` anotado).
4. Importar uma planilha que **inclua** o `id_externo` desse entregador (cai
   no ramo `ON CONFLICT DO UPDATE`), com o teto folgado.
5. **Expected**: `dados_entrego_solicitado_em` desse entregador continua
   `NULL`. Ele **não** foi enfileirado, mesmo tendo sido tocado pela
   importação e mesmo satisfazendo todos os outros predicados.
6. Prova complementar: um entregador criado **depois** da habilitação, que
   tenha ficado fora por teto, **é** enfileirado na mesma importação
   (Scenario 10 passo 10). O único discriminador entre os dois é `criado_em`
   vs `desde`.

---

## Scenario 14: Os dois gatilhos `BEFORE UPDATE` convivem (regressão de `0019`/`0025`)

A `0060` acrescenta um segundo gatilho `BEFORE UPDATE … FOR EACH ROW` sobre
`"Entregador"`; `trg_entregador_protege_nome` já estava lá. Este cenário prova
que o novo não desligou o antigo.

1. Marcar um entregador com `nome_editado_manualmente = true` e um nome
   editado à mão.
2. Reimportar uma planilha que traga **outro** nome para o mesmo
   `id_externo`, pela importação normal (com a claim `origem_importacao`).
3. **Expected**:
   - o `nome` editado à mão **permanece** (comportamento de `0025`, intacto);
   - o estado de fila desse entregador continua obedecendo às regras da
     `0060` (não é enfileirado se já foi tentado / se é anterior a `desde` /
     se o teto está cheio).
4. Conferir a ordem de disparo, se necessário:
   `SELECT tgname FROM pg_trigger WHERE tgrelid = '"Entregador"'::regclass AND NOT tgisinternal ORDER BY tgname;`

> Os dois escrevem campos disjuntos (`dados_entrego_solicitado_em` vs `nome`)
> e o PostgreSQL os encadeia em ordem alfabética de nome, cada um recebendo o
> `NEW` devolvido pelo anterior — a ordem é indiferente ao resultado.

---

## Scenario 15: Reproduzir as medições do desenho (opcional, 2 min)

O desenho do gatilho foi validado empiricamente em `postgres:13.23` antes de
virar artefato (`data-model.md` §Evidência empírica). Para reproduzir sem
tocar em ambiente algum:

1. Subir um Postgres descartável:
   `docker run --rm -d --name hub-test-pgprobe -e POSTGRES_PASSWORD=probe --memory=512m postgres:13`
2. Criar réplica mínima de `"Entregador"` + `"EnriquecimentoAutomatico"` + um
   stub de `hub_jwt_origem_importacao()` lendo `current_setting`.
3. Instalar a função e o gatilho **literais** de `data-model.md`.
4. Rodar os casos da tabela de evidência (teto=3 com lote de 7; reimportar;
   drenar e reimportar; empresa 99 sem habilitação; `criado_em` anterior a
   `desde`; `INSERT` sem a claim; ordenação manual-primeiro; lote de 500).
5. `docker rm -f hub-test-pgprobe`.

Nenhum passo toca produção, o hub-homolog ou qualquer volume — o container é
`--rm`, sem portas e sem volumes.

---

## Scenario 16: Regressão do evento `UPDATE` — só a importação alcança o gatilho (gate `owasp-security`, L3 estendido)

O Scenario 8 já prova que a criação **manual** não enfileira. Com o gatilho
cobrindo também `UPDATE`, a mesma garantia precisa valer para toda escrita de
`UPDATE` que **não** seja importação.

1. Com a empresa habilitada, teto folgado e um entregador criado **depois** de
   `desde`, ainda `nunca-tentado` e fora da fila.
2. Executar, **sem** a claim `origem_importacao`, cada um destes caminhos
   reais e conferir que **nenhum** enfileira:
   - `PATCH /api/v1/motoristas/:id` (edição de dados do motorista);
   - `PATCH /api/v1/robo-entrego/motoristas/:id/entrego-enriquecimento` com
     `sucesso: false` (o robô fechando uma tentativa);
   - `POST /api/v1/motoristas/:id/vinculo`.
3. **Expected**: `dados_entrego_solicitado_em` permanece `NULL` em todos.
4. Teste de guarda no código, não só de comportamento: `grep -rn
   "origemImportacao" app_homologacao/backend/` deve continuar retornando
   **um único** produtor (`lib/hub-import-processor.js`). Um segundo produtor
   é uma mudança de superfície e exige revisão.

> Por que este cenário existe: a garantia de que o `UPDATE` não enfileira
> indevidamente é a **ausência** da claim. Um futuro caller que espalhe
> `job.claims` reintroduziria o efeito sem quebrar nenhum outro teste.

---

## Scenario 17: RLS da tabela de habilitação (gate `owasp-security`, onda-005)

1. Autenticar como usuário da empresa A e consultar a tabela de habilitação
   pelo PostgREST com o escopo de A.
2. **Expected**: vê **apenas** a linha de A — nunca a de outra empresa,
   mesmo que exista.
3. Conferir que a importação de A continua enfileirando normalmente (a
   política de `SELECT` não pode quebrar o gatilho, que roda `SECURITY
   INVOKER` com o JWT da importação).
4. Tentar `INSERT`/`UPDATE` na tabela via PostgREST com JWT de usuário comum.
5. **Expected**: negado — não há grant de escrita para `authenticated`.
