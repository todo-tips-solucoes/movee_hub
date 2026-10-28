# Quickstart / Cenários de Teste — `repasse-gera-movimento`

**Data**: 2026-10-28 · **Fase**: Phase 1 (plan)
Ambiente: **`hub-homolog` isolado**, nunca produção. `preflight.sh` é **obrigatório** antes do primeiro `up` (aborta se alcançar produção).

```bash
infra/hub/scripts/preflight.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog
docker compose -f infra/hub/compose.hub.homolog.yml -p hub-homolog --env-file /var/lib/hub_secrets/.env.hub.homolog up -d
infra/hub/scripts/migrate.sh -f infra/hub/compose.hub.homolog.yml -p hub-homolog -e /var/lib/hub_secrets/.env.hub.homolog
# depois de migrations: SIGUSR1 no PostgREST para recarregar o schema cache
```

⚠️ `SchemaMigration` **mente** fora do `migrate.sh` — aplicar sempre pelo script, arquivo a arquivo, nunca à mão.

---

## Fixtures que esta frente exige

### FX-1 — `mensagem1_modelo` configurado (⚠️ **obrigatória**)

Hoje `mensagem1_modelo` é **NULL** no `hub_homolog` (BRIEFING §7). Sem esta fixture, **todo cenário de caminho feliz passaria pelo ramo de recusa de D10 sem exercitar nada** — e um teste que passa pelo motivo errado é pior que teste ausente.

A fixture configura `AdiantamentoConfiguracao.mensagem1_modelo` (e `mensagem2_modelo`) para a empresa do cenário. **Um cenário separado (C8) mantém o modelo NULL de propósito**, para cobrir o ramo de recusa.

### FX-2 — `categorias_nota` configurado

Sem ele, `valor_nota`/`valor_fora_nota` vêm `NULL` e `nota_a_emitir` também — todos os motoristas cairiam em `SEM_DIVISAO`. **Um cenário separado (C7) mantém `categorias_nota` ausente**, para cobrir esse ramo.

### FX-3 — JWT com claim de escopo

⚠️ **A prévia depende da claim de escopo**: sem ela `hub_jwt_escopo_ids()` não resolve e a prévia devolve **zero** — *parece* defeito e não é (BRIEFING §9). Todo cenário assina o JWT **com** escopo. Um "zero inesperado" em diagnóstico se checa **primeiro** na claim, nunca no cálculo.

### FX-4 — semana com produção **já encerrada e passado o corte**

⚠️ `hub_adiantamento_repasse_pode_fechar` (`infra/hub/migrations/0067_adiantamento_funcoes.sql:1891`) exige `now() >= ((periodo_fim + 1) + horario_corte) AT TIME ZONE timezone`. Uma semana em curso devolve `PERIODO_EM_ABERTO`. Cenários de caminho feliz usam semana passada; **C6 usa semana em curso de propósito**.

---

## Cenário 1 — Caminho feliz: gerar a semana sem fechar antes (US1 · FR-001, FR-002)

**Pré**: FX-1 + FX-2 + FX-3 + FX-4. Semana **sem** apuração fechada. **Sem** adiantamento pendente. Dois motoristas com CNPJ e produção.

1. `GET /api/v1/adiantamentos/repasse?periodo=<semana>` → anotar `valor_nota` e `valor_fora_nota` **de cada motorista, como exibidos**.
2. `POST /api/v1/adiantamentos/repasse/<semana>/movimentos` com `{ "confirmacao": true }`.

**Expected**:
- `201` com `{ apuracaoId, gerados: 2, semTelefone, recusados: [] }`.
- `ApuracaoRepasse` da semana passou a **existir** (não existia no passo 1).
- Duas linhas novas em `EnvioMassa`, com `valor` e `gorjeta` **iguais aos números anotados no passo 1** (SC-002).
- Duas linhas em `ApuracaoRepasseMovimento`, apontando para os `EnvioMassa.id` criados.
- `mensagem1`/`mensagem2` renderizadas a partir do modelo da FX-1 — **não vazias, não inventadas**.
- `enviado = 'off'` e `mov_fechado = false` — estado inicial **idêntico** ao do upload de planilha.

---

## Cenário 2 — Repetir não duplica (US1-AS2 · FR-017, SC-004)

**Pré**: C1 concluído.

1. `POST .../movimentos` de novo, mesma semana.

**Expected**: `201` com `gerados: 0`, e **os dois** motoristas em `recusados` com `motivo: 'JA_GERADO'`. **Zero** linhas novas em `EnvioMassa`. **Zero** linhas novas na trilha.

---

## Cenário 3 — Retomada após falha no meio (US1-AS3 · `research.md` Decision 1)

**Pré**: semana sem apuração, três motoristas elegíveis. Injetar falha no insert do **terceiro** (ex.: indisponibilizar o PostgREST após o segundo, ou forçar erro na linha).

1. `POST .../movimentos` → falha parcial.
2. Conferir estado.
3. `POST .../movimentos` de novo, **sem nenhuma intervenção manual**.

**Expected**:
- Passo 2: apuração **fechada**; dois movimentos criados; o terceiro **sem** movimento; `recusados` inclui o terceiro com `FALHA_AO_GRAVAR`. O estado da trilha depende de **onde** a falha caiu: antes da reserva ⇒ **sem** trilha (mensagem *"nada foi gravado"*, verdadeira); depois da reserva ⇒ **com** reserva e **sem** `EnvioMassa` com aquele id (mensagem *"reserva registrada, movimento não criado"*). Ver C10b.
- Passo 3: `gerados: 1` (só o terceiro; na variante com reserva, ele é **concluído com o mesmo id** reservado); os dois primeiros em `JA_GERADO`. **Nenhum duplicado.**
- ⚠️ **O que este cenário NÃO prova**: que "o estado volta ao anterior". Não volta — `ApuracaoRepasse` é **imutável** (`infra/hub/migrations/0066_adiantamento_tabelas.sql:460`–`:461` (REVOKE) · `:463` + `:470`–`:478` (função e triggers)). Ele prova que o estado **continua** e que não existe beco sem saída, que é a garantia declarada em `research.md` Decision 1 (reinterpretação de FR-002/AS-3).

---

## Cenário 4 — Pago por fora abate a nota, gorjeta intacta (US2-AS1 · FR-005) — **com controle negativo**

**Pré**: FX-1..4. Motorista com parte da nota **R$ 100** e gorjeta **R$ 40**; um `LancamentoExterno` do tipo `ADIANTAMENTO` de **R$ 30** com `data_pagamento` dentro da semana.

1. `POST .../movimentos`.

**Expected**: `EnvioMassa` do motorista com `valor = 70.00` e `gorjeta = 40.00` (**gorjeta não muda**).

### ⚠️ Controle negativo — obrigatório

Rodar o **mesmo** cenário **sem** a migration `0118` (função de fechamento na versão `0117`).

**Expected**: `valor = 100.00` — a nota sai **bruta**. É `research.md` M5 que torna este controle obrigatório: a dedução hoje entra **só** no `remanescente`, nunca na nota. Se o cenário passar nas duas rodadas, **o teste é oco** (BRIEFING §9) e não cobre nada.

---

## Cenário 5 — Excedente zera a nota e vira saldo (US2-AS2/AS3 · FR-006, FR-007, SC-005) — **com controle negativo**

**Pré**: FX-1..4. **Duas** semanas consecutivas, N e N+1.
Semana N: motorista com parte da nota **R$ 100**, gorjeta **R$ 40**, `LancamentoExterno` de **R$ 130**.
Semana N+1: o **mesmo** motorista com parte da nota **R$ 200** — e **um segundo motorista com nenhuma produção em N+1**, só o excedente carregado de N.

1. `POST .../movimentos` para a semana N.
2. Conferir `ApuracaoRepasseItem` da semana N.
3. `POST .../movimentos` para a semana N+1.

**Expected**:
- Passo 1/2 — semana N: `nota_a_emitir = 0`, `base_nota = 100 > 0` e `gorjeta = 40 > 0` ⇒ **um movimento só-com-gorjeta** (FR-022, `dec-054`): `EnvioMassa` com `valor = 0`, `gorjeta = 40`, `total = 40`, **em `gerados`** (não em `recusados`); o motorista **não** recebe pedido de nota (o app o esconde, FR-023 — Cenário 5b); `ApuracaoRepasseItem` com `nota_a_emitir = 0`, `valor_fora_nota = 40` e `transportado_nota = −30.00` (a gorjeta segue intacta no retrato); o lote **não** o cobra como `NOTA_PENDENTE` (`0119`). ⚠️ `VALOR_ZERO` só ocorre se a base da nota já era zero (o motorista não produziu) ou se não há gorjeta — não para esta fixture.
- Passo 3 — semana N+1: `saldo_anterior_nota = −30.00` ⇒ `nota_a_emitir = 170.00`; `EnvioMassa` com `valor = 170.00`.
- Passo 3, **segundo motorista** (⚠️ o caso que o predicado da CTE deixava escapar): ele **aparece** na apuração N+1 com `saldo_anterior_nota = −30.00`, apesar de não ter produção nem `valor_transportado > 0`. É o teste do `OR COALESCE(sa.transportado_nota, 0) <> 0` no predicado da CTE `linhas` (`infra/hub/migrations/0117_lancamento_externo.sql:867`).

### ⚠️ Controle negativo — obrigatório

Rodar o passo 3 com o transporte do excedente **desligado** (ou com a função na versão `0117`).

**Expected**: `valor = 200.00` em N+1 — **maior** que os `170.00` corretos. Sem esta rodada não há prova de que o saldo **chegou**; há só prova de que um número apareceu.

---

## Cenário 5b — Movimento só-com-gorjeta e o app do motorista (FR-022, FR-023 · `dec-054`, `dec-056`) — **com controle negativo**

**Pré**: o movimento só-com-gorjeta do Cenário 5 (`valor = 0`, `gorjeta = 40`), e **outro** movimento do mesmo CNPJ com `valor > 0`.

| Sub | Ação | Expected |
|---|---|---|
| 5b-1 | `GET /motorista/movimento-aberto` | devolve o movimento de `valor > 0`; **nunca** o de valor zero, mesmo sendo o mais recente |
| 5b-2 | `POST /motorista/validar-nota` com o movimento de valor zero como único aberto | recusa; a FastAPI **nem é chamada** |
| 5b-3 | `GET /motorista/notas-pendentes` | o movimento de valor zero **não** aparece |
| 5b-4 | `POST /motorista/notas-pendentes/:id/validar` com o id do movimento de valor zero | `404`; a FastAPI nem é chamada |
| 5b-5 | `valor = 0`, `valor < 0` e `valor = NULL` | nenhum é nota emitível |

**Prova automatizada**: `tests/motorista-integration.test.js` (bloco `dec-056`, **47/0** no arquivo) e `tests/motorista-notas-pendentes-unit.test.js` (**41/0**). ⚠️ **Controle negativo por rota**: remover `VALOR_EMITIVEL` de **uma** rota por vez e ver **falhar** os testes dela (medido na FASE 8: 2, 2, 3 e 1 falhas nas quatro rotas, todas em testes da própria rota) — o mock interpreta `valor=gt.N` como o PostgREST, então o filtro ausente devolve a linha de valor 0. Sem isto o teste pode passar por mostrar a linha certa pelo motivo errado.

---

## Cenário 6 — As recusas que **não** desaparecem com D1 (`plan.md` §5)

| Sub | Pré | Ação | Expected |
|---|---|---|---|
| 6a | semana **em curso** (antes do corte D-1) | `POST .../movimentos` | `409 PERIODO_EM_ABERTO`. **Nada fechado, nada criado.** A tela diz **até quando esperar** |
| 6b | semana anterior não processada | `POST .../movimentos` na semana seguinte | `409 APURACAO_FORA_DE_ORDEM` |
| 6c | sem `AdiantamentoConfiguracao` vigente | `POST .../movimentos` | `409 APURACAO_NAO_CONFIGURADA` |
| 6d | data que não é início de semana de apuração | `POST .../movimentos` | `409 PERIODO_DESALINHADO` |
| 6e | `Empresa.cnpj` ausente | `POST .../movimentos` | `409 EMPRESA_SEM_CNPJ` |

⚠️ 6a é a recusa **mais provável e mais confundível com defeito**. `periodoAberto` na tela significa *"sem apuração fechada"* (`app_homologacao/backend/routes/hub-adiantamentos.js:1962`), **não** "antes do corte" — confundir os dois gera diagnóstico errado.

---

## Cenário 7 — Sem `categorias_nota`: recusa, não arbitra rateio (US5-AS3 · `research.md` Decision 4)

**Pré**: FX-1 + FX-3 + FX-4, **sem** FX-2 (`categorias_nota` ausente). Motorista com produção **e** um `LancamentoExterno` de dedução.

1. `POST .../movimentos`.

**Expected**:
- `201` com o motorista em `recusados`, `motivo: 'SEM_DIVISAO'`. **Nenhum movimento criado** para ele.
- `ApuracaoRepasseItem.nota_a_emitir` = **`NULL`** (não `0` — `0` colidiria com `VALOR_ZERO`).
- `transportado_nota` **não** recebe excedente: sem parte-da-nota não há de onde deduzir, e nada é transportado no livro da nota.
- A dedução no **caixa** continua aplicada como hoje (`remanescente` reflete o `LancamentoExterno`), inalterada pela `0118`.

---

## Cenário 8 — Sem modelo de mensagem: recusa e avisa (US5-AS3 · FR-012/D10)

**Pré**: FX-2 + FX-3 + FX-4, **sem** FX-1 (`mensagem1_modelo` NULL). Motorista elegível.

1. `POST .../movimentos`.

**Expected**: a geração é recusada com aviso explícito e **nenhum texto de mensagem é inventado**. ⚠️ Este cenário é a razão de FX-1 existir: sem a fixture, **todos** os outros cenários cairiam aqui silenciosamente.

---

## Cenário 9 — Recusa por adiantamento pendente, nomeando quem trava (US3 · FR-008, FR-009, SC-006)

**Pré**: FX-1..4. Semana **sem** apuração. **25** adiantamentos pendentes: 10 `LIBERADA` + 15 `EXPORTADA`, de 25 motoristas distintos.

1. `POST .../movimentos`.

**Expected**:
- `409` com `erro: 'ADIANTAMENTOS_PENDENTES'`, `total: 25`, `porStatus: { LIBERADA: 10, EXPORTADA: 15 }`, `motoristas` com **20** itens (`entregadorId`, `nome`, `status`) e `motoristasOmitidos: 5`.
- **Nada fechado**: `ApuracaoRepasse` da semana **continua não existindo**.
- **Nada criado**: zero linhas em `EnvioMassa`, zero na trilha.
- ⚠️ **Asserção de privacidade**: o corpo da resposta **não contém** `cnpj`, `cnpj_prestador`, telefone, conta bancária nem valor monetário. Teste por varredura das chaves do JSON, não por inspeção visual.

### 9b — Pendência **com apuração já fechada** (o caso que o RPC não cobre)

**Pré**: semana **com** apuração já fechada; adiantamento liberado **depois** do fechamento.

1. `POST .../movimentos`.

**Expected**: `409 ADIANTAMENTOS_PENDENTES`. ⚠️ Este é o cenário que prova por que o pré-flight é **da rota** e não do RPC: a checagem `APURACAO_COM_PENDENCIAS` vive **dentro** do fechamento (`infra/hub/migrations/0117_lancamento_externo.sql:759`–`:771`) e **não roda** quando a apuração já existe.

### 9c — Resolvidos os pendentes, passa (US3-AS2)

1. Resolver os 25. 2. `POST .../movimentos`.

**Expected**: `201`, geração normal, **sem estado residual** da tentativa recusada.

---

## Cenário 10 — Concorrência: dois financeiros, a mesma semana (Edge Case · achado **S1**) — **com controle negativo**

**Pré**: semana sem apuração, motoristas elegíveis.

1. Disparar **dois** `POST .../movimentos` simultâneos para a mesma semana.

**Expected**:
- Exatamente **uma** `ApuracaoRepasse` (serializada pelo `pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'))`, `infra/hub/migrations/0117_lancamento_externo.sql:732`).
- **No máximo um** movimento por motorista: a segunda requisição bate no `UNIQUE (apuracao_id, entregador_id)` da **reserva**, **antes** de qualquer escrita em `EnvioMassa`.
- O segundo acionamento vê os motoristas do primeiro como `JA_GERADO`. ⚠️ `APURACAO_JA_FECHADA` **não** vaza como erro para o financeiro: a rota relê a apuração e segue.

⚠️ **Controle negativo obrigatório**: rodar **sem** a reserva (ordem de hoje: `EnvioMassa` primeiro, trilha depois, `jaGerados` lido uma única vez no início) ⇒ **duas** linhas em `EnvioMassa` para o mesmo motorista, **nota fiscal em dobro**. É o estado atual do código (`:2309`–`:2323`) e é a razão de S1 ser bloqueante. Se este cenário passar com e sem a correção, ele não está exercitando a corrida — provavelmente as duas requisições não se sobrepuseram de fato.

### 10b — Reserva sem movimento, a mensagem que mente, e a conclusão com o mesmo id (parte do **S1**)

**Pré**: um motorista elegível; injetar falha no `POST EnvioMassa` **depois** de a reserva ter sido gravada (não-PK, ex.: PostgREST indisponível só para essa tabela).

1. Acionar a geração com a falha injetada.
2. Ler a resposta da rota.
3. Conferir o banco.
4. Reacionar **sem** a falha injetada.

**Expected**:
- Passo 2 — `FALHA_AO_GRAVAR` cujo texto afirma que **a reserva foi registrada e o movimento não foi criado** (o motorista **não** recebeu nota) e que tentar de novo é seguro. ⚠️ Asserção **no texto literal**: não pode conter *"nada foi gravado para este motorista"* — é a frase falsa que S1 nomeia, e o operador que a lê tenta de novo e duplica nota fiscal.
- Passo 3 — **uma** linha em `ApuracaoRepasseMovimento` com `envio_massa_id` **preenchido** (alocado por `nextval` **antes** das duas escritas) e **zero** linhas em `EnvioMassa` com aquele id. Estado **decidível**: `NOT EXISTS (SELECT 1 FROM "EnvioMassa" e WHERE e.id = m.envio_massa_id)`.
- Passo 4 — o movimento é **concluído com o MESMO id**: **uma** linha de `EnvioMassa` cujo `id` = `envio_massa_id` da reserva, **uma** reserva (nenhuma foi apagada), **zero** duplicatas.

⚠️ **Controle negativo 1 (mensagem)**: no código de hoje a mesma injeção deixa uma linha de `EnvioMassa` **órfã** (sem trilha) e o `catch` (`:2321`) afirma *"nada foi gravado para este motorista"* — **falso**; o retry **duplica**, porque não há trilha para recusar.
⚠️ **Controle negativo 2 (o mesmo id)**: concluir a reserva com um id **novo** (`nextval` de novo) em vez do reservado ⇒ **duas** linhas de `EnvioMassa` para o motorista. Prova que é o **mesmo id** — e não o UNIQUE sozinho — que entrega a garantia. (Reverter a alteração de teste e conferir **no arquivo** antes de medir o controle seguinte.)
⚠️ **Por que não se testa `envio_massa_id IS NULL`** nem "reserva liberada/apagada": esses estados **não existem** neste desenho. O `NULL` era de `dec-030`, descartado porque não distingue "nota não criada" de "nota criada e id perdido" (sem chave natural: `0033:126`, `:150`–`:156`); a liberação por `DELETE` era de `dec-034`, descartada porque não distingue órfã de em andamento.

### 10c — Duas conclusões concorrentes da MESMA reserva (a corrida que `dec-034` perdia)

**Pré**: reserva sem movimento criada como em 10b (passos 1–3).

1. Disparar **dois** `POST .../movimentos` simultâneos.

**Expected**: exatamente **uma** linha de `EnvioMassa` com o id reservado; uma das respostas traz o motorista em `gerados`, a outra em `recusados` com `JA_GERADO`. Nenhuma linha da trilha é apagada. **Nenhuma** dependência de tempo (rodar com atrasos artificiais de 0, 100 e 1000 ms entre as requisições dá o mesmo resultado).

⚠️ **Controle negativo**: a mesma rodada contra uma variante que **apaga** a reserva "órfã" antes de recriar (`dec-034`) ⇒ **duas** linhas de `EnvioMassa`. É a objeção que tornou aquele desenho inviável; se não duplicar, as requisições não se sobrepuseram.

---

## Cenário 11 — Movimento da planilha convive (US5-AS1 · FR-010/D6)

**Pré**: motorista elegível que **já tem** movimento aberto na `EnvioMassa`, do grupo Movee.

1. `POST .../movimentos`.

**Expected**: recusado com `motivo: 'MOVIMENTO_ABERTO'`, detalhe *"O motorista já tem movimento aberto (provavelmente da planilha)."* Nenhum movimento novo.

### 11b — Tenant: movimento de **outra** empresa não conta (FR-018 · achado **S7**) — **com controle negativo**

**Pré**: o mesmo CNPJ com movimento aberto numa empresa **fora** do grupo Movee.

**Expected**: **não** recusa por `MOVIMENTO_ABERTO` — o movimento de outro tenant não é visível para esta contagem.

⚠️ **Controle negativo obrigatório, e aqui ele é o ponto**: rodar **sem** o filtro de S7 ⇒ o motorista **é** recusado com `MOVIMENTO_ABERTO` e **não recebe nota**. É assim que o código está **hoje** (`hub-adiantamentos.js:2250`–`:2251`, sem `id_empresa`; `lib/hub-postgrest-lotes.js:39` só acrescenta `campoId=in.(...)`) — logo este cenário **tem de falhar antes da correção**. Se passar nas duas rodadas, o teste não está exercitando o filtro.

⚠️ A `EnvioMassa` **não tem RLS**: o filtro na query é a única proteção, e a resolução usa `mesmoGrupoQue(_, 6)`, nunca `id_empresa === 6` estrito.

---

## Cenário 12 — Retenção abaixo do mínimo preservada (US5-AS2 · FR-011/D7)

**Pré**: motorista cujo total da semana fica abaixo de **R$ 5,50**.

**Expected**: recusado com `motivo: 'RETIDO'`; nenhuma nota; o valor transportado para a semana seguinte pelo mecanismo já existente. Comportamento **idêntico** ao de antes da frente (SC-008).

---

## Cenário 13 — UI: as duas telas, um componente (US4 · FR-013..FR-016, SC-007)

| Sub | Ação | Expected |
|---|---|---|
| 13a | Abrir a tela de Repasse com semana **aberta** | **Não existe** mais o botão "Fechar apuração"; "Gerar" está **habilitado** (hoje está desabilitado — ⚠️ o teste tem de **falhar antes** da mudança, senão é oco) |
| 13b | Acionar na tela de Repasse | Processa **a semana em exibição** (D9), sem seletor próprio |
| 13c | Abrir a tela de Envio em Massa, ao lado do upload | Botão "Gerar do repasse" presente, **com** seletor de semana (ali não existe semana na tela), default = início da semana de apuração |
| 13d | Acionar nas duas telas para a **mesma** semana | Resultado **idêntico**; `gerarMovimentos` chamada **uma** vez por acionamento (prova de FR-015) |
| 13e | Usuário **sem** `adiantamentos.pagamento_confirmar` | Botão **não renderiza** em nenhuma das duas telas |
| 13f | Painel legado **sem sessão de hub** | Botão **não renderiza**; **nenhum redirect** (o `HubAuthProvider` é montado sem o `HubSessionGuard`) |
| 13g | Recusa de pendências | Abre **diálogo com a lista** (contagem por status + nomes + omitidos), não um toast |

---

## Cenário 14 — Roundtrip End-to-End (obrigatório: borda backend↔frontend)

Chamada **real** ao backend do `hub-homolog` (não mock, não fixture de resposta), capturando o payload e comparando o **shape** contra `contracts/hub-repasse-gerar-movimentos.md`.

1. Autenticar de verdade (JWT com claim de escopo — FX-3), via o proxy `app/api/[...path]`.
2. `POST /api/v1/adiantamentos/repasse/<semana>/movimentos`.
3. Capturar o JSON **cru** da resposta.

**Expected**:
- `201` com **exatamente** as chaves `apuracaoId`, `gerados`, `semTelefone`, `recusados` — e `recusados[]` com `entregadorId`, `nome`, `motivo`, `detalhe`.
- Todas em **`camelCase`**. ⚠️ Esta asserção existe porque um drift `snake_case` × `camelCase` sobreviveu 40 ondas nesta base por os testes parsearem **mocks** em vez do payload real.
- Repetir para o `409 ADIANTAMENTOS_PENDENTES`: chaves `total`, `porStatus`, `motoristas`, `motoristasOmitidos`, e `motoristas[]` com `entregadorId`, `nome`, `status` — **e nenhuma** chave de CNPJ/telefone/conta/valor.

---

## Cenário 15 — Fluxo depois do movimento: inalterado (FR-020/D12 · SC-008)

**Pré**: C1 concluído (movimentos gerados pelo repasse).

1. Seguir o fluxo existente: disparo, emissão de nota, validação de XML, fechar movimento.

**Expected**: tudo funciona como com uma linha de **planilha** — a linha gerada é **indistinguível** (decisão já vigente, registrada em `app_homologacao/backend/routes/hub-adiantamentos.js:2170`–`:2171`). Nenhuma mudança na FastAPI de validação. "Fechar movimento" segue manual e opcional.

---

## O que medir antes de declarar a frente verde

Todos os gates de `plan.md` §Gates, **com números**, comparados à baseline de 2026-10-28. Mais:

- ⚠️ `package-lock.json` **sem diff** — o container do Playwright o reescreve a cada E2E, via bind mount. Conferir e reverter **antes** de commitar (já foi pego 2× por acaso na mesma sessão).
- ⚠️ `df -h /` (abortar com menos de ~20 GB livres) **e** swap ativa **antes** de qualquer `next build` / `docker build`.
- ⚠️ Os E2E rodam pelos **drivers** `infra/hub/testes/*.sh` (Playwright dentro do container oficial) — **nunca** instalar browsers no host.
- ⚠️ `cd` da tool Bash **persiste entre chamadas**: ancorar cada comando com `cd` explícito na raiz, senão a guarda `session-scope` recusa com `verdict=diverged`.
- ⚠️ Os **dois controles negativos** (C4 e C5) rodados e **com resultado diferente** da rodada corrigida. Teste que passa com e sem a correção é **achado**, não cobertura.
