// hub-shell (S3) task 1.4.3 — teste smoke do HubAuthProvider com /me mockado.
//
// Cobre: estado inicial (carregando -> me carregado), refetchMe() atualiza
// `me`, logout() limpa o estado. `fetch` global é mockado (sem rede real).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubAuthProvider, useHubAuth } from './hub-auth-context';

const ME_RESPONSE_DTO = {
  usuario: { id: 1, email: 'pessoa@exemplo.com', nome: 'Pessoa Exemplo' },
  entidades: [{ empresa_id: 10, papel: 'admin', ativo: true }],
  entidade_ativa: 10,
  modulos: [{ codigo: 'motoristas', nome: 'Motoristas', icone: 'truck', ordem: 1, ativo: true }],
  permissoes: ['motoristas.view'],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function Consumidor() {
  const { usuario, entidadeAtiva, carregando, logout, refetchMe } = useHubAuth();
  return (
    <div>
      <span data-testid="carregando">{String(carregando)}</span>
      <span data-testid="usuario">{usuario ? usuario.nome : 'sem-usuario'}</span>
      <span data-testid="entidade-ativa">{String(entidadeAtiva)}</span>
      <button onClick={() => refetchMe()}>refetch</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

describe('HubAuthProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('estado inicial: carrega /me no mount e popula usuario/entidadeAtiva', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ME_RESPONSE_DTO));

    render(
      <HubAuthProvider>
        <Consumidor />
      </HubAuthProvider>
    );

    expect(screen.getByTestId('carregando').textContent).toBe('true');

    await waitFor(() => expect(screen.getByTestId('carregando').textContent).toBe('false'));
    expect(screen.getByTestId('usuario').textContent).toBe('Pessoa Exemplo');
    expect(screen.getByTestId('entidade-ativa').textContent).toBe('10');
    expect(fetch).toHaveBeenCalledWith('/api/v1/me', expect.objectContaining({ credentials: 'include' }));
  });

  it('refetchMe() atualiza o me (ex.: entidade ativa mudou)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ME_RESPONSE_DTO));

    render(
      <HubAuthProvider>
        <Consumidor />
      </HubAuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('carregando').textContent).toBe('false'));

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ ...ME_RESPONSE_DTO, entidade_ativa: 11 })
    );
    fireEvent.click(screen.getByText('refetch'));

    await waitFor(() => expect(screen.getByTestId('entidade-ativa').textContent).toBe('11'));
  });

  it('logout() limpa o estado (usuario volta a null)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(ME_RESPONSE_DTO));

    render(
      <HubAuthProvider>
        <Consumidor />
      </HubAuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId('usuario').textContent).toBe('Pessoa Exemplo'));

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true }));
    fireEvent.click(screen.getByText('logout'));

    await waitFor(() => expect(screen.getByTestId('usuario').textContent).toBe('sem-usuario'));
    expect(screen.getByTestId('entidade-ativa').textContent).toBe('null');
  });

  it('degrada para deslogado (me=null) sem lançar quando /me responde 401', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ erro: 'NAO_AUTENTICADO' }, 401));

    render(
      <HubAuthProvider>
        <Consumidor />
      </HubAuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('carregando').textContent).toBe('false'));
    expect(screen.getByTestId('usuario').textContent).toBe('sem-usuario');
  });
});
