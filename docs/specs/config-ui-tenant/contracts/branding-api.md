# Contracts: Branding API (config-ui-tenant)

Convenção de payload: **snake_case** (espelha banco e DTO do frontend — ver
plan.md §Convenções de Borda). Auth via cookie httpOnly `accessToken` (proxy
`app/api/[...path]/route.ts`).

---

## GET /empresa/branding

Retorna a branding do **grupo do token** (escopo resolvido server-side). Painel
(`frontend_v2`) usa para popular o form de aparência.

### Request
- **Auth**: `authenticateToken` (aud empresa). `req.user.empresaId` + claim
  `id_grupo`.
- **Body**: nenhum.

### Response (200)
```json
{
  "id_grupo": 12,
  "logo_url": "https://<supabase>/storage/v1/object/public/branding/logo/12/<sha>.png",
  "cor_primaria": "#1f63eb",
  "cor_destaque": "#ff7a18",
  "nome_exibicao": "Transportadora D&G"
}
```
Se a empresa **não tem grupo** (`id_grupo` NULL) ou o grupo não tem branding:
```json
{ "id_grupo": null, "fallback": "movee" }
```

### Error Responses
| Status | Quando | Body |
|--------|--------|------|
| 401 | sem/inválido token | `{ "error": "Acesso negado..." }` |

---

## PUT /empresa/branding

Cria/atualiza (upsert) a branding do grupo do token. **Somente o CNPJ pai** pode
editar (validação `is_grupo_pai`). Multipart se inclui upload de logo.

### Request
- **Auth**: `authenticateToken` + `is_grupo_pai === true` (senão 403).
- **Content-Type**: `multipart/form-data` (campo `logo` opcional) **ou**
  `application/json` (sem alterar logo).
- **Campos**:
  | Campo | Tipo | Validação |
  |-------|------|-----------|
  | `cor_primaria` | string | hex `^#[0-9a-fA-F]{6}$` |
  | `cor_destaque` | string | hex `^#[0-9a-fA-F]{6}$` |
  | `nome_exibicao` | string | não vazio, ≤ N chars |
  | `logo` (file) | PNG/SVG/JPEG | mimetype permitido, ≤ 512 KB |

> O `id_grupo` **não** vem do cliente — é derivado de `resolveScope`/claim do
> token (Princípio II). Enviar `id_grupo` no body é ignorado.

### Response (200)
```json
{
  "id_grupo": 12,
  "logo_url": "https://.../logo/12/<sha>.png",
  "cor_primaria": "#1f63eb",
  "cor_destaque": "#ff7a18",
  "nome_exibicao": "Transportadora D&G",
  "updated_at": "2026-06-05T12:00:00Z"
}
```

### Error Responses
| Status | Quando | Body |
|--------|--------|------|
| 400 | hex inválido / logo formato ou tamanho inválido | `{ "error": "Cor inválida..." \| "Logo deve ser PNG/SVG/JPEG até 512 KB" }` |
| 401 | sem token | `{ "error": "Acesso negado..." }` |
| 403 | token não é pai do grupo | `{ "error": "Apenas o CNPJ administrador do grupo pode editar a aparência." }` |

---

## GET /motorista/branding-tomador

Endpoint **leve** do PWA. Resolve a branding do **tomador** de um movimento.

### Request
- **Auth**: `authenticateMotorista` (aud=motorista; `req.motorista.cnpjPrestador`).
- **Query**: `?movimento=<id>` (preferencial) **ou** `?id_empresa=<id>` — o backend
  resolve `id_empresa` do tomador a partir do movimento server-side.

### Response (200)
```json
{
  "logo_url": "https://.../logo/12/<sha>.png",
  "cor_primaria": "#1f63eb",
  "cor_destaque": "#ff7a18",
  "nome_exibicao": "Transportadora D&G"
}
```
Tomador sem grupo/branding ou erro de resolução → fallback (HTTP 200, payload
fallback) para o PWA degradar graciosamente:
```json
{ "fallback": "movee" }
```

### Error Responses
| Status | Quando | Body |
|--------|--------|------|
| 401 | token motorista inválido | `{ "error": "Credenciais inválidas." }` |
| 200 (fallback) | tomador sem branding / movimento não resolvido | `{ "fallback": "movee" }` — **nunca** erro que trave o PWA (FR-010) |

> Read-only; só expõe campos de marca pública (logo/cores/nome). Nenhum dado
> sensível do tomador trafega.

---

## Mapeamento snake_case → CSS custom property (TenantThemeProvider)

| Campo da API | CSS var (frontend_v2 / oklch) | CSS var (frontend_motorista / HEX) |
|--------------|-------------------------------|------------------------------------|
| `cor_primaria` | `--primary` (+ deriva `--ring`, `--sidebar-primary`) | `--primary` (+ `--ring`) |
| `cor_destaque` | `--accent` | `--accent` / ponto do gradiente `--warm-2` (extremos derivados por luminância) |
| `nome_exibicao` | texto do wordmark/header | texto do `wordmark` |
| `logo_url` | `src` do logo no header | `src` do `logo-mark` |

Conversão de cor: HEX recebido da API é aplicado direto no motorista (tokens HEX);
no v2 (tokens oklch) o provider converte HEX→oklch em runtime (ou usa a property
diretamente, já que `var()` aceita qualquer formato de cor válido). Fallback: se
campo ausente/NULL, a property **não** é sobrescrita → mantém o valor hardcoded do
`globals.css` (identidade atual).
