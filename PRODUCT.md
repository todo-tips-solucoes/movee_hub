# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Operador de empresa (painel/hub)**: funcionário de logística de um tenant (Movee e
  suas empresas clientes) que importa planilhas de movimentos, dispara e acompanha
  envios em massa, fecha movimentos e — no hub de frota — gere motoristas, importações,
  faturamento, performance, usuários e papéis. Autentica por e-mail + senha; dados
  escopados por `id_empresa` resolvida do token. Papéis com permissões distintas
  (ex.: `admin_entidade`, `operador`) controlam o que cada um vê e faz.
- **Motorista (prestador de serviço)**: acessa pelo celular o PWA
  (`app.motorista.moveelog.com.br`) para consultar o movimento aberto e validar sua
  NFS-e em XML. Login por CNPJ do prestador; exclusivo do grupo Movee (empresa 6 +
  filiais).
- **Operação/Infra**: mantém os serviços Docker Swarm na VPS atrás do Traefik;
  executa deploys e mudanças de produção sob o rito de 5 gates.

## Product Purpose

Plataforma de gestão de frota e automação fiscal para transportadoras: automatiza o
envio em massa de mensagens/documentos fiscais a motoristas, gere movimentos de
pagamento de prestadores e — via hub de frota — oferece módulos de gestão
(motoristas, importações, faturamento, performance, administração) sobre a mesma base
autenticada. Sucesso = a operação da empresa fecha seus ciclos de pagamento e
validação fiscal sem trabalho manual planilha-a-planilha, com isolamento total entre
tenants.

## Positioning

Integra num só produto o disparo em massa (via n8n/WhatsApp), a validação automática
de NFS-e (FastAPI que casa o XML com o movimento do prestador) e a gestão modular de
frota multi-tenant — com o motorista fechando o ciclo pelo próprio celular. Um
concorrente genérico de disparo de mensagens não valida a nota contra o movimento; um
ERP de frota não fecha o loop com o motorista via PWA.

## Operating Context

- Dois produtos no mesmo backend/frontend: o **envio em massa legado**
  (`app/{login,dashboard,…}`) e o **hub de frota** (`app/hub/*`), servidos pelo mesmo
  Next.js. **Direção confirmada (2026-08-05): o hub é o futuro** — vai absorver o
  painel legado com o tempo; o legado recebe só manutenção. Investimento de design
  concentra-se no hub.
- O ambiente chamado "homologação" **é produção** — clientes reais em
  `https://app.moveelog.com.br`. Todo trabalho visual entregue ali atinge usuários
  imediatamente; deploys seguem o rito de produção (5 gates) executado pelo operador.
- Fluxo típico do operador: importar planilha de movimento → conferir/ajustar →
  disparar envio em massa → acompanhar validação das notas → fechar movimento. No hub:
  navegar módulos conforme permissão do papel.
- Uso em desktop no dia a dia da operação; painel e hub são responsivos (trabalho de
  responsividade validado em celular). O app motorista é mobile-first (PWA instalável).

## Capabilities and Constraints

- Multi-tenant NON-NEGOTIABLE: escopo sempre resolvido server-side do token, nunca do
  corpo da requisição (constitution §II). RBAC por papéis no hub com auditoria.
- Auth por JWT em cookies httpOnly via proxy `/api/*`; o browser nunca chama o backend
  direto (constitution §I e §III).
- Stack de UI vigente: Next.js App Router + React + TypeScript + Tailwind 4 +
  **Base UI** (`@base-ui/react`, não Radix) + shadcn. Novas superfícies reaproveitam
  essa stack.
- Idioma do produto: **português (pt-BR)** em toda a UI, mensagens de erro incluídas.
- Terminologia do domínio: *movimento* (ciclo de pagamento), *prestador/motorista*,
  *envio em massa*, *validação de NFS-e*, *tenant/empresa*, *filial*, *grupo de
  CNPJs*, *módulos* e *papéis* (hub).
- Restrição operacional: builds pesados no host de produção seguem rito
  anti-starvation (swap + `--memory=2g`).

## Brand Commitments

- **Movee** é a identidade base do painel e do hub (design system Movee v2 já
  implementado); domínio `moveelog.com.br`. Assets em `docs/brand/`.
- **White-label por tenant** (feature config-ui-tenant): tenants podem sobrepor
  logo/cores à base Movee — o design do painel/hub precisa tolerar essa
  parametrização sem quebrar.
- **EntreGô** é a identidade exclusiva do app motorista (PWA); logos e ícones em
  `docs/brand/EntreGo-Logo-Icones/`.

## Evidence on Hand

- Produto em produção com clientes reais e dados reais — nenhum conteúdo de
  demonstração precisa ser inventado; telas trabalham com dados verdadeiros dos
  tenants.
- Assets de marca reais: `docs/brand/` (Movee: `img_movee.jpg`, tipografia/cores em
  `img_tipo_cores*.jpg`; EntreGô: pacote completo de logo/favicon/app-icon).
- Evidências visuais de entregas anteriores em `docs/plans/*/evidencias/`
  (screenshots de estados reais do hub).
- Não existem depoimentos, casos de sucesso ou métricas de marketing registrados —
  trabalho futuro não deve fabricá-los.

## Product Principles

1. **Isolamento de tenant acima de tudo** — nenhuma conveniência de UX justifica vazar
   dados ou escopo entre empresas.
2. **O hub é o destino** — features e refinamentos novos nascem no hub; o legado só
   recebe correção, até ser absorvido.
3. **Fechar o ciclo, não só disparar** — o valor está em levar o movimento do import à
   nota validada e ao fechamento, incluindo o motorista no celular.
4. **Produção é sagrada** — entregar artefatos prontos (código, PR, runbook); escrita
   no ambiente vivo só pelo rito de 5 gates.
5. **Reuso da base comum** — auth, proxy de cookies, PostgREST, componentes e deploy
   existentes antes de qualquer stack paralela.

## Accessibility & Inclusion

Compromisso confirmado (2026-08-05): **WCAG 2.1 AA** — contraste, foco visível,
navegação completa por teclado e ARIA correto, validados com axe nas entregas de UI.
Dark e light mode suportados no painel/hub.
