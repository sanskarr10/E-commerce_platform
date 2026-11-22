const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const secured = [{ bearerAuth: [] }];

const problem = (description) => ({ description, content: json(ref('Error')) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
const xCache = { 'X-Cache': { description: 'HIT, MISS or BYPASS (cache unavailable)', schema: { type: 'string' } } };

const authErrors = { 401: problem('Missing or invalid token'), 403: problem('Not an admin') };

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Product Service',
    version: '0.1.0',
    description:
      'Product catalog. Money is an integer in minor units (paise/cents) plus an ISO currency code. ' +
      'Writes require an admin access token issued by the user-service.',
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: { type: 'object', properties: { detail: {} } },
      Category: {
        type: 'object',
        properties: { id: { type: 'integer' }, name: { type: 'string' }, slug: { type: 'string' } },
      },
      Product: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          sku: { type: 'string' },
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          price_minor: { type: 'integer', description: 'Price in minor units, e.g. 49900 = 499.00' },
          currency: { type: 'string', example: 'INR' },
          stock: { type: 'integer' },
          category: { anyOf: [ref('Category'), { type: 'null' }] },
          image_url: { type: ['string', 'null'] },
          is_active: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      ProductPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: ref('Product') },
          total: { type: 'integer' },
          page: { type: 'integer' },
          page_size: { type: 'integer' },
        },
      },
      ProductCreate: {
        type: 'object',
        required: ['sku', 'name', 'price_minor'],
        properties: {
          sku: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
          name: { type: 'string', maxLength: 200 },
          description: { type: ['string', 'null'], maxLength: 5000 },
          price_minor: { type: 'integer', minimum: 0, maximum: 2000000000 },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'INR' },
          stock: { type: 'integer', minimum: 0, default: 0 },
          category_id: { type: ['integer', 'null'] },
          image_url: { type: ['string', 'null'], description: 'http(s) URL' },
          is_active: { type: 'boolean', default: true },
        },
      },
      ProductUpdate: {
        type: 'object',
        description: 'Any subset of the fields below. SKU is immutable; use /stock to change stock.',
        properties: {
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          price_minor: { type: 'integer' },
          currency: { type: 'string' },
          category_id: { type: ['integer', 'null'] },
          image_url: { type: ['string', 'null'] },
          is_active: { type: 'boolean' },
        },
      },
    },
  },
  paths: {
    '/api/products': {
      get: {
        tags: ['products'],
        summary: 'Search and list products (cached)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 }, description: 'Matches name or description' },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Category slug' },
          { name: 'min_price', in: 'query', schema: { type: 'integer' } },
          { name: 'max_price', in: 'query', schema: { type: 'integer' } },
          { name: 'in_stock', in: 'query', schema: { type: 'boolean' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'price_asc', 'price_desc', 'name'], default: 'newest' } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { 200: { description: 'A page of products', headers: xCache, content: json(ref('ProductPage')) }, 422: problem('Invalid query') },
      },
      post: {
        tags: ['products'],
        summary: 'Create a product (admin)',
        security: secured,
        requestBody: { required: true, content: json(ref('ProductCreate')) },
        responses: { 201: { description: 'Created', content: json(ref('Product')) }, ...authErrors, 409: problem('SKU already exists'), 422: problem('Validation error') },
      },
    },
    '/api/products/batch': {
      get: {
        tags: ['products'],
        summary: 'Look up several products at once (not cached)',
        description: 'Used by the order service at checkout. Archived and unknown ids are omitted from the result.',
        parameters: [
          { name: 'ids', in: 'query', required: true, schema: { type: 'string', example: '1,2,3' }, description: 'Comma-separated ids, at most 50' },
        ],
        responses: {
          200: { description: 'Matching active products', content: json({ type: 'object', properties: { items: { type: 'array', items: ref('Product') } } }) },
          422: problem('Invalid ids'),
        },
      },
    },
    '/api/products/{id}': {
      parameters: [idParam],
      get: {
        tags: ['products'],
        summary: 'Get one product (cached)',
        responses: { 200: { description: 'The product', headers: xCache, content: json(ref('Product')) }, 404: problem('Not found or archived') },
      },
      patch: {
        tags: ['products'],
        summary: 'Update a product (admin)',
        security: secured,
        requestBody: { required: true, content: json(ref('ProductUpdate')) },
        responses: { 200: { description: 'Updated', content: json(ref('Product')) }, ...authErrors, 404: problem('Not found'), 422: problem('Validation error') },
      },
      delete: {
        tags: ['products'],
        summary: 'Archive a product (admin, soft delete)',
        security: secured,
        responses: { 204: { description: 'Archived' }, ...authErrors, 404: problem('Not found') },
      },
    },
    '/api/products/{id}/stock': {
      parameters: [idParam],
      patch: {
        tags: ['inventory'],
        summary: 'Atomically add or remove stock (admin)',
        security: secured,
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['delta'], properties: { delta: { type: 'integer', description: 'Positive adds, negative removes' } } }),
        },
        responses: { 200: { description: 'Updated product', content: json(ref('Product')) }, ...authErrors, 404: problem('Not found'), 409: problem('Insufficient stock') },
      },
    },
    '/api/products/categories': {
      get: {
        tags: ['categories'],
        summary: 'List categories (cached)',
        responses: { 200: { description: 'All categories', headers: xCache, content: json({ type: 'array', items: ref('Category') }) } },
      },
      post: {
        tags: ['categories'],
        summary: 'Create a category (admin)',
        security: secured,
        requestBody: { required: true, content: json({ type: 'object', required: ['name'], properties: { name: { type: 'string' } } }) },
        responses: { 201: { description: 'Created', content: json(ref('Category')) }, ...authErrors, 409: problem('Category already exists') },
      },
    },
  },
};
