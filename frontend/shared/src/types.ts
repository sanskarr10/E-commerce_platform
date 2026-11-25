/** Shapes returned by the backend services (see each service's OpenAPI docs). */

export type Role = 'customer' | 'admin';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  /** Integer minor units: 49900 = 499.00 */
  price_minor: number;
  currency: string;
  stock: number;
  category: Category | null;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export type OrderStatus =
  | 'PENDING'
  | 'STOCK_RESERVED'
  | 'PAID'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface OrderItem {
  product_id: number;
  sku: string;
  name: string;
  unit_price_minor: number;
  quantity: number;
}

export interface StatusChange {
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  reason: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  user_id: string;
  status: OrderStatus;
  total_minor: number;
  currency: string;
  cancel_reason: string | null;
  items: OrderItem[];
  created_at: string;
  updated_at: string;
}

export interface OrderDetail extends Order {
  history: StatusChange[];
}

export interface Payment {
  id: string;
  order_id: string;
  user_id: string;
  amount_minor: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  provider_ref: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppNotification {
  id: string;
  type: 'order.confirmed' | 'order.shipped' | 'order.delivered' | 'order.cancelled';
  order_id: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface NotificationPage extends Page<AppNotification> {
  /** Unread across ALL pages, not just this one. */
  unread: number;
}

export interface ProductFilters {
  q?: string;
  category?: string;
  min_price?: number;
  max_price?: number;
  in_stock?: boolean;
  sort?: 'newest' | 'price_asc' | 'price_desc' | 'name';
  page?: number;
  page_size?: number;
}

export interface ProductInput {
  sku: string;
  name: string;
  description?: string | null;
  price_minor: number;
  currency?: string;
  stock?: number;
  category_id?: number | null;
  image_url?: string | null;
  is_active?: boolean;
}

export type ProductPatch = Partial<Omit<ProductInput, 'sku' | 'stock'>>;
