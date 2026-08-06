// hub-shell (S3) task 2.2 — funções puras do ModuleNav: mapeamento
// módulo→rota e módulo→ícone. Nenhuma lista fixa de módulos aqui (FR-001/
// SC-001) — quem decide QUAIS módulos aparecem é o backend (`GET /me`,
// `modulos[]`); este arquivo só resolve, para um `codigo`/`icone`
// arbitrário, a rota e o componente de ícone correspondentes.
//
// Achado desta onda (grep em `infra/hub/migrations/`): a coluna
// `Modulo.icone` é `text NULL` (0003_papel_permissao_modulo.sql linha 17) e
// o seed atual (0007_seed_papeis_permissoes_modulos.sql) povoa só
// `codigo`/`nome`/`ordem` — `icone` chega `null` na prática hoje, embora o
// contrato (`data-model.md` §1) o declare como `string`. `resolveModuleIcon`
// é fail-safe (mesmo espírito do EnvBadge — CHK029): valor ausente ou não
// reconhecido cai num ícone padrão, nunca quebra a renderização.

import {
  FileCheck,
  FileUp,
  Gauge,
  LayoutDashboard,
  LayoutGrid,
  Receipt,
  ScrollText,
  Send,
  Settings,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Truck,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * Mapeamento `codigo`/`icone` (string livre, convenção observada em
 * fixtures/testes existentes: lowercase — ver
 * `contexts/hub-auth-context.test.tsx` `icone: 'truck'`) para o
 * componente lucide-react. Cobre os módulos canônicos do seed
 * (`0007_seed_papeis_permissoes_modulos.sql`), mas o mapa é só um
 * ATALHO cosmético — módulo fora do mapa cai no ícone padrão, nunca
 * é omitido do menu (a decisão de "aparecer ou não" é 100% do backend).
 */
const ICON_MAP: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  layoutdashboard: LayoutDashboard,
  motoristas: Truck,
  truck: Truck,
  faturamento: Receipt,
  receipt: Receipt,
  performance: Gauge,
  trendingup: TrendingUp,
  importacoes: FileUp,
  upload: Upload,
  envio_massa: Send,
  send: Send,
  validacao_xml: FileCheck,
  filecheck: FileCheck,
  usuarios: Users,
  users: Users,
  auditoria: ScrollText,
  shieldcheck: ShieldCheck,
  admin: Settings2,
  settings: Settings,
};

/** Ícone de fallback — módulo sem `icone` reconhecido, mas ainda visível. */
export const DEFAULT_MODULE_ICON: LucideIcon = LayoutGrid;

/**
 * Resolve o ícone do módulo em cascata: `icone` explícito → `codigo` do
 * módulo → padrão. Como `Modulo.icone` chega `null` na prática hoje (ver
 * nota acima), sem a etapa do `codigo` TODOS os módulos renderizavam o
 * `LayoutGrid` padrão e a sidebar ficava indistinguível item a item.
 * Fail-safe: nunca lança, nunca retorna `undefined`.
 */
export function resolveModuleIcon(
  icone: string | null | undefined,
  codigo?: string | null,
): LucideIcon {
  if (icone) {
    const porIcone = ICON_MAP[icone.toLowerCase()];
    if (porIcone) return porIcone;
  }
  if (codigo) {
    const porCodigo = ICON_MAP[codigo.toLowerCase()];
    if (porCodigo) return porCodigo;
  }
  return DEFAULT_MODULE_ICON;
}

/**
 * Descrição de uma linha por módulo — impeccable rodada 3, h10 "Ajuda e
 * documentação" (1/4 no critique #2: "nenhum help contextual estruturado;
 * placeholders fazem todo o trabalho pedagógico"; e, na persona do
 * recém-convidado, "cards do dashboard sem descrição").
 *
 * Mora aqui, ao lado do ícone e da rota, pelo mesmo motivo que eles: é
 * cosmético e opcional. Módulo fora do mapa simplesmente não ganha descrição
 * — nunca some do dashboard nem da navegação (a decisão de "aparecer ou não"
 * continua 100% do backend, FR-001/SC-001).
 *
 * ponytail: mapa no frontend em vez de coluna `Modulo.descricao` no contrato
 * — decidido com o operador nesta rodada, porque a alternativa exigiria
 * migration no hub, que em produção vive dentro do `chatmasterveloz` (rito
 * integral de 5 gates). Mover para o contrato quando a descrição precisar
 * variar por tenant.
 *
 * Redação: o que o operador FAZ ali, não o que a tela é. "Importe planilhas"
 * ensina; "Módulo de importações" não.
 */
const DESCRICAO_MAP: Record<string, string> = {
  dashboard: 'Ponto de partida: seus módulos liberados nesta entidade.',
  motoristas: 'Consulte a ficha do motorista, o acesso ao app e o histórico de atividades.',
  faturamento: 'Acompanhe lançamentos por competência e exporte o fechamento.',
  performance: 'Meça corridas, aceitação e tempo disponível por turno.',
  importacoes: 'Importe planilhas de movimento e acompanhe o processamento de cada carga.',
  envio_massa: 'Dispare mensagens ao motorista e acompanhe o movimento até o fechamento.',
  validacao_xml: 'Valide as NFS-e do movimento em lote e veja o que foi recusado.',
  usuarios: 'Convide pessoas, defina papéis e controle quem acessa cada módulo.',
  auditoria: 'Consulte a trilha imutável de quem fez o quê, e quando.',
  admin: 'Habilite ou desabilite módulos por entidade da plataforma.',
};

/**
 * Descrição do módulo, ou `null` quando não há uma — o chamador decide se
 * omite a linha ou usa outro texto. Nunca lança, nunca inventa.
 */
export function resolveModuleDescription(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return DESCRICAO_MAP[codigo.toLowerCase()] ?? null;
}

/**
 * Rota do módulo — convenção pura `/hub/dashboard/<codigo>` (FR-001/SC-001:
 * "sem lista fixa de módulos"). Não hardcoda nenhum `codigo` — qualquer
 * módulo futuro que o backend passe a devolver em `modulos[]` já resolve
 * para uma rota sem precisar tocar este arquivo.
 *
 * Correção retroativa (Fase 4, dec-039/dec-041): a convenção original usava
 * `/dashboard/<codigo>` sem prefixo, mas o envio-massa LEGADO já possui
 * `app/dashboard/page.tsx` + subrotas reais `app/dashboard/motoristas`,
 * `app/dashboard/configuracoes`, `app/dashboard/validacao-xml` — e o próprio
 * seed canônico de módulos do hub (`0007_seed_papeis_permissoes_modulos.sql`)
 * inclui um módulo de código `motoristas`, que colidiria letra-por-letra com
 * a rota legada. O prefixo `/hub/` isola TODA a árvore de rotas autenticadas
 * do shell da árvore do envio-massa legado (que "permanece onde está" até a
 * S8 — briefing S3), sem tocar nenhum arquivo legado.
 *
 * Correção (hub-motorista-canonico, FASE 1, FR-001/FR-002, research.md
 * Decision 1): o módulo `dashboard` (seed 0007, nome "Painel Geral") é a
 * ÚNICA exceção à convenção `/hub/dashboard/<codigo>` — a página real dele é
 * a raiz `/hub/dashboard` (`app/hub/dashboard/page.tsx`), não
 * `/hub/dashboard/dashboard` (rota inexistente → 404 antes desta correção).
 * Demais códigos mantêm a convenção pura, sem regressão.
 */
export function moduloParaRota(codigo: string): string {
  if (codigo === 'dashboard') return '/hub/dashboard';
  return `/hub/dashboard/${codigo}`;
}
