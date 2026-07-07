# Data Model: hub-shell (S3)

Feature de frontend sobre contrato de backend existente (S2). **Sem persistência nova / sem
DDL** (research D8). Este documento modela os **tipos de domínio do shell** e o **adaptador de
borda** — não há entidade de banco criada por esta fase. As entidades de banco subjacentes
(`Usuario`, `UsuarioEntidade`, `Papel`, `Modulo`, `ModuloEntidade`, `Auditoria`) pertencem à S2
e são imutáveis aqui.

## 1. DTO da API (snake_case) — o que o backend emite

Espelho literal do contrato verificado (`plan.md` §1.1/§1.2). Consumido SÓ pelo adaptador.

```ts
// lib/hub/me-dto.ts — shapes de fronteira (NÃO usar direto em componentes)
interface MeResponseDTO {
  usuario: { id: number; email: string; nome: string };
  entidades: Array<{ empresa_id: number; papel: string | null; ativo: boolean }>;
  entidade_ativa: number | null;
  modulos: Array<{ codigo: string; nome: string; icone: string; ordem: number; ativo: boolean }>;
  permissoes: string[]; // "<codigo>.<acao>", união cross-entidade
}
interface TrocarEntidadeReqDTO  { empresa_id: number }
interface TrocarEntidadeRespDTO { entidade_ativa: number }
```

## 2. Tipos de domínio do shell (camelCase) — o que os componentes veem

```ts
interface HubUsuario   { id: number; email: string; nome: string }
interface HubVinculo   { empresaId: number; papel: string | null; ativo: boolean }
interface HubModulo    { codigo: string; nome: string; icone: string; ordem: number }
// nota: 'ativo' do DTO não é propagado — presença no array já significa habilitado+visível (D2)

interface HubMe {
  usuario: HubUsuario;
  entidades: HubVinculo[];
  entidadeAtiva: number | null;
  modulos: HubModulo[];      // já ordenado por 'ordem' (backend); reordenar é defensivo
  permissoes: string[];      // decorativo p/ PermissionGate; NÃO é barreira de segurança (D3)
}
```

## 3. Adaptador de borda (fonte única da tradução)

`lib/hub/me-dto.ts` expõe:
- `toHubMe(dto: MeResponseDTO): HubMe` — snake→camel; descarta `modulos[].ativo` (D2); mantém
  `entidadeAtiva` podendo ser `null` (degradação de vínculo — plan §1.1).
- `toTrocarEntidadeReq(empresaId: number): TrocarEntidadeReqDTO` — camel→snake p/ o body.

**Invariante de paridade (testada)**: os campos snake do `MeResponseDTO` devem casar 1:1 com o
select real de `hub-me.js`. Teste unitário lê o contrato §1.1 e falha se `toHubMe` referenciar
um campo inexistente ou omitir um contratado. (plan §6)

## 4. Estado de sessão do shell (client, efêmero)

Mantido pelo `HubAuthProvider` (`contexts/hub-auth-context.tsx`), NÃO persistido em git/localStorage
sensível. A sessão real é o cookie `accessToken` httpOnly (invisível ao JS — correto).

| Campo | Origem | Uso |
|-------|--------|-----|
| `me: HubMe \| null` | `GET /api/v1/me` via `toHubMe` | render de nav/dashboard/perfil |
| `carregando: boolean` | ciclo de fetch | telas de loading/guard |
| `entidadeAtiva` | `me.entidadeAtiva` | escopo visual corrente |

Transições: `login()` → `refetchMe()`; `trocarEntidade(id)` → `POST /me/entidade` → `refetchMe()`;
navegação entre rotas → `refetchMe()` (guard, D7); `logout()` → `POST /auth/logout` → limpa `me`
→ redireciona `/login`.

## 5. Mapeamento módulo → rota (derivado, sem hardcode de itens)

`HubModulo.codigo` → rota `/dashboard/<codigo>` (convenção; nenhuma lista fixa de módulos).
Testado unitariamente (briefing "mapeamento módulo→rota"). O breadcrumb deriva de NAV_ITEMS,
que por sua vez deriva de `me.modulos` (gotcha herdado do U-fix do painel).

## 6. Convenção de permissão (PermissionGate)

`permissoes[]` contém strings `"<codigo>.<acao>"` (ex.: `motoristas.view`, `usuarios.gerenciar`
— código real seedado pela fundação S2; correção CHK010, ver `spec.md` Q1).
`PermissionGate action="motoristas.view"` renderiza os filhos só se a string estiver presente.
Decorativo — a autorização real é do backend por-entidade (D3). Sem mapa estático
código→permissão no frontend (spec Q1/dec-007).
