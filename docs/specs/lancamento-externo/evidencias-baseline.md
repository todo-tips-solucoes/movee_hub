# Baseline de não-regressão (medida em 2026-10-22, ANTES da extração) — sem PII

| Suíte (`node --test tests/<arq>.test.js`) | tests | pass | fail |
|---|---|---|---|
| adiantamento-retorno-transfeera-unit | 86 | 86 | 0 |
| adiantamento-retorno-transfeera-arquivo-real | 5 | 5 | 0 |
| adiantamento-transfeera-xlsx-unit | 20 | 20 | 0 |
| hub-adiantamentos-rotas-unit | 157 | 157 | 0 |
| `npm test` completo | 2030 | 2030 | 0 (396 suítes) |

DEPOIS da extração (2.3.1): as 4 linhas e o total idênticos (diff vazio).

Controles negativos da extração (2.3.3), reversão conferida por `cmp` antes de remedir:
- `bookProps:false -> true` no núcleo: unit 38 fail (79 tests), arquivo-real 4 fail, rotas-unit 8 fail
  (xlsx-unit segue 20/0).
- teto de linhas desligado (`if (false)`): falha `10.005 linhas de dados -> ARQUIVO_MUITO_GRANDE`.
- `instanceof RetornoTransfeeraParseError` + `motivo` são asseridos por `erroParse` no unit (:117).

tsc/vitest/lint: baselines dadas pelo operador (vitest 941/0; lint 28 = 5 erros + 23 avisos); medidas
na 6.2.4 com o comando exato (`npx tsc --noEmit`, `npx vitest run`, `npm run lint`).

## Evidências da onda-006 (2026-10-22/23)

- Backend `npm test`: **2071 pass / 0 fail** (410 suítes; baseline 2030/396). Novos: lancamento-externo-unit 21,
  lancamento-externo-xlsx-nativo 9, hub-lancamento-externo-integration 11 — os 3 em `package.json:8`
  (contagem de arquivos `tests/…test.js` na lista 155 -> 158). `package-lock.json` sem diff.
- Frontend: `tsc --noEmit` limpo; `vitest` **948/0** (baseline 941; +7); `next build` EXIT 0; lint **28 (5 erros, 23 avisos)** = baseline.
- Driver existente `hub-adiantamentos-integration.sh` (com a 0117 nova aplicada do zero): **231 PASS / 0 FAIL**.
- Driver novo `hub-lancamento-externo-integration.sh`: **26 PASS / 0 FAIL**.
- md5 `pg_get_functiondef` no hub_homolog, antes -> depois da reaplicação da 0117 (migrate.sh, `aplicadas agora`=1; 2ª corrida 0):
  resumo 1a3194cc… -> d4a8b959… (gate `pagamentos_consultar`, sem `pagamento_confirmar`); aplicar cae12d0a… (inalterada,
  segue `pagamento_confirmar`); previa d91c4fd3… -> 2f534017…; fechar ee6947e4… -> a29e2499… (ambas com `externos_cte`).
  O registro `0117%` já estava ausente de `"SchemaMigration"` (DELETE 0); backup em `~/le-backup-4.3.1.sql` (fora do git).
- Controles negativos (nomes dos testes que falharam):
  - 2.3.3 bookProps:true no núcleo: unit 38, arquivo-real 4, rotas-unit 8; teto de linhas off: `10.005 linhas de dados -> ARQUIVO_MUITO_GRANDE`.
  - 3.1.4 gate de meio centavo (`> 0.5`): `FR-047: 1234.565 e "100,005" -> VALOR_FRACAO_DE_CENTAVO` (unit) e `valor numérico nativo: 30.5 … fração de centavo recusa` (nativo).
  - 4.1.4 `LE_NEG=escopo-1` (sem `IF NOT (6 = ANY…)`): FAIL `C15`; `LE_NEG=escopo-2` (sem `e.id_empresa = 6`): FAIL `C15.b` (0:APLICADA — o furo cross-tenant), `C15.b nada gravado`, `resumo (a)`, `resumo (c) nada gravado`, `C3.c`.
  - 4.2.2 gate antigo (`pagamento_confirmar`): FAIL só `resumo (a)` (e C9/FR-049); (b) e (c) passam.
  - 4.4.3 `LE_NEG=cte-off`: FAIL `C2 previa`, `C1 fechamento`, `C1 repasse de A (obtido 100.00)`, `C7`, `C9`.
  - 6.2.3 aviso engolindo erro: FAIL `CHK008: falha na consulta NÃO é engolida — vira alerta`.
- Achado que mudou o produto: a 0117 NÃO continha o termo externo nas funções vivas (prévia 0100:26 e fechar 0098:111); a seção 8
  da 0117 agora redefine ambas (CREATE OR REPLACE, assinaturas inalteradas) e o fechar grava `lancamentos_externos`.
- Desvio declarado: os cenários C15/C15.b/resumo/C1.. vivem num driver NOVO (stack efêmero próprio), não dentro do
  `hub-adiantamentos-integration.sh`, porque C1 exige zero `ApuracaoRepasse` e o driver antigo já fecha apurações.

## Procedência da baseline do frontend (tarefa 1.1.4) — leia antes de confiar nos números

Na onda-006 o "antes" de `vitest` (941/0) e do lint (28 = 5 erros + 23 avisos) foi o **informado pelo operador**; o
agente só mediu o "depois". Isso foi declarado, mas deixava a baseline sem medição própria. **Na onda-007 o
agente mediu a baseline de fato**, em worktree destacado (`git worktree add --detach … HEAD`, commit `9f50c08`,
sem nenhuma mudança desta frente; `node_modules` por symlink; worktree removido depois):

| Comando (em `app_homologacao/frontend_v2`) | Baseline medida em `9f50c08` |
|---|---|
| `npx tsc --noEmit` | exit 0 (limpo) |
| `npx vitest run` | **941 passed (98 arquivos) / 0 failed** |
| `npm run lint` | **28 problemas (5 erros, 23 avisos)** |

Coincide com o que o operador informou. A baseline do **backend** (2030 pass / 396 suítes) e a dos 4 arquivos
de não-regressão foram medidas pelo agente antes da extração (tabela no topo deste arquivo).

## Evidências da onda-007 (2026-10-23) — achados da revisão independente e fechamento

A revisão independente do diff (tarefa 7.2.4, subagente read-only) achou **dois HIGH e quatro MEDIUM**. Todos
foram verificados contra o código antes de agir:

| # | Sev | Achado | Desfecho |
|---|---|---|---|
| 1 | HIGH | **A 0117 só redefinia 2 das 3 funções vivas.** `hub_adiantamento_repasse_motorista()` (`0098:515`, lida pelo APP do motorista) — que a própria FR-022 nomeia — ficou de fora: o motorista veria um remanescente e receberia outro. **Mesmo defeito da frente toda ("feature escrita, caminho não ligado"), reaparecendo dentro da própria correção.** | **CORRIGIDO**: seção 8.3 da 0117; cenário `C16` no driver; controle negativo `LE_NEG=app-off` (2 FAIL); rollback cobre as 3 funções |
| 2 | HIGH | `C7` do driver dizia "R$4+R$3=R$7 recebe" mas semeava 4−10+3=−3: **nunca tocava o piso**. FR-018/FR-019 sem cobertura real | **CORRIGIDO**: `C7` (7,00 recebe), `C7.b` (5,00 retido, transportado), `FR-019` com dedução (20−15), em prévia **e** fechamento, com a conservação assertada; `LE_NEG=cte-off` agora reprova 12 asserções |
| 3 | MED | O comentário da 0117 dizia que data/teto eram validados "na função de aplicação"; **não eram**. A RPC é chamável direto pelo PostgREST | **CORRIGIDO**: recusa de LINHA no banco (`DATA_FORA_DA_FAIXA`, `VALOR_INVALIDO`, `VALOR_ACIMA_DO_TETO`, `OBSERVACAO_MUITO_LONGA`); `C10/SQL`; `LE_NEG=faixa-sql` |
| 4 | MED | Aviso FR-049 da aba Repasse ficava velho depois do import | **CORRIGIDO**: prop `versao`; teste + controle negativo (sem a dependência, o teste falha) |
| 5 | MED | Prévia/CSV/app não mostram o externo como parcela (créditos − adiantamentos − débitos ≠ remanescente na tela) | **NÃO é defeito de cálculo; decisão de produto** (FR-040 — **histórico, já emendado**: proibia tela/listagem nova, hoje autorizadas; coluna nova exige `DROP`+`CREATE`). Entregue ao operador como **H5** no RUNBOOK §0 — não aceito como risco |
| 6 | MED | A divisão nota/fora-da-nota do saldo transportado não inclui o termo externo | **Verificado: herdado do desenho vigente** — `transportado_nota/fora` partem só dos créditos e já ignoram o adiantamento do app e o débito. Não é regressão desta frente. Também em H5 |
| 7 | LOW | Rótulo de `C3` afirmava `JA_APLICADO` e assertava `SEMANA_JA_FECHADA` | **CORRIGIDO**: rótulo `C3.c-bis` honesto; comportamento documentado no quickstart |
| 8 | LOW | Dia de início mudado depois do fechamento deixava uma linha entrar em semana congelada | **CORRIGIDO**: checagem por contenção em `[periodo_inicio, periodo_fim]`; `C17`; `LE_NEG=contencao` |
| 9 | LOW | `retornoRateLimiter` compartilhado com o retorno da Transfeera | **CORRIGIDO**: `lancamentoExternoRateLimiter` próprio |

Controles negativos novos (nomes das asserções que falharam):
- `LE_NEG=app-off`: `C16: APP do motorista 01 … (obtido='50.00')` e `C16 … 02 … abaixo_do_minimo`.
- `LE_NEG=contencao`: `C17 … SEMANA_JA_FECHADA (obtido='0:APLICADA')` e `C17: nada gravado`.
- `LE_NEG=faixa-sql`: `C10/SQL: valor acima do teto (obtido='0:APLICADA')`, `C10/SQL: nenhuma das recusas gravou`, `C11: nada gravado`.
- `LE_NEG=cte-off`: `C2 previa`, `C1 fechamento`, `C1 repasse de A`, `C7/C7.b/FR-019 na PREVIA`, `C7.c`, `C7 (FECHAMENTO)`, `C7.b (FECHAMENTO)`, `FR-019 (FECHAMENTO)`, `C9`, `C8 previa`, `C8 fechamento`, `C16 02` (12 FAIL).
- `PERF_NEG=noindex` (perf): 8 critérios reprovados (Seq Scan ×5 runs, `Index Cond` vazio, 17,958 ms/3086 buffers e 21,103 ms/3151 buffers).
- Aviso velho (`versao`): sem `versao` nas dependências do hook, `depois de importar (versao nova) o aviso RECONSULTA` falha.

`hub_homolog` (exceção `hub-*`): 0117 revisada reaplicada (backup `~/le-backup-onda7.sql`, `LancamentoExterno` = 0 linhas antes e
depois). md5 `pg_get_functiondef` depois: motorista `1d002bb6…` (antes `40f59253…`), aplicar `fde797b8…` (antes `cae12d0a…`),
fechar `a29e2499…` e prévia `2f534017…` (inalteradas desde a onda-006); as quatro mencionam `LancamentoExterno`.

## Rodada 1 do `bmad-code-review` (2026-10-23) — correções, reconciliação de números e controles negativos

### P24 — reconciliação dos números de gate (qual valeu e qual foi superado)

| Fonte | Backend | vitest | Driver lançamento | Situação |
|---|---|---|---|---|
| onda-006 (acima) | 2071/0 | 948/0 | 26 PASS | **superado** |
| onda-007 (`tasks.md` 7.2.1) | 2071/0 | 952/0 | 52 PASS | **superado** |
| RUNBOOK (versão anterior) | 2073/0 | 953/0 | 64 PASS | **superado** (era o fechamento da FASE 9, antes desta rodada) |
| **ATUAL (esta rodada)** | **2083/0** (412 suítes) | **955/0** | **70 PASS** | **vale** |

`frontend_motorista` 126/0 · lint 28 (5/23) = baseline · `hub-adiantamentos-integration.sh` 231/0 ·
`hub-repasse-lote-integration.sh` 74/0 · rollback 31 PASS · perf APROVADO · `package-lock.json` sem diff.
A diferença 2073 -> 2083 são os testes novos da rodada: A1 (2: CSV unit + rota), A2 (2 + 1 do P17 adulterado), P4 (2), P5 (2), P6 (1).

### Correções e o teste que as prova (controle negativo: reversão **conferida no arquivo/na função** antes de medir)

| # | Correção | Controle negativo -> o que reprova |
|---|---|---|
| A1 | CSV de conferência ganha a coluna `Pago por fora (líquido)` (13ª, no fim) | tira a coluna do `serializarCsvRemanescente`: `cabeçalho + linhas…`, `0117 (A1): a coluna "Pago por fora (líquido)" leva o sinal…`, `F3 …`, `conferência: CNPJ, valor da nota…`; tira o campo do mapper da rota: `0117 (A1): GET /repasse/exportar leva lancamentos_externos…` |
| A2 | `padStart(14,'0')` quando a célula é numérica | volta ao `replace(/\D/g,'')`: `número 192 é recomposto para 00000000000192…` (fixture com raiz zero; a de antes era estruturalmente incapaz — sempre começava em 9) |
| A3 | RUNBOOK §3 ganha o 3º serviço + prova de bundle ASCII | (documento) string `Pago por fora` conferida no chunk do `next build` real e **ausente do HEAD** (controle negativo) |
| W1 | prévia soma `PAGA + EXPORTADA` | `LE_NEG=w1`: `C18b: motorista 01 - PREVIA == APP…` e `W1: PREVIA deduz a EXPORTADA…` (68 PASS / 2 FAIL) |
| P3 | recusa `SEMANA_ANTERIOR_A_APURACAO` | `LE_NEG=p3`: `P3: semana anterior…`, `P3: nada gravado…`, `C3.c…` (67/3) |
| P4 | `flagDescontoLigada: … === true` | volta a `!== false`: `P4: resposta sem a flag (undefined) falha FECHADO…` |
| P5 | enviadas × respondidas | desliga a comparação: `P5: resposta da RPC que não é array…`, `P5: RPC devolve MENOS linhas…` |
| P6 | auditoria pós-commit não vira 500 | faz o `catch` relançar: `P6: falha da AUDITORIA depois da RPC commitada…` (1 FAIL, 15/1) |
| P7 | `abrir()` zera o `tipo` | tira o reset: `P7: o tipo NÃO é grudento…` |
| P8 | cast de data/valor com handler por linha | `LE_NEG=p8`: `P8: data/valor ilegiveis…` (`ERROR: date/time field value out of range`) (69/1) |
| P9 | gate de escopo no resumo | `LE_NEG=escopo-resumo`: `P9: resumo com escopo SEM a empresa 6…` (69/1) |
| P15 | 3 suítes em `test:hub:unit` | `test:hub:unit` 1374/0 passa a incluí-las |
| P17 | teste com arquivo REAL sem `<workbookPr>` | **achado não reproduzido**: o SheetJS devolve `date1904:false` mesmo sem o atributo — o ramo `null` é inalcançável por arquivo real; o teste prende a medição (reprova se o default mudar). Sem alteração em `xlsx-import-core.js` |
| P19 | asserção vazia `[403,500]` -> `403` | (asserção estreitada) |
| P20 | seed do C9 com `|| fail` | (guarda de erro de seed) |
| P25 | ACL conferida também na IDA | `RB_NEG=ida-sem-grant`: `pos-0117: ACL de hub_adiantamento_repasse(…) IGUAL a de antes…` (1 FAIL) |

### A4 — controles negativos da FASE 9 (SC-011: nomeados, medidos de novo nesta rodada)

- `LE_NEG=col-previa` (8 FAIL): `C18a motorista 03 – PREVIA ja fecha a conta`, `C18a 03 – FECHAMENTO == previa`, `C18a 03 – CONGELADO == previa`, `C18a 03 – APP (ultimo fechado) == previa`, `C18b motorista 01/02 – PREVIA == APP`, `C18b 01/02 – lancamentos_externos = -15,00 nas duas superficies`.
- `LE_NEG=col-congelado` (1 FAIL): `C18a: motorista 03 - CONGELADO (hub, semana fechada) == previa`.
- `LE_NEG=col-app-fechado` (1 FAIL): `C18a: motorista 03 - APP (ultimo fechado) == previa`.
- `LE_NEG=col-app-corrente` (4 FAIL): `C18b motorista 01/02 – PREVIA == APP` e `C18b 01/02 – lancamentos_externos = -15,00`.
- `RB_NEG=sem-drop` (6 FAIL): as 4 reaplicações sem `DROP` são **recusadas** (`cannot change return type`); reprovam `volta ao corpo anterior (md5)` das 4, `nenhuma das cinco menciona LancamentoExterno` e `nenhuma das quatro devolve a coluna`.
- `RB_NEG=sem-grant` (5 FAIL): `volta a ACL anterior` das 4 e `EXECUTE de authenticated preservado (as cinco)`.
- `RB_NEG=ida-sem-grant` (novo, P25) e `PERF_NEG=noindex` (já nomeado acima).

### W1 — o app continua coerente (prova)

O app (`0117`, seção 8.3) já deduzia `PAGA + EXPORTADA`; a prévia agora também. `C18b` deixou de provar a **ausência** do caso: a
fixture tem uma solicitação `EXPORTADA` (R$ 5,00) do motorista 01 na semana em curso e a prévia e o app dão **30,00** nas duas
superfícies (`W1: APP do motorista 01 == 30,00`). O fechamento não mudou (já deduzia as duas).

## Rodada 2 do `bmad-code-review` (2026-10-23, onda-011) — números e controles negativos

| Gate | Resultado |
|---|---|
| backend `npm test` | **2088 / 0** (era 2083) |
| `test:hub:unit` | **1379 / 0** (era 1374) |
| `tsc --noEmit` frontend_v2 / frontend_motorista | exit 0 / exit 0 |
| `vitest` frontend_v2 | **964 / 0** (era 955) |
| frontend_motorista (`npm test`, node:test) | **126 / 0** |
| lint frontend_v2 | **28 (5/23)** = baseline |
| `next build` | feito DENTRO do E2E (`npm run build` no container Playwright), verde |
| `hub-adiantamentos-integration.sh` | **231 / 0** |
| `hub-lancamento-externo-integration.sh` | **72 / 0** (era 70; +2 cenários H5) |
| `hub-repasse-lote-integration.sh` | **83 / 0** (era 74; +9 cenários H1) |
| `hub-repasse-saldo-minimo-roundtrip-integration.sh` (H2) | **ANTES 51 PASS / 6 FAIL** (os 6 do cabeçalho de 12 colunas e das caudas) → **DEPOIS 57 PASS / 0 FAIL** (as mesmas 6 asserções agora verdes) |
| `hub-lancamento-externo-perf.sh` | APROVADO (zero Seq Scan em LancamentoExterno) |
| `hub-lancamento-externo-rollback.sh` | **35 PASS / 0 FAIL** (a 6ª função, `hub_repasse_lote_avaliar`, entra na prova) |
| E2E do hub (`hub-adiantamentos-e2e-browser.sh`) | **14 passed** (13 + 1 novo) |
| `package-lock.json` | sem diff |

Observação H6: o E2E **passava sem o stub** (13/13) — o `default` 404 não derrubava nenhum spec, então "gate vermelho"
não se reproduziu como falha. Por isso foi acrescentado um teste que **trava** o stub (resumo 200 e ausência do banner de
falha do aviso). Controle negativo: sem o stub, **só** esse teste falha (13 passed / 1 failed); com o stub, 14 passed.

Controles negativos (reversão conferida no arquivo antes de medir):

- **H1**: `previa_h1` com o corpo da 0112 (sed remove a exceção) → crédito puro `NOTA_PENDENTE`, `apta=false`; restaurado → `apta=true`, R$ 50,00. Mista R$ 10 + R$ 50: EnvioMassa de 10, lote de 60. `ADIANTAMENTO` externo sem nota → `NOTA_PENDENTE` (inalterado).
- **H5**: `LE_NEG=h5` (ordem antiga) → `C3.c-bis` e `C3.c-ter` falham (70 / 2); sem a variável, 72 / 0.
- **Escopo do resumo**: `LE_NEG=escopo-resumo` → o check P9 falha (flag da empresa 6 vaza como `true`).
- **CSV**: troca de `celulaNumero` por `celulaCsv` → 2 testes falham (193 / 2); restaurado 195 / 0.
- **MENSAGENS**: apagar 3 entradas → o teste novo falha (23 / 1); restaurado 24 / 0. **`formatarParcelaExterna`**: ramo zero → `''` → 6 testes falham.
- **CNPJ numérico**: gate antigo (`Number.isInteger` + `padStart`) → o teste do ramo numérico falha.
- Disco: 21,8 GB livres (`df`); o driver do E2E exige 21 GiB (20,93) e abortaria a 20,8 GiB — rodado por **cópia temporária com o limiar de 20 GiB** (regra do operador: >= 20 GB), cópia removida depois. Três imagens sem tag criadas hoje pelos drivers foram removidas (`docker rmi`, sem `-f`, sem `prune`).


## Rodada 3 do `bmad-code-review` (2026-10-23, onda-012) — números e controles negativos

| Gate | Resultado |
|---|---|
| backend `npm test` / `test:hub:unit` | **2104 / 0** (era 2088) · **1394 / 0** (era 1379) |
| `tsc --noEmit` frontend_v2 / frontend_motorista | exit 0 / exit 0 |
| `vitest` frontend_v2 | **970 / 0** (era 964) |
| frontend_motorista (`npm test`) | **126 / 0** |
| lint frontend_v2 | **28 (5/23)** = baseline |
| `hub-adiantamentos-integration.sh` | **231 / 0** |
| `hub-lancamento-externo-integration.sh` | **120 / 0** (era 72; +48: ALTO 2, listagem, exclusão, C11/exclusão) |
| `hub-repasse-lote-integration.sh` | **86 / 0** (era 83; +3: ALTO 1) |
| `hub-repasse-saldo-minimo-roundtrip-integration.sh` | **57 / 0** |
| `hub-lancamento-externo-perf.sh` | APROVADO; líquido **0,112–0,185 ms/chamada** (~1,4 s para 10.000 linhas); critério 4 novo (limite 1 ms) |
| `hub-lancamento-externo-rollback.sh` | **37 PASS / 0 FAIL** (era 35) |
| E2E do hub | **14 passed + 1 flaky** (15 testes; o flaky é o US5 "reprocessar", preexistente e alheio) — rodado por cópia temporária do driver com o limiar de **20 GiB** (o driver pede 21 GiB e o host tinha 20,76 GiB; regra do operador: ≥ 20 GB), removida em seguida |
| `package-lock.json` | sem diff (o driver conferiu) |

Controles negativos (reversão conferida com `cmp` antes de medir):

- **ALTO 1**: `previa_h1` com o corpo da rodada 2 (perl remove `AND b.valor_pago <= b.lancamentos_externos`) → `true||5.01` (o furo); corpo corrigido → `false|NOTA_PENDENTE|5.01`. Antes do conserto, **nenhuma das 4 fixtures tinha `saldo_anterior`**: o driver ficava verde com e sem ele — a fixture nova é parte do conserto.
- **ALTO 2**: `LE_NEG=excesso` → **104 / 16**; prévia do motorista com crédito 30 e dedução 100 = **−70,00** (os 70 somem), SC-001 reprovada (`30,00 → 0,00` vira `−70,00`).
- **Exclusão**: `LE_NEG=excluir-fechada` → **111 / 9** (a linha da semana FECHADA é apagada e o congelado, −30,00, não tem mais origem); `excluir-sem-rastro` → **118 / 2**.
- **Paridade**: `LE_NEG=liquido-sem-exportada` → **119 / 1** (o líquido deixa de deduzir EXPORTADA e diverge da prévia).
- **MEDIUM 9**: `RB_NEG=escritor-vivo` → 1 FAIL (`aplicar`/`excluir` sobrevivem ao rollback).
- **MEDIUM 2/3/7** (unit): limite de releitura = 0 → 2 testes; `cabecalhoTolerante: false` → 1; remover `VALOR_EXCEDE_LIQUIDO` de `MOTIVO_LINHA` → 1.
- **Perf**: `PERF_NEG=noindex` → 9 critérios reprovam (inclusive o do líquido, 1,529 ms/chamada); `LIQ_MAX_MS=0.05` → só o critério 4.

Premissa corrigida (do orquestrador pai): `lancamento-externo-aviso.tsx:39` suprime com **`true`**; `false` **mostra** — o gate de escopo do resumo estava correto e fechado, nada a fazer.
