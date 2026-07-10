# Carga S10 (20260710T030019Z) — projeto hub-s10b-1783651300

Base: 1505183 FaturamentoLancamento, 1020000 PerformanceTurno (tenant 9001, janela 2026-07-03..2027-07-12).

## p95 por endpoint — ASSERT <1s (100 reqs, 3 de aquecimento descartadas)

Listas paginadas server-side + resumos na janela padrão das telas (30d).

| endpoint | p50 (ms) | p95 (ms) | max (ms) | HTTP≠200 |
|---|---|---|---|---|
| /faturamento/resumo?de=2027-06-12&ate=2027-07-12 | 68 | 87 | 107 | 0 |
| /faturamento/resumo?de=2027-06-12&ate=2027-07-12&groupBy=dia | 59 | 82 | 97 | 0 |
| /performance/resumo?de=2027-06-12&ate=2027-07-12 | 104 | 131 | 167 | 0 |
| /performance/resumo?de=2027-06-12&ate=2027-07-12&groupBy=dia | 110 | 137 | 157 | 0 |
| /faturamento?de=2026-07-03&ate=2027-07-12 | 158 | 178 | 183 | 0 |
| /performance?de=2026-07-03&ate=2027-07-12 | 123 | 138 | 166 | 0 |
| /importacoes | 5 | 7 | 43 | 0 |
| /auditoria | 4 | 7 | 8 | 0 |

## Medições informativas de PIOR CASO (sem assert — achado S10)

Resumos na janela de 1 ano cheio (varredura completa da MV) e
/motoristas (paginação/filtro em JS + hub_areas_por_entregador sobre
as 2 tabelas de fato inteiras). Melhorar exige mudança funcional —
registrado para decisão do operador (follow-up pré ou pós-cutover).

| endpoint | p50 (ms) | p95 (ms) | max (ms) | HTTP≠200 |
|---|---|---|---|---|
| /faturamento/resumo?de=2026-07-03&ate=2027-07-12 | 705 | 751 | 772 | 0 |
| /faturamento/resumo?de=2026-07-03&ate=2027-07-12&groupBy=dia | 801 | 854 | 888 | 0 |
| /performance/resumo?de=2026-07-03&ate=2027-07-12 | 1117 | 1179 | 1259 | 0 |
| /performance/resumo?de=2026-07-03&ate=2027-07-12&groupBy=dia | 1506 | 1567 | 1601 | 0 |
| /motoristas | 1973 | 2269 | 2332 | 0 |

## Importação de arquivo diário (pipeline real + auto-refresh das MVs)

```json
{
 "fat": {
  "upload_status": 201,
  "id": 6,
  "status_final": "completed_with_errors",
  "ms": 1691
 },
 "perf": {
  "upload_status": 201,
  "id": 7,
  "status_final": "completed",
  "ms": 1042
 }
}
```

## Reimportação (idempotência de linha sob volume)

Delta de fatos após reenviar o MESMO arquivo + um arquivo com 1 linha nova: +1 (esperado 1).

```json
{
 "reimport_identico": {
  "upload_status": 409,
  "body": {
   "error": "CONFLITO",
   "importacaoOriginalId": 6
  },
  "ms": 26
 },
 "reimport_mais1": {
  "upload_status": 201,
  "id": 8,
  "status_final": "completed_with_errors",
  "ms": 1115
 }
}
```
