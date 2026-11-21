import { z } from 'zod';

const MAX_PRICE = 2_000_000_000; // fits INT UNSIGNED
const MAX_STOCK = 1_000_000;

const queryInt = (min, max) => z.coerce.number().int().min(min).max(max);

const httpUrl = z
  .string()
  .max(500)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:'; // blocks javascript: and data: URLs
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL');

// Field definitions are shared by create and update. Defaults are NOT declared here: a default
// inside a PATCH schema would silently reset fields the client did not send.
const fields = {
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'Use letters, digits, dot, dash or underscore (max 64)'),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).nullable(),
  price_minor: z.number().int().min(0).max(MAX_PRICE),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter uppercase ISO currency code'),
  category_id: z.number().int().positive().nullable(),
  image_url: httpUrl.nullable(),
  is_active: z.boolean(),
};

export const createProductSchema = z
  .object({
    sku: fields.sku,
    name: fields.name,
    price_minor: fields.price_minor,
    description: fields.description.optional(),
    currency: fields.currency.optional(),
    stock: z.number().int().min(0).max(MAX_STOCK).optional(),
    category_id: fields.category_id.optional(),
    image_url: fields.image_url.optional(),
    is_active: fields.is_active.optional(),
  })
  .strict();

// SKU is immutable (orders reference products) and stock only changes through the stock endpoint.
export const updateProductSchema = z
  .object({
    name: fields.name.optional(),
    description: fields.description.optional(),
    price_minor: fields.price_minor.optional(),
    currency: fields.currency.optional(),
    category_id: fields.category_id.optional(),
    image_url: fields.image_url.optional(),
    is_active: fields.is_active.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export const stockSchema = z
  .object({
    delta: z
      .number()
      .int()
      .min(-MAX_STOCK)
      .max(MAX_STOCK)
      .refine((value) => value !== 0, 'delta must not be 0'),
  })
  .strict();

export const categorySchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

export const idSchema = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'Must be a positive integer')
  .transform(Number);

export const listQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((value) => value || undefined),
    category: z
      .string()
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a category slug')
      .optional(),
    min_price: queryInt(0, MAX_PRICE).optional(),
    max_price: queryInt(0, MAX_PRICE).optional(),
    in_stock: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc', 'name']).default('newest'),
    page: queryInt(1, 100_000).default(1),
    page_size: queryInt(1, 100).default(20),
  })
  .refine(
    (value) =>
      value.min_price === undefined || value.max_price === undefined || value.min_price <= value.max_price,
    { message: 'min_price must be <= max_price', path: ['min_price'] },
  );

export function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
