// MP fashion bot - file unico. MODE=create (crea bozze) oppure MODE=sync (scorte e prezzi)
const __reg = {}; const __def = {}; const __nodeRequire = require;
function __req(n){ if(!n.startsWith("./")) return __nodeRequire(n); const k=n.slice(2).replace(/\.js$/,""); if(!__reg[k]){ const m={exports:{}}; __def[k](m,m.exports,__req); __reg[k]=m.exports;} return __reg[k]; }
__def["pricing"] = function(module, exports, require){
// Prezzo di vendita IVA inclusa. Mai sotto costo + spese + IVA + margine minimo.
const VAT = Number(process.env.VAT || "0.22");
const SHIPPING = Number(process.env.SHIPPING_COST || "4.00");   // costo spedizione medio a tuo carico
const FEE_PCT = Number(process.env.PAYMENT_FEE_PCT || "0.03");  // commissione pagamento ~3%
const FEE_FIX = Number(process.env.PAYMENT_FEE_FIX || "0.25");
const MARGIN = Number(process.env.MIN_MARGIN || "0.25");        // margine netto minimo sul prezzo senza IVA

// costo = prezzo fornitore IVA esclusa
function sellPrice(cost) {
  const net = (cost + SHIPPING + FEE_FIX) / (1 - FEE_PCT - MARGIN); // prezzo netto
  const gross = net * (1 + VAT);
  return Math.ceil(gross) - 0.10; // es. 17.90
}
function netMargin(cost, gross) {
  const net = gross / (1 + VAT);
  const fees = net * FEE_PCT + FEE_FIX;
  return (net - cost - SHIPPING - fees) / net;
}
module.exports = { sellPrice, netMargin };

};
__def["shopifyAuth"] = function(module, exports, require){
// Token Shopify. Due modi:
//  - SHOPIFY_TOKEN (app legacy, token fisso)
//  - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (app Dev Dashboard, token che scade dopo 24h:
//    lo richiediamo a ogni esecuzione, che dura pochi minuti)
let cached;
module.exports = async function token() {
  const { SHOPIFY_TOKEN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_STORE = "zg1yry-ep" } = process.env;
  if (SHOPIFY_TOKEN) return SHOPIFY_TOKEN;
  if (cached) return cached;
  const r = await fetch(`https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Token Shopify non ottenuto: " + JSON.stringify(j));
  return (cached = j.access_token);
};

};
__def["notify"] = function(module, exports, require){
// Avvisi Telegram (opzionale). Variabili: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
module.exports = async function notify(text) {
  const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (e) { console.error("Telegram:", e.message); }
};

};
__def["describe"] = function(module, exports, require){
// Descrizioni originali in italiano via API Claude (opzionale). Variabile: ANTHROPIC_API_KEY
// Il testo del fornitore e' usato solo come base di fatti, non copiato.
module.exports = async function describe(p) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return p.description || "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
        max_tokens: 600,
        messages: [{ role: "user", content:
          `Scrivi una descrizione di vendita in italiano, originale, max 90 parole, in HTML semplice (<p> e <ul><li>). ` +
          `Usa SOLO i fatti presenti qui sotto, non inventare caratteristiche, certificazioni o garanzie.\n` +
          `Titolo: ${p.title}\nDati fornitore: ${(p.description || "").replace(/<[^>]+>/g, " ").slice(0, 1500)}` }],
      }),
    });
    const j = await r.json();
    return j.content?.[0]?.text || p.description || "";
  } catch (e) { console.error("Claude:", e.message); return p.description || ""; }
};

};
__def["bigbuy"] = function(module, exports, require){
// Adattatore BigBuy -> formato del bot. Endpoint dalla guida ufficiale BigBuy.
// NON verificato con una chiave reale: provalo prima su sandbox (BIGBUY_SANDBOX=1).
const KEY = process.env.BIGBUY_KEY;
const BASE = process.env.BIGBUY_SANDBOX ? "https://api.sandbox.bigbuy.eu" : "https://api.bigbuy.eu";
const TAXONOMY = process.env.BIGBUY_TAXONOMY; // ID categoria (vedi /rest/catalog/taxonomies.json)
const { sellPrice } = require("./pricing");

async function get(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`BigBuy ${path} -> ${r.status}`);
  return r.json();
}

module.exports = async function loadBigBuy() {
  if (!KEY || !TAXONOMY) throw new Error("Mancano BIGBUY_KEY o BIGBUY_TAXONOMY");
  const q = `parentTaxonomy=${TAXONOMY}`;
  const [products, info, images] = await Promise.all([
    get(`/rest/catalog/products.json?${q}`),
    get(`/rest/catalog/productsinformation.json?isoCode=it&${q}`),
    get(`/rest/catalog/productsimages.json?${q}`),
  ]);
  const infoById = new Map(info.map((i) => [i.id, i]));
  const imgById = new Map(images.map((i) => [i.id, i]));
  return products
    .map((p) => {
      const i = infoById.get(p.id);
      const im = imgById.get(p.id);
      const wholesale = Number(p.wholesalePrice);
      const retail = Number(p.retailPrice);
      if (!i || !wholesale) return null;
      const sell = Math.max(sellPrice(wholesale), 0);
      return {
        id: String(p.id),
        title: i.name,
        description: i.description || "",
        image: im?.images?.[0]?.url || "",
        price: wholesale,        // costo fornitore
        sell_price: sell,        // prezzo di vendita
        vendor: "MP fashion",
      };
    })
    .filter(Boolean);
};

};
__def["bot"] = function(module, exports, require){
// Bot MP fashion: legge un feed di prodotti in sconto e crea BOZZE su Shopify.
// Node 18+, nessuna dipendenza. Eseguito da Render come cron job.
const {
  SHOPIFY_STORE = "zg1yry-ep",      // handle del negozio
  SHOPIFY_TOKEN,                     // Admin API token (write_products, read_products)
  FEED_URL,                          // URL feed JSON (alternativa a BigBuy)
  BIGBUY_KEY,                        // se presente usa BigBuy (vedi bigbuy.js)
  MIN_MARGIN = "0.25",               // margine minimo (solo BigBuy), es. 0.25 = 25%
  MIN_DISCOUNT = "30",               // sconto minimo % per considerare un prodotto
  MARKUP = "1.35",                   // moltiplicatore sul prezzo fornitore
  MAX_PER_RUN = "10",                // max prodotti creati per esecuzione
} = process.env;

if (!(SHOPIFY_TOKEN || process.env.SHOPIFY_CLIENT_ID) || (!FEED_URL && !BIGBUY_KEY)) {
  console.error("Mancano SHOPIFY_TOKEN e FEED_URL/BIGBUY_KEY");
  process.exit(1);
}

const API = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-01/graphql.json`;

async function gql(query, variables = {}) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await require("./shopifyAuth")() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function exists(srcId) {
  const d = await gql(
    `query($q:String!){products(first:1,query:$q){edges{node{id}}}}`,
    { q: `tag:'src-${srcId}'` }
  );
  return d.products.edges.length > 0;
}

const describe = require("./describe");
const notify = require("./notify");

async function create(p) {
  p.description = await describe(p);
  const price = (p.sell_price ?? Number(p.price) * Number(MARKUP)).toFixed(2);
  const d = await gql(
    `mutation($input:ProductInput!,$media:[CreateMediaInput!]){
      productCreate(input:$input,media:$media){
        product{id title variants(first:1){edges{node{id}}}}
        userErrors{field message}
      }}`,
    {
      input: {
        title: p.title,
        descriptionHtml: p.description || "",
        vendor: p.vendor || "MP fashion",
        status: "DRAFT", // sempre bozza: li approvi tu
        tags: [`src-${p.id}`, "bot"],
      },
      media: p.image
        ? [{ originalSource: p.image, mediaContentType: "IMAGE", alt: p.title }]
        : [],
    }
  );
  const err = d.productCreate.userErrors;
  if (err.length) throw new Error(JSON.stringify(err));
  const variantId = d.productCreate.product.variants.edges[0].node.id;
  const productId = d.productCreate.product.id;
  await gql(
    `mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){
      productVariantsBulkUpdate(productId:$pid,variants:$v){userErrors{message}}}`,
    { pid: productId, v: [{ id: variantId, price }] }
  );
  return price;
}

(async () => {
  const feed = BIGBUY_KEY ? await require("./bigbuy")() : await (await fetch(FEED_URL)).json();
  let n = 0;
  for (const p of feed) {
    if (n >= Number(MAX_PER_RUN)) break;
    let disc = 0;
    if (p.sell_price) {
      // modalita' BigBuy: filtra per margine
      if (require("./pricing").netMargin(p.price, p.sell_price) < Number(MIN_MARGIN)) continue;
    } else {
      if (!p.compare_at_price || p.compare_at_price <= p.price) continue;
      disc = (1 - p.price / p.compare_at_price) * 100;
      if (disc < Number(MIN_DISCOUNT)) continue;
    }
    if (await exists(p.id)) continue;
    try {
      const price = await create(p);
      console.log(`Bozza creata: ${p.title} (-${disc.toFixed(0)}%) -> ${price} EUR`);
      n++;
    } catch (e) {
      console.error(`Errore su ${p.id}:`, e.message);
    }
  }
  console.log(`Fine: ${n} bozze create`);
  if (n) await notify(`MP fashion bot: ${n} nuove bozze da approvare su Shopify`);
})();

};
__def["sync"] = function(module, exports, require){
// FASE 1: sincronizza scorte e prezzi dei prodotti del bot (tag "bot") con BigBuy.
// - scorte sotto soglia -> il prodotto torna in BOZZA (ritirato)
// - altrimenti aggiorna prezzo e quantita' su Shopify
// Campi BigBuy NON verificati: prova con BIGBUY_SANDBOX=1 e DRY_RUN=1.
const { SHOPIFY_STORE = "zg1yry-ep", SHOPIFY_TOKEN, BIGBUY_KEY, BIGBUY_TAXONOMY,
  BIGBUY_SANDBOX, MIN_STOCK = "3", DRY_RUN, BOT_ENABLED = "1" } = process.env;
const { sellPrice, netMargin } = require("./pricing");

if (BOT_ENABLED !== "1") { console.log("Bot disattivato (BOT_ENABLED!=1)"); process.exit(0); }
if (!(SHOPIFY_TOKEN || process.env.SHOPIFY_CLIENT_ID) || !BIGBUY_KEY || !BIGBUY_TAXONOMY) { console.error("Mancano variabili"); process.exit(1); }

const API = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-01/graphql.json`;
const BB = BIGBUY_SANDBOX ? "https://api.sandbox.bigbuy.eu" : "https://api.bigbuy.eu";

async function gql(query, variables = {}) {
  const r = await fetch(API, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await require("./shopifyAuth")() },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
async function bb(path) {
  const r = await fetch(BB + path, { headers: { Authorization: `Bearer ${BIGBUY_KEY}` } });
  if (!r.ok) throw new Error(`BigBuy ${path} -> ${r.status}`);
  return r.json();
}

async function shopifyBotProducts() {
  const out = []; let after = null;
  do {
    const d = await gql(`query($after:String){products(first:50,after:$after,query:"tag:bot"){
      pageInfo{hasNextPage endCursor}
      edges{node{id tags status variants(first:1){edges{node{id price inventoryItem{id tracked}}}}}}}}`, { after });
    d.products.edges.forEach((e) => out.push(e.node));
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  return out;
}

(async () => {
  const q = `parentTaxonomy=${BIGBUY_TAXONOMY}`;
  const [prices, stocks] = await Promise.all([
    bb(`/rest/catalog/products.json?${q}`),
    bb(`/rest/catalog/productsstockbyhandlingdays.json?${q}`),
  ]);
  const costById = new Map(prices.map((p) => [String(p.id), Number(p.wholesalePrice)]));
  const stockById = new Map(stocks.map((s) => [String(s.id),
    (s.stocks || []).reduce((a, x) => a + Number(x.quantity || 0), 0)]));

  const loc = (await gql(`query{locations(first:1){edges{node{id}}}}`)).locations.edges[0].node.id;
  const products = await shopifyBotProducts();
  let upd = 0, off = 0;

  for (const p of products) {
    const tag = p.tags.find((t) => t.startsWith("src-"));
    if (!tag) continue;
    const id = tag.slice(4);
    const cost = costById.get(id), stock = stockById.get(id) ?? 0;
    const v = p.variants.edges[0].node;
    try {
      if (!cost || stock < Number(MIN_STOCK)) {
        if (p.status === "ACTIVE") {
          console.log(`RITIRO ${id}: stock=${stock}`);
          if (!DRY_RUN) await gql(`mutation($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{message}}}`,
            { product: { id: p.id, status: "DRAFT" } });
          off++;
        }
        continue;
      }
      const price = sellPrice(cost);
      if (netMargin(cost, price) < 0) { console.log(`SALTO ${id}: margine negativo`); continue; }
      console.log(`AGGIORNO ${id}: costo=${cost} prezzo=${price} stock=${stock}`);
      if (DRY_RUN) continue;
      if (!v.inventoryItem.tracked)
        await gql(`mutation($id:ID!,$input:InventoryItemInput!){inventoryItemUpdate(id:$id,input:$input){userErrors{message}}}`,
          { id: v.inventoryItem.id, input: { tracked: true } });
      await gql(`mutation($pid:ID!,$v:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$pid,variants:$v){userErrors{message}}}`,
        { pid: p.id, v: [{ id: v.id, price: price.toFixed(2) }] });
      await gql(`mutation($input:InventorySetQuantitiesInput!){inventorySetQuantities(input:$input){userErrors{message}}}`,
        { input: { name: "available", reason: "correction", ignoreCompareQuantity: true,
          quantities: [{ inventoryItemId: v.inventoryItem.id, locationId: loc, quantity: stock }] } });
      upd++;
    } catch (e) { console.error(`Errore ${id}:`, e.message); }
  }
  if (off) await require("./notify")(`MP fashion bot: ${off} prodotti ritirati (scorte finite)`);
  console.log(`Sync finita: ${upd} aggiornati, ${off} ritirati${DRY_RUN ? " (DRY RUN)" : ""}`);
})();

};
const __mode = process.env.MODE === "sync" ? "sync" : "bot";
__req("./" + __mode);
