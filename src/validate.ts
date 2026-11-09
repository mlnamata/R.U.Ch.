/**
 * Tiny request validator for the HTTP API. Replaces zod on the server path,
 * which saves ~14 MB of resident memory per hub process.
 */
export type V<T> = (v: unknown, path: string) => T;

export class ValidationError extends Error {}
const fail = (path: string, msg: string): never => {
  throw new ValidationError(`${path || "(tělo)"}: ${msg}`);
};

export const str =
  (opts: { max?: number; min?: number } = {}): V<string> =>
  (v, p) => {
    if (typeof v !== "string") return fail(p, "očekáván text");
    if (opts.min !== undefined && v.length < opts.min) fail(p, `min. ${opts.min} znaků`);
    if (opts.max !== undefined && v.length > opts.max) fail(p, `max. ${opts.max} znaků`);
    return v;
  };
export const int =
  (opts: { min?: number; max?: number } = {}): V<number> =>
  (v, p) => {
    if (typeof v !== "number" || !Number.isInteger(v)) return fail(p, "očekáváno celé číslo");
    if (opts.min !== undefined && v < opts.min) fail(p, `min. ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) fail(p, `max. ${opts.max}`);
    return v;
  };
export const bool: V<boolean> = (v, p) => (typeof v === "boolean" ? v : fail(p, "očekáváno true/false"));
export const oneOf =
  <T extends string>(...values: T[]): V<T> =>
  (v, p) =>
    values.includes(v as T) ? (v as T) : fail(p, `povoleno: ${values.join(", ")}`);
export const arr =
  <T>(item: V<T>, opts: { min?: number; max?: number } = {}): V<T[]> =>
  (v, p) => {
    if (!Array.isArray(v)) return fail(p, "očekáván seznam");
    if (opts.min !== undefined && v.length < opts.min) fail(p, `min. ${opts.min} položek`);
    if (opts.max !== undefined && v.length > opts.max) fail(p, `max. ${opts.max} položek`);
    return v.map((x, i) => item(x, `${p}[${i}]`));
  };
export const opt =
  <T>(inner: V<T>): V<T | undefined> =>
  (v, p) =>
    v === undefined ? undefined : inner(v, p);
/** Optional and also accepts null. */
export const nul =
  <T>(inner: V<T>): V<T | null | undefined> =>
  (v, p) =>
    v === undefined || v === null ? (v as null | undefined) : inner(v, p);
export const dflt =
  <T>(inner: V<T>, d: T): V<T> =>
  (v, p) =>
    v === undefined ? d : inner(v, p);

type Shape = Record<string, V<unknown>>;
export type Infer<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

/** Object with known keys; unknown keys are dropped. */
export const obj =
  <S extends Shape>(shape: S): V<Infer<S>> =>
  (v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(p, "očekáván objekt");
    const out: Record<string, unknown> = {};
    for (const [k, check] of Object.entries(shape)) {
      const r = check((v as Record<string, unknown>)[k], p ? `${p}.${k}` : k);
      if (r !== undefined) out[k] = r;
    }
    return out as Infer<S>;
  };
/** Pick the object validator by the value of a tag field. */
export const tagged =
  <T>(tag: string, variants: Record<string, V<T>>): V<T> =>
  (v, p) => {
    const t = (v as Record<string, unknown> | null)?.[tag];
    const check = typeof t === "string" ? variants[t] : undefined;
    return check ? check(v, p) : fail(`${p}.${tag}`, `povoleno: ${Object.keys(variants).join(", ")}`);
  };
