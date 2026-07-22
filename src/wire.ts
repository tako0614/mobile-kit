import type { FetchLike } from "./types.ts";
import type { WireDecoder } from "./contract/mobile-discovery.ts";

export type { WireDecoder };

/**
 * A host answered with a document the contract decoder rejects. This is a
 * producer/consumer disagreement, so the error names the document, the URL and
 * the field — enough for an operator to file it against the producer.
 */
export class WireDecodeError extends Error {
  readonly document: string;
  readonly url: string;
  readonly reason: string;

  constructor(document: string, url: string, reason: string) {
    super(`Invalid ${document} document at ${url}: ${reason}`);
    this.name = "WireDecodeError";
    this.document = document;
    this.url = url;
    this.reason = reason;
  }
}

/**
 * Reads a host document through a decoder **value**.
 *
 * There is deliberately no `fetchJson<T>()`: a caller that could supply the
 * shape as a type argument would be asserting what the producer emits instead
 * of checking it, which is exactly how a renamed wire field stayed green in
 * tests while every real sign-in failed. Because `decoder` is a value, reading
 * a host document requires importing the contract that defines it.
 */
export async function fetchWire<T>(
  fetcher: FetchLike,
  url: string,
  decoder: WireDecoder<T>,
): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Discovery request failed: ${response.status} ${url}`);
  }
  return decodeWire(decoder, await response.json(), url);
}

/** Same as {@link fetchWire}, but an absent document (404) is not an error. */
export async function fetchOptionalWire<T>(
  fetcher: FetchLike,
  url: string,
  decoder: WireDecoder<T>,
): Promise<T | undefined> {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`Discovery request failed: ${response.status} ${url}`);
  }
  return decodeWire(decoder, await response.json(), url);
}

export function decodeWire<T>(
  decoder: WireDecoder<T>,
  value: unknown,
  source: string,
): T {
  try {
    return decoder.decode(value);
  } catch (error) {
    throw new WireDecodeError(
      decoder.document,
      source,
      error instanceof Error ? error.message : String(error),
    );
  }
}
