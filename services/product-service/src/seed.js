import mysql from 'mysql2/promise';
import { loadConfig } from './config.js';
import { ProductRepository } from './repository.js';
import { slugify } from './validation.js';

const CATEGORIES = ['Electronics', 'Books', 'Home & Kitchen', 'Clothing'];

// Prices are in paise (49900 = INR 499.00).
const PRODUCTS = [
  ['ELEC-001', 'Wireless Earbuds', 'Bluetooth 5.3 earbuds with 24 hour battery case.', 249900, 40, 'Electronics'],
  ['ELEC-002', 'Mechanical Keyboard', 'Tenkeyless keyboard with hot-swappable switches.', 449900, 25, 'Electronics'],
  ['ELEC-003', 'USB-C Fast Charger 65W', 'Compact GaN charger for laptops and phones.', 199900, 100, 'Electronics'],
  ['ELEC-004', '27 inch 4K Monitor', 'IPS panel, 60 Hz, USB-C power delivery.', 2499900, 8, 'Electronics'],
  ['BOOK-001', 'Designing Data-Intensive Applications', 'The standard text on modern distributed systems.', 59900, 60, 'Books'],
  ['BOOK-002', 'The Pragmatic Programmer', 'Classic advice for working developers.', 44900, 45, 'Books'],
  ['BOOK-003', 'Site Reliability Engineering', 'How Google runs production systems.', 54900, 0, 'Books'],
  ['HOME-001', 'Stainless Steel Water Bottle', 'Vacuum insulated, keeps drinks cold for 24 hours.', 69900, 150, 'Home & Kitchen'],
  ['HOME-002', 'Pour-Over Coffee Set', 'Glass dripper, server and 100 filters.', 129900, 30, 'Home & Kitchen'],
  ['HOME-003', 'Cast Iron Skillet 10 inch', 'Pre-seasoned, oven safe.', 159900, 22, 'Home & Kitchen'],
  ['CLTH-001', 'Cotton T-Shirt', 'Heavyweight 220 GSM organic cotton.', 79900, 200, 'Clothing'],
  ['CLTH-002', 'Zip Hoodie', 'Fleece-lined hoodie with two pockets.', 189900, 55, 'Clothing'],
];

/** Idempotent: existing categories and SKUs are left alone, so it is safe to run repeatedly. */
export async function seed(pool) {
  const repo = new ProductRepository(pool);
  const existing = new Map((await repo.listCategories()).map((category) => [category.name, category]));

  for (const name of CATEGORIES) {
    if (!existing.has(name)) existing.set(name, await repo.createCategory(name, slugify(name)));
  }

  let created = 0;
  for (const [sku, name, description, price, stock, categoryName] of PRODUCTS) {
    if (await repo.findBySku(sku)) continue;
    await repo.create({
      sku,
      name,
      description,
      price_minor: price,
      currency: 'INR',
      stock,
      category_id: existing.get(categoryName).id,
      image_url: `https://picsum.photos/seed/${sku.toLowerCase()}/600/600`,
      is_active: true,
    });
    created += 1;
  }
  return { categories: existing.size, productsCreated: created };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { mysql: db } = loadConfig();
  const pool = mysql.createPool({ ...db, timezone: 'Z' });
  seed(pool)
    .then((result) => console.log(`seed complete: ${result.categories} categories, ${result.productsCreated} new products`))
    .catch((err) => {
      console.error(`seed failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
