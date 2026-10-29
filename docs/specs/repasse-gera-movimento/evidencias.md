# Evidencias - repasse-gera-movimento (alimentado por P7)

Medido em 2026-10-28 (onda-008). Produzido por comando; saida literal quando o numero e a prova.

## FASE 0.1 - Baseline

- `git status` (rastreados): somente ` M docs/briefing.md` (alheio a esta frente); o resto e `??` de outras sessoes. Nada commitado, nada em stage.
- sha256 `package-lock.json`: frontend_v2 `b90342cc718553059a320fca29f63a95eb3b334e3c5ecd72d11443332a20fbae` · frontend_motorista `6e2d44ac6aedc30364fa7831bbc32ad594bba00cf7413feea358d72e4e526078`
- `df -h /`: 150G, 124G usados, **21G livres** (86%) - acima do piso de ~20 GB, **sem folga para build**. Swap: `/swapfile` 8G, 4.1G usados (ativa).
- Gates (reais, nao de memoria): backend `npm test` **2136/0** · `test:hub:unit` **1426/0** · `tsc --noEmit` frontend_v2 exit 0 e motorista exit 0 · vitest frontend_v2 **981/0** (100 arquivos) · motorista `node --test` **126/0** · lint **28 (5 erros / 23 warnings)**.
- Drivers de integracao: ver secao "Drivers" abaixo.

## FASE 0.2 - Sondas no `hub_homolog` (isolado; papel `authenticated` / JWT `authenticated`)

| Sonda | Comando | Saida literal |
|---|---|---|
| 0.2.1 nextval sem privilegio novo | `BEGIN; SET LOCAL ROLE authenticated; SELECT nextval('"EnvioMassa_id_seq"'); ... ROLLBACK` | `authenticated nextval \| 235443` e na 2a chamada `235444` (crescente, sem erro) |
| 0.2.2 POST com `id` explicito | PostgREST `POST /EnvioMassa {"id":900000001,"id_empresa":9001,...}` com JWT `role=authenticated` | `201` com `"id":900000001`; `last_value` da sequencia **inalterado** (235444). Linha de sonda removida depois (`DELETE 1`). |
| 0.2.3 formato do erro de PK | 2o `POST` com o mesmo `id` | `409 {"code":"23505","details":"Key (id)=(900000001) already exists.","message":"duplicate key value violates unique constraint \"EnvioMassa_pkey\""}` |
| 0.2.4 DELETE em `EnvioMassa` | `grep` em `routes/`, `lib/`, `server.js` | **EXISTE**: `server.js:1221` `app.delete('/envio-massa/:id', ... postgrestRequest('EnvioMassa?id=eq.${id}&id_empresa=eq.${idEmp}', 'DELETE')` |

Observacoes:
- O `psql -c "A; B"` imprime so o ultimo resultado - a sonda foi refeita com um comando por vez.
- Nao foi sondado o `23505` da **trilha** (`ApuracaoRepasseMovimento`) via PostgREST: a trilha so ganha escrita na FASE 3 e a funcao `hub_repasse_alocar_envio_id` so existe apos a 0118 (o `rpc` devolveu `404 PGRST202` antes dela, como esperado). O formato do `23505` e o mesmo (`409` + `code`) para qualquer UNIQUE/PK no PostgREST; a tarefa 3.5 o reconfere contra a trilha real.

### ACHADO 0.2.4 - a premissa "nenhum caminho do backend faz DELETE em EnvioMassa" e FALSA

`plan.md:421` e a tarefa 0.2.4 afirmavam "medido: nenhum" (o `grep` procurou `DELETE` junto de `EnvioMassa` na mesma linha; a chamada monta o caminho numa template string e passa `'DELETE'` como argumento, linhas separadas). O operador **pode apagar** um movimento pela tela legada (permissao `envio_massa.aprovar`).

Consequencia para S1: a trilha guarda `envio_massa_id` (sem FK). Se o movimento gerado for apagado, a conclusao ("reserva cujo `envio_massa_id` nao existe em `EnvioMassa`") **o recria com o mesmo id**. Decisao conservadora para a 3.8: manter o desenho (recriar) so quando a recriacao for **idempotente e explicita na resposta** - registrar em Decisao e levar ao relatorio; nao inventar escopo novo. Tratado na tarefa 3.8.

## FASE 2 - Migration `0118`

Arquivo: `infra/hub/migrations/0118_repasse_nota_a_emitir.sql` (525 linhas; corpo vivo da 0117 byte a byte + so as mudancas a-d; gerado por script a partir da 0117 e conferido por `diff`).

Driver novo: `infra/hub/testes/hub-repasse-nota-liquida-integration.sh` (o do lancamento externo fixa `categorias_nota = NULL`; aqui a empresa 6 tem divisao da nota). T06 (invariante) foi adicionado ao driver existente.

### Rodada 2 (COM a 0118): **35 PASS / 0 FAIL**

### Rodada 1 (controles negativos, reversao conferida no proprio driver por `patch_fn`/`cmp` e eco do corpo)

| Controle (`LE_NEG=`) | Resultado | Quais testes falham | Esperado pela tabela P2 |
|---|---|---|---|
| `sem-0118` (reaplica a 0117 sobre o stack) | 24 PASS / **11 FAIL** | T01 (nota sai **bruta**: `100.00\|20.00\|NULL`), T03, T05, SC-002 x3 (previa/congelado `NULL`), T04a, T04b, SC-002 N+1 x2 | T01, T03, T04, T05 falham; **T02 passa** (invariante) - confere |
| `sem-excedente` | 29 PASS / **6 FAIL** | T03, T04a, T04b (nota de N+1 sai **50** em vez de 20), SC-002 N+1 x2 | T03, T04 falham - confere |
| `sem-predicado` | 33 PASS / **2 FAIL** | so T04a (motorista com divida de nota **nao entra**: `1` motorista em vez de `2`) | T04 - confere |
| `sem-case` | 33 PASS / **2 FAIL** | T05 (`valor_nota` NULL em vez de 0) e T04a (colateral: M12 em N+1 tem `valor_nota` NULL) | T05 - confere |
| `acl-public` | 29 PASS / **6 FAIL** | T09 x6: `anon` com EXECUTE e `=X/` no `proacl` nas 3 funcoes | T09 - confere |
| T08 variante sem `IF NOT EXISTS` | falha na 2a aplicacao (controle permanente dentro do driver) | - | T08 - confere |

T02 (gorjeta intacta) passa nas duas rodadas, como a tabela diz (invariante legitimo). T06 e invariante: medido contra o codigo de hoje - sem `categorias_nota` o item sai `NULL\|NULL\|0.00` em ambas as versoes.

### Correcao de desenho achada pela leitura do backend (dec-055) - ANTES de a 0118 ir adiante

A primeira versao da 0118 somava `saldo_anterior_nota` tambem em semana de `remanescente < 0`. Mas `planejarGeracao` ja
excluia o saldo nesse caso (a 0098 o mantem em `transportado_nota` para a PROXIMA nota; somar duplicaria). Corrigido: em
`remanescente < 0` a base da nota e so a producao da semana, e `transportado_nota` fica `saldo_anterior_nota` (nenhum
excedente carregado: o caixa descarta o negativo por contrato). Teste novo T04c (M16: nota 20 sem somar a divida -30) e
controle `LE_NEG=sem-negativo`: 37 PASS / **1 FAIL** (so T04c; a nota sai 0 em vez de 20).
Rodada 2 final do driver novo: **38 PASS / 0 FAIL**.

### Drivers com a 0118 final (stack efemero, codigo antigo do front; backend atual)

| Driver | Antes (baseline) | Agora |
|---|---|---|
| `hub-lancamento-externo-integration.sh` | 150/0 | **151/0** (+T06) |
| `hub-adiantamentos-integration.sh` | 231/0 | **231/0** |
| `hub-repasse-lote-integration.sh` | 86/0 | **86/0** |
| `hub-lancamento-externo-rollback.sh` | 37 PASS | **37 PASS** (`RESULTADO rollback: OK`) |
| `hub-repasse-saldo-minimo-roundtrip-integration.sh` | 57/0 | **57/0** - mas so depois de corrigir a fixture (ver abaixo) |

**Achado do roundtrip (backend real, sem mock)**: com a rota nova o driver caiu para 49/8 - `POST /movimentos` devolveu `409`. Causa: a fixture
de configuracao do driver nao tinha `mensagem1_modelo` (era a FX-1 "obrigatoria" do quickstart), e a regra D10/FR-012 agora RECUSA em vez de gerar
mensagem vazia. Fixture ganhou `mensagem1_modelo`/`mensagem2_modelo` -> 57/0. Isto tambem prova, contra PostgREST de verdade, o fluxo S1 inteiro: alocar id (RPC)
-> `POST` da trilha com o id -> `POST EnvioMassa` com `id` explicito -> 201 e `EnvioMassa.valor = 10.00`.

### hub_homolog (isolado) - 2.6

`preflight.sh` PASSOU; `migrate.sh` aplicou a 0118 (registro `141 | 0118_repasse_nota_a_emitir.sql`); 2a execucao: nada a aplicar. `POST /rpc/hub_repasse_alocar_envio_id` via PostgREST do hub
(JWT `authenticated`) -> `200 235451`. `proacl` das 4 funcoes: nenhuma entrada de PUBLIC. O unico item de `ApuracaoRepasseItem` em hub_homolog tem `nota_a_emitir IS NULL` (linha anterior a 0118).

## FASE 3 - Backend (parcial: 3.1-3.7 em codigo + testes de rota; falta o driver de concorrencia em banco real)

Arquivos: `routes/hub-adiantamentos.js` (helper `mapearErroFechamento`, pre-flight, fechar-se-nao-existir, S7, laco S1, auditoria) e
`lib/adiantamento-geracao-movimento.js` (`nota_a_emitir`, `NOTA_LIQUIDA_AUSENTE`, pendencias, textos de falha).
Testes novos: `tests/hub-repasse-movimentos-rota-unit.test.js` (16, PostgREST fake COM ESTADO: UNIQUE da trilha, PK de EnvioMassa, sem RLS, concorrencia por intercalacao)
+ 6 em `adiantamento-geracao-movimento-unit.test.js` + 4 em `hub-adiantamentos-rotas-unit.test.js`. Backend **2162/0** (era 2136), `test:hub:unit` **1446/0** (era 1426), `checar-testes-orfaos` ok.

### Controles negativos da FASE 3 (reversao conferida por grep no arquivo; restauracao conferida por `diff` contra o backup)

| Correcao revertida | Falham (so estes) | Passam |
|---|---|---|
| 3.3 `planejarGeracao` volta a ler `valor_nota` (+saldo) | T01, T07, T07b, "deducao que zera a nota" (4) | T05, T06 (invariantes **no unit**: `valor_nota 0` ja dava `VALOR_ZERO`; o `NULL`-vs-0 e provado no driver novo) |
| 3.4 S7: leitura de abertos sem `id_empresa=in.(grupo)` | T18 e P6 (2) | os demais 14 |
| 3.5 S1: `POST EnvioMassa` sem o `id` | T12, T13/T15, T17 (3) | T14 (a trilha ainda serializa) |
| 3.5 S1: violacao do UNIQUE da trilha tratada como falha comum | T14 (1) | os demais |
| 3.2 pre-flight desligado | T10, T11 (2) | os demais |
| 3.6 checagem de modelo desligada | T21 (1) | os demais |

### 3.8.1 - toda chamada a `EnvioMassa` desta rota e o filtro de tenant

| Chamada (`routes/hub-adiantamentos.js`) | Filtro |
|---|---|
| abertos: `EnvioMassa?mov_fechado=eq.false&id_empresa=in.(<grupo>)&select=cnpj_prestador` + `cnpj_prestador=in.()` | **novo (S7)** |
| historico #229: `EnvioMassa?dt_final=gte.X&id_empresa=in.(<grupo>)...` | ja existia; agora reusa o grupo resolvido **uma vez** |
| existencia por id: `EnvioMassa?id_empresa=in.(<grupo>)&select=id` + `id=in.()` | **novo (S1)** |
| `POST EnvioMassa` com `id` | `id_empresa` vem de `GRUPO_MOVEE_ID` na linha montada por `planejarGeracao`, nunca do corpo da requisicao |

Coberto por teste (`P6/3.8: TODA leitura de EnvioMassa ... id_empresa=in.(6,7)`), que falha na mutacao S7.
O teste T19 (JWT de **outra** empresa) exige banco/PostgREST reais e fica para a FASE 5.

### 3.8.2 - o limite "apagar uma EnvioMassa gerada" (ver ACHADO 0.2.4 acima)

Confirmado: `DELETE /envio-massa/:id` existe (`server.js:1221`, permissao `envio_massa.aprovar`). Efeito sobre o desenho: a trilha guarda `envio_massa_id`; se o operador apagar o movimento
gerado, a proxima geracao o trata como "reserva sem movimento" e o **recria com o mesmo id**, desde que valor/gorjeta recalculados batam com a trilha. Decisao (mais conservadora que
inventar escopo): manter o desenho, nao tocar o `DELETE` legado, e declarar o limite no relatorio final e na ajuda (FASE 6). Se o operador quiser que apagar = "nao gerar de novo", e outra frente.

### Decisoes de projeto desta onda (sem bloqueio humano - criterio mais conservador)

1. Modelo de mensagem: a recusa `MODELO_MENSAGEM_AUSENTE` exige `mensagem1_modelo` nao vazio (e o modelo da nota); `mensagem2_modelo` vazio nao e "texto inventado" (renderiza vazio, como hoje). Checada **antes** de fechar (fechar e irreversivel) e de novo na apuracao ja existente.
2. `PERIODO_EM_ABERTO` ganha `liberaApos: { data, horario, timezone }` (dia seguinte ao fim da semana + corte da config vigente) - o RPC nao devolve o instante.
3. Item anterior a 0118 (`nota_a_emitir NULL` com `valor_nota` presente) e **recusado** com `NOTA_LIQUIDA_AUSENTE` (P4), nunca gerado pelo bruto. Impacto: uma apuracao fechada antes da 0118 e ainda sem notas geradas nao pode mais ser gerada por esta rota - o financeiro precisa saber (relatorio final).
4. Pre-flight usa `limit=5000`: se o PostgREST de producao tiver `PGRST_DB_MAX_ROWS` menor, o `total` do 409 pode subestimar, mas a **decisao de recusar** continua correta (ha ao menos uma linha).

## FASE 3 - fechamento (onda-009): concorrencia em banco real

**Driver `hub-adiantamentos-integration.sh`: 231/0 -> 235/0** (+4). Bloco "repasse-gera-movimento FASE 3/5 (T14-T17, S1)":
duas sessoes `psql` reais; a A segura a transacao com `pg_sleep(2)` e a B entra 0,7 s depois. A sobreposicao e **provada**, nao suposta: o tempo da B medido
tem de ser >= 1000 ms (a B bloqueou esperando a A). Sem isso o teste passaria com e sem a correcao (achado do checklist).

| Check | Resultado |
|---|---|
| ordem NOVA (alocar id -> trilha UNIQUE -> `EnvioMassa` com o id), duas conclusoes sobrepostas | **1 trilha, 1 `EnvioMassa`** |
| sobreposicao real (B >= 1000 ms) | PASS |
| **controle negativo**: ordem ANTIGA (`EnvioMassa` antes da trilha) | **2 `EnvioMassa`, 1 trilha - duplica** (reproduz o defeito) |
| 6 alocacoes simultaneas de `hub_repasse_alocar_envio_id()` | 6 ids distintos |

Duas armadilhas do proprio teste, corrigidas antes de valer: (1) `EnvioMassa.id_empresa` tem FK - o driver nao tinha `Empresa` 6 e as duas rodadas davam `0|0` (erro engolido pelo `EXCEPTION`);
(2) um `EXCEPTION` em bloco plpgsql desfaz o bloco inteiro e escondia a duplicata da ordem antiga - o handler ficou so em volta do `INSERT` da trilha.
Limite declarado: isto e o **modelo SQL** do laco S1; o laco em Node (reserva reaproveitada, texto por falha) segue provado pelos 16 testes de rota com PostgREST fake com estado.

**Driver `hub-repasse-saldo-minimo-roundtrip-integration.sh`: 57/0 -> 61/0** (+T18, +3 de T19), backend real + PostgREST real:
- T18: movimento ABERTO do mesmo CNPJ na empresa 9 nao trava a geracao da Movee (1 `EnvioMassa` em `id_empresa=6`).
  **Controle negativo** (tirei `&id_empresa=in.(...)` da leitura de abertos, reversao conferida por `sed -n`; restaurada e conferida por `diff`): falham **3** - T18, "1 movimento gerado na semana 2", "`EnvioMassa.valor` = 10.00" (obtido 1.00); passam os demais 58.
- T19: financeiro de OUTRA empresa (9) loga (200), troca de entidade (200), `POST .../movimentos` da Movee **nao e 2xx** e a leitura da apuracao devolve **0 itens**.
  **Sem controle negativo proprio**: quem barra e o escopo/RLS do JWT, nao o filtro de S7; nenhuma mutacao isolada foi feita para T19 - o teste prova o comportamento, nao a causa.

## FASE 4 - Frontend (onda-009)

### 4.1 P5 - "isto ja aparece em X" (CLAUDE.md, "Propor UI nova"), lido ANTES de escrever UI

| Proposta de UI | Onde a informacao JA aparece hoje | Decisao |
|---|---|---|
| Rotulo "Gerar do repasse" | Tela Repasse: botoes "Fechar apuração" e "Gerar notas da semana" (`repasse/page.tsx`); ajuda do hub (`ajuda-conteudo.json`) chama os dois passos assim | rotulo e o de FR-014 (decisao do operador); os dois botoes viram UM; "Gerar notas da semana" continua sendo o NOME do passo na ajuda ate a FASE 6 |
| Contagem de pendencias por status | Dialogo "Fechar apuração" (`rotuloStatusAdiantamento`, ex. "Adiantamento liberado: 2") | **reusado** o mesmo bloco e o mesmo rotulador; nenhum vocabulario novo |
| Nomes de quem trava | **Em nenhum lugar** (so contagem) | novo, exigido por FR-009; nome + status, lista capada em 20 + "e mais N", como texto, sem CNPJ/telefone/valor |
| Motivos de recusa da geracao | Toast da tela Repasse via `resumirRecusas` | **reusado** (mesma funcao, mesmos rotulos) |
| Nota liquida / gorjeta | Coluna do CSV "Valor da nota fiscal da semana"/"Gorjeta da semana" e card da home do app motorista ("VALOR DA NOTA FISCAL"/"GORJETA") | **nenhum rotulo novo** nesta frente; a tela nao ganha coluna de nota liquida |
| Remanescente negativo (caixa de confirmacao) | Dialogo "Fechar apuração" + `AvisoLancamentoExterno` | **movido** com texto identico (so "Confirmo fechar" -> "Confirmo gerar") |
| Aviso de espera (`PERIODO_EM_ABERTO`) | Mensagem generica "O período ainda está em aberto para solicitações." | ganha "a partir de DD/MM/AAAA às HH:MM" (campo `liberaApos` da FASE 3) |

### 4.2-4.6 Entregue

- `components/hub/gerar-do-repasse-button.tsx` (novo): renderiza nada sem `adiantamentos.pagamento_confirmar`; `periodo?` (sem `variant`); sem `periodo` -> `<input type="date">` ISO com default = semana imediatamente anterior a corrente (`semanaAnterior`, pela config); 6+ codigos de 409 com texto proprio; pendencias em DIALOGO (nao toast).
- `lib/hub/adiantamentos-api.ts`: `AdiantamentosApiError.corpo`, `AdiantamentosPendentes`, `pendentesDoErro`, textos de `ADIANTAMENTOS_PENDENTES`/`MODELO_MENSAGEM_AUSENTE`/`EMPRESA_SEM_CNPJ`. `fecharRepasse()` e a rota `/fechar` **mantidos** (FR-013).
- `repasse/page.tsx`: os dois botoes e o dialogo saem (deletado `adiantamento-fechar-apuracao-dialog.tsx`, ~167 linhas); `<GerarDoRepasseButton periodo={h.periodo} onSucesso={h.refetch} />`.
- `components/action-bar.tsx` (compartilhado pelas DUAS telas de Envio em Massa, legada e hub): botao sem `periodo`; `app/dashboard/layout.tsx` ganha `HubAuthProvider` **sem** `HubSessionGuard`. `import-button.tsx` e `app/dashboard/page.tsx` intocados.
- `lib/hub/repasse-lote.ts`: a acao de `APURACAO_ABERTA` dizia 'Use "Fechar apuração"' (botao que nao existe mais) -> 'Gerar do repasse'. **Achado**: nao estava na lista de tarefas.
- E2E `adiantamentos.spec.ts`: 2 testes reescritos para o fluxo novo + stub de `POST /movimentos`.

### Guarda "informado, nao bloqueado" (P9) - os 5 testes migrados e o controle negativo

Os 5 (`A2` + 4 de `C4`) foram para `gerar-do-repasse-button.test.tsx` com as **mesmas asserções**; mudaram so o nome do controle ("Fechar apuração" -> "Gerar do repasse") e a funcao chamada (`fecharRepasse` -> `gerarMovimentos`). Migrados ANTES de apagar o dialogo.
Controle negativo (4.2.4): `exigeConfirmacao = false` no componente (reversao conferida com `grep -n`; restaurada e conferida por `diff`): **falham 4** - A2, "CARREGANDO", "ERRO na consulta", "backend SEM o campo qtdNegativo"; passa o quinto, "controle: qtdNegativo 0 conhecido NAO exige a caixa" (e o controle POSITIVO, passa com e sem a guarda por desenho).

### Numeros

vitest **990/0** (era 981: -8 testes migrados/removidos de `repasse/page.test.tsx`, +1 T22b, +14 do componente, +2 do layout, +1 sobrado do ajuste; total conferido pela execucao completa); `tsc --noEmit` limpo; lint **28 (5 erros/23 avisos)** = baseline.
Detector impeccable (hook PostToolUse) sobre `gerar-do-repasse-button.tsx`: **0 achados**. Area tocavel: `min-h-11 sm:min-h-8` (mesmo padrao dos botoes vizinhos) e `h-11` no campo de data. Sem `<option>` (nada a medir no tema escuro).
**NAO medido** (4.7.2/4.7.3 ficam `[~]`): area tocavel e tema escuro no DOM de um browser real - exige o E2E de browser.

### E2E de browser - NAO rodou

`hub-adiantamentos-e2e-browser.sh` **abortou pela propria guarda**: "disco livre em / < 21Gi" (host em 20 GB). Respeitei a guarda, nao a contornei. Tentei liberar com `docker rmi` das 5 imagens sem tag criadas por esta sessao (nenhum ganho: camadas compartilhadas). O spec reescrito esta tipado (`tsc`) mas **nao foi executado**. Pendente para quando houver disco (>= 21 GB) - registrado em `deferred-work.md`.

### dec-049 no frontend (barato, feito)
Ao abrir o dialogo, a mesma leitura de `obterConfiguracoes()` que da o default da semana avisa **antes de confirmar** quando `vigente.mensagem1Modelo` esta vazio: "a geracao sera recusada. Cadastre o modelo antes de gerar". **A regra nao mudou** (o botao segue habilitado; quem recusa e o backend, `MODELO_MENSAGEM_AUSENTE`). Falha na leitura da config = sem aviso, nunca bloqueio. 2 testes (com aviso; controle sem aviso).

## FASE 6 - Ajuda (onda-009)

Hub (`lib/hub/ajuda-conteudo.json`): a trilha do ciclo passou de 6 para 5 passos ("Gerar do repasse" funde "Fechar apuração" + "Gerar notas da semana"; `ajuda/page.test.tsx` ajustado de 6 para 5 - mudanca de CONTEUDO, nao de regra); tabela de recusas, matriz de papeis, secao do repasse ("O que impede de gerar", incl. modelo de mensagem e pendencias nominais), "O pago por fora abate a nota" (a gorjeta nao e tocada; excedente desconta das proximas semanas), aviso "Apagar um movimento gerado", tabela de erros (`ADIANTAMENTOS_PENDENTES`, `MODELO_MENSAGEM_AUSENTE`).
App (`frontend_motorista/lib/ajuda-conteudo.json`): uma dica nova sob o card da home - P5 cumprido: a tela `app/(app)/repasse/page.tsx:126/252` ja mostra "Pago por fora" e o card da home ja mostra "Valor da nota fiscal"/"Gorjeta"; nenhum rotulo novo, so explica por que a nota do card pode ser menor que a do extrato. HTMLs publicados: nenhum no repo (gerados fora); nada editado a mao.
`ajuda.test.ts` 14/0; motorista `node --test` **126/0**.

## FASE 7 - Revisao adversarial independente (7.2) - revisor opus, nao o autor, 15 mutacoes em COPIAS

**0 bloqueantes, 1 alto, 2 medios, 9 baixos.** Relatorio integral em `/tmp/rgm-review.md` (efemero); resumo e destino de cada achado:

| # | Sev. | Achado | Destino |
|---|---|---|---|
| 1 | ALTO | Pago por fora >= nota zera `nota_a_emitir`; a geracao recusa (`VALOR_ZERO`), o lote mostra `NOTA_PENDENTE` e o que sobra (gorjeta - excedente) nao e transportado (`valor_transportado = 0` no ramo pago). O teste `adiantamento-geracao-movimento-unit.test.js:276` afirma o comportamento. | **Decisao de PRODUTO do operador, pendente** (mesmo `dec` registrado); codigo INALTERADO (preferir restringir; mudar o ramo pago/lote e outra migration e outra frente); declarado no RUNBOOK e no relatorio. Mesma classe de "so gorjeta, sem nota" que ja existia |
| 2 | MEDIO | CSV/tela mostram a nota BRUTA; o movimento sai LIQUIDO (`nota_a_emitir` nao chega a DTO/CSV/UI) | **Deferido**: o cabecalho do CSV e contrato fixo do roundtrip e coluna nova e vocabulario novo (P5). Declarado no RUNBOOK; `deferred-work.md` |
| 3 | MEDIO | S1 depende de `USAGE` na `"EnvioMassa_id_seq"` e de `id` aceitar valor explicito - medido so no espelho | **Passo 0 do RUNBOOK** (leitura em producao pelo operador antes de qualquer coisa) |
| 4 | BAIXO | Teste oco: ramo "PK violada => JA_GERADO" revertivel sem teste falhar | **CORRIGIDO**: T17 agora afirma o motivo do perdedor; controle negativo (`if (false)` no ramo, conferido por grep): 1 falha; restaurado e conferido |
| 5 | BAIXO | Texto "nada foi gravado" mente se a resposta se perde depois do commit | Aceito/declarado (retomada converge sem duplicar) |
| 6 | BAIXO | `EMPRESA_SEM_CNPJ` checado depois do fechamento implicito | Aceito/declarado (retomavel); `deferred-work.md` |
| 7 | BAIXO | Trocar a semana no seletor mantinha a caixa do negativo marcada | **CORRIGIDO** + teste; controle negativo: falha so este |
| 8 | BAIXO | `APURACAO_COM_PENDENCIAS` (corrida) perdeu a contagem por status | **CORRIGIDO** + teste; controle negativo: falha so este |
| 9 | BAIXO | Leitura morta `jaGeradosLinhas` | **REMOVIDA** (1 consulta a menos por acionamento); 217/0 |
| 10 | BAIXO | `limit=5000` sem contagem exata no 409 | Ja era a decisao 4 da FASE 3; declarado |
| 11 | BAIXO | `e.message` em log pode trazer a linha inteira (PII) | **CORRIGIDO** nos 2 logs novos (so `status`) |
| 12 | BAIXO | `lancamento-externo/RUNBOOK.md` mandava usar "Fechar apuração" | **CORRIGIDO** |

Verificado e OK pelo revisor: 0118 contra a 0117 por diff programatico; algebra dos CASEs (previa == fechado, NULL x 0, `numeric` exato); predicado da CTE `linhas`; intercalacoes do laco S1 (sem duplicata fora do limite do `DELETE` legado); 14 de 15 mutacoes derrubaram teste (a 15a e o achado 4, ja corrigida); tenant em TODA leitura de `EnvioMassa` (controle positivo pegou template strings); 409 sem PII; guarda do negativo portada fielmente; `/fechar` e funcoes do app do motorista nao tocadas.

## 7.3 Baseline x final (todos medidos nesta onda, apos as correcoes da revisao)

| Gate | Baseline (0.1) | Final |
|---|---|---|
| backend `npm test` | 2136 | **2162/0** |
| `test:hub:unit` | 1426 | **1446/0** |
| `tsc --noEmit` (frontend_v2; frontend_motorista) | limpo | **limpo** (os dois) |
| vitest | 981 | **992/0** |
| motorista `node --test` | 126 | **126/0** |
| lint | 28 (5/23) | **28 (5/23)** |
| adiantamentos | 231 | **235/0** |
| lancamento externo | 150 | **151/0** |
| lote | 86 | **86/0** |
| roundtrip | 57 | **61/0** |
| rollback | 37 PASS | **37 PASS** |
| nota liquida (driver novo) | - | **38/0** |
| `package-lock.json` | sem diff | **sem diff** (`git status -- '*package-lock.json'` vazio) |
| perf | - | **nao medido** nesta onda (nenhuma query nova no caminho quente alem do pre-flight, com `limit=5000`) |
| E2E de browser | - | **NAO rodou** (guarda de disco do proprio driver) |

## dec-054 — gorjeta presa (decisao do operador 28/10): resolvida

- `planejarGeracao`: nota zerada POR DEDUCAO (`valor_nota + saldo_anterior_nota` > 0, mesma base da 0118:213) COM gorjeta gera o movimento so-gorjeta (nota 0). Base ja zero (nao produziu) e "dedutiva sem gorjeta" seguem `VALOR_ZERO`. Remanescente negativo: saldo carregado nao conta como base.
- 4 testes nomeados (unit). Controle negativo: `soGorjetaPorDeducao = false` -> falha o teste novo; variante "qualquer zero com gorjeta" -> 4 falhas (os casos base-zero). Arquivo restaurado e conferido (`grep baseNota > 0`).
- MEDIDO: o lote devolvia `NOTA_PENDENTE` para esse movimento (aprovadas 0 < total 1) — migration inevitavel: `0119_repasse_lote_nota_zero.sql` (so `hub_repasse_lote_avaliar`, `nota_a_emitir IS DISTINCT FROM 0` antes do NOTA_PENDENTE; NULL = comportamento anterior). 0118 intocada.
- Driver do lote: 86 -> **89 PASS / 0 FAIL** (apta, controle nota devida, controle negativo com o corpo da 0117 mostrando o defeito).
- Gates reexecutados: backend 2165/0, hub:unit 1446/0, lancamento externo 151/0, adiantamentos 0 falha, lote 89/0.
- ~~ABERTO~~ **RESOLVIDO por dec-056** (decisao do operador 28/10): `routes/motorista.js` filtra `valor=gt.0` (`VALOR_EMITIVEL`) nas 4 rotas do app; FR-023.

## FASE 8 (convergencia) — correcoes de artefato

- Artefatos corrigidos/propagados: `quickstart.md` (C5 + cenario 5b), `plan.md` (tabela de recusas 7→8 com ancoras remedidas; F1b = `0119`; F1c = filtro do motorista), `spec.md` (FR-022, FR-023, emenda a FR-006), `data-model.md`, `contracts/hub-repasse-gerar-movimentos.md`, `tasks.md` (5.2.1/7.2.4/7.3.1, nota de T21, Resumo, Escopo), `deferred-work.md` (gorjeta presa: resolvida).
- C9c implementado: `T11b` em `tests/hub-repasse-movimentos-rota-unit.test.js` (17/0 no arquivo). Controle negativo: sem resolver os pendentes, falha.
- Controle negativo do filtro do motorista, 1 rota por vez (restaurado e conferido com `cmp`): `/movimento-aberto` 2 falhas, `/validar-nota` 2, `/notas-pendentes` 3, `/notas-pendentes/:id/validar` 1; restaurado: 88/0.
- Gates: backend 2175→2176 (+T11b); demais inalterados (nenhum codigo de producao tocado).

## Onda-013 — passada de confirmação do `converge` + todos os gates no MESMO estado

Nenhum código de produção foi tocado nesta onda: as correções são de **prosa de artefato**
(4 achados abaixo). Os gates foram medidos **depois** das correções.

### Os 4 achados do converge de confirmação (todos remediados na própria onda)

| # | Sev | Achado | Correção |
|---|-----|--------|----------|
| 1 | ALTO | `RUNBOOK-DEPLOY.md` declarava a **gorjeta presa** como limite conhecido vigente, com "decisão de produto **PENDENTE** do operador" — mas a `dec-054` (28/10) a **resolveu**. Alarme sobrevivendo à causa. | Reescrito como ✅ RESOLVIDO, com o comportamento vigente (`valor=0`, `gorjeta>0`, `total=gorjeta`, contado em `gerados`) e a dependência das **duas** migrations. `dec-065` |
| 2 | ALTO | A migration **`0119`** existia no disco (`6956` bytes, 28/10 15:27) e **não estava no runbook** — a receita do "meio-deployado". | Novo **Passo 2b** depois da `0118`, com verificação própria (`prosrc LIKE '%nota_a_emitir%'`; `has_function_privilege` para `authenticated`/`anon`) e **rollback próprio** (reaplicar a função da `0117` §9, `:1352`/`:1369`). Mais: ordem obrigatória `0118`→`0119` no cabeçalho, a `0119` em "O que muda", e passo 7 no roteiro de validação. `dec-066` |
| 3 | MÉDIO | 4 referências ao `:2321` estavam em **presente** ("é falsa **hoje**", "**tem de ser** consertada") e liam-se como **bug vivo**: `data-model.md:118` e `:153`, `contracts/hub-repasse-gerar-movimentos.md:168`, `plan.md:364`. | Remarcadas como estado **ANTERIOR/CORRIGIDO**, com a âncora declarada como "numeração de **antes** da correção". `dec-067` |
| 4 | BAIXO | `plan.md:42` dizia "**7** ramos de recusa", contra os **8** de `plan.md:558` — contradição no mesmo documento. | Corrigido para **8**. `dec-067` |

Prova de que o achado 3 é de fato passado (não suposição): `lib/adiantamento-geracao-movimento.js:253`
— *"Textos VERDADEIROS por modo de falha do laço de geração"* — e `routes/hub-adiantamentos.js:2321`
**hoje é** `if (!cnpjTomador) {`; os `FALHA_AO_GRAVAR` vivos estão em `:2415` (`RESERVA_DIVERGENTE`),
`:2435` (`NADA_GRAVADO`) e `:2449` (`RESERVA_SEM_MOVIMENTO`).

### Gates — TODOS medidos no mesmo estado (pós-correções)

| Gate | Baseline esperada | Medido na onda-013 |
|------|-------------------|--------------------|
| backend `npm test` | 2176/0 | **2176/0** |
| `test:hub:unit` | 1446/0 | **1447/0** — ver nota do delta |
| vitest (frontend_v2) | 992/0 | **992/0** (102 arquivos) |
| motorista `node --test` | 126/0 | **126/0** |
| `tsc --noEmit` frontend_v2 | exit 0 | **exit 0** |
| `tsc --noEmit` frontend_motorista | exit 0 | **exit 0** |
| lint (vs. baseline) | 28 (5/23) | **28 problems (5 errors, 23 warnings)** = baseline, **0 erro novo** |
| `hub-adiantamentos-integration.sh` | 235/0 | **235 PASS / 0 FAIL** |
| `hub-lancamento-externo-integration.sh` | 151/0 | **151 PASS / 0 FAIL** |
| `hub-repasse-lote-integration.sh` | 89/0 | **89 PASS / 0 FAIL** |
| `hub-repasse-saldo-minimo-roundtrip-integration.sh` | 61/0 | **61 PASS / 0 falha(s)** |
| `hub-lancamento-externo-rollback.sh` | 37 PASS | **37 PASS** (`RESULTADO rollback: OK`) |
| `hub-repasse-nota-liquida-integration.sh` | 38/0 | **38 PASS / 0 FAIL** |
| `hub-lancamento-externo-perf.sh` | *era "não medido"* | **7 PASS / 0 FAIL** — inclui `LIQ critério 4: custo por chamada do líquido <= 1 ms` |
| `package-lock.json` | sem diff | **sem diff** (`git diff --stat` vazio nos 3 pacotes) |

⚠️ **Nota do delta de `test:hub:unit` (1446 → 1447)**: **não é regressão**. O `T11b`
(`tests/hub-repasse-movimentos-rota-unit.test.js:180`) está nos scripts de **`npm test` E de
`test:hub:unit`** — o mesmo +1 que levou o backend de 2175 a 2176. A nota da FASE 8 registrou
só a metade do backend. Medido: o arquivo isolado dá **17/0**. **1447/0 é a baseline correta.**

✅ **`perf` deixou de ser "não medido"**: a FASE 7 o havia dispensado por argumento
(*"nenhuma query nova no caminho quente"*). Nesta onda ele **rodou** — 7/0, com os critérios de
índice (`zero Seq Scan em LancamentoExterno`, `Index Cond` cobrindo igualdade + faixa), de tempo e
de buffers dentro de 2× a baseline, e `4.5.4: sem resíduo — count antes (0) = depois (0)`.
Argumento substituído por medição.

### E2E de browser: gatilho reconferido, guarda NÃO contornada

`df -BG --output=avail /` = **20 G**; a guarda do driver exige **21 GB**. Mantidas deferidas
5.5.1, 5.5.2, 4.7.2 e a parte de banco real de 5.2.1 (`dec-068`). Não houve `docker prune` nem
qualquer tentativa de contornar: a memória do projeto registra que apagar imagem rende pouco
(camadas compartilhadas) e que o acervo é de vários clientes.

**4.7.1 e 4.7.3 fecharam** (não eram falta de medição, e sim leitura equivocada de escopo): o
diálogo **não é** arquivo separado — vive dentro de `components/hub/gerar-do-repasse-button.tsx`
(`:145` `<AlertDialog>`; `:7` registra que a guarda do antigo `FecharApuracaoDialog` migrou para
lá, e `adiantamento-fechar-apuracao-dialog.tsx` foi **deletado**). O detector, cobrindo esse
arquivo com **0 achados**, cobriu **componente + diálogo**; `evidencias.md:179` é o relatório com
a contagem que 4.7.3 pedia. Resta só 4.7.2 (medir no **DOM vivo**) — medir no código não
substitui medir no DOM.

## Revisão adversarial de 3 camadas sobre `1ae29af` → `6b0f550` (2026-10-28)

Blind Hunter (só o diff, sem acesso ao projeto) · Edge Case Hunter (diff + projeto) · Acceptance
Auditor (diff + spec + os 12 D's), em paralelo, sem contexto da sessão, em Opus. Placar bruto:
blind 4 ALTO/9 MÉDIO/6 BAIXO · edge 2 ALTO/6 MÉDIO/3 BAIXO · auditor 2 ALTO/7 MÉDIO/5 BAIXO,
com 12/12 decisões conferidas (9 corretas, 3 divergentes).

### Medições primeira-mão que decidiram cada achado

| O que foi medido | Comando / fonte | Resultado | Decide |
|---|---|---|---|
| `EnvioMassa.id` é `ALWAYS` ou `BY DEFAULT`? | `information_schema.columns` em produção | `is_identity=YES`, `identity_generation=**BY DEFAULT**`, `column_default=(null)`, `bigint` | **refuta** o único item que o blind pediu antes do deploy (o INSERT com id explícito funciona) |
| `LancamentoExterno.valor` pode ser ≤ 0? | `0117:75` | `CONSTRAINT lancamentoexterno_valor_positivo_chk CHECK (valor > 0)` | **refuta** "LEAST sem piso infla a nota" |
| `lancamentos_externos` pode ser NULL? | `0117:676` + `information_schema` + join da `0119:15` | coluna `NOT NULL DEFAULT 0`; join **direto** (não LEFT); 0 itens na tabela | **refuta** "falta COALESCE" |
| A operação fecha movimento? | `EnvioMassa` do grupo Movee, em produção | **53.988 fechados** contra **937 abertos** (98,3%) | **refuta** "fechar movimento virou pré-requisito contra D12"; confirma que os 937 são a semana corrente |
| O gate da `0119` exclui planilha? | diff da definição viva `0117`→`0119` | ramo (b) do UNION da `0109` **byte a byte idêntico** | **refuta** a suspeita |
| Ficou 5ª rota do app sem filtro? | enumeração de `EnvioMassa` em `routes/motorista.js` | as 4 são as certas (`:712/830/1066/1146`) | **refuta** — mas acha a 5ª porta no **painel** |
| `/validate-xml-batch` filtra valor? | `server.js:2528` | `mov_fechado=eq.false&id_empresa=eq.` — **sem** `valor=gt.0`; `grep VALOR_EMITIVEL server.js` = 0 | **confirma** o patch |
| `/upload` é tudo-ou-nada? | `server.js:2031` | `if (errors.length > 0)` ⇒ 400 "Nenhum registro foi inserido" | **confirma** o ALTO |
| O export traz `gorjeta`? | `server.js:2141` | `grep gorjeta` no select = **0** | **confirma** o ALTO (round trip quebrado) |
| O lote depende de `mov_fechado`? | `grep mov_fechado` na `0109` e `0119` | **0 ocorrências nas duas** | **viabiliza** a correção "nascer fechado" |
| A correção pela tela aceita movimento fechado? | `envio-massa-correcao.js:196` | `pulado_mov_fechado` ⇒ **409** | **custo declarado** de "nascer fechado"; saída de D11 = apagar |
| Movimentos abertos hoje (dia 1 do deploy) | produção, grupo Movee | **937 motoristas / 937 linhas**, **0** com `valor<=0` | entrou como pré-check no RUNBOOK Passo 0 |

### Controle negativo por correção (guarda anti-oco)

Cada correção revertida isoladamente, com conferência **no arquivo** de que a reversão surtiu
efeito antes de medir:

| Reversão | Resultado |
|---|---|
| `mov_fechado: soGorjetaPorDeducao` → `false` | **1 falha** (suíte `mov_fechado do movimento so-gorjeta`), 43 passam |
| `temColunaGorjeta && linhaSemNada` → `linhaSemNada` | **1 falha** (teste de ligação) |
| `valor,gorjeta,mensagem1` → `valor,mensagem1` no export | **1 falha** |
| `&valor=gt.0&id_empresa=eq.` → sem o filtro | **1 falha** |

⚠️ **A guarda anti-oco pegou 2 reversões que NÃO aplicaram** (escaping de `perl`): sem ela, as duas
teriam reportado "0 falhas", que eu leria como "o teste não discrimina" — quando o fato era "o
controle negativo não rodou". Confirmar no arquivo **antes** de medir é o que separa os dois casos.

### Gates após as correções

backend **2182/0** (+3 testes) · `test:hub:unit` **1448/0** · vitest **992/0** · app motorista
**126/0** · `tsc` limpo nos dois · lint **28 (5 erros/23 avisos)** = baseline exata · driver nota
líquida **39/0** · driver adiantamentos **0 falhas** · driver lote **91/0** · `package-lock.json`
sem diff · `gitleaks protect --staged` **0 leaks**.

## E2E de browser — RODOU em 2026-10-29 (15/15 × 3 rodadas)

Desbloqueado quando o operador rodou `~/liberar-disco-PASSO0.sh --aplicar`: disco **19 → 21 GiB**
(ganho real **1.702 MB**; 3 imagens removidas, todas confirmadas no registry e reversíveis por
`pull`). A guarda do driver (`:54`, 21 GiB = 21.943.040 KB) passou com **~135 MB de margem** —
medido como o driver mede, `df -Pk / | awk 'NR==2{print $4}'` = 22.081.548 KB.

| Rodada | Resultado | Correção aplicada antes |
|---|---|---|
| 1 | **12 passed / 3 failed** | — |
| 2 | **13 passed / 2 failed** | stub do resumo ganhou `qtdNegativo`/`totalNegativo` |
| 3 | **14 passed / 1 failed** | stub dos lançamentos ganhou `semanaFechada`; locator `getByRole('listitem')` |
| 4 | **15 passed / 0 failed** | locator ancorado: `/^Adiantamento liberado:/` |
| 5 e 6 (confirmação) | **15/15** e **15/15** | nenhuma — estável, não flaky |

### 🔴 As 3 falhas: nenhuma era defeito de produção, todas eram stub violando o contrato

1. **`qtdNegativo` ausente no stub do resumo.** `ResumoLancamentosExternos`
   (`lib/hub/lancamento-externo.ts:78`) o declara `number | null` e a rota real o devolve
   (`routes/hub-adiantamentos.js:1854`). Sem ele, `typeof qtdNeg !== 'number'` ⇒
   `negativoDesconhecido = true` ⇒ `exigeConfirmacao = true` e o botão de confirmar fica
   **`disabled` para sempre** (115 tentativas de clique no log). ⚠️ **O componente está CORRETO** —
   é o fail-closed que a frente anterior implementou de propósito (`gerar-do-repasse-button.tsx:99-100`).
2. **`semanaFechada` ausente no stub dos lançamentos.** Campo **obrigatório** em
   `LancamentoExternoItem` (`:68`), com o comentário *"sem ele a tela chutaria um dos dois"*. A lista
   escolhe entre "Semana fechada" e "Sem permissão" por ele (`lancamento-externo-lista-dialog.tsx:139`).
   **Herdado do PR #299**, que escreveu este teste e nunca o executou — por falta de disco.
3. **Locator ambíguo em strict mode, duas vezes.** `/Adiantamento liberado.*2/` casava o `<li>` da
   contagem **e** o `<ul>` dos nomes; trocar para `getByRole('listitem')` ainda casava dois, porque
   **os nomes também são `<li>`** (`:207`). O discriminador real, lido do componente: a contagem
   começa pelo rótulo (`{rótulo}: <span>{n}</span>`, `:199`), o nome o traz no fim (`{nome} — {rótulo}`).

**Por que o `tsc` não pegou nenhuma das duas primeiras**: são objetos literais dentro de
`json(200, …)` e um tipo inline no `state` do próprio spec — não há anotação de tipo que o compilador
possa conferir. **Um stub que omite campo obrigatório do contrato só o E2E pega.** O spec ficou 6
dias "tipado mas nunca executado", e isso escondeu 3 defeitos de teste.
