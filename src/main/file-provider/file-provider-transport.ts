import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FileProviderItem } from '../../shared/file-provider/contract.js';
import type { OpenedProviderOriginal } from './file-provider-service.js';

const ENDPOINT_FILE = 'endpoint.json';
const MAX_URL_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 1024;

export interface FileProviderTransportSource {
  readonly enumerate: (parentId: string) => readonly FileProviderItem[];
  readonly item: (itemId: string) => FileProviderItem | undefined;
  readonly materialize: (itemId: string) => Promise<OpenedProviderOriginal>;
}

function authorized(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function unavailable(response: ServerResponse): void {
  if (response.headersSent) response.destroy();
  else {
    response.writeHead(404, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Unavailable');
  }
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function queryIdentifier(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  return value !== null && value !== '' && value.length <= MAX_IDENTIFIER_LENGTH ? value : null;
}

export class FileProviderTransport {
  private server: Server | undefined;
  private token: string | undefined;
  private starting: Promise<void> | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly activeRequests = new Set<Promise<void>>();

  constructor(
    private readonly stateDirectory: string,
    private readonly source: FileProviderTransportSource,
  ) {}

  start(): Promise<void> {
    if (this.server?.listening === true) return Promise.resolve();
    this.starting ??= this.listen().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.token = undefined;
    await unlink(this.endpointPath()).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
    const closed =
      server !== undefined && server.listening
        ? new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))))
        : Promise.resolve();
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.activeRequests]);
    server?.closeAllConnections();
    this.sockets.clear();
    await closed;
  }

  private async listen(): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => {
      const active = this.handle(request.method, request.url, request.headers.authorization, response);
      this.activeRequests.add(active);
      void active.then(
        () => this.activeRequests.delete(active),
        () => this.activeRequests.delete(active),
      );
    });
    let temporary: string | undefined;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('File Provider transport did not bind a TCP port');
      await mkdir(this.stateDirectory, { recursive: true });
      temporary = path.join(this.stateDirectory, `.${ENDPOINT_FILE}.${process.pid}.${randomBytes(8).toString('hex')}`);
      await writeFile(temporary, `${JSON.stringify({ version: 1, port: address.port, token })}\n`, { mode: 0o600 });
      await rename(temporary, this.endpointPath());
      await chmod(this.endpointPath(), 0o600);
      this.server = server;
      this.token = token;
    } catch (error) {
      server.close();
      await Promise.all([
        temporary === undefined ? Promise.resolve() : unlink(temporary).catch(() => undefined),
        unlink(this.endpointPath()).catch(() => undefined),
      ]);
      throw error;
    }
  }

  private async handle(
    method: string | undefined,
    requestUrl: string | undefined,
    header: string | string[] | undefined,
    response: ServerResponse,
  ) {
    const token = this.token;
    if (
      token === undefined ||
      method !== 'GET' ||
      requestUrl === undefined ||
      requestUrl.length > MAX_URL_LENGTH ||
      !authorized(header, token)
    ) {
      unavailable(response);
      return;
    }
    try {
      const url = new URL(requestUrl, 'http://127.0.0.1');
      if (url.pathname === '/v1/enumerate') {
        const parent = queryIdentifier(url, 'parent');
        if (parent === null) throw new Error('unavailable');
        json(response, this.source.enumerate(parent));
        return;
      }
      if (url.pathname === '/v1/item') {
        const id = queryIdentifier(url, 'id');
        const item = id === null ? undefined : this.source.item(id);
        if (item === undefined) throw new Error('unavailable');
        json(response, item);
        return;
      }
      if (url.pathname === '/v1/materialize') {
        const id = queryIdentifier(url, 'id');
        if (id === null) throw new Error('unavailable');
        const opened = await this.source.materialize(id);
        try {
          response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' });
          await pipeline(opened.stream, response);
        } finally {
          await opened.release?.();
        }
        return;
      }
      throw new Error('unavailable');
    } catch {
      unavailable(response);
    }
  }

  private endpointPath(): string {
    return path.join(this.stateDirectory, ENDPOINT_FILE);
  }
}
