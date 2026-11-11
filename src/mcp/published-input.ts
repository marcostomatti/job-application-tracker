import { z, type ZodType } from 'zod'

/**
 * The input schema a client is shown for a tool, when the tool's own schema is a union.
 *
 * MCP lists a tool's input as one JSON Schema object. The SDK can list a Zod object, but a
 * union (such as the registry tools', where the registry name picks the row's shape) is listed
 * with no properties at all. A client then cannot tell that `patch` is an object, and may send
 * it as text. This builds one object that names every field any branch has, merged field by
 * field (see `mergeField`).
 *
 * The result is looser than the union, because it does not tie a field's shape to the
 * discriminator. `registerTools` therefore parses each call with the tool's own schema as well,
 * so the published object only tells a client what to send and never widens what is accepted.
 *
 * A schema that is not a union of objects is returned as it is, because the SDK lists it already.
 */
export function publishedInput(schema: ZodType): ZodType {
  if (!(schema instanceof z.ZodUnion)) return schema
  const branches: readonly unknown[] = schema.options
  if (branches.length === 0 || !branches.every((branch) => branch instanceof z.ZodObject)) return schema
  return mergeObjects(branches as readonly z.ZodObject[])
}

/**
 * The objects as one: every field any of them has, required only when all of them have it.
 * It is strict, as each branch is, so a field no branch knows is refused here already.
 */
function mergeObjects(objects: readonly z.ZodObject[]): z.ZodObject {
  const shapes = objects.map((object) => object.shape)
  const fields = [...new Set(shapes.flatMap((shape) => Object.keys(shape)))]
  const merged = fields.map((field): [string, z.ZodType] => {
    const own = shapes.map((shape) => shape[field]).filter((schema) => schema !== undefined)
    const schema = mergeField(own)
    return [field, own.length === shapes.length ? schema : schema.optional()]
  })
  return z.strictObject(Object.fromEntries(merged))
}

/**
 * One field across the branches that have it. The same schema everywhere stays itself, so its
 * own refusal message (a NUL in a label, a key that cannot change) still reaches the caller.
 * Literals (the discriminator) become one enum. Objects are merged as above, and arrays of
 * objects by their items, with the array's own bounds left to the tool's own parse. Anything
 * else becomes a union of the schemas.
 */
function mergeField(schemas: readonly z.ZodType[]): z.ZodType {
  const distinct = [...new Set(schemas)]
  const [first, ...rest] = distinct
  if (first === undefined) throw new Error('a field with no schema cannot be merged')
  if (rest.length === 0) return first
  if (distinct.every((schema) => schema instanceof z.ZodLiteral)) return literalsAsEnum(distinct as readonly z.ZodLiteral[]) ?? z.union([first, ...rest])
  const inner = distinct.map(unwrapOptional)
  const objects = inner.filter((schema): schema is z.ZodObject => schema instanceof z.ZodObject)
  if (objects.length === inner.length) return withOptional(distinct, mergeObjects(objects))
  const arrays = inner.filter(isArrayOfObjects)
  if (arrays.length === inner.length) return withOptional(distinct, z.array(mergeObjects(arrays.map((array) => array.element))))
  return z.union([first, ...rest])
}

/** The values of string literals as one enum, or `undefined` when one of them is not a string. */
function literalsAsEnum(literals: readonly z.ZodLiteral[]): z.ZodType | undefined {
  const values = literals.flatMap((literal) => [...literal.values])
  if (!values.every((value): value is string => typeof value === 'string')) return undefined
  const [first, ...rest] = values
  return first === undefined ? undefined : z.enum([first, ...rest])
}

function isArrayOfObjects(schema: z.ZodType): schema is z.ZodArray<z.ZodObject> {
  return schema instanceof z.ZodArray && schema.element instanceof z.ZodObject
}

function unwrapOptional(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema
}

/** The merged schema, optional when any of the originals was. */
function withOptional(originals: readonly z.ZodType[], merged: z.ZodType): z.ZodType {
  return originals.some((schema) => schema instanceof z.ZodOptional) ? merged.optional() : merged
}
