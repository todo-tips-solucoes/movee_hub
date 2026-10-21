# Requirements Checklist: Importar o retorno da Transfeera em XLSX

**Purpose**: qualidade dos requisitos (spec + plan) antes de create-tasks; cobre o ramo binario do proxy, os tres tetos, as duas rotas, a varredura de CSV, saneamento, `paraCentavos` e o controle negativo.
**Created**: 2026-10-21 (onda-004)
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md)

## Contrato do arquivo e leitor

- [x] CHK001 - O cabecalho de 21 colunas esta definido por nome e ordem, com a fonte da verdade apontada para a fixture e nao para o briefing? [Completude, Spec §FR-003, Plan §D2 ("Tipo de Conta (Corrente ou Poupança)")] {auto}
- [x] CHK002 - A presenca de coluna e determinada pelo cabecalho e nao pelo conteudo da linha, com cenario de celula vazia no meio? [Clareza, Spec §FR-004, Edge Cases, Plan §D2 passo 6] {auto}
- [x] CHK003 - Os tipos de celula (texto, numero nativo, formula) tem tratamento definido e nenhum caminho executa conteudo? [Cobertura, Spec §FR-010, Plan §D2 "Tipos de celula"] {auto}
- [x] CHK004 - As falhas de leitura (nao-XLSX, ZIP corrompido, vazio, sem aba, ZIP64) mapeiam para tokens de recusa e nunca para erro interno? [Completude, Spec §FR-011, Plan §D2 passos 1-5] {auto}
- [x] CHK005 - Esta definido o comportamento para multiplas abas e linhas finais vazias? [Cobertura, Spec Edge Cases, Plan §D2 passo 4/6] {auto}
- [x] CHK006 - O fim de `lerCsv`/`dividirCsvRfc4180` e dos testes que vao com eles esta especificado sem chamador orfao, incluindo o alias `lerCsv: lerRetornoTransfeeraCsv` nos dois imports de rota e o script manual do operador? [Completude, Plan §D2 "Removidos", §D8, Gap: aliases em routes/hub-adiantamentos.js:71 e hub-repasse-lotes.js:40 citados so por linha] {auto}

## Status e saneamento

- [x] CHK007 - O conjunto de status conhecidos e consistente entre spec e plan? [Conflict, Spec §FR-006/US3-AS1/SC-002/Clarifications ("Finalizada/Devolvida nao continuam conhecidos") vs Plan §D3 (`{FINALIZADO, Finalizada, Devolvida}` por reversao do operador)] {auto} **Resolvido (converge):** spec FR-006/US3/SC-002 e Clarifications sincronizadas com plan D3 (tres rotulos); 86/0 no unit.
  - **Gap/Conflict**: a spec ainda manda recusar "qualquer valor diferente de FINALIZADO" e proibir presumir devolucao; o plan mantem `Devolvida`. A reversao do operador nao foi propagada para a spec. Destino: `/clarify` (ou edicao da spec) antes de create-tasks.
- [x] CHK008 - O saneamento do status (40 chars, so imprimiveis) tem local unico (`casarComItensDoLote`), cobrindo as duas rotas, e criterio mensuravel? [Clareza, Clarifications FR-014, Plan §D3] {auto}
- [x] CHK009 - Ha criterio de teste do saneamento (status de 5.000 chars com `<script>` e `\u0000`) e mutacao que o derruba? [Mensurabilidade, Plan §D3, §D8 mutacao (b)] {auto}
- [x] CHK010 - O motivo de falha literal (FR-007) esta mantido sem traducao e sem a coluna `Codigo de erro`? [Consistencia, Spec §FR-007, Plan §D2] {auto}

## Proxy do frontend

- [x] CHK011 - O ramo binario do proxy esta especificado (mime por igualdade apos `split(';')`, `Uint8Array`, sem tocar outros endpoints) com teste byte a byte e controle negativo? [Completude, Plan §D1, §D8 mutacao (e)] {auto}
- [x] CHK012 - O retry apos 401 com corpo binario esta especificado como requisito proprio (`corpoReenviavel` aceita o buffer; multipart segue NAO reenviavel) e tem teste que falha se o buffer voltar a ser nao-reenviavel? [Gap, Plan §D1 so cita a mudanca de `corpoReenviavel`; route.ts:109 hoje exige `typeof init.body === 'string'`; nenhum teste de retry nem de manutencao do multipart esta listado em §D8] {auto} **Resolvido (converge):** FR-018 + tasks 3.2.1/1.5.3/1.5.4 (reenvio binario e multipart nao reenviavel, testes distintos); vitest verde.
- [x] CHK013 - O teto no proxy (411 sem content-length, 413 acima de 10 MB, sem chamar `arrayBuffer`) esta definido? [Completude, Plan §D1 (owasp F2)] {auto}
- [x] CHK014 - O proxy (corpo binario, tetos 411/413, retry) e rastreavel a um requisito da spec? [Gap, Spec §FR-001 cobre "binario sem corromper" mas nao ha FR para o proxy; o requisito existe so no plan] {auto} **Resolvido (converge):** FR-016, FR-017 e FR-018 na lista de requisitos da spec.

## Rotas e tetos

- [x] CHK015 - As DUAS rotas (adiantamento `hub-adiantamentos.js:1471` e repasse `hub-repasse-lotes.js:523`) estao ambas listadas com a mesma troca `express.text` -> `express.raw`, na propria rota e depois da autorizacao? [Consistencia, Spec §US2, Plan §D4, Project Structure] {auto}
- [x] CHK016 - Content-Type inesperado (`text/csv`, `text/plain`, `octet-stream`, ausente) tem resposta definida (400 `ARQUIVO_INVALIDO/FORMATO_INVALIDO`)? [Cobertura, Spec §FR-002, Plan §D4] {auto}
- [x] CHK017 - Teto de transporte (10 MB) tem valor, local de aplicacao (`express.raw` + dialog) e racional medido? [Mensurabilidade, Spec §FR-009, Plan §D4] {auto}
- [x] CHK018 - Teto descomprimido (32 MiB / 100 entradas) tem valor, local (`lerXlsx` passo 3, antes de `XLSX.read`) e teste de ZIP "bomba"? [Mensurabilidade, Plan §D4, §D8 mutacao (c)] {auto}
- [x] CHK019 - Teto de linhas (10.000) tem local (`sheetRows` + `!fullref`) e cobre linhas em branco que empurram dados alem do corte? [Clareza, Spec §FR-009/SC-004, Plan §D2 passo 5] {auto}
- [x] CHK020 - O 413 do `express.raw` (corpo HTML padrao do Express) e aceitavel para o usuario que burla o limite do dialog? [Risco, Plan §D4 aceita sem handler JSON] {humano} -> decidido pelo orquestrador pai: 413 em HTML e paridade com a rota CSV atual (Plan D4) - aceito
- [x] CHK021 - Os logs das rotas nao ecoam mensagem do SheetJS nem conteudo do arquivo? [Seguranca, Plan §D2 (owasp F7)] {auto}

## Valores monetarios (`paraCentavos`)

- [x] CHK022 - O ramo novo de milhar BR esta delimitado ao padrao que hoje produz `NaN`, com entradas/saidas esperadas e rejeicoes (`1.2.3,4`, `R$ 1.234,56`)? [Clareza, Spec §FR-008/US4, Plan §D5] {auto}
- [x] CHK023 - A nao-regressao esta exigida por tabela congelada de entradas/saidas rodada ANTES e DEPOIS, e pela suite dos arquivos chamadores, com os chamadores enumerados? [Mensurabilidade, Spec §FR-008, Plan §D5] {auto}
- [x] CHK024 - Valor ilegivel nunca confirma valor errado (vira `null` -> `VALOR_DIVERGENTE`)? [Cobertura, Spec §US4-AS2, Plan §D5] {auto}

## Frontend e textos

- [x] CHK025 - O dialog tem requisitos para `accept`, `arrayBuffer()` (nunca `text()`), `XLSX_MAX_BYTES`, rotulo, frase informativa e `MOTIVO_ARQUIVO.CABECALHO_INVALIDO`/`FORMATO_INVALIDO`? [Completude, Spec §FR-012/FR-015, Plan §D6] {auto}
- [x] CHK026 - A Central de Ajuda esta no escopo com linhas, regra de "so texto" e regeneracao dos HTMLs pelo gerador? [Completude, Spec §FR-015, Plan §D7] {auto}
- [x] CHK027 - O trecho de "20 MB" do JSON de ajuda e declarado como do importador de Faturamento (EntreGo) e fora do escopo? [Clareza, Plan §D7] {auto}
- [x] CHK028 - O caminho de menu da Transfeera esta declarado como nao medido (nao afirmado) com pendencia ao operador? [Veracidade, Plan §D7, Constituicao VI] {auto}
- [x] CHK029 - FR-014 e FR-015 existem apenas na secao Clarifications e nao na lista de Functional Requirements; o Delta "MODIFIED FR-013" colide com o FR-013 da propria spec. A numeracao e rastreavel? [Ambiguity, Spec §Clarifications vs §Functional Requirements/§Delta] {auto} **Resolvido (converge):** FR-014..FR-019 promovidos a lista de Functional Requirements; Delta aponta 'FR-013 da spec anterior' explicitamente; FR-020 acrescentado.

## Testes e controle negativo

- [x] CHK030 - Esta exigido escrever os testes antes do codigo e registrar quais falham contra o codigo atual? [Mensurabilidade, Spec §SC-003, Plan §D8.1] {auto}
- [x] CHK031 - As cinco mutacoes estao listadas com o teste que deve cair em cada uma (a: 58/58; b: FR-014; c: ZIP bomba; d: celula vazia; e: bytes do proxy)? [Completude, Plan §D8.2] {auto}
- [x] CHK032 - Os testes que "caem" nas mutacoes estao nomeados (nome de `it`), e nao so descritos por comportamento? [Clareza, Plan §D8.2 descreve por comportamento] {auto} **Resolvido (converge):** tasks 1.2.4, 1.2.6, 1.2.9, 1.3.1 e 1.5.1 nomeiam os testes; mutacoes da FASE 5 relatadas nome a nome.
  - **Gap**: nomear os testes ao escrevê-los (tarefa de execute), relatando "mutacao -> nomes que cairam".
- [x] CHK033 - Esta determinado que nenhum arquivo de teste novo e criado, com os 4 arquivos ja listados em `npm test` e `checar-testes-orfaos.js` ao fim? [Consistencia, Plan §D8 "Registro no npm test"] {auto}
- [x] CHK034 - O teste do dialog prova que `importar` recebe `ArrayBuffer` com `byteLength == File.size`? [Mensurabilidade, Plan §D8.3] {auto}
- [x] CHK035 - SC-004 (10.000 linhas < 5 s) tem metodo de medicao (`process.hrtime`) e valor medido de referencia? [Mensurabilidade, Spec §SC-004, Plan §D4] {auto}

## Dados, gates e entrega

- [x] CHK036 - O plano sobre a fixture e consistente com o estado real? [Conflict, Plan §D9 manda o execute anonimizar/decidir; a fixture JA foi anonimizada pelo operador (diff celula a celula: 58 linhas, 6 colunas pessoais trocadas, 15 intactas, IDs `ADV-000015..74` e `FINALIZADO` 58/58 preservados)] {auto} **Resolvido (converge):** plan D9 revisado: fixture ja anonimizada pelo operador; nenhuma tarefa de anonimizacao (tasks 1.3.2 so verifica).
  - **Gap**: D9 desatualizado; execute NAO anonimiza nem regera a fixture e nao usa arquivo de `/root`; outra fixture, se precisa, e sintetica do zero. Registrar na tasks.
- [x] CHK037 - Os gates tem numeros de baseline (1956 pass/0 fail backend; lint 28 problemas, 5 erros, 23 avisos) e `package-lock.json` sem diff (SC-005)? [Mensurabilidade, Spec §SC-003/SC-005, Plan §Gates] {auto}
- [x] CHK038 - Deploy como par backend+frontend, rollback e prova pos-deploy estao definidos como artefato do operador, sem tocar producao? [Completude, Plan §D10] {auto}
- [x] CHK039 - A janela em que o CSV e recusado entre backend e frontend novos e aceitavel ao negocio? [Risco, Plan §D10 aceita pela decisao do operador] {humano} -> decidido pelo orquestrador pai: janela de deploy aceita, com linha no runbook (Plan D10)
- [x] CHK040 - O ramo de falha/devolucao fica efetivamente alcancavel apenas por `Devolvida` (rotulo do CSV, nao medido no XLSX): o risco de um XLSX real trazer rotulo diferente e aceito? [Risco, Plan §D3] {humano} -> decidido pelo orquestrador pai: ramo de devolucao alcancavel so por `Devolvida` e o desenho (Plan D3) - aceito

## Notes

- Gate `requirement-coverage.sh`: 13 requisitos, 13 cobertos, 0 erros (exit 0).
- Resumo (apos converge): 40 itens; 37 resolvidos [x] com citacao; 3 {humano} (CHK020, 039, 040) decididos pelo orquestrador pai na review-task e marcados citando a decisao.
- Destinos: CHK007 e CHK029 -> `/clarify` (sincronizar spec); CHK012, CHK014, CHK032, CHK036 -> `/create-tasks` (tarefas explicitas); `{humano}` -> operador.
