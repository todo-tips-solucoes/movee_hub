# Contracts: API do hub (`/api/v1/adiantamentos`)

O browser chama `/api/v1/...` (`HUB_API_BASE`, `app_homologacao/frontend_v2/lib/hub/api.ts:18`)
e o proxy `app_homologacao/frontend_v2/app/api/[...path]/route.ts` repassa os cookies
httpOnly ao backend (constitution §III).

---

## Parte 1 — Convenções existentes (fonte: código)

| Item | Valor real | Fonte |
|---|---|---|
| Montagem das rotas do hub | `app.use('/api/v1/<recurso>', router)`, sem middleware na montagem | `backend/server.js:2855-2914` |
| Módulo ativo | `requireModuloAtivo(codigo)`: 401 `{erro:'NAO_AUTENTICADO'}`; 403 `{erro:'MODULO_DESABILITADO'}` (inclusive em erro — fail-closed) | `backend/middleware/hub-require-modulo.js:23` |
| Permissão | `requirePermission(codigo)`: 401 `NAO_AUTENTICADO`; 403 `PERMISSAO_NEGADA`; define `req.hubUsuarioId` | `backend/middleware/hub-require-permission.js:40` |
| Contexto da entidade | cópia local por arquivo; a de avisos exige `mesmoGrupoQue(entidadeAtiva, 6, cache)` → 403 `{erro:'FORA_DO_GRUPO_MOVEE'}`; 400 `ENTIDADE_NAO_SELECIONADA` sem entidade ativa; escopo = ids do grupo | `backend/routes/hub-avisos.js:126-150` |
| Claims para o PostgREST | `generateHubPostgrestJWT({usuarioId, empresaAtiva, escopo, …})` → `role:'authenticated'`, `sub`, `empresa_ativa`, `escopo` | `backend/lib/hub-postgrest-jwt.js:77` |
| Chamada | `hubPostgrestRequest(endpoint, method, body, claims, {count, range})`; erro não-2xx lança `Error` com `.status` e `.body` | `backend/lib/hub-postgrest.js:53` |
| Paginação | `page`, `pageSize` (padrão 20, máx. 100) | `backend/lib/hub-faturamento-dto.js:15-16, 98` |
| Datas | `de`, `ate` em `YYYY-MM-DD`; `DATA_INVALIDA`, `FILTRO_CONTRADITORIO` | `backend/lib/hub-faturamento-dto.js:53` |
| Lista (avisos) | `{itens, total, page, pageSize}` | `backend/routes/hub-avisos.js:256` |
| Lista (demais módulos) | `{items, total, page, pageSize}` | ex.: `backend/routes/hub-faturamento.js:270-275` |
| Erro 500 | `{erro:'ERRO_SERVIDOR'}` | rotas `hub-*.js` |
| CSV | `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="…"`, escrita em lotes; `escaparCelulaCsvInjection`, `quotarCelulaCsv` | `backend/routes/hub-faturamento.js:150-221`; `backend/lib/hub-csv.js:25,37` |
| Auditoria | `registrarAuditoria({idEmpresa, usuarioId, acao, recurso, recursoId, detalhes, ip, claims})`, nunca lança | `backend/lib/hub-auditoria.js:148` |
| Download no front | `fetch` → `blob` → nome do `Content-Disposition` → `<a download>` | `frontend_v2/lib/hub/faturamento-api.ts:100-121` |

**Escolha desta feature** (dec-014): listas no formato `{itens,total,page,pageSize}`, como a
PLANO §16.2 e o módulo de avisos.

---

## Parte 2 — Contratos novos `[PROPOSTA — a validar na implementação]`

Arquivo `backend/routes/hub-adiantamentos.js`, montado em `/api/v1/adiantamentos`. Toda
rota: `requireModuloAtivo('adiantamentos')` → `requirePermission('adiantamentos.<acao>')`
→ `resolverContextoAdiantamentos` (padrão de avisos, com uma diferença: o escopo é o grupo
inteiro **só** quando a entidade ativa é a empresa-pai 6; para uma filial, o escopo é
`[entidadeAtiva]` — constitution §II, dec-022). JSON em camelCase; dinheiro em
string decimal; ids numéricos; ações de mudança de estado com `motivo` de 3 a 500
caracteres quando obrigatório.

**Erros novos** (PLANO §16.2): `TRANSICAO_INVALIDA` (409), `VERSAO_DESATUALIZADA` (409),
`PREVIA_DESATUALIZADA` (409, com `divergencias`), `SOLICITACOES_EM_OUTRO_LOTE` (409, com
`ids`), `LOTE_ACIMA_DO_LIMITE` (422), `ARQUIVO_INDISPONIVEL` (409/410), `LIMITE_EXCEDIDO`
(429), `APURACAO_JA_FECHADA` (409), `APURACAO_NAO_CONFIGURADA` (409),
`APURACAO_COM_PENDENCIAS` (409, com `detalhe` por status — D-23). Mais os existentes
`DADOS_INVALIDOS`, `NAO_ENCONTRADO`, `PERMISSAO_NEGADA`, `MODULO_DESABILITADO`,
`ENTIDADE_NAO_SELECIONADA`, `FORA_DO_GRUPO_MOVEE`, `NAO_AUTENTICADO`, `ERRO_SERVIDOR`.

**Limiters** (chave `sub`): prévia e criação de lote, 30 / 15 min cada
(`[PROPOSTA]`; PLANO §20 não fixa o número); os valores ficam em constantes no topo do
arquivo, como `disparoRateLimiter` em `hub-avisos.js:209`.

### Solicitações

| Método e caminho | Permissão | Request | Response |
|---|---|---|---|
| `GET /` | `consultar` | query `de`, `ate`, `busca`, `status` (lista), `exportado`, `pago`, `pendencia`, `page`, `pageSize`, `ordem` | `{itens:[SolicitacaoResumo], total, page, pageSize}` |
| `GET /:id` | `consultar` | — | `SolicitacaoDetalhe` |
| `POST /:id/rejeitar` | `gerenciar` | `{motivo}` | `SolicitacaoDetalhe` (`REJEITADA`); 409 `TRANSICAO_INVALIDA` fora de `LIBERADA`/`AGUARDANDO_PRODUCAO` |
| `POST /:id/recalcular` | `gerenciar` | — | `SolicitacaoDetalhe` (só `AGUARDANDO_PRODUCAO`) |
| `POST /:id/encerrar` | `gerenciar` | `{motivo}` | `SolicitacaoDetalhe` (`INELEGIVEL`; só `AGUARDANDO_PRODUCAO`, Q-N14) |
| `POST /:id/atualizar-conta` | `gerenciar` | `{motivo}` | `SolicitacaoDetalhe` — troca o snapshot da conta pela aprovada vigente (pendência `CONTA_ALTERADA`, R-10) |
| `POST /:id/reprocessar` | `reprocessar` | `{motivo}` | `SolicitacaoDetalhe` (`LIBERADA`; só `FALHOU`, R-14) |
| `POST /:id/encerrar-falha` | `reprocessar` | `{motivo}` | **D-23** (operador, 2026-09-17): `SolicitacaoDetalhe` (`ENCERRADA`); só `FALHOU`; motivo obrigatório; 409 `TRANSICAO_INVALIDA` fora de `FALHOU`; audita `adiantamento.encerrado_sem_pagamento`; notifica o motorista ("pagamento não realizado") |

`SolicitacaoResumo`: `id`, `integrationId`, `motorista {entregadorId, nome}`,
`dataSolicitacao`, `dataProducao`, `status`, `motivoStatus`, `valorLiquido`,
`pendencias[]`, `loteId`. `SolicitacaoDetalhe` = resumo + `calculo`
(`{fonte, categorias, producao, porCategoria, percentual, bruto, taxa, liquido, calculadoEm, versaoConfiguracao}`),
`contaMascarada`, `eventos[]` (timeline com ator e motivo), `lotes[]` (histórico).

### Configuração

| Método e caminho | Permissão | Request | Response |
|---|---|---|---|
| `GET /configuracoes` | `consultar` | — | `{vigente: Configuracao, historico:[{versao, vigenteDesde, criadoPor, criadoEm, motivo, alteracoes}]}` |
| `GET /configuracoes/categorias` | `consultar` | `?fonte=` | `{itens:[{descricao, lancamentos, semMotoristaIdentificado}]}` — últimos 90 dias |
| `PUT /configuracoes` | `configurar` | `{versaoEsperada, vigenteDesde?, motivo?, diasHabilitados, horarioAbertura, horarioCorte, percentual, taxaFixa, fonteProducao, categoriasProducao, previsaoPagamentoTexto, descricaoPixModelo, apuracaoDiaInicio, apuracaoDiasAteRepasse, apuracaoDataBase, categoriasExtrato, categoriasNota, descontoAdiantamentos, descontoDebitos, repasseVisivelApp}` | 201 `Configuracao` (N+1); 409 `VERSAO_DESATUALIZADA`; 400 `DADOS_INVALIDOS` |

`Configuracao`: os mesmos campos em camelCase + `versao`, `vigenteDesde`, `timezone`,
`completa` (FR-025). Auditoria `adiantamento.configuracao_alterada` com o diff.

### Contas bancárias

| Método e caminho | Permissão | Request | Response |
|---|---|---|---|
| `GET /contas` | `contas_consultar` | `status`, `origem`, `semAlertas`, `busca`, `banco`, `page`, `pageSize` | `{itens:[ContaMascarada], total, page, pageSize}` |
| `GET /contas/:id` | `contas_consultar` | — | `ContaMascarada` — **[Correção 11.27]** sem `entregador`/histórico (código real; ver nota abaixo) |
| `GET /contas/:id?completo=true` | `contas_revisar` | — | `ContaCompleta` (inclui `entregadorVinculado`); audita `conta_bancaria.visualizada` (FR-019) |
| `POST /contas/:id/aprovar` | `contas_revisar` | `{entregadorConfirmadoId}` | `APROVADA`; a anterior vira `SUBSTITUIDA`; notifica |
| `POST /contas/:id/rejeitar` | `contas_revisar` | `{motivo}` | `REJEITADA`; notifica |
| `POST /contas/aprovar-lote` | `contas_revisar` | `{ids}` (≤ 5.000) | `{aprovadas, ignoradas:[{id, motivo}]}` — só `origem=CARGA_INICIAL`, `PENDENTE`, sem alertas (Q-N5) |

**[Correção 11.29 — converge]** `banco` documentado retroativamente: capacidade real
(`routes/hub-adiantamentos.js:552-558`, dec-105/protótipo H06), sem FR/menção nesta
PROPOSTA original. Decisão: manter — 1.735 contas na carga inicial tornam o filtro
útil pro financeiro, e é um `p_banco` opcional passado direto à RPC existente
(`hub_conta_bancaria_listar`), sem superfície nova de risco; só faltava o registro.

`ContaMascarada`: `id`, `status`, `origem`, `banco`, `agencia`, `contaMascarada`
(`••••4521-7`), `tipoConta`, `titularNome`, `documentoMascarado` (`***.***.***-41`),
`alertas[]`, `solicitadaEm`, `revisadaEm`. `ContaCompleta` acrescenta `titularDocumento`,
`conta`, `contaDigito`, `chavePixTipo`, `chavePix`, `emailComprovante`,
`entregadorVinculado {entregadorId, nome}` (FR-018). Resposta com dado completo sai
com `Cache-Control: no-store`.

**[Correção 11.27 — converge]** Esta proposta original previa `entregador{}` +
histórico também no `GET /contas/:id` **sem** `completo=true` (`ContaMascarada` pura).
Decisão: converge o contrato para o código, não o inverso — `hub_conta_bancaria_mascarar`
(SQL, `infra/hub/migrations/0067_adiantamento_funcoes.sql:863-886`) nunca teve
`entregadorId`/`entregadorNome`, só `hub_conta_bancaria_detalhe(p_completo=true)` tem
(`:865-878`); `entregadorVinculado` já sai em `ContaCompleta` (acima). "Histórico" de
conta bancária não existe em nenhuma tabela/migration do hub — implementá-lo aqui
inventaria um schema sem fonte (Constitution VI). E o cliente tipado nunca chamou o
modo mascarado para entregador: `obterConta()` (`frontend_v2/lib/hub/adiantamentos-api.ts:361`)
só é exercitado pelo próprio teste (`adiantamentos-api.test.ts:145-155`); a única tela
que precisa do entregador (`app/hub/dashboard/adiantamentos/contas/[id]/page.tsx:58`) já
usa `obterContaCompleta()`.

### Pagamentos e lotes

| Método e caminho | Permissão | Request | Response |
|---|---|---|---|
| `POST /lotes/previa` | `pagamentos_consultar` | `{ids}` (1–5.000, sem repetição tratada como pendência) | `{selecionadas, aptas:[LinhaPrevia], pendentes:[{id, pendencias:[codigo]}], quantidadeApta, totalApto}` |
| `POST /lotes` | `lote_criar` | `{ids, quantidadeEsperada, totalEsperado, chaveIdempotencia}` | 201 `Lote` (`GERADO`); 200 no reenvio da mesma chave; 409 `PREVIA_DESATUALIZADA`/`SOLICITACOES_EM_OUTRO_LOTE`; 422 `LOTE_ACIMA_DO_LIMITE`; 500 `{erro:'FALHA_GERACAO_ARQUIVO'}` com o lote já `CANCELADO` |
| `GET /lotes` | `pagamentos_consultar` | `de`, `ate`, `status`, `page`, `pageSize` | `{itens:[Lote], total, page, pageSize}` |
| `GET /lotes/:id` | `pagamentos_consultar` | — | `Lote` + `itens[]` (snapshot, documento e conta mascarados) + `historico[]` |
| `GET /lotes/:id/arquivo` | **`exportar`** | — | bytes do xlsx; 409 `ARQUIVO_INDISPONIVEL` (lote `GERANDO`/`CANCELADO`) ou 410 (bytes expurgados) |
| `POST /lotes/:id/cancelar` | `reprocessar` | `{motivo, naoEnviadoATransfeera}` | `Lote` (`CANCELADO`); itens voltam a `LIBERADA`; depois do download exige `naoEnviadoATransfeera: true` |
| `POST /lotes/:id/confirmacao` | `pagamento_confirmar` | `{falhas:[{id, motivo}]}` (`id` = solicitação) | `Lote` (`CONCLUIDO` ou `CONCLUIDO_COM_FALHAS`); demais itens `pago` |
| `POST /lotes/:id/retorno` | `pagamento_confirmar` | `{csvBase64}` (CSV do retorno da Transfeera, base64, mesmo contrato de transporte de `hub_adiantamento_lote_arquivo`) | **FASE 9** (dec-129, 2026-09-18): casa cada linha pelo `ID de integração` (`ADV-<id>`, nunca por nome/valor) e reusa `hub_adiantamento_lote_confirmar`; 200 `{aplicadas, ignoradas:[{idIntegracao, motivo}]}`; 400 `DADOS_INVALIDOS`/`ARQUIVO_INVALIDO` (`CABECALHO_INVALIDO`/`ARQUIVO_VAZIO`); 404 `NAO_ENCONTRADO` (lote sem itens no escopo); 409 `RETORNO_INCOMPLETO` (`{faltantes:[id]}` — item `incluido` sem resolução no arquivo, nunca aplicado por omissão) ou `TRANSICAO_INVALIDA`. Idempotente (9.1.5): reimportar não muda nada, tudo volta como `ignoradas` com motivo `JA_APLICADO`. `[ADAPTADO]` `origem_situacao` continua `'manual'` (não `'retorno'`, ver data-model.md) — a RPC reusada não distingue a origem; sem migration nova nesta FASE |

`Lote`: `id`, `numero` (`000123`), `status`, `criadoPor {id, nome}`, `criadoEm`,
`quantidade`, `valorTotal`, `arquivoNome`, `arquivoSha256`, `downloads`,
`primeiroDownloadEm`, `canceladoEm`, `canceladoMotivo`, `concluidoEm`.
`LinhaPrevia`: `id`, `integrationId`, `motorista`, `valor`, `bancoAgenciaContaMascarados`.

Pendências realmente emitidas (12.5, converge onda-044 — `hub_adiantamento_lote_previa`,
0075:240-251, + duplicata na própria seleção detectada no Node,
`hub-adiantamentos.js:810`): `JA_EM_LOTE`, `STATUS_<status>` (status atual da solicitação
quando diferente de `LIBERADA`), `VALOR_INVALIDO`, `CONTA_ALTERADA` (conta do snapshot
ausente ou não mais `APROVADA` — funde os antigos `CONTA_AUSENTE`/`CONTA_NAO_APROVADA`,
11.5), `DUPLICADA_NA_SELECAO`. A lista aspiracional anterior (`STATUS_INVALIDO`,
`NOME_AUSENTE`, `DOCUMENTO_INVALIDO`, `BANCO_INVALIDO`, `AGENCIA_INVALIDA`,
`CONTA_INVALIDA`, `DIGITO_AUSENTE`, `TIPO_CONTA_INVALIDO`, `EMAIL_INVALIDO`, `LIMITE_5000`)
nunca foi implementada — o limite de itens do lote é o 422 `LOTE_ACIMA_DO_LIMITE` já
documentado acima, não uma pendência por item.

**Download** (`GET /lotes/:id/arquivo`):

| Header | Valor |
|---|---|
| `Content-Type` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `Content-Disposition` | `attachment; filename="transfeera_adiantamentos_<AAAA-MM-DD>_lote-<NNNNNN>.xlsx"` |
| `Cache-Control` | `no-store` |
| `X-Content-Type-Options` | `nosniff` |

Os mesmos bytes a cada download (sha256 conferido antes de enviar); o 1º download move o
lote para `EXPORTADO` e as solicitações para `EXPORTADA`; cada download é auditado com o
número de ordem (FR-030). Os bytes nunca vão para log, auditoria ou mensagem de erro.

### Repasse

| Método e caminho | Permissão | Request | Response |
|---|---|---|---|
| `GET /repasse` | `pagamentos_consultar` | `periodo` (data de início), `busca`, `somenteNegativos`, `page`, `pageSize` | `{periodo {inicio, fim, dataRepasse, situacao}, totais {creditos, adiantamentos, debitos, remanescente, motoristas}, itens:[{entregadorId, nome, creditos, adiantamentos, debitos, remanescente, negativo, emProcessamento}], total, page, pageSize}` (12.6: não há bloco `descontos{}` separado — `adiantamentos`/`debitos` já vêm dentro de `totais{}`, `hub-adiantamentos.js:1359-1364`) |
| `GET /repasse/exportar` | `pagamentos_consultar` | `periodo` | CSV em streaming (`hub-csv.js`), `Content-Disposition: attachment; filename="repasse-<inicio>_<fim>.csv"` |
| `POST /repasse/:periodo/fechar` | `pagamento_confirmar` | `{confirmacao: true}` | **D-23** (operador, 2026-09-17): 201 `{apuracaoId, motoristas, total, naoPagosNoPeriodo}`; 409 `APURACAO_COM_PENDENCIAS` (`{erro, detalhe: {<STATUS>: <contagem>, ...}}` — recusa enquanto houver solicitação com `dataProducao` no período em `AGUARDANDO_CORTE`/`AGUARDANDO_PRODUCAO`/`LIBERADA`/`EM_LOTE`/`EXPORTADA`/`FALHOU`) / `APURACAO_JA_FECHADA` / `APURACAO_NAO_CONFIGURADA` / 409 `PERIODO_EM_ABERTO` (1.6.3: a produção do último dia da janela ainda pode ser solicitada até o corte do dia seguinte) |

`naoPagosNoPeriodo` também vem no `GET /repasse` para o diálogo de confirmação (dec-020).

### Avisos (mudança em contrato existente)

Hoje a prévia de alcance (`GET` em `backend/routes/hub-avisos.js:268`) responde
`{motoristas, inscricoes}` contando só quem tem `PushInscricao` (`:314-315`: `motoristas` =
CNPJs distintos com inscrição, `inscricoes` = linhas). Com D-15:

- a prévia passa a responder `{motoristas, comPush, inscricoes}`: `motoristas` = público
  total do histórico, `comPush` = CNPJs com inscrição, `inscricoes` mantido (compatível
  com o front atual), para o texto "N motoristas · M com push" (PLANO §19);
- `POST /api/v1/avisos` (`:420`) grava o histórico para todo o público e não recusa mais o
  envio só porque ninguém ativou push. O `SEM_INSCRICOES_ATIVAS` dá lugar a
  `SEM_DESTINATARIOS` quando o público está vazio.

---

## Permissões por rota (PLANO §21) e rótulos

Hoje o rótulo é derivado **só do verbo** (sufixo do código) em
`frontend_v2/lib/hub/rotulo-permissao.ts` (`VERBOS`, `ALTO_IMPACTO`, `rotuloPermissao`);
`consultar` vira "Acessar o módulo" quando o módulo não tem `listar`. Dois verbos já
mapeados mentiriam aqui: `exportar` = "Exportar (CSV)" e `gerenciar` = "Administrar tudo
do módulo". A F7 acrescenta um mapa por **código completo**, consultado antes do mapa de
verbos, e marca como alto impacto por código as permissões que movem dinheiro ou expõem
dado bancário. Rótulos `[PROPOSTA]`:

| Permissão | Rótulo | Alto impacto |
|---|---|---|
| `adiantamentos.consultar` | Acessar o módulo (verbo existente) | não |
| `adiantamentos.gerenciar` | Rejeitar, recalcular e encerrar adiantamentos (por código) | sim (já é, pelo verbo) |
| `adiantamentos.configurar` | Alterar regras do adiantamento | sim |
| `adiantamentos.contas_consultar` | Ver contas bancárias (mascaradas) | não |
| `adiantamentos.contas_revisar` | Ver completas e aprovar contas bancárias | sim |
| `adiantamentos.pagamentos_consultar` | Ver pagamentos, lotes e repasse | não |
| `adiantamentos.lote_criar` | Criar lote de pagamento | sim |
| `adiantamentos.exportar` | Baixar arquivo da Transfeera (por código) | sim |
| `adiantamentos.reprocessar` | Reprocessar falhas e cancelar lotes | sim |
| `adiantamentos.pagamento_confirmar` | Confirmar pagamentos e fechar apuração | sim |

O teste `rotulo-permissao.test.ts` ganha os 10 códigos na lista de permissões conhecidas.
