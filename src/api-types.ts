/**
 * Request and response types of the developer API, read from the generated
 * OpenAPI types (`src/generated/openapi.ts`, never edited by hand). A resource
 * method names its route once; its input and output follow the spec.
 */
import type { paths } from "./generated/openapi.js";

type Method = "get" | "post" | "put" | "patch" | "delete";

/** Paths of the spec, without the `/api/v1` prefix the client's base URL carries. */
export type ApiPath = keyof paths extends infer P
  ? P extends `/api/v1${infer Rest}`
    ? Rest
    : never
  : never;

type Operation<P extends ApiPath, M extends Method> = `/api/v1${P}` extends keyof paths
  ? paths[`/api/v1${P}`] extends Record<M, infer O>
    ? O
    : never
  : never;

type JsonOf<T> = T extends { content: { "application/json": infer B } } ? B : never;

/** The JSON body a route takes. */
export type RequestBody<P extends ApiPath, M extends Method> = Operation<P, M> extends {
  requestBody?: infer RB;
}
  ? JsonOf<NonNullable<RB>>
  : never;

/** The query a route takes. */
export type RequestQuery<P extends ApiPath, M extends Method> = Operation<P, M> extends {
  parameters: { query?: infer Q };
}
  ? NonNullable<Q>
  : never;

type SuccessResponses<R> = {
  [S in keyof R]: S extends 200 | 201 ? R[S] : never;
}[keyof R];

/** What a route answers on success — the `data` of the envelope, never the envelope. */
export type ResponseData<P extends ApiPath, M extends Method> = Operation<P, M> extends {
  responses: infer R;
}
  ? JsonOf<SuccessResponses<R>> extends { data: infer D }
    ? D
    : JsonOf<SuccessResponses<R>>
  : never;
