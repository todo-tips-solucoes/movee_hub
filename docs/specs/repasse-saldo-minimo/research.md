# Research: repasse-saldo-minimo

**Feature**: `repasse-saldo-minimo` | **Date**: 2026-09-26 | **Spec**: [spec.md](./spec.md)

Toda afirmação sobre código abaixo foi conferida por `grep`/leitura na data do plano
(árvore em `feat/repasse-saldo-minimo`, última migration aplicada no repo: `0096`).
Reconferir na hora de implementar — outra sessão pode ter redefinido algo depois.

## Corpo vigente das funções (ponto de partida obrigatório)

| Função | Vigente em | Retorno |
|---|---|---|
| `hub_adiantamento_repasse` | `0088_repasse_categoria_familia.sql:34` | `TABLE(entregador_id, nome, creditos, adiantamentos, debitos, remanescente, em_processamento, total, total_creditos, total_adiantamentos, total_debitos, total_remanescente)` |
| `hub_adiantamento_repasse_congelado` | `0086_repasse_us6_janela_e_congelado.sql:84` | mesmo shape de `hub_adiantamento_repasse` |
| `hub_adiantamento_repasse_fechar` | `0092_apuracao_divisao_nota_e_trilha.sql:67` | `TABLE(apuracao_id, motoristas, total, nao_pagos_no_periodo)` |
| `hub_adiantamento_repasse_motorista` | `0088_repasse_categoria_familia.sql:241` | `TABLE(visivel, periodo_inicio, periodo_fim, data_repasse, situacao, creditos, debitos, remanescente, negativo, adiantamentos jsonb)` |
| `hub_adiantamento_repasse_motorista_ultimo_fechado` | `0086_repasse_us6_janela_e_congelado.sql:139` | `TABLE(periodo_inicio, periodo_fim, data_repasse, fechado_em, creditos, adiantamentos, debitos, remanescente, negativo)` |
| `hub_adiantamento_configuracao_salvar` | `0091_hub_dono_telefone_e_moldes.sql:68` | `"AdiantamentoConfiguracao"` |
| `hub_adiantamento_tem_permissao` | `0067_adiantamento_funcoes.sql:401` (GRANT refeito em `0084:102`) | `boolean` |
| Políticas `usuarioentidade_insert_admin` / `_update_admin` | `0039_usuarioentidade_escrita_admin.sql:46/58` (nenhuma migration posterior as redefine) | — |

## Decision 1 — F1: uuid resolvido no Node, em lotes de 100, sem DDL

**Decision**: o backend busca `Entregador?id=in.(…)&select=id,id_externo` em lotes de no
máximo 100 ids e junta ao resultado da RPC, nas rotas `GET /repasse` e
`GET /repasse/exportar` (ao vivo e congelado). Helper único, reusado pelas duas rotas.

**Rationale**: F1 precisa ir a produção sozinha e sem migration; mudar o retorno da RPC
exigiria DROP+CREATE (rito integral de banco). `in.()` grande já estourou o header do
PostgREST (PR #50). Medido: 1.021 motoristas → CSV = 11 lotes; tela pagina 20 → 1 lote.

**Alternatives considered**: devolver `id_externo` pela RPC (exige DDL; entra naturalmente
na F3 se quisermos, mas F1 não pode depender dela); embed PostgREST (RPC não embeda).

## Decision 2 — F1: vocabulário = o da tela de Motoristas

**Decision**: rótulo **"Identificador"** na coluna da tela e no cabeçalho do CSV; campo
DTO `idExterno` (camelCase); valor renderizado com o componente já existente
`components/hub/copyable-uuid.tsx` (`CopyableUuid`).

**Rationale**: FR-003 exige o mesmo rótulo e o mesmo dado já usados na tela de Motoristas.
Lido: `app/hub/dashboard/motoristas/page.tsx:494` (`<TableHead>Identificador</TableHead>`),
`:479/:510` (`<CopyableUuid value={item.idExterno} …/>`). O briefing sugeria o cabeçalho
`UUID do motorista` e o campo `entregadorUuid` — a spec (clarificada depois) prevalece:
um segundo nome para o mesmo dado é exatamente o que FR-003 proíbe.

**Alternatives considered**: `UUID do motorista` (segundo vocabulário, rejeitado por
FR-003); `entregadorUuid` no DTO (idem).

## Decision 3 — F2: restringir por papel, não por permissão nova

**Decision**: reusar `adiantamentos.pagamento_confirmar`. Migration nova cria o papel
`financeiro_aprovador` (= permissões do `financeiro` + `pagamento_confirmar`) e retira
`pagamento_confirmar` de todo papel exceto `admin_plataforma` e `financeiro_aprovador`.

**Rationale**: as ações de FR-006 são exatamente todos os usos da permissão — rotas
`hub-adiantamentos.js:1209, :1298, :1580, :1654`; SQL `hub_adiantamento_lote_confirmar`
(`0083:63`) e `hub_adiantamento_repasse_fechar` (`0092:84`). As três camadas
(middleware, `resolverContextoAdiantamentos` `:290`, `hub_adiantamento_tem_permissao`)
já leem `PapelPermissao`: mudar o conjunto de papéis basta. Há um papel por pessoa por
empresa (`UNIQUE (usuario_id, empresa_id)`, `0003:50`) — por isso o papel novo carrega
tudo do `financeiro`.

**Dívida registrada**: o papel novo é cópia do `financeiro` na data da migration. Toda
migration futura que conceder permissão ao `financeiro` precisa conceder também ao
`financeiro_aprovador` — comentário na migration + nota no `CLAUDE.md`.

**Alternatives considered**: permissão nova `adiantamentos.aprovar` (mexeria nas três
camadas e em 4 rotas/2 telas sem ganho); segundo `admin_plataforma` (poder total, rejeitado
pelo operador em D10).

## Decision 4 — F2: a trava cobre TRÊS pontos de escrita de vínculo, não dois

**Decision**: a checagem "papel restrito só por `admin_plataforma`" roda em
`POST /usuarios` (`hub-usuarios.js:214`, cria usuário **e** o 1º vínculo com `papel_id`),
`POST /usuarios/:id/vinculos` (`:397`) e `PUT /usuarios/:id/vinculos/:vinculoId` (`:478`).
No banco, refazer `usuarioentidade_insert_admin` e `usuarioentidade_update_admin` (corpo
vigente: 0039) com a condição de papel não-restrito, avaliada na linha nova (`WITH CHECK`)
e na linha atual (`USING` do UPDATE). Papéis restritos resolvidos **por nome**
(`admin_plataforma`, `financeiro_aprovador`) num helper SQL `STABLE`.

**Rationale**: o briefing listava só `:397` e `:478`; `POST /usuarios` também grava
`papel_id` (lido: `:241-271`). Deixá-lo de fora reabre o furo pela criação de usuário.

**Observação de comportamento**: `USING` que reprova num UPDATE do PostgREST **não gera
erro** — a linha simplesmente não é afetada (resposta `[]`). O teste "direto no PostgREST"
precisa conferir que a linha **não mudou**, não esperar 403. `WITH CHECK` que reprova gera
`42501` (403 no PostgREST).

## Decision 5 — F2: fechar a escrita direta em `Papel`/`PapelPermissao`/`Permissao`/`Modulo`

**Decision**: `REVOKE INSERT, UPDATE ON "Papel", "PapelPermissao", "Permissao", "Modulo"
FROM authenticated` na mesma migration da F2. A única escrita legítima da matriz é a RPC
`hub_papel_permissao_set` (`0037`, `SECURITY DEFINER`, exclusiva de `admin_plataforma`).

**Rationale**: `0003:58` concede `SELECT, INSERT, UPDATE` nessas tabelas a
`authenticated`, e `0006` declara explicitamente que elas **não** têm RLS. Sob o mesmo
modelo de ameaça que a spec exige cobrir (FR-010: "acesso direto à camada de dados"), um
`admin_entidade` poderia inserir `PapelPermissao(financeiro, pagamento_confirmar)` e
anular a F2 inteira. Lido no backend: nenhuma rota escreve direto nessas tabelas (só
`GET` em `hub-papeis.js:78-80,140,144`, `hub-usuarios.js:241,414`, `hub-admin.js:85,117,169`).
Conferido de novo em 2026-09-26: nenhum `POST/PATCH` nessas tabelas em `routes/`, `lib/`,
`tests/`; a matriz é escrita só por `rpc/hub_papel_permissao_set` (`hub-papeis.js`);
seeds vivem em migrations (rodam como dono) e o único `INSERT INTO "Papel"` de teste
(`hub-adiantamentos-integration.sh:2035`) usa `psql_t` como `DB_USER`, fora do role
`authenticated`. Confirmar na implementação com `hub-papeis-integration.sh`/`hub-admin-*`
verdes. **Aprovado pelo operador (block-005).** Rollback devolve o `GRANT` de `0003:58`.

**Nota**: o token de sessão é assinado com `JWT_SECRET` (`routes/hub-auth.js:254`) e o do
PostgREST com `PGRST_JWT_SECRET` (`lib/hub-postgrest-jwt.js:123`); a exploração de S2 exige
o segundo. O operador confirma em produção que os dois valores diferem.

**Alternatives considered**: RLS com política `hub_jwt_admin_plataforma()` (mais código
para o mesmo efeito, e a escrita legítima já é por RPC definer).

## Decision 6 — F2: `PUT /usuarios/:id` também precisa respeitar o papel restrito

**Achado**: `PUT /usuarios/:id` (`hub-usuarios.js:325`) aceita `nome`, `ativo` e **`senha`**
para qualquer usuário com vínculo na entidade ativa do chamador (`:335-343`). Um
`admin_entidade` da empresa 6 pode, portanto, **trocar a senha** (ou desativar) do
`admin_plataforma` ou de um `financeiro_aprovador` — tomada de conta que anula a trava de
vínculo (FR-009) por outro caminho.

**Recomendação**: sem ser `admin_plataforma`, recusar `PUT /usuarios/:id` com
`403 PAPEL_RESTRITO` quando o alvo tem vínculo **ativo** com papel restrito (em qualquer
entidade), auditado como as demais negativas.

**Decision (operador, block-005)**: `PUT /usuarios/:id` só altera `senha`, `nome` ou
`ativo` de usuário cujo vínculo ativo tem papel restrito (`admin_plataforma` ou
`financeiro_aprovador`) quando o chamador é `admin_plataforma`; senão `403 PAPEL_RESTRITO`,
auditado na auditoria existente (`usuario_vinculo_negado`). Teste de controle negativo
(F2.0) prova o furo antes da correção.

## Decision 7 — F3: colunas novas em `ApuracaoRepasseItem` são NULÁVEIS (NULL = item pré-regra)

**Decision**: `saldo_anterior`, `saldo_anterior_nota`, `saldo_anterior_fora`,
`valor_pago`, `valor_transportado`, `transportado_nota`, `transportado_fora` — todas
`numeric(12,2)` **sem** `NOT NULL`. O fechamento novo sempre as preenche; itens fechados
antes da migration ficam `NULL`. `CHECK` do invariante escrito como
`valor_pago IS NULL OR (…)`.

**Rationale**: o briefing propunha `NOT NULL DEFAULT 0`, mas `valor_pago = 0` num item
antigo com `remanescente = 100` é falso (foi pago pelo CSV) e faria a geração de notas
pular esse item como "retido" — regressão de FR-022/SC-007. `NULL` diz a verdade ("a regra
não existia"). Medido em produção: 0 apurações fechadas — o caso legado só existe nos
ambientes de teste, mas o retrato antes/depois (§5 caso 8) precisa passar.

**Alternatives considered**: `DEFAULT 0` + `CHECK … NOT VALID` (evita falhar no ALTER mas
mantém o `valor_pago = 0` mentiroso); flag `regra_saldo boolean` (uma coluna a mais para a
mesma informação que o `NULL` já dá).

## Decision 8 — F3: regra de cálculo por item (fechamento e prévia)

```
saldo_anterior = COALESCE(item do mesmo entregador na apuração anterior .valor_transportado, 0)
total          = remanescente + saldo_anterior
se remanescente < 0:            valor_pago = 0; valor_transportado = saldo_anterior           (D2 + D9)
senão se 0 < total < piso:      valor_pago = 0; valor_transportado = total                     (FR-014)
senão:                          valor_pago = total; valor_transportado = 0                     (FR-015; total = 0 → ambos 0)
retido = (remanescente >= 0 AND 0 < total < piso)
```

Componentes da nota (D4): quando retido, `transportado_nota = COALESCE(valor_nota,0) +
saldo_anterior_nota` e idem `_fora`; quando pago, `transportado_* = 0` e a geração emite
`valor = valor_nota + saldo_anterior_nota`, `gorjeta = valor_fora_nota +
saldo_anterior_fora`; quando `remanescente < 0`, `transportado_* = saldo_anterior_*` e a
nota da própria semana segue como hoje (FR-018: "comportamento atual mantido" — hoje
`planejarGeracao` emite pela `valor_nota` independentemente do sinal do remanescente).

`CHECK` (linha com `valor_pago` não nulo): `valor_pago >= 0 AND valor_transportado >= 0 AND
(valor_pago = 0 OR valor_transportado = 0) AND (remanescente < 0 AND valor_pago = 0 AND
valor_transportado = saldo_anterior OR remanescente >= 0 AND remanescente + saldo_anterior
= valor_pago + valor_transportado)`.

**Ceiling conhecido**: se `categorias_nota` não estiver configurada numa semana retida,
`valor_nota` é NULL e entra como 0 no transporte da divisão da nota. Produção tem a
divisão configurada (F4 no ar); a geração já recusa `SEM_DIVISAO` nesse caso.

## Decision 9 — F3: ordem estrita de fechamento com trava de concorrência

**Decision**: no início de `hub_adiantamento_repasse_fechar`, após a checagem de permissão:
`pg_advisory_xact_lock` por empresa; se já existe apuração com `periodo_inicio =
p_periodo_inicio` → `APURACAO_JA_FECHADA` (semântica atual preservada); senão, se existe
alguma apuração da empresa e `p_periodo_inicio <> max(periodo_inicio) + 7` →
`APURACAO_FORA_DE_ORDEM`. Sem apuração anterior: livre (janela já validada por
`hub_adiantamento_repasse_pode_fechar`). Rota mapeia para `409 APURACAO_FORA_DE_ORDEM`.

**Rationale**: FR-021. Sem a trava, dois fechamentos simultâneos de semanas consecutivas
leriam o "último fechado" errado. O lock transacional some com o `COMMIT`.

## Decision 10 — F3: incluir quem só tem saldo (o furo do CTE `linhas`)

**Decision**: o CTE `linhas` (`0092:161-172`) e o equivalente da prévia ao vivo passam a
incluir o entregador quando `saldo_anterior > 0`, mesmo sem crédito, débito ou
adiantamento na semana. Sem filtro de `ativo` — motorista desativado segue com linha
(edge case da spec).

**Controle negativo obrigatório**: sem essa inclusão, o caso "R$ 3,00 → semana sem
atividade" tem de falhar.

## Decision 11 — F3: `total` do fechamento passa a ser `sum(valor_pago)`

**Decision**: manter a assinatura de `hub_adiantamento_repasse_fechar` (sem DROP) e trocar
o `total` devolvido para a soma do que será pago. Consumidores: rota `:1580` e
`components/hub/adiantamento-fechar-apuracao-dialog.tsx` (conferir o texto exibido).

## Decision 12 — F3: piso por empresa em `AdiantamentoConfiguracao`, escrita restrita

**Decision**: `repasse_valor_minimo numeric(14,2) NOT NULL DEFAULT 5.50 CHECK (> 0)`.
`hub_adiantamento_configuracao_salvar` (a partir de 0091) copia o valor da versão atual e,
se `p_dados ? 'repasseValorMinimo'` com valor diferente do atual, exige também
`hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar')` →
`PERMISSAO_NEGADA_PISO`. A rota `PUT /configuracoes` (`:484`) repete a checagem no Node
(403 antes de chamar a RPC). Tela: campo no card "Repasse semanal"
(`configuracoes/page.tsx:565`), desabilitado sem a permissão.

**Qual versão vale no fechamento (block-006)**: `hub_adiantamento_repasse_fechar` lê o
`repasse_valor_minimo` **vigente no momento do fechamento** — mesma leitura simples da
versão atual de `AdiantamentoConfiguracao` já usada pelo resto da função, dentro da mesma
transação — e não o vigente no início da semana. O valor lido é gravado em
`ApuracaoRepasse.piso_aplicado` (nulo em apurações pré-0098, Decision 7) só para
auditoria; a regra de cálculo (Decision 8) já usava esse mesmo piso, então não há coluna
de cálculo nova, apenas o retrato do que foi usado. A prévia da semana aberta
(`GET /repasse`) não muda: já lê o vigente a cada requisição, sem gravar nada (não há
fechamento). Se o piso mudar entre segunda e o fechamento, o fechamento usa o valor de
quando roda — não o de segunda.

## Decision 13 — F3: geração de notas em lotes (risco observado, mesmo arquivo)

**Achado**: a rota de geração (`hub-adiantamentos.js`, bloco de `:1654`) faz
`Entregador?id=in.(${ids.join(',')})` com **todos** os ids da apuração de uma vez. Nunca
rodou em produção (0 apurações fechadas); com ~1.000 motoristas é o mesmo padrão do
incidente do PR #50.

**Decision**: a F3 já edita essa rota (colunas novas no select); reusar o helper de lotes
da F1 ali. Custo: a troca de uma chamada.

## Decision 14 — Ordem e deploy

F1 → F2 → F3, cada uma PR/deploy próprio. F2: a migration leva trava de banco + papel
novo **juntos** (atomicidade garante "trava nunca depois do papel"); backend com a trava
de rota vai **antes** (preferível) ou imediatamente depois. F3 recomendada **antes do
primeiro fechamento** (medido: 0 apurações). Mudança de tipo de retorno → `DROP FUNCTION`
+ `CREATE` + `GRANT` refeitos + `SIGUSR1` no `pgadmin_postgrest` — **registrado no runbook,
executado pelo operador**.
