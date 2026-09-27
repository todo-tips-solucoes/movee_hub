# Contrato: trava de papéis restritos (F2)

Base: `/api/v1/usuarios` (`server.js:2919`), roteador `routes/hub-usuarios.js`. Todas as
rotas abaixo exigem `usuarios.gerenciar` (existente). "Admin plataforma" = claim resolvida
por `usuarioEhAdminPlataforma` (`hub-rbac-cache.js`), a mesma que já monta
`claims.adminPlataforma` (`hub-usuarios.js:136`).

Papéis restritos: `admin_plataforma`, `financeiro_aprovador`.

## Erro novo [PROPOSTA — a validar na implementação]

```json
HTTP 403
{ "erro": "PAPEL_RESTRITO", "mensagem": "Somente o administrador da plataforma pode conceder, alterar ou desativar este papel." }
```

Toda resposta `PAPEL_RESTRITO` grava auditoria `usuario_vinculo_negado`
(`lib/hub-auditoria.js`), detalhes sem dado pessoal (ids de usuário/papel, rota).

## Pontos de escrita cobertos

| Rota | Linha | Recusa quando o chamador NÃO é admin plataforma e… |
|---|---|---|
| `POST /usuarios` | `:288` | `papelId` do 1º vínculo é restrito |
| `POST /usuarios/:id/vinculos` | `:487` | `papelId` é restrito |
| `PUT /usuarios/:id/vinculos/:vinculoId` | `:603` | o papel **atual** do vínculo é restrito (altera ou desativa), **ou** o `papelId` novo é restrito — checagem **escopada** à entidade ativa do chamador (`filtroEscopo`, linha `:588`; o vínculo alterado já é sempre de uma entidade visível ao chamador, então não há caso cross-empresa aqui) |
| `PUT /usuarios/:id` | `:424`-`:425` | o alvo tem vínculo **ativo** com papel restrito **em QUALQUER EMPRESA** e o corpo altera `senha`, `nome` ou `ativo` (troca de senha/desativação = tomada de conta) |

Ordem da checagem: depois de resolver o papel (a rota consulta
`Papel?id=eq.…&select=id,nome` em `:281`/`:484`; em `PUT /usuarios/:id`, os vínculos
ativos do alvo — ver "Checagem cross-empresa" abaixo) e **antes** de qualquer escrita.
A checagem vale mesmo quando o alvo é o próprio chamador (edge case da spec).

### Checagem cross-empresa (`PUT /usuarios/:id`, correção block-009/dec-075/dec-077)

`PUT /usuarios/:id` é o único ponto de escrita cujo alvo pode ter o vínculo restrito
numa empresa **diferente** da entidade ativa do chamador — os outros 3 pontos escrevem
sempre dentro do escopo do próprio chamador. Por isso usa uma leitura **privilegiada e
separada** da consulta de visibilidade: `alvoTemPapelRestritoAtivo(usuarioId)`
(`lib/hub-rbac-cache.js:208-216`) consulta
`UsuarioEntidade?usuario_id=eq.<alvo>&ativo=eq.true&select=papel:Papel(nome)` **sem
filtro de empresa**, assinando o JWT com `{ usuarioId: usuarioAlvoId }` — o `sub` da
claim é o **próprio alvo**, não o chamador, então a policy real
`usuarioentidade_select_proprio` (`0006_rls_policies.sql:74-76`,
`USING (usuario_id = sub::int)`) devolve os vínculos do alvo em **qualquer empresa**. A
consulta antiga (`vinculosVisiveis`, ainda usada só para o 404 anti-vazamento) é
filtrada por `empresa_id=eq.<entidade ativa do CHAMADOR>` e por isso nunca enxergava um
vínculo restrito do alvo numa empresa diferente — esse era o furo original.

**Fail-closed em erro de leitura**: `alvoTemPapelRestritoAtivo` não tem `try/catch`
próprio — se a chamada ao PostgREST falhar (rede, timeout, 5xx), o erro sobe e cai no
`try/catch` que envolve o handler inteiro de `PUT /usuarios/:id`, respondendo `500` e
**nunca prosseguindo para o `PATCH`**. Não existe caminho em que uma falha de leitura
libere a escrita (fail-open).

Sem regressão (FR-011): papéis não restritos seguem com o comportamento atual,
incluindo os códigos existentes (`PAPEL_NAO_ENCONTRADO`, `USUARIO_NAO_ENCONTRADO`,
`DADOS_INVALIDOS`).

## Camada de banco (prova "direto no PostgREST")

| Operação com JWT de `admin_entidade` | Resultado esperado |
|---|---|
| `POST /UsuarioEntidade` com `papel_id` restrito | erro `42501` (RLS `WITH CHECK`) → HTTP 403 do PostgREST |
| `PATCH /UsuarioEntidade?id=eq.<vínculo restrito>` (`ativo=false` ou troca de papel) | **0 linhas afetadas** (`USING` filtra) → resposta `[]`; o teste confere que a linha não mudou |
| `PATCH` de vínculo não restrito para papel restrito | `42501` (`WITH CHECK`) → 403 |
| `POST /PapelPermissao`, `PATCH /Papel`, `POST /Permissao`, `PATCH /Modulo` (qualquer) | após o REVOKE da 0097: `42501` → 403 |

## Tela de Usuários (frontend_v2)

`app/hub/dashboard/usuarios/page.tsx:139` monta o seletor a partir de `papeis`. Para quem
não é admin plataforma, os papéis restritos saem da lista (conforto; a segurança é das
duas camadas acima). Rótulo do papel novo: `labelPapel` já gera "Financeiro aprovador".
