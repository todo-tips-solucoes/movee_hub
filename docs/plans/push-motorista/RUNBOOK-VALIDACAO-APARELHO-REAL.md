# Runbook: validação em aparelho real (Scenario 21, SC-003)

Roteiro para o **operador** executar manualmente o cenário 21 do
`docs/specs/envioMassa_homologacao/quickstart.md`. Não é executável pela
pipeline autônoma (agente-00c) — exige aparelho físico e uma origem HTTPS
alcançável pelo celular. tasks.md 9.6.3.

## Pré-condições

- Build de produção do backend + frontend_motorista com o código desta feature
  já mergeado (o PWA precisa do Service Worker real — `next build && next
  start`, não `next dev`).
- Chave VAPID de **teste** (nunca a de produção — ver restrição abaixo) gerada
  via `infra/hub/scripts/gen-vapid.sh`.
- 1 motorista de teste com conta ativa, cadastrado no grupo Movee.
- Celular Android (Chrome) e iPhone (Safari, iOS 16.4+) na mesma rede ou com
  acesso à origem escolhida.

## Origem HTTPS — decisão do operador (nenhuma opção pré-escolhida)

O app precisa ser servido por HTTPS com certificado confiável pelo celular
(Service Worker e Web Push não funcionam em HTTP nem com certificado
autoassinado não instalado no aparelho). Três opções, cada uma com trade-offs
— o agente **não escolhe por conta própria** (é uma decisão estrutural de
ambiente, classe `ambiente-alvo`):

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **Túnel autenticado para hub-homolog** (ex.: Cloudflare Tunnel, ngrok com auth) apontando para `infra/hub` local/hub-homolog | `ngrok http https://localhost:8443` (ou similar) sobre o compose do hub-homolog | Isolado do cliente real; nenhum rito de produção envolvido; rápido de montar/desmontar | URL efêmera/rotativa; exige reconfigurar `NEXT_PUBLIC_VAPID_PUBLIC_KEY`/CORS a cada sessão de teste; alguém precisa manter o túnel no ar durante o teste |
| **Janela em produção sob o rito de 5 gates** (`app.moveelog.com.br` real, com a chave VAPID de teste isolada de qualquer aviso real) | Deploy controlado seguindo os 5 gates do `CLAUDE.md` (autorização explícita, janela combinada, rollback à mão, `docker service update`, smoke test) | Origem estável, sem dependência de túnel; mesma infra que o cliente usa (validação mais fiel) | É produção — qualquer engano afeta clientes reais; exige TODOS os gates, inclusive janela combinada e autorização explícita **por esta mudança específica** |
| **Ambiente hub-homolog com domínio próprio + certificado real** (subdomínio dedicado, ex. `homolog-push.moveelog.com.br`, com Let's Encrypt) | Provisionar DNS + Traefik/certificado dedicado para hub-homolog | Estável, reutilizável para futuras validações de push; sem tocar produção | Trabalho de infra adicional (DNS, cert, Traefik) só para este teste; ninguém revisou o custo/benefício ainda |

**Nenhuma das três é executada por este runbook** — o operador escolhe e, se a
opção 2 for escolhida, os 5 gates do rito de produção (`CLAUDE.md`) se aplicam
integralmente, sem exceção.

## Passo a passo (após a origem estar decidida e no ar)

1. Instalar o PWA no Android (Chrome: "Adicionar à tela inicial") e no iPhone
   (Safari: "Adicionar à Tela de Início", exige iOS 16.4+).
2. Fazer login com o motorista de teste em cada aparelho.
3. Ativar as notificações (gesto explícito — tocar em "Ativar").
4. Fechar completamente o app (não deixar em segundo plano).
5. Disparar **20 avisos de teste** pelo hub (modo `individual`, visando este
   motorista) — nunca por `toda_base` num ambiente com usuários reais.
6. Cronometrar cada notificação recebida.

## Critério de aceite (SC-003)

- Notificação exibida em **≤ 1 min** em **≥ 95%** das entregas com
  `status='aceito'` no banco (19 de 20, no mínimo).
- Tocar na notificação abre `/avisos/:id` correto em cada aparelho.
- Registrar os **hosts de endpoint observados** (ex.: `fcm.googleapis.com` no
  Android, `*.push.apple.com` no iPhone) — usados para validar/ajustar a
  allowlist real de produção (`ALLOWLIST_PADRAO` em
  `app_homologacao/backend/lib/hub-push-endpoint.js`, research.md Decision 10).

## Restrições (não negociáveis)

- **Nunca gerar ou usar a chave VAPID de produção nesta validação** — sempre
  `gen-vapid.sh` para uma chave de teste isolada.
- **Nunca disparar em `toda_base`** durante este teste — sempre `individual`
  visando apenas a conta de teste.
- Se a opção 2 (produção) for escolhida: todos os 5 gates do rito de produção
  do `CLAUDE.md` se aplicam, sem exceção, e a autorização é específica para
  esta janela de teste — não vale autorização antiga/genérica.
