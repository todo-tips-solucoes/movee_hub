/**
 * adiantamento-motorista — lib/notificacao-link.ts (tasks.md 6.5.1)
 *
 * `link` de uma notificação já passa pela allowlist do backend
 * (`linkPermitidoOuNulo`, `routes/motorista-adiantamento.js`), mas o
 * contrato exige uma segunda checagem no app antes de navegar
 * (contracts/motorista-api.md §Notificações: "o app valida de novo antes
 * de navegar") — defesa em profundidade, nunca confiar cegamente no que o
 * servidor mandou (mesmo padrão de `notificacaomotorista_link_chk`/
 * `linkPermitidoOuNulo`).
 */

const PERMITIDOS = [/^\/adiantamento$/, /^\/adiantamento\/\d+$/, /^\/conta-bancaria$/, /^\/avisos\/\d+$/, /^\/repasse$/];

export function linkPermitido(link: string | null | undefined): string | null {
  if (!link) return null;
  return PERMITIDOS.some((re) => re.test(link)) ? link : null;
}
