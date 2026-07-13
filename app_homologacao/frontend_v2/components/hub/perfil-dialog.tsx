'use client';

// hub-motorista-canonico (FASE 1, task 1.3, FR-003/FR-004) — modal "Meu
// perfil": aberto a partir do `account-menu.tsx` (idioma do
// `motorista-detalhe-dialog.tsx`, hook `useXDialog` + `Dialog` Base UI),
// exibindo o `PerfilCard` (task 1.2) SEM navegar para uma página diferente
// (FR-003/SC-002). Diferente do `MotoristaDetalheDialog`, não há fetch — os
// dados já estão disponíveis via `useHubAuth()` dentro do `PerfilCard`, então
// o estado do hook é só a visibilidade do modal.
//
// Ref: docs/specs/hub-motorista-canonico/spec.md FR-003/FR-004,
// research.md Decision 2, quickstart.md Scenario 2.

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PerfilCard } from '@/components/hub/perfil-card';

/** Lógica isolada do JSX (mesmo padrão de `useMotoristaDetalheDialog`). */
export function usePerfilDialog() {
  const [open, setOpen] = useState(false);
  const abrir = () => setOpen(true);
  return { open, setOpen, abrir };
}

interface PerfilDialogProps {
  state: ReturnType<typeof usePerfilDialog>;
}

export function PerfilDialog({ state: v }: PerfilDialogProps) {
  return (
    <Dialog open={v.open} onOpenChange={v.setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Meu perfil</DialogTitle>
          <DialogDescription>Dados da sua conta no Hub de Frota.</DialogDescription>
        </DialogHeader>

        <PerfilCard />
      </DialogContent>
    </Dialog>
  );
}
