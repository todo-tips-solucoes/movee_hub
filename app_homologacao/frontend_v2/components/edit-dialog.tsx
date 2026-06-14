'use client';

import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EnvioMassa } from '@/types';
import { toast } from 'sonner';

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: EnvioMassa | null;
  onSave: (id: number, data: Record<string, unknown>) => Promise<void>;
}

export function EditDialog({ open, onOpenChange, record, onSave }: EditDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    number: '',
    nome: '',
    valor: '',
    cnpj_tomador: '',
    cnpj_prestador: '',
    mensagem1: '',
    mensagem2: '',
  });

  useEffect(() => {
    if (record) {
      setForm({
        number: record.number || '',
        nome: record.nome || '',
        valor: String(record.valor || ''),
        cnpj_tomador: record.cnpj_tomador || '',
        cnpj_prestador: record.cnpj_prestador || '',
        mensagem1: record.mensagem1 || '',
        mensagem2: record.mensagem2 || '',
      });
    }
  }, [record]);

  // Reseta a confirmação visual sempre que o diálogo (re)abre
  useEffect(() => {
    if (open) setSaved(false);
  }, [open]);

  const handleSave = async () => {
    if (!record) return;
    try {
      setLoading(true);
      await onSave(record.id, form);
      toast.success('Registro atualizado com sucesso!');
      // Confirmação visual breve antes de fechar (U011)
      setSaved(true);
      setTimeout(() => onOpenChange(false), 900);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atualizar registro');
    } finally {
      setLoading(false);
    }
  };

  const fields = [
    { key: 'number', label: 'Numero' },
    { key: 'nome', label: 'Nome' },
    { key: 'valor', label: 'Valor' },
    { key: 'cnpj_tomador', label: 'CNPJ Tomador' },
    { key: 'cnpj_prestador', label: 'CNPJ Prestador' },
    { key: 'mensagem1', label: 'Mensagem 1' },
    { key: 'mensagem2', label: 'Mensagem 2' },
  ] as const;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* R003: largura mobile explícita (sem scroll horizontal); scroll interno já no body */}
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-md">
        <AnimatePresence>
          {saved && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[inherit] bg-card/95 backdrop-blur-sm"
              role="status"
              aria-live="polite"
            >
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 300, damping: 18 }}
              >
                <CheckCircle2 className="h-12 w-12 text-success" aria-hidden="true" />
              </motion.div>
              <p className="text-sm font-medium">Registro atualizado</p>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHeader>
          <DialogTitle>
            {record?.nome ? `Editar “${record.nome}”` : 'Editar registro'}
          </DialogTitle>
          <DialogDescription>
            {record?.number
              ? `Atualize os dados do registro nº ${record.number}.`
              : 'Atualize os dados do registro selecionado.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-4 max-h-[60vh] overflow-y-auto pr-1">
          {fields.map(({ key, label }) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={key} className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</Label>
              <Input
                id={key}
                value={form[key]}
                onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                className="h-11 sm:h-9 md:h-8"
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading || saved}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={loading || saved}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
