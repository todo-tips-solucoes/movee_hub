# Trabalho deferido — `repasse-gera-movimento`

**Criado**: 2026-10-28, por decisão do operador em `block-001` (resposta: **Opção B**).
**Fonte autoritativa da decisão**: `.human_blocks[0].human_answer` no state da execução (`.claude/feature-00c-state/repasse-gera-movimento/`), Decisões `dec-020`…`dec-027`.

> Este arquivo existe para que **alarme não sobreviva à causa nem morra com ela em silêncio**. Cada item tem o que foi medido, por que foi deferido e — onde aplicável — **o gatilho que o torna bloqueante de novo**.

---

## S2 · 🔴 high — permissão checada na entidade ativa, escrita na Movee

**Status**: **DEFERIDO com gatilho medido** · `dec-021`

**O defeito**: `resolverContextoAdiantamentos` valida `adiantamentos.pagamento_confirmar` **na entidade ativa do usuário** e, quando `entidadeAtiva !== GRUPO_MOVEE_ID`, apenas define `escopo = [entidadeAtiva]` e **retorna com sucesso, sem 403**. A rota usa `GRUPO_MOVEE_ID` (= `6`, `hub-adiantamentos.js:79`) e o RPC grava `id_empresa = 6` **hardcode** (`0117:776`; itens em `:909`). As leituras de `ApuracaoRepasse` dentro do RPC também usam `id_empresa = 6` (`0117:738`, `:742`, `:788`), não o escopo do token.

**Consequência se explorado**: quem tiver a permissão em outra entidade fecha uma apuração **da Movee**, com entregadores de outra empresa gravados como itens dela (mistura cross-tenant em tabela de dinheiro). E como `ApuracaoRepasse` é **imutável** (`0066:460`–`:461`, `:470`–`:478`), essa apuração errada **avança o "último fechado"** e **trava a semana real** com `APURACAO_FORA_DE_ORDEM`, **sem caminho de volta**.

**Por que foi deferido** — medição do operador em **produção, 2026-10-28**: a permissão `adiantamentos.pagamento_confirmar` existe em **5 usuários, TODOS na empresa 6**. **Zero portadores fora da Movee**, ainda que existam vínculos ativos em **8 empresas**. Ou seja: hoje não há quem exercite o caminho.

### ⚠️ GATILHO DE REABERTURA — torna S2 bloqueante

> **O primeiro vínculo fora da empresa 6 cujo papel carregue `adiantamentos.pagamento_confirmar`.**

Quem conceder esse papel a um vínculo de outra entidade **tem de** corrigir S2 antes, ou aceitar a exposição conscientemente. ⚠️ **Atenção ao modo de falha conhecido desta base**: o papel `financeiro_aprovador` nasceu como **cópia** de `financeiro` na `0097` e **não há vínculo vivo entre os dois** — uma permissão nova dada só a `financeiro` **não** se propaga. Quem editar a matriz papel×permissão precisa checar **os dois** (e qualquer papel novo) contra este gatilho.

**Mitigação quando reabrir**: `403` antes do pré-flight se `entidadeAtiva` não pertencer ao grupo Movee (`mesmoGrupoQue`), **e** asserção `6 = ANY(hub_jwt_escopo_ids())` dentro do RPC. Teste negativo com JWT de outra empresa **que tenha** a permissão.
⚠️ A correção **toca `POST /repasse/:periodo/fechar`**, rota em produção — foi exatamente o motivo do deferimento (*"NÃO toque `/repasse/:periodo/fechar` nesta frente"*).

**Como monitorar sem depender de memória humana**: uma consulta que liste vínculos ativos cujo papel carregue a permissão, agrupados por `id_empresa`, e alarme quando aparecer `id_empresa <> 6`. ⚠️ Um alarme escopado à causa **não vê quem removeu a causa** — então a consulta deve partir da **matriz papel×permissão vigente**, nunca de uma lista de papéis fixada hoje.

---

## S3 · 🟡 medium — sem rate limit na rota de geração

**Status**: deferido

A rota `POST /repasse/:periodo/movimentos` (e a `/fechar`) não têm limiter, enquanto as irmãs têm (`lancamentoExternoRateLimiter`, `exportarRepasseRateLimiter`). A rota faz ~10 chamadas PostgREST + N inserts por requisição **e escreve dinheiro**.

**Mitigação**: limiter por **usuário** — chave `sub` + entidade — na faixa de 5–10 req/15 min.
⚠️ **Nunca por IP**: rate limit por IP é bug em produto multi-operador (precedente desta base, 2026-10-10).
⚠️ **Não substitui S1**: com a reserva da trilha corrigida nesta frente, a duplicata já está fechada por integridade; o limiter é sobre consumo de recurso, não sobre corretude.

---

## S4 · 🟡 medium — identidade dupla hub ↔ legado na tela de Envio em Massa

**Status**: deferido

Montar `HubAuthProvider` em `app/dashboard/layout.tsx` **sem** o `HubSessionGuard` é só controle de UI, e o servidor segue autoritativo. Os dois riscos reais:

1. O botão age com a identidade do **cookie do hub**, enquanto a página mostra o usuário **legado** (navegador compartilhado).
2. O `GET /me` extra passa pelo proxy `app/api/[...path]`, que **renova ou limpa cookies** ao ver `accessToken` ausente/vencido — em sessão só-legado isso pode gerar tentativa de refresh ou toque em cookie legado, que é justamente o caminho que o desenho diz evitar (colisão de cookie hub↔legado, incidente conhecido).

**Mitigação**: diálogo de confirmação exibindo **nome do usuário e entidade do hub** antes de gerar.
**Teste quando for feito**: sessão só-legado ⇒ `/me` 401, `permissoes = []`, **nenhum** `Set-Cookie`, **nenhum** refresh em laço, login legado **intacto**.

---

## S6 · 🟢 low — três amarras do 409 com nomes

**Status**: deferido (as amarras, não o desenho — o corpo sem CNPJ/telefone/conta/valor já está no contrato)

1. `id_empresa=in.(<escopo>)` **obrigatório** na consulta de pendências.
2. **Log só com contagens**, nunca nomes.
3. Front renderiza nomes como **texto**, sem HTML.

---

## Dívidas de produto nomeadas (não são segurança)

| Dívida | Por que não agora |
|---|---|
| **App do motorista mostra a nota BRUTA + o pago por fora em linha separada; o hub passa a mostrar a nota LÍQUIDA** | App explicitamente fora de escopo (BRIEFING §5 *Fora*). Os dois números são verdadeiros; o que divergiu é o **vocabulário**. ⚠️ Unificar exige **abrir a tela do app e mostrar onde o dado já aparece** antes de propor rótulo novo — regra do `CLAUDE.md`, nascida do incidente de 23/09 |
| **O excedente do pago por fora é transportado no livro da NOTA, não no do CAIXA** | Levá-lo ao caixa exigiria alterar o CHECK `apuracaorepasseitem_saldo_conserva` (`0098:71`–`:81`) em tabela de dinheiro **imutável** — o que a própria `0117:682`–`:685` se recusou a fazer. Se o operador quiser simetria caixa↔nota, é decisão de negócio + migration dedicada |
| **`id_empresa` hardcode `6` nas escritas do fechamento** | Pré-existente, fora de escopo. Nomeado para que ninguém o leia como introduzido por esta frente. Ligado a S2 |
| **As 5 cópias da fórmula de início de semana** | Dívida que a `0117:17`–`:21` já nomeou e deliberadamente não pagou: refatorar obrigaria a redeployar 5 funções de dinheiro vivas sem requisito pedindo |

---

## O que **não** é deferível

| Item | Onde |
|---|---|
| **S5** — `REVOKE ALL ... FROM PUBLIC` após cada `DROP FUNCTION`+`CREATE` na `0118` | Decisão literal do operador: *"S5 é OBRIGATÓRIO na 0118, não é deferível"*. Padrão já usado em `0067:2278`–`:2279`. ⚠️ Teste de ACL com `has_function_privilege('anon', ...) = false` |
| **S1** — reserva da trilha antes do `EnvioMassa` + conserto da mensagem falsa do `catch` | `block-001` opção B · `plan.md` §S1 (mecanismo único, `dec-038`/`dec-040`) · §O mecanismo da reserva do S1 (histórico) |
| **S7** — filtro de `id_empresa` na consulta de movimento aberto | `plan.md` §S7 (incluído por aplicação do critério do operador; **vetável**) |
| **§2.bis** — `CASE`/`COALESCE` no fechamento, senão o caso central de D3 cai em `SEM_DIVISAO` | `plan.md` §2.bis · `dec-024` |

## 🔴 PENDÊNCIA DO OPERADOR — antes do primeiro uso

**A configuração vigente da Movee tem `mensagem1_modelo` NULO.** Medido em produção em
2026-10-28: `AdiantamentoConfiguracao` da empresa 6, versões 19, 20 e 21 (a atual, vigente
desde 24/10) — todas com o campo nulo. `categorias_nota` **está** preenchida.

Com a regra D10 implementada (`MODELO_MENSAGEM_AUSENTE`), a geração **recusa todos os
motoristas** enquanto o campo estiver nulo. Isso é a regra funcionando, não defeito — mas
sem o cadastro a feature fica **inerte**, o mesmo modo de falha que originou esta frente.

**Decisão do operador (28/10):** o código fica **inalterado** — nunca inventar o texto que
o motorista lê sobre dinheiro. O modelo é cadastrado **pela tela** (Configurações do
adiantamento) antes do primeiro uso, e a recusa serve como alarme de configuração faltando.

⚠️ Quem escrever o roteiro de validação: **cadastrar o modelo é o passo 1**, antes de
qualquer tentativa de gerar.

## Onda-009
- **E2E de browser (5.5.1, 5.5.2, 4.7.2, 4.7.3 e a parte de banco real de 5.2.1)**: `hub-adiantamentos-e2e-browser.sh` e `hub-shell-e2e-browser.sh` nao foram executados. O spec `adiantamentos.spec.ts` foi reescrito (2 testes) e so esta tipado, nao executado. Conferir/reverter `package-lock.json` depois (o container do Playwright o reescreve).
  - ✅ **RESOLVIDO PELA METADE em 29/10**: o operador liberou disco (19 → 21 GiB, ganho real de 1.702 MB) e o
    **`hub-adiantamentos-e2e-browser.sh` RODOU: 15/15 em TRES rodadas consecutivas** (13,1s/13,2s/13,4s), estavel.
    A guarda dele (`:54`, 21 GiB) passou com ~135 MB de margem. `package-lock.json` intacto nas 4 execucoes.
    Fechou 5.5.1, 5.5.2 e a parte de DOM de 4.7.2 que exigia browser.
    - 🔴 A primeira rodada deu **3 falhas, nenhuma defeito de producao**: eram 3 stubs do proprio spec violando o
      contrato TS (resumo sem `qtdNegativo` ⇒ botao disabled para sempre; lancamento sem `semanaFechada`, obrigatorio
      e herdado do PR #299; e locator ambiguo em strict mode, 2x). O `tsc` nao pega: objeto literal em `json(200, …)`.
    - ⏳ **RESTA o `hub-shell-e2e-browser.sh`**, e o motivo NAO e disco (ele nao tem guarda de disco e nao builda):
      ele roda contra o `hub_homolog_frontend`/`_backend` servidos, cujas imagens sao de **14/10** e nao tem bind
      mount do codigo. Rodar sem rebuildar validaria codigo anterior a esta frente — teste oco, nao cobertura.
      **Gatilho**: rebuildar `hub-frontend:homolog` e `hub-backend:homolog` desta entrega (~2 GB cada) e recriar os
      containers. Com 21 GiB cabe, mas o operador precisa de ~6 GB para os 3 builds de producao do deploy — por isso
      nao foi feito por iniciativa propria: a prioridade do disco e dele.
      ⚠️ O banco do `hub_homolog` tem a **0118** aplicada mas **nao a 0119** (medido: `SchemaMigration` para em
      `0118_repasse_nota_a_emitir.sql`) — aplicar antes, senao o cenario so-gorjeta do lote nao vale.

- **Cadastrar `mensagem1_modelo` e o primeiro passo do roteiro de validacao** (dec-049): sem o modelo a geracao recusa TODOS (`MODELO_MENSAGEM_AUSENTE`). Aviso proativo na tela: FEITO (dialogo de "Gerar do repasse" avisa antes de confirmar; ver evidencias.md).
- ~~**[ALTO, decisao de produto] Gorjeta presa quando o pago por fora zera a nota**~~ **RESOLVIDO (dec-054, decisao do operador 28/10)**: a nota zerada por deducao, com gorjeta, gera o movimento so-gorjeta (FR-022; `0119` para o lote); o app do motorista o esconde (FR-023, dec-056). Ver `evidencias.md` §dec-054. ✅ **Fechado por completo na onda-013** (`dec-065`): o texto de "Limites conhecidos" do `RUNBOOK-DEPLOY.md` ainda declarava a gorjeta presa como limite vigente com "decisão de produto PENDENTE" — foi reescrito como RESOLVIDO, e a `0119` entrou no runbook como **Passo 2b** com verificação e rollback próprios (`dec-066`). Nada mais pendente deste item.
- **Nota liquida invisivel no CSV/tela** (achado 2): expor `nota_a_emitir` pede coluna nova no CSV (contrato do roundtrip) e vocabulario novo - decidir com o financeiro.
  - ⚠️ **Severidade reforcada pela revisao adversarial de 28/10 (2 camadas independentes, edge M1 + blind M1)**: a consequencia nao e so
    "falta uma coluna". O CSV e a tela mostram `valorNota` **BRUTO** (`routes/hub-adiantamentos.js:2114`), e o financeiro confirma uma
    acao **IRREVERSIVEL** (o fechamento) vendo `100,00` quando a nota sera emitida por `70,00`. A `0118` cita SC-002 ("a tela mostra o
    que a geracao usara") e esse fio **nao esta ligado**: `grep notaAEmitir` no `frontend_v2` = 0 ocorrencias. `transportado_nota`
    (a divida de nota carregada) nao e devolvido por nenhuma das duas RPCs — e invisivel no hub inteiro.
  - Segue **deferido de proposito**, nao por esquecimento: a coluna nova muda o contrato do CSV que o driver de roundtrip verifica, e o
    rotulo e vocabulario ("nota a emitir" x "valor da nota") cria um segundo nome para a mesma conta — o projeto tem regra explicita
    contra isso (CLAUDE.md, "Propor UI nova"). **Gatilho**: decisao do financeiro sobre o rotulo.
- **`EMPRESA_SEM_CNPJ` antes do fechamento implicito** (achado 6): mover a leitura de `Empresa.cnpj` para antes do RPC de fechar; hoje e retomavel.

## Onda-015 (correcao dos 3 achados da revisao adversarial, dec-073)

- **Corrigidos**: (1) disparo WhatsApp filtra `valor > 0` (`lib/disparo-alvo.js`, usado por `processBatchMessages`); (2) `0119` com gate estreito `(nota_a_emitir IS DISTINCT FROM 0 OR com_valor > 0)` + fixture multi-movimento no driver do lote com controle negativo; (3) chave unica `valor > 0`: `0119` ignora movimento de valor <= 0 em `total`/`aprovadas`, `/upload` e `corrigir-valor` recusam `valor <= 0`; auditoria `repasse_fechado` emitida logo apos o RPC, antes do laco.
- **Registro (dependencia 0118 -> 0119)**: o "bonus" NAO se confirmou — a `0119` continua lendo `nota_a_emitir` (coluna da `0118`), entao a ordem `0118` antes de `0119` FICA no deploy.
- **DEFERIDO — `nextval` x `max(id)` do legado** (`hub_repasse_alocar_envio_id`, 0118): nenhuma migration faz `setval`; colisao seria rotulada `JA_GERADO`. **Gatilho**: antes do deploy, o operador confere `SELECT last_value FROM "EnvioMassa_id_seq"` >= `SELECT max(id) FROM "EnvioMassa"`; se menor, `setval` ANTES da `0118` (ato do operador, rito de producao). So implementar rotulo/guarda no codigo se a conferencia falhar ou aparecer `JA_GERADO` sem trilha.

## Dívida da revisão final (28/10, não corrigida)

- **M1** — o disparo pula em silêncio movimento com `valor <= 0`; se TUDO for `valor <= 0`, devolve **500** em vez de "nada a emitir".
- **M2** — a `mensagem1` com "R$ 0,00" continua gravada em movimentos antigos e o painel a **exibe** (o conserto filtrou o consumidor, não a fonte).
- **M3** — o log removeu `e.message`; sobra só `status 403`, exatamente como o ALTO do `nextval` (42501) se manifestaria. Restaurar a causa no log.
- **M5** — no card da home o motorista não vê nada da semana só-gorjeta (nem gorjeta, nem total). Declarado no RUNBOOK em "Limites conhecidos".

## Deferred from: code review de repasse-gera-movimento (2026-10-28)

Revisão adversarial de 3 camadas sobre o commit `1ae29af`, antes do PR. Achados classificados
como `defer` (os `decision`/`patch` estão na seção "Review Findings" de `spec.md`):

- **Divergência entre a linha da `EnvioMassa` e o valor pago, numa semana isolada**
  (`lib/adiantamento-geracao-movimento.js:166`). Com nota 40 / fora-nota 200 / dedução 70: o
  repasse paga 170 e o movimento sai `valor 0 + gorjeta 200`. **Herdado e REDUZIDO por esta
  entrega** — o gap cai de 70 para 30, porque antes a nota saía bruta. Fecha em duas semanas
  (o revisor conferiu a aritmética: 270 de caixa contra 270 de documentos). Fica aberto porque
  a gorjeta nunca é abatida, e o resíduo agora vira redução de uma nota **futura** — mais
  difícil de explicar que o gap antigo. **Gatilho para fechar**: decisão de produto sobre abater
  a gorjeta.
- **Botão na `ActionBar` com seletor de data livre, enquanto a rota usa `GRUPO_MOVEE_ID` fixo**
  para `ApuracaoRepasse` mas `claims.escopo` no pré-flight. Um operador de outro tenant com
  `adiantamentos.pagamento_confirmar` fecharia apuração estampada como empresa 6. Hoje
  `requireModuloAtivo('adiantamentos')` segura, e a apuração é imutável. É o mesmo S2 já
  registrado (0 portadores fora da empresa 6). **Gatilho**: ativar o módulo adiantamentos para
  qualquer outro cliente.
- **`valor=gt.0` é retroativo**: linha histórica com `valor` 0 ou NULL sai de `/notas-pendentes`
  e passa a dar 404 em `/notas-pendentes/:id/validar`, para um motorista que ontem via a
  pendência. **O volume NÃO foi medido** — a consulta (`count(*) FROM "EnvioMassa" WHERE
  COALESCE(valor,0) <= 0`, todos os tenants) foi **bloqueada pelo classificador do harness** e
  não foi contornada. **Gatilho**: medir antes do deploy; é um `count(*)`.
- **`EMPRESA_SEM_CNPJ` é checado DEPOIS do fechamento implícito**
  (`routes/hub-adiantamentos.js:2238-2270` fecha, `:2330` recusa). A rota pré-checa o modelo de
  mensagem antes de fechar de propósito ("o fechamento é irreversível") e não faz o mesmo com o
  CNPJ. **Não é deadlock** — medido: o botão não depende do estado do período, reapertar relê a
  apuração e gera. Conserto: mover o check para antes do fechamento, junto do modelo.
