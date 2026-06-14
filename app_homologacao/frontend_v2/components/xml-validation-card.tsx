'use client';

import { useRef, useState, useMemo } from 'react';
import {
  FileCheck, Upload, Loader2, FileX2, CheckCircle2, Download,
  FileText, AlertTriangle, ChevronLeft, ChevronRight,
  RefreshCw, Copy, Ban, HelpCircle,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useXmlValidation, ValidationStatus, ValidationRow } from '@/hooks/use-xml-validation';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

// ---------------------------------------------------------------------------
// Badge de status — a11y: nunca cor sozinha, sempre ícone + texto
// ---------------------------------------------------------------------------

interface StatusBadgeConfig {
  label: string;
  icon: React.ReactNode;
  /** classes Tailwind para fundo + texto (dark/light via variáveis CSS) */
  className: string;
}

function getStatusConfig(status: ValidationStatus): StatusBadgeConfig {
  switch (status) {
    case 'ja_validada':
      return {
        label: 'Ja validada',
        icon: <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-muted text-muted-foreground',
      };
    case 'validada':
      return {
        label: 'Validada',
        icon: <CheckCircle2 className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-success/15 text-success',
      };
    case 'revalidada':
      return {
        label: 'Revalidada',
        icon: <RefreshCw className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-primary/10 text-primary',
      };
    case 'duplicada_no_lote':
      return {
        label: 'Duplicada no lote',
        icon: <Copy className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-warning/15 text-warning-foreground',
      };
    case 'sem_movimento':
      return {
        label: 'Sem movimento',
        icon: <HelpCircle className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-secondary text-secondary-foreground',
      };
    case 'erro':
      return {
        label: 'Erro',
        icon: <Ban className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-destructive/15 text-destructive',
      };
    default:
      // União fechada de 6 status; fallback defensivo para status desconhecido.
      return {
        label: String(status),
        icon: <HelpCircle className="h-3 w-3 shrink-0" aria-hidden="true" />,
        className: 'bg-secondary text-secondary-foreground',
      };
  }
}

function StatusBadge({ status }: { status: ValidationStatus }) {
  const cfg = getStatusConfig(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}
      aria-label={cfg.label}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Label do critério de casamento
// ---------------------------------------------------------------------------
function matchCriterioLabel(c: ValidationRow['match_criterio']): string {
  if (c === 'chave') return 'Chave NF-e';
  if (c === 'fallback') return 'CNPJ + Nota + Data';
  return '—';
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------
export function XmlValidationCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [validarDescricao, setValidarDescricao] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const { loading, data, error, validateBatch, downloadCSV, reset } = useXmlValidation();

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.results.length / rowsPerPage));
  }, [data, rowsPerPage]);

  const paginatedResults = useMemo(() => {
    if (!data) return [];
    const start = (currentPage - 1) * rowsPerPage;
    return data.results.slice(start, start + rowsPerPage);
  }, [data, currentPage, rowsPerPage]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (selected && selected.length > 0) {
      const xmlFiles = Array.from(selected).filter(f => f.name.endsWith('.xml'));
      if (xmlFiles.length === 0) {
        toast.error('Selecione apenas arquivos .xml');
        return;
      }
      setFiles(xmlFiles);
      reset();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.xml'));
    if (dropped.length === 0) {
      toast.error('Selecione apenas arquivos .xml');
      return;
    }
    setFiles(dropped);
    reset();
  };

  const handleSubmit = async () => {
    if (files.length === 0) {
      toast.error('Selecione pelo menos um arquivo XML.');
      return;
    }
    try {
      await validateBatch(files, validarDescricao);
      setCurrentPage(1);
      toast.success('Validacao concluida!');
    } catch {
      toast.error('Erro ao validar XMLs.');
    }
  };

  const handleClear = () => {
    setFiles([]);
    reset();
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Card de upload */}
      <Card>
        <CardHeader>
          <CardTitle as="h1" className="flex items-center gap-2 text-lg">
            <FileCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            Validacao XML NFSe
          </CardTitle>
          <CardDescription>
            Selecione arquivos XML de NFSe para validacao em lote.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Drop zone */}
          <div
            className={`relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors cursor-pointer ${
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-muted-foreground/50'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Area de upload de arquivos XML. Clique ou arraste arquivos."
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xml"
              multiple
              className="hidden"
              onChange={handleFileChange}
              aria-label="Selecionar arquivos XML"
            />
            <Upload className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              Clique ou arraste arquivos XML aqui
            </p>
            {files.length > 0 && (
              <p className="text-sm font-medium text-foreground">
                {files.length} arquivo(s) selecionado(s)
              </p>
            )}
          </div>

          {/* Lista de arquivos */}
          <AnimatePresence>
            {files.length > 0 && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="max-h-40 overflow-y-auto rounded-lg border bg-muted/30 p-3"
              >
                <div className="space-y-1">
                  {files.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{f.name}</span>
                      <span className="ml-auto shrink-0">{(f.size / 1024).toFixed(1)} KB</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Checkbox validar descricao */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={validarDescricao}
              onChange={(e) => setValidarDescricao(e.target.checked)}
              className="h-4 w-4 rounded border-muted-foreground/50"
            />
            <span className="text-sm">Validar Descricao do Servico</span>
          </label>

          {/* Mensagem de erro */}
          <AnimatePresence>
            {error && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              >
                <FileX2 className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Botoes de acao */}
          <div className="flex gap-2 flex-wrap">
            <Button
              onClick={handleSubmit}
              disabled={loading || files.length === 0}
              className="gap-2"
            >
              {loading
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <FileCheck className="h-4 w-4" aria-hidden="true" />}
              {loading ? 'Validando...' : 'Validar'}
            </Button>
            {files.length > 0 && (
              <Button variant="outline" onClick={handleClear} disabled={loading}>
                Limpar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Relatorio de Resultados */}
      <AnimatePresence>
        {data && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.3 }}
            className="space-y-4"
          >
            {/* ── Resumo agregado: 7 contadores ── */}
            <section aria-label="Resumo da validacao">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {/* Total */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <FileText className="h-4 w-4 text-primary" aria-hidden="true" />
                    <p className="tabular text-xl font-bold">{data.stats.total}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Total</p>
                  </CardContent>
                </Card>

                {/* Ja validada */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <p className="tabular text-xl font-bold text-muted-foreground">{data.stats.ja_validada}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Ja validadas</p>
                  </CardContent>
                </Card>

                {/* Validada */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                    <p className="tabular text-xl font-bold text-success">{data.stats.validada}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Validadas</p>
                  </CardContent>
                </Card>

                {/* Revalidada */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <RefreshCw className="h-4 w-4 text-primary" aria-hidden="true" />
                    <p className="tabular text-xl font-bold text-primary">{data.stats.revalidada}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Revalidadas</p>
                  </CardContent>
                </Card>

                {/* Duplicada no lote */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <Copy className="h-4 w-4 text-warning-foreground" aria-hidden="true" />
                    <p className="tabular text-xl font-bold">{data.stats.duplicada_no_lote}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Duplicadas</p>
                  </CardContent>
                </Card>

                {/* Sem movimento */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <HelpCircle className="h-4 w-4 text-secondary-foreground" aria-hidden="true" />
                    <p className="tabular text-xl font-bold">{data.stats.sem_movimento}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Sem movimento</p>
                  </CardContent>
                </Card>

                {/* Erro */}
                <Card size="sm">
                  <CardContent className="flex flex-col items-center justify-center gap-1 p-3 text-center">
                    <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
                    <p className="tabular text-xl font-bold text-destructive">{data.stats.erro}</p>
                    <p className="text-xs text-muted-foreground leading-tight">Erros</p>
                  </CardContent>
                </Card>
              </div>
            </section>

            {/* ── Tabela de resultados detalhados ── */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-sm">Detalhes da Validacao</CardTitle>
                  <Button size="sm" variant="outline" onClick={downloadCSV} className="gap-1.5 shrink-0">
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Exportar CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto max-h-[400px] overflow-y-auto relative rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b text-left text-muted-foreground">
                        <th scope="col" className="pb-2 pr-3 pt-2 pl-3 font-medium bg-card">Arquivo</th>
                        <th scope="col" className="pb-2 pr-3 pt-2 font-medium bg-card whitespace-nowrap">Status</th>
                        <th scope="col" className="pb-2 pr-3 pt-2 font-medium bg-card whitespace-nowrap">Criterio</th>
                        <th scope="col" className="pb-2 pr-3 pt-2 font-medium bg-card whitespace-nowrap">Mov. ID</th>
                        <th scope="col" className="pb-2 pr-3 pt-2 font-medium bg-card whitespace-nowrap">CNPJ Prestador</th>
                        <th scope="col" className="pb-2 pr-3 pt-2 font-medium bg-card whitespace-nowrap">Num. Nota</th>
                        <th scope="col" className="pb-2 pr-3 pt-2 font-medium bg-card">Mensagem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedResults.map((row, i) => {
                        const isError = row.status === 'erro' || row.status === 'sem_movimento';
                        return (
                          <tr
                            key={i}
                            className={`border-b last:border-0 transition-colors ${
                              isError ? 'bg-destructive/5 hover:bg-destructive/10' : 'hover:bg-muted/30'
                            }`}
                          >
                            <td className="py-2 pr-3 pl-3 max-w-[180px]">
                              <span className="block truncate font-mono" title={row.arquivo}>
                                {row.arquivo}
                              </span>
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap">
                              <StatusBadge status={row.status} />
                            </td>
                            <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                              {matchCriterioLabel(row.match_criterio)}
                            </td>
                            <td className="py-2 pr-3 font-mono text-muted-foreground">
                              {row.movimento_id ?? '—'}
                            </td>
                            <td className="py-2 pr-3 font-mono">
                              {row.cnpj_prestador ?? '—'}
                            </td>
                            <td className="py-2 pr-3">
                              {row.numnota ?? '—'}
                            </td>
                            <td className="py-2 pr-3 max-w-[240px]">
                              {row.erro_validacao ? (
                                <span className="text-destructive" title={row.erro_validacao}>
                                  {row.erro_validacao}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Paginacao */}
                {data.results.length > rowsPerPage && (
                  <div className="flex items-center justify-between border-t pt-3 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <label htmlFor="rows-per-page" className="text-xs text-muted-foreground sr-only">
                        Registros por pagina
                      </label>
                      <span className="text-xs text-muted-foreground" aria-hidden="true">Registros por pagina:</span>
                      <select
                        id="rows-per-page"
                        value={rowsPerPage}
                        onChange={(e) => { setRowsPerPage(Number(e.target.value)); setCurrentPage(1); }}
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                      >
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                      <span className="text-xs text-muted-foreground" aria-live="polite">
                        {((currentPage - 1) * rowsPerPage) + 1}–{Math.min(currentPage * rowsPerPage, data.results.length)} de {data.results.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-1" role="navigation" aria-label="Paginacao">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="h-8 w-8 p-0"
                        aria-label="Pagina anterior"
                      >
                        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <span className="text-xs px-2" aria-current="page">
                        {currentPage} / {totalPages}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="h-8 w-8 p-0"
                        aria-label="Proxima pagina"
                      >
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
