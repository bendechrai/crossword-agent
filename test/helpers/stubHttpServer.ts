import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * One canned reply for the stub server to hand back. `headers` keys are
 * matched verbatim (the server does not lower-case them; Node's HTTP layer
 * does that for a real client reading them back, which is exactly the
 * behaviour under test).
 */
export interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  /** Sent as-is if a string; JSON.stringify'd otherwise. */
  body?: string | Record<string, unknown>;
}

/** One request the stub server received, captured for assertions. */
export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed as JSON when the body is valid JSON; the raw text otherwise. */
  body: unknown;
  bodyText: string;
}

export interface StubHttpServer {
  /** `http://127.0.0.1:<port>`, real sockets only, never external. */
  url: string;
  /** Every request received so far, in arrival order. */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonMaybe(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Starts a real HTTP server on `127.0.0.1` (an ephemeral port) that answers
 * every request with the next entry of `responses`, in order; the last entry
 * is repeated for any request beyond the queue's length, so a test can hand
 * a single "always 200" response and issue any number of calls against it.
 *
 * T33's client tests exercise real sockets against this rather than mocking
 * `fetch`, so retry timing, real header casing and real body framing are all
 * genuine.
 */
export async function startStubHttpServer(
  responses: ReadonlyArray<StubResponse>,
): Promise<StubHttpServer> {
  if (responses.length === 0) {
    throw new Error('startStubHttpServer: responses must have at least one entry');
  }

  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void readBody(req).then((bodyText) => {
      const index = Math.min(requests.length, responses.length - 1);
      const planned = responses[index]!;

      requests.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: parseJsonMaybe(bodyText),
        bodyText,
      });

      const bodyOut =
        planned.body === undefined
          ? ''
          : typeof planned.body === 'string'
            ? planned.body
            : JSON.stringify(planned.body);

      res.writeHead(planned.status, planned.headers ?? {});
      res.end(bodyOut);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()));
      }),
  };
}
