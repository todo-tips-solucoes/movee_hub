'use client';

/**
 * Tela /dashboard/configuracoes/grupo
 * Gerenciamento de empresas filhas do grupo de CNPJs.
 *
 * Feature: config-ui-tenant
 * Ref: docs/specs/config-ui-tenant/contracts/grupo-api.md
 *      docs/specs/config-ui-tenant/spec.md US-002
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/auth-context';

interface EmpresaFilha {
  id: number;
  nome_empresa: string;
  email?: string;
}

export default function GrupoPage() {
  const { user } = useAuth();
  const isGrupoPai = (user as any)?.is_grupo_pai === true;

  const [filhos, setFilhos] = useState<EmpresaFilha[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  // Vincular novo filho
  const [empresaIdFilho, setEmpresaIdFilho] = useState('');
  const [vinculando, setVinculando] = useState(false);
  const [vinculoErro, setVinculoErro] = useState<string | null>(null);
  const [vinculoSucesso, setVinculoSucesso] = useState(false);

  const carregarFilhos = useCallback(async () => {
    if (!isGrupoPai) { setLoading(false); return; }
    setLoading(true);
    setErro(null);
    try {
      const res = await fetch('/api/grupo/filhos', { credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErro(data.error || 'Erro ao carregar filhos.');
        return;
      }
      const data = await res.json();
      setFilhos(data.filhos || []);
    } catch {
      setErro('Erro de comunicação com o servidor.');
    } finally {
      setLoading(false);
    }
  }, [isGrupoPai]);

  useEffect(() => { carregarFilhos(); }, [carregarFilhos]);

  const handleVincular = async () => {
    setVinculoErro(null);
    setVinculoSucesso(false);
    const id = parseInt(empresaIdFilho, 10);
    if (!Number.isInteger(id) || id <= 0) {
      setVinculoErro('Informe um ID de empresa válido (número inteiro).');
      return;
    }
    setVinculando(true);
    try {
      const res = await fetch('/api/grupo/filhos', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa_id_filho: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVinculoErro(data.error || 'Erro ao vincular empresa.');
        return;
      }
      setVinculoSucesso(true);
      setEmpresaIdFilho('');
      await carregarFilhos();
    } catch {
      setVinculoErro('Erro de comunicação com o servidor.');
    } finally {
      setVinculando(false);
    }
  };

  const handleDesvincular = async (idFilho: number) => {
    if (!confirm('Tem certeza que deseja desvincular esta empresa do grupo?')) return;
    try {
      const res = await fetch(`/api/grupo/filhos/${idFilho}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Erro ao desvincular empresa.');
        return;
      }
      await carregarFilhos();
    } catch {
      alert('Erro de comunicação com o servidor.');
    }
  };

  if (!isGrupoPai) {
    return (
      <div className="max-w-xl mx-auto mt-8 p-6 rounded-lg border bg-card text-card-foreground">
        <h1 className="font-display text-xl font-semibold mb-2">Grupo de CNPJs</h1>
        <p className="text-muted-foreground text-sm">
          O gerenciamento de filhos está disponível apenas para o administrador do grupo.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Grupo de CNPJs</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Vincule e gerencie as empresas filhas do seu grupo. Máximo de 100 filhos.
        </p>
      </div>

      {/* Vincular nova empresa */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h2 className="text-base font-semibold">Vincular empresa filha</h2>
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[180px] space-y-1">
            <label className="text-sm font-medium" htmlFor="empresa_id">
              ID da empresa
            </label>
            <input
              id="empresa_id"
              type="number"
              min={1}
              value={empresaIdFilho}
              onChange={e => setEmpresaIdFilho(e.target.value)}
              placeholder="Ex: 42"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={handleVincular}
            disabled={vinculando || !empresaIdFilho}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors h-9"
          >
            {vinculando ? 'Vinculando…' : 'Vincular'}
          </button>
        </div>
        {vinculoErro && (
          <p className="text-sm text-destructive">{vinculoErro}</p>
        )}
        {vinculoSucesso && (
          <p className="text-sm text-success">Empresa vinculada com sucesso.</p>
        )}
      </div>

      {/* Lista de filhos */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">
          Empresas filhas{' '}
          <span className="ml-1 text-muted-foreground text-sm font-normal">
            ({filhos.length}/100)
          </span>
        </h2>

        {loading && (
          <div className="flex justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        )}

        {!loading && erro && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {erro}
          </div>
        )}

        {!loading && !erro && filhos.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nenhuma empresa filha vinculada ainda.
          </p>
        )}

        {!loading && filhos.length > 0 && (
          <div className="rounded-lg border divide-y divide-border overflow-hidden">
            {filhos.map(f => (
              <div key={f.id} className="flex items-center justify-between px-4 py-3 bg-card hover:bg-muted/50 transition-colors">
                <div>
                  <p className="text-sm font-medium">{f.nome_empresa}</p>
                  <p className="text-xs text-muted-foreground">ID: <span className="tabular">{f.id}</span>{f.email ? ` · ${f.email}` : ''}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDesvincular(f.id)}
                  className="text-xs text-destructive hover:underline ml-4"
                >
                  Desvincular
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
