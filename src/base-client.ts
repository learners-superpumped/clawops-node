import { z } from 'zod';
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  INITIAL_RETRY_DELAY,
  MAX_RETRY_DELAY,
} from './constants.js';
import {
  APIConnectionError,
  APIResponseValidationError,
  APITimeoutError,
  ClawOpsError,
  makeStatusError,
} from './error.js';
import { VERSION } from './version.js';

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

function validateBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ClawOpsError(`Invalid base_url: ${url}`);
  }
  if (parsed.protocol === 'https:') return url;
  if (parsed.protocol === 'http:' && LOCALHOST_HOSTS.has(parsed.hostname)) return url;
  throw new ClawOpsError(
    `base_url은 HTTPS를 사용해야 합니다 (받은 값: '${url}'). ` +
      `로컬 개발 시에는 http://localhost를 사용할 수 있습니다.`,
  );
}

export interface APIClientOptions {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: Record<string, string>;
}

/**
 * 본문 직렬화와 그에 딸린 `Content-Type` 을 **함께** 정한다.
 *
 * ⚠️ `contentType: null` 은 "헤더를 붙이지 말라" 는 뜻이다. multipart 의 boundary 는 fetch 가
 *    붙이므로, 기본값(`application/json`)이 남으면 서버가 본문을 파싱하지 못하고 그 실패는
 *    "왜 파일이 안 왔지" 로만 드러난다.
 *
 * ⚠️ 직렬화가 재시도 루프 **밖**이라 재시도마다 다시 stringify 하지 않는다.
 */
function serializeBody(body?: Record<string, unknown> | FormData | null): {
  payload: FormData | string | undefined;
  contentType: string | null;
} {
  if (body instanceof FormData) return { payload: body, contentType: null };
  if (!body) return { payload: undefined, contentType: 'application/json' };
  return { payload: JSON.stringify(body), contentType: 'application/json' };
}

export class APIClient {
  protected _apiKey: string;
  protected _baseURL: string;
  protected _maxRetries: number;
  protected _timeout: number;
  protected _fetch: typeof globalThis.fetch;
  protected _defaultHeaders: Record<string, string>;

  constructor(options: APIClientOptions) {
    this._apiKey = options.apiKey;
    this._baseURL = validateBaseUrl((options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''));
    this._maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._fetch = options.fetch ?? globalThis.fetch;
    this._defaultHeaders = options.defaultHeaders ?? {};
  }

  private _buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `claw-ops-node/${VERSION}`,
      ...this._defaultHeaders,
    };
    if (extra) Object.assign(headers, extra);
    return headers;
  }

  protected async _send(
    method: string,
    path: string,
    options: {
      /** `FormData` 면 그대로 보낸다(multipart) — 직렬화도 Content-Type 도 건드리지 않는다. */
      body?: Record<string, unknown> | FormData | null;
      query?: Record<string, unknown> | null;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Response> {
    const headers = this._buildHeaders(options.extraHeaders);

    // 본문과 Content-Type 은 **한 결정**이다 — 따로 두면 새 본문 종류를 더할 때 한쪽만
    // 고치게 되고, 헤더 쪽을 빠뜨리면 조용히 깨진다.
    const { payload, contentType } = serializeBody(options.body);
    if (contentType === null) delete headers['Content-Type'];
    else headers['Content-Type'] = contentType;

    const params = new URLSearchParams();
    const queryObj = { ...options.query, ...options.extraQuery };
    for (const [k, v] of Object.entries(queryObj)) {
      if (v != null) params.set(k, String(v));
    }

    const queryString = params.toString();
    const url = `${this._baseURL}${path}${queryString ? `?${queryString}` : ''}`;
    const reqTimeout = options.timeout ?? this._timeout;

    let retriesLeft = this._maxRetries;

    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), reqTimeout);

      let response: Response;
      try {
        response = await this._fetch(url, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (retriesLeft > 0) {
            retriesLeft--;
            await this._sleep(this._retryDelay(this._maxRetries - retriesLeft));
            continue;
          }
          throw new APITimeoutError({ method, url });
        }
        if (retriesLeft > 0) {
          retriesLeft--;
          await this._sleep(this._retryDelay(this._maxRetries - retriesLeft));
          continue;
        }
        throw new APIConnectionError({ method, url });
      } finally {
        clearTimeout(timeoutId);
      }

      if (response.ok) return response;

      if (retriesLeft > 0 && this._shouldRetry(response.status)) {
        retriesLeft--;
        await this._sleep(this._retryDelay(this._maxRetries - retriesLeft));
        continue;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      throw makeStatusError(response.status, body, response.headers, { method, url });
    }
  }

  protected async _request<T>(
    method: string,
    path: string,
    options: {
      /** `FormData` 면 그대로 보낸다(multipart) — 직렬화도 Content-Type 도 건드리지 않는다. */
      body?: Record<string, unknown> | FormData | null;
      query?: Record<string, unknown> | null;
      castTo?: z.ZodType<T>;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<T | null> {
    const response = await this._send(method, path, options);
    if (response.status === 204 || !options.castTo) return null;

    const url = `${this._baseURL}${path}`;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new APIResponseValidationError({ status: response.status }, { method, url });
    }
    const parsed = options.castTo.safeParse(json);
    if (!parsed.success) {
      throw new APIResponseValidationError({ status: response.status }, { method, url });
    }
    return parsed.data;
  }

  private _shouldRetry(status: number): boolean {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  private _retryDelay(retriesTaken: number): number {
    const delay = Math.min(INITIAL_RETRY_DELAY * 2 ** retriesTaken, MAX_RETRY_DELAY);
    return delay * (1 + Math.random());
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _get<T>(
    path: string,
    options: {
      castTo: z.ZodType<T>;
      query?: Record<string, unknown> | null;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    },
  ): Promise<T> {
    const result = await this._request<T>(method('GET'), path, options);
    return result!;
  }

  async _post<T>(
    path: string,
    options: {
      /** `FormData` 면 그대로 보낸다(multipart) — 직렬화도 Content-Type 도 건드리지 않는다. */
      body?: Record<string, unknown> | FormData | null;
      castTo: z.ZodType<T>;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    },
  ): Promise<T> {
    const result = await this._request<T>('POST', path, options);
    return result!;
  }

  async _put<T>(
    path: string,
    options: {
      body?: Record<string, unknown> | null;
      castTo: z.ZodType<T>;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    },
  ): Promise<T> {
    const result = await this._request<T>('PUT', path, options);
    return result!;
  }

  async _patch<T>(
    path: string,
    options: {
      body?: Record<string, unknown> | null;
      castTo: z.ZodType<T>;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    },
  ): Promise<T> {
    const result = await this._request<T>('PATCH', path, options);
    return result!;
  }

  async _getRaw(
    path: string,
    options: {
      query?: Record<string, unknown> | null;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    } = {},
  ): Promise<Response> {
    return this._send('GET', path, options);
  }

  /**
   * 본문을 돌려주는 DELETE. 기존 `_delete` 는 void 라 응답을 버리는데, soft delete 처럼
   * 삭제 결과 리소스를 그대로 반환하는 endpoint 가 있어서 따로 둔다.
   */
  async _deleteWithResponse<T>(
    path: string,
    options: {
      body?: Record<string, unknown> | null;
      castTo: z.ZodType<T>;
      extraHeaders?: Record<string, string>;
      extraQuery?: Record<string, unknown>;
      timeout?: number;
    },
  ): Promise<T> {
    const result = await this._request<T>('DELETE', path, options);
    return result!;
  }

  async _delete(
    path: string,
    options: {
      extraHeaders?: Record<string, string>;
      timeout?: number;
    } = {},
  ): Promise<void> {
    await this._request('DELETE', path, options);
  }
}

function method(m: string): string {
  return m;
}
