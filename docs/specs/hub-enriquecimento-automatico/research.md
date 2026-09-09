# Research: Enriquecimento automático de entregadores novos

Documento produzido no Phase 0 do `/plan` (feature `hub-enriquecimento-automatico`).
Resolve os unknowns técnicos antes do design.

> **Princípio VI (veracidade)**: todo nome de coluna, rota, função SQL e
> assinatura citado abaixo veio de leitura real do código/migrations deste
> repositório, com arquivo e linha. Nada foi suposto a partir de convenção.

---

## Decision 1 — Distinguir INSERT de UPDATE no upsert de `Entregador`: trigger no banco, escopado pela claim de importação

> ⚠️ **Estendida pela Decision 8** (onda-005, após `block-003`): a decisão
> continua valendo integralmente — gatilho `BEFORE … FOR EACH ROW` no banco,
> escopado pela claim. O que mudou: ele passa a cobrir também o evento
> `UPDATE` e a consultar habilitação/teto. Leia junto com a Decision 8.

**Decision**: a distinção NÃO é feita na aplicação. A migration `0060` cria um
trigger `BEFORE INSERT` em `"Entregador"` que grava
`dados_entrego_solicitado_em := now()` **apenas** quando
`hub_jwt_origem_importacao()` é verdadeiro. O `lib/hub-import-processor.js`
**não muda uma linha**.

**Rationale**:

1. O PostgREST não sinaliza quais linhas do upsert foram inseridas e quais
   foram atualizadas — a resposta `return=representation` devolve as linhas
   afetadas sem marcar a origem. Confirmado em
   `app_homologacao/backend/lib/hub-import-processor.js:344-347`, que só
   consegue extrair `linha.id_externo` → `linha.id`, e em
   `app_homologacao/backend/lib/hub-postgrest.js:60`, onde o único `Prefer`
   de retorno é `return=representation` / `return=minimal`.
2. No banco a distinção é **nativa e gratuita**: `merge-duplicates` é, sob o
   capô, um `INSERT ... ON CONFLICT DO UPDATE`, que tem dois ramos
   fisicamente distintos. Um trigger `BEFORE INSERT` só dispara no ramo de
   inserção — nunca no de atualização. Fonte no próprio repositório
   (`docs/specs/hub-motoristas/research.md:240-243`):

   > "o payload do upsert de reimportação envia **apenas**
   > `{id_empresa, id_externo, nome}` … ou seja, o único campo que uma
   > reimportação pode alterar em um `Entregador` já existente é `nome`. Um
   > trigger `BEFORE UPDATE` intercepta esse UPDATE (o `merge-duplicates` do
   > PostgREST é, sob o capô, um `INSERT ... ON CONFLICT DO UPDATE`, que
   > dispara triggers normalmente)"

   Esse não é um raciocínio teórico: a migration `0019` + `0025` já colocaram
   um trigger nessa **mesma tabela** apoiado nessa mesma propriedade, e ele
   roda em produção desde o cutover G3.
3. **Corroboração empírica adicional (defaults disparam no ramo INSERT)**: o
   payload do upsert tem só 3 colunas, mas toda linha de `Entregador` criada
   por importação em produção tem `ativo = true` e `criado_em` preenchidos —
   valores que só podem ter vindo dos `DEFAULT` da migration `0010:20-21`.
   Ou seja, colunas ausentes do payload recebem seu `DEFAULT` no ramo INSERT
   e ficam intocadas no ramo `DO UPDATE`. É exatamente a propriedade da qual
   FR-002 depende.
4. FR-002 ("MUST NOT alterar o estado de fila de um entregador que já
   existia") passa a ser garantida **estruturalmente**, não por disciplina de
   código: não existe caminho de UPDATE que toque a coluna. Nenhum teste
   pode regredir isso sem antes derrubar o trigger.
5. FR-003 (um identificador externo repetido no lote conta como uma única
   criação) já é garantido duas vezes antes de chegar ao trigger: o
   `Map` de dedupe em `hub-import-processor.js:316-325` colapsa o lote por
   `id_externo`, e a `UNIQUE (id_empresa, id_externo)` de `0010:23` garante
   uma única linha. O trigger dispara uma vez por INSERT real.

**Alternatives considered**:

| Alternativa | Prós | Contras | Custo | Veredito |
|---|---|---|---|---|
| **(a) Pré-`SELECT` dos `id_externo` existentes antes do upsert** e derivar o conjunto novo por diferença | Fica todo em JS, sem migration; fácil de testar com mock | +1 round-trip por lote; esbarra no **header overflow do PostgREST com `in.()` grande** — gotcha real deste projeto, que já obrigou a paginar em lotes de 100 (bugfix do upload de motorista), então um lote de 500 viraria 5 requisições extras; abre **janela de corrida** entre o SELECT e o upsert (linha criada nesse intervalo é classificada como "nova" e re-enfileirada, ou vice-versa) | Alto (≈5 req extras/lote + código de paginação + tratamento de corrida) | **Rejeitada** |
| **(b) `ALTER COLUMN dados_entrego_solicitado_em SET DEFAULT now()`** | 1 linha de SQL; zero código; imune a corrida | Alcança **todo** INSERT, inclusive o `POST /motoristas` manual (`routes/hub-motoristas.js:705`), que não emite a claim. Efeito colateral concreto e visível: o operador cria um motorista e, ao clicar em "enriquecer" logo depois, leva `429 JA_PENDENTE` (`routes/hub-motoristas.js:842`) — comportamento não pedido pela spec | Baixíssimo, mas com regressão de UX não solicitada | **Rejeitada** |
| **(c) Alargar o filtro da fila** para incluir também os nunca-tentados (`or=(solicitado_em.not.is.null, desfecho.eq.nunca-tentado)`) | Zero mudança no caminho de importação; resolveria o problema sem distinguir INSERT de UPDATE | Enfileiraria **retroativamente** todos os entregadores já cadastrados. Retroatividade do enriquecimento foi **bloqueio humano explícito** na feature irmã `hub-motorista-360` (onda-002, opções `retroativo-com-reconciliacao` / `so-daqui-pra-frente`) — não pode ser reaberta aqui por conta própria | Baixo em código, alto em governança | **Rejeitada** |
| **(d) Trigger `BEFORE INSERT` escopado por `hub_jwt_origem_importacao()`** | Exato a FR-001 (só importação); imune a FR-002 por construção; zero round-trip; zero mudança em `hub-import-processor.js`; reusa helper já em produção nesta mesma tabela | ~10 linhas de SQL numa migration; a regra passa a viver no banco (mas é onde já vive a regra irmã de `0025`) | Baixo | **ESCOLHIDA** |

**Fontes da claim de origem (verificadas)**:

- `infra/hub/migrations/0025_entregador_protege_nome_apenas_import.sql:44-50`:
  `CREATE OR REPLACE FUNCTION hub_jwt_origem_importacao() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE((hub_jwt_claims() ->> 'origem_importacao')::boolean, false); $$;`
- `app_homologacao/backend/lib/hub-postgrest-jwt.js:76-77`: converte
  `claims.origemImportacao === true` em `payload.origem_importacao = true`.
- `app_homologacao/backend/lib/hub-import-processor.js:342`: único emissor —
  `{ ...job.claims, origemImportacao: true }`.
- `app_homologacao/backend/routes/hub-motoristas.js:705`: o POST manual chama
  `hubPostgrestRequest('Entregador', 'POST', {...}, claims)` **sem** a claim.

---

## Decision 2 — A fila já existe: FR-004 é satisfeita sem nenhum canal novo

**Decision**: reutilizar integralmente o canal sob-demanda existente. Nenhuma
tabela de fila, nenhum worker novo, nenhum scheduler novo.

**Rationale**: a fila já é, literalmente, o predicado
`dados_entrego_solicitado_em IS NOT NULL`. Em
`app_homologacao/backend/routes/hub-robo-entrego.js:167` o modo `sob-demanda`
monta o filtro
`dados_entrego_solicitado_em=not.is.null&order=dados_entrego_solicitado_em.asc`
e o `GET /robo-entrego/motoristas-para-enriquecer` devolve até
`LOTE_ENRIQUECIMENTO_DEFAULT = 20` itens por chamada
(`routes/hub-robo-entrego.js:44`). O comentário da própria migration `0057`
já declara essa intenção: *"Marca o estado 'na fila' sem precisar de uma
tabela de fila separada — a própria linha de `Entregador` é o registro de
fila"*. Gravar o carimbo na criação é, portanto, tudo o que FR-001 exige para
que FR-004 se cumpra sozinha.

**Alternatives considered**: tabela de fila dedicada (rejeitada — a spec diz
explicitamente "nenhum canal de consumo novo é necessário", e a coluna já foi
criada em `0057` para exatamente este fim).

---

## Decision 3 — Desfecho como coluna `text` + `CHECK` de 4 valores, não `enum` nativo

**Decision**: nova coluna `dados_entrego_desfecho text NOT NULL DEFAULT
'nunca-tentado'` com `CHECK (dados_entrego_desfecho IN ('nunca-tentado',
'pessoa-nao-encontrada', 'outra-falha', 'sucesso'))`.

**Rationale**:

- Os 4 valores são decisão fechada do operador (dec-010, Clarifications da
  spec) — FR-006 exige que sejam mutuamente exclusivos e consultáveis.
- `text + CHECK` é *expand-only* e reversível: adicionar um 5º valor no futuro
  é um `ALTER ... DROP CONSTRAINT` + `ADD CONSTRAINT` numa migration nova. Um
  `CREATE TYPE ... AS ENUM` exigiria `ALTER TYPE ... ADD VALUE`, que não roda
  dentro de transação em versões antigas do PostgreSQL e complica o rollback.
- O PostgREST expõe `text` diretamente como string JSON, sem mapeamento
  especial — o filtro `?dados_entrego_desfecho=eq.pessoa-nao-encontrada`
  funciona sem nada adicional.
- `ADD COLUMN ... NOT NULL DEFAULT <const>` é operação de metadado (sem
  reescrita de tabela) no PostgreSQL ≥ 11, então é barata mesmo com a tabela
  de produção populada.
- As permissões já estão cobertas: `0010:31` faz
  `GRANT SELECT, INSERT, UPDATE ON "Entregador" TO authenticated` no nível de
  **tabela**, o que alcança colunas novas automaticamente — nenhum GRANT novo.

**Alternatives considered**:
- `enum` nativo (rejeitada: rollback e evolução mais caros, sem ganho aqui).
- Derivar o desfecho de colunas existentes em vez de materializá-lo
  (rejeitada: é justamente o que a spec proíbe — dec-010 pediu um campo
  autoexplicativo, "a decisão de retentar sai direto dele, sem cruzar
  colunas").
- Tabela de histórico de tentativas (rejeitada: FR-007 exige apenas a
  tentativa **mais recente**, nunca acúmulo).

---

## Decision 4 — Backfill do desfecho na própria `0060`, derivado do que já é verdade

**Decision**: a `0060` roda, uma única vez e de forma idempotente:

```
UPDATE "Entregador"
   SET dados_entrego_desfecho = 'sucesso'
 WHERE dados_entrego_enriquecidos_em IS NOT NULL
   AND dados_entrego_desfecho = 'nunca-tentado';
```

**Rationale**: sem backfill, as linhas já enriquecidas ficariam
marcadas como `nunca-tentado`, e o campo mentiria — SC-002 exige responder
**corretamente** em 100% dos casos. `dados_entrego_enriquecidos_em IS NOT NULL`
é prova direta e já persistida de uma tentativa bem-sucedida, então o backfill
não inventa nada.

**Loteamento do backfill** (gate `owasp-security`, achado **M3**): `ADD COLUMN
… NOT NULL DEFAULT <const>` é metadado e barato, mas o `UPDATE` do backfill
**reescreve linhas e segura lock** numa tabela viva do `chatmasterveloz`.
Medir primeiro (Cenário 6.1 do quickstart) e, acima de alguns milhares de
linhas, lotear o `UPDATE` por faixa de `id` em vez de rodá-lo de uma vez. Na
escala atual conhecida (~720 linhas) uma única passada é segura — mas a
decisão MUST sair da medição, não da suposição.

**Quantos registros o backfill toca**: desconhecido neste momento, e
deliberadamente **não estimado** — o agente não consulta produção. O número
sai da própria consulta do `quickstart.md` Cenário 6, executada pelo operador
(`SELECT count(*) FROM "Entregador" WHERE dados_entrego_enriquecidos_em IS NOT
NULL;`). Não confundir com os **471 vínculos de credencial** do backfill da
feature `hub-motorista-360`: aquilo é `motorista_id` preenchido por
similaridade de nome, métrica diferente de "enriquecido pela EntreGô".

**Limitação conhecida e aceita**: tentativas que **falharam** antes desta
feature não podem ser reconstruídas — não existia coluna que as registrasse.
Elas permanecem como `nunca-tentado`. Isso é subnotificação honesta (o sistema
nunca afirma uma falha que não pode provar), e se corrige sozinha na primeira
tentativa nova de cada entregador.

**Alternatives considered**: reconstruir falhas passadas a partir de
`AuditoriaEvento` (ação `motorista.entrego_enriquecimento_falhou`, registrada
em `routes/hub-robo-entrego.js:249-256`) — **rejeitada**: o `motivoFalha` lá é
texto livre (`enriquecimento.js:259` envia `e.message`), então não distingue
`pessoa-nao-encontrada` de `outra-falha` sem parsear string, exatamente o que
a Decision 5 vem eliminar. Reconstruir só `outra-falha` daria um resultado
enviesado e pior que a subnotificação.

---

## Decision 5 — O robô envia um **sinal estruturado**; o backend nunca parseia `motivoFalha`

**Decision**: o corpo do `PATCH /robo-entrego/motoristas/:id/entrego-enriquecimento`
ganha o campo opcional `sinalFalha` (string). O robô passa a enviar
`sinalFalha: e.sinal`. O backend mapeia por **allowlist fechada**:
`'pessoa_nao_encontrada'` → `pessoa-nao-encontrada`; qualquer outro valor,
ausente ou desconhecido → `outra-falha`. `sucesso: true` → `sucesso`.

**Rationale**:

- O sinal já existe e é estável: `infra/robo-entrego/src/entrego-portal.js:80-86`
  define `class ErroPessoaNaoEncontradaNoPortal` com
  `this.sinal = 'pessoa_nao_encontrada'`. A classe foi criada exatamente para
  **não** ser confundida com antibot, e o cabeçalho dela registra a medição que
  a originou ("38 de 38 falhas do reprocessamento tinham exatamente isso").
- Hoje `infra/robo-entrego/src/enriquecimento.js:259` envia
  `{ sucesso: false, motivoFalha: e.message, modo }` — texto livre. Classificar
  por `e.message` seria heurística de string frágil, quebrando ao primeiro
  ajuste de mensagem.
- Allowlist fechada no servidor é obrigatória porque o destino é uma coluna com
  `CHECK`: repassar um valor arbitrário do cliente causaria violação de
  constraint e `500`. Mapear desconhecido → `outra-falha` mantém o endpoint
  total (nunca falha por valor novo) e degrada para o valor mais genérico.
- Mesma disciplina já adotada no arquivo para `acao`
  (`ACOES_PERMITIDAS`, `routes/hub-robo-entrego.js:55-61`) — allowlist fechada
  introduzida por achado MEDIUM de gate `owasp-security` anterior.

**Alternatives considered**:
- Backend parseia `motivoFalha` por regex (rejeitada: frágil; acopla o backend
  ao texto de mensagens de erro do robô).
- Robô manda o desfecho final já no vocabulário da coluna (rejeitada: coloca
  regra de negócio do hub dentro do robô e permitiria ao cliente escrever
  direto num campo com `CHECK`, ampliando a superfície de confiança).

---

## Decision 6 — O invariante dec-010 é "mesmo PATCH", **não** "sucesso ⟺ enriquecidos_em"

**Decision**: `dados_entrego_desfecho = 'sucesso'` e
`dados_entrego_enriquecidos_em` continuam sendo gravados no **mesmo** corpo de
PATCH (`routes/hub-robo-entrego.js:222-229`). Nenhum dos dois é removido.
Porém, o plano registra explicitamente que a bicondicional
`desfecho = 'sucesso' ⟺ enriquecidos_em IS NOT NULL` **não** vale ao longo do
tempo.

**Rationale**: FR-008 proíbe que uma falha descarte dados de um enriquecimento
bem-sucedido anterior — e o código já respeita isso, porque o ramo de falha
grava apenas `{ dados_entrego_solicitado_em: null }`
(`routes/hub-robo-entrego.js:228`), preservando `dados_entrego_json` e
`dados_entrego_enriquecidos_em`. Logo, um entregador enriquecido em janeiro que
falhe em setembro fica legitimamente com `desfecho = 'pessoa-nao-encontrada'`
**e** `enriquecidos_em` preenchido: FR-007 (desfecho reflete a tentativa mais
recente) e FR-008 (dados antigos preservados) convivem.

Registrar isso é o ponto: sem essa nota, uma futura "simplificação" leria a
redundância como inconsistência e removeria uma das duas colunas — exatamente
o que a spec proíbe em nota destacada.

---

## Decision 7 — Verificação de pré-requisito em produção antes da `0060`

**Decision**: a `0060` depende de `hub_jwt_origem_importacao()` existir no banco
alvo. Em `hub_homolog_db` isso é certo (a série roda inteira lá). Em produção
(`chatmasterveloz`) o plano **exige verificação ao vivo pelo operador** antes de
aplicar.

**Rationale**: a evidência disponível é **documental, não medida**.
`docs/plans/hub-frota/G3-CUTOVER-STATUS-E-RETOMADA.md:43` registra "série
**0000–0046** aplicada … `SchemaMigration=47`", o que inclui a `0025`. Mas o
cabeçalho da própria `0025:40-42` diz o contrário para a época em que foi
escrita ("Aplicada por migrate.sh só no `hub_homolog_db` (nunca em
chatmasterveloz/produção legada)") — a frase é anterior ao cutover, quando o
hub ainda não vivia no `chatmasterveloz`. Além disso a memória do projeto
registra que **`SchemaMigration` mente se a migration for aplicada fora do
`migrate.sh`**. Duas fontes documentais em tensão + um registro que já foi
reconciliado uma vez = não é base para escrever em produção.

Custo da verificação: uma consulta de leitura. Ver `quickstart.md` Cenário 6.

**Alternatives considered**: tornar a `0060` autossuficiente recriando a função
com `CREATE OR REPLACE` (rejeitada: `hub_jwt_origem_importacao()` depende de
`hub_jwt_claims()`, e recriar função de outra migration numa migration nova
duplica a fonte da verdade e mascara justamente o desvio que se quer detectar).

---

## Decision 8 — O teto cabe no gatilho de linha; a hipótese contrária foi testada e refutada

**Decisão**: manter o gatilho `BEFORE … FOR EACH ROW` da Decision 1,
estendendo-o a `BEFORE INSERT OR UPDATE` e acrescentando duas condições
(habilitação da empresa, teto por empresa). **Nenhum** gatilho de statement,
**nenhuma** *transition table*, **nenhuma** guarda de recursão.

**Rationale**: FR-010 (teto) exige contar quantos pedidos já estão pendentes
enquanto o lote é inserido. A hipótese natural — "um gatilho de linha não
enxerga as linhas irmãs do mesmo comando, porque o `cmin` delas é igual ao
*command id* corrente" — foi **medida e é falsa**: cada `SELECT` dentro de uma
função PL/pgSQL passa pelo SPI, que incrementa o *command counter*, tornando
visíveis os efeitos já produzidos pelo comando em curso.

Prova (`postgres:13.23`, container descartável, `BEFORE INSERT` de linha num
`INSERT … SELECT` de 5 linhas, `RAISE NOTICE` do `count`):

```
NOTICE:  BEFORE INSERT row trigger: count visivel = 0
NOTICE:  BEFORE INSERT row trigger: count visivel = 1
NOTICE:  BEFORE INSERT row trigger: count visivel = 2
NOTICE:  BEFORE INSERT row trigger: count visivel = 3
NOTICE:  BEFORE INSERT row trigger: count visivel = 4
```

Com isso, o desenho simples aplica o teto exatamente: `teto=3` num lote de 7
novos ⇒ **3** enfileirados. A tabela completa de provas está em
`data-model.md` §Evidência empírica.

**O evento `UPDATE`** entra por outro motivo, não pelo teto: é o que faz o
excedente "entrar na importação seguinte" (segunda metade de FR-010, palavras
do operador). Naquela importação as linhas excedentes caem no ramo
`ON CONFLICT DO UPDATE`, e um gatilho só de `INSERT` não as veria. O risco de
o ramo de `UPDATE` varrer o passivo histórico (retroatividade — bloqueio
humano na feature irmã `hub-motorista-360`) é fechado pela cláusula
`NEW.criado_em < EnriquecimentoAutomatico.desde`, também medida.

**Alternatives considered**:

| Alternativa | Por que não |
|---|---|
| Gatilho `AFTER … FOR EACH STATEMENT` com *transition table* | Foi projetado, escrito e **medido — funciona** (3 de 7, excedente volta, etc.). Descartado por custo sem benefício: exige dois gatilhos (o PG proíbe *transition table* em gatilho multi-evento — medido: `ERROR: transition tables cannot be specified for triggers with more than one event`), uma `WITH … UPDATE` com `row_number()`, e uma guarda `pg_trigger_depth()` para não se realimentar, já que gatilho de statement dispara mesmo com zero linhas afetadas. Tudo isso para resolver um problema que não existe |
| Aplicar o teto no `lib/hub-import-processor.js` | Reintroduz o que a Decision 1 eliminou: o processador voltaria a precisar saber **quais** linhas são novas (pré-`SELECT` ou `RETURNING` paginado), com round-trip extra e janela de corrida |
| Aplicar o teto na leitura da fila | Não é o que o operador decidiu ("fica **sem enfileirar**"), e não bounda o backlog: o consumidor continuaria drenando o lote inteiro ao longo do dia |
| Contador por importação numa tabela nova | Precisa de chave "qual importação", reset diário e limpeza. O teto de fila **pendente** é mais forte, sem estado, e cai em 3 linhas |

**Custo medido**: lote de **500** novos com `teto=100`, com o índice parcial —
`INSERT` inteiro em **19,0 ms**, exatamente 100 enfileirados. As 500×2
consultas do gatilho não são um problema de desempenho.

---

## Decision 9 — Teto e habilitação numa tabela própria, não em `"ModuloEntidade"` nem numa constante

**Decisão**: tabela nova `"EnriquecimentoAutomatico" (empresa_id PK, ativo,
teto, desde, atualizado_em)`, com `GRANT SELECT` e **nenhum** grant de escrita
para `authenticated`.

**Rationale**: as respostas de `block-003` criam três necessidades que hoje
não têm onde morar — um liga/desliga por empresa (FR-012), um teto
**configurável, nunca constante mágica** (FR-010, palavras do operador) e uma
ativação separada do deploy (FR-013). Uma tabela de 5 colunas cobre as três, e
a ausência de rota de escrita é o que **materializa** FR-013: aplicar a
migration e subir o código não liga nada; ligar exige um `INSERT` deliberado
no runbook, e desligar é um `UPDATE` sem deploy.

**Alternatives considered**:

| Alternativa | Por que não |
|---|---|
| Reusar `"ModuloEntidade"` (nega-por-padrão já pronto, `routes/hub-admin.js:121-123`) | Cobriria só FR-012. `"Modulo"` é o catálogo que alimenta a navegação — um módulo para capacidade **backend-only** (dec-011) poluiria o menu com item que não abre tela. E o `teto`/`desde` teriam de virar colunas específicas desta feature numa tabela genérica |
| Constante no SQL do gatilho | O operador foi explícito: "configurável, nunca constante mágica" |
| GUC de banco (`ALTER DATABASE … SET hub.teto`) | Só vale para conexões novas; o PostgREST mantém pool, então mudar exigiria reiniciar o serviço — pior que um `UPDATE` |
| Rota administrativa `PUT /admin/…/enriquecimento` | Superfície de API nova que ninguém pediu, para uma operação que acontece uma vez por empresa. Custo de RBAC + auditoria + testes sem demanda |

**Limitação declarada**: sem rota, a mudança não gera linha em `"Auditoria"`.
O rastro é a própria linha (`ativo`, `desde`, `atualizado_em`) mais o registro
no runbook.

---

## Decision 10 — Prioridade do manual por coluna booleana, não por fila separada

**Decisão**: coluna `dados_entrego_solicitado_manual boolean NOT NULL DEFAULT
false` e **uma** chave a mais no `order` do consumo da fila.

**Rationale**: hoje manual e automático escrevem na **mesma** coluna
(`dados_entrego_solicitado_em`) — não há como distingui-los, e sem
discriminador FR-011 é inexprimível. `order=…_manual.desc,…_em.asc` resolve em
um parâmetro de querystring; `NOT NULL` elimina a ambiguidade de
`NULLS FIRST/LAST` do `desc`.

**Alternatives considered**: tabela de fila separada (duplicaria consumidor,
endpoint e testes para uma diferença de prioridade); coluna `text`
`'manual'|'automatico'` (mesma informação, ordenação por acaso alfabético);
timestamp sentinela no passado para o pedido manual (ordena certo por efeito
colateral e destrói o dado de quando o operador clicou).

---

## Decision 11 — O código pode existir em produção sem que nada seja coletado (resposta H1)

**Decisão**: nesta entrega, a `0060` é aplicada e provada **somente** no
ambiente isolado (`hub_homolog`). Em produção, três camadas independentes
impedem coleta automática, e as três precisam ser vencidas de propósito:

1. a `0060` **não é aplicada** no `chatmasterveloz` nesta entrega;
2. se fosse, o gatilho seria **inerte**: sem linha ativa em
   `"EnriquecimentoAutomatico"`, o `SELECT … INTO cfg` não encontra nada e a
   função retorna sem carimbar (falha fecha);
3. ligar exige o `INSERT` explícito do runbook, condicionado à definição do
   prazo de retenção/expurgo de CPF/RG/CNH — decisão pendente do operador,
   dívida herdada de `0057` (dec-038).

**Rationale**: é a resposta literal de H1 ("implementar e testar sem ligar em
produção"; "não ampliar a coleta de PII agora"), com o interruptor no banco em
vez de num `if` de código — reversível sem deploy.

**Acoplamento a declarar**: a `0060` e o backend desta feature formam **um
par**. O `PATCH` passa a enviar `dados_entrego_desfecho` e
`dados_entrego_solicitado_manual`; contra um PostgREST sem essas colunas, o
PostgREST responde erro e o enriquecimento manual **quebraria**. Portanto, em
produção, ou sobem os dois (migration primeiro) ou não sobe nenhum. Como não
há autorização de deploy nesta entrega, a questão é registro, não decisão.

---

## NEEDS CLARIFICATION restantes

Nenhum. Os dois pontos que poderiam virar suposição foram tratados como
verificação explícita, não como premissa:

1. Existência de `hub_jwt_origem_importacao()` em `chatmasterveloz` →
   Decision 7 (passo de verificação do operador, bloqueante para a aplicação
   em produção; **não** bloqueante para implementar/testar em `hub_homolog`).
2. Classificação de falhas históricas → Decision 4 (limitação declarada, não
   inventada).
