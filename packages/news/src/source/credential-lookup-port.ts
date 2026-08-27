// packages/news/src/source/credential-lookup-port.ts
// #2007 — News's name for the keyed dataset runtime's credential lookup contract.
//
// Aliased onto the runtime's own types rather than redeclared, so the two sides cannot drift
// apart: if @moss/datasets changes the shape it expects, this stops compiling instead of
// silently disagreeing at runtime.
//
// The context type is the request-scoped database handle. That is what lets a cached answer
// outlive one request while the lookup itself still runs under the acting person's row security.
import type { KeyedCredentialLookup, KeyedCredentialLookupResult } from "@moss/datasets";
import type { DataContextDb } from "@moss/db";

export type NewsCredentialLookupResult = KeyedCredentialLookupResult;
export type NewsCredentialLookupPort = KeyedCredentialLookup<DataContextDb>;
