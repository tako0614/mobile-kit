// Vendored generic JSON type aliases (originally takosumi-contract/types).
// mobile-kit is a standalone client SDK for the mobile host wire contract and
// owns its own copy of the small contract surface it consumes.
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export type JsonObject = { [key: string]: JsonValue };

export type IsoTimestamp = string;
