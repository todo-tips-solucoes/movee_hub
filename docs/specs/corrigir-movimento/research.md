# Research: Corrigir o valor de um movimento antes do envio da nota

**Feature**: `corrigir-movimento` · **Fase**: Phase 0 (plan) · **Data**: 2026-10-20

Todo dado factual abaixo foi extraído de fonte rastreável (código-fonte, DDL de migration
ou medição sobre as planilhas reais). Onde a fonte não existe, o item está marcado
`[PROPOSTA]` ou `[A MEDIR]` — nunca afirmado como real (principio de zero-fabricacao da execucao autonoma; a constitution DESTE projeto tem apenas os principios I-V).

---

## Decision 1 — Reconhecimento da chave dupla: UMA consulta por lote, dirigida pela lista de CNPJ

**Decision**: o casamento de ~980 linhas faz **uma passada** de consultas em lote ao
PostgREST, dirigida pela **lista de `cnpj_prestador` do lote**, filtrando
`id_empresa` + faixa de `dt_inicial`/`dt_final`. O resultado traz também a coluna `uuid`
de cada candidato, então **os dois ramos da chave dupla (FR-001) são resolvidos em
memória sobre esse mesmo resultado**: primeiro tenta `uuid`, depois o fallback
(`id_empresa` + `cnpj_prestador` + `dt_inicial` + `dt_final`).

**Rationale**:
- Sem consulta individual por linha (FR-010): ~10 round trips de 100 CNPJs para 980 linhas.
- Dispensa um índice em `EnvioMassa.uuid`, que **não existe** (ver Decision 2).
- Dispensa uma segunda consulta por `uuid=in.(...)`.
- O conjunto de candidatos é exatamente o universo a que o lote pertence (a empresa, no
  período importado), então o ramo `uuid` encontra ali o que precisa encontrar.

**Alternatives considered**:
- *Duas consultas (uma por `uuid`, uma por CNPJ+período)*: exigiria índice novo em `uuid`
  e dobraria os round trips, sem ganho — o ramo `uuid` já está contido no resultado único.
- *Varredura do período inteiro da empresa sem filtro de CNPJ*: não usa o índice da 0109
  (coluna líder ausente — ver Decision 2) e cresce com o histórico da empresa, não com o lote.
- *Consulta por linha*: proibida explicitamente por FR-010.

**Limite conhecido (`ponytail:` ceiling)**: uma linha cujo `cnpj_prestador` na planilha
difere do gravado no movimento não aparece no conjunto de candidatos e é tratada como
*sem correspondente* → criada nova e **contada no resumo** (FR-007/FR-009), ficando visível
ao operador. Isto é consistente com FR-003, que proíbe a reimportação de alterar CNPJ
(a troca de CNPJ tem caminho próprio: `PATCH /update-envio-massa/:id`, ordem `[B]..[F]`).
Fechar o furo exigiria o índice de Decision 2 (alternativa B) — só se a medição justificar.

---

## Decision 2 — Índice: o `idx_envio_massa_cnpj_periodo` da 0109 **serve**; nenhum índice novo

**Decision**: reusar `idx_envio_massa_cnpj_periodo` e **não criar índice**.

**Rationale** — inventário verificado dos índices de `EnvioMassa`:

| Índice | Colunas | Origem |
|---|---|---|
| `idx_envio_massa_cnpj_periodo` | `(cnpj_prestador, dt_inicial, dt_final)` | `0109_repasse_lote_movimento_planilha.sql:17-18` |
| `idx_enviomassa_id_empresa_legado` | `(id_empresa)` | `0033_schema_legado_envio_massa.sql:153` |
| `idx_enviomassa_mov_fechado_legado` | `(mov_fechado)` | `0033:154` |
| `idx_enviomassa_cnpj_prestador_legado` | `(cnpj_prestador)` | `0033:155` |
| `idx_enviomassa_entregador_uuid` | `(entregador_uuid)` | `0046_envio_massa_entregador_uuid.sql:38-39` |
| `idx_envio_massa_cnpj_prestador` | `(cnpj_prestador)` | `0094` |
| `EnvioMassa_pkey` | `(id)` | PK |

**Fonte e ressalva (correcao da onda-005)**: sao **7** indices, medidos em `pg_indexes` do
`hub_homolog` em 2026-10-20 (a versao anterior listava 5). `idx_enviomassa_cnpj_prestador_legado`
(0033) e `idx_envio_massa_cnpj_prestador` (0094) sao **duplicatas** sobre a mesma coluna. E o
espelho do hub-homolog: **producao pode divergir** - nao afirmado para producao.

**Medicao no hub-homolog (onda-005, 20.000 linhas sinteticas em transacao com ROLLBACK, ANALYZE)**:
a consulta de casamento (`id_empresa` + `cnpj_prestador IN (...)` + faixas de `dt_inicial`/`dt_final`)
usou `Index Scan using idx_envio_massa_cnpj_periodo` (0,040 ms); a busca por `uuid` fez
`Seq Scan` (2,8 ms, 20.003 linhas descartadas) - confirma que nao ha indice em `uuid`. Isto e
evidencia de planner no espelho, nao de producao: o CHK022 do operador permanece como confirmacao
final em `chatmasterveloz`, mas o risco de o indice ser ignorado esta medido e nao se materializou.

Dois pontos decisivos:

1. O índice da 0109 cobre o fallback **inteiro** quando a consulta é dirigida pela lista de
   CNPJ: igualdade (`IN`) na coluna **líder** `cnpj_prestador`, seguida das condições de
   faixa em `dt_inicial`/`dt_final` — exatamente a ordem das colunas do índice. Ele **não**
   serviria a uma varredura só por período (coluna líder ausente do predicado), que é
   justamente a razão de Decision 1 dirigir a consulta pelos CNPJs.
2. **`EnvioMassa.uuid` não tem índice.** O único índice de uuid é
   `idx_enviomassa_entregador_uuid`, sobre a coluna **diferente** `entregador_uuid`
   (motorista canônico, 0046) — não sobre o `uuid` que a planilha traz e que o `/upload`
   grava (`server.js:1989`, `uuid: row.uuid`). Confundir as duas colunas levaria a
   planejar um índice que já existe para outra finalidade. Decision 1 resolve `uuid` em
   memória e por isso nenhum índice é necessário aqui.

**Alternatives considered**:
- *(B) Índice novo `(id_empresa, dt_inicial, dt_final)`*: permitiria uma única consulta do
  período inteiro da empresa (código mais simples, fecha o furo de Decision 1), ao custo de
  uma migration e de um índice a manter. **Rejeitado agora** por não ser necessário ao
  requisito; reconsiderar **somente** se a medição abaixo reprovar.
- *(C) Índice em `EnvioMassa.uuid`*: desnecessário sob Decision 1.

**[A MEDIR] — tarefa obrigatória de verificação**: `EXPLAIN (ANALYZE, BUFFERS)` da consulta
de casamento no ambiente do hub (`infra/hub/`, onde a 0033 espelha o schema legado e a 0109
cria o índice), confirmando `Index Scan`/`Bitmap Index Scan` sobre
`idx_envio_massa_cnpj_periodo` e **ausência de `Seq Scan`** em `EnvioMassa`. Esta decisão
está registrada com score 2 (apoiada na ordem de colunas do DDL lido, não em medição):
o ambiente do hub **não estava no ar** no momento do plano (só
`hub_homolog_frontend`/`_backend`/`_traefik`), e medir em produção é vedado pela cláusula
pétrea. O gate de performance (SC-005) depende desta medição, não da suposição.

---

## Decision 3 — O período do fallback vem do range da requisição, por **faixa**, nunca `::date`

**Decision**: o período do fallback é composto a partir do range já obrigatório no
`POST /upload` (`req.body.dt_inicial` / `dt_final`, `DD/MM/YYYY`), convertido pela função
que o próprio import já usa — `toTimestamptzMidnightSP` (`server.js:1778`) — e comparado
por **faixa de um dia** (`>= d AND < d+1`), não por igualdade exata nem por `::date`.

> ⚠️ **A função NÃO grava meia-noite, apesar do nome e do próprio JSDoc** — achado da
> auditoria de veracidade, confirmado no código. O JSDoc (`server.js:1776`) promete
> `"YYYY-MM-DDT00:00:00-03:00"`, mas o corpo (`server.js:1785`) emite literalmente:
> ```js
> return `${y}-${pad2(m)}-${pad2(day)}T03:00:00${offset}`;
> ```
> Com `offset = -03:00`, isso é **03:00 local = 06:00Z**, não meia-noite em SP (que seria
> `03:00Z`). O nome da função, o comentário e o corpo discordam entre si — é a armadilha de
> fuso `03:00` já conhecida no repositório, agora localizada.
>
> **Consequências obrigatórias para a implementação**:
> 1. **`D0` é definido como o valor devolvido pela própria `toTimestamptzMidnightSP`** para
>    a data do range — nunca uma data truncada nem um `00:00` construído à mão. A faixa é
>    `[D0, D0 + 1 dia)`. Derivar `D0` de qualquer outra forma desalinha a faixa do que o
>    import de fato gravou.
> 2. Reusar a função **como ela é** (não "como o nome sugere") garante, por construção, que
>    o fallback compare contra o mesmo instante que o `/upload` grava.
> 3. **Não "corrigir" a função** nesta feature: ela já governa dados em produção, e mudar o
>    instante gravado reescreveria a semântica de todo movimento existente (FR-025). O
>    descasamento nome-vs-corpo fica **registrado** para o operador decidir em frente
>    própria.

**Rationale**:
- A planilha **não tem** colunas de data. As 13 colunas reais, confirmadas nos dois
  arquivos, são: `uuid, number, nome, valor, mensagem1, mensagem2, enviado,
  retorno_envio_msg_1, retorno_envio_msg_2, tribnac, cnpj_tomador, cnpj_prestador, gorjeta`.
  O código já declara isso: *"As colunas dt_inicial/dt_final da planilha são ignoradas"*
  (`server.js:1948`), e o range do handler é aplicado a **todas** as linhas do lote
  (`dt_inicial: dtIniTS, dt_final: dtFimTS`, `server.js:1990-1991`).
- `::date` sobre a coluna **impede o planner de usar o índice** — a faixa preserva o
  `Index Scan` de Decision 2 (lição já paga neste repositório na 0109).
- A faixa de um dia, e não a igualdade exata, tolera movimento gravado com componente de
  hora diferente do instante canônico atual (import anterior a `import-range-datas`, quando
  as datas vinham por linha). Igualdade exata transformaria essa divergência de fuso em
  duplicata silenciosa — e o fuso `03:00` já é armadilha conhecida aqui, confirmada no
  corpo da própria função (aviso acima).

**Alternatives considered**:
- *Igualdade exata no timestamp canônico*: determinística para lotes novos, mas duplica
  silenciosamente contra dados gravados por imports antigos. Rejeitado.
- *`dt_inicial::date = $1`*: legível e errado — mata o índice. Rejeitado.
- *Derivar o período da planilha*: impossível, não há coluna de data.

---

## Decision 4 — Texto da mensagem: planilha na reimportação; **substituição ancorada** na tela

**Decision**:
- **Reimportação**: o texto vem da **planilha corrigida**. Zero lógica de formato
  (`mensagem1: row.mensagem1` já é o comportamento atual, `server.js:1976`).
- **Edição pela tela**: substituir **apenas o número**, ancorado na frase literal
  `O valor total para emissão da NF é de R$` (com espaço opcional antes do número),
  preservando todo o resto do texto. Âncora ausente ou ambígua ⇒ **não declarar sucesso
  pleno**: gravar o valor e avisar que a mensagem não pôde ser ajustada (FR-014).

**Rationale** — o formato **não é do sistema e não é estável**. Medido por `python3`
(stdlib `zipfile` + `ElementTree`) sobre `xl/sharedStrings.xml` das duas planilhas reais:

| Arquivo | `R$ <dígito>` (com espaço) | `R$<dígito>` (sem espaço) |
|---|---|---|
| `modelo_upload_envio_em_massa_movee 05.10.xlsx` | 0 | **982** |
| `modelo_upload_envio_em_massa_movee (2).xlsx` | **3** | 0 |

**Unidade da contagem**: *strings distintas* da tabela `sharedStrings` que casam o padrão —
não ocorrências de `R$` (cada mensagem contém **duas**: o valor da NF e a gorjeta).

**Procedência (reproduzível)** — as planilhas são binárias e ficam fora de
`docs/specs/`, então a medição vai aqui com o comando que a produz, em
`docs/documentos_apoio/`:

```sh
python3 - <<'PY'
import glob, zipfile, re, xml.etree.ElementTree as ET
NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
for f in sorted(glob.glob("modelo_upload_envio_em_massa_movee*.xlsx")):
    z=zipfile.ZipFile(f); ss=[]
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')).iter(NS+'si'):
        ss.append(''.join(t.text or '' for t in si.iter(NS+'t')))
    print(f, sum(1 for s in ss if re.search(r'R\$ \d',s)), sum(1 for s in ss if re.search(r'R\$\d',s)))
PY
```

Usa apenas a stdlib (`zipfile` + `ElementTree`) — não há `openpyxl` no host. As **13 colunas**
da planilha e os valores concretos do texto citados abaixo vêm da mesma leitura; as colunas
são **corroboradas** (não provadas) pelos `row.<campo>` lidos em `server.js:1916-1989`, que
incluem também `dCompet`/`numnota`/`nota_ok`/`data_emissao`/`erro_validacao` — logo o código
**tolera** colunas extras e não prova que o arquivo tenha exatamente 13.

Texto integral capturado (05.10): `…O valor total para emissão da NF é de R$242,24. O valor
de gorjetas é de R$0,00. …` — e a variante `R$ 21,20` / `R$ -` (gorjeta nula) no outro arquivo.

Daí três consequências que determinam o desenho:

1. **Recompor a sentença é fabricar formato.** A frase não existe em nenhum lugar do
   código — `grep` por *"valor total para emissão da NF"* em `app_homologacao/` e `docs/`
   casa **somente** com a própria spec. O texto é autorado fora do sistema, na planilha.
   Gerar a sentença exigiria inventar grafia, pontuação e espaçamento: vedado: seria fabricar dado factual.
2. **Um padrão `R$<número>` solto é perigoso.** O mesmo texto embute um **segundo** valor
   (gorjeta) e ainda `48.904.673/0001-00` (CNPJ), `04726-170` (CEP) e os códigos `02461`,
   `53.20.20-2`, `26.01.01`, `1.0703.00.00`. Substituir "o primeiro número depois de R$"
   acertaria a gorjeta em metade dos casos. A âncora é a **frase**, não a moeda.
3. **O espaçamento varia por arquivo**, logo a âncora aceita `R$` com ou sem espaço antes
   do número, e **reescreve o número na mesma grafia encontrada** (não normaliza).

A gorjeta tem âncora própria (`O valor de gorjetas é de R$`) e o mesmo tratamento, incluindo
o caso `R$ -` para gorjeta nula.

**Alternatives considered**:
- *Recompor a mensagem a partir de um template no backend*: inventa formato; além disso
  perderia o texto específico do lote (nome, período, códigos de serviço). Rejeitado.
- *Não mexer no texto*: viola FR-014 — o motorista emitiria a nota pelo valor antigo, que é
  exatamente o dano que a feature existe para evitar. Rejeitado.
- *Pedir o texto novo ao operador na tela*: joga em quem corrige um valor a tarefa de
  reescrever 1.200 caracteres. Rejeitado (e não pedido pela spec).

---

## Decision 5 — FR-017 + FR-023 exigem **função no banco** (RPC), não ler-depois-PATCH

**Decision**: a correção de valor (nos **dois** caminhos) executa numa **função PostgreSQL**
invocada por `/rpc/`, que num único comando faz: filtro de escopo → guarda de nota
enviada/movimento fechado → `UPDATE` → `INSERT` em `Auditoria`.

**Rationale**:
- FR-017 exige que verificar "nota enviada" e gravar o valor sejam **indivisíveis por
  movimento**; o Edge Case *"nota enviada entre a verificação e a gravação"* nomeia
  exatamente a janela que um ler-depois-PATCH deixaria aberta.
- FR-023 exige que alteração e auditoria ocorram **juntas** ("sem registro não há
  alteração"). A trilha atual é deliberadamente *best-effort*: `auditarEnvioMassaSeViaHub`
  engole a exceção num `try/catch` e segue (`server.js:170-172`). Mantê-la nesse caminho
  violaria FR-023.
- A persistência fala **HTTP com PostgREST, sem ORM**: a aplicação **não tem** transação
  multi-statement. Sobre PostgREST, uma função é a única forma de atomicidade real.
- É o padrão que o repositório **já** usa para exatamente este problema:
  `hub_repasse_lote_avaliar` (0109), `hub_adiantamento_repasse_fechar` (0098).

**Alternatives considered**:
- *`GET` + `PATCH` na aplicação, com filtro de guarda no próprio `PATCH`*: um `PATCH` com
  os predicados de guarda no `WHERE` (`nota vazia AND mov_fechado=false AND id_empresa=...`)
  **é** atômico quanto ao FR-017 e seria mais barato. Mas não cobre FR-023 (a auditoria
  seguiria num segundo request, portanto separável) nem devolve, por si, o `valor` anterior
  exigido pelo registro (FR-021). Rejeitado por FR-021+FR-023, não por FR-017.
- *Aceitar a janela de corrida*: proibido pelo Edge Case. Rejeitado.
- *Transação via `BEGIN` em conexão crua (`pg`)*: introduz um segundo cliente de banco e um
  pool novo num backend que hoje só fala PostgREST. Rejeitado (dependência nova para o que
  uma função resolve).

---

## Decision 6 — Auditoria: reusar `Auditoria` com `usuario_id` nulo no painel legado

**Decision**: reusar a tabela `Auditoria` existente. Autoria:
- sessão do **hub** → `usuario_id` = a pessoa (`req.hubContext.usuarioId`);
- **painel legado** → `usuario_id = NULL` + `id_empresa` = a conta da empresa.

Nenhuma tabela nova, nenhum usuário sintético.

**Rationale** — a tabela já aceita autoria sem pessoa e já é imutável, verificado em
`0004_auditoria.sql`:

| Linha | Conteúdo literal | Consequência |
|---|---|---|
| 6 | `id_empresa  int NULL,` | a empresa é representável |
| 7 | `usuario_id  int NULL REFERENCES "Usuario"(id),` | autoria sem pessoa é **legal no schema** |
| 21 | `GRANT SELECT, INSERT ON "Auditoria" TO authenticated;` | sem `UPDATE`/`DELETE` |
| 27 | `REVOKE UPDATE, DELETE ON "Auditoria" FROM authenticated;` | defesa em profundidade |
| 29 | *"Trigger que bloqueia INCONDICIONALMENTE qualquer UPDATE/DELETE"* | **FR-024 já satisfeito** |

Ou seja: **FR-024 (imutabilidade) vem de graça** e é o argumento mais forte contra criar
tabela nova — ela nasceria sem o trigger e sem o `REVOKE`, e duplicaria uma trilha que já
existe. O login legado é **por empresa, não por pessoa**: `usuario_id = NULL` diz
honestamente "não houve pessoa", enquanto um usuário sintético **inventaria autoria**
(proibido por FR-022: *"o sistema MUST NOT inventar autoria"*).

O que falta implementar é só a **cobertura do legado**: hoje a trilha retorna cedo —
`if (!(req.hubContext && req.hubContext.viaHub === true)) return;` (`server.js:157`) — e o
painel legado é o principal usuário do módulo. Como a gravação passa a ser feita **dentro da
função** (Decision 5), ela deixa de depender desse guard e passa a cobrir os dois caminhos
por construção. `auditarEnvioMassaSeViaHub` permanece intocada para os demais eventos
(`movimento_editado`, `envio_massa_importado`, …) — sem regressão.

**[PROPOSTA]** `detalhes` (jsonb) carrega `valor_anterior`, `valor_novo`, `motivo`, `origem`
(`tela` | `reimportacao`) e `gorjeta_anterior`/`gorjeta_nova`. Campos novos dentro de um
jsonb já existente — nenhuma coluna nova. A ação proposta é `movimento_valor_corrigido`,
distinta de `movimento_editado` para não misturar com a edição genérica.

---

## Decision 7 — Escopo por empresa: filtro explícito, porque o banco **não** escopa

**Decision**: todo acesso filtra `id_empresa` **explicitamente** — na consulta de casamento
do lote **e** dentro da função de Decision 5, que recebe `p_id_empresa` como parâmetro e o
aplica no `WHERE`. A empresa-alvo é resolvida por `resolveEmpresaAlvo`, já existente.

**Rationale**:
- O banco **não escopa `EnvioMassa` por empresa**. Verificado: a tabela recebe
  `GRANT SELECT, INSERT, UPDATE, DELETE … TO authenticated` por tabela
  (`0033_schema_legado_envio_massa.sql:192`; a 0113:19 reconfirma: *"GRANT da EnvioMassa é
  por tabela (0033); as colunas herdam"*) e **nenhuma policy de `EnvioMassa`** aparece nas
  migrations de RLS (`0006_rls_policies.sql` cita a tabela apenas em comentário). Com policy
  permissiva ou sem policy alguma, a conclusão operacional é a mesma, e é a que importa:
  **o filtro de empresa é responsabilidade da query** — requisito de segurança (FR-019),
  não detalhe de implementação.
- Por isso a função de Decision 5 **MUST NOT** identificar o movimento só pelo `id`: um
  `id` adivinhado de outra empresa precisa sair como *não encontrado* (FR-019), e é o
  `p_id_empresa` no `WHERE` que garante isso — não uma RLS (a tabela não tem RLS: só GRANT por tabela, `0033:192`; `0006:11-12`).
- `resolveEmpresaAlvo` (`routes/grupo.js:831`) satisfaz o Princípio II: o `empresa_id` do
  corpo é **validado** contra o escopo derivado do token (`_resolveScopeStrict`), com
  *fail-closed* — 403 fora do escopo, 503 se o escopo não puder ser resolvido, **nunca**
  degradação silenciosa para `user.empresaId`. O id nunca é *confiado* vindo do corpo.

**Alternatives considered**:
- *Confiar na RLS*: não há RLS nesta tabela (nenhum `CREATE POLICY`/`ENABLE ROW LEVEL SECURITY` para `EnvioMassa` em `infra/hub/migrations/` nem `docs/sql/`; comentários de `0109` e do briefing que falam em policy `USING (true)` não têm DDL). Rejeitado por evidência.
- *Criar policy de RLS para `EnvioMassa`*: mexer no modelo de acesso de uma tabela de
  produção compartilhada por vários caminhos (legado, hub, robô, FastAPI) é risco
  desproporcional e fora do escopo desta feature (FR-025). Rejeitado.

---

## Decision 8 — Permissão: reusar `envio_massa.criar`, que **já** protege os dois caminhos

**Decision**: nenhuma permissão nova. Reusar `envio_massa.criar`.

**Rationale** — verificado que os dois caminhos que a feature altera **já** a declaram, com
a cadeia de middleware idêntica:
- `POST /upload` → `server.js:1789`
- `PATCH /update-envio-massa/:id` → `server.js:1079`

ambos como `authenticateTokenCompartilhado, hubEnvioMassaClaimsBridge,
hubEnvioMassaRequirePermission('envio_massa.criar')`. FR-020 é satisfeito **por reuso**, e
as Suposições da spec já pedem para não criar permissão nova.

**Registrado, e deliberadamente fora de escopo**: a **sessão legada passa sem checagem de
permissão** — `if (!req.hubContext || req.hubContext.viaHub !== true) { return next(); }`
(`middleware/hub-envio-massa-permission.js:38-40`), o *modo compatibilidade estrutural*
(Decision 5 de `hub-envio-massa`, FR-018: *"NUNCA 403 para o painel legado"*). Isto **não é
regressão** desta feature e mudá-lo quebraria o painel legado, que é o principal usuário do
módulo. A consequência que **permanece obrigatória** para a sessão legada é o escopo por
empresa (Decision 7) e a auditoria (Decision 6) — autorização e isolamento são eixos
distintos, e o segundo não é dispensado pelo primeiro.

---

## Decision 9 — Tudo-ou-nada: preservado para linha **inválida**, quebrado para **ambígua**

**Decision**: duas regras distintas, conforme FR-005 e FR-006:
- linha **inválida** (formato/numérica) → **nada** é criado ou atualizado no lote
  (comportamento atual preservado; já é o que o `/upload` faz ao acumular `errors` e
  retornar antes do insert);
- linha **ambígua** (casa com mais de um movimento) → as demais linhas **são aplicadas**, a
  ambígua é listada e não tocada.

**Rationale**: FR-006 muda deliberadamente o tudo-ou-nada atual para ambiguidade, com
autorização explícita do operador (Q4): uma ambiguidade — resultado de duplicações
passadas — não pode travar centenas de linhas boas. FR-005 mantém o tudo-ou-nada para
inválidas porque ali o arquivo está errado e o operador deve corrigi-lo antes.

---

## Decision 10 — Limite de corpo: o `/upload` é multipart e **não** esbarra nos 100 KB

**Decision**: nenhuma mudança no `express.json()` global. O resultado da reimportação é
devolvido como **resposta**, não enviado como corpo de requisição.

**Rationale**: o `express.json()` global (sem `limit` em `server.js:225` ⇒ default do body-parser, 100 kb; também no briefing) roda **antes** do router e tornaria
inalcançável qualquer rota JSON de corpo grande. Mas:
- `POST /upload` é **multipart** via `multer` (`upload.single('file')`, `server.js:1789`) —
  não passa pelo parser JSON;
- a edição pela tela manda **JSON pequeno** (id, valor, motivo);
- o resumo de centenas de linhas (contagens + listas de pulados/ambíguos) é **resposta**, e
  limite de corpo não se aplica a resposta.

**Regra para a implementação**: se em algum momento o desenho passar a **trafegar** o resumo
de centenas de linhas como corpo de requisição, usar `express.text({ type })` **na própria
rota** — **nunca** subir o limite global. Não há motivo previsto para isso nesta feature.

---

## Decision 11 — Chunking do `in.()`: reusar `buscarEmLotes`, injetando o cliente

**Decision**: reusar `buscarEmLotes` (`lib/hub-postgrest-lotes.js`) acrescentando-lhe um
parâmetro **opcional** de cliente (`fetcher`), com default no atual `hubPostgrestRequest`.
O caminho legado passa o seu `postgrestRequest`.

**Rationale**:
- O helper **já encapsula a lição que importa**: um `in.()` grande **estourou o header do
  PostgREST em produção** (PR #50), e ele chunka em lotes de 100 (`tamanhoLote = 100`),
  agregando resultados e falhando **total, nunca parcial**. Reescrever isso em `server.js`
  duplicaria exatamente a lógica que já existe — e este repositório já pagou por ter "o
  mesmo mapa duplicado 3×".
- O helper hoje fala **só** com `hubPostgrestRequest` (cliente do hub, com JWT e claims),
  enquanto o `/upload` é legado e usa `postgrestRequest` (chave de serviço). **Não cruzar
  clientes**: um parâmetro opcional com default preserva 100% dos chamadores atuais
  (`routes/hub-adiantamentos.js`, 9 chamadas) e não troca a autenticação de ninguém.

**Alternatives considered**:
- *Chamar `hubPostgrestRequest` do caminho legado*: trocaria o cliente/auth de uma rota de
  produção por conveniência. Rejeitado.
- *Novo loop de chunking em `server.js`*: duplicação. Rejeitado.
- *Mover `buscarEmLotes` para um módulo neutro*: refatoração maior, 6 chamadores a tocar,
  sem ganho adicional. Rejeitado (o parâmetro opcional entrega o mesmo).

---

## Decision 12 — Estratégia de teste: controle negativo obrigatório

**Decision**: toda suíte que **afirma** uma correção roda também **contra o código antigo**,
e o plano registra **quais** testes falham nesse controle — não apenas que algum falhou.

**Rationale**: este repositório já teve teste que **afirmava o defeito** — foi por isso que
a suíte verde nunca o pegou (`producao-2026-10-12-fixes`: um teste afirmava o filtro que
escondia 71 movimentos). Um teste que passa contra o código antigo **e** contra o novo não
está testando a correção. O mapeamento esperado é declarado em `quickstart.md`.

---

## Itens sem fonte — nenhum pendente

Nenhum `NEEDS CLARIFICATION` estrutural restante. Os seis eixos estruturais
(linguagem/runtime, stack/frameworks, arquitetura, persistência, ambiente-alvo, tier de
entrega) são **herdados do projeto** e não são reabertos por esta feature: Node/Express +
PostgREST + Next.js, em container Docker no Swarm — fixados pelo briefing e pela
constitution, não por este plano.

## Nota de auditoria (onda-006) — procedência pendente

Auditoria `data-veracity-verifier` (onda-006): os 5 achados ALTA da onda-004 já estavam corrigidos
nos artefatos (tipos `double precision`/`bigint`, guarda `nota_ok`, `T03:00:00${offset}`). Ficam
**sem fonte reproduzível** (procedência a reforçar, não contradição): (a) contagens de `R$` e os literais
de mensagem medidos nos `.xlsx` (fora do alcance do verificador); (b) completude do inventário de índices
e "`uuid` sem índice" (negativa; o schema de `0033` é espelho do hub, os índices reais de produção não
estão no repo); (c) a afirmação de que a frase "O valor total para emissão da NF é de R$" só existe na
planilha: o hub **também** compõe `mensagem1/2` por molde editável (`lib/adiantamento-mensagem.js`,
`lib/adiantamento-geracao-movimento.js:189-190`, `AdiantamentoConfiguracao.mensagem1_modelo`) — movimentos
gerados pelo hub podem não ter a âncora; o ajuste automático de mensagem (FR-014) deve tratar "não
reconhecível" como já previsto na spec (Edge Cases), sem presumir a frase.
