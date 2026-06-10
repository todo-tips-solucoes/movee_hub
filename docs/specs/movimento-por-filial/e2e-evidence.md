# Evidência E2E — movimento-por-filial (homologação)

Data: 2026-06-10 · Ambiente: homologação (Docker Swarm, https://envmassv2.todo-tips.com)
Deploy aditivo: backend `sha256:ee37d7bb…` + frontend_v2 `sha256:f47af706…` (ambos convergiram 1/1).

## Conta de teste
- Admin grupo-pai: `admin@movee.com.br` (Empresa id=6) — virou grupo-pai via seed 006.
- Filial de teste: `FILIAL TESTE E2E (movimento-por-filial)` (Empresa id=12, grupo id=2).
- Seed: `docs/sql/006-seed-movee-grupo-teste-e2e.sql` · Limpeza: `docs/sql/006b-cleanup-…sql`.

## Resultados (todos verdes)

| # | Cenário | Esperado | Obtido |
|---|---------|----------|--------|
| 1 | Smoke unauth `GET /grupo/escopo` | 401 | 401 |
| 2 | Login Movee | 200 | 200 (empresaId=6) |
| 3 | `GET /grupo/escopo` (multi-filial) | 2 empresas | `[{6,Movee},{12,Filial}]`, default=6 |
| 4 | `GET /envio-massa?empresa_id=6` | 200 | 200 · 277 itens |
| 5 | `GET /envio-massa?empresa_id=12` | 200 (isolado) | 200 · 0 itens (→1 após import) |
| 6 | `GET /envio-massa` (sem param) | 200 = própria | 200 · 277 (== #4) |
| 7 | `GET /envio-massa?empresa_id=1` (fora) | 403 | 403 `empresa fora do escopo` |
| 8 | `?empresa_id=abc` (inválido) | 403 | 403 `empresa_id inválido` |
| 9 | `GET /export-envio-massa?empresa_id=1` | 403 | 403 |
| 10 | `GET /download-xml-movimento?empresa_id=1` | 403 | 403 |
| 11 | `POST /upload` empresa_id=12 (import filial) | 200 inserted | 200 `{inserted:1}` |
| 12 | `POST /upload` empresa_id=1 (fora) | 403 | 403 `empresa fora do escopo` |
| 13 | Isolamento pós-import | filial=1, Movee=277 | filial 12 = 1 (`id_empresa:12`), Movee 6 = 277 |
| 14 | `GET /grupo/filhos` | lista filial 12 | 200, filhos=[{12}] |

## Conclusão
Invariante de segurança (constitution §II) e a feature multi-filial (visão + import por
filial) validadas end-to-end. Ramo hardcoded `id_empresa===6` preservado (filial ≠6 seguiu
o caminho normal exigindo dt_inicial/dt_final). Pendente: operador aplicar `006b` para
remover o dado de teste (filial 12 + grupo + a linha EnvioMassa importada).
