# nfc.installsmart.ai

NFC tap card ordering site for InstallSmart.AI. £25 per card plus £3.95 Royal Mail Tracked 48, UK only.

## How an order flows

1. Customer fills in the form on nfc.installsmart.ai (platform, link or @handle, name, email).
2. The form emails an “order started” note to sat@installsmart.ai through Web3Forms (same key as installsmart.ai) and sends the customer to the Stripe payment link with an order reference (for example `NFC-IG-7K2QXM`) and their email filled in.
3. Stripe takes payment, collects the UK delivery address, phone and the profile link again, then returns the customer to `/thanks.html`.
4. The `worker/` Cloudflare Worker receives Stripe’s `checkout.session.completed` webhook, creates the order in Royal Mail Click & Drop and emails the paid order to sat@installsmart.ai and madi@byerim.com.

Stripe payment link: https://buy.stripe.com/cNi00c1fyaQn1AzghH5ZC0s (`plink_1UfS3A2NFW59QiEipiyfRVth`, Clearlegacy + installsmart.ai account).

## Hosting

GitHub Pages from `main`, custom domain in `CNAME`. DNS at Namecheap: `CNAME nfc → s7ssl.github.io`.

## Worker set-up (one time, on the Mac)

1. Click & Drop: Settings → Integrations → Add → Click & Drop API. Copy the API key.
2. Resend (resend.com): add the domain installsmart.ai, put its DNS records in Namecheap, create an API key.
3. Stripe: Developers → Restricted keys → new key with Checkout Sessions read only.
4. Deploy and set secrets:

```
cd worker && npx wrangler deploy && npx wrangler secret put CLICKDROP_API_KEY && npx wrangler secret put RESEND_API_KEY && npx wrangler secret put STRIPE_SECRET_KEY
```

5. Stripe: Developers → Webhooks → add endpoint `https://nfc-orders.<your-subdomain>.workers.dev/stripe`, event `checkout.session.completed`. Copy the signing secret, then:

```
cd worker && npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

6. Once you know your Tracked 48 service code in Click & Drop, put it in `CD_SERVICE_CODE` in `wrangler.toml` and redeploy. Left blank, orders arrive in Click & Drop and you pick the service there.

Health check: `https://nfc-orders.<your-subdomain>.workers.dev/health` returns `ok`.
