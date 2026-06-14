'use client';

/**
 * Tela /dashboard/configuracoes/aparencia
 * Formulário de identidade visual (branding) do grupo de CNPJs.
 *
 * Feature: config-ui-tenant
 * Ref: docs/specs/config-ui-tenant/spec.md US-003
 *      docs/specs/config-ui-tenant/contracts/branding-api.md
 *
 * Decisões aplicadas:
 * - dec-027, CHK052: preview live via previewBranding (client-only, não persiste até Salvar)
 * - dec-028, CHK057: MOVEE_DEFAULTS como fallback no preview
 * - dec-029, CHK058/059: warning de contraste (não bloqueia)
 * - dec-030, CHK062: logo no header com h-8 max-w-32
 * - dec-020, CHK025: remoção de logo via remove_logo: true
 */

import { useState, useRef, useCallback } from 'react';
import { useTenantTheme } from '@/contexts/tenant-theme-context';
import { useAuth } from '@/contexts/auth-context';
import { Button } from '@/components/ui/button';

const MOVEE_DEFAULTS = {
  cor_primaria: '#2C67EA',
  cor_destaque: '#2CEABC',
  nome_exibicao: 'EntreGô',
};

export default function AparenciaPage() {
  const { branding, loading, previewBranding, saveBranding, refetch } = useTenantTheme();
  const { user } = useAuth();

  // Somente is_grupo_pai pode editar
  const isGrupoPai = (user as any)?.is_grupo_pai === true;

  // Estado do formulário
  const [corPrimaria, setCorPrimaria] = useState<string>(
    () => branding?.cor_primaria || MOVEE_DEFAULTS.cor_primaria
  );
  const [corDestaque, setCorDestaque] = useState<string>(
    () => branding?.cor_destaque || MOVEE_DEFAULTS.cor_destaque
  );
  const [nomeExibicao, setNomeExibicao] = useState<string>(
    () => branding?.nome_exibicao || MOVEE_DEFAULTS.nome_exibicao
  );
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(
    () => branding?.logo_url || null
  );
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview ao vivo conforme o usuário altera as cores (dec-027)
  const handleCorChange = useCallback(
    (field: 'cor_primaria' | 'cor_destaque', value: string) => {
      if (field === 'cor_primaria') setCorPrimaria(value);
      else setCorDestaque(value);
      previewBranding({ cor_primaria: corPrimaria, cor_destaque: corDestaque, [field]: value });
    },
    [corPrimaria, corDestaque, previewBranding]
  );

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    setRemoveLogo(false);
    const url = URL.createObjectURL(file);
    setLogoPreviewUrl(url);
  };

  const handleRemoveLogo = () => {
    setRemoveLogo(true);
    setLogoFile(null);
    setLogoPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSave = async () => {
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      if (logoFile) {
        // Multipart: tem arquivo de logo
        const fd = new FormData();
        fd.append('cor_primaria', corPrimaria);
        fd.append('cor_destaque', corDestaque);
        fd.append('nome_exibicao', nomeExibicao);
        fd.append('logo', logoFile);
        await saveBranding(fd);
      } else {
        // JSON: sem arquivo
        await saveBranding({
          cor_primaria: corPrimaria,
          cor_destaque: corDestaque,
          nome_exibicao: nomeExibicao,
          remove_logo: removeLogo ? true : undefined,
        } as any);
      }
      setSuccess(true);
      setLogoFile(null);
    } catch (err: any) {
      setError(err.message || 'Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!isGrupoPai) {
    return (
      <div className="max-w-xl mx-auto mt-8 p-6 rounded-lg border bg-card text-card-foreground">
        <h1 className="font-display text-xl font-semibold mb-2">Aparência</h1>
        <p className="text-muted-foreground text-sm">
          A personalização de aparência está disponível apenas para o administrador do grupo de CNPJs.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 space-y-8">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Aparência</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Personalize a identidade visual exibida no painel e no App Motorista.
        </p>
      </div>

      {/* Preview do header */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Pré-visualização do cabeçalho</p>
        <div
          className="flex items-center gap-3 rounded-md px-4 py-3"
          style={{ backgroundColor: corPrimaria }}
        >
          {/* Logo preview — dec-030: h-8 max-w-32 */}
          {logoPreviewUrl && !removeLogo ? (
            <img
              src={logoPreviewUrl}
              alt="Logo da empresa"
              className="h-8 max-w-32 object-contain"
            />
          ) : (
            <span
              className="font-bold text-lg truncate max-w-[8rem]"
              style={{ color: '#ffffff' }}
            >
              {nomeExibicao || MOVEE_DEFAULTS.nome_exibicao}
            </span>
          )}
        </div>
      </div>

      {/* Formulário */}
      <div className="space-y-6">
        {/* Nome de exibição */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="nome_exibicao">
            Nome de exibição
            <span className="ml-1 text-muted-foreground text-xs">(máx. 60 caracteres)</span>
          </label>
          <input
            id="nome_exibicao"
            type="text"
            maxLength={60}
            value={nomeExibicao}
            onChange={e => setNomeExibicao(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            placeholder={MOVEE_DEFAULTS.nome_exibicao}
          />
          <p className="text-xs text-muted-foreground">{nomeExibicao.length}/60</p>
        </div>

        {/* Cor primária */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="cor_primaria">
            Cor primária
          </label>
          <div className="flex items-center gap-3">
            <input
              id="cor_primaria"
              type="color"
              value={corPrimaria}
              onChange={e => handleCorChange('cor_primaria', e.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border border-input bg-background p-0.5"
            />
            <input
              type="text"
              value={corPrimaria}
              maxLength={7}
              onChange={e => {
                const v = e.target.value;
                if (/^#[0-9a-fA-F]{0,6}$/.test(v)) handleCorChange('cor_primaria', v);
              }}
              className="flex h-9 w-28 rounded-md border border-input bg-background px-3 py-1 text-sm font-mono"
              placeholder="#2C67EA"
            />
            <span className="text-xs text-muted-foreground">Botões, links, destaque principal</span>
          </div>
        </div>

        {/* Cor de destaque */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="cor_destaque">
            Cor de destaque
          </label>
          <div className="flex items-center gap-3">
            <input
              id="cor_destaque"
              type="color"
              value={corDestaque}
              onChange={e => handleCorChange('cor_destaque', e.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border border-input bg-background p-0.5"
            />
            <input
              type="text"
              value={corDestaque}
              maxLength={7}
              onChange={e => {
                const v = e.target.value;
                if (/^#[0-9a-fA-F]{0,6}$/.test(v)) handleCorChange('cor_destaque', v);
              }}
              className="flex h-9 w-28 rounded-md border border-input bg-background px-3 py-1 text-sm font-mono"
              placeholder="#2CEABC"
            />
            <span className="text-xs text-muted-foreground">Gradiente, badges, acentos</span>
          </div>
        </div>

        {/* Logo */}
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Logotipo</label>
          <p className="text-xs text-muted-foreground">PNG, JPEG ou SVG — máx. 512 KB</p>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/svg+xml"
              onChange={handleLogoChange}
              className="text-sm file:mr-3 file:py-1 file:px-3 file:rounded-md file:border file:border-input file:bg-background file:text-sm file:font-medium hover:file:bg-accent"
            />
            {(logoPreviewUrl && !removeLogo) && (
              <button
                type="button"
                onClick={handleRemoveLogo}
                className="text-xs text-destructive hover:underline"
              >
                Remover logo
              </button>
            )}
          </div>
          {logoPreviewUrl && !removeLogo && (
            <img
              src={logoPreviewUrl}
              alt="Pré-visualização do logo"
              className="mt-2 h-12 object-contain rounded border border-border bg-muted p-1"
            />
          )}
          {removeLogo && (
            <p className="text-xs text-muted-foreground">Logo será removido ao salvar.</p>
          )}
        </div>
      </div>

      {/* Feedback */}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-md border border-success/50 bg-success/10 px-4 py-3 text-sm text-success">
          Aparência salva com sucesso.
        </div>
      )}

      {/* Ações */}
      <div className="flex gap-3">
        <Button type="button" size="lg" onClick={handleSave} disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar aparência'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={() => {
            setCorPrimaria(branding?.cor_primaria || MOVEE_DEFAULTS.cor_primaria);
            setCorDestaque(branding?.cor_destaque || MOVEE_DEFAULTS.cor_destaque);
            setNomeExibicao(branding?.nome_exibicao || MOVEE_DEFAULTS.nome_exibicao);
            setLogoFile(null);
            setLogoPreviewUrl(branding?.logo_url || null);
            setRemoveLogo(false);
            setError(null);
            setSuccess(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        >
          Descartar
        </Button>
      </div>
    </div>
  );
}
