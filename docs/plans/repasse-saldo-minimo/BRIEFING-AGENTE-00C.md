# Briefing — repasse: saldo mínimo carregado, aprovação só do admin e uuid na tela

Entrada para o fluxo `feature-00c` (specify → clarify → plan → checklist → create-tasks →
execute-task → converge → review-task). **Leia o `CLAUDE.md` antes de qualquer coisa**: o
ambiente "homologação" É produção, o rito do ciclo git é cláusula pétrea e a autorização é
**por etapa**. Repositório público — nenhum dado pessoal em código, teste, log ou documento.

Pedido do operador (2026-09-25), em três frentes:

1. Motorista cujo repasse da semana somar **menos de R$ 5,50** não recebe na semana; o valor
   é **carregado para a próxima**, **nunca pode ser esquecido** e fica **à mostra para o
   motorista**.
2. A **aprovação de pagamento** passa a ser **só do administrador do sistema**. Nenhum outro
   perfil.
3. A tela **Repasse semanal** ganha a coluna **uuid do motorista**, também na **exportação**
   — é a chave que o financeiro usa para conciliar.

A §1 foi **lida no código em 2026-09-25**. O que depende de produção está marcado
**[MEDIR]** e é medido pelo operador antes do `specify` (§6).

---

## 1. O estado de hoje, lido no código

### Repasse e fechamento

| O que | Onde |
|---|---|
| Cálculo ao vivo (tela do hub) | `hub_adiantamento_repasse` — vigente em `0088:34`; `remanescente = creditos − adiantamentos − debitos` (`0088:105`) |
| Leitura de semana fechada | `hub_adiantamento_repasse_congelado` — `0086:84` |
| Fechamento | `hub_adiantamento_repasse_fechar` — vigente em **`0092:67`** (antes 0088:125 → 0082:24 → 0067:1902). **Nunca partir de versão anterior.** |
| App do motorista | `hub_adiantamento_repasse_motorista` (`0088:241`) e `…_ultimo_fechado` (`0086:139`) |
| Congelamento | `ApuracaoRepasse` + `ApuracaoRepasseItem` (`0066:416/429`), REVOKE UPDATE/DELETE + gatilho `hub_bloqueia_alteracao_apuracao` (`0066:463`). Fechou, não reabre. |
| Status de pagamento do repasse | **Não existe.** A linha em `ApuracaoRepasse` = semana fechada. O pagamento é feito fora do sistema, a partir do CSV. |
| `id_empresa` do fechamento | **Fixo em 6** (`0092:114,176`) |

### ⚠️ Hoje nada é carregado entre semanas — e isso é regra escrita

- `lib/adiantamento-remanescente.js:97-100`: *"Negativo é só SINALIZADO — nunca transportado
  para a semana seguinte (FR-040)"*.
- `docs/plans/adiantamento-motorista/PLANO.md:517` (Q-N4): *"Não acumula para a semana
  seguinte sem regra definida"*. **Esta entrega É a regra definida** — atualizar o PLANO.
- App: `frontend_motorista/app/(app)/repasse/page.tsx:174` diz ao motorista *"Ele não é
  transportado automaticamente para a semana seguinte"*. Texto a revisar.

### ⚠️ O furo que faria o saldo ser esquecido

O CTE `linhas` do fechamento (`0092:161-172`) só cria item para quem teve **crédito, débito
ou adiantamento na semana**:

```sql
AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR p.entregador_id IS NOT NULL)
```

Motorista com R$ 3,00 retido que **não rodar** na semana seguinte **não ganha linha** — e o
saldo some. O mesmo filtro existe no cálculo ao vivo. **Este é o ponto que o requisito "não
pode ser esquecido de jeito nenhum" protege**; teste obrigatório (§5).

### Aprovação / permissão

- Fechar apuração (`POST /repasse/:periodo/fechar`, `hub-adiantamentos.js:1580`) e gerar
  notas (`POST /repasse/:periodo/movimentos`, `:1654`) exigem
  `adiantamentos.pagamento_confirmar`. A **mesma** permissão confirma os lotes de
  adiantamento da Transfeera (`POST /lotes/:id/confirmacao` `:1209`, `/retorno` `:1298`).
- Checada em **três camadas**: middleware `hub-require-permission.js`; por entidade ativa em
  `resolverContextoAdiantamentos` (`hub-adiantamentos.js:303`); e no SQL
  (`hub_adiantamento_tem_permissao`, `0092:84`). **As três precisam mudar juntas.**
- Quem tem hoje: `financeiro`, `admin_entidade`, `admin_plataforma` (`0070:41-49`).
- **O "administrador do sistema" já existe: `admin_plataforma`** (escopo global, único com
  `admin.gerenciar`, `0007:69-90`; detectado por `usuarioEhAdminPlataforma`,
  `hub-rbac-cache.js:161`). Mas o módulo de adiantamento o trata como qualquer papel: ele
  **precisa de vínculo em `UsuarioEntidade` na empresa 6**, senão leva 403. **[MEDIR]**
- Frontend: botões "Fechar apuração" e "Gerar notas da semana" aparecem com
  `podeFechar = permissoes.includes('adiantamentos.pagamento_confirmar')`
  (`frontend_v2/app/hub/dashboard/adiantamentos/repasse/page.tsx:146`).

### Tela e exportação

- Tela: `frontend_v2/app/hub/dashboard/adiantamentos/repasse/page.tsx`, tabela inline,
  colunas (`:302-307`): Motorista · Créditos · Adiantamentos · Débitos · Remanescente ·
  Observação.
- DTO `GET /repasse` (`hub-adiantamentos.js:1439`, itens em `:1500-1509`) traz só
  `entregadorId` **inteiro**. Tipo `RepasseItem` em `lib/hub/adiantamentos-api.ts:535`.
- CSV: gerado no backend, `GET /repasse/exportar` (`:1526`) via `serializarCsvRemanescente`
  (`adiantamento-remanescente.js:124/145`). Cabeçalho `Entregador, Créditos, Adiantamentos,
  Débitos, Remanescente` — **sem id nenhum**. Semana fechada exporta o congelado.
- **O uuid é `"Entregador".id_externo`** (`0010_entregador.sql:17`, `NOT NULL`,
  `UNIQUE (id_empresa, id_externo)`). **É o mesmo que a tela de Motoristas do hub já mostra**
  (`idExterno` em `app/hub/dashboard/motoristas/`) — não é identificador novo, é o que o
  financeiro já conhece. Rótulo na tela nova: o mesmo da tela de Motoristas (conferir lá e
  copiar; regra "mostrar antes onde a informação já aparece", CLAUDE.md).

---

## 2. Decisões

### Do operador (2026-09-25) — não reabrir sem ele

| # | Pergunta | Decisão |
|---|---|---|
| D1 | Sobre **qual valor** vale o piso de R$ 5,50? | O **total a pagar** da semana = `remanescente` (créditos − adiantamentos − débitos) **+ saldo carregado**. |
| D2 | Remanescente **negativo** carrega? | **Não.** O piso vale para `0 < total < 5,50`. Negativo segue como hoje: alerta, não transporta. |
| D4 | Semana retida **gera nota** (movimento na EnvioMassa)? | **Não.** A geração pula o motorista retido; na semana em que ele receber, o movimento leva `valor_nota` e `valor_fora_nota` **somados aos componentes carregados** — uma nota só. |
| D5 | "Aprovação de pagamento" cobre quais ações? | **Fechar apuração**, **gerar notas da semana** **e** confirmar/retornar **lotes de adiantamento (Transfeera)**. Todas só do administrador do sistema. |

### Do agente — recomendações que o operador pode vetar no `clarify`

| # | Pergunta | Recomendação |
|---|---|---|
| D3 | Piso fixo ou configurável? | Coluna `repasse_valor_minimo numeric(14,2) NOT NULL DEFAULT 5.50` em `AdiantamentoConfiguracao` (versionada, auditável). **Sem campo na tela** — entra quando alguém pedir para mudar. |
| D6 | Como restringir ao admin? | Consequência de D5: **as quatro ações de D5 são exatamente todos os usos de `adiantamentos.pagamento_confirmar`** (rotas `:1209`, `:1298`, `:1580`, `:1654`; telas `lotes/[id]/page.tsx:153` e `repasse/page.tsx:146`; SQL 0067/0083/0092). Então **não precisa de permissão nova nem de mexer nas três camadas**: basta **retirar** essa permissão de `financeiro` e `admin_entidade` em `PapelPermissao`. Ficam só com `admin_plataforma`. |
| D7 | Semanas **já fechadas** antes do deploy | **Não reescrever** (imutáveis por gatilho). O carregamento começa na primeira semana fechada depois do deploy. Item fechado com `0 < remanescente < 5,50` **não pago** → o operador decide caso a caso. **[MEDIR]** |
| D9 | Motorista com saldo carregado (ex.: R$ 3,00) tem semana **negativa** (ex.: −R$ 10,00). O que acontece com os R$ 3,00? | **Continuam carregados, intactos.** Somar daria −R$ 7,00, que pela D2 não transporta: os R$ 3,00 sumiriam, e o requisito é que nunca sumam. O negativo da semana é tratado como hoje (alerta, sem transporte). |
| D8 | Ordem de fechamento | Proibir fechar semana **anterior** à última fechada (`APURACAO_FORA_DE_ORDEM`). Sem isso, o saldo anterior de uma semana fechada fora de ordem sai errado e não há como corrigir (imutável). |

---

## 3. Fases, em ordem — cada uma vai a produção sozinha

A regra que ordena: **não inviabilizar o repasse em uso**. Do menor risco para o maior.

### F1 — uuid do motorista na tela e no CSV (sem DDL)

- **Sem migration.** O backend busca `Entregador?id=in.(…)&select=id,id_externo` **em lotes
  de 100** (o `in.()` grande estoura o header do PostgREST — incidente do upload, PR #50) e
  junta no Node, nas duas rotas: `GET /repasse` e `GET /repasse/exportar`, **ao vivo e
  congelado**.
- DTO: `entregadorUuid: string`. Tipo em `adiantamentos-api.ts:535`.
- Tela: coluna nova com o uuid (fonte mono, **copiável** — é para colar em planilha).
- CSV: coluna `UUID do motorista` **como primeira coluna** (chave de conciliação). Mudar o
  cabeçalho quebra quem já importa o CSV por posição → **avisar o financeiro** no PR.
- **Pronto quando:** tela e CSV da semana corrente e de uma semana fechada trazem o uuid, e o
  uuid bate com o da tela de Motoristas para o mesmo motorista.

### F2 — aprovação só do administrador do sistema

- **Só migration, zero código de aplicação** (D6). `NNNN_pagamento_so_admin_plataforma.sql`:
  `DELETE FROM "PapelPermissao"` da permissão `adiantamentos.pagamento_confirmar` para os
  papéis `financeiro` e `admin_entidade`, por **nome** (nunca por id). Idempotente.
  Rollback = o `INSERT … ON CONFLICT DO NOTHING` inverso, testado antes.
- As três camadas (middleware, `resolverContextoAdiantamentos`, `hub_adiantamento_tem_permissao`
  no SQL) já leem `PapelPermissao` — passam a recusar sozinhas. O cache do RBAC tem TTL de
  60 s (`hub-rbac-cache.js:28`): o efeito é total em até 1 minuto, sem restart.
- Os botões ("Fechar apuração", "Gerar notas da semana", confirmação de lote) já dependem da
  permissão e somem sozinhos. **Nenhum build, nenhum `service update`.**
- ⚠️ **Pré-condição, antes da migration:** existir ao menos um usuário `admin_plataforma`
  com vínculo ativo em `UsuarioEntidade` na **empresa 6**. Sem isso **ninguém fecha a semana
  nem confirma lote de adiantamento** — e o lote parado atrasa o pagamento do motorista.
  **[MEDIR]**
- ⚠️ Conferir se algum outro papel (criado por tela, fora das migrations) tem a permissão:
  a migration deve retirar de **todo papel exceto `admin_plataforma`**, não só dos dois
  conhecidos. **[MEDIR]**
- Conferir o rótulo em `lib/hub/rotulo-permissao.ts:58-95` e textos de tela que digam que o
  `financeiro` confirma pagamento (ajuste de texto, se houver, entra na F1 ou na F3).
- **Pronto quando:** `financeiro` e `admin_entidade` recebem 403 nas quatro ações (rota **e**
  RPC direto no PostgREST), `admin_plataforma` executa, e os botões somem para os demais.

### F3 — saldo mínimo carregado (o coração; código de dinheiro)

**Modelo (aditivo, nada reescrito):** colunas novas em `ApuracaoRepasseItem`, todas
`NOT NULL DEFAULT 0` (itens antigos ficam com 0, que é a verdade deles):

| Coluna | Significado |
|---|---|
| `saldo_anterior` | o que veio carregado da semana anterior (total e os dois componentes de D4: `saldo_anterior_nota`, `saldo_anterior_fora`) |
| `valor_pago` | o que o financeiro paga nesta semana |
| `valor_transportado` | o que fica retido e vai para a próxima (idem, com componentes) |

Invariante, travada por `CHECK` na tabela:
`remanescente + saldo_anterior = valor_pago + valor_transportado` quando `remanescente ≥ 0`, e
`valor_transportado = saldo_anterior, valor_pago = 0` quando `remanescente < 0` (D9),
com `valor_pago = 0 OR valor_transportado = 0` (ou paga tudo, ou retém tudo).

**Fechamento** (`CREATE OR REPLACE` **a partir do corpo vigente**, hoje o da 0092 — a F2 não
redefine função nenhuma):

1. `saldo_anterior` = `valor_transportado` do item do **mesmo motorista na última apuração
   fechada anterior** da empresa.
2. **O CTE `linhas` passa a incluir quem tem saldo anterior > 0**, mesmo sem movimento na
   semana (o furo da §1).
3. `total = remanescente + saldo_anterior`; se `0 < total < repasse_valor_minimo` → retém
   (`valor_pago = 0`, `valor_transportado = total`); se `total ≥ piso` paga tudo. Se o
   `remanescente` da semana for negativo: não paga, não transporta o negativo (D2) e
   **preserva** o `saldo_anterior` como `valor_transportado` (D9).
4. Guarda D8 (`APURACAO_FORA_DE_ORDEM`).
5. O `total` devolvido pelo fechamento passa a ser `sum(valor_pago)` — **conferir quem
   consome esse número** (rota `:1580` e diálogo `adiantamento-fechar-apuracao-dialog.tsx`).

**Leitura** — as quatro funções expõem `saldo_anterior`, `valor_pago`, `valor_transportado`
e `retido`: `hub_adiantamento_repasse` (prévia ao vivo **também** soma o saldo anterior e
inclui quem só tem saldo), `…_congelado`, `…_repasse_motorista`, `…_ultimo_fechado`.
⚠️ Mudar o tipo de retorno exige `DROP FUNCTION` + `CREATE` (não basta `OR REPLACE`), com os
`GRANT` refeitos, e **`SIGUSR1` no `pgadmin_postgrest`** depois (há dois PostgREST no host —
produção 2026-09-23).

**Geração de notas** (`lib/adiantamento-geracao-movimento.js:41`): pula retidos (D4) e soma
os componentes carregados em quem recebe. Teste unit puro.

**Hub — tela e CSV:** colunas `Saldo anterior` e `A pagar`; badge **"Retido — vai para a
próxima semana"** na coluna Observação que já existe (não criar coluna nova para isso). CSV
ganha `Saldo anterior`, `A pagar`, `Retido para a próxima semana`. **O CSV é de onde o
financeiro paga: retido tem de sair com `A pagar = 0,00` explícito, nunca linha omitida.**

**App do motorista** (`frontend_motorista/app/(app)/repasse/page.tsx`) — antes de desenhar,
**abrir a tela e a home** e dizer na proposta onde cada número já aparece (regra de UI nova,
CLAUDE.md, incidente 2026-09-23):

- Card da semana corrente: linha **"Saldo da semana anterior"** entre "Outros débitos"
  (`:113`) e "Previsão a receber" (`:119`), só quando > 0.
- Previsão abaixo do piso: aviso de que o valor **será somado ao próximo repasse** (texto
  curto, sem jargão).
- Card "Semana fechada" (`:191-240`): mesma linha, e se retido, **"Retido: R$ X,XX — entra no
  repasse de <data>"** no lugar do valor a receber.
- Revisar o texto de `:174` (hoje afirma que nada é transportado).

**Documentação:** atualizar Q-N4 no `PLANO.md:517` e o comentário FR-040 de
`adiantamento-remanescente.js:97` — senão o próximo agente "corrige" de volta.

**Pronto quando:** numa sequência de semanas simulada (§5), nenhum centavo some, o motorista
vê o saldo carregado no app, e o CSV do financeiro fecha com o hub.

---

## 4. Riscos e o que NÃO fazer

- **Não reescrever apurações fechadas** — são imutáveis por gatilho, e é bom que sejam.
- **Não partir de versão antiga das funções.** Vigentes: `repasse` 0088, `congelado` 0086,
  `fechar` 0092, `motorista` 0088, `ultimo_fechado` 0086 — reconferir com
  `grep -l "FUNCTION hub_adiantamento_repasse" infra/hub/migrations/*.sql` na hora; outra
  sessão pode ter redefinido depois de hoje.
- **Número da migration:** a última hoje é 0096. Conferir na hora de criar; nunca editar
  migration aplicada.
- **Não tocar** em `categorias_producao`, FastAPI, endpoints de validação, nem no fluxo de
  lote/Transfeera (salvo decisão D5).
- **F2 sem admin vinculado = ninguém fecha a semana.** Medir antes, não depois.
- **Cabeçalho do CSV muda** (F1 e F3): planilhas do financeiro que leem por posição quebram.
- Tabelas do hub em produção vivem **dentro do `chatmasterveloz`**: migration = **rito
  integral** (5 gates), com rollback testado antes (modelo: `0092-rollback.test.sql`,
  `0096-rollback.sql`).

## 5. Verificação (o mínimo de cada PR)

`tsc --noEmit` · suíte unit do backend e dos dois frontends · `next build` se tocar frontend
· detector impeccable 0 achados se tocar UI · E2E do hub (e do motorista na F3) · integração
do adiantamento (**só passa aos domingos** — memória produção 2026-09-22; planejar a janela)
· smoke full-chain (`hub-adiantamentos-smoke-full-chain-integration.sh`) em tudo que muda
leitura via PostgREST · lint contra baseline.

Específico da F3 — driver novo `infra/hub/testes/hub-repasse-saldo-minimo.sh` +
`infra/hub/testes/sql/NNNN-saldo-minimo.test.sql`, cobrindo em sequência de semanas:

1. R$ 3,00 → retido; semana seguinte R$ 4,00 → **paga R$ 7,00**.
2. R$ 3,00 → retido; semana seguinte **sem nenhuma atividade** → item existe com
   `saldo_anterior = 3,00` e segue retido (o furo da §1).
3. Três semanas seguidas abaixo do piso → acumula e paga quando cruza.
4. Exatamente R$ 5,50 → paga (limite é `<`, não `≤`).
5. Negativo sem saldo → nada transporta (D2). Saldo R$ 3,00 + semana −R$ 10,00 → os
   R$ 3,00 seguem carregados (D9).
6. Fechar fora de ordem → `APURACAO_FORA_DE_ORDEM`.
7. **Conservação:** para cada motorista, `Σ remanescente = Σ valor_pago + último
   valor_transportado` ao longo de todas as semanas.
8. Retrato antes/depois: semanas já fechadas leem **idênticas** após a migration.

**Controles negativos obrigatórios** (memória: controle negativo pega teste oco — conferir
**quais** falham): sem a inclusão do saldo no CTE `linhas`, o caso 2 **tem** de falhar; sem
a soma do saldo anterior, os casos 1, 3 e 7 **têm** de falhar. `ROLLBACK=1` conferido.

F2: `hub-rbac-integration.sh` + caso novo que chama o **RPC direto** com JWT de `financeiro`
(prova a terceira camada, não só a rota).

**Revisão adversarial independente sobre o diff antes do PR** da F3 (e da F2) — memória
"revisão adversarial antes do PR".

## 6. [MEDIR] — o operador mede em produção antes do `specify`

Leitura apenas (sem escrita), via os mesmos meios dos briefings anteriores:

1. `SELECT count(*), min(periodo_inicio), max(periodo_inicio) FROM "ApuracaoRepasse";`
2. Itens fechados com `remanescente > 0 AND remanescente < 5.50` — quantos e soma (**D7**).
3. Na última semana ao vivo: quantos motoristas ficariam retidos e quanto somam (dimensiona
   o impacto no financeiro).
4. Usuários `admin_plataforma` com vínculo ativo em `UsuarioEntidade` na empresa 6 — só a
   **contagem** (**pré-condição da F2**).
5. Papéis (além de `admin_plataforma`) que hoje têm `adiantamentos.pagamento_confirmar` — só
   os **nomes** dos papéis (**F2**).
6. Lotes de adiantamento (`AdiantamentoLote`) ainda sem confirmação/retorno — só a contagem (depois da
   F2, só o admin confirma; não deixar lote parado na virada).
7. Quantos `Entregador` da empresa 6 aparecem no repasse — confirma que o lote de 100 da F1
   basta sem paginação extra.

## 7. Entregáveis

Por fase: branch `feat/repasse-<escopo>` · PR com gates **com números** · migration +
teste SQL + rollback (F2, F3) · runbook de deploy da fase em
`docs/plans/repasse-saldo-minimo/RUNBOOK-DEPLOY-F<n>.md` (imagem anterior anotada, ordem
migration → `SIGUSR1` → provar coluna → `service update`, prova de bundle por string
servida). Deploy só com os 5 gates e autorização por etapa.
