# Contract: arquivo de exportação Transfeera (xlsx)

Contrato de **saída** para um sistema externo. A estrutura vem da PLANO §6 (medida no
`modelo_transfeera.xlsx` do operador e conferida contra o modelo público oficial) e o
mapeamento da PLANO §7.1 (decisões D-18..D-22). A aceitação real no importador da
Transfeera é a validação V-1..V-6, feita pelo operador fora desta feature (Q-B4).

## Estrutura (fonte: PLANO §6)

| Item | Valor |
|---|---|
| Abas | exatamente uma, `Página1` |
| Linha 1 | `A1` com a instrução do modelo; mescla `A1:L1` |
| Linha 2 | 12 cabeçalhos, na ordem abaixo; nada além da coluna `L` |
| Linhas 3+ | um item por linha; nenhuma linha ilustrativa |
| Limite | 5.000 linhas de dados (Central de Ajuda; R-17) |
| Formato de moeda | coluna I com `"R$" #,##0.00` |

O texto exato da linha 1 e dos cabeçalhos vive na fixture
`app_homologacao/backend/lib/fixtures/transfeera-contrato.json`, extraída do modelo local
por `app_homologacao/backend/scripts/extrair-contrato-transfeera.js` (só aba, linha 1,
cabeçalhos e mescla — **sem** a linha 3, que tem dado pessoal real).

## Colunas (fonte: PLANO §7.1)

| Col. | Cabeçalho | Origem | Tipo da célula | Regra |
|---|---|---|---|---|
| A | `Nome ou Razão Social` | `titular_nome` | `s` | aparado; 1–120 |
| B | `CPF ou CNPJ` | `titular_documento` | `s` | com máscara `999.999.999-99` / `99.999.999/9999-99` |
| C | `Email (opcional)` | `email_comprovante` | `s` | vazio se ausente (D-18) |
| D | `Banco` | `banco_codigo` | `s` | 3 dígitos (formato final depende da V-1) |
| E | `Agência` | `agencia` | `s` | 4 dígitos com zeros |
| F | `Conta` | `conta` | `s` | só dígitos, zeros preservados |
| G | `Dígito da conta` | `conta_digito` | `s` | 1 caractere |
| H | `Tipo de Conta (Corrente ou Poupança)` | `tipo_conta` | `s` | `Conta Corrente` / `Conta Poupança` (D-19) |
| I | `Valor` | `valor_liquido` | `n` | 2 casas, `> 0`, formato moeda |
| J | `ID integração (opcional)` | id da solicitação | `s` | `ADV-000123` (D-20), estável entre lotes |
| K | `Data de agendamento (opcional)` | — | vazio | D-22 |
| L | `Descrição Pix (opcional)` | modelo da configuração | `s` | `Antecipação entregador mei DD.MM.AA_<nome do titular>` com a data da produção (D-21, Q-N11); até 140 caracteres |

A chave PIX **não** é exportada.

## Funções `[PROPOSTA — a validar na implementação]`

`app_homologacao/backend/lib/adiantamento-transfeera-xlsx.js`:

- `montarPlanilhaTransfeera(itens, contrato) → Buffer` — recebe o snapshot já formatado
  dos itens (`AdiantamentoLoteItem`), escreve com o `xlsx` (SheetJS CE 0.18.5) já
  instalado; nenhum campo de código passa por `Number()`.
- `validarPlanilhaTransfeera(buffer, contrato, {quantidade, valorTotal, idsIntegracao}) →
  {ok, falhas:[codigo]}` — relê o buffer e confere: uma aba com o nome certo; `A1` e a
  mescla; os 12 cabeçalhos na ordem e nada depois de `L`; quantidade de linhas; soma dos
  valores em centavos inteiros = `valorTotal`; IDs únicos e iguais aos esperados;
  obrigatórios (A, B, D, E, F, G, H, I, J) preenchidos; `t === 's'` nas colunas de texto e
  `t === 'n'` na I.
- O Node gera o arquivo logo após `hub_adiantamento_lote_criar`, valida e só então chama
  `hub_adiantamento_lote_arquivo`. Falha em qualquer passo → `hub_adiantamento_lote_cancelar`
  com motivo `falha_geracao`; auditoria registra a falha **sem** o conteúdo (FR-029).

## Nome do arquivo (Q-N19)

`transfeera_adiantamentos_<AAAA-MM-DD>_lote-<NNNNNN>.xlsx` — data de criação do lote no
fuso da configuração; número do lote com 6 dígitos (sem truncar acima disso).

## Diferenças conhecidas em relação ao modelo (PLANO §15.1)

- A SheetJS CE não grava fonte, cor nem borda: o cabeçalho sai sem o vermelho e o negrito
  do modelo (não estrutural).
- A SheetJS inclui um formato numérico interno a mais, não usado por nenhuma célula
  (entra na V-6).

## Testes do contrato

`app_homologacao/backend/tests/adiantamento-transfeera-xlsx-unit.test.js` (PLANO §26):
estrutura, mapeamento das 12 colunas, CPF e CNPJ, zeros à esquerda (edge 21), valor
decimal, os dois tipos de conta, opcionais vazios, acento e caractere especial, corte em
140 (edge 28), quantidade, soma, ID duplicado e registro inválido recusado pelo
validador. A comparação fixture × `docs/documentos_apoio/modelo_transfeera.xlsx` roda
**só** quando o arquivo local existe (ele nunca entra no git).
