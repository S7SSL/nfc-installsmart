// nfc-orders: Stripe "checkout.session.completed" webhook for nfc.installsmart.ai
// 1. Verifies the Stripe signature
// 2. Creates the order in Royal Mail Click & Drop (ready to print the label)
// 3. Emails the order to sat@installsmart.ai and madi@byerim.com
//
// Secrets (wrangler secret put ...):
//   STRIPE_WEBHOOK_SECRET  whsec_...   (from the Stripe webhook endpoint)
//   STRIPE_SECRET_KEY      rk_live_... (restricted key: Checkout Sessions read)
//   CLICKDROP_API_KEY      Click & Drop > Settings > Integrations > Click & Drop API
//   RESEND_API_KEY         re_...      (Resend, with installsmart.ai verified)
// Vars (wrangler.toml): PAYMENT_LINK_ID, NOTIFY_TO, FROM_EMAIL, CD_SERVICE_CODE,
//   CD_PACKAGE_FORMAT, CARD_WEIGHT_G

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return new Response('ok');
    // One-off go-live self-test. Switches itself off at SELFTEST_UNTIL.
    if (request.method === 'GET' && url.pathname === '/selftest') {
      if (!env.SELFTEST_UNTIL || Date.now() > Date.parse(env.SELFTEST_UNTIL)) return new Response('Not found', { status: 404 });
      const order = {
        ref: 'NFC-TEST-GOLIVE', sessionId: 'selftest', qty: 1, link: 'https://www.instagram.com/installsmart.ai/', platform: 'Instagram',
        name: 'TEST ORDER Do Not Post', business: 'InstallSmart test', email: 'sat@installsmart.ai', phone: '',
        address: { line1: '86-90 Paul Street', line2: '', city: 'London', state: '', postal_code: 'EC2A 4NE', country: 'GB' },
        subtotal: 25, shipping: 3.95, total: 28.95, created: new Date().toISOString(),
      };
      const cd = env.CLICKDROP_API_KEY ? await createClickDrop(order, env) : { ok: false, detail: 'no key' };
      const mail = url.searchParams.get('mail') === '0' ? { skipped: true } : env.RESEND_API_KEY ? await sendEmail(order, cd, env) : { ok: false, detail: 'no key' };
      return json({ selftest: true, keys: { clickdrop: !!env.CLICKDROP_API_KEY, resend: !!env.RESEND_API_KEY, stripe: !!env.STRIPE_SECRET_KEY, webhook: !!env.STRIPE_WEBHOOK_SECRET }, cd, mail });
    }
    if (request.method !== 'POST' || url.pathname !== '/stripe') return new Response('Not found', { status: 404 });

    const body = await request.text();
    const ok = await verifyStripe(body, request.headers.get('stripe-signature'), (env.STRIPE_WEBHOOK_SECRET || '').trim());
    if (!ok) return new Response('Bad signature', { status: 400 });

    const event = JSON.parse(body);
    if (event.type !== 'checkout.session.completed') return json({ ignored: event.type });
    const s = event.data.object;
    if (env.PAYMENT_LINK_ID && s.payment_link !== env.PAYMENT_LINK_ID) return json({ ignored: 'other payment link' });
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return json({ ignored: 'not paid yet' });

    const order = await buildOrder(s, env);

    let cd = { ok: false, detail: 'CLICKDROP_API_KEY not set' };
    if (env.CLICKDROP_API_KEY) cd = await createClickDrop(order, env);

    let mail = { ok: false, detail: 'RESEND_API_KEY not set' };
    if (env.RESEND_API_KEY) mail = await sendEmail(order, cd, env);

    // Only ask Stripe to retry if Click & Drop failed for a temporary reason
    if (!cd.ok && cd.retry) return json({ cd, mail }, 500);
    return json({ ref: order.ref, cd, mail });
  },
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
}

async function verifyStripe(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = parts.t;
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => timingSafeEqual(s, hex));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function buildOrder(s, env) {
  let qty = 1;
  if (env.STRIPE_SECRET_KEY) {
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${s.id}/line_items?limit=10`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const li = await r.json();
      qty = (li.data || []).reduce((n, i) => n + (i.quantity || 0), 0) || 1;
    } catch (_) { /* default to 1 */ }
  }
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
  const addr = ship.address || (s.customer_details && s.customer_details.address) || {};
  const cust = s.customer_details || {};
  const field = (s.custom_fields || []).find((f) => /profile/i.test(f.key)) || {};
  const link = cleanLink((field.text && field.text.value) || '');
  const ref = s.client_reference_id || `NFC-${s.id.slice(-8).toUpperCase()}`;
  const platform = /NFC-GBP/.test(ref) ? 'Google Business Profile' : /NFC-IG/.test(ref) ? 'Instagram' : /NFC-TT/.test(ref) ? 'TikTok' : guessPlatform(link);
  const shipping = (s.shipping_cost && s.shipping_cost.amount_total) || 395;
  return {
    ref, sessionId: s.id, qty, link, platform,
    name: ship.name || cust.name || '',
    business: (cust.business_name) || '',
    email: cust.email || '',
    phone: cust.phone || '',
    address: addr,
    billing: (cust.address && cust.address.line1) ? cust.address : null,
    billName: cust.name || '',
    subtotal: (s.amount_subtotal || 2500) / 100,
    shipping: shipping / 100,
    total: (s.amount_total || 2895) / 100,
    created: new Date((s.created || Date.now() / 1000) * 1000).toISOString(),
  };
}

function cleanLink(v) {
  const t = String(v).trim();
  if (/^https?:\/\/(www\.)?(instagram|tiktok)\.com\//i.test(t)) return t.split(/[?#]/)[0];
  return t;
}

function guessPlatform(link) {
  if (/tiktok/i.test(link)) return 'TikTok';
  if (/instagram|^@/i.test(link)) return 'Instagram';
  if (/google|g\.page|maps/i.test(link)) return 'Google Business Profile';
  return 'Check link';
}

async function createClickDrop(o, env) {
  const weight = Number(env.CARD_WEIGHT_G || 15) * o.qty;
  const item = {
    orderReference: o.ref.slice(0, 40),
    recipient: {
      address: {
        fullName: o.name.slice(0, 210),
        companyName: o.business.slice(0, 100) || undefined,
        addressLine1: (o.address.line1 || '').slice(0, 100),
        addressLine2: (o.address.line2 || '').slice(0, 100) || undefined,
        city: (o.address.city || '').slice(0, 100),
        county: (o.address.state || '').slice(0, 100) || undefined,
        postcode: (o.address.postal_code || '').slice(0, 20),
        countryCode: o.address.country || 'GB',
      },
      phoneNumber: o.phone || undefined,
      emailAddress: o.email || undefined,
    },
    billing: {
      address: {
        fullName: (o.billName || o.name).slice(0, 210),
        companyName: o.business.slice(0, 100) || undefined,
        addressLine1: ((o.billing || o.address).line1 || '').slice(0, 100),
        addressLine2: ((o.billing || o.address).line2 || '').slice(0, 100) || undefined,
        city: ((o.billing || o.address).city || '').slice(0, 100),
        county: ((o.billing || o.address).state || '').slice(0, 100) || undefined,
        postcode: ((o.billing || o.address).postal_code || '').slice(0, 20),
        countryCode: (o.billing || o.address).country || 'GB',
      },
      phoneNumber: o.phone || undefined,
      emailAddress: o.email || undefined,
    },
    orderDate: o.created,
    subtotal: o.subtotal,
    shippingCostCharged: o.shipping,
    total: o.total,
    currencyCode: 'GBP',
    packages: [{
      weightInGrams: weight,
      packageFormatIdentifier: env.CD_PACKAGE_FORMAT || 'largeLetter',
      contents: [{
        name: "NFC Tap Card (black)",
        SKU: 'NFC-CARD-BLK',
        quantity: o.qty,
        unitValue: 25,
        unitWeightInGrams: Number(env.CARD_WEIGHT_G || 15),
      }],
    }],
    postageDetails: {
      sendNotificationsTo: 'recipient',
      ...(env.CD_SERVICE_CODE ? { serviceCode: env.CD_SERVICE_CODE } : {}),
    },
    specialInstructions: `Programme ${o.qty} card(s) to ${o.platform}: ${o.link}`.slice(0, 500),
  };
  try {
    const r = await fetch('https://api.parcel.royalmail.com/api/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CLICKDROP_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [item] }),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    const created = data && data.createdOrders && data.createdOrders.length;
    return { ok: r.ok && !!created, status: r.status, retry: r.status >= 500 || r.status === 429, detail: created ? `Order ${data.createdOrders[0].orderIdentifier}` : JSON.stringify((data && data.failedOrders && data.failedOrders[0] && data.failedOrders[0].errors) || data).slice(0, 1500) };
  } catch (e) {
    return { ok: false, retry: true, detail: String(e) };
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function sendEmail(o, cd, env) {
  const a = o.address;
  const addr = [o.name, o.business, a.line1, a.line2, a.city, a.state, a.postal_code].filter(Boolean).map(esc).join('<br>');
  const linkHtml = /^https?:\/\//i.test(o.link) ? `<a href="${esc(o.link)}" style="color:#0a66c2">${esc(o.link)}</a>` : esc(o.link);
  const row = (k, v) => `<tr><td style="padding:8px 14px 8px 0;color:#555;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:8px 0;color:#111">${v}</td></tr>`;
  const cdLine = cd.ok
    ? `Created in Click &amp; Drop (${esc(cd.detail)}). Print the label there.`
    : `Not created in Click &amp; Drop: ${esc(cd.detail)}. Please add it by hand.`;
  const html = `<div style="font-family:Verdana,Geneva,sans-serif;font-size:14px;line-height:1.6;color:#111;max-width:600px">
<p style="font-size:18px;font-weight:bold;margin:0 0 4px">New NFC card order ${esc(o.ref)}</p>
<p style="margin:0 0 18px;color:#555">Paid £${o.total.toFixed(2)} by Stripe</p>
<table style="border-collapse:collapse;font-size:14px">
${row('Opens', esc(o.platform))}
${row('Programme to', linkHtml)}
${row('Quantity', String(o.qty))}
${row('Customer', esc(o.name) + (o.business ? ` (${esc(o.business)})` : ''))}
${row('Email', `<a href="mailto:${esc(o.email)}" style="color:#0a66c2">${esc(o.email)}</a>`)}
${row('Phone', esc(o.phone))}
${row('Deliver to', addr)}
${row('Postage', 'Royal Mail Tracked 48')}
${row('Royal Mail', cdLine)}
</table>
<p style="margin:22px 0 0"><a href="https://dashboard.stripe.com/payments?query=${encodeURIComponent(o.email)}" style="display:inline-block;background:#00a3b8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:4px;margin-right:8px">Open in Stripe</a><a href="https://business.parcel.royalmail.com/orders/" style="display:inline-block;background:#da202a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:4px">Open Click &amp; Drop</a></p>
<p style="margin:22px 0 0;color:#777;font-size:12px">Stripe session ${esc(o.sessionId)}</p>
</div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'InstallSmart NFC <orders@installsmart.ai>',
        to: (env.NOTIFY_TO || 'sat@installsmart.ai,madi@byerim.com').split(',').map((x) => x.trim()),
        reply_to: o.email || undefined,
        subject: `${o.sessionId === 'selftest' ? 'TEST, please ignore: ' : ''}NFC order ${o.ref}: ${o.qty} x ${o.platform} for ${o.name}`,
        html,
      }),
    });
    return { ok: r.ok, status: r.status, detail: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}
