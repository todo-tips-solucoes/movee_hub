'use client';

import { useRef, useState, useMemo } from 'react';
import { FileCheck, Upload, Loader2, FileX2, CheckCircle2, Download, FileText, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useXmlValidation } from '@/hooks/use-xml-validation';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCheck className="h-5 w-5 text-primary" />
            Validacao XML NFSe
          </CardTitle>
          <CardDescription>
            Selecione arquivos XML de NFSe para validacao em lote.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Drop zone */}
          <div
            className={`relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors ${
              dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xml"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Clique ou arraste arquivos XML aqui
            </p>
            {files.length > 0 && (
              <p className="text-sm font-medium text-foreground">
                {files.length} arquivo(s) selecionado(s)
              </p>
            )}
          </div>

          {/* File list */}
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
                      <FileCheck className="h-3 w-3 shrink-0" />
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

          {/* Error message */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
              >
                <FileX2 className="h-4 w-4 shrink-0" />
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleSubmit}
              disabled={loading || files.length === 0}
              className="gap-2"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileCheck className="h-4 w-4" />
              )}
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

      {/* Relatorio Visual */}
      <AnimatePresence>
        {data && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.3 }}
            className="space-y-4"
          >
            {/* Stats Cards */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card size="sm">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                    <FileText className="h-5 w-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{data.stats.total}</p>
                    <p className="text-xs text-muted-foreground">Notas Validadas</p>
                  </div>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{data.stats.success}</p>
                    <p className="text-xs text-muted-foreground">Sucesso</p>
                  </div>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardContent className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10">
                    <AlertTriangle className="h-5 w-5 text-red-500" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-red-600 dark:text-red-400">{data.stats.errors}</p>
                    <p className="text-xs text-muted-foreground">Erros</p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Results table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Detalhes da Validacao</CardTitle>
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={downloadCSV} className="gap-1.5">
                    <Download className="h-4 w-4" />
                    Exportar CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto max-h-[400px] overflow-y-auto relative">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-3 pt-1 font-medium bg-card">Arquivo</th>
                        <th className="pb-2 pr-3 pt-1 font-medium bg-card">CNPJ Prestador</th>
                        <th className="pb-2 pr-3 pt-1 font-medium bg-card">Razao Social</th>
                        <th className="pb-2 pr-3 pt-1 font-medium bg-card">Valor</th>
                        <th className="pb-2 pr-3 pt-1 font-medium bg-card">Data Emissao</th>
                        <th className="pb-2 pr-3 pt-1 font-medium text-center bg-card">Valida</th>
                        <th className="pb-2 pr-3 pt-1 font-medium text-center bg-card">CNPJ Prest.</th>
                        <th className="pb-2 pr-3 pt-1 font-medium text-center bg-card">CNPJ</th>
                        <th className="pb-2 pr-3 pt-1 font-medium text-center bg-card">Descricao</th>
                        <th className="pb-2 pr-3 pt-1 font-medium text-center bg-card">Valor</th>
                        <th className="pb-2 pr-3 pt-1 font-medium text-center bg-card">Trib. Nac.</th>
                        <th className="pb-2 pt-1 font-medium text-center bg-card">dCompet</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedResults.map((row, i) => (
                        <tr key={i} className={`border-b last:border-0 ${row.valid ? '' : 'bg-red-500/5'}`}>
                          <td className="py-2 pr-3 max-w-[180px] truncate" title={row.filename}>{row.filename}</td>
                          <td className="py-2 pr-3 font-mono">{row.cnpj_prestador}</td>
                          <td className="py-2 pr-3 max-w-[150px] truncate" title={row.razao_social}>{row.razao_social}</td>
                          <td className="py-2 pr-3">R$ {row.valor_nota}</td>
                          <td className="py-2 pr-3">{row.data_emissao ? new Date(row.data_emissao).toLocaleDateString('pt-BR') : ''}</td>
                          <td className="py-2 pr-3 text-center">{row.valid ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                          <td className="py-2 pr-3 text-center">{row.valid_cnpj_prestador ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                          <td className="py-2 pr-3 text-center">{row.valid_cnpj ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                          <td className="py-2 pr-3 text-center">{row.valid_descricao_servico ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                          <td className="py-2 pr-3 text-center">{row.valid_valor ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                          <td className="py-2 pr-3 text-center">{row.valid_trib_nac ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                          <td className="py-2 text-center">{row.valid_dCompet ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" /> : <FileX2 className="h-4 w-4 text-red-500 mx-auto" />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Paginacao */}
                {data.results.length > 0 && (
                  <div className="flex items-center justify-between border-t pt-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Registros por pagina:</span>
                      <select
                        value={rowsPerPage}
                        onChange={(e) => { setRowsPerPage(Number(e.target.value)); setCurrentPage(1); }}
                        className="h-8 rounded-md border bg-background px-2 text-xs"
                      >
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                        <option value={100}>100</option>
                      </select>
                      <span className="text-xs text-muted-foreground">
                        {((currentPage - 1) * rowsPerPage) + 1}-{Math.min(currentPage * rowsPerPage, data.results.length)} de {data.results.length}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="h-8 w-8 p-0"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-xs px-2">{currentPage} / {totalPages}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="h-8 w-8 p-0"
                      >
                        <ChevronRight className="h-4 w-4" />
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
