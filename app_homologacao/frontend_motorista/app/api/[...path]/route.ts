/**
 * Proxy reverso para o backend Express (/motorista/*)
 * Reutiliza o padrão do frontend_v2 com ajuste de origem.
 * Ref: plan.md §Frontend Proxy; tarefa 4.1.2
 */

import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

async function proxyRequest(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');
    const target = `${BACKEND_URL}${path}${url.search}`;

    const skipHeaders = new Set([
      'host', 'connection', 'content-length',
      'transfer-encoding', 'accept-encoding', 'cookie',
    ]);
    const headers = new Headers();
    req.headers.forEach((value, key) => {
      if (!skipHeaders.has(key)) {
        headers.set(key, value);
      }
    });

    // Preservar cookie header raw sem re-codificação
    const rawCookie = req.headers.get('cookie');
    if (rawCookie) {
      headers.set('cookie', rawCookie);
    } else {
      const allCookies = req.cookies.getAll();
      if (allCookies.length > 0) {
        headers.set('cookie', allCookies.map(c => `${c.name}=${c.value}`).join('; '));
      }
    }

    // Para multipart/form-data: repassar body como stream sem buffer
    let body: BodyInit | null = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const contentType = req.headers.get('content-type') ?? '';
      if (contentType.includes('multipart/form-data')) {
        body = await req.formData();
        // Remover content-type para deixar fetch reconstruir o boundary
        headers.delete('content-type');
      } else {
        body = await req.arrayBuffer();
      }
    }

    const backendRes = await fetch(target, {
      method: req.method,
      headers,
      body,
      // @ts-expect-error — Node fetch aceita duplex para streaming
      duplex: 'half',
    });

    const responseHeaders = new Headers(backendRes.headers);
    // Repassar Set-Cookie sem modificação (para httpOnly funcionar)
    const setCookies = backendRes.headers.getSetCookie?.() ?? [];
    responseHeaders.delete('set-cookie');
    for (const cookie of setCookies) {
      responseHeaders.append('set-cookie', cookie);
    }

    return new NextResponse(backendRes.body, {
      status: backendRes.status,
      statusText: backendRes.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('[proxy]', req.method, req.url, error);
    return NextResponse.json(
      { error: 'Erro ao conectar com o servidor' },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest) { return proxyRequest(req); }
export async function POST(req: NextRequest) { return proxyRequest(req); }
export async function PUT(req: NextRequest) { return proxyRequest(req); }
export async function PATCH(req: NextRequest) { return proxyRequest(req); }
export async function DELETE(req: NextRequest) { return proxyRequest(req); }
export async function OPTIONS(req: NextRequest) { return proxyRequest(req); }
