import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApiClient } from './api';
import { AuthProvider, useAuth } from './auth';
import { mockFetch } from './test-utils';

const me = { id: 'u1', email: 'a@b.co', full_name: 'Asha', role: 'customer', is_active: true, created_at: '' };

function Probe() {
  const { status, user, login, logout } = useAuth();
  return (
    <div>
      <p>status:{status}</p>
      <p>user:{user?.full_name ?? 'none'}</p>
      <button onClick={() => void login('a@b.co', 'pw')}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

const setup = (routes: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(routes);
  const api = createApiClient({ fetchImpl: m.fetch });
  render(<AuthProvider api={api}><Probe /></AuthProvider>);
  return m;
};

it('restores the session from the refresh cookie on load', async () => {
  setup({ 'POST /api/users/refresh': { body: { access_token: 't' } }, 'GET /api/users/me': { body: me } });
  expect(await screen.findByText('status:authenticated')).toBeInTheDocument();
  expect(screen.getByText('user:Asha')).toBeInTheDocument();
});

it('is anonymous when there is no valid refresh cookie', async () => {
  setup({ 'POST /api/users/refresh': { status: 401, body: { detail: 'no' } } });
  expect(await screen.findByText('status:anonymous')).toBeInTheDocument();
});

it('logs in and out', async () => {
  const m = setup({
    'POST /api/users/refresh': { status: 401 },
    'POST /api/users/login': { body: { access_token: 't', token_type: 'bearer', expires_in: 900 } },
    'GET /api/users/me': { body: me },
    'POST /api/users/logout': { status: 204 },
  });
  await screen.findByText('status:anonymous');
  await userEvent.click(screen.getByText('login'));
  expect(await screen.findByText('status:authenticated')).toBeInTheDocument();
  await userEvent.click(screen.getByText('logout'));
  await waitFor(() => expect(screen.getByText('status:anonymous')).toBeInTheDocument());
  expect(m.calls.some((c) => c.url === '/api/users/logout')).toBe(true);
});
