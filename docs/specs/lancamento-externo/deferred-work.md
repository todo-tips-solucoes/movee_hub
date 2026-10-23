# deferred-work — lancamento-externo (rodada 1 do `bmad-code-review`)

Itens classificados **LOW** (ou dívida deliberada) que a rodada 1 **registrou e não corrigiu**. Cada um fica aqui com
arquivo:linha e o porquê de esperar, para não virar "esquecido" nem "feito".

> ⚠️ **Lacuna de proveniência (declarada, não escondida).** O agente que fez a correção da rodada 1 recebeu, na instrução,
> a **lista de IDs** e a descrição completa **só dos itens corrigidos** (A1–A4, W1, P3–P9, P15, P17, P19, P20, P24, P25,
> D3, P13) e de **P21**. Para **P10, P11, P12, P14, P26–P37, W2 e W3** o texto do achado (arquivo:linha, descrição) **não
> foi repassado** — o relatório do review não está no disco (`/tmp/review-lanc-externo/` tem só o `diff-bundle.txt`).
> Preenchido em 2026-10-23 pelo orquestrador pai, que tinha o relatório do review em contexto
> (o agente da rodada 1 não o tinha em disco — só o `diff-bundle.txt`). Severidades: a skill
> produz buckets (`decision_needed`/`patch`/`defer`/`dismiss`); a classificação de severidade foi
> das camadas, com rebaixamentos do revisor anotados onde houve divergência.
> inventar arquivo:linha aqui seria pior do que deixar o buraco visível.

## Destaque

### P21 — o E2E do hub não foi rodado nem estendido, e o stub cai em 404  — ✅ FECHADO na rodada 2 (onda-011)
> Estava aqui como bloqueio pré-merge e **sobreviveu à causa** (MEDIUM 6, rodada 3: alarme que não se atualiza custa credibilidade).
> Na rodada 2 o stub ganhou a rota de resumo e o E2E do hub foi rodado e estendido (**14 passed** nos gates da rodada 3).
> O texto original fica abaixo só como histórico; **não** é pendência.

- ~~**O quê**: nenhum spec Playwright do hub cobre o diálogo "Importar pagos por fora" nem a parcela na tela de repasse; o
  driver `hub-adiantamentos-e2e-browser.sh` **não foi rodado** nesta frente.~~
- ~~**Por que é mais que "falta de teste"**: o stub de rotas do E2E responde **404** para rota que não conhece.~~
- **Lição que permanece**: o E2E do hub exige rebuildar `hub-frontend:homolog` — sem isso o gate é oco.

## Demais itens

| ID | Onde | Descrição / porquê de ficar |
|---|---|---|
| P10 | `infra/hub/migrations/0117_lancamento_externo.sql:892` | **Polaridade invertida na função do app**: `IF NOT v_config.desconto_adiantamentos THEN v_externo_deducao := 0` usa a forma **negativa**, contra a positiva das outras três superfícies — e contra o `v_desconto` **19 linhas acima, na mesma função** (`:877`). Com config NULL as duas metades se comportariam ao contrário. **Ramo inalcançável** hoje: `desconto_adiantamentos` é `NOT NULL DEFAULT true` (`0066:69`), então só ocorre sem linha de config. Fica a forma frágil. *(camada: MEDIUM · revisor: LOW)* |
| P11 | `infra/hub/migrations/0117_lancamento_externo.sql:222` | O import **segura a trava do fechamento** (`pg_advisory_xact_lock`) por **todo** o lote, e o SQL **não** confere `jsonb_array_length(p_linhas)`. Um chamador direto do PostgREST não tem teto algum — a rota impõe o teto, o banco não. LOW. |
| P12 | `infra/hub/migrations/0117_lancamento_externo.sql:140` (GRANT) e `:131` (policy) | `GRANT SELECT ON "LancamentoExterno" TO authenticated` com policy **só de escopo** expõe `cnpj_prestador`, `valor` e `observacao` a qualquer autenticado com a empresa 6 no escopo — **sem** `pagamentos_consultar` — pelo PostgREST, que a própria migration diz ser público. E **não tem consumidor**: a entrega não tem listagem (FR-040) e o caminho quente é `SECURITY DEFINER`, que não passa por RLS. Correção devida: remover o GRANT órfão (menor privilégio). *(camada: HIGH · revisor: MEDIUM — é o padrão da casa: `ApuracaoRepasseItem` tem policy idêntica e **13 tabelas do hub** têm o mesmo GRANT; a exposição nova é só CNPJ+observação, não é regressão introduzida aqui — ver W3)* |
| P13 | `app_homologacao/backend/tests/lancamento-externo-unit.test.js`, `docs/.../contracts/import-lancamento-externo.md` | **CORRIGIDO na rodada 1** (não é deferido): os dois CNPJ de fixture com DV válido foram trocados por DV inválido (sufixos `-96` e `-92`). O repositório é público e o `gitleaks` não pega CNPJ. |
| P14 | `infra/hub/migrations/0117_lancamento_externo.sql:163` | `GRANT EXECUTE` em `hub_apuracao_semana_de` a `authenticated` **sem necessidade**: a função só é chamada de dentro de uma `SECURITY DEFINER`. O grant publica `/rpc/hub_apuracao_semana_de` sem consumidor. LOW. |
| P26 | `infra/hub/migrations/0117_lancamento_externo.sql:26`, `backend/lib/lancamento-externo.js:27`, `frontend_v2/lib/hub/lancamento-externo.ts:12` | O comentário "tipo novo = um INSERT, sem DDL e sem redesenho" é **contrariado pelo código da própria entrega**: `TIPOS` está hardcoded no backend (a rota recusa com `TIPO_INVALIDO`) e no frontend. Um terceiro tipo inserido na lookup é **inalcançável ponta a ponta**. LOW–MED. |
| P27 | `docs/.../contracts/import-lancamento-externo.md` §2, `docs/plans/lancamento-externo/RUNBOOK.md:44` | Drift de documento: o contrato lista `situacao` **sem** `DATA_FORA_DA_FAIXA`/`VALOR_INVALIDO`/`VALOR_ACIMA_DO_TETO`/`OBSERVACAO_MUITO_LONGA`, que a RPC devolve (`0117:237-258`); e o RUNBOOK diz "**três** funções vivas" onde o §2 do mesmo arquivo diz **cinco**. LOW. |
| P28 | `frontend_v2/components/hub/lancamento-externo-aviso.tsx:39` + `0117:347` | O aviso julga semana **já congelada** pela flag **viva** (`hub_adiantamento_config_vigente` sempre lê a vigente, nunca a `configuracao_id` congelada). Desligar a flag depois de fechar faz a semana fechada exibir "NÃO serão descontados" — afirmação **falsa** sobre um retrato imutável. LOW. |
| P29 | `frontend_v2/components/hub/adiantamento-fechar-apuracao-dialog.tsx:100` | `AvisoLancamentoExterno` com `periodo` vazio renderiza `null` — nem aviso nem alerta de falha. A página protege com `{h.periodo && …}`; o **diálogo de fechamento não**, exatamente no momento em que a spec exige o aviso. LOW. |
| P30 | `frontend_v2/app/hub/dashboard/adiantamentos/repasse/page.tsx:151` e `:220` | O botão "Importar pagos por fora" é oferecido em semanas **já fechadas** (gate só de permissão). Importar lá é **seguro** (toda linha volta `SEMANA_JA_FECHADA`); é usabilidade. LOW. |
| P31 | `frontend_v2/components/hub/lancamento-externo-dialog.tsx` | O arquivo **não** é limpo após sucesso: o 2º clique reposta o mesmo arquivo e o painel que dizia "3 aplicada(s)" passa a "0 aplicada(s) · 3 recusada(s) — Já lançado antes". A `UNIQUE` impede dinheiro em dobro, mas o operador lê como fracasso. LOW. |
| P32 | `backend/routes/hub-adiantamentos.js:1693` | Totais do resumo trafegam como **float** (`Number(r.total_deducao || 0)`) contra a convenção de string do módulo — e é o número que o operador usa para decidir se fecha a semana. LOW. |
| P33 | `frontend_v2/lib/hub/lancamento-externo.ts`, `frontend_motorista/lib/adiantamento-api.ts` | `lancamentosExternos` tipado `string` **não-nulo** nos dois clientes, mas a rota pode emitir `null` (o retorno de não-visível devolve `NULL::numeric`). O repo tem a cicatriz exata disto: "o TIPO mentia e escondeu o defeito do `tsc`". LOW. |
| P34 | `backend/lib/lancamento-externo.js`, `backend/lib/xlsx-import-core.js`, `0117` | **Código morto**: `qtdCredito`/`totalCredito` atravessam SQL→rota→interface TS e **nunca são renderizados**; `MAX_LINHAS`, `TETO_CENTAVOS`, `MENSAGENS`, `conferirTetoZip`, `MAX_BYTES_DESCOMPRIMIDOS`, `MAX_ENTRADAS_ZIP` são exportados sem importador. LOW. |
| P35 | `backend/lib/lancamento-externo.js`, `0117`, `frontend_v2/lib/hub/lancamento-externo.ts` | O teto de R$ 5.000 tem **quatro fontes de verdade** (`TETO_CENTAVOS`, `TETO_TEXTO` **não derivado**, `> 5000.00` no SQL, string no frontend) e o único teste compara mensagem com mensagem — mudar o teto deixa as outras três em R$ 5.000 **com a suíte verde**. LOW. |
| P36 | `backend/lib/lancamento-externo.js:61` e `:122` | `maisUmDia`/`hojeSaoPaulo` não validam o formato do locale: saída não-ISO ⇒ `"NaN-NaN-NaN"`, e como `'N' > '2'` o **teto superior de data desaparece** no leitor (o SQL ainda recusa, então o dano fica contido). O default de aritmética de data quebrada deveria ser **recusar**. LOW. |
| P37 | `backend/lib/lancamento-externo.js:61`, `:122` vs `0117:236` | Fuso **fixo** `'America/Sao_Paulo'` no JS contra `v_config.timezone` no SQL. LOW. |
| W2 | `0098` (pré-existente) | ✅ **RESOLVIDO na rodada 3 (ALTO 2, FR-055)** para o que esta feature controla: a linha que excede o líquido é recusada. O comportamento da 0098 segue (não é desta frente). *Texto original:* **Remanescente negativo não transporta**: a regra da 0098 preserva o saldo anterior sem reduzi-lo, então uma dedução maior que a produção da semana **não** gera dívida a cobrar. É o substrato de **D1** (decisão de negócio em aberto: recusar a linha, transportar o negativo, ou aceitar a perda). Não foi introduzido por esta frente. |
| W3 | 13 tabelas do hub (padrão repo-wide) | `GRANT SELECT … TO authenticated` com RLS **só de escopo** é o padrão do repositório, não um desvio desta entrega — `ApuracaoRepasseItem` tem policy idêntica. É o substrato de **P12**. Tratar exigiria uma frente própria de menor privilégio no hub inteiro. |

## Verificação pendente que NÃO é achado, mas vale registrar

- `hub-lancamento-externo-perf.sh`/`rollback.sh` foram re-rodados após a W1; a prévia agora soma `PAGA + EXPORTADA` num
  `FILTER` já existente (sem novo acesso a tabela), mas o número de buffers da CTE `adiant` deve ser lido de novo no perf.


## Rodada 2 (onda-011) - registrado, NAO corrigido

| ID | Onde | Descrição / porquê de ficar |
|---|---|---|
| R2-1 | `infra/hub/testes/hub-repasse-lote-segundo-lote.sh` | **Arquivo de outra sessão — risco relatado ao operador.** O revisor achou: `DELETE FROM "RepasseLote" … criado_por = 328 AND criado_em > now() - interval '1 hour'` **sem restrição à faixa de teste**; `SET session_replication_role = replica` (desliga o trigger de imutabilidade da apuração); aponta para `hub_homolog` **sem preflight**; e um comentário de RBAC que a 0115 tornou falso. **Não tocado** (`tasks.md:243` declara que é de outra sessão). |
| R2-2 | `lib/lancamento-externo.js` (H4) | ✅ **RESOLVIDO na rodada 3 (FR-056/FR-057):** com a semana aberta, "Ver pagos por fora" → Excluir → reenviar a soma. Semana fechada segue sem caminho (por desenho). *Texto original:* A remediação "some os dois pagamentos numa linha e reenvie" só vale **ANTES** do primeiro envio: o lançamento aplicado é imutável (append-only, FR-028), então reenviar a soma depois volta `VALOR_DIVERGENTE`. As mensagens dizem isso. Para corrigir um lançamento já aplicado **não há caminho** nesta entrega (sem tela de edição, FR-040) — decisão de produto em aberto se isso passar a acontecer. |
| R2-3 | `routes/hub-adiantamentos.js` (movimentos) / `adiantamento-geracao-movimento.js` (H1) | "Gerar notas" continua recusando o crédito externo puro com `VALOR_ZERO` ("Base da nota é zero — nada a emitir."). É verdadeiro, mas não diz que o valor segue pelo lote. Um motivo próprio exigiria mexer na lista de tokens de `frontend_v2/lib/hub/adiantamento-recusas.ts`. LOW. |


## Rodada 3 (onda-012) — registrado, NÃO corrigido

> Corrigidos na rodada 3: ALTO 1 (FR-054b), ALTO 2 (FR-055), exclusão + listagem (FR-056/FR-057), MEDIUM 2, 3, 4, 5, 6, 7, 8, 9.
> Abaixo, o que **ficou**: cada item com o porquê.

| ID | Onde | Descrição / porquê de ficar |
|---|---|---|
| R3-M1 | `0117` `hub_repasse_lote_avaliar` (`JA_PAGO_CONCILIADO` antes da exceção) | Semana **conciliada** pela UneCont **com** crédito externo volta `apta=false` para um `valor_pago` que inclui crédito nunca pago. **Não alterado de propósito:** liberar pagaria de novo a produção já paga (dupla); pagar **só o crédito** exige pagamento parcial, que o lote não tem. Documentado em FR-054b. Tratar fora do lote (pagar o crédito por fora e lançar como "Já foi pago"). |
| R3-ESPELHO | `0117` `hub_repasse_lote_avaliar` (MEDIUM, mesma raiz do ALTO 1) | Item de **puro saldo transportado** (sem crédito, sem produção) fica `NOTA_PENDENTE` para sempre e o motorista não tem nota a emitir. Só alcançável se alguém **reduzir** `repasse_valor_minimo` depois da retenção. **É comportamento da `0112`, não regressão desta feature**; corrigir exige decidir QUAL nota cobre um saldo de semana anterior (decisão de negócio). Registrado, não corrigido. |
| R3-L1 | `lib/lancamento-externo.js` / frontend `DUPLICADA_NO_ARQUIVO` | A mensagem afirma "só a primeira foi aplicada", mas a primeira pode não ter sido (recusada por outro motivo). LOW. |
| R3-L2 | `lib/lancamento-externo.js` `interpretarLinhas` | `idx` calculado e descartado. LOW. |
| R3-L3 | JS × SQL (FR-029) | Paridade de regras JS×SQL **sem guarda cruzada** (só o cruzamento de TOKENS foi feito na rodada 3, para MENSAGENS). LOW. |
| R3-L4 | JS e SQL | CNPJ com lixo em volta é aceito (só dígitos são mantidos) e **nenhuma ponta valida o DV**. Decisão antiga (FR-005), não regressão. LOW. |
| R3-L5 | testes | 2 testes ocos: o guard `!==` vs `<` e o cabeçalho da seção 8 negando o W1. LOW. |
| R3-L6 | `lib/lancamento-externo.js` | Fuso `America/Sao_Paulo` **fixo** no JS contra `v_config.timezone` no SQL (já era P37). LOW. |
| R3-U1 | `0117` `hub_adiantamento_config_vigente` | **UNPROVEN**: `timezone` NULL na config. Hoje `NOT NULL`; sem prova de que nenhum caminho o anula. |
| R3-U2 | `0117` `aplicar` | **UNPROVEN**: `U+0000` em `obs` (o Postgres recusa `\u0000` em `text`; o efeito no lote não foi medido). |
| R3-U3 | `lib/lancamento-externo.js` | **UNPROVEN**: valor em notação científica (`1e3`) vindo de célula texto. |
| R3-N1 | `0117` `excluir`/`aplicar` | A exclusão e a importação serializam pela **mesma** trava do fechamento: uma importação de 10.000 linhas segura a trava (já era P11) e agora também bloqueia exclusões e fechamentos pelo mesmo tempo. Medido em `hub-lancamento-externo-perf.sh` (critério 4). |
| R3-N2 | frontend | A listagem pagina de 50 em 50 e **não ordena por coluna**. Suficiente para corrigir um erro pontual; se a conferência em massa virar uso, é frente própria. |


## Rodada 4 (onda-013) — corrigido e registrado

> Corrigidos: A1, A2 (com a decisão abaixo), A3, A4, M1, M2, M3, M5, M6, M7, M8, M10, M13, M14 (ver nota) e M11 (parte).

| ID | Decisão / o que NÃO foi feito |
|---|---|
| R4-A2 | **Decisão de desenho do operador (2026-10-23): o fechamento NÃO recusa.** Fechar é irreversível e o operador precisa fechar na segunda; recusar travaria a operação. Feito: o resumo conta quem fecha negativo AGORA (`qtd_negativo`/`total_negativo`), o diálogo de fechar mostra os dois números e **exige confirmação explícita** (checkbox), e o aviso de negativo **não depende da flag** (antes sumia justamente quando a flag ligava). **NÃO feito, de propósito:** (a) revalidar no `fechar` e **recusar** — rejeitado pela decisão acima; (b) gravar a confirmação no servidor (a exigência é de tela: um cliente que chame `POST …/fechar` direto não passa por ela); (c) cobrir negativo de motorista SEM lançamento por fora (negativo pré-existente de débito/adiantamento, comportamento anterior à feature). |
| R4-A3A4 | O leitor compartilhado (`xlsx-import-core.js`) agora recusa área usada > 1.000.000 de células **antes** do `sheet_to_json` e reescreve `!ref` para a área real. Isso cura a dimensão sub-declarada **só quando declarada inflada** (as linhas reais são lidas, não recortadas) — **correção da rodada 5b: a afirmação original era falsa para dimensão declarada DENTRO do teto** (ver R5b-A2) e limita o pior caso a ~0,6 s. **NÃO feito:** varredura de XML por contagem de `<row>` (descartada — a reescrita do `!ref` resolve A4 sem reabrir a planilha). Limite remanescente: a releitura sem `sheetRows` só ocorre com ≤ 2 MiB descomprimidos. |
| R4-M11 | Interpretação: o `patch_fn` do driver reescreve funções num stack **efêmero** (`hub-test-*`, destruído pelo `trap`), e o rollback roda DROP+reaplicação numa transação única. Não há como o driver deixar função reescrita no `hub_homolog`. Feito: `patch_fn` e o controle `excluir-liquido` abortam se a expressão do `sed`/`perl` **não casa** (controle negativo oco). A asserção de paginação deixou de ser igualdade. **Se o revisor se referia a outro driver, o ponto segue ABERTO.** |
| R4-M14 | `hub_homolog` tinha a 0117 registrada com corpo de rodada anterior. Reaplicada após remover o registro (nota no relatório da onda). A prova é pelo corpo (`pg_get_functiondef`), não pelo exit code. |


## Rodada 5 (onda-014) — o operador decidiu ENCOLHER a superfície; o que NÃO foi feito

> Corrigidos: C1 (Transfeera volta a se comportar como o HEAD, `areaReal` desligado por padrão), C2 (colunas travadas), C3 (guarda de exclusão), C4 (confirmação fail-closed), `semanaFechada` obrigatório, `limitarArea` uma vez só, truncamento de `excedentes` marcado, `lerValor`, `set -e` nos drivers de perf e rollback.

| ID | Decisão / o que NÃO foi feito |
|---|---|
| R5-FECHAR | **A rota `POST …/fechar` continua SEM validação no servidor** do negativo/confirmação (decisão do operador; a exigência é de **tela**, como já registrado em R4-A2.b). Quem chamar a API direto não passa pela caixa. |
| R5-COLUNAS | **O alargamento de COLUNAS da área foi abandonado de propósito.** Só as LINHAS seguem a área real (isso é o que mata o A4); as colunas ficam travadas na largura do cabeçalho esperado + 1 sentinela (que ainda faz uma coluna a mais com texto no cabeçalho ser recusada). Consequência aceita: texto em coluna **além da sentinela** no lançamento externo é ignorado, não recusado. |
| R5-TRANSFEERA | **A correção herdada da `<dimension>` subdeclarada NÃO vale para a Transfeera** (retorno em produção desde 30/09). O leitor dela se comporta byte a byte como o HEAD: `<dimension>` inflada recusa, subdeclarada lê só a declarada, célula solta fora da dimensão é ignorada. Só o lançamento externo (`areaReal: true`) lê a área real. **Dívida registrada:** o retorno da Transfeera continua com o defeito A4 original (planilha com `<dimension>` menor que o real importa parcialmente calada). Corrigir é decisão separada, com prova de equivalência própria. |
| R5-DEDUCAO-APP | A guarda de exclusão (C3) deixou de olhar dedução do **app** e débito de faturamento: um crédito sustentado só por elas pode ser excluído e o líquido fica negativo (aparece no resumo/diálogo de fechar, H9). **NÃO feito:** recusar com outra mensagem, ou permitir apagar dedução do app pela tela. |
| R5-FALSOS-POSITIVOS | Medidos pelo operador e **não tratados**: o teto de ZIP é enganável como número, mas o SheetJS recusa o arquivo adulterado; 200×16.384 células geram ZIP de 104,5 MiB, recusado pelo teto em 0 ms. |
| R5-INTEGRATION-E | O driver `hub-lancamento-externo-integration.sh` segue com `set -uo pipefail` **sem `-e`** (só perf e rollback foram corrigidos): não foi tocado nesta rodada (conta PASS/FAIL em `check`; mudar o modo de falha dele exigiria revisar linha a linha). |


## Rodada 5b (onda-016) — o que a entrega afirmava e não fechava

| ID | Decisão / o que NÃO foi feito |
|---|---|
| R5b-A1 | **Corrigido no contador, não na guarda.** O HINT da guarda de exclusão descrevia a sequência "apague a dedução, depois o crédito", que remove a própria condição da guarda e deixava o líquido em -99,00 com ZERO lançamento externo na semana — e o contador do aviso (`qtd_negativo`) varria só `LancamentoExterno`, então o motorista saía do aviso. Agora o contador também varre `LancamentoExternoExclusao` (quem TEVE lançamento na semana). A guarda de um passo e o HINT (reescrito para avisar do risco) seguem; o fechamento continua só **informando**, nunca recusando. O driver `hub-lancamento-externo-integration.sh` tinha uma limpeza (motorista 17) justificada por uma crença falsa; virou check, e há cenário novo (motorista 18) de 3 etapas, com controle negativo `LE_NEG=contador-5b`. |
| R5b-A2 | **Corrigido para planilha de até 2 MiB de XML:** o modo `areaReal` agora relê SEM corte sempre (não só com dimensão inflada), então a `<dimension>` declarada dentro do teto não esconde mais linhas. **Resíduo NÃO fechado:** acima de 2 MiB de XML descomprimido a releitura é proibida (custo); vale o corte do primeiro `ler(maxLinhas + 2)` e a rede passou a ser sobre a **última linha física lida** (> `maxLinhas + 1` recusa). Um arquivo acima de 2 MiB, com dimensão subdeclarada e dados **dos dois lados** do ponto de corte, ainda tem o excedente descartado em silêncio.

**MEDIDO em 2026-10-23 (não é arquivo hostil — é planilha comum):** 12.501 linhas físicas, **10.500 lançamentos** com observação de 45 caracteres e um bloco de linhas em branco no meio (o que o Excel deixa quando alguém apaga linhas), `<dimension>` declarada `A1:E2` → **ACEITA 9.999 e DESCARTA 501**, respondendo sucesso. Os dois controles recusam corretamente: dimensão honesta → `ARQUIVO_MUITO_GRANDE`; sem a tag → `ARQUIVO_MUITO_GRANDE`. Com observação de 10 KB o mesmo efeito aparece com só 200 lançamentos (aceita 99, descarta 101).

**Por que foi deferido e não corrigido:** fechar exige mexer no teto de 2 MiB da releitura, que é a defesa de DoS medida na rodada 4 (o ataque original custava >90 s de CPU com o backend inteiro parado). A 3 dias do fechamento da apuração, trocar um descarte que exige **mais de 10.002 linhas físicas** — contra um uso real de dezenas a centenas de lançamentos manuais por semana — por um risco de disponibilidade não se justifica. **Gatilho para reabrir:** se esta feature passar a receber planilhas com mais de ~10 mil linhas (o `tipo` é genérico por desenho, então isso é previsível), este resíduo vira bloqueante e o teto de 2 MiB tem de ser repensado junto com a defesa de DoS, não isolado. Caminho legado (Transfeera, `areaReal` desligado) **intocado** — mesma dívida de R5-TRANSFEERA. |
| R5b-SENTINELA | **NÃO consertado:** `limitarArea` trava as colunas em `cabecalhoEsperado.length + 1`. Coluna titulada **colada** ao cabeçalho vira a sentinela e recusa; com **um gap vazio** antes dela (ex.: "Valor real" na coluna G) fica além da sentinela e é ignorada sem aviso. Não é perda de dinheiro (a coluna não é lida), mas o operador pode achar que foi. |
| R5b-FAILCLOSED | `qtdNegativo`/`totalNegativo` da rota de resumo agora são `null` quando o campo falta (antes: `0` fabricado, que tornava inalcançável o ramo "desconhecido" do diálogo). Texto "Mostrando 0 de N" só aparece com a lista presente. |
