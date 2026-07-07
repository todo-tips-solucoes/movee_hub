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
  LayoutDashboard,
  LayoutGrid,
  Receipt,
  Send,
  Settings,
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
  performance: TrendingUp,
  trendingup: TrendingUp,
  importacoes: Upload,
  upload: Upload,
  envio_massa: Send,
  send: Send,
  usuarios: Users,
  users: Users,
  auditoria: ShieldCheck,
  shieldcheck: ShieldCheck,
  admin: Settings,
  settings: Settings,
};

/** Ícone de fallback — módulo sem `icone` reconhecido, mas ainda visível. */
export const DEFAULT_MODULE_ICON: LucideIcon = LayoutGrid;

/**
 * Resolve o campo `HubModulo.icone` (pode ser `null`/string desconhecida —
 * ver nota acima) para um componente lucide-react. Fail-safe: nunca lança,
 * nunca retorna `undefined`.
 */
export function resolveModuleIcon(icone: string | null | undefined): LucideIcon {
  if (!icone) return DEFAULT_MODULE_ICON;
  return ICON_MAP[icone.toLowerCase()] ?? DEFAULT_MODULE_ICON;
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
 */
export function moduloParaRota(codigo: string): string {
  return `/hub/dashboard/${codigo}`;
}
