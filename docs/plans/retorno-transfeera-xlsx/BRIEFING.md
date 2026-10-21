# Importar o retorno da Transfeera em XLSX (repasse e adiantamento)

> Pedido do operador em 21/10/2026: *"o arquivo de retorno será com esse layout
> (`34c495e0-cd5c-11f1-b0ea-b1f409261007.xlsx`). Hoje está pedindo o CSV."*

## ✅ DESBLOQUEADA em 2026-10-21 pelo operador

> *"tem sim. esse é o arquivo de retorno da transfeera
> (`34c495e0-cd5c-11f1-b0ea-b1f409261007.xlsx`). porém a coluna id da integração veio com
> o valor errado, pois foi substituído manualmente na importação do arquivo. você fez a
> correção e transformou o documento de retorno da transfeera nesse documento
> (`/root/retorno-transfeera-TESTE-lote-000003.xlsx`). então considere um arquivo parecido
> com esse com o valor certo na coluna F."*

**O que isso resolve:** o layout de **21 colunas** do
`34c495e0-cd5c-11f1-b0ea-b1f409261007.xlsx` **é** o formato real do retorno, e a coluna
**F (`ID integração`)** **traz o nosso `ADV-000015`/`REP-000123`** quando o arquivo
enviado está correto. O texto livre da amostra era consequência de a coluna J do arquivo
de ENVIO ter sido sobrescrita à mão (medido: idêntica à coluna L, `Descrição Pix`, em
**58 de 58** linhas) — a Transfeera devolve o que recebeu.

**Consequência para o escopo:** **NÃO há chave nova a inventar.** O casamento segue
determinístico por `extrairIdSolicitacao` (`^(ADV|REP)-(\d+)$`), exatamente como o CSV de
hoje. A frente encolhe de "nova estratégia de casamento ambíguo" para **"novo leitor de
arquivo"** — muito menor e muito mais seguro. A decisão de **substituir o CSV** (§4)
deixa de ser arriscada, justamente porque o ID volta.

**Amostra canónica para o desenvolvimento:**
`/root/retorno-transfeera-TESTE-lote-000003.xlsx` — 21 colunas, cabeçalho **idêntico** ao
da amostra real (conferido campo por campo), 58 linhas, coluna F de `ADV-000015` a
`ADV-000074`. Copiar para uma fixture do repo; **não** depender de `/root`.

### ⚠️ O que AINDA não se sabe, e não se deve inventar

**O rótulo de status para DEVOLUÇÃO.** A amostra real tem `FINALIZADO` em **58 de 58**.
O CSV usa `Finalizada`/`Devolvida`; o XLSX usa maiúsculas. Por simetria, devolução
*seria* algo como `DEVOLVIDO` — **mas isso é suposição, e programar contra ela faria o
teste passar contra ficção.**

**Tratamento correto:** `STATUS_CONHECIDOS` cobre `FINALIZADO`; qualquer outro valor
**recusa o arquivo em voz alta**, nomeando o status encontrado. Quando a primeira
devolução real aparecer, o operador manda a amostra e o enum cresce numa linha.

## 1. O que existe hoje

`lib/adiantamento-retorno-transfeera.js` aceita **CSV com 23 colunas exatas**
(`CABECALHO_ESPERADO`, conferido por igualdade estrita) da tela
**Transferências → exportar CSV**. Registrado na memória do projeto: o XLSX de
movimentações e o Extrato **não** serviam.

O casamento é **determinístico**: a coluna `ID de integração` traz `ADV-000123` /
`REP-000123`, e `extrairIdSolicitacao` converte em id da solicitação. Status aceitos:
`Finalizada` e `Devolvida`. O motivo da devolução é **literal** do arquivo
(`Motivo da falha`, caindo para `Código de erro`), nunca uma string fabricada.

Nós **enviamos** esse ID: `lib/adiantamento-transfeera-xlsx.js:88` escreve
`col_id_integracao` e a função de validação (`:167-169`) confere a lista de
`idsIntegracao` esperados.

## 2. O que o arquivo novo tem — medido

**21 colunas** (A–U), 58 linhas de dados, 1 aba:

```
Valor · Favorecido · Comprovante Transfeera · Comprovante Banco · Status ·
ID integração · Motivo · CPF ou CNPJ · Email · Banco · Agência · Conta ·
Dígito da conta · Tipo de Conta · Nome do lote · Data transferido ·
Banco de saída · Data de agendamento · Tentativas de pagamento ·
Tipo da chave PIX · Chave PIX
```

Diferenças que importam frente ao CSV:

| | CSV (hoje) | XLSX (novo) |
|---|---|---|
| Colunas | 23 | **21** |
| `ID de integração` | `ADV-000123` | **texto livre**: `"Antecipação entregador mei 19.10.26_Rafael Bra…"` |
| Status | `Finalizada` / `Devolvida` | `FINALIZADO` (maiúsculas; 58/58 na amostra) |
| Falha | `Código de erro` + `Motivo da falha` | só `Motivo` (vazio em 58/58) |
| Datas | `Pago em`, `Criado em` | `Data transferido`, `Data de agendamento` |
| Ausentes | — | `ID da transferência`, `ID do lote`, `Código do banco` |

## 3. 🔴 O bloqueio: sem o ID, o casamento fica ambíguo

A coluna `ID integração` do XLSX traz o que parece ser **nome do lote + nome do
favorecido**, não o nosso `ADV-`/`REP-`. Três hipóteses, e **só o operador distingue**:

1. **Esta exportação não devolve o campo** que enviamos (devolve outro, de nome
   parecido) — então existe outra tela/opção de export que o preserva. ← a conferir
2. **O arquivo veio de outra tela** da Transfeera.
3. **Este lote foi criado à mão** na Transfeera, sem passar pelo nosso exportador —
   e aí o ID nunca existiu para ele, e o arquivo é caso excepcional, não o padrão.

**Se nenhuma exportação XLSX trouxer o ID**, a alternativa é casar por
(`CPF/CNPJ` + `Valor` + `Nome do lote`), que é **ambíguo**: dois pagamentos do mesmo
motorista, mesmo valor, mesmo lote não se distinguem. Precisaria listar os ambíguos
para decisão humana — o mesmo padrão do lote do repasse.

## 4. Decisões já tomadas (21/10)

- **Vale para repasse E adiantamento** (os dois usam o mesmo importador, com prefixo
  `REP`/`ADV`).
- **Substituir o CSV, aceitar só XLSX.** ⚠️ **Esta decisão é CONDICIONAL à §3**: se o
  XLSX não trouxer o ID, substituir troca um casamento determinístico por um ambíguo —
  o operador precisa reconfirmar com esse dado à vista.

## 5. Restrições

- `STATUS_CONHECIDOS` precisa cobrir `FINALIZADO`; e **qual rótulo o XLSX usa para
  devolução** é desconhecido — a amostra só tem finalizados. **Não inventar**: sem
  amostra de devolução, o importador deve recusar status desconhecido em voz alta, não
  adivinhar.
- O motivo da devolução continua **literal do arquivo**, nunca fabricado.
- `xlsx` já é dependência do backend (usada pelo exportador) — nada novo a instalar.
- A deduplicação de linhas repetidas do mesmo ID (hoje em `dedupePorId`) precisa de
  equivalente, ou de decisão explícita de que não se aplica.

## 6. Achados do ciclo agêntico (21/10) — medidos, não supostos

O ciclo `/feature-00c` (specify→clarify→plan→checklist→create-tasks→execute) produziu
cinco achados que **mudaram o escopo**. Cada um está medido; nenhum é suposição.

### 🔴 O proxy do frontend corrompe corpo binário — e é invisível para a suíte do backend

`app_homologacao/frontend_v2/app/api/[...path]/route.ts:103` faz
`init.body = await req.text()` para **todo** corpo que não é `multipart/form-data`. Um XLSX
passa por essa decodificação UTF-8 e os bytes inválidos viram **U+FFFD** — corrupção
irreversível, antes de o backend ver qualquer coisa.

**Por que isso quase passou:** corrigir só as rotas e o dialog deixaria a entrega
**verde em todos os testes** e quebrada em produção, porque o proxy é Next e não entra no
`node --test` do backend. **São três camadas que precisam aceitar binário** — proxy,
`express.raw` nas rotas, e o `arrayBuffer()` do cliente — e nenhuma cobre a outra.

### 🔴 O retry após 401 morre em silêncio com corpo binário

Na linha 109 do mesmo arquivo:

```js
const corpoReenviavel = init.body === undefined || typeof init.body === 'string';
if (backendRes.status === 401 && renovar && !jaRenovou && corpoReenviavel) { … }
```

Com `ArrayBuffer`/`Uint8Array`, `typeof` não é `'string'` ⇒ `corpoReenviavel` fica
**false** e **o reenvio após a renovação não acontece**. Efeito: se o `accessToken` de 15
min vencer no instante do upload, o financeiro recebe 401 e o arquivo não é reenviado — a
renovação silenciosa de sessão (que existe porque a sessão desliza) **deixa de cobrir esta
rota**. O corpo binário já está materializado em memória, então reenviar é trivial; o
**multipart continua não-reenviável**, e com razão: é stream de verdade (`duplex: 'half'`).

### 🔴 PII de 58 pessoas entrou no repositório público como fixture

A amostra instalada em `app_homologacao/backend/tests/fixtures/` trazia **nome, CPF/CNPJ,
agência e conta de 58 pessoas**. Foi pega antes de qualquer `git add` e **anonimizada**,
com prova por diff célula a célula: cabeçalho idêntico (21 colunas), 58 linhas, **15
colunas intactas** (inclusive `Valor`, `Status` e `ID integração` de `ADV-000015` a
`ADV-000074`); trocadas apenas `Favorecido`, `Comprovante Transfeera`, `CPF ou CNPJ`,
`Agência`, `Conta`, `Dígito da conta`. O original com PII real continua **fora do repo**.

⚠️ **Fixture vinda de arquivo real de cliente é PII até prova em contrário.** Classificar
coluna por coluna antes de versionar é mais rápido que remover do histórico depois.

### ⚠️ A Central de Ajuda afirma um caminho de menu que a entrega torna errado

São **14** menções a "CSV" em `frontend_v2/lib/hub/ajuda-conteudo.json`, não ~10. **Três
não são da Transfeera** (uma da Validação XML, duas do importador de Faturamento da
EntreGô) e trocá-las seria introduzir defeito em tela alheia. Há um caso-armadilha:
`secoes[22].blocos[10].itens[0]` fala de `.zip` e 20 MB **dentro da seção da Transfeera**,
mas descreve o importador do EntreGô.

E a omissão que o plano não cobria: a ajuda **afirma** *"portal da Transfeera ›
Transferências › Exportar CSV"* em **4 pontos**. "Não afirmar o caminho novo" não resolve —
se a frase velha fica, a ajuda passa a mandar exportar exatamente o arquivo que o sistema
vai recusar. A afirmação velha **sai**; no lugar, o **contrato verificável** (`.xlsx`, 21
colunas, `ID integração` com `ADV-`/`REP-`). **O caminho novo é pendência do operador** —
ninguém mediu, e deduzir do nome do antigo seria ficção.

### ⚠️ O cabeçalho real é mais literal que o briefing

A coluna N é `Tipo de Conta (Corrente ou Poupança)`, não "Tipo de Conta". **O contrato sai
da fixture, nunca do briefing** — a abreviação de §2 não casa com o arquivo.

## 7. Decisões que eu (orquestrador) tomei durante o ciclo

| # | Decisão | Por quê |
|---|---|---|
| 1 | `STATUS_CONHECIDOS` = `{FINALIZADO, Finalizada, Devolvida}` — **reversão** de uma decisão da onda-002, que deixaria só `FINALIZADO` | Deixar só `FINALIZADO` torna o ramo de devolução **inalcançável**: código morto de propósito, com testes afirmando comportamento que produção não executa — o defeito exato que a revisão adversarial achou em `lerOrigemHub` na frente anterior. Os três rótulos foram **medidos** (o 1º no XLSX, os outros no CSV da mesma fornecedora). Inventar `DEVOLVIDO` segue proibido. |
| 2 | O 413 do `express.raw` sai como HTML padrão do Express — **aceito** | Paridade com a rota CSV de hoje; não é regressão, e o caminho normal é barrado antes pelo teto do dialog. Construir handler novo seria escopo inventado. |
| 3 | A janela entre o deploy do backend e do frontend — **aceita**, com linha no runbook | Dura minutos, o importador é de uso pontual e o frontend_v2 já é stop-first com 1 réplica. Aceitar os dois formatos "para evitar a janela" manteria `lerCsv` como código morto, contra a decisão do operador. |
| 4 | O ramo de devolução só é alcançável por `Devolvida` — **aceito, é o desenho** | Fica vivo e testável; se o XLSX trouxer outro rótulo, `STATUS_DESCONHECIDO:` o nomeia na tela e o operador manda a amostra. |

## 8. Pendências do operador

1. **O caminho no portal da Transfeera para baixar o XLSX de retorno** — a ajuda fica sem
   afirmar menu até a resposta. Não bloqueia a entrega.
2. **O rótulo de status de uma DEVOLUÇÃO no XLSX** — quando a primeira acontecer, mandar a
   amostra. Até lá, o sistema recusa nomeando o valor, de propósito.
3. ⚠️ **Disco do host em 19 GB livres (88%)**, abaixo do gate de 20 GB deste repo. Só 2
   imagens sem tag (1,3 GB) e 203 MB de cache de build são recuperáveis com segurança;
   os 15,7 GB "recuperáveis" em volumes são **proibidos** (`envio_massa_hub_uploads`
   guarda os originais das importações).
