# Data Model: hub-uiux-refresh

Sem alterações no banco (PostgreSQL/PostgREST) ou em qualquer DTO de
API — as duas "entidades" desta feature são estado **puramente
client-side**, persistidas em `localStorage` do navegador, não em linha de
tabela.

## Entity: Preferência de navegação da usuária

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `hub:sidebar-collapsed` (chave de `localStorage`) | boolean (serializado como string `"true"`/`"false"`) | Ausente ou inválido → assume `false` (expandida) | Escopo: por navegador/dispositivo, não por usuária (mesmo padrão do `next-themes`, que também é por navegador) |

### Relationships

Nenhuma — chave isolada, sem vínculo com entidades de backend (`Usuario`,
`Empresa`, etc.).

### State Transitions

```
expandida (padrão) ⇄ colapsada
```

Transição bidirecional simples, acionada pelo controle na topbar (FR-001);
sem estados intermediários persistidos (a transição visual é só CSS).

## Entity: Preferência de tema da usuária

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| `theme` (chave de `localStorage`, gerenciada pela lib `next-themes`) | enum `"dark" \| "light"` | Ausente → `defaultTheme="dark"` (`app/layout.tsx:44`) | Já implementado — nenhuma mudança de shape; citado aqui só para completude do modelo |

### Relationships

Nenhuma — já existente, gerenciada inteiramente pela biblioteca
`next-themes`; esta feature não altera seu formato, só expõe o controle
(`<ThemeToggle />`) dentro do shell do hub.

### State Transitions

```
dark (padrão) ⇄ light
```
