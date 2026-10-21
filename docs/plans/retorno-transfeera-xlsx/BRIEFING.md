# Importar o retorno da Transfeera em XLSX (repasse e adiantamento)

> Pedido do operador em 21/10/2026: *"o arquivo de retorno será com esse layout
> (`34c495e0-cd5c-11f1-b0ea-b1f409261007.xlsx`). Hoje está pedindo o CSV."*

## 🔴 BLOQUEADA — aguarda conferência do operador

O arquivo de amostra **não traz o nosso ID de integração**, que é a chave do casamento
atual. Enquanto isso não se resolver, desenvolver seria escolher a chave no escuro.
Ver §3.

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
