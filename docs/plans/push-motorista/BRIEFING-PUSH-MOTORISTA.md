# Briefing — notificações push no app do motorista

Objetivo: a equipe Moveelog cria um **aviso** e o motorista o recebe **em tempo real**
no celular, mesmo com o app fechado.

## Estado atual — MEDIDO em 2026-09-11, não suposto

### O que já existe e serve de base

| | evidência |
|---|---|
| PWA real | `public/manifest.json`: `display: standalone`, ícones 192/512 + **maskable**, `start_url: /movimento` |
| Service worker | `app/sw.ts` via `@serwist/next` + `serwist` — precache do app shell + runtime caching |
| Autenticação própria do motorista | `routes/motorista.js`: `POST /login`, `/token/refresh`, `/logout`, middleware `authenticateMotorista`; tabela `ContaMotorista` |
| Proxy do PWA | `app/api/[...path]` (o browser nunca fala direto com o backend) |
| RBAC do hub | `Modulo` · `Permissao` · `PapelPermissao` · `ModuloEntidade` — é aqui que a permissão de criar aviso deve nascer |

### O que NÃO existe — o gap inteiro

- **Nenhuma** dependência de push no backend (`web-push`, `firebase`, `fcm`, `apn`: zero).
- `app/sw.ts` **não** tem handler `push` nem `notificationclick` — só cache.
- **Nenhuma** chave VAPID, em lugar nenhum.
- **Nenhuma** tabela de assinatura (subscription).
- **Nenhum** conceito de Aviso/Notificação no schema do hub (as 24 tabelas foram listadas; não há).
- **Nenhuma** tela ou permissão para a equipe criar avisos.

Ou seja: a fundação de PWA está pronta; **todo o resto é novo**.

## Restrições duras — cada uma muda o desenho

🔴 **iOS só entrega push para PWA INSTALADO na tela de início** (Safari/iOS 16.4+).
Não há contorno. Isso não é detalhe técnico, é **adoção**: sem um fluxo que leve o
motorista a instalar o app, a feature simplesmente não existe para a base iOS. O plano
precisa tratar instalação como parte do produto, e medir a cobertura por plataforma.

🔴 **A permissão do navegador só pode ser pedida dentro de um gesto do usuário**, e
**uma recusa é praticamente definitiva** (o navegador passa a bloquear silenciosamente).
Pedir no carregamento da página queima a única chance. Tem que haver um passo de
contexto antes — explicar o valor, e só então pedir.

🔴 **O app motorista é exclusivo do grupo Movee** (ver `CLAUDE.md` §Regras de domínio):
grupo = empresa `id=6` **+ filiais**, resolvido por `mesmoGrupoQue(idEmpresa, 6, cache)`,
**nunca** `id_empresa === 6` estrito. O escopo de quem recebe um aviso segue essa regra.

🔴 **Escopo multi-tenant e identidade sempre server-side, a partir do token** — a
assinatura se vincula ao motorista autenticado, **nunca** a um id vindo do corpo da
requisição (constitution §I-III).

🔴 **Segredos só em `/var/lib/hub_secrets/`**, fora do git. A chave privada VAPID é um
segredo de longa vida: se vazar, qualquer um envia push em nome do app.

⚠️ **Assinatura morre sozinha.** O endpoint de push expira, o usuário desinstala, o
navegador rota a chave. O serviço responde `404`/`410 Gone` — e assinatura morta que não
é removida vira fila entupida e métrica mentirosa.

⚠️ **Envio em massa não pode ser laço síncrono dentro do request.** Um aviso para toda a
base é I/O de rede multiplicado por N. Precisa de persistência + processamento em lote
com limite de concorrência, senão o primeiro aviso grande derruba o backend.

## Decisão de arquitetura — JÁ TOMADA PELO OPERADOR (2026-09-11)

🟢 **Web Push nativo (VAPID). Decidido pelo operador — não reabrir, não propor FCM.**

O raciocínio que sustentou a escolha, para quem for executar entender o porquê:
**Web Push nativo**: o app já é PWA com `serwist` (que tem suporte a push),
não acrescenta dependência de terceiro, não manda dado de motorista para fora, e cobre
Chrome/Edge/Firefox/Samsung e Safari-iOS-16.4+ com o mesmo código. FCM traria SDK,
conta Google no caminho e um segundo canal para manter — ganho real só se houvesse app
nativo, que não há.

Trocar essa decisão exige autorização explícita do operador. Se durante a execução
aparecer um impedimento técnico REAL ao Web Push nativo, **pare e devolva ao operador**
com a evidência medida — não migre para outro canal por conta própria.

## O que se quer entregar

1. **Motorista**: fluxo de ativação (contexto → permissão → assinatura), com tratamento
   honesto de iOS-não-instalado e de permissão negada; recebimento com app fechado;
   clique na notificação abre a tela certa.
2. **Equipe Moveelog**: tela no hub para criar um aviso, escolher destinatários dentro do
   escopo permitido, e **ver o que aconteceu** — quantos receberam, quantos falharam,
   quantas assinaturas morreram.
3. **Plataforma**: envio escalável, assinaturas limpas automaticamente, auditoria do que
   foi enviado e por quem.

## Segurança — tratar como requisito, não como revisão final

- Chave privada VAPID em `/var/lib/hub_secrets/`, nunca no git, nunca em log.
- Assinatura vinculada ao motorista **pelo token**, nunca pelo corpo.
- **Sem PII no payload** da notificação: o push carrega referência e texto curto; o dado
  sensível é buscado pelo app depois de aberto, já autenticado. Payload de push passa por
  um serviço de terceiro (o push service do navegador) — tratar como canal público.
- Rate limit no endpoint de assinatura e no de envio.
- RLS nas tabelas novas, no mesmo padrão das existentes.
- Assinatura revogada no logout.
- Permissão dedicada para criar/enviar aviso, no RBAC do hub.
- ⚠️ **Retenção**: um aviso e seu log de entrega dizem quem recebeu o quê e quando.
  Definir prazo de expurgo **junto com o schema**, não depois.

## Gates de qualidade (cada entrega, com números)

- `tsc --noEmit` · suíte unit do backend (baseline atual **932**) · `next build` nos dois
  frontends tocados · suíte do frontend (vitest) · E2E do hub se tocar o hub.
- Teste novo em arquivo novo **precisa** ser registrado em `package.json` — `npm test`
  lista arquivo a arquivo, sem glob. Rodar `node scripts/checar-testes-orfaos.js`.
- Nada de "passou": relatar a contagem medida.

## Restrições de processo

- **Rito do ciclo git é cláusula pétrea** (`CLAUDE.md`): branch → gates → `git add` por
  caminho explícito → commit → PR → **merge antes do deploy** → build da main com tag
  `<rótulo>-<sha7>` → deploy pelos 5 gates → **provar o bundle servido**.
- Autorização é **por etapa**: commitar, abrir PR e deployar são três permissões.
- O ambiente "homologação" **é produção**. Migration nova segue a série
  `infra/hub/migrations/NNNN_*.sql`; nunca editar migration já aplicada.
- Validar contra o ambiente isolado `hub-homolog` antes de qualquer coisa em produção.
  ⚠️ O backend de lá roda de **imagem buildada** — rebuildar antes de testar código novo
  de rota, senão o verde é do código velho.
