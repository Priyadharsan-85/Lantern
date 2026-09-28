const { randomUUID } = require('crypto');

const API_BASE = process.env.LANTERN_API_BASE || 'http://localhost:8080/api';
const email = process.env.TEST_CUSTOMER_EMAIL;
const password = process.env.TEST_CUSTOMER_PASSWORD;
const productId = process.env.TEST_PRODUCT_ID;

async function runTest() {
  if (!email || !password || !productId) {
    throw new Error(
      'Set TEST_CUSTOMER_EMAIL, TEST_CUSTOMER_PASSWORD, and TEST_PRODUCT_ID for an active catalog product.'
    );
  }

  const loginResponse = await fetch(`${API_BASE}/auth/customer/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginData = await loginResponse.json();
  if (!loginResponse.ok) {
    throw new Error(loginData.error || `Customer sign-in failed (HTTP ${loginResponse.status})`);
  }

  const cookieHeader = loginResponse.headers.get('set-cookie');
  if (!cookieHeader) throw new Error('Customer sign-in did not return a session cookie');
  const sessionCookie = cookieHeader.split(';', 1)[0];

  const orderResponse = await fetch(`${API_BASE}/order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({
      items: [{ productId, quantity: 1 }],
    }),
  });
  const orderData = await orderResponse.json();
  if (!orderResponse.ok) {
    throw new Error(orderData.error || `Order creation failed (HTTP ${orderResponse.status})`);
  }

  console.log('Order response:', JSON.stringify(orderData, null, 2));
  console.log('Open the checkoutUrl to complete a Stripe sandbox payment.');
}

runTest().catch((err) => {
  console.error('Request failed:', err.message);
  process.exitCode = 1;
});
