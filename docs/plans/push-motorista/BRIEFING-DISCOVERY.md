# Project Briefing: Notificações Push no App do Motorista

**Data**: 2026-09-11
**Status**: Draft
**Versão**: 1.0

---

## 1. Visão e Propósito

**O que é**: nova frente dentro do projeto `envioMassa_homologacao` (hub de gestão de
frota Movee, já em produção com múltiplas features anteriores). A equipe Moveelog cria
um **aviso** no hub e o motorista recebe em **tempo real** no celular, no app PWA
(`frontend_motorista`), **mesmo com o app fechado**.

**Problema que resolve**: hoje não existe nenhum canal ativo hub → motorista. A equipe
precisa comunicar avisos e o motorista só descobre se abrir o app por conta própria.
[inferido — os exemplos de aviso ("mudança de rota, aviso de pagamento, comunicado
geral") não constam da fonte e não são requisito]

**Proposta de valor**: comunicação em tempo real com a base de motoristas usando a
infraestrutura PWA já existente. [inferido — a comparação com SMS/WhatsApp não consta
da fonte]

## 2. Usuários e Stakeholders

| Ator | Papel | Ações Principais |
|------|-------|-----------------|
| Motorista | Usuário final do PWA | Ativa notificações (contexto → permissão → assinatura), recebe aviso com app fechado, toca na notificação e é levado à tela correta |
| Equipe Moveelog (hub) | Operador do canal | Cria aviso, escolhe destinatários dentro do escopo permitido (RBAC), acompanha resultado da entrega (recebidos/falhados/assinaturas mortas) |

**Stakeholders de decisão**: operador do projeto (dono do produto e da infraestrutura
`VPSTodo`); decisão de canal (Web Push nativo/VAPID) já tomada e não está em aberto
nesta frente.

## 3. Escopo

### MVP (Essencial)

1. Fluxo de ativação no app motorista: passo de **contexto** antes do gesto do usuário
   (explicar valor), então pedir permissão do navegador, então assinar (subscription
   Web Push) vinculada ao motorista autenticado via token — nunca por id do corpo.
   Tratamento honesto de dois caminhos de recusa: iOS sem o PWA instalado na tela de
   início (push não existe nesse caso — Safari/iOS 16.4+ só entrega a app instalado) e
   permissão negada pelo navegador (recusa é quase definitiva; não insistir).
2. Recebimento em tempo real com o app fechado; clique na notificação abre a tela certa
   dentro do PWA.
3. Tela no hub (RBAC dedicado) para a equipe: criar aviso, escolher destinatários dentro
   do escopo permitido (grupo Movee, via `mesmoGrupoQue(idEmpresa, 6, cache)` — nunca
   `id_empresa === 6` estrito), disparar o envio.
4. Painel de resultado da entrega: quantos receberam, quantos falharam, quantas
   assinaturas foram identificadas como mortas (404/410) e removidas.
5. Envio escalável: persistência do aviso + processamento em lote com concorrência
   limitada (nunca laço síncrono dentro do request — um aviso para toda a base é I/O de
   rede multiplicado por N).
6. Limpeza automática de assinatura morta (o navegador/OS pode revogar a chave a
   qualquer momento; o endpoint de push responde 404/410 e a assinatura correspondente
   deve ser removida, senão vira fila entupida e métrica mentirosa).
7. Auditoria: quem criou/enviou qual aviso, quando, para qual escopo.
8. Schema novo com RLS (mesmo padrão das tabelas existentes do hub) e retenção do log de
   entrega definida junto com o schema (não depois).

### Pós-MVP (Desejável)

[inferido — NÃO consta da fonte; nenhum item abaixo é requisito nem escopo desta frente]

1. Segmentação mais fina de destinatários (além do escopo de grupo/empresa).
2. Reenvio seletivo para assinaturas que falharam por motivo transitório.
3. Templates de aviso reutilizáveis.

### Fora de Escopo

- FCM/push nativo de app store — decisão já tomada pelo operador: Web Push nativo
  (VAPID). Não reabrir essa decisão nesta frente.
- Qualquer canal de notificação fora do PWA. [inferido — a lista SMS/WhatsApp/e-mail
  não consta da fonte]
- Retenção de PII no payload do push — o payload é curto e sem dado sensível; o dado
  sensível é buscado pelo app depois de aberto, já autenticado.

## 4. Prioridades e Trade-offs

**Ordem de prioridade**: Segurança/isolamento multi-tenant > corretude do fluxo de
ativação (honestidade com o usuário sobre iOS/permissão negada) > escalabilidade do
envio > abrangência de segmentação de destinatários.

**Decisões explícitas**:
- Web Push nativo (VAPID) é definitivo para esta frente; impedimento técnico real deve
  ser medido e devolvido ao operador, nunca decidido por troca de canal autônoma.
- Validar sempre primeiro no ambiente isolado `hub-homolog` (não é produção); o
  ambiente chamado "homologação" no `VPSTodo` é produção real de clientes — nenhuma
  escrita ali sem os 5 gates do rito de produção do `CLAUDE.md`.
- Retenção do log de entrega decidida junto com o desenho do schema, não como reforma
  posterior.

## 5. Restrições

| Restrição | Valor | Notas |
|-----------|-------|-------|
| Prazo | Não definido nesta frente | [inferido — não mencionado na fonte] |
| Equipe | Agente autônomo (agente-00C) + operador humano nos gates de commit/PR/deploy | Autorização é por etapa: commit, PR e deploy são 3 permissões distintas, nenhuma concedida nesta execução |
| Budget | Não definido | [inferido — não mencionado na fonte] |
| Técnica | iOS só entrega push a PWA instalado na tela de início (Safari 16.4+, sem contorno); permissão do navegador só pode ser pedida dentro de gesto do usuário, recusa é quase definitiva; escopo multi-tenant sempre server-side a partir do token; chave privada VAPID só em `/var/lib/hub_secrets/`, nunca git/log; sem PII no payload (trafega por serviço de terceiro); migration nova segue a série `infra/hub/migrations/NNNN_*.sql` | Ver `docs/plans/push-motorista/BRIEFING-PUSH-MOTORISTA.md` para a medição completa |

## 6. Stack Técnica

| Camada | Tecnologia | Justificativa |
|--------|-----------|---------------|
| Backend | Express (`app_homologacao/backend`, Node 20-alpine via `Dockerfile.hub`) | Já existente; endpoints de assinatura/envio/gestão de avisos entram aqui |
| Push | Web Push nativo (VAPID) | Decisão do operador; já suportado pelo `serwist` do PWA, sem SDK de terceiro, sem dado saindo para FCM |
| Service Worker | `@serwist/next` (`frontend_motorista/app/sw.ts`) | Precisa ganhar handler `push` + `notificationclick`; hoje só faz cache |
| Frontend motorista | Next.js PWA (`frontend_motorista`) | Fluxo de ativação (contexto/permissão/assinatura) |
| Frontend hub | Next.js (`frontend_v2/app/hub/*`) | Tela de criação de aviso + painel de resultado |
| Persistência | PostgREST sobre `chatmasterveloz` (schema do hub) | Padrão já usado por todo o hub; tabelas novas de Aviso/Assinatura/LogEntrega com RLS |
| Auth | JWT em cookies httpOnly (`routes/motorista.js`, `authenticateMotorista`) | Assinatura de push vinculada ao motorista pelo token, nunca por id do corpo |
| RBAC | `Modulo`/`Permissao`/`PapelPermissao`/`ModuloEntidade` do hub | Nova permissão dedicada para criar/enviar aviso |

## 7. Qualidade e Padrões

**Padrões adotados**:
- Gates com números medidos, nunca "passou": `tsc --noEmit`, suíte unit do backend
  (baseline atual **932** testes — medir a nova contagem após as tarefas), `next build`
  nos dois frontends tocados, suíte `vitest` do frontend, E2E do hub se a mudança tocar
  o hub.
- Teste novo em arquivo novo precisa ser registrado em `package.json` (o `npm test` lista
  arquivo a arquivo, sem glob) + rodar `node scripts/checar-testes-orfaos.js`.
- Rito do ciclo git como cláusula pétrea: branch dedicada → gates verdes com números →
  `git add` por caminho explícito (nunca `-A`/`.`) → commit → PR → merge antes do deploy
  → build da main com tag `<rótulo>-<sha7>` → deploy pelos 5 gates de produção → provar
  o bundle servido.
- Validar sempre no ambiente isolado `hub-homolog` primeiro (rebuildar a imagem do
  backend antes de testar rota nova, senão o verde é do código antigo).

**Compliance**: nenhum framework formal (LGPD não citado explicitamente na fonte), mas
tratamento de dado sensível já é regra do projeto: sem PII no payload do push, segredo
VAPID fora do git, escopo multi-tenant resolvido sempre server-side.

## 8. Visão de Futuro

**6 meses**: canal de push em operação estável, com métrica de cobertura por
plataforma (iOS instalado vs não-instalado, Android/desktop) e taxa de entrega
monitorada.

**12 meses**: [não coberto pela fonte — a definir]

**Riscos conhecidos**:
- iOS sem instalação do PWA é uma fatia da base que a feature simplesmente não alcança
  — precisa ser tratado como parte do produto (fluxo de instalação), não só como
  detalhe técnico.
- Recusa de permissão do navegador é quase irreversível; pedir cedo demais (sem
  contexto) queima a chance definitivamente.
- Envio para toda a base é I/O multiplicado por N; sem lote com concorrência limitada,
  o primeiro aviso grande pode derrubar o backend.
- Assinatura morta não removida automaticamente vira fila entupida e métrica
  mentirosa de entrega.

---

## Itens a Definir

| Item | Dimensão | Impacto |
|------|----------|---------|
| Prazo/janela de entrega desta frente | Restrições | Médio |
| Prazo de expurgo (retenção) do log de entrega | Qualidade / Restrições | Alto — decidido junto com o schema, mas o valor numérico ainda não foi fixado |
| Evolução em 12 meses | Visão de Futuro | Baixo |

---

**Próximo passo recomendado**: `/constitution` para verificar/atualizar principios de
governança — este projeto já tem `docs/constitution.md` (global, v1.x com amendments);
seguir o protocolo de pré-flight de conflito raiz-vs-feature antes de qualquer escrita
nele.
