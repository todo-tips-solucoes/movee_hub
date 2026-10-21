# Research: retorno-transfeera-xlsx (Phase 0)

Sem NEEDS CLARIFICATION estrutural (stack, runtime, persistencia e ambiente herdados do projeto). Decisoes e evidencias:

## Decision 1: o proxy do frontend precisa de ramo binario
- **Evidencia**: `app/api/[...path]/route.ts:94-104` — multipart vai por stream, todo o resto por `await req.text()`. UTF-8 decode troca bytes invalidos por U+FFFD; ZIP nao sobrevive.
- **Decision**: ramo restrito ao mime `spreadsheetml.sheet` com `arrayBuffer()` -> `Uint8Array`; `corpoReenviavel` aceita `Uint8Array`.
- **Alternativas**: multipart + multer (desvia da decisao do operador `express.raw` e adiciona parser); base64 em JSON (estoura o `express.json()` global de 100 KB, incidente 2026-10-01); `application/octet-stream` generico no proxy (afeta endpoints alheios).

## Decision 2: leitor com SheetJS ja instalado, travas antes e depois
- **Evidencia (medida)**: fixture 61.883 B, 10 entradas ZIP "Stored", 1 aba `Transferencias`, `A1:U59`, celulas `t:'s'` (texto), Valor `"54,57"`, Status `FINALIZADO`. `XLSX.read` da fixture: 24 ms. 10.000 linhas sinteticas: 1.032.555 B, ~100 ms. `sheetRows` limita a materializacao; `!fullref` revela a dimensao real.
- **Decision**: magic `PK\x03\x04` + teto de descompressao pelo diretorio central + `XLSX.read` sem formula/estilo + checagem de dimensao. 
- **Alternativas**: `exceljs`/`read-excel-file` (dependencia nova, SC-005); ler sem magic (SheetJS auto-detecta CSV/HTML/XML — o motivo de 2026-09-18 para ter leitor proprio).
- **Risco residual declarado**: cabecalho ZIP que *mente* sobre o tamanho descomprimido. O execute gera esse arquivo e relata empiricamente o que acontece (memoria/tempo); o teto de 10 MB de transporte e o rate limiter da rota (30 req/15 min) limitam o dano.

## Decision 3: STATUS_CONHECIDOS = {FINALIZADO, Finalizada, Devolvida}
Reversao do operador (prevalece sobre onda-002). Sem rotulo inventado.

## Decision 4: paraCentavos — ramo so para o que hoje e NaN
Regex atual nao casa `1.234,56` (verificado em `adiantamento-remanescente.js:34`). Ramo novo estrito; caracterizacao congelada prova que nada mais muda.

## Decision 5: nomes de colunas vem da fixture, nao do BRIEFING
Cabecalho real da coluna N e `Tipo de Conta (Corrente ou Poupança)` (BRIEFING abrevia). `ID integração` (sem "de"), `Motivo` (nao `Motivo da falha`), sem `Código de erro`.

## Decision 6: Central de Ajuda cita o CSV em ~10 pontos
`lib/hub/ajuda-conteudo.json`; atualizar texto, nao estrutura; menu exato da Transfeera para XLSX nao medido -> nao afirmar.

## Decision 7: fixture tem PII de 58 pessoas em repositorio publico
Anonimizar com prova por diff de celulas, ou parar e devolver ao operador.
