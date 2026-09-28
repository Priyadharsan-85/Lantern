import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  checkCustomerSession,
  createOrder,
  fetchProducts,
  loginCustomer,
  logoutCustomer,
  registerCustomer,
} from './api';
import './Shop.css';

const formatInr = (minorUnits) => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
}).format(Number(minorUnits) / 100);

function CustomerAccess({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = mode === 'register'
        ? await registerCustomer(email, password)
        : await loginCustomer(email, password);
      onAuthenticated(result.customer);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shop-access">
      <form className="shop-access__card" onSubmit={handleSubmit}>
        <a className="shop-brand" href="/shop"><span className="brand-mark" />lantern</a>
        <p className="shop-eyebrow">Customer account</p>
        <h1>{mode === 'register' ? 'Create your account' : 'Welcome back'}</h1>
        <p className="shop-muted">
          {mode === 'register'
            ? 'Create an account to browse and securely check out.'
            : 'Sign in to continue to the storefront.'}
        </p>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={254}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={mode === 'register' ? 12 : undefined}
            maxLength={128}
            required
          />
          {mode === 'register' && <span className="shop-field-hint">Use at least 12 characters.</span>}
        </label>
        {error && <p className="shop-error" role="alert">{error}</p>}
        <button className="shop-button shop-button--primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
        </button>
        <button
          className="shop-link-button"
          type="button"
          onClick={() => {
            setMode(mode === 'register' ? 'login' : 'register');
            setError('');
          }}
        >
          {mode === 'register' ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </form>
    </main>
  );
}

function Storefront({ customer }) {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const checkoutResult = new URLSearchParams(window.location.search).get('checkout');

  const loadProducts = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const result = await fetchProducts();
      setProducts(result.products);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchProducts()
      .then((result) => {
        if (active) setProducts(result.products);
      })
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const totalMinor = useMemo(() => products.reduce(
    (total, product) => total + Number(product.priceMinor) * (cart[product.id] || 0),
    0
  ), [products, cart]);
  const cartCount = Object.values(cart).reduce((total, quantity) => total + quantity, 0);

  function adjustQuantity(productId, delta) {
    setCart((current) => {
      const quantity = Math.min(99, Math.max(0, (current[productId] || 0) + delta));
      if (quantity === 0) {
        const next = { ...current };
        delete next[productId];
        return next;
      }
      return { ...current, [productId]: quantity };
    });
  }

  async function handleCheckout() {
    setError('');
    setBusy(true);
    try {
      const items = Object.entries(cart).map(([productId, quantity]) => ({ productId, quantity }));
      const result = await createOrder(items, crypto.randomUUID());
      if (result.checkoutUrl) {
        const checkoutUrl = new URL(result.checkoutUrl);
        if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'checkout.stripe.com') {
          throw new Error('Checkout returned an unexpected payment URL');
        }
        window.location.assign(checkoutUrl.toString());
        return;
      }
      throw new Error('Order started without a Stripe Checkout URL');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await logoutCustomer();
      window.location.reload();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="shop-shell">
      <header className="shop-header">
        <a className="shop-brand" href="/shop"><span className="brand-mark" />lantern</a>
        <a className="shop-dashboard-link" href="/">Trace dashboard</a>
        <div className="shop-customer">
          <span>{customer.email}</span>
          <button className="shop-link-button" type="button" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      <main className="shop-main">
        <section className="shop-hero">
          <p className="shop-eyebrow">Lantern store</p>
          <h1>Thoughtful tools, clearly priced.</h1>
          <p>Prices are shown in INR. Your checkout total is calculated from the current server catalog.</p>
        </section>

        {checkoutResult === 'success' && (
          <div className="shop-notice" role="status">
            Checkout returned successfully. The order is confirmed only after the server receives Stripe’s webhook.
          </div>
        )}
        {checkoutResult === 'cancelled' && (
          <div className="shop-notice" role="status">
            Checkout was cancelled. Review the catalog and add products again when you are ready.
          </div>
        )}
        {error && (
          <div className="shop-error-banner" role="alert">
            <span>{error}</span>
            <button className="shop-link-button" type="button" onClick={loadProducts}>Retry</button>
          </div>
        )}

        <div className="shop-layout">
          <section className="shop-products" aria-label="Products">
            <div className="shop-section-heading">
              <div>
                <p className="shop-eyebrow">Catalog</p>
                <h2>Available products</h2>
              </div>
              <span className="shop-muted">{products.length} products</span>
            </div>

            {loading ? (
              <p className="shop-muted" role="status">Loading products…</p>
            ) : products.length === 0 ? (
              <div className="shop-empty">
                <h3>The catalog is being prepared</h3>
                <p>There are no active products yet. Please check back later.</p>
                <button className="shop-button" type="button" onClick={loadProducts}>Refresh catalog</button>
              </div>
            ) : (
              <div className="shop-product-grid">
                {products.map((product) => (
                  <article className="shop-product" key={product.id}>
                    <div className="shop-product__art" aria-hidden="true"><span>l</span></div>
                    <p className="shop-eyebrow">INR · {product.id}</p>
                    <h3>{product.name}</h3>
                    {product.description && <p className="shop-muted">{product.description}</p>}
                    <div className="shop-product__footer">
                      <strong>{formatInr(product.priceMinor)}</strong>
                      <button
                        className="shop-button shop-button--primary"
                        type="button"
                        onClick={() => adjustQuantity(product.id, 1)}
                        aria-label={`Add ${product.name} to cart`}
                      >
                        Add to cart
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <aside className="shop-cart" aria-label="Shopping cart">
            <div className="shop-section-heading">
              <div>
                <p className="shop-eyebrow">Your selection</p>
                <h2>Cart <span className="shop-cart-count">{cartCount}</span></h2>
              </div>
            </div>
            {cartCount === 0 ? (
              <p className="shop-muted">Your cart is empty.</p>
            ) : (
              <div className="shop-cart__items">
                {products.filter((product) => cart[product.id]).map((product) => (
                  <div className="shop-cart-item" key={product.id}>
                    <div>
                      <strong>{product.name}</strong>
                      <span>{formatInr(product.priceMinor)} each</span>
                    </div>
                    <div className="shop-quantity">
                      <button type="button" onClick={() => adjustQuantity(product.id, -1)} aria-label={`Remove one ${product.name}`}>−</button>
                      <span>{cart[product.id]}</span>
                      <button type="button" onClick={() => adjustQuantity(product.id, 1)} aria-label={`Add one ${product.name}`}>+</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="shop-cart__total">
              <span>Estimated total</span>
              <strong>{formatInr(totalMinor)}</strong>
            </div>
            <p className="shop-field-hint">Final total is rechecked against active catalog prices on the server.</p>
            <button
              className="shop-button shop-button--primary shop-checkout"
              type="button"
              onClick={handleCheckout}
              disabled={busy || loading || cartCount === 0}
            >
              {busy ? 'Starting secure checkout…' : 'Continue to Stripe Checkout'}
            </button>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default function Shop() {
  const [customer, setCustomer] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    checkCustomerSession()
      .then((result) => setCustomer(result.customer))
      .catch(() => setCustomer(null))
      .finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) {
    return <main className="shop-access" aria-busy="true"><p>Checking customer session…</p></main>;
  }
  if (!customer) return <CustomerAccess onAuthenticated={setCustomer} />;
  return <Storefront customer={customer} />;
}
