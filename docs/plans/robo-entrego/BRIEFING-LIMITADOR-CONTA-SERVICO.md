# Briefing — redimensionar o rate limiter do robô para a conta de serviço

Prompt para sessão paralela. **Leia o `CLAUDE.md` do repositório antes de
qualquer coisa**: o ambiente chamado "homologação" É produção, e o ciclo git é
cláusula pétrea (branch → gates com números → `git add` por caminho → commit →
PR → merge → build da main com tag `<rótulo>-<sha7>` → deploy pelos 5 gates →
prova do bundle servido). **Autorização é por etapa.**

## O problema, medido (não suposto)

Na drenagem do backfill de enriquecimento em 2026-09-06/07 (599 motoristas
processados numa noite), o robô foi **rate-limitado pelo próprio backend** ao
gravar os resultados.

`app_homologacao/backend/routes/hub-robo-entrego.js` (l.67-81):

```js
const roboEntregoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {            // por usuário autenticado, não por IP
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    return payload && payload.sub ? String(payload.sub) : req.ip;
  },
  handler: (_req, res) => res.status(429).json({ erro: 'Muitas requisições...' }),
});
```

Ele cobre as **três** rotas do robô:

| linha | rota | permissão |
|---|---|---|
| 83 | `POST /eventos` | `importacoes.criar` |
| 134 | `GET /motoristas-para-enriquecer` | `motoristas.enriquecimento.consultar` |
| 188 | `PATCH /motoristas/:id/entrego-enriquecimento` | `motoristas.enriquecimento.atualizar` |

**A aritmética que estoura:** uma rodada de enriquecimento custa **1 GET
(fila) + até 20 PATCH (um por motorista) = 21 requisições**.

| throttle do worker | duração da rodada | cadência efetiva | req / 15 min | vs. teto 30 |
|---|---|---|---|---|
| 60 s (default FR-016) | ~20 min | 1 rodada / ~20 min | ~16 | ok |
| 30 s (usado no backfill) | ~10 min | 1 rodada / ~10 min | **~31,5** | **estoura** |

**Efeito medido na noite:** 70 falhas contabilizadas, mas só 29 saíram da fila.
O motorista era buscado no portal **com sucesso** e mesmo assim virava falha,
porque o PATCH de resultado levava 429. 15 linhas de
`falha ao reportar item N ao hub: ... status inesperado 429` no journal, e **31
motoristas terminaram sem enriquecimento e fora da fila** (já reenfileirados
manualmente em 2026-09-07 13:43).

## O que JÁ foi feito (não refazer)

- **PR #166** (`98bac20`): `atualizarEnriquecimento` no robô agora **retenta o
  429 até 3×**, respeitando `retry-after`/`ratelimit-reset` da própria resposta
  (piso 1 s, teto 5 min), e toda falha passa a logar id + motivo.
  Isso é **mitigação**: o robô deixou de perder trabalho, mas continua
  **esperando** por um limite mal dimensionado. Este briefing trata da causa.
- O limiter **não foi alterado** em nenhum PR até aqui.

## O que se quer

Redimensionar/escopar o limitador para que a **conta de serviço do robô**
(`HUB_SERVICO_EMAIL`, entidade 6) consiga drenar em ritmo de backfill sem
tomar 429, **sem afrouxar a proteção para usuários humanos**.

O limitador existe por um motivo real, registrado no próprio código: *"defesa
barata contra uso indevido da credencial de serviço para flood de uma tabela
imutável"* (hardening de `contracts/hub-api.md`, gate owasp-security). **Não
resolva simplesmente subindo `max` para todo mundo** — isso remove a proteção
que justificou o limiter.

Direções a avaliar (escolher com justificativa, não implementar todas):

1. **Escopar por princípio**: limite alto para a conta de serviço (identificada
   server-side pelo vínculo/papel, **nunca** por algo vindo do cliente), limite
   atual para os demais.
2. **Escopar por rota**: o `PATCH` de resultado é o gargalo e é
   idempotente-por-motorista; ele pode ter um teto próprio, bem maior, enquanto
   `POST /eventos` mantém o teto apertado.
3. **Custo por requisição em vez de contagem plana** (`express-rate-limit`
   suporta `skip`/store customizado), se as duas acima não servirem.

Dimensione com a conta explícita: qual throttle do worker se quer suportar
(hoje 60 s; o backfill quis 30 s; considerar folga para 15 s), quantas
requisições isso dá por janela, e qual teto cobre isso com margem.

## Restrições

- **Escopo multi-tenant e identidade sempre server-side, a partir do token** —
  nunca de header, corpo ou querystring (constitution §I-III).
- Manter `standardHeaders: true`: o robô agora **depende** de
  `retry-after`/`ratelimit-reset` para esperar o tempo certo.
- Manter o `keyGenerator` por usuário autenticado (com fallback para IP) — não
  voltar a chavear só por IP, que travaria usuários atrás do mesmo proxy.
- **Não tocar** em `routes/hub-auth.js#authRateLimiter` (login), que protege
  outra coisa.
- **Não tocar** em `infra/robo-entrego/` — a mitigação de lá já está mergeada.
- Mudança de backend ⇒ **build + deploy em produção** ⇒ rito integral dos 5
  gates. Imagem de backend **sempre** via `Dockerfile.hub` (node:20), com
  `df -h /` e swap conferidos antes.

## Entregáveis

1. Decisão de desenho, com a aritmética que a sustenta.
2. Mudança em `routes/hub-robo-entrego.js` + testes unitários que provem:
   conta de serviço acima do teto antigo **passa**; usuário comum acima do teto
   **toma 429**; os headers de reset continuam presentes.
3. PR com o que muda, risco, verificação com números, e o que ficou de fora.
4. Runbook de deploy com rollback anotado (produção hoje: backend
   `registry.todo-tips.com/envio-massa-backend:hub-sessao-fix-1e281d0`).
5. Prova pós-deploy: uma rodada de enriquecimento a 30 s **sem** nenhum 429 no
   journal do worker.

## Contexto útil

- Estado do backfill em 2026-09-07: **590 de 1281 enriquecidos (46%)**, **691
  na fila**, drenagem parada e o timer
  `entrego-enriquecimento-sob-demanda.timer` **desabilitado** de propósito.
- Plano do backfill e histórico da noite:
  [`docs/plans/robo-entrego/PLANO-ENRIQUECIMENTO-MASSA.md`](PLANO-ENRIQUECIMENTO-MASSA.md).
- Contrato do enriquecimento:
  `docs/specs/hub-motorista-360/contracts/entrego-enriquecimento.md`.
- ⚠️ Pendência **não** resolvida e alheia a este briefing: a **retenção de PII**
  segue sem prazo definido, e já cobre 590 pessoas (CPF/RG/CNH).
