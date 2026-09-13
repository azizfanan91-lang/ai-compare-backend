// هاد السكريبت كيتخدم مرة وحدة فقط باش يصاوب "المنتج" و"الخطة" (Plan) عند PayPal
// خدمو من جهازك ولا من Render Shell بـ: node setup-paypal-plan.js
// خاصك تكون حاطط PAYPAL_CLIENT_ID و PAYPAL_SECRET فـ .env قبل ما تخدمو

require('dotenv').config();

async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString('base64');

  const res = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await res.json();
  if (!data.access_token) {
    console.error('ما قدرتش نجيب access token:', data);
    process.exit(1);
  }
  return data.access_token;
}

async function main() {
  console.log('كنجيب access token...');
  const accessToken = await getAccessToken();

  console.log('كنصاوب Product...');
  const productRes = await fetch('https://api-m.paypal.com/v1/catalogs/products', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Azizart AI Compare Premium',
      description: 'اشتراك شهري بلا حدود فمقارنة نماذج الذكاء الاصطناعي',
      type: 'SERVICE',
      category: 'SOFTWARE'
    })
  });
  const product = await productRes.json();
  if (!product.id) {
    console.error('ما قدرتش نصاوب Product:', product);
    process.exit(1);
  }
  console.log('✅ Product ID:', product.id);

  console.log('كنصاوب Plan ($10/شهر)...');
  const planRes = await fetch('https://api-m.paypal.com/v1/billing/plans', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      product_id: product.id,
      name: 'اشتراك شهري - Premium',
      description: 'بلا حدود فالأسئلة، $10 كل شهر',
      billing_cycles: [
        {
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: '10.00', currency_code: 'USD' }
          }
        }
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        payment_failure_threshold: 2
      }
    })
  });
  const plan = await planRes.json();
  if (!plan.id) {
    console.error('ما قدرتش نصاوب Plan:', plan);
    process.exit(1);
  }

  console.log('✅ Plan ID:', plan.id);
  console.log('\n=== خاصك تحط هاد الـ Plan ID فـ Environment Variables ديال Render باسم PAYPAL_PLAN_ID ===');
}

main().catch((err) => {
  console.error('وقع خطأ:', err);
  process.exit(1);
});
