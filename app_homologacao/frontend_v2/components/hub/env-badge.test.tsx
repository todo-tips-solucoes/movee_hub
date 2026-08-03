// hub-shell (S3) task 2.1.6 — teste unitário dos 3 casos do EnvBadge
// (CHK029): "production" esconde; valor reconhecido não-produção mostra;
// valor ausente/inválido mostra (fail-safe).
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvBadge, isProductionEnv } from './env-badge';

const ENV_KEY = 'NEXT_PUBLIC_APP_ENV';
const ORIGINAL = process.env[ENV_KEY];

function setEnv(value: string | undefined) {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}

describe('isProductionEnv', () => {
  it('só "production" é produção', () => {
    expect(isProductionEnv('production')).toBe(true);
    expect(isProductionEnv('homologacao')).toBe(false);
    expect(isProductionEnv('staging')).toBe(false);
    expect(isProductionEnv(undefined)).toBe(false);
    expect(isProductionEnv(null)).toBe(false);
    expect(isProductionEnv('')).toBe(false);
    expect(isProductionEnv('Production')).toBe(false); // case-sensitive: só o valor exato
  });
});

describe('EnvBadge', () => {
  afterEach(() => {
    setEnv(ORIGINAL);
  });

  it('caso 1 — "production": não renderiza o banner', () => {
    setEnv('production');
    const { container } = render(<EnvBadge />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/HOMOLOGAÇÃO/)).toBeNull();
  });

  it('caso 2 — "homologacao"/"staging" (valor reconhecido não-produção): mostra o banner', () => {
    setEnv('homologacao');
    render(<EnvBadge />);
    expect(screen.getByText('HOMOLOGAÇÃO — dados fictícios')).toBeInTheDocument();

    setEnv('staging');
    render(<EnvBadge />);
    expect(screen.getAllByText('HOMOLOGAÇÃO — dados fictícios').length).toBeGreaterThan(0);
  });

  it('caso 3 — valor ausente ou inválido: fail-safe, mostra o banner', () => {
    setEnv(undefined);
    render(<EnvBadge />);
    expect(screen.getByText('HOMOLOGAÇÃO — dados fictícios')).toBeInTheDocument();
  });

  it('caso 3.bis — valor não reconhecido (typo de configuração): fail-safe, mostra o banner', () => {
    setEnv('produção'); // typo/valor não-canônico — NÃO deve ser confundido com "production"
    render(<EnvBadge />);
    expect(screen.getByText('HOMOLOGAÇÃO — dados fictícios')).toBeInTheDocument();
  });

  // O header e a sidebar do hub grudam em `top: var(--env-badge-h, 0px)`. Se
  // esta var sumir junto com o banner, os dois voltam a empilhar em top-0 e o
  // header fica escondido atrás do badge — falha visual silenciosa, sem erro.
  it('declara --env-badge-h junto com o banner (e só com ele)', () => {
    setEnv('homologacao');
    const { container } = render(<EnvBadge />);
    expect(container.querySelector('style')?.textContent).toContain('--env-badge-h');

    setEnv('production');
    const semBanner = render(<EnvBadge />);
    expect(semBanner.container.querySelector('style')).toBeNull();
  });

  it('aplica favicon alternativo (data-hub-env-favicon) quando não-produção', async () => {
    setEnv('homologacao');
    render(<EnvBadge />);
    await waitFor(() => {
      expect(document.querySelector('link[data-hub-env-favicon]')).not.toBeNull();
    });
  });

  it('não deixa favicon alternativo marcado quando produção', () => {
    setEnv('production');
    render(<EnvBadge />);
    expect(document.querySelector('link[data-hub-env-favicon]')).toBeNull();
  });
});
