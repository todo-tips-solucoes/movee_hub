# Quickstart / Cenários de Teste — import-range-datas

> Cenários de validação manual e integração para a feature de seletor de range de datas.

---

## Cenário 1 — Happy path: import com range válido

**Pré-condição:** Usuário autenticado, planilha `test.xlsx` com pelo menos 2 linhas (colunas obrigatórias: `number`, `nome`, `valor`, `cnpj_tomador`, `cnpj_prestador`; colunas `dt_inicial`/`dt_final` podem estar ausentes ou com valores aleatórios).

1. Navegar para `app.moveelog.com.br/dashboard`
2. Clicar **Importar XLSX**
3. **Expected:** diálogo abre solicitando "Data inicial" e "Data final"
4. Preencher Data inicial: `2026-05-01`, Data final: `2026-05-31`
5. **Expected:** botão Enviar está habilitado
6. Clicar **Enviar**
7. **Expected:** `POST /upload` retorna `200 OK`
8. **Expected:** toast "importado com sucesso!"
9. Consultar banco (`EnvioMassa` para `id_empresa` do token): todas as linhas inseridas têm `dt_inicial = 2026-05-01T03:00:00-03:00` e `dt_final = 2026-05-31T03:00:00-03:00`

---

## Cenário 2 — Range inválido bloqueado na UI

1. Clicar **Importar XLSX**, escolher arquivo
2. Preencher Data inicial: `2026-06-01`, Data final: `2026-05-01`
3. **Expected:** botão Enviar permanece desabilitado (data final < data inicial)
4. Preencher Data final: `2026-06-01` (iguais)
5. **Expected:** botão Enviar habilita (dt_inicial ≤ dt_final permite igualdade)

---

## Cenário 3 — Envio com range ausente (chamada direta ao backend)

```bash
curl -X POST https://apimoveelog/upload \
  -H "Cookie: accessToken=<token>" \
  -F "file=@test.xlsx"
# Sem dt_inicial / dt_final
```

**Expected:** `400 Bad Request` com body `{"success":false,"message":"dt_inicial é obrigatório para o import."}` (mensagem única, não por linha).

---

## Cenário 4 — Range inválido no backend (chamada direta)

```bash
curl -X POST https://apimoveelog/upload \
  -H "Cookie: accessToken=<token>" \
  -F "file=@test.xlsx" \
  -F "dt_inicial=31/05/2026" \
  -F "dt_final=01/05/2026"
```

**Expected:** `400 Bad Request` com body `{"success":false,"message":"dt_inicial deve ser menor ou igual a dt_final."}`.

---

## Cenário 5 — Planilha com colunas de data divergentes (retrocompat)

**Pré-condição:** `test_legacy.xlsx` com colunas `dt_inicial=15/03/2025` e `dt_final=20/03/2025` por linha.

1. Importar `test_legacy.xlsx` com range UI: `2026-05-01` → `2026-05-31`
2. **Expected:** lote processado com sucesso; todas as linhas gravadas com `dt_inicial=2026-05-01` / `dt_final=2026-05-31` (range da UI, ignorando colunas da planilha)

---

## Cenário 6 — Roundtrip End-to-End (regressão gorjeta + valor + CNPJ)

**Pré-condição:** Planilha com `gorjeta` preenchido em algumas linhas e vazio (`R$ -`) em outras.

1. Importar com range válido
2. **Expected (gorjeta):** linhas com `R$ -` → `gorjeta = NULL` no banco; linhas com valor → `gorjeta = valor` correto
3. **Expected (valor):** campo `valor` gravado corretamente em todas as linhas
4. **Expected (CNPJ):** `cnpj_prestador` sem máscara (14 dígitos); `cnpj_tomador` com máscara `##.###.###/####-##`
5. **Expected (datas):** todas as linhas com `dt_inicial`/`dt_final` do range, não da planilha

---

## Cenário 7 — Grupo Movee (antes usava fallback 01/01/1982)

**Pré-condição:** Conta de empresa que pertence ao grupo Movee (`idReferencia = 6`).

1. Importar planilha sem colunas de data (ou com colunas vazias)
2. Preencher range na UI: `2026-06-01` → `2026-06-30`
3. **Expected:** lote processado; datas gravadas = range da UI (não o antigo fallback `01/01/1982`)

---

## Notas de Ambiente

- Backend: `https://app.moveelog.com.br/api/upload` (via proxy do frontend)
- Chamada direta ao backend (cenários 3 e 4) requer token JWT válido e endereço do backend interno
- Lote de teste: planilha mínima com 3-5 linhas cobrindo cenários de gorjeta nula e preenchida
