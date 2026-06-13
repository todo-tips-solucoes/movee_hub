# Data Model — import-range-datas

> Sem DDL — nenhuma mudança de schema de banco de dados.
> O modelo de dados relevante é o contrato de transmissão do range entre camadas.

## Entity: RangeMovimento (in-flight, sem persistência própria)

O `RangeMovimento` é transmitido como campos de um `multipart/form-data` e aplicado como valores escalares nas linhas da tabela `EnvioMassa` existente.

| Campo | Tipo (wire) | Formato transmitido | Formato no banco | Obrigatório | Notas |
|-------|-------------|---------------------|------------------|-------------|-------|
| `dt_inicial` | string (FormData field) | `DD/MM/YYYY` (convertido na UI de `YYYY-MM-DD`) | `timestamptz` (meia-noite SP) | Sim | Convertido via `toTimestamptzMidnightSP` no backend |
| `dt_final` | string (FormData field) | `DD/MM/YYYY` (convertido na UI de `YYYY-MM-DD`) | `timestamptz` (meia-noite SP) | Sim | Convertido via `toTimestamptzMidnightSP` no backend |

**Regra de negócio:** `dt_inicial ≤ dt_final` (comparação de strings `YYYY-MM-DD` na UI; comparação de timestamps no backend após conversão).

---

## Entity: EnvioMassa (existente, sem alteração de schema)

A tabela `EnvioMassa` no PostgreSQL já tem as colunas `dt_inicial` e `dt_final` do tipo `timestamptz`. Nenhuma coluna nova. Nenhuma coluna removida.

**Mudança comportamental:** O valor gravado nas colunas `dt_inicial` e `dt_final` passa a ser o range fornecido pelo operador na UI (uniforme para todas as linhas do lote), em vez do valor per-row da planilha.

---

## State Transitions

```
[Operador clica Importar]
  ↓
[Seleciona arquivo .xlsx/.xls]
  ↓
[Dialog abre: Data inicial / Data final]
  ↓ (validação UI: ambas preenchidas + dt_inicial ≤ dt_final)
[Botão Enviar habilitado]
  ↓ [Confirma]
[FormData: file + dt_inicial (DD/MM/YYYY) + dt_final (DD/MM/YYYY) + empresa_id]
  ↓ [proxy transparente]
[Backend: valida range UMA VEZ → loop linhas → insere com dtIniTS/dtFimTS uniformes]
  ↓
[200 OK + registros gravados] | [400 mensagem de erro única]
```
