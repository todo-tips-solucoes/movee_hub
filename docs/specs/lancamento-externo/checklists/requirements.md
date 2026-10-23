# Checklist de Qualidade de Requisitos: lancamento-externo

**Purpose**: gate de release formal (não pré-commit leve) para a importação de
lançamento pago por fora que deduz/credita no repasse semanal. Caminho de
dinheiro, **irreversível** depois do fechamento — o checklist valida a qualidade
dos REQUISITOS, não a implementação.
**Created**: 2026-10-22 (onda-004, etapa `checklist`)
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) ·
[contrato](../contracts/import-lancamento-externo.md) ·
[RUNBOOK](../../../plans/lancamento-externo/RUNBOOK.md)

**Legenda**: `{auto}` = resolvível contra os artefatos, com evidência citada ·
`{humano}` = julgamento de risco/negócio, aguarda o dono do produto.
`[Gap]`/`[Conflict]`/`[Ambiguity]` = destino obrigatório na §Follow-up.

---

## A · Rótulos de código vivo (a armadilha que já custou 3 correções)

- [x] CHK001 - Os requisitos apontam para as definições **vivas** das 3 funções do repasse, e não para a prévia morta? [Consistência, Spec §FR-022] {auto} — ✅ corrigido na onda-004 (dec-035): prévia `0100:26` (corpo `0100:71-143`), fechamento `0098:111`, detalhe `0098:515`.
- [x] CHK002 - **Nenhuma** referência de artefato trata `0098:321-444` (prévia dropada pela `0100:24`) como código vivo? [Consistência, dec-035] {auto} — ✅ `grep -rn 0098:` nos artefatos: as 2 únicas citações restantes do intervalo morto (research §Consequência direta, quickstart C2) o nomeiam **explicitamente como morto**, que é o uso correto.
- [x] CHK003 - **Nenhuma** referência trata `0071:104` como gate vivo? [Consistência, dec-035] {auto} — ✅ era o 4º ponto de FR-022; `0098:513`/`0098:515` redefine `hub_adiantamento_repasse_motorista`, logo o gate vivo é `0098:597`. Rótulo corrigido.
- [x] CHK004 - A quantidade de gates de `desconto_adiantamentos` é **medida**, não suposta? [Mensurabilidade, research §2] {auto} — ✅ `grep -nE desconto_adiantamentos 0071/0098/0100` → **3** gates vivos (`0100:103`, `0098:237`, `0098:597`). Não existe um 4º "cálculo": era a função morta.
- [x] CHK005 - Os nomes de CTE citados nos requisitos existem de fato no código? [Clareza, Spec §FR-042-PERF] {auto} — ✅ `adiantamentos_cte` **não existia em nenhuma migration** (grep vazio); corrigido para os nomes reais: `adiant` (`0100:81`) na prévia e `pagas` (`0098:218`) no fechamento.
- [x] CHK006 - O par `REVOKE`/`GRANT` citado como precedente pertence a função viva? [Consistência, Spec §Anexo] {auto} — ✅ `0098:447-448` era o par da função **morta**; trocado por `0100:164-165` + `0098:629-630`.

## B · Segurança e multi-tenancy

- [x] CHK007 - 🔴 **BLOQUEANTE (CHK-F2)** — Os requisitos exigem que a fonte do aviso de FR-049 seja gateada pela **mesma** permissão da prévia (`adiantamentos.pagamentos_consultar`) e **proíbem** `pagamento_confirmar`? [Completude, Spec §FR-049, dec-036] {auto} → ✅ **requisito especificado** (spec §FR-049 + contrato §3 Garantias). ⚠️ **A implementação continua pendente**: a `0117` nasceu com o gate errado (`hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar')` no corpo do resumo). Item fica `[ ]` até `execute-task` alterar o gate e provar as **duas** metades: (a) usuário com só `pagamentos_consultar` **vê** o aviso; (b) usuário sem nenhuma das duas **não** alcança a tela. **[RESOLVIDO em review-task, onda-008]** a nota "implementação pendente" acima está obsoleta: a 0117 viva usa `pagamentos_consultar`; driver `hub-lancamento-externo-integration.sh` prova resumo (a) VE o aviso, (b) sem permissão -> PERMISSAO_NEGADA, (c) só consultar NÃO aplica (52 PASS / 0 FAIL).
  - ✅ **FECHADO (onda-007, evidência)**: gate do resumo trocado para `pagamentos_consultar` em `0117:307`; driver `hub-lancamento-externo-integration.sh` — `resumo (a)` PASS (papel só com `pagamentos_consultar` vê qtd/totais/flag), `resumo (b)` PASS (sem nenhuma → `PERMISSAO_NEGADA`), `resumo (c)` PASS (escrever segue exigindo `pagamento_confirmar`). Controle negativo `LE_NEG=gate-resumo`: reprova só `resumo (a)` e `C9/FR-049`. Frontend: `repasse/page.test.tsx` (aviso visível com só `pagamentos_consultar`; botões importar/fechar ausentes) e `lancamento-externo.test.tsx` (`CHK008`, falha não engolida).
- [x] CHK008 - Os requisitos **proíbem** degradar o aviso de FR-049 por `catch`? [Clareza, Spec §FR-049] {auto} — ✅ "O aviso MUST NOT ser degradado por `catch` — degradar é o falhar-calado que esta FR proíbe". A alternativa foi rejeitada em dec-036, não apenas não escolhida.
- [x] CHK009 - 🔴 Existe **cenário nomeado** que prove a guarda de escrita cross-tenant nas **duas** metades, incluindo o caso **negativo** (usuário de outra empresa injetando dedução na empresa 6)? [Gap] {auto} → **ABERTO**. A correção **existe** no DDL e nas duas metades (`0117:210` `IF NOT (6 = ANY (v_escopo)) THEN RAISE EXCEPTION 'FORA_DE_ESCOPO'` fail-closed **e** `0117:243` `AND e.id_empresa = 6`), e foi verificada ad-hoc no `hub_homolog` (plan §F1: `gate-escopo: OK`, `resolucao-empresa-6: OK`). **Falta** o cenário repetível: `quickstart.md` tem C1–C14 e **nenhum** deles é o negativo de escopo. Verificação ad-hoc não sobrevive à próxima refatoração.
  - ✅ **FECHADO (onda-007, evidência)**: C15/C15.b permanentes no driver `hub-lancamento-externo-integration.sh` (tarefa 4.1); controle negativo nomeado `LE_NEG=escopo-1` reprova `C15`, `escopo-2` reprova `C15.b` (`0:APLICADA` — o furo cross-tenant).
- [x] CHK010 - Está especificado **por que** o `INSERT` grava `6` fixo e resolve o entregador por `e.id_empresa = 6`, em vez de `ANY(v_escopo)`? [Clareza, plan §F1] {auto} — ✅ "os dois lados usam o mesmo número"; um escopo `[6, 9002]` resolveria entregador da 9002 e gravaria como lançamento da 6.
- [x] CHK011 - Os requisitos exigem `REVOKE ALL FROM PUBLIC` **antes** do `GRANT EXECUTE` em toda função nova? [Completude, data-model §GRANT] {auto} — ✅ e cumprido nas 3 funções da `0117` (`:161-162`, `:282-283`, `:328-329`).
- [x] CHK012 - Os requisitos exigem RLS nas tabelas novas e `search_path` pinado nas funções `SECURITY DEFINER`? [Completude, Spec §FR-036] {auto} — ✅ `0117:115-116` RLS habilitada nas duas tabelas; políticas `:130`/`:136`; `SET search_path = public, pg_temp` em `:176` e `:300`.
- [x] CHK013 - Os requisitos **proíbem** dado identificável de terceiro na resposta do import e do resumo? [Completude, Spec §FR-031] {auto} — ✅ resposta é contagem por motivo, sem CNPJ/nome; resumo devolve só `qtd_*`, `total_*` e `flag_desconto_ligada`.
- [x] CHK014 - Os motivos de recusa são **tokens fechados**, sem interpolar conteúdo de célula? [Clareza, plan §F3] {auto} — ✅ corrigido no contrato; única exceção deliberada é `VALOR_ACIMA_DO_TETO`, que nomeia constante nossa, não dado do arquivo.
- [x] CHK015 - A escrita tem **uma única** porta privilegiada, sem `GRANT` de escrita direto na tabela? [Completude, Spec §FR-036] {auto} — ✅ só `GRANT SELECT` (`0117:139-140`); escrita só por `hub_lancamento_externo_aplicar`.

## C · Dinheiro: precisão, ordem dos gates e teto

- [x] CHK016 - 🔴 A **ordem** "gate de FR-047 **antes** de `paraCentavos`" é parte explícita do requisito, e não só a existência do gate? [Clareza, Spec §FR-047] {auto} — ✅ o critério é `|valor × 100 − round(valor × 100)| <= 1e-6` **sobre o valor da célula**: recusa a linha **antes** de converter. `paraCentavos` (`lib/adiantamento-remanescente.js:33`) arredonda calado (`100.005` → R$ 100,01); rodar o gate depois dela aceitaria silenciosamente um valor que a planilha não disse.
- [x] CHK017 - O critério de aceitação de valor é **quantificado**, em vez de "precisão adequada"? [Mensurabilidade, Spec §FR-047] {auto} — ✅ tolerância literal `1e-6`, com controle negativo em C6 (trocar por comparação literal de meio centavo faz `1234.565` passar, e só esse teste falha).
- [x] CHK018 - A recusa por teto nomeia **motivo e o teto**? [Clareza, contrato §Motivos] {auto} — ✅ `VALOR_ACIMA_DO_TETO` "nomeia **o teto** (R$ 5.000,00)" (contrato `:77`, `:92`).
- [x] CHK019 - A decisão de o teto de R$ 5.000 viver **no JS e não em `CHECK`** está registrada em algum artefato? [Gap, dec-026] {auto} → **ABERTO**. Verificado: os `CHECK` da `0117` são `valor > 0` (`:75`), CNPJ 14 dígitos (`:77`), `observacao <= 500` (`:80`) e piso de data (`:83`) — **nenhum** teto superior, o que está **correto** e coerente com dec-026. Mas o *porquê* (guard-rail de digitação, ajustável sem migration) só existe na Decisão, não nos artefatos — spec §FR-048 cita o teto sem o número e sem a sede.
  - ✅ **FECHADO (onda-007, evidência)**: tarefa 3.2.1/3.2.2 [x]: dec-026 em `data-model.md` §Constraints (linha 177) e em `spec.md` FR-048.
- [x] CHK020 - Está especificado que o teto por linha é **guard-rail de digitação**, não limite de negócio? [Clareza, Spec §FR-048] {auto} — ✅ spec `:317-318`: "guard-rail contra erro de digitação (valor lançado sem separador decimal), não um limite de negócio".
- [ ] CHK021 - O apetite de risco de FR-022 (flag desligada ⇒ a empresa **paga duas vezes**) segue aceito, agora que FR-049 depende de uma permissão que ainda vai mudar? [Risco, Spec §FR-022] {humano} — decisão do operador (Q2) registrada; reconfirmar após CHK007.

## D · Integração com o cálculo do repasse

- [x] CHK022 - Os requisitos nomeiam em **quais** definições a CTE nova entra, uma a uma? [Completude, data-model §Funções] {auto} — ✅ prévia `0100:26`, fechamento `0098:111`, detalhe `0098:515`.
- [x] CHK023 - Está especificado que a CTE nova **não** pode colidir com `debitos_cte`, que existe em **duas** cópias? [Completude, Spec §FR-042-PERF] {auto} — ✅ nome, chave de junção e dupla contagem; as duas cópias são `0100:71` (prévia) e `0098:208` (fechamento).
- [x] CHK024 - Está especificado que as **três** fontes de dedução somam, sem nenhuma substituir a outra nem contar duas vezes? [Cobertura, Spec §FR-016] {auto} — ✅ cenário C8 dedicado.
- [x] CHK025 - A invariante de conservação de saldo do item está identificada e o ramo aplicável escolhido? [Dependências, research §CHECK] {auto} — ✅ `apuracaorepasseitem_saldo_conserva` (`0098:71-81`), ramo pós-regra (`valor_pago NOT NULL`); verificado que **nenhum** CHECK liga `remanescente` às parcelas, logo somar um 4º termo não viola nada.
- [x] CHK026 - Está especificado que o crédito entra **dentro** do remanescente, antes do teste do piso? [Clareza, research §Ordem] {auto} — ✅ `calc` (`0098:255`) roda antes de `resultado` (`0098:259`), então a decisão 9 é satisfeita por construção.
- [x] CHK027 - Prévia e fechamento são exigidos **não divergentes**, com cenário próprio? [Consistência, Spec §US2/SC-002] {auto} — ✅ C2, que é também o detector de "alterou a função morta".

## E · Performance

- [x] CHK028 - O requisito de performance tem plano de execução **medido**, não estimado? [Mensurabilidade, Spec §FR-042-PERF] {auto} — ✅ `EXPLAIN (ANALYZE, BUFFERS)` real: **1,604 ms** isolada (`Index Scan`, 1.554 de **229.467** linhas = 0,68%, 47 buffers) e **2,094 ms** com as **três** fontes, 58 buffers (plan `:103-108`, research `:283-303`).
- [x] CHK029 - A medição foi feita em volume **pessimista** declarado face ao real? [Clareza, plan §Escala] {auto} — ✅ 229.467 linhas sintéticas contra 106 adiantamentos reais (≈2.166×).
- [x] CHK030 - Está definido **o que conta como regressão** face a essa baseline? [Gap, Spec §SC-009] {auto} → **ABERTO**. A baseline está registrada em 3 artefatos, mas nenhum define o limiar: SC-009 exige "zero `Seq Scan` na tabela nova", o que é binário e cobre o pior caso, porém não há critério para degradação de tempo/buffers. Sugestão a decidir: regressão = aparecer `Seq Scan` em `LancamentoExterno`, **ou** `Index Cond` deixar de cobrir igualdade+faixa, **ou** tempo das três fontes passar de ~2× a baseline no mesmo volume.
  - ✅ **FECHADO (onda-007, evidência)**: critério fixado em `spec.md` §SC-009 e espelhado em `plan.md` (dec-040); implementado e **provado nos dois sentidos** por `hub-lancamento-externo-perf.sh`: APROVADO com o índice (isolada 1,286 ms/31 buf; três fontes 2,924 ms/96 buf, zero Seq Scan) e REPROVADO com `PERF_NEG=noindex` (8 critérios: Seq Scan, Index Cond vazio, 17,958 ms/3086 buf e 21,103 ms/3151 buf).
- [x] CHK031 - O dado sintético (229.467 linhas) foi **removido** do `hub_homolog` após a medição, e isso está registrado? [Gap] {auto} → **ABERTO**. Nenhum artefato menciona a remoção (`grep -niE 'seed|remov|DELETE FROM' research/plan/data-model` → vazio). Sobra de seed envenena C1–C14, que rodam no mesmo banco isolado — precisa estar escrito, não lembrado.
  - ✅ **FECHADO (onda-007, evidência)**: o seed vive dentro de `BEGIN..ROLLBACK` no script de perf (resolvido por construção); o script confere `count(*)` antes = depois (0 = 0) e que o seed efetivo foi de 229.467 linhas (sem isso a medição seria oca). `research.md` §Higiene registra a contagem do `hub_homolog`.

## F · Não-regressão e cobertura de teste

- [x] CHK032 - 🔴 A **ordem** da extração de FR-050 é parte do requisito (medir → extrair → medir com números idênticos)? [Clareza, Spec §FR-050 / C13] {auto} — ✅ C13 é explícito: "a ordem é parte do teste"; qualquer diferença **pára** a extração, porque é código em produção desde 2026-10-22.
- [x] CHK033 - As suítes de não-regressão nomeadas são **as mesmas** na spec e no cenário? [Conflict] {auto} → **ABERTO**. `FR-050` nomeia **3** arquivos (`adiantamento-retorno-transfeera-unit`, `…-arquivo-real`, `hub-adiantamentos-rotas-unit`); C13 nomeia **4**, somando `adiantamento-transfeera-xlsx-unit`. Verificado: o 4º **existe** (`backend/tests/adiantamento-transfeera-xlsx-unit.test.js`) e **está** em `package.json:8`. A lista certa é a de C13 — FR-050 está incompleta. **[RESOLVIDO em tasks 1.2]** FR-050 alinhada às 4 suítes (spec cita `adiantamento-transfeera-xlsx-unit`); o "ABERTO" acima é histórico.
  - ✅ **FECHADO (onda-007, evidência)**: tarefa 1.2.1/1.2.2 [x]: FR-050-REUSO lista as 4 suítes; `grep` mostra spec, quickstart e `package.json` concordando.
- [x] CHK034 - O requisito exige que a fábrica de erro preserve `instanceof` e o valor de cada `motivo`? [Cobertura, C13] {auto} — ✅ "`e instanceof RetornoTransfeeraParseError` continua verdadeiro na rota (`hub-adiantamentos.js:1515`)".
- [x] CHK035 - 🔴 O requisito exige que **todo** arquivo de teste novo entre na lista de `backend/package.json:8`? [Completude, Spec §FR-050] {auto} — ✅ "fora dela ele não roda e o verde fica oco". Baseline medida: **88** arquivos listados hoje; as 4 suítes do C13 estão todas lá.
- [x] CHK036 - Os cenários incluem **controle negativo** (um teste que falha se a correção for revertida)? [Cobertura, Spec §SC-011] {auto} — ✅ C6 para FR-047 e C2 para a função viva, cada um nomeando o teste que falha e afirmando que é o único.

## G · Operação: o cenário que roda na quarta

- [x] CHK037 - 🔴 Existe cenário próprio para a **primeira apuração da história** (sem anterior, `saldo_anterior` NULL/0, com lançamento externo)? [Cobertura, quickstart C1] {auto} — ✅ C1, marcado **OBRIGATÓRIO**, e é o único caminho que roda na quarta.
- [x] CHK038 - Está especificado **por que** a primeira apuração não levanta `APURACAO_FORA_DE_ORDEM`? [Dependências, research §Primeira] {auto} — ✅ `0098:140` "empresa sem nenhuma apuração: livre"; `v_ultimo_periodo` vem NULL e o `IF` não dispara. `saldo_ant` (`0098:227`) devolve 0 linhas ⇒ `COALESCE(..., 0)`.
- [x] CHK039 - O passo de conferência da prévia traz os **6 números** e os **6 sinais de problema**, com a exigência de diferença **zero**? [Completude, RUNBOOK §4.3/4.4] {auto} — ✅ 6 linhas na tabela de §4.3 (soma bate, quantidade, retenção, ninguém negativo, semana certa, aviso de flag) e 6 bullets em §4.4; item 1 exige que a queda do total a pagar seja **exatamente** a soma importada, "diferença de zero centavo".
- [x] CHK040 - Está declarado que o fechamento é **irreversível** e que a prévia é a única chance de ver o efeito antes? [Premissas, RUNBOOK §4] {auto} — ✅ "Depois do passo 5 não há desfazer".

## H · Gate determinístico `requirement-coverage.sh` (§4.2.1)

Saída literal sobre `spec.md`:
`RESULT|requirements=48|covered=45|errors=3` — 3 FRs sem cenário associado.

- [x] CHK041 - FR-034 tem cenário de aceite, e seu escopo não contradiz FR-049? [Conflict → resolvido] {auto} — ⚠️ **o gate achou um conflito real, introduzido nesta própria onda**: FR-034 dizia "A operação MUST exigir `pagamento_confirmar`" **sem escopo**, o que contradizia a exigência nova de FR-049 (resumo por `pagamentos_consultar`, dec-036). ✅ **Corrigido**: FR-034 agora se limita à **escrita** (`hub_lancamento_externo_aplicar`), declara explicitamente que não alcança o resumo, e ganhou cenário de aceite (quem tem só `pagamentos_consultar` vê o aviso e é recusado ao importar).
- [x] CHK042 - FR-033 (mensagens em português, claras e acionáveis) tem cenário que o verifique? [Gap, gate `fr-no-scenario`] {auto} → **ABERTO**, e é gap **de baixo risco**: FR-033 é requisito transversal de Constitution, não de comportamento próprio. Destino: cobrir por asserção dentro dos cenários de recusa já existentes (C4, C10), não por cenário novo.
  - ✅ **FECHADO (onda-007, evidência)**: tarefa 3.1.6 [x]: asserções de mensagem em português nos testes de recusa (C4/C10).
- [x] CHK043 - FR-043 (nenhum segredo nem dado pessoal real versionado — repositório **público**) tem cenário/gate que o verifique? [Gap, gate `fr-no-scenario`] {auto} → **ABERTO**, e este **não** é de baixo risco: as fixtures de teste da feature são XLSX com CNPJ e nome. O repo já tem guarda de segredos (`gitleaks`, PR #246), mas ela não pega CNPJ real de motorista. Destino: item de verificação na tarefa que cria as fixtures.
  - ✅ **FECHADO (onda-007, evidência)**: tarefas 2.1.1–2.1.5 [x]: fixtures geradas por código com CNPJ sintético, varredura de PII sobre as células no formato real, com controle negativo (reprovou com 2 achados; a tag `<t>` dá 0 num arquivo de 9 células `t="str"><v>`) e sobre os arquivos novos do `git status`.

---

## Follow-up — destino de cada item aberto

| Item | Marcador | Destino |
|---|---|---|
| CHK007 | bloqueante (requisito ✅, implementação ✗) | `create-tasks` → tarefa **crítica**: trocar o gate do resumo para `pagamentos_consultar` e provar as duas metades |
| CHK009 | `[Gap]` | `create-tasks` → tarefa **crítica**: cenário negativo de escopo (C15) no quickstart + teste no driver `hub-adiantamentos-integration.sh` |
| CHK019 | `[Gap]` | `create-tasks` → registrar dec-026 (teto no JS, não em `CHECK`) em `data-model.md` §Constraints |
| CHK030 | `[Gap]` | `create-tasks` → fixar o critério de regressão de performance em `spec.md` §SC-009 |
| CHK031 | `[Gap]` | `create-tasks` → registrar a remoção do seed de 229.467 linhas e checá-la antes de C1 |
| CHK033 | `[Conflict]` | `create-tasks` → alinhar FR-050 à lista de 4 suítes do C13 |
| CHK042 | `[Gap]` (baixo risco) | `create-tasks` → asserção de mensagem em C4/C10, sem cenário novo |
| CHK043 | `[Gap]` | `create-tasks` → verificação de CNPJ/nome **sintéticos** na tarefa das fixtures (repo público) |
| CHK021 | `{humano}` | reconfirmação do operador após CHK007 |

**Resolução**: 34 `{auto}` resolvidos com evidência citada · 1 `{humano}` em
aberto · 8 itens abertos (1 bloqueante + 6 `[Gap]` + 1 `[Conflict]` já
corrigido na spec). Total: 43 itens.

**Gates da casa a rodar em `execute-task`** (números de referência, não deste
checklist): backend **2030 pass / 0 fail** · `tsc --noEmit` · vitest **941/0** ·
`next build` · lint na **baseline (28: 5 erros, 23 avisos)** · driver
`hub-adiantamentos-integration.sh` **231 PASS / 0 FAIL**.

Um checklist meio-marcado cujos gaps viraram tarefa cumpriu o papel; um 100%
verde cujos gaps foram varridos, não.
