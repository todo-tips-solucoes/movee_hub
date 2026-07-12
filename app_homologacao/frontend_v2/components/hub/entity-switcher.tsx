'use client';

// hub-shell (S3) task 3.1 — EntitySwitcher: evolui o padrão UX de
// `components/empresa-selector.tsx` (legado do envio-massa, NÃO tocado —
// FR-018/SC-007) para o domínio do hub: consome `entidades[]`/`entidadeAtiva`
// do `HubAuthProvider` e troca via `POST /me/entidade` (`trocarEntidade`), que
// já recarrega todo o contexto (`refetchMe`) em caso de sucesso
// (contexts/hub-auth-context.tsx).
//
// Achado desta onda: o contrato `GET /me` (hub-me.js) NÃO inclui o nome da
// empresa em `entidades[]` — só `{empresaId, papel, ativo}` (a tabela
// "Empresa" mora FORA do banco do hub — FK lógica, ver
// infra/hub/migrations/0008_migracao_empresa_para_usuario.sql linhas 1-22).
// Por dec-010 (fronteira desta fase: sem novo dado/endpoint de backend), o
// rótulo exibido é "Empresa #<id>" + papel, sem nome amigável — decisão
// auditável registrada no runtime (Decisão "rótulo de entidade sem nome
// amigável").
//
// Ref: docs/specs/hub-shell/plan.md §3.2, data-model.md §2,
// spec.md FR-005/FR-006/FR-007.

import { useCallback, useId, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Loader2 } from 'lucide-react';
import { useHubAuth, HubApiError } from '@/contexts/hub-auth-context';
import type { HubVinculo } from '@/lib/hub/me-dto';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** Rótulo exibido para um vínculo — ver nota acima sobre ausência de nome. */
export function labelVinculo(v: HubVinculo): string {
  return v.papel ? `Empresa #${v.empresaId} — ${v.papel}` : `Empresa #${v.empresaId}`;
}

/**
 * Lógica de troca de entidade, isolada do componente visual — testável sem
 * precisar simular a interação real do `Select` (Base UI, portal/positioner)
 * em jsdom. Mesmo espírito de `useModuleNavItems` em `module-nav.tsx`.
 */
export function useEntitySwitcher() {
  const { entidades, entidadeAtiva, trocarEntidade } = useHubAuth();
  const [trocando, setTrocando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');

  const items = entidades.map((e) => ({ value: String(e.empresaId), label: labelVinculo(e) }));
  const value = entidadeAtiva !== null ? String(entidadeAtiva) : '';

  const handleChange = useCallback(
    async (v: string | null) => {
      if (v === null) return;
      const empresaId = Number(v);
      if (!Number.isInteger(empresaId) || empresaId === entidadeAtiva) return;
      setTrocando(true);
      setErro(null);
      try {
        // FR-005/FR-007: trocarEntidade() chama POST /me/entidade e, em
        // sucesso, refetchMe() recarrega TODO o contexto (nada é atualizado
        // aqui manualmente — a fonte da verdade é sempre o /me).
        await trocarEntidade(empresaId);
        const alvo = entidades.find((e) => e.empresaId === empresaId);
        const mensagem = alvo
          ? `${labelVinculo(alvo)} selecionada. Dados recarregados.`
          : 'Entidade selecionada. Dados recarregados.';
        setLiveMessage(mensagem);
        // uiux-hub F3: feedback VISUAL complementando o aria-live — antes a
        // única pista para quem enxerga era a troca silenciosa dos dados.
        toast.success(mensagem);
      } catch (e) {
        // FR-006: 400 EMPRESA_ID_INVALIDO / 403 SEM_VINCULO — trocarEntidade
        // só chama refetchMe() em sucesso (hub-auth-context.tsx), então `me`
        // (e portanto `entidadeAtiva`) já preserva o valor anterior aqui; não
        // há necessidade de reverter estado manualmente.
        setErro(
          e instanceof HubApiError
            ? e.message
            : 'Não foi possível trocar de entidade. Tente novamente.'
        );
      } finally {
        setTrocando(false);
      }
    },
    [entidades, entidadeAtiva, trocarEntidade]
  );

  return { entidades, items, value, trocando, erro, liveMessage, handleChange };
}

export interface EntitySwitcherProps {
  className?: string;
}

export function EntitySwitcher({ className }: EntitySwitcherProps) {
  const { entidades, items, value, trocando, erro, liveMessage, handleChange } =
    useEntitySwitcher();
  const liveRegionId = useId();

  // Nada a trocar com 0 ou 1 vínculo (FR-005 pressupõe pelo menos 2 opções) —
  // mesmo espírito de ModuleNav (modulos.length === 0 -> null).
  if (entidades.length < 2) return null;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor="entity-switcher-trigger" className="text-sm font-semibold text-foreground">
        Entidade
      </label>

      <Select items={items} value={value} onValueChange={handleChange} disabled={trocando}>
        <SelectTrigger
          id="entity-switcher-trigger"
          aria-label="Trocar entidade de trabalho"
          className="w-full sm:w-[240px]"
        >
          {trocando ? (
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-muted-foreground" aria-hidden="true" />
          ) : (
            <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <SelectValue placeholder="Selecionar entidade" />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Erro de troca (FR-006) — mesmo padrão visual de empresa-selector.tsx:
          bg-destructive/10 eleva o contraste efetivo do texto destructive
          (WCAG AA, CHK013). */}
      {erro && (
        <p
          role="alert"
          className="mt-1 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive"
        >
          {erro}
        </p>
      )}

      {/* Região aria-live — anúncio de troca bem-sucedida independente do
          portal do Select (mesmo padrão de empresa-selector.tsx). */}
      <span id={liveRegionId} aria-live="polite" aria-atomic="true" className="sr-only">
        {liveMessage}
      </span>
    </div>
  );
}

export default EntitySwitcher;
