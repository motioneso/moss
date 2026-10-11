import { types } from "node:util";
import pg from "pg";

/** Only node-postgres server errors may contribute a SQLSTATE; never invoke error getters. */
export function safePostgresErrorFields(
  error: unknown
): { readonly errorClass: "PostgresError"; readonly postgresCode?: string } | undefined {
  if (!types.isNativeError(error) || Object.getPrototypeOf(error) !== pg.DatabaseError.prototype)
    return undefined;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  return {
    errorClass: "PostgresError",
    ...(code &&
    "value" in code &&
    typeof code.value === "string" &&
    code.value.length === 5 &&
    /^[0-9A-Z]{5}$/.test(code.value)
      ? { postgresCode: code.value }
      : {})
  };
}
