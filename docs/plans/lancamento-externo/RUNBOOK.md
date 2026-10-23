# RUNBOOK — `lancamento-externo` (execução do OPERADOR)

**Feature**: importar lançamentos pagos por fora e descontá-los do repasse
**Spec**: [`docs/specs/lancamento-externo/spec.md`](../../specs/lancamento-externo/spec.md) · **Plano**: [`plan.md`](../../specs/lancamento-externo/plan.md)

> 🔴 **"Homologação" É produção.** Todo passo deste runbook é executado pelo
> **operador**. O agente entrega artefatos (código, migration, testes, este
> runbook) e **não toca o ambiente vivo** (FR-044).

> ⏱ **A janela é 26/10 até o fechamento.** `apuracao_dia_inicio=1` (segunda) e
> `apuracao_dias_ate_repasse=3` ⇒ semana **19–25/10**, pagamento **quarta 28/10**.
> Depois do fechamento o lançamento **não tem mais efeito**: o retrato é imutável.

> 🔴 **A semana 19–25/10 é a PRIMEIRA apuração fechada na história do sistema.**
> `ApuracaoRepasse` tinha **zero** registros em 2026-10-22. O caminho de
> fechamento nunca rodou em produção com dado real, e ele é **irreversível**. É
> por isso que o passo **4** não é recomendação: é parte do procedimento.

---

## 0 · O que depende de **você** (o agente não decide nem executa nenhum destes)

| # | Decisão / ação | Por quê é sua |
|---|---|---|
| H1 | **Reconfirmar o apetite de risco de FR-022**: com `desconto_adiantamentos` **desligada**, a dedução **não** entra e a empresa **paga duas vezes** o que já pagou por fora. O aviso (FR-049) só existe para quem tem `pagamentos_consultar` — a permissão que ainda vai mudar | é risco de dinheiro da empresa |
| H2 | **Autorizar** a migration e o deploy em produção (autorização para *esta* mudança), **escolher a janela** e **executar** | rito de produção, 5 gates |
| H3 | **Confirmar a versão do Postgres de produção** (`SHOW server_version;`). O DDL da 0117 foi escrito e testado para **<= PG 12** de sintaxe e rodou no PG 13.23 do isolado; produção pode diferir | só você alcança o banco vivo |
| H5 | **PARTE RESOLVIDA em 2026-10-23, parte ainda sua**: o operador **autorizou mostrar a parcela "pago por fora"** (emenda de FR-040, FR-053) — a prévia e a semana fechada do hub e o app do motorista (semana em curso e última fechada) agora têm a parcela e a conta fecha; custo aceito: `DROP`+`CREATE`+`GRANT` em 4 funções e rollback de outra natureza (§2.R). **Ainda é decisão sua**: a divisão **nota / fora da nota** do saldo transportado (`transportado_nota`/`transportado_fora`) parte só dos créditos e **não** inclui o termo externo — herdado do desenho vigente (já ignora o adiantamento do app e o débito), não regressão; nenhum `CHECK` quebra e o dinheiro é conservado. Falta decidir se `AJUSTE_CREDITO` conta como "nota" ou "fora". O **CSV de exportação do repasse ganhou a coluna "Pago por fora (líquido)"** (rodada 1 do code review: sem ela a conta do CSV não fecha); é a **13ª e última** coluna, as doze de antes não mudaram de posição | produto / contábil |
| H6 | **Crédito externo NÃO exige nota no lote** (decisão tomada em 2026-10-23, rodada 2 do code review — registrada aqui para você saber o que mudou): `hub_repasse_lote_avaliar` (função de dinheiro) deixa de devolver `NOTA_PENDENTE` para o item cujo valor vem só de `AJUSTE_CREDITO` (sem produção na semana). ⚠️ **Inverte a invariante "faturado ≥ pago"**: o lote passa a pagar valor SEM `EnvioMassa` correspondente. Semana **mista** (produção + crédito): a nota continua só da produção e o lote paga o total. `ADIANTAMENTO` (dedução) **não muda**. Sexta função tocada: `CREATE OR REPLACE` (sem DROP, ACL inalterada), ver §1(f) e §2.R | é dinheiro pago sem nota; spec FR-054 |
| H7 | **Um lançamento por motorista, por dia, por tipo** (decisão de 2026-10-23: a chave FICA): dois pagamentos ao mesmo motorista no mesmo dia/tipo → o 2º volta `DUPLICADA_NO_ARQUIVO` (mesmo arquivo) ou `VALOR_DIVERGENTE` (arquivos separados) e **NÃO é deduzido — o repasse paga de novo**. A planilha tem de **somar os pagamentos do dia numa linha ANTES de enviar**. Lançamento já aplicado é imutável: somar e reenviar depois **não** o altera. As mensagens do diálogo dizem isso | produto; avise o financeiro |
| H8 | **Importar o FATURAMENTO da semana ANTES dos pagos por fora** (rodada 4, M7): a dedução é conferida contra o líquido **no instante do import**. Faturamento ainda não importado ⇒ líquido 0 ⇒ **100% das linhas de `ADIANTAMENTO` voltam `VALOR_EXCEDE_LIQUIDO`** e nada é aplicado. É a falha operacional mais provável da primeira segunda-feira | é a ordem do seu trabalho; ver §4.1 |
| H9 | **Remanescente negativo no fechamento** (rodada 4, A2 — decisão de desenho do operador): o fechamento **não recusa**; o diálogo **informa** quantos motoristas e quantos R$ não seriam pagos nem transportados e **exige confirmação explícita**. Débito de faturamento que chega depois do import, ou a flag `desconto_adiantamentos` ligada com a semana aberta, podem criar esse negativo | fechar é irreversível; a decisão de seguir é sua |
| H10 | **Ordem de deploy: a MIGRATION 0117 entra ANTES do código** (rodada 5): o código novo (backend e frontend) pede a tabela, as funções e a coluna `lancamentos_externos`; o código **antigo** segue funcionando sem a 0117. Na ordem inversa a tela de fechar e as rotas novas falham até a migration entrar. A 0117 **nunca foi aplicada** no ambiente vivo (só no `hub_homolog`). Ordem: 0117 → backend → frontend_v2 → só então importar | rito de produção; é a sua janela |
| H11 | **Guarda de exclusão (rodada 5, C3)**: excluir um **crédito** é recusado (`EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO`) **somente** quando existe um lançamento de dedução do **mesmo motorista e semana** que o operador consiga apagar. Deduções do app e débitos de faturamento **não** travam a exclusão (não são apagáveis ali) — elas podem deixar o líquido negativo, e isso aparece no aviso de negativo do fechamento (H9) | evita crédito "imortal" |
| H4 | **Decidir o que fazer se a prévia não bater** (passo 4): o runbook manda parar; quem decide o próximo passo é você | o fechamento é irreversível |

### 0.1 · O defeito que quase foi entregue — *feature escrita, caminho não ligado*

Na primeira versão a `0117` criava a tabela e a função `aplicar`, e **nada mais**.
`LancamentoExterno` não aparecia em **nenhum outro ponto** da série: a **prévia**
(`0100`) e o **fechamento** (`0098`) — as funções que de fato calculam o repasse —
**não a liam**. O financeiro subiria a planilha, veria "N aplicadas", e o repasse
pagaria o **valor cheio**. Tudo verde, nada ligado.

> **Reincidência dentro da própria correção.** A 1ª versão da seção 8 religou a prévia e o
> fechamento e **esqueceu a terceira função viva** — `hub_adiantamento_repasse_motorista()`
> (`0098:515`), a que o **app do motorista** lê, e que a própria FR-022 nomeia. Quem pegou foi a
> **revisão independente**, não o autor: o motorista veria um remanescente e receberia outro.
> Hoje a seção 8.3 a cobre e o cenário `C16` do driver a prova. A correção é a **seção 8** da
`0117` (redefine as **cinco** funções vivas do repasse — prévia, fechamento, a do app do motorista, o congelado e o último fechado — e, na seção 9, a `hub_repasse_lote_avaliar` do lote) e é por causa dela que este runbook exige
**provar o corpo da função**, não o exit code (passo 2) e **conferir a prévia**
(passo 4).

É a **terceira** manifestação do mesmo padrão nesta frente de trabalho (a F5 que
ficou inerte; o `VALOR_AMBIGUO` que nunca chegava à tela; esta). **Um import que
responde "aplicadas" sem mudar nenhum número da prévia é este defeito de novo.**

---

## Ordem (não inverta)

```text
1. Pré-flight          2. Migration 0117       3. Deploy do código
        ↓                      ↓                       ↓
4. IMPORTAR + CONFERIR A PRÉVIA  →  5. Fechar  →  6. Pós-fechamento
   (4 só depois de o FATURAMENTO da semana estar importado — senão toda dedução é recusada)
```

**Migration ANTES do código.** O código novo pede a tabela e as funções; o
código **antigo** não conhece nada da 0117 e segue funcionando (todo acréscimo é
aditivo, com default neutro). Na ordem inversa, o código novo quebra enquanto a
migration não entrar.

---

## 1 · Pré-flight

```bash
# a) disco — abortar se < ~20 GB livres (incidente 2026-08-30 derrubou o banco)
df -h /

# b) qual imagem está no ar AGORA — esta é o rollback, anote
docker service ls --filter name=envio-massa-homologacao_ --format '{{.Name}}\t{{.Image}}'

# c) a apuração continua zerada? (o fato é de 22/10 — reconferir)
#    Se já houver apuração fechada, o caminho "primeira apuração" deixa de ser
#    o que roda: avise antes de seguir.
#    psql de produção: -U chatmasterveloz (NÃO postgres)
SELECT count(*) AS apuracoes, max(periodo_inicio) AS ultima FROM "ApuracaoRepasse";

# d) a config não mudou?
SELECT apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
       desconto_adiantamentos, desconto_debitos, repasse_valor_minimo
FROM hub_adiantamento_config_vigente(6);
```

```sql
-- e) versão do Postgres de produção (H3) e o corpo VIVO das CINCO funções que a 0117 vai redefinir
SHOW server_version;
```

```bash
# f) GUARDAR o corpo E A ACL das SEIS funções (as cinco do repasse + a avaliar do lote, H1) — é o ROLLBACK delas (passo 2.R).
#    Fora do repo, em /var/lib ou ~/ ; conferir que os 6 arquivos NÃO estão vazios.
#    (a ACL entra porque o rollback agora é DROP+CREATE e o DROP apaga os GRANT)
PG="docker exec -i <pgadmin_db> psql -U chatmasterveloz -d chatmasterveloz -tAc"
for par in "fechar:hub_adiantamento_repasse_fechar(date)" \
           "previa:hub_adiantamento_repasse(date,text,boolean,integer,integer)" \
           "app:hub_adiantamento_repasse_motorista()" \
           "congelado:hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer)" \
           "ultimo:hub_adiantamento_repasse_motorista_ultimo_fechado()" \
           "aval:hub_repasse_lote_avaliar(bigint[],integer[])"; do
  n="${par%%:*}"; f="${par#*:}"
  $PG "SELECT pg_get_functiondef('$f'::regprocedure)" > ~/le-pre0117-$n.sql ; echo ';' >> ~/le-pre0117-$n.sql
  $PG "SELECT md5(pg_get_functiondef('$f'::regprocedure)) || ' ' || COALESCE(proacl::text,'<nulo>') FROM pg_proc WHERE oid='$f'::regprocedure" | tee ~/le-pre0117-$n.md5acl
done
wc -l ~/le-pre0117-*.sql        # nenhum pode ser 1 linha só
# ANOTE cada linha "md5 acl": a prova do rollback compara os DOIS (corpo E ACL) com elas.
```

**Esperado em (c)**: `0`. **Esperado em (d)**: `1 · 3 · data_lancamento · t · t · 5.50`.
Qualquer divergência: **pare e devolva ao agente** — o plano foi desenhado sobre
esses números.

---

## 2 · Migration `0117`

```bash
# Produção: aplicar ARQUIVO A ARQUIVO (a SchemaMigration já mentiu antes
# quando se aplicou fora do migrate.sh — producao-2026-09-27)
# DDL + registro na SchemaMigration na MESMA transação.
```

A `0117` **nunca foi a produção**: o passo de produção é a sua **primeira**
aplicação lá (não há registro a remover da `SchemaMigration`; o `DELETE` do
registro foi coisa só do `hub_homolog` isolado, para reaplicar a versão corrigida).
Ela é **idempotente** e foi aplicada sem erro no `hub_homolog` isolado (PG 13.23), por
dois mecanismos distintos: `IF NOT EXISTS` nas tabelas/colunas/índices e
`ON CONFLICT DO NOTHING` no seed dos tipos; nas **funções**, pelo par
`DROP FUNCTION IF EXISTS` + `CREATE` (quem muda tipo de retorno) ou por
`CREATE OR REPLACE` (quem não muda).

⚠️ **O `migrate.sh` PULA arquivo já registrado em `"SchemaMigration"`.** Em produção
isso não atrapalha (a 0117 é nova), mas a seção 8 redefine funções que **já
existem** — então um "aplicou" sem efeito é possível (registro presente, corpo
antigo). **Por isso a prova é o CORPO da função, nunca o exit code** (abaixo).

**O que ela faz** (nada destrutivo, nada de `UPDATE`):

- cria `LancamentoExternoTipo` (2 linhas), `LancamentoExterno` e
  `LancamentoExternoExclusao` (o rastro de quem excluiu; **ninguém do produto a lê**, e
  por isso ela tem `REVOKE ALL` para `authenticated` — guarda CNPJ)
- cria 2 índices e **sete** funções do lançamento externo:
  `hub_apuracao_semana_de`, `hub_lancamento_externo_aplicar`,
  `hub_lancamento_externo_resumo`, `hub_lancamento_externo_liquido`,
  `hub_lancamento_externo_semana_fechada`, `hub_lancamento_externo_listar` e
  `hub_lancamento_externo_excluir`
- ⚠️ `aplicar`, `resumo` e `listar` **mudaram de tipo de retorno** nas rodadas 4/5 (o
  `resumo` ganhou `qtd_negativo`/`total_negativo`; o `listar`, `semana_fechada`), então
  vêm com **`DROP FUNCTION IF EXISTS` + `CREATE`**, não `CREATE OR REPLACE` — o Postgres
  recusa trocar o tipo de retorno por `REPLACE`. Na **primeira** aplicação (produção) o
  `DROP` é no-op; o que ele resolve é a **reaplicação**, e foi exatamente o que faltou no
  `hub_homolog` (R4-M14), onde o registro na `SchemaMigration` existia com o corpo antigo
- `ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN lancamentos_externos numeric(12,2) NOT NULL DEFAULT 0`
- **seção 8 — redefine as CINCO funções VIVAS do repasse** (§0.1: é ela que liga o caminho):
  `hub_adiantamento_repasse_fechar` (corpo anterior `0098:111`) segue por `CREATE OR REPLACE`
  — o tipo de retorno não muda; passa a gravar `lancamentos_externos` no item congelado.
  As outras **QUATRO ganham a coluna `lancamentos_externos`** (a parcela "pago por fora" que faz a
  decomposição somar) e por isso são **`DROP FUNCTION` + `CREATE` + `REVOKE ALL FROM PUBLIC` +
  `GRANT EXECUTE TO authenticated`**: a **prévia** `hub_adiantamento_repasse` (`0100:26`), o
  **congelado** `hub_adiantamento_repasse_congelado` (`0100:172`, semana fechada no hub), o
  **app corrente** `hub_adiantamento_repasse_motorista` (`0098:515`) e o **app último fechado**
  `hub_adiantamento_repasse_motorista_ultimo_fechado` (`0098:639`, semana fechada no app).
  🔴 **Há uma janela entre o `DROP` e o `GRANT`** — a migration roda numa transação (`migrate.sh` /
  `psql -1`), logo ela não é observável por outras sessões; **nunca** aplique esta seção
  por partes, fora de transação.
  Nenhuma outra função depende destas **por tipo**. ⚠️ Mas `hub_repasse_lote_avaliar` **não é alheia à 0117**: lê o snapshot
  `ApuracaoRepasseItem` (não estas funções) **e desde a §9 da migration (H1) enxerga `creditos`, `lancamentos_externos` e
  `valor_pago` dele para decidir `NOTA_PENDENTE`** — é a **SEXTA** função tocada (`CREATE OR REPLACE`, sem `DROP`, ACL só do
  dono). O texto anterior ("`hub_repasse_lote_*` leem o snapshot") era de ANTES da §9 e escondia isto; a conferência **F**
  abaixo a prova pelo corpo.
  O `DROP` exige **`SIGUSR1` no PostgREST** depois (assinatura de retorno mudou).

**Conferir depois de aplicar — PROVA PELO CORPO DA FUNÇÃO** (`pg_get_functiondef`):

```sql
-- A) as TRÊS funções de cálculo AGORA leem LancamentoExterno e têm o termo no cálculo.
--    Esperado: t | t | t | t | t.  Qualquer f = a seção 8 NÃO está ativa -> PARE (§0.1).
SELECT pg_get_functiondef('hub_adiantamento_repasse(date,text,boolean,integer,integer)'::regprocedure) ~ 'LancamentoExterno'      AS previa_le_externo,
       pg_get_functiondef('hub_adiantamento_repasse_fechar(date)'::regprocedure)                         ~ 'LancamentoExterno'      AS fechar_le_externo,
       pg_get_functiondef('hub_adiantamento_repasse_motorista()'::regprocedure)                          ~ 'LancamentoExterno'      AS app_le_externo,
       pg_get_functiondef('hub_adiantamento_repasse_fechar(date)'::regprocedure)                         ~ 'lancamentos_externos'   AS fechar_grava_rastro,
       pg_get_functiondef('hub_lancamento_externo_resumo(date)'::regprocedure)                           ~ 'pagamentos_consultar'   AS resumo_gate_consultar;
-- B) o gate do resumo NÃO é o de escrita (FR-049: quem VÊ a prévia vê o aviso)
SELECT pg_get_functiondef('hub_lancamento_externo_resumo(date)'::regprocedure) !~ 'pagamento_confirmar' AS resumo_sem_gate_de_escrita;  -- t
-- C) md5 diferente do anotado no pré-flight (f)
SELECT md5(pg_get_functiondef('hub_adiantamento_repasse_fechar(date)'::regprocedure));
-- D) as QUATRO funções que mudaram de tipo devolvem a coluna nova (4) e NENHUMA ficou aberta a PUBLIC (0)
SELECT count(*) FILTER (WHERE 'lancamentos_externos' = ANY (p.proargnames)) AS com_coluna,
       (SELECT count(*) FROM pg_proc q, aclexplode(COALESCE(q.proacl, acldefault('f', q.proowner))) a
         WHERE q.proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_motorista','hub_adiantamento_repasse_congelado','hub_adiantamento_repasse_motorista_ultimo_fechado')
           AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS abertas_a_public
FROM pg_proc p WHERE p.proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_motorista','hub_adiantamento_repasse_congelado','hub_adiantamento_repasse_motorista_ultimo_fechado');   -- 4 | 0
```

```sql
-- F) 🔴 MEDIUM 4 (rodada 3) — a SEXTA função e as novas da rodada 3, PROVADAS PELO CORPO (as conferências A–E só sondavam 6 funções
--    e NÃO a §9: sem esta, o crédito externo puro voltaria a travar em NOTA_PENDENTE sem ninguém ver).
--    Esperado: t | t | t | t | t | t | t.
SELECT pg_get_functiondef('hub_repasse_lote_avaliar(bigint[],integer[])'::regprocedure) ~ 'b\.lancamentos_externos > 0'                        AS avaliar_excecao_credito,
       pg_get_functiondef('hub_repasse_lote_avaliar(bigint[],integer[])'::regprocedure) ~ 'b\.valor_pago <= b\.lancamentos_externos'          AS avaliar_limite_do_credito,  -- ALTO 1: sem isto R$ 0,01 destrava saldo sem nota
       pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure)                  ~ 'VALOR_EXCEDE_LIQUIDO'                AS aplicar_recusa_excedente,   -- ALTO 2
       to_regprocedure('hub_lancamento_externo_liquido(integer,date,"AdiantamentoConfiguracao")') IS NOT NULL                                  AS liquido_existe,
       pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure)                      ~ 'SEMANA_JA_FECHADA'                   AS excluir_guarda_semana_fechada,
       pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure)                      ~ 'LancamentoExternoExclusao'           AS excluir_grava_rastro,
       to_regprocedure('hub_lancamento_externo_listar(date,text,integer,integer)') IS NOT NULL                                                  AS listar_existe;
-- G) a ACL das novas: só `authenticated` executa as TRÊS públicas; as DUAS internas (semana_fechada, liquido) NÃO são do PostgREST.
SELECT p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_executa,
       (SELECT count(*) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS aberta_a_public
FROM pg_proc p WHERE p.proname IN ('hub_lancamento_externo_aplicar','hub_lancamento_externo_excluir','hub_lancamento_externo_listar',
                                    'hub_lancamento_externo_semana_fechada','hub_lancamento_externo_liquido') ORDER BY 1;
--    esperado: aplicar t/0, excluir t/0, listar t/0, semana_fechada f/0, liquido f/0.
```

```bash
# E) 🔴 P25 — a ACL das CINCO, comparada COM A QUE VOCÊ GUARDOU no pré-flight (f). O rollback já comparava corpo E ACL;
#    o caminho de ida só olhava "não ficou aberta a PUBLIC" (D) — um GRANT perdido no DROP+CREATE passaria. Esperado: 5 linhas "OK".
for par in "fechar:hub_adiantamento_repasse_fechar(date)" \
           "previa:hub_adiantamento_repasse(date,text,boolean,integer,integer)" \
           "app:hub_adiantamento_repasse_motorista()" \
           "congelado:hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer)" \
           "ultimo:hub_adiantamento_repasse_motorista_ultimo_fechado()"; do
  n="${par%%:*}"; f="${par#*:}"
  ACL_AGORA=$($PG "SELECT COALESCE(proacl::text,'<nulo>') FROM pg_proc WHERE oid='$f'::regprocedure")
  ACL_ANTES=$(cut -d' ' -f2- ~/le-pre0117-$n.md5acl)
  [ "$ACL_AGORA" = "$ACL_ANTES" ] && echo "OK  $n" || echo "DIVERGE $n: antes=$ACL_ANTES agora=$ACL_AGORA"
done
```

⚠️ **W1 (rodada 1 do code review) — mudança DELIBERADA em código que não é desta feature.** A **prévia**
(`hub_adiantamento_repasse`, `0100:26`) deduzia só adiantamento `PAGA`; o **fechamento** (`0098:111`) e o **app**
(`0117`, seção 8.3) deduzem `PAGA` **+ `EXPORTADA`**. Para quem tinha adiantamento exportado e ainda não pago, a prévia
mostrava remanescente **maior** que o fechamento congelava — e você confere a prévia antes de fechar. Agora a prévia
deduz as duas (e mantém `em_processamento` como informação). **Consequência visível**: valores da prévia de
motorista com adiantamento `EXPORTADA` **diminuem** em relação à prévia anterior; o fechamento e o app não mudam.
Provado em `hub-lancamento-externo-integration.sh` (`W1:` e `C18b` com uma `EXPORTADA` na fixture).

```sql
-- 1) objetos no lugar
SELECT count(*) FROM pg_tables  WHERE tablename LIKE 'LancamentoExterno%';           -- 3 (LancamentoExterno, ...Tipo, ...Exclusao)
SELECT count(*) FROM pg_indexes WHERE tablename = 'LancamentoExterno';               -- 4
SELECT codigo, sinal FROM "LancamentoExternoTipo" ORDER BY sinal;                    -- ADIANTAMENTO -1 / AJUSTE_CREDITO 1

-- 2) a coluna nova nasceu neutra
SELECT count(*) FILTER (WHERE lancamentos_externos <> 0) FROM "ApuracaoRepasseItem"; -- 0

-- 3) a semana está sendo derivada como esperado (PROVA, não suposição)
SELECT d::date, to_char(d,'Dy'), hub_apuracao_semana_de(d::date, 1::smallint)
FROM generate_series(DATE '2026-10-19', DATE '2026-10-26', INTERVAL '1 day') d;
--    19..25/10 -> 2026-10-19   |   26/10 -> 2026-10-26
```

⚠️ **Função nova exige `SIGUSR1` no PostgREST** para ele recarregar o schema
cache, **senão a rota responde 404 calado**. São **dois** PostgREST no host — o
de produção é `pgadmin_postgrest`:

```bash
docker kill -s SIGUSR1 pgadmin_postgrest.1.<hash>
```

### 2.R · 🔴 Rollback — como voltar as **cinco** funções ao corpo **e à ACL** anteriores

> Este é o item mais sensível do runbook. **Dropar a tabela nova NÃO desfaz a
> 0117**: as funções vivas continuam com o corpo novo (e, sem a tabela, a
> prévia e o fechamento **quebrariam**). O DDL novo (tabelas, colunas, funções
> novas) é aditivo e inerte; o que precisa voltar é o **corpo das cinco funções**.
>
> 🔴 **Mudou de natureza (parcela visível, 2026-10-23).** Antes o rollback era reaplicar o
> corpo salvo por `CREATE OR REPLACE`. Agora **quatro** das cinco funções mudaram o *tipo de
> retorno*: o Postgres **recusa** `CREATE OR REPLACE` com tipo diferente
> (`cannot change return type of existing function` — provado pelo controle
> `RB_NEG=sem-drop`), então é **`DROP` + `CREATE` + `REVOKE ALL FROM PUBLIC` + `GRANT`**. E
> o `DROP` **apaga os `GRANT`** (`0098:30`): esquecer o `GRANT` deixa o repasse inteiro em 403
> (provado por `RB_NEG=sem-grant`); esquecer o `REVOKE` deixa a função aberta ao PostgREST público.

**Procedimento** (usa os arquivos guardados no pré-flight (f); **numa só transação**):

```bash
# 1) tudo numa transação: DROP das 4 que mudam de tipo -> corpo salvo de TODAS as 6 -> ACL
{ echo 'BEGIN;'
  echo 'DROP FUNCTION hub_adiantamento_repasse(date,text,boolean,integer,integer);'
  echo 'DROP FUNCTION hub_adiantamento_repasse_motorista();'
  echo 'DROP FUNCTION hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer);'
  echo 'DROP FUNCTION hub_adiantamento_repasse_motorista_ultimo_fechado();'
  cat ~/le-pre0117-fechar.sql ~/le-pre0117-previa.sql ~/le-pre0117-app.sql \
      ~/le-pre0117-congelado.sql ~/le-pre0117-ultimo.sql \
      ~/le-pre0117-aval.sql        # a 6ª (lote): CREATE OR REPLACE, sem DROP e SEM GRANT (ACL só do dono; o REVOKE abaixo é inócuo)
  for f in 'hub_adiantamento_repasse_fechar(date)' \
           'hub_adiantamento_repasse(date,text,boolean,integer,integer)' \
           'hub_adiantamento_repasse_motorista()' \
           'hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer)' \
           'hub_adiantamento_repasse_motorista_ultimo_fechado()'; do
    echo "REVOKE ALL ON FUNCTION $f FROM PUBLIC;"
    echo "GRANT EXECUTE ON FUNCTION $f TO authenticated;"
  done
  echo 'REVOKE ALL ON FUNCTION hub_repasse_lote_avaliar(bigint[],integer[]) FROM PUBLIC;'   # NÃO dar GRANT: interna
  # MEDIUM 9 (rodada 3): as funções ESCRITORAS caem junto. Sem isto, rollback do SQL sem rollback da imagem deixava
  # `aplicar` com GRANT: o financeiro importava, via "N aplicadas" e NADA deduzia (o repasse já não lê a tabela). Sem a função,
  # a rota responde erro de servidor — barulhento — em vez de sucesso mentiroso. Os dados ficam na tabela.
  echo 'DROP FUNCTION IF EXISTS hub_lancamento_externo_aplicar(text,jsonb);'
  echo 'DROP FUNCTION IF EXISTS hub_lancamento_externo_excluir(bigint);'
  echo 'COMMIT;'
} | docker exec -i <pgadmin_db> psql -v ON_ERROR_STOP=1 -U chatmasterveloz -d chatmasterveloz
docker kill -s SIGUSR1 pgadmin_postgrest.1.<hash>     # recarrega o schema cache
```

⚠️ Os arquivos salvos terminam com `;` (o passo (f) o acrescenta). `ON_ERROR_STOP=1` + `BEGIN/COMMIT`
fazem tudo ou nada: se qualquer `CREATE` falhar, **nada** é aplicado e as funções novas seguem no ar.

**Prova do rollback** — o md5 **e a ACL** têm de ser **idênticos** aos anotados em (f), e nenhuma
função pode citar a tabela nova nem devolver a coluna:

```sql
SELECT p.oid::regprocedure, md5(pg_get_functiondef(p.oid)), COALESCE(p.proacl::text,'<nulo>')   -- = o de (f), as 5 linhas
FROM pg_proc p WHERE p.proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_fechar','hub_adiantamento_repasse_motorista',
                                    'hub_adiantamento_repasse_congelado','hub_adiantamento_repasse_motorista_ultimo_fechado');
SELECT count(*) FROM pg_proc WHERE proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_fechar','hub_adiantamento_repasse_motorista','hub_adiantamento_repasse_congelado','hub_adiantamento_repasse_motorista_ultimo_fechado') AND prosrc ~ 'LancamentoExterno';  -- 0
SELECT count(*) FROM pg_proc p WHERE p.proname LIKE 'hub_adiantamento_repasse%' AND 'lancamentos_externos' = ANY (p.proargnames);   -- 0
```

Prova: `to_regprocedure('hub_lancamento_externo_aplicar(text,jsonb)')` e `to_regprocedure('hub_lancamento_externo_excluir(bigint)')` voltam **NULL**.

**O procedimento foi provado** em stack efêmero por
`infra/hub/testes/hub-lancamento-externo-rollback.sh` (migra até 0116, guarda corpo + ACL das
**cinco**, aplica 0117, faz DROP + reaplica + REVOKE/GRANT): md5 **e ACL** idênticos, `EXECUTE` de
`authenticated` preservado, **nenhum `EXECUTE` para PUBLIC**, nenhuma menção a `LancamentoExterno`,
nenhuma coluna `lancamentos_externos` restante. Controles negativos: `RB_NEG=sem-drop` (4 reaplicações recusadas) e
`RB_NEG=sem-grant` (ACL e EXECUTE divergem) — o script REPROVA nos dois.

**Efeito no código**: o backend novo lê `lancamentos_externos` das RPCs. Com as funções revertidas a coluna
some e o DTO devolve `null` nesse campo (o código novo não quebra; a tela mostra "—"). Reverter o banco **sem**
reverter a imagem é seguro; o inverso (imagem antiga + banco novo) também, pois a coluna é aditiva.

**Efeitos que você precisa saber antes de decidir reverter**:

- Os **lançamentos já importados ficam na tabela** e passam a ser **ignorados** pelo
  repasse (a feature volta ao estado "escrita, caminho não ligado" — **não** importe
  mais nada enquanto estiver revertido).
- **Semanas já fechadas não mudam**: o retrato é imutável; o `lancamentos_externos`
  gravado nelas permanece.
- Reverter **só a imagem do código** (passo 3) **não** reverte o banco: as funções
  novas seguem ativas e o código antigo convive com elas (aditivo, default neutro).

---

## 3 · Deploy do código

Precedido do rito de produção (5 gates) e do rito do ciclo git: **merge na `main`
antes do build**, tag `<rótulo>-<sha7>`, `df -h /` e swap conferidos.

```bash
# backend — SEMPRE Dockerfile.hub (o Dockerfile antigo derruba o runtime de 20 para 14)
DOCKER_BUILDKIT=0 docker build --memory=2g -f Dockerfile.hub \
  -t registry.todo-tips.com/envio-massa-backend:<rótulo>-<sha7> .
docker run --rm registry.todo-tips.com/envio-massa-backend:<rótulo>-<sha7> node --version   # v20.x

docker service update --with-registry-auth \
  --image registry.todo-tips.com/envio-massa-backend:<rótulo>-<sha7> \
  envio-massa-homologacao_backend_homologacao
# idem frontend_v2 (envio-massa-homologacao_frontend_v2_homologacao)

# idem app motorista — TERCEIRO serviço. A FR-053 exige a parcela nas cinco superfícies
# e duas delas (semana em curso e última fechada) vivem em frontend_motorista:
#   serviço: envio-massa-homologacao_frontend_motorista_homologacao
#   imagem : registry.todo-tips.com/app-motorista-frontend:<rótulo>-<sha7>
#   build  : em app_homologacao/frontend_motorista (Dockerfile próprio, Next standalone)
#   anote ANTES a imagem no ar (hoje `ajuda-3-entregas-f3ffeba`): é o rollback dele.
docker service update --with-registry-auth \
  --image registry.todo-tips.com/app-motorista-frontend:<rótulo>-<sha7> \
  envio-massa-homologacao_frontend_motorista_homologacao
```

Sem o terceiro serviço, o hub mostra a parcela e o app do motorista **não**: o financeiro
vê `100 − 0 − 0 − 30 = 70` e o motorista vê `100 − 0 − 0 = 100`.

**Nunca** `docker stack deploy`.

**Rollback do código**: a imagem anotada no pré-flight (b) é o retorno —
`docker service update --with-registry-auth --image <anterior> <serviço>`.
Não revive o banco (ver §2.R).

**Prova de bundle** (HTTP 200 prova que subiu, não que subiu o código certo):
buscar no artefato servido uma string que só existe nesta entrega — p.ex. o
rótulo do botão **"Importar pagos por fora"**. No **app motorista**, a string ASCII
**`Pago por fora`** (a linha da decomposição do repasse; ⚠️ **acento não casa** no
`docker exec` — por isso a string é ASCII), buscada nos chunks servidos, p.ex.:

```bash
TID=$(docker ps -q --filter name=envio-massa-homologacao_frontend_motorista_homologacao | head -1)
docker exec "$TID" sh -c 'grep -rl "Pago por fora" /app/.next/static /app/.next/server 2>/dev/null | head -3'
# CONTROLE NEGATIVO (obrigatório): a mesma busca contra a imagem ANTERIOR tem de dar VAZIO.
# Sem ele, um grep que casa em qualquer coisa "prova" um deploy que não houve.
docker run --rm --entrypoint sh registry.todo-tips.com/app-motorista-frontend:ajuda-3-entregas-f3ffeba \
  -c 'grep -rl "Pago por fora" /app/.next/static /app/.next/server 2>/dev/null | wc -l'   # esperado: 0
```

No backend, interrogar o processo
vivo (`docker service logs` agrega tarefas **antigas** e engana).

---

## 4 · 🔴 IMPORTAR e **CONFERIR A PRÉVIA** — antes de fechar

> A prévia (`hub_adiantamento_repasse`, `0100`) é **ao vivo** e **não congela
> nada**. É a **única** chance de ver o efeito antes de ele virar imutável.
> Depois do passo 5 não há desfazer.

### 4.1 Importar

Aba **Repasse** → botão **"Importar pagos por fora"** (fica **antes** de "Fechar
apuração", de propósito) → escolher o **tipo** → selecionar o XLSX.

Planilha: 5 colunas, nesta ordem —
`CNPJ · Data do pagamento · Valor · Nome · Observação`.
`Nome` é só para você conferir: o sistema casa pelo **CNPJ**. Maiúsculas, acento (`Observacao`) e uma célula vazia
sobrando à direita no cabeçalho **não** derrubam o arquivo (MEDIUM 3); coluna a mais **com texto**, a menos ou fora de ordem, sim.
Planilha com poucas linhas mas "área usada" inflada (o Excel deixa isso depois de apagar linhas) **é lida** (MEDIUM 2).

> 🔴 **Importe o FATURAMENTO da semana ANTES dos pagos por fora (ALTO 2, FR-055).** Uma linha de `ADIANTAMENTO` maior que o
> **líquido disponível** do motorista na semana (créditos − adiantamentos − débitos − o que já foi lançado) é **RECUSADA** com
> `VALOR_EXCEDE_LIQUIDO`, e o diálogo mostra **"Linha N: R$ X excede o líquido disponível de R$ Y"**. Sem crédito
> importado o líquido é zero e **toda** dedução é recusada. A conferência vale **no momento do import** e **na ordem do
> arquivo**: duas deduções do mesmo motorista na mesma semana disputam o mesmo saldo (a 2ª vê o líquido já reduzido pela 1ª);
> um `AJUSTE_CREDITO` importado antes eleva o líquido. Linha recusada não grava nada: corrija o valor (ou importe o faturamento) e reenvie.

### 4.2 Anotar o resultado do import

O diálogo devolve: **aplicadas**, **recusadas** e a **contagem por motivo**.
Anote os três. Por decisão de segurança a resposta **não** traz CNPJ nem nome —
é só contagem.

### 4.3 Os números a conferir na prévia

> A prévia e o fechamento usam **a mesma fórmula** (seção 8 da 0117): o que a
> prévia mostra é o que será congelado — `remanescente = créditos − adiantamentos do
> app − débitos − lançamentos externos (dedução) + lançamentos externos (crédito)`.
> O driver de integração prova **zero centavo de diferença** entre as duas (cenário
> `C2`). Se você achar diferença, é defeito: **pare**.

| # | O que conferir | Como |
|---|---|---|
| 1 | **A soma bate** | Σ dos valores **aplicados** (exclui as recusadas, em especial `VALOR_EXCEDE_LIQUIDO`) que você importou como `ADIANTAMENTO` deve ser **exatamente** a queda do **total a pagar** da semana, comparado ao que a prévia mostrava antes do import. Diferença de **zero centavo** |
| 2 | **Quantidade** | `aplicadas` no diálogo = nº de linhas da planilha menos as recusadas. Se "aplicadas" for menor do que você esperava, a diferença está na **contagem por motivo** — não no cálculo |
| 3 | **Quem caiu em retenção** | motorista cujo valor a pagar virou **0** com saldo transportado: a dedução o levou abaixo de **R$ 5,50**. É o comportamento correto (o valor **não** se perde, vai para a semana seguinte), mas você precisa **saber** que aconteceu |
| 4 | **Nenhum negativo causado pelo import** | desde a rodada 3 uma dedução que excederia o líquido é **recusada** (`VALOR_EXCEDE_LIQUIDO`), então **este import não cria remanescente negativo NO INSTANTE em que roda**. ⚠️ Rodada 4: a guarda vale só naquele instante — um **débito de faturamento que chega depois** (o robô importa 11h/13h/14h) ou a **flag ligada depois** podem torná-lo negativo; por isso o diálogo de fechar mostra **quantos motoristas e quantos R$** e exige confirmação (H9), e o aviso vermelho aparece **mesmo com a flag ligada**. ⚠️ Rodada 5: o número do diálogo conta o negativo **por qualquer causa** — inclusive o que já existia antes (débito ou adiantamento do app maior que o crédito, sem nenhum lançamento por fora); a confirmação vale para ele também. A tela não distingue a origem. ⚠️ A conferência 1 e esta **não se contradizem mais**: a diferença de zero centavo vale para as linhas **aplicadas**; as recusadas por excedente **não** entram na soma e vêm nomeadas no diálogo |
| 5 | **A semana certa** | lançamento com data de **26/10 ou depois** **não** deve aparecer nesta semana. Se aparecer, a derivação da semana está errada — **pare** |
| 6 | **Aviso de flag** | se aparecer o aviso "valores pagos por fora que **não** serão descontados", a flag `desconto_adiantamentos` está **desligada** e a empresa vai **pagar duas vezes**. Decida antes de fechar |

### 4.4 Sinais de problema — **pare e devolva ao agente**

- **o import respondeu "aplicadas" mas NENHUM número da prévia mudou** — é o defeito
  de §0.1 (*caminho não ligado*): a seção 8 da 0117 não está ativa. Volte ao passo 2
  e refaça a prova pelo corpo
- o **app do motorista** mostra um remanescente diferente do que a prévia calcula para o
  mesmo motorista/semana (a 3ª função, §0.1) — confira UM motorista com lançamento no app
- a queda do total **não** é igual à soma importada (qualquer centavo de diferença)
- o total a pagar **subiu** depois de importar `ADIANTAMENTO`
- um motorista que você **não** lançou mudou de valor
- `aplicadas` + `recusadas` ≠ nº de linhas da planilha
- a contagem por motivo traz motivo que você não reconhece
- lançamento de outra semana aparecendo nesta
- **100% das linhas de `ADIANTAMENTO` voltaram `VALOR_EXCEDE_LIQUIDO`** (rodada 4, M7) — quase certamente o **faturamento da semana ainda não foi importado** (líquido 0). Importe o faturamento e reenvie; nada foi gravado
- o diálogo de fechar mostra **remanescente NEGATIVO** (rodada 4, A2): não feche no automático — confira o motorista (débito tardio? flag ligada depois?); se for o caso, exclua o lançamento em "Ver pagos por fora" antes

### 4.4b Ver e EXCLUIR um lançamento (autorizado pelo operador em 2026-10-23)

Aba Repasse → **"Ver pagos por fora"**: lista os lançamentos da semana (motorista, tipo, data, valor, observação, quem lançou).
Errou o valor, ou pagou duas vezes no mesmo dia? **Excluir** na linha (pede confirmação). A prévia e o aviso recalculam na hora, e
**reenviar a mesma linha com o valor certo volta a funcionar** (a chave de idempotência é liberada).
⚠️ Rodada 4 (A1): **excluir um CRÉDITO que sustenta uma dedução é recusado** (`EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO`) — deixaria o motorista
negativo e o excedente evaporaria no fechamento. **Apague a dedução primeiro, depois o crédito.** Excluir dedução nunca é recusado por isto.
Rodada 5: a recusa só vale quando existe dedução **lançada por fora** do mesmo motorista e semana (a que você consegue apagar); dedução do app ou débito de faturamento não travam o crédito (H11).

- 🔴 **Semana já FECHADA não permite excluir** ("Semana fechada" no lugar do botão; o servidor recusa com 409 de qualquer forma): o
  valor está congelado e apagar a origem divergiria o congelado da tabela. Não há como desfazer depois do fechamento.
- Cada exclusão deixa rastro em `"LancamentoExternoExclusao"` (quem, quando, o que e o valor que havia), na mesma transação:

```sql
SELECT excluido_em, excluido_por, lancamento_id, tipo, valor, data_pagamento FROM "LancamentoExternoExclusao" ORDER BY id DESC LIMIT 20;
```

### 4.5 Reenvio é seguro

Faltou uma linha? Corrija a planilha e suba o **arquivo inteiro** de novo: as já
aplicadas voltam como `JA_APLICADO` e **nenhum valor muda**. O que o sistema
recusa é a mesma chave com **valor diferente** (`VALOR_DIVERGENTE`) — ele nunca
sobrescreve um lançamento. Para corrigir um valor já aplicado (semana **aberta**), use **"Ver pagos por fora" → Excluir** (4.4b)
e reenvie com o valor certo. Semana fechada: não há correção por tela — devolva ao agente.

> **Reenvio depois do fechamento (H5, rodada 2)**: linha que **foi** aplicada volta `JA_APLICADO` mesmo com a
> semana já fechada (a idempotência vem **antes** da janela). `SEMANA_JA_FECHADA` significa, sem ambiguidade,
> "esta linha **nunca** foi aplicada". Se você receber `SEMANA_JA_FECHADA` para linhas que acha que subiu,
> **não** relance na semana seguinte: confira antes (o motorista seria deduzido duas vezes).

> **Um lançamento por motorista, por dia, por tipo (H4)**: se houve **dois pagamentos** ao mesmo motorista no
> mesmo dia, **some-os numa única linha ANTES de enviar**. O 2º, enviado à parte, volta `VALOR_DIVERGENTE`
> (ou `DUPLICADA_NO_ARQUIVO`, se estava no mesmo arquivo) e **não é deduzido: o repasse paga esse valor de novo**.
> Somar e reenviar depois NÃO altera o lançamento já aplicado: com a semana **aberta**, exclua os dois em 4.4b e reenvie a soma; com a
> semana fechada, devolva ao agente.

---

## 5 · Fechar a apuração

Só depois do passo 4 inteiro. Aba Repasse → **"Fechar apuração"**.

O diálogo de confirmação repete o aviso de flag, se houver. **Fechar é
irreversível**: `ApuracaoRepasse` é imutável por desenho (`REVOKE UPDATE,
DELETE` + trigger, `0066:443-470`).

Esperado: a apuração de **2026-10-19** é criada, com `data_repasse` = **2026-10-28**.

---

## 6 · Pós-fechamento

```sql
-- o congelado explica a si mesmo: a diferença entre remanescente e as 3 parcelas
-- é exatamente a coluna nova
SELECT count(*) AS itens,
       sum(valor_pago) AS a_pagar,
       sum(valor_transportado) AS transportado,
       sum(lancamentos_externos) AS externos
FROM "ApuracaoRepasseItem" i
JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
WHERE a.periodo_inicio = DATE '2026-10-19';
```

**Esperado**: `externos` = **−(soma importada como ADIANTAMENTO)** + (soma de
`AJUSTE_CREDITO`), batendo com o que você anotou em 4.2. Se não bater, registre e
devolva ao agente — o retrato já está congelado e a correção é de processo, não
de `UPDATE`.

Depois: seguir o ciclo normal do repasse (gerar notas, lote de pagamento).
Lembrete do ciclo: **"Gerar notas da semana" é o 2º passo e PEDE a nota**, não é
o que paga; e `confirmar` exige lote **EXPORTADO**, que só acontece no 1º
download — **baixe antes de confirmar**.

---

## Apêndice A — evidência da entrega (números do agente, ambiente isolado)

> Valores **ATUAIS** após a **rodada 3** do `bmad-code-review` (2026-10-23, onda-012). **Superados** (não usar): rodada 2 — 2088/1379/964,
> integração 72/83, rollback 35, E2E 14; rodada 1 — 2083/1374/955, integração 70/74, rollback 31; ondas 006/007 — 2071/948/26.
> A reconciliação fica em `docs/specs/lancamento-externo/evidencias-baseline.md`. (MEDIUM 5: este quadro dizia "ATUAIS" com números
> da rodada 1 — 74 PASS contra 83 reais — e passou a ser reescrito a cada rodada.)

| Gate | Resultado |
|---|---|
| Backend `npm test` | **2104 pass / 0 fail**; `test:hub:unit` **1394/0** |
| Frontend `tsc --noEmit` (hub e app motorista) | limpo / limpo |
| `vitest` frontend_v2 · app motorista (`npm test`) · lint frontend_v2 | **970/0** · **126/0** · **28 (5 erros, 23 avisos) = baseline** |
| `hub-adiantamentos-integration.sh` | **231 PASS / 0 FAIL** |
| `hub-lancamento-externo-integration.sh` | **120 PASS / 0 FAIL** (inclui ALTO 2 — recusa por líquido, ordem, paridade —, listagem e exclusão, C11 com exclusão concorrente) |
| `hub-repasse-lote-integration.sh` | **86 PASS / 0 FAIL** (+3 do ALTO 1, com a fixture de `saldo_anterior`) |
| `hub-repasse-saldo-minimo-roundtrip-integration.sh` | **57 PASS / 0 FAIL** |
| `hub-lancamento-externo-perf.sh` | **APROVADO** (zero Seq Scan; ISO 1,017 ms/31 buf; TRÊS 3,68 ms/96 buf; **líquido 0,135 ms/chamada ⇒ ~1,4 s para 10.000 linhas**; o tempo varia com a carga do host) |
| `hub-lancamento-externo-rollback.sh` | **OK, 37 PASS** (+2: `aplicar`/`excluir` caem no rollback); `RB_NEG=escritor-vivo` reprova |
| E2E do hub (`hub-adiantamentos-e2e-browser.sh`) | **14 passed + 1 flaky** de 15 (15 = 14 + o teste novo de listagem/exclusão). O flaky é `US5 reprocessar uma solicitação falhada` (`getByText('Liberada')` contra o rótulo "Adiantamento liberado"): **não é desta feature**, passa na repetição |
| `package-lock.json` | sem diff |

**Controles negativos da rodada 3** (cada um reprova SÓ o que deve; reversão conferida no arquivo antes de medir):
`LE_NEG=excesso` 104/16 (o excedente SOME: prévia −70,00) · `excluir-fechada` 111/9 (congelado e tabela divergem) · `liquido-sem-exportada` 119/1 (paridade) ·
`excluir-sem-rastro` 118/2 · lote: corpo da rodada 2 ⇒ `apta=true` 5,01 (o furo do ALTO 1) · MEDIUM 2/3/7: 2/1/1 testes · `PERF_NEG=noindex` reprova (inclusive o líquido: 1,5 ms/chamada).

## Apêndice B — o que este runbook deliberadamente NÃO cobre

| Fora | Por quê |
|---|---|
| Editar lançamento pela tela | continua fora: o caminho é **excluir + reenviar** (4.4b) |
| Excluir lançamento de semana fechada | **proibido por desenho** (FR-056): o valor está congelado |
| Reabrir semana fechada | a apuração é imutável por desenho |
| Lançar para empresa fora do grupo Movee | o fechamento é da empresa 6 |
