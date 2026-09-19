/** Small, private schema primitives. Public contracts live in contracts.ts. */
export class ContractValidationError extends Error {
  readonly path: string;

  constructor(path: string, rule: string) {
    // Never interpolate rejected values (queries, credentials or provider bodies).
    super(`${path}: ${rule}`);
    this.name = 'ContractValidationError';
    this.path = path;
  }
}

export function requireContract(condition: boolean, path: string, rule: string): asserts condition {
  if (!condition) throw new ContractValidationError(path, rule);
}

export type Schema<T> = {
  parse: (input: unknown, path?: string) => T;
  safeParse: (input: unknown) =>
    | { success: true; data: T }
    | { success: false; error: ContractValidationError };
};
export type Infer<S> = S extends Schema<infer T> ? T : never;

export function schema<T>(parse: (input: unknown, path: string) => T): Schema<T> {
  return {
    parse: (input, path = '$') => parse(input, path),
    safeParse(input) {
      try {
        return { success: true, data: parse(input, '$') };
      } catch (error) {
        if (!(error instanceof ContractValidationError)) throw error;
        return { success: false, error };
      }
    },
  };
}

export function refine<T>(base: Schema<T>, check: (value: T, path: string) => void): Schema<T> {
  return schema((input, path) => {
    const value = base.parse(input, path);
    check(value, path);
    return value;
  });
}

export function textValue(maxBytes: number, nonblank = true): Schema<string> {
  return schema((input, path) => {
    requireContract(typeof input === 'string', path, 'expected a string');
    requireContract(input.isWellFormed(), path, 'expected well-formed Unicode');
    requireContract(!nonblank || input.trim().length > 0, path, 'must not be blank');
    requireContract(Buffer.byteLength(input, 'utf8') <= maxBytes, path, 'UTF-8 byte limit exceeded');
    return input;
  });
}

export function numberValue(min: number, max: number, integer = true): Schema<number> {
  return schema((input, path) => {
    requireContract(typeof input === 'number' && Number.isFinite(input), path, 'expected a finite number');
    requireContract(!integer || Number.isSafeInteger(input), path, 'expected a safe integer');
    requireContract(input >= min && input <= max, path, 'number outside the permitted range');
    return input;
  });
}

export const booleanValue: Schema<boolean> = schema((input, path) => {
  requireContract(typeof input === 'boolean', path, 'expected a boolean');
  return input;
});

export function literal<const T extends string | number | boolean>(expected: T): Schema<T> {
  return schema((input, path) => {
    requireContract(input === expected, path, 'unsupported literal or schema version');
    return expected;
  });
}

export function enumeration<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return schema((input, path) => {
    requireContract(typeof input === 'string' && values.includes(input), path, 'unknown code');
    return input as T[number];
  });
}

export function nullable<T>(item: Schema<T>): Schema<T | null> {
  return schema((input, path) => input === null ? null : item.parse(input, path));
}

export function array<T>(item: Schema<T>, min = 0, max = Number.MAX_SAFE_INTEGER): Schema<T[]> {
  return schema((input, path) => {
    requireContract(Array.isArray(input), path, 'expected an array');
    requireContract(input.length >= min && input.length <= max, path, 'array length outside the permitted range');
    requireContract(Object.getPrototypeOf(input) === Array.prototype, path, 'expected a plain JSON array');
    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      requireContract(typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < input.length,
        path, 'unknown array property');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      requireContract(descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true,
        path, 'expected enumerable array data properties');
    }
    // Array.from visits holes too; sparse arrays must not bypass validation.
    return Array.from(input, (value: unknown, index) => item.parse(value, `${path}[${index}]`));
  });
}

function recordValue(input: unknown, path: string): Record<string, unknown> {
  requireContract(typeof input === 'object' && input !== null && !Array.isArray(input), path, 'expected an object');
  const prototype: unknown = Object.getPrototypeOf(input);
  requireContract(prototype === Object.prototype || prototype === null, path, 'expected a plain JSON object');
  requireContract(Object.getOwnPropertySymbols(input).length === 0, path, 'symbol keys are not allowed');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
    requireContract('value' in descriptor && descriptor.enumerable === true, path, 'expected enumerable data properties');
  }
  return input as Record<string, unknown>;
}

type Shape = Record<string, Schema<unknown>>;
type Fields<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

export function object<R extends Shape, O extends Shape = Record<never, never>>(
  required: R, optional?: O,
): Schema<Fields<R> & Partial<Fields<O>>> {
  return schema((input, path) => {
    const value = recordValue(input, path);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      requireContract(Object.hasOwn(required, key) || Object.hasOwn(optional ?? {}, key), path, 'unknown object key');
    }
    for (const [key, field] of Object.entries(required)) {
      requireContract(Object.hasOwn(value, key), `${path}.${key}`, 'required field missing');
      result[key] = field.parse(value[key], `${path}.${key}`);
    }
    for (const [key, field] of Object.entries(optional ?? {})) {
      if (Object.hasOwn(value, key)) result[key] = field.parse(value[key], `${path}.${key}`);
    }
    return result as Fields<R> & Partial<Fields<O>>;
  });
}

/** A finite-key map; unknown keys are rejected without echoing their contents. */
export function codeMap<const K extends readonly string[], V>(
  keys: K, value: Schema<V>,
): Schema<Partial<Record<K[number], V>>> {
  return schema((input, path) => {
    const entries = recordValue(input, path);
    const result: Partial<Record<K[number], V>> = {};
    for (const key of Object.keys(entries)) {
      requireContract(keys.includes(key), path, 'unknown map key');
      result[key as K[number]] = value.parse(entries[key], `${path}.${key}`);
    }
    return result;
  });
}
