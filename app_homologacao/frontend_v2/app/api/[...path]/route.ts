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

    // Reconstruct Cookie header from parsed cookies with proper encoding.
    const allCookies = req.cookies.getAll();
    const rawCookie = req.headers.get('cookie');
    console.log('[proxy-debug]', req.method, path, {
      rawCookie: rawCookie ? rawCookie.substring(0, 120) : null,
      parsedCookieNames: allCookies.map(c => c.name),
      parsedCookieCount: allCookies.length,
    });

    if (rawCookie) {
      // Prefer raw cookie header when available — no re-encoding needed
      headers.set('cookie', rawCookie);
    } else if (allCookies.length > 0) {
      const cookieHeader = allCookies
        .map(c => `${c.name}=${encodeURIComponent(c.value)}`)
        .join('; ');
      headers.set('cookie', cookieHeader);
    }

    const init: RequestInit = {
      method: req.method,
      headers,
      cache: 'no-store' as RequestCache,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const contentType = req.headers.get('content-type') || '';
      if (contentType.includes('multipart/form-data')) {
        // Stream the raw body directly — avoids ArrayBuffer detachment
        // that happens with req.formData(), req.arrayBuffer(), etc.
        init.body = req.body;
        (init as Record<string, unknown>).duplex = 'half';
        // Keep original Content-Type header with boundary intact
      } else {
        init.body = await req.text();
      }
    }

    const backendRes = await fetch(target, init);

    const responseHeaders = new Headers();
    backendRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'set-cookie') return;
      responseHeaders.append(key, value);
    });

    // Set-Cookie must be handled separately — Headers.forEach() merges multiple values with comma
    const setCookies = backendRes.headers.getSetCookie();
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
export async function PATCH(req: NextRequest) { return proxyRequest(req); }
export async function DELETE(req: NextRequest) { return proxyRequest(req); }
export async function PUT(req: NextRequest) { return proxyRequest(req); }
