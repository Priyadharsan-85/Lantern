// Run this after starting all 4 services:
//
//   Tab 1: node packages\collector\index.js
//   Tab 2: node services\payment-service\index.js
//   Tab 3: node services\order-service\index.js
//   Tab 4: node services\api-gateway\index.js
//   Tab 5: node test-trace.js

const axios = require('axios');

async function runTest() {
  console.log('Firing test request through all 3 services...\n');

  try {
    const res = await axios.post('http://localhost:3000/order', {
      userId: 'user_123',
      items:  [{ id: 'item_1', qty: 2 }, { id: 'item_2', qty: 1 }],
      amount: 149.99,
    });
    console.log('\nResponse:', JSON.stringify(res.data, null, 2));
    console.log('\nCheck Tab 1 (collector) for the trace waterfall ↑');
  } catch (err) {
    console.error('Request failed:', err.response?.data || err.message);
  }
}

// small delay to let services finish booting
setTimeout(runTest, 500);