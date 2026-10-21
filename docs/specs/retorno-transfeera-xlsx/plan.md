# Implementation Plan: Importar o retorno da Transfeera em XLSX

**Feature**: `retorno-transfeera-xlsx` | **Spec**: [spec.md](spec.md) | **Data**: 2026-10-21 (onda-003)
**Artefatos**: [research.md](research.md) · [data-model.md](data-model.md) · [contracts/retorno-xlsx.md](contracts/retorno-xlsx.md) · [quickstart.md](quickstart.md)

## Summary

A frente e "novo leitor de arquivo": o casamento por `ADV-/REP-` (`extrairIdSolicitacao`,
`casarComItensDoLote`, `deduplicarPorIdIntegracao`) e os efeitos de negocio nao mudam. Mudam, em
ordem de dependencia: (1) **o proxy do frontend**, que hoje corrompe qualquer corpo binario
(achado novo, ver D1); (2) o leitor (`lerCsv` -> `lerXlsx`) em `lib/adiantamento-retorno-transfeera.js`;
(3) as duas rotas (`express.text` -> `express.raw`); (4) o dialog compartilhado + `adiantamentos-api.ts`;
(5) textos (dialog e Central de Ajuda). Sem migration, sem dependencia nova, sem lock.

## Technical Context

| Campo | Valor |
|-------|-------|
| Backend | Node 20 (`node:20-alpine`, `Dockerfile.hub`), Express, `node --test` |
| Frontend | Next.js App Router (`frontend_v2`), vitest, tsc, eslint |
| Leitor | `xlsx` 0.20.3 (SheetJS) — **ja dependencia** do backend (`package.json:29`), `package-lock.json` sem diff |
| Persistencia | nenhuma nova; RPCs `hub_adiantamento_lote_confirmar` / `hub_repasse_lote_confirmar` inalteradas |
| Migration | **NENHUMA** (confirmado: nenhuma coluna/RPC/permissao muda) |
| Escala | 1 lote <= 5000 itens (`LOTE_LIMITE_IDS`); arquivo <= 10.000 linhas de dados |
| NEEDS CLARIFICATION | 0 (nenhum eixo estrutural em aberto: stack, runtime, persistencia e ambiente herdados) |

## Constitution Check (docs/constitution.md)

| Principio | Status | Notas |
|-----------|--------|-------|
| I Auth/segredos | PASS | rotas mantem `requireModuloAtivo` + `requirePermission` ANTES do parser de corpo; nenhum segredo novo; fixture ja anonimizada (ver D9) |
| II Multi-tenant | PASS | escopo continua vindo de `claims.escopo`; o arquivo so escolhe o item por ID dentro do lote ja filtrado por `id_empresa` |
| III Proxy/contratos | PASS com ajuste | continua via proxy `/api/*`; o proxy ganha ramo binario (D1) — contrato do corpo muda de `text/csv` para XLSX |
| IV Qualidade | PASS | branch `feat/retorno-transfeera-xlsx`, Conventional Commits, `git add` explicito |
| V Deploy | PASS | backend + frontend_v2 deployados juntos pelo operador (D10); nada fora desses dois servicos |

Re-check pos-design: sem camada nova, sem abstracao nova, sem dependencia. PASS.

## Decisoes de design (com numeros)

### D1. 🔴 O proxy `app/api/[...path]/route.ts:103` corrompe binario (achado novo desta onda)

Para todo `Content-Type` que nao e `multipart/form-data` o proxy faz `init.body = await req.text()` —
decodifica UTF-8, e todo byte >= 0x80 invalido vira U+FFFD. Um XLSX (ZIP) nao sobrevive.
Isto invalida FR-001 se so as rotas e o frontend forem tocados: o teste de rota passaria, a
producao devolveria `FORMATO_INVALIDO` para o arquivo bom.

**Mudanca**: novo ramo, restrito ao mime XLSX (nao muda o caminho de nenhum outro endpoint):
`else if (contentType.includes('spreadsheetml.sheet')) init.body = new Uint8Array(await req.arrayBuffer());`
e `corpoReenviavel` passa a aceitar `Uint8Array` (o retry apos 401 reenvia o mesmo buffer; `Uint8Array`
e reutilizavel, diferente de stream). Nao ha `middleware.ts`/`proxy.ts` no frontend (verificado) logo nao
ha teto de corpo do Next a dimensionar; o teto efetivo e o do backend (D4).
**Teto no proxy (achado owasp F2, medium)**: o proxy bufferiza o corpo inteiro ANTES de qualquer autenticacao do backend; sem teto, qualquer cliente
da internet faz o Next alocar corpo arbitrario nesse ramo. O ramo XLSX recusa antes de ler: `content-length` ausente/invalido -> `411`, `> 10 MB` -> `413`
(JSON `{erro:'ARQUIVO_INVALIDO', motivo:'ARQUIVO_MUITO_GRANDE'}`), reaproveitando a constante de 10 MB; o teste afirma que `req.arrayBuffer` NAO foi chamado nesses casos.
O mime e comparado por igualdade apos `split(';')[0].trim()`, nao por `includes`.
**Prova**: `route.test.ts` ganha teste com corpo contendo bytes invalidos em UTF-8 (`0x80..0xFF`, `PK\x03\x04`)
e compara byte a byte o que chega ao `fetch` mockado; **controle negativo**: o mesmo teste falha contra o
proxy atual (ele entrega string com U+FFFD).

### D2. Leitor: `lerXlsx(buffer)` substitui `lerCsv` — o CSV sai por inteiro

Mora em `lib/adiantamento-retorno-transfeera.js` (mesmo modulo que ja exporta `casarComItensDoLote`;
nao cria arquivo novo). Assinatura: `lerXlsx(buffer: Buffer) -> Linha[]`, lanca `RetornoTransfeeraParseError(motivo)`.
`Linha = {idIntegracao, status, statusConhecido, valorCentavos, motivoFalha}` (a mesma forma de hoje, sem `codigoErro`, que nao existe no XLSX).

**Removidos** (CSV e FR-002 — manter seria codigo morto sem chamador): `lerCsv`, `dividirCsvRfc4180`,
`motivoLiteral`'s ramo `codigoErro`, a coluna `Codigo de erro` em `normalizarLinha`.
**Mantidos e reusados**: `RetornoTransfeeraParseError`, `extrairIdSolicitacao`, `regexIdIntegracao`,
`deduplicarPorIdIntegracao`, `casarComItensDoLote`, `STATUS_CONHECIDOS`, `paraCentavos`, `MAX_LINHAS_RETORNO`.
`CABECALHO_ESPERADO` **fica, com as 21 colunas** (e exportado: os testes das rotas o usam para montar planilhas).
O nome da coluna de tipo de conta e **`Tipo de Conta (Corrente ou Poupança)`** (copiado do cabecalho
da fixture; o BRIEFING abrevia para `Tipo de Conta`, que NAO bate) — o teste do cabecalho le a fixture e compara.

Pipeline interno (ordem = barato -> caro; qualquer falha = `RetornoTransfeeraParseError`):
1. `Buffer.isBuffer && length > 0`, senao `FORMATO_INVALIDO`.
2. Magic `PK\x03\x04` (4 bytes), senao `FORMATO_INVALIDO`. **Este e o filtro que impede o SheetJS de
   "farejar" CSV/HTML/XML/Lotus** (a mesma razao pela qual o leitor CSV proprio existiu em 2026-09-18): so ZIP chega ao `XLSX.read`.
3. Teto de descompressao: ler o diretorio central do ZIP (EOCD nos ultimos 65.557 bytes), somar os tamanhos
   *declarados* descomprimidos; recusar (`ARQUIVO_MUITO_GRANDE`) se > 32 MiB ou > 100 entradas; EOCD ausente
   ou ZIP64 -> `FORMATO_INVALIDO`. ~25 linhas, sem dependencia.
4. `XLSX.read(buf, {type:'buffer', sheetRows: MAX_LINHAS_RETORNO + 2, cellFormula:false, cellHTML:false, cellStyles:false, cellDates:false, bookDeps:false, bookProps:false})` em `try/catch` -> `FORMATO_INVALIDO`. So a **primeira aba** (`SheetNames[0]`); sem aba -> `FORMATO_INVALIDO`.
5. Recusar por dimensao: `!fullref` (ou `!ref`) com linha final > `MAX_LINHAS_RETORNO + 1` -> `ARQUIVO_MUITO_GRANDE` (cobre linhas em branco que empurram dados para alem do corte de `sheetRows`).
6. `sheet_to_json(ws, {header:1, raw:true, defval:'', blankrows:false})`: linha 0 = cabecalho; **a presenca da coluna e posicional pelo cabecalho** (FR-004, `defval:''` preenche celula vazia). Sem linhas -> `ARQUIVO_VAZIO`.
7. Cabecalho (cada celula `String(c).trim()`) deve igualar `CABECALHO_ESPERADO` por `JSON.stringify` (nome + ordem + 21) senao `CABECALHO_INVALIDO` — **antes** de normalizar qualquer linha.
8. Indices das 4 colunas usadas (`ID integração`, `Status`, `Valor`, `Motivo`) resolvidos **uma vez**; cada linha produz so os 4 campos (nao o objeto de 21 chaves de hoje).

Tipos de celula (FR-010): `raw:true` devolve `cell.v`; tudo e coagido com `String(v).trim()` — texto (`"54,57"` na amostra),
numero nativo (`54.57` -> `"54.57"`), formula (so o valor em cache; `cellFormula:false`, nada e avaliado). Nenhum caminho executa conteudo.

**Log (owasp F7, low)**: os `catch` das rotas logam so uma mensagem constante + `e.name`, nunca `e.message` de SheetJS nem bytes/celulas do arquivo (mensagens do parser podem ecoar conteudo de terceiro).

### D3. `STATUS_CONHECIDOS = {'FINALIZADO','Finalizada','Devolvida'}` (reversao do operador, prevalece sobre a onda-002)

`FINALIZADO` medido no XLSX (58/58); `Finalizada`/`Devolvida` medidos no CSV da mesma fornecedora. Comparacao por `trim` + caixa exata.
Efeito: nenhum ramo novo. `casarComItensDoLote` ja so distingue `Devolvida` (-> `motivo`); `FINALIZADO` cai no mesmo caminho de
`Finalizada` (pagamento efetivado), e os filtros `a.status === 'Devolvida'` das duas rotas continuam corretos sem edicao.
**Proibido**: `DEVOLVIDO` ou qualquer rotulo nao medido. Rotulo desconhecido -> `STATUS_DESCONHECIDO:<valor>` (mecanismo existente).
FR-006 resolvido sem mecanismo novo.

**FR-014 (sanear o valor)**: dentro de `casarComItensDoLote`, `STATUS_DESCONHECIDO:${rotuloStatus(linha.status)}` com
`rotuloStatus = s => String(s).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40)`. Fica no lib (borda do backend) e cobre as DUAS rotas
(o repasse chama a mesma funcao). O teto de 40 e deliberado: o valor aparece numa lista curta na tela (`rotuloIgnorada`).
Teste: status de 5.000 caracteres com `<script>` e controle `\u0000` -> motivo <= 40 + prefixo, sem `<`/`>`/controle; **mutacao**: tirar o `.slice`/`.replace` faz o teste falhar.

### D4. Rotas e limites — dois tetos, cada um com seu lugar

| Teto | Valor | Onde | Racional (medido) |
|------|-------|------|-------------------|
| Bytes de **transporte** | **10 MB** | `express.raw({limit:'10mb', type: XLSX_MIME})` nas DUAS rotas (e `XLSX_MAX_BYTES` no dialog, antes do upload) | amostra: 61.883 B / 58 linhas (ZIP "Stored", ~820 B/linha) => 10.000 linhas ~ 8,2 MB no pior caso (sem compressao). 10 MB cobre o teto de linhas; baixa dos 12 MB do CSV |
| Bytes **descomprimidos** | **32 MiB** (e <= 100 entradas) | `lerXlsx` passo 3, antes de `XLSX.read` | deflate chega a ~1000:1; 10 MB comprimidos poderiam ser GB. 32 MiB = 4x o pior caso legitimo (8,2 MB) |
| **Linhas** | `MAX_LINHAS_RETORNO = 10000` linhas de dados (mantido) | `lerXlsx` passos 4–5 (`sheetRows` + `!fullref`) | lote ate 5000 itens (`LOTE_LIMITE_IDS`); 2x cobre reenvio/concatenacao. `sheetRows` impede o SheetJS de materializar mais que 10.002 linhas |

Parser: `express.raw({ limit: '10mb', type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] })` **na propria rota**
(depois de `requireModuloAtivo` + `requirePermission` + `retornoRateLimiter`; **nunca** no `express.json()` global). `Content-Type` inesperado
(incluindo `text/csv`, `text/plain`, `application/octet-stream`, ausente): o parser nao casa, `req.body` fica `{}` e a rota responde
**400 `{erro:'ARQUIVO_INVALIDO', motivo:'FORMATO_INVALIDO'}`** (hoje: `DADOS_INVALIDOS/csv`). Corpo > 10 MB: `413` do proprio `express.raw`
(sem handler JSON dedicado — `server.js:2467` so cobre as rotas XML; resposta HTML padrao do Express, igual a rota CSV de hoje; o dialog barra > 10 MB no cliente antes do envio, e o teste de rota afirma o status 413).
Constante do mime: uma so no backend (`lib/adiantamento-retorno-transfeera.js` exporta `XLSX_MIME`) importada pelas duas rotas.

SC-004 (medido nesta onda: 10.000 linhas = 1.032.555 B comprimido, `XLSX.read`+`sheet_to_json` ~100 ms; `sheetRows:10002` retorna 10.002 linhas e `!fullref` expoe o tamanho real, `A1:B10006` num teste de 10.005): arquivo sintetico de 10.000 linhas montado no teste, `lerXlsx` + `casarComItensDoLote` medidos com `process.hrtime` (alvo < 5 s; o relato do execute traz o numero).

### D5. `paraCentavos` — milhar BR (`1.234,56`) hoje da `NaN`

Medido no codigo: o regex `^(-?)(\d+)(?:[.,](\d+))?$` nao casa `1.234,56`; o fallback `Number("1.234,56")` e `NaN`.
**Onde entra**: dentro de `paraCentavos` (`lib/adiantamento-remanescente.js:33`), um unico ramo novo **antes** do fallback e **so para o padrao que
hoje produz NaN**: `/^(-?)(\d{1,3}(?:\.\d{3})+),(\d+)$/` -> remove os pontos e reentra no caminho existente. Estrito e proposital:
`1.234` (so ponto) continua sendo decimal em `paraCentavos` (`123` centavos, comportamento atual), `54,57` e `54.57` inalterados. **No retorno**, porem, `1.234`/`12.345` e ambiguo e vira `VALOR_AMBIGUO:<texto>` na borda (D5.bis).
**Chamadores vivos** (todos recebem numeric do banco ou numero, nunca texto com milhar BR):
`adiantamento-remanescente.js` (82, 105, 107, 162, 171), `adiantamento-dto.js:30`, `adiantamento-transfeera-xlsx.js:159`,
`routes/hub-repasse-lotes.js` (171, 199, 303), `routes/hub-adiantamentos.js` (import `:69`), e o proprio retorno.
**Prova de nao-regressao** (FR-008): teste de caracterizacao com tabela *congelada* de entradas->saidas do comportamento atual
(inteiros, `0`, negativos, `54,57`, `54.57`, `1.005`->101, `8.165`->817, `2.675`->268, `1e3`, numero nativo, string com espacos)
que passa ANTES e DEPOIS da mudanca (rodar antes de editar e relatar), mais a suite inteira dos 6 arquivos chamadores. Saidas validas no novo ramo:
`1.234,56`->123456, `-1.234,56`->-123456, `12.345.678,9`->1234567890. `abc`, `1.2.3,4`, `R$ 1.234,56` -> `NaN` (**`paraCentavos('')` -> `0`, comportamento existente mantido**; o vazio nunca chega la: `normalizarLinha` so converte se o texto nao e vazio, senao `null`)
(e `normalizarLinha` converte `!Number.isFinite` em `null`, que nunca iguala o valor do item -> `VALOR_DIVERGENTE`; nunca confirma valor errado).

### D6. Frontend — assinatura e textos

- `adiantamentos-api.ts`: `importarRetornoLote(id, xlsx: ArrayBuffer)` e `importarRetornoLoteRepasse(id, xlsx: ArrayBuffer)` — as duas viram
  chamadas de um helper privado `postarRetorno(path, xlsx)` (`method:'POST'`, header `Content-Type: XLSX_MIME`, `body: xlsx`). `XLSX_MIME` exportado
  dali. O `request()` de `lib/hub/api.ts:80` so adiciona `application/json` quando nao ha header proprio (o spread de `init.headers` vem depois) — verificado.
- `adiantamento-importar-retorno-dialog.tsx`: `importar?: (id, xlsx: ArrayBuffer) => ...` (default e os dois chamadores do repasse/adiantamento acompanham);
  `arquivo.text()` -> `await arquivo.arrayBuffer()` (nunca `text()`: decodifica e corrompe); `accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"`;
  `CSV_MAX_BYTES` -> `XLSX_MAX_BYTES = 10 * 1024 * 1024` (alinhado ao backend); rotulo "Arquivo CSV" -> "Arquivo XLSX"; frase da linha ~188 reescrita
  ("Envie o arquivo `.xlsx` baixado da Transfeera, sem editar as colunas. Cada pagamento e casado pelo ID de integracao ..."); `MOTIVO_ARQUIVO.CABECALHO_INVALIDO`
  ("Exporte o relatorio em CSV" **mente depois da mudanca**) -> "O cabeçalho não é o do retorno da Transfeera. Envie a planilha XLSX baixada de lá, sem editar as colunas.";
  novo `FORMATO_INVALIDO`: "O arquivo não é uma planilha XLSX válida. Envie o .xlsx baixado da Transfeera."; comentarios do cabecalho do arquivo e do topo atualizados.
- `rotuloIgnorada` e `MOTIVO_IGNORADA` **nao mudam** (reuso total; `STATUS_DESCONHECIDO:` ja e renderizado e agora vem saneado do backend).
- Testes: `adiantamento-importar-retorno-dialog.test.tsx` (mock de `importar` recebe `ArrayBuffer`; `File` `.xlsx`; mensagens novas), `repasse-lote-dialogs-reuso.test.tsx`,
  `route.test.ts` (D1), `page.test.tsx` do lote/repasse onde citarem CSV.

### D7. Central de Ajuda (FR-015 alcanca alem do dialog) — achado novo

`lib/hub/ajuda-conteudo.json` cita o CSV da Transfeera em ~10 pontos (linhas 153, 817, 826, 832, 844, 1631–1650, 1700, 1771, 1852):
dizem "Transferências › Exportar CSV", "23 colunas", "`.csv` ou `.zip`... 20 MB" (esta ultima e do importador de Faturamento da EntreGo — **nao tocar**, so as do retorno Transfeera).
Atualizar so o **texto** (sem adicionar blocos novos — o teste da ajuda quebra se o JSON ganhar bloco que a tela nao renderiza; nao ha bloco novo). Os HTMLs compartilhaveis sao
GERADOS do JSON: regenerar pelo gerador existente (localizar no execute; nunca editar o HTML publicado) e relatar o que foi regenerado.
**Fato nao inventado**: o menu exato da Transfeera para baixar o XLSX **nao esta medido** (o BRIEFING so tem o arquivo). O texto da ajuda diz "o arquivo XLSX de retorno que a Transfeera devolve para o lote" e **nao afirma caminho de menu**; pendencia explicita para o operador confirmar o caminho (Constituicao VI).

### D8. Testes — o que sai, o que entra, e como o controle negativo e provado

**Saem com o CSV** (`adiantamento-retorno-transfeera-unit.test.js`): helpers `csvEscape/montarCsv`, `describe('lerCsv')` (L73–), `describe('lerCsv — leitor RFC4180 proprio')` (L322–380: BOM, aspas, CRLF, `ARQUIVO_MUITO_GRANDE` por linhas CSV). **Viram XLSX**: o helper `montarXlsx(linhas)` (`XLSX.write` em memoria, `bookType:'xlsx'`, so no teste) substitui `montarCsv`; os blocos de casamento/duplicata/prefixo REP (L146–406) so trocam `lerCsv(montarCsv(..))` por `lerXlsx(montarXlsx(..))`. `adiantamento-retorno-transfeera-arquivo-real.test.js` e reescrito sobre a fixture. `hub-adiantamentos-rotas-unit.test.js` (1346–1400, 1821–1836) e `hub-repasse-lotes-rotas-unit.test.js` (62, 281–338): `csvRetornoTexto`/`csv()` -> `xlsxRetorno()` devolvendo `Buffer`, `contentType: XLSX_MIME`; o helper `request` (`bodyStr`) ja serve com `Buffer` — conferir `Content-Length` por `Buffer.byteLength`.
`scripts/verificar-retorno-transfeera-real.js` (script manual do operador sobre CSV) passa a ler `.xlsx` via `lerXlsx` — mesmo objetivo, sem deixar caminho CSV vivo.

**Registro no `npm test`** (script lista arquivo a arquivo): **nenhum arquivo de teste novo** — tudo entra nos 4 arquivos ja listados; ao fim roda-se `node scripts/checar-testes-orfaos.js` e contam-se os testes por arquivo para provar que nenhum virou oco.

**Controle negativo (SC-003) — comando e mutacoes, relatados nome a nome no execute:**
1. Escrever os testes novos **antes** de tocar em `lib/`, `routes/`, proxy e componentes; rodar `node --test tests/adiantamento-retorno-transfeera-unit.test.js tests/adiantamento-retorno-transfeera-arquivo-real.test.js tests/hub-adiantamentos-rotas-unit.test.js tests/hub-repasse-lotes-rotas-unit.test.js` e `npx vitest run` nos arquivos de frontend: registrar a lista de testes que FALHAM contra o codigo atual (esperado: todos os que usam a fixture/`lerXlsx`/`XLSX_MIME`, mais o do proxy). Depois implementar e registrar os mesmos passando.
2. Mutacoes (reverter apos cada uma, relatar quais testes caem): (a) tirar `FINALIZADO` de `STATUS_CONHECIDOS` -> o teste de 58/58 cai; (b) tirar o `.slice`/`.replace` de `rotuloStatus` -> o de FR-014 cai; (c) desligar o teto de descompressao -> o de ZIP "bomba" (arquivo com declarado > 32 MiB, gerado em memoria) cai; (d) comparar cabecalho por conteudo da linha em vez de posicao -> o de celula vazia no meio cai; (e) ramo `spreadsheetml` removido do proxy -> teste de bytes cai.
3. Prova adicional de "falha pelo motivo certo": o teste do dialog afirma que o `importar` recebeu `ArrayBuffer` cujo `byteLength` e o do arquivo (`File.size`) — contra o dialog atual recebe `string`.

### D9. Fixture e dados — JA ANONIMIZADA (revisao pos-checklist, CHK036)

`tests/fixtures/retorno-transfeera-21col-exemplo.xlsx` (untracked) **ja foi anonimizada pelo operador/orquestrador antes do execute**, com prova por diff celula a celula:
cabecalho identico, 58 linhas, 15 colunas intactas (incluindo A/E/F: ID, status, valor) e so B/C/H/K/L/M trocadas por dados sinteticos. **O execute NAO anonimiza, NAO regera a fixture e NAO le nada de `/root`**
(la esta o original com PII real, fora do repo, e assim fica). Fixture nova, se precisar, e sintetica do zero. O gitleaks nao pega PII; o execute apenas confere por inspecao que a fixture nao traz nome/CPF/CNPJ reais antes do `git add` e relata.

### D10. Deploy e rollback (entrega de artefatos — o operador executa)

Backend e frontend_v2 sao um **par**: backend novo recusa o CSV que o frontend antigo ainda envia; frontend novo envia XLSX que o backend antigo recusa. Deploy na mesma janela, backend primeiro (a janela de CSV recusado e o custo aceito pela decisao do operador de remover o CSV). **Runbook, em uma linha: nao importar retorno durante a janela de deploy.** Nao se aceitam os dois formatos para evitar a janela. Rollback = imagens anteriores dos dois servicos (`docker service ls` antes). Sem migration => sem passo de banco, sem `SIGUSR1` no PostgREST. Prova pos-deploy: frontend pela STRING servida (ex.: `Arquivo XLSX` no chunk do dialog); backend interrogando o processo vivo (grep de `XLSX_MIME` no arquivo da imagem em execucao — `docker service logs` agrega tarefas antigas). Smoke funcional exige arquivo real em lote real: e do operador.

## Convencoes de Borda

| Camada | Case style | Validacao | Fonte da verdade |
|--------|------------|-----------|------------------|
| Arquivo XLSX (entrada) | cabecalho em portugues, 21 colunas exatas | `CABECALHO_ESPERADO` por igualdade (nome+ordem) | `lib/adiantamento-retorno-transfeera.js` + fixture |
| API request | corpo binario `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `express.raw` + magic + teto zip + `lerXlsx` | `contracts/retorno-xlsx.md` |
| API response | camelCase (`aplicadas`, `ignoradas`, `ignoradasPorMotivo`, `faltantes`) — **inalterado** | nenhuma mudanca | `routes/hub-adiantamentos.js`, `routes/hub-repasse-lotes.js` |
| Erro | `{erro:'ARQUIVO_INVALIDO', motivo:<TOKEN>}` MAIUSCULO | `MOTIVO_ARQUIVO` no dialog | `RetornoTransfeeraParseError.motivo` |
| Frontend DTO | camelCase, `ImportarRetornoResponse` — **inalterado** | tipos TS | `lib/hub/adiantamentos-api.ts` |

Mapper DB<->DTO: N/A (nenhuma coluna tocada). A borda nova e a do **corpo binario** atravessando o proxy (D1).

## Project Structure (arquivos reais tocados)

```
app_homologacao/backend/
├── lib/adiantamento-retorno-transfeera.js      # lerCsv/dividirCsvRfc4180 -> lerXlsx; CABECALHO 21; STATUS_CONHECIDOS; rotuloStatus; XLSX_MIME
├── lib/adiantamento-remanescente.js            # +1 ramo em paraCentavos (milhar BR)
├── routes/hub-adiantamentos.js                 # :71 import, :1471 express.raw, :1478-1490 corpo/erro
├── routes/hub-repasse-lotes.js                 # :40 import, :523 express.raw, :530-540 corpo/erro
├── scripts/verificar-retorno-transfeera-real.js
└── tests/ (4 arquivos existentes reescritos; fixture retorno-transfeera-21col-exemplo.xlsx)
app_homologacao/frontend_v2/
├── app/api/[...path]/route.ts (+ route.test.ts)            # ramo binario XLSX
├── lib/hub/adiantamentos-api.ts                            # ArrayBuffer + XLSX_MIME + postarRetorno
├── components/hub/adiantamento-importar-retorno-dialog.tsx (+ .test.tsx), repasse-lote-dialogs-reuso.test.tsx
├── lib/hub/ajuda-conteudo.json                             # so texto (D7)
docs/specs/retorno-transfeera-xlsx/                         # estes artefatos
```

## Gates (numeros a relatar no execute)

Backend `node --test`: baseline **1956 pass / 0 fail** + novos, `0 fail`; `node scripts/checar-testes-orfaos.js` limpo. Frontend do hub: `tsc --noEmit`, `vitest run`,
`next build`, lint contra a baseline (**28 problemas: 5 erros, 23 avisos** — sem erro novo); detector impeccable 0 achados (toca UI: dialog); E2E do hub apenas se um spec cobrir o dialog
(grep nos `tests/e2e-hub-browser`; os `impeccable-rodada*` citam "retorno" — avaliar e relatar). `git diff --stat package-lock.json` vazio (o container do Playwright reescreve o lock — conferir). `df -h /` e swap antes de qualquer build.

## Complexity Tracking

Nenhuma violacao de constitution. Desvios deliberados do `spec.md`/clarify a registrar: (i) `STATUS_CONHECIDOS` com 3 rotulos (reversao do operador); (ii) escopo
ampliado para o proxy (D1) e a Central de Ajuda (D7) — ambos necessarios para FR-001/FR-015 serem verdade em producao.


### D5.bis. Valor ambiguo `1.234` — validado na borda do retorno (achado da revisao do diff, onda de converge)

Medido: `"1.234"` -> 123 centavos (R$ 1,23; o BR leria 1.234,00) e `"12.345"` -> 1235 (leria 12.345,00): erro de 1000x. O efeito e falha fechada
(`VALOR_DIVERGENTE` ignora a linha, o item fica faltante, o lote nao confirma), mas o sintoma apontava para o cadastro do lote, nao para a leitura do arquivo.
Decisao: `normalizarLinha` marca `valorAmbiguoTexto` (regex `^-?\d{1,3}(?:\.\d{3})+$`) e `casarComItensDoLote` emite `VALOR_AMBIGUO:<texto saneado por rotuloStatus>`
ANTES da comparacao de valor. `paraCentavos` NAO muda. Rotulo na tela em `rotuloIgnorada` (prefixo, como `STATUS_DESCONHECIDO:`). Teste + contraprova nos arquivos ja listados no `npm test`.

## Reconciliacao com o codigo entregue (desvios do plano, declarados)

1. **Modulo novo `frontend_v2/lib/hub/retorno-xlsx.ts`** (so constantes `XLSX_MIME`, `XLSX_MAX_BYTES`): D6 mandava exportar `XLSX_MIME` de `adiantamentos-api.ts`; tres camadas (proxy, API, dialog) precisam concordar e o proxy nao deve importar codigo de fetch. `adiantamentos-api.ts` importa dali.
2. **Chamador orfao de `lerCsv` no driver** `infra/hub/testes/hub-adiantamentos-integration.sh`: nao constava em D2/D8 (so os unit tests); migrado para `lerXlsx` com XLSX sintetico em memoria. Hoje `grep lerCsv` fora de `docs/` = 0.
3. **Central de Ajuda: 10 mencoes alteradas, nao 11** (tasks 4.1.1 dizia 11, medidas antes de editar; a diferenca foi erro de contagem do orquestrador pai, que escreveu "(11)" no cabecalho da mensagem com o mapa da ajuda mas listou 10 bullets; o executor acertou). Valor real = 10; as 3 do Faturamento/Validacao XML intactas.
4. **Dois titulos de ajuda trocados** (nao previstos): "O texto da tela indica o arquivo errado" -> "Só o arquivo .xlsx de retorno é aceito" e "3 · O diálogo de importar retorno indica o arquivo errado" -> "3 · O retorno da Transfeera só aceita .xlsx"; os titulos descreviam o defeito corrigido.
5. **`paraCentavos('')` -> `0` mantido** (plano D5 dizia vazio -> NaN; o codigo existente devolve 0 e FR-008 proibe alterar entradas existentes). Sem efeito no retorno: vazio vira `null` antes.
6. **`blankrows:false` nao basta**: com `defval:''` a linha de celulas `''` conta como preenchida; o leitor filtra linhas em branco DEPOIS do `sheet_to_json`.
7. **Nomes literais das colunas**: o contrato usa os nomes exatos da fixture, inclusive `ID integração` (sem "de"), `Dígito da conta` e `Tipo de Conta (Corrente ou Poupança)`; a spec/briefing as citavam de forma abreviada.
8. **`VALOR_AMBIGUO`** (D5.bis, FR-020), acrescentado depois do plano.
9. **Fora do escopo, declarado**: `backend/package.json` religou o teste orfao `tests/notas-pendentes-corte-unit.test.js` ao `npm test` (correcao alheia, feita pelo operador).
10. **Achado de revisao adversarial: `VALOR_AMBIGUO` (e `VALOR_DIVERGENTE`, `STATUS_DESCONHECIDO`) nunca chegavam a tela.** Item `incluido` cuja linha e ignorada entra em `faltantes`; as duas rotas respondiam `409 RETORNO_INCOMPLETO` ANTES de calcular `ignoradasPorMotivo`, entao so o 200 o carregava e o 200 e inalcancavel nesse caso. O financeiro lia "o arquivo nao traz o resultado" e reexportava o mesmo periodo. Os testes passaram por 8 ondas porque usavam linha montada a mao, nunca a rota. **Correcao**: `ignoradasPorMotivo` (so contagem por motivo, nunca linhas cruas) sai tambem no 409, nas duas rotas; o dialog nomeia a causa junto da contagem de faltantes (filtra o ruido `ID_INTEGRACAO_INVALIDO`/`NAO_PERTENCE_AO_LOTE`/`JA_APLICADO`). Testes agora atravessam a rota por HTTP com XLSX real, nas duas rotas.
11. **`Devolvida` sem evidencia real**: a guarda "arquivo real tem devolucao" foi trocada por um teste `LACUNA CONHECIDA` que afirma 0 devolucoes e aponta a cobertura sintetica (`adiantamento-retorno-transfeera-unit.test.js`). Risco: o `Set` de status e case-sensitive e o XLSX usa MAIUSCULA; uma devolucao pode vir como `DEVOLVIDO` (nao medido, nao adicionado) e cairia em `STATUS_DESCONHECIDO`, agora diagnosticavel na tela.

## Limites honestos (nao resolvidos de proposito)

- O teste da "bomba de descompressao" prova a **dependencia do teto** (ZIP com tamanho *declarado* acima de 32 MiB e recusado antes de o SheetJS ler), **nao** o estouro real de memoria de uma bomba verdadeira; o diretorio central declara tamanhos que um ZIP malicioso pode falsear, e o 10 MB de `express.raw` e o teto de transporte.
- Os tres rotulos de status foram medidos em arquivos distintos; `Devolvida` (unico do ramo de devolucao) nunca foi observado num XLSX real (CHK040, {humano}).
- O caminho de menu da Transfeera para baixar o XLSX nao foi medido; a ajuda nao afirma menu (pendencia do operador).
- O smoke funcional com arquivo real em lote real e do operador; nenhum E2E de navegador cobre o dialog de retorno.
- Gate de integracao `hub-adiantamentos-integration.sh` rodou: 230 PASS / 1 FAIL herdada (ver quickstart).
