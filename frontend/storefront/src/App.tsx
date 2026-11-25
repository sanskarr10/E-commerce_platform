import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AuthPage } from './pages/AuthPage';
import { CartPage } from './pages/CartPage';
import { Catalog } from './pages/Catalog';
import { CheckoutPage } from './pages/CheckoutPage';
import { OrderPage } from './pages/OrderPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrdersPage } from './pages/OrdersPage';
import { ProductPage } from './pages/ProductPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Catalog />} />
        <Route path="products/:id" element={<ProductPage />} />
        <Route path="cart" element={<CartPage />} />
        <Route path="login" element={<AuthPage mode="login" />} />
        <Route path="register" element={<AuthPage mode="register" />} />
        <Route path="checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
        <Route path="notifications" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
        <Route path="orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
        <Route path="orders/:id" element={<RequireAuth><OrderPage /></RequireAuth>} />
        <Route path="*" element={<p>Page not found. <a href="/">Back to the catalog</a></p>} />
      </Route>
    </Routes>
  );
}
