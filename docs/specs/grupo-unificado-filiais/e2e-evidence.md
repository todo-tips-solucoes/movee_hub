# Evidência E2E — grupo-unificado-filiais (homologação)

Data: 2026-06-10 · Ambiente: homologação (Docker Swarm) · API: `https://envmassapihomologacao.todo-tips.com` · Frontend: `https://envmassv2.todo-tips.com`

## Deploy aditivo (service update --image, preserva env/labels)
- backend `sha256:90de679b…` (convergido 1/1)
- frontend_v2 `sha256:eeb3ce7b…` (convergido 1/1)
- Serviços `frontend` e `frontend_motorista` não tocados.

## Contas de teste
- Pai/matriz do grupo 2 (Movee): `admin@movee.com.br` (Empresa id=6), senha `123456`.
- Filial do grupo 2: `filial.teste.e2e@movee.com.br` (Empresa id=12), senha `teste123` (seed `006`).
- Filial cross-grupo (grupo 1 / D&G): Empresa id=3.

## Bugs encontrados pelo E2E e corrigidos antes de fechar (deploy iterado)
1. **HTTP 500 em todo `POST /login`** — a reordenação do HIGH-001 chamava `bcrypt.compare`
   sem validar presença de `email`/`password` → `data and hash arguments required`.
   Fix: guarda de presença → 400 genérico antes de qualquer bcrypt.
2. **HTTP 500 ao logar filial sem senha (FR-B)** — `bcrypt.compare(password, user.pass=null)`
   lançava. Fix: `user.pass || BCRYPT_DUMMY_HASH` (retorna false, equaliza timing, sem crash).
3. **express-rate-limit incompatível** — `^8.x` exige Node ≥18; backend roda `node:14`.
   Fix: downgrade para `^6.11.2`.

## Resultados (todos verdes)

| # | Cenário | Esperado | Obtido |
|---|---------|----------|--------|
| C1 | Login da matriz (`admin@movee.com.br`) | 200 | 200 |
| C2 | Login de filial com **senha errada** (anti-enumeração HIGH-001) | 400 genérico | 400 `Email ou senha incorretos` |
| C2' | Login de filial com **senha correta** (bloqueio CL-002) | 403 | 403 `Acesse o painel usando o login do grupo` |
| C3 | Refresh token da matriz | 200 | 200 |
| RL | Rate limiting `POST /login` (MEDIUM-001) | 429 após 10/15min | 429 `Muitas tentativas…` |
| L1 | `GET /grupo/filhos` | 200 | 200 |
| L2 | Listagem inclui a matriz com `is_pai:true` (decisão operador) | presente | `is_pai:true` presente |
| B1 | `GET /grupo/empresas/12` (filial mesmo grupo) | 200 | 200 |
| B2 | `PUT /grupo/empresas/12` editar filial | 200 | 200 |
| B2b | `PUT` restaurar nome da filial | 200 | 200 |
| B3 | `PUT /grupo/empresas/3` cross-grupo (BOLA MEDIUM-003) | 403 genérico | 403 `Empresa não encontrada` |
| B4 | `GET`+`PUT /grupo/empresas/6` editar a **matriz** (novo escopo) | 200 | 200 |
| B4c | `PUT` restaurar nome da matriz | 200 | 200 |
| B5 | `PUT /grupo/empresas/abc` id inválido (HIGH-002) | 400 | 400 `ID inválido` |

## Cobertura

- **Módulo B (editar filiais)** + **edição da matriz** + **Módulo C (login único + refresh + rate limit)**: validados E2E acima.
- **Módulo A (comportamento por grupo)**: NÃO exercido via HTTP de propósito — testar dispararia
  envio real (whatsmeow) e validação fiscal na **produção da Movee**. Coberto por validação
  estática: `node --check`, revisão dos 4 ramos (415/938/1314/1762 trocados por
  `mesmoGrupoQue(...,6,_grupoCache)`; ramo id=16 intacto) e pela membresia da filial 12 no grupo 2.

## Pendências
- Operador aplicar `006b` (limpeza do seed de teste) quando não precisar mais da filial 12.
- Decisão de corte de produção do Módulo C (bloqueia 5 filiais D&G reais com login ativo) — adiada para após este E2E.
