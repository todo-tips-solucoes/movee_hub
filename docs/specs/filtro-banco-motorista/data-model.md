# Data Model — filtro-banco-motorista

Nenhuma entidade persistida. **Sem banco, sem PostgREST, sem migration, sem RLS,
sem índice.** As duas entidades abaixo são dados estáticos em memória, carregados
por `require` no boot do processo.

---

## Entity: Banco (somente leitura, pré-existente)

Fonte: `app_homologacao/backend/lib/fixtures/bancos-compe.json` — **não é alterada
por esta feature** (FR-003; restrição da §4 (Restrições) do BRIEFING.md da feature).

| Campo | Tipo | Notas |
|-------|------|-------|
| `codigo` | string | 3 dígitos, zero à esquerda preservado (`001`, `077`). Único. |
| `nome` | string | Nome/razão social oficial do BCB. É o que é exibido e o que consta no comprovante. |
| `ispb` | string | Presente na fixture; **não** devolvido pela API. |

Metadados do arquivo (também inalterados): `dataExtracao` (`2026-09-17`), `fonte`
(CSV ParticipantesSTR do BCB), `totalLinhasCsv` (474), `excluidosSemCodigo3Digitos`
(11). Total: **463 bancos**. Ordem do array = ordem do CSV do BCB (**não** ordenada
por código) — e é essa ordem que serve de desempate dentro de cada tier de busca.

Regerável por `scripts/extrair-bancos-compe.js`. Invariantes já cobertos por
`tests/adiantamento-bancos-compe-unit.test.js` (463 itens, código `^\d{3}$`, códigos
únicos).

---

## Entity: Nome comercial (apelido de busca) — novo

Camada **apenas de busca**: nunca é exibida, nunca é gravada, nunca substitui o nome
oficial (FR-003). Fonte única: constante `APELIDOS_BANCOS` em
`app_homologacao/backend/lib/bancos-busca.js` (Decision 1).

| Campo | Tipo | Notas |
|-------|------|-------|
| chave | string | apelido já normalizado (minúsculo, sem acento, espaço simples). |
| valor | string[] | um ou mais `codigo` de Banco, **na ordem em que devem aparecer**. |

Conteúdo (FR-002 exige no mínimo estes 5; cada código conferido contra a fixture):

| Apelido | Códigos | Nome oficial correspondente |
|---|---|---|
| `nubank` | `260` | NU PAGAMENTOS - IP |
| `mercado pago` | `323` | MERCADO PAGO IP LTDA. |
| `picpay` | `380`, `079`, `469` | PICPAY · PICPAY BANK - BANCO MÚLTIPLO S.A · PICPAY INVEST |
| `inter` | `077` | BANCO INTER |
| `c6` | `336`, `626` | BCO C6 S.A. · BCO C6 CONSIG |

### Invariantes

1. **Todo código listado existe na fixture.** Verificável por teste, e é o guard-rail
   contra um apelido apontar para um código inexistente ou removido numa reextração
   futura da fixture.
2. **Chave já normalizada.** A chave é comparada contra o termo normalizado; uma chave
   com acento ou maiúscula nunca casaria. Teste assere que
   `normalizar(chave) === chave` para todas.
3. **Ordem dos códigos é significativa** — é o desempate dentro do tier T1 e o único
   lugar onde se ajusta qual banco da marca aparece primeiro. A busca **não** escolhe
   pelo motorista: todos os códigos da marca são mostrados, ele escolhe.

   ⚠️ **PicPay — ponto a confirmar com o operador.** A ordem declarada acima **não** é a
   ordem da fixture: é uma reordenação deliberada. A fixture traz `469 PICPAY INVEST`
   primeiro, e `INVEST` é a corretora/DTVM do grupo — não a instituição que recebe
   repasse. Deixar a DTVM no topo convida o motorista a escolher a entidade errada, que é
   exatamente o dano que a spec cita (**pagamento recusado**). Por isso as entidades de
   pagamento vêm antes: `380 PICPAY`, depois `079 PICPAY BANK - BANCO MÚLTIPLO S.A`, e a
   DTVM por último.

   Base da ordem: leitura do **nome oficial** de cada entidade na fixture
   (`INVEST` / `BANCO MÚLTIPLO`), não medição de qual delas os motoristas de fato usam —
   esse dado não existe no repo. Se o operador souber qual entidade aparece nos
   comprovantes dos motoristas, é **uma linha** nesta constante. Mesma pergunta vale, em
   menor grau, para `c6` (`336 BCO C6 S.A.` antes de `626 BCO C6 CONSIG`, que é consignado
   — aqui a fixture já põe a ordem útil primeiro).
4. **Não há entrada `nu`.** O tier T1 casa por *prefixo do apelido*, então `nu` já
   resolve via `nubank` (Decision 2).

### Crescimento

Marca nova = uma linha nova nesta constante. Nenhuma mudança de lógica, de contrato,
de fixture ou de frontend. A spec (§Assumptions) já declara isso fechado: marcas
futuras entram sem reabrir a decisão.
