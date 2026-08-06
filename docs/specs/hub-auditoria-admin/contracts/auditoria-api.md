# Contrato — /api/v1/auditoria

Padrões herdados do hub (hub-faturamento/hub-performance): prefixo
`/api/v1`; auth por cookie JWT httpOnly (`hub_accessToken`, HS256 pinado);
entidade SEMPRE resolvida de `payload.entidade_ativa` (nunca query/body);
erros no formato curto `{ "erro": "CODIGO" }`; campos camelCase na borda,
snake_case no banco. Handler: `routes/hub-me.js` (`auditoriaRouter`, montado
em `server.js`) — EVOLUÇÃO do endpoint existente, aditiva (chave `eventos`
preservada).

## GET /auditoria

Lista paginada de eventos, mais recentes primeiro (`criado_em DESC, id DESC`).

**Permissão**: `auditoria.consultar` (flat) **+** checagem por-entidade via
`obterPermissoesEfetivasPorEntidade(sub, entidadeAtiva)` (padrão existente).

**Escopo (FR-002/FR-003)**:
- `admin_entidade` (sem claim global): SEMPRE `id_empresa = entidade_ativa`.
  Sem entidade ativa → `200 { "eventos": [], "total": 0 }` (nega-por-padrão,
  comportamento já asserted em `hub-rbac-integration.sh`). Param `entidadeId`
  fora do escopo → `403 PERMISSAO_NEGADA` (nunca resultado cross-tenant).
- `admin_plataforma` (vínculo ativo com papel global — backend seta claim
  `admin_plataforma` no JWT PostgREST): sem `entidadeId` vê TODAS as
  entidades + eventos globais (`id_empresa IS NULL`); com `entidadeId` vê só
  aquela entidade (US2).

**Query params**:

| Param | Tipo | Default | Nota |
|-------|------|---------|------|
| `acao` | string | — | igualdade exata (`acao=eq.`) |
| `usuarioId` | int | — | responsável (`usuario_id=eq.`) |
| `recurso` | string | — | igualdade exata |
| `de` | date ISO (`YYYY-MM-DD`) | — | `criado_em >= de` (00:00 UTC) |
| `ate` | date ISO | — | `criado_em <= ate` (23:59:59 UTC) |
| `entidadeId` | int | — | SÓ admin_plataforma; outros → 403 |
| `page` | int ≥ 1 | 1 | página além do total → `eventos: []`, 200 |
| `pageSize` | int 1..100 | 20 | |

**Validação**: `de > ate` → `400 { "erro": "PERIODO_INVALIDO" }` (edge case
da spec); `page`/`pageSize` não-numéricos → `400 PARAMETRO_INVALIDO`.

**Hardening obrigatório (gate owasp, finding M1 — A05)**: todo valor de
filtro é validado por vocabulário fechado ANTES de compor a URL PostgREST —
`acao`/`recurso` casam `^[a-z0-9_]+$` (senão `400 PARAMETRO_INVALIDO`),
`usuarioId`/`entidadeId` são `Number.isInteger`, datas parseadas como ISO —
e TODO valor passa por `encodeURIComponent` na composição. Nunca interpolar
input bruto na query string do PostgREST (evita injeção de operadores
`,or=`/`&` na sintaxe de filtro).

**Response 200**:

```json
{
  "eventos": [
    {
      "id": 4211,
      "entidadeId": 9001,
      "usuarioId": 17,
      "acao": "usuario_papel_alterado",
      "recurso": "UsuarioEntidade",
      "recursoId": "33",
      "detalhes": { "papelAnterior": "operador", "papelNovo": "leitura" },
      "ip": "10.0.0.5",
      "criadoEm": "2026-07-09T18:22:10.000Z"
    }
  ],
  "total": 1342,
  "page": 1,
  "pageSize": 20
}
```

`total` via `Prefer: count=exact` do PostgREST. `detalhes` chega scrubbed por
construção (escrita via `registrarAuditoria`/`scrubDetalhes` — FR-004/SC-006);
o handler NÃO re-serializa campos sensíveis. Detalhe de evento = drawer
client-side sobre a linha (research Decision 9 — sem `GET /:id`).

**Erros**: `401 NAO_AUTENTICADO` · `403 PERMISSAO_NEGADA` ·
`403 MODULO_DESABILITADO` (módulo `auditoria` inativo p/ entidade ativa) ·
`400 PERIODO_INVALIDO` / `PARAMETRO_INVALIDO` · `502 SERVICO_INDISPONIVEL`
(falha PostgREST).

## Imutabilidade (contrato negativo — FR-005/SC-003)

Não existe rota de escrita sob `/api/v1/auditoria`. Qualquer
UPDATE/DELETE direto no PostgREST falha por REVOKE + trigger
`hub_bloqueia_alteracao_auditoria` (coberto por
`infra/hub/testes/hub-auditoria-integration.sh`).
