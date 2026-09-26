// netlify/functions/bids.mjs
//
// Netlify Function (v2 / Fetch API style) served at /.netlify/functions/bids
//
// -----------------------------------------------------------------------------
// REQUEST CONTRACT (documented here because this file was written without
// access to the existing index.html / admin.html source — wire up your
// frontend calls to match this shape, or tell me the exact shape your
// existing frontend already sends and I'll adjust just this file):
//
// GET  /.netlify/functions/bids
//      -> public status: { highestBid, highestBrand, bids: [public-safe],
//                           activeBillboard, periodStart, periodEnd,
//                           remainingMs }
//
// GET  /.netlify/functions/bids?admin=1&password=ADMIN_PASSWORD
//      -> same as above but `bids` includes private fields (upiOrEmail)
//         and a `pendingBillboard` field. Password may also be sent as
//         header "x-admin-password" or "Authorization: Bearer <password>".
//
// POST /.netlify/functions/bids
//      body: { action: "placeBid", brandName, bidAmount, website?,
//               tagline?, upiOrEmail, policy, creative? }
//      (action defaults to "placeBid" if omitted)
//      -> 200 { success: true, bid }         on success
//      -> 400 { success: false, error }      on invalid bid
//      -> 500 { success: false, error }      on server error
//
// POST /.netlify/functions/bids   (admin actions — password required)
//      body: { action: "deleteBid", password, id }
//      body: { action: "selectNext", password, id }         // choose next brand from bids
//      body: { action: "startNextBillboard", password }     // start the 24h clock, reset bids
//      Password may also be sent as header "x-admin-password" or
//      "Authorization: Bearer <password>" instead of in the body.
// -----------------------------------------------------------------------------

import { getStore } from "@netlify/blobs";

const MIN_BID = 149;
const MAX_BID = 2499;
const BILLBOARD_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const STATE_KEY = "state";
const STORE_NAME = "bids-store";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-password",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(error, status = 400) {
  return json({ success: false, error }, status);
}

function getStoreClient() {
  return getStore(STORE_NAME);
}

function defaultState() {
  return {
    bids: [],
    activeBillboard: null, // { brandName, website, tagline, creative, bidAmount, id }
    pendingBillboard: null, // brand selected by admin, awaiting "start" action
    periodStart: null,
    periodEnd: null,
  };
}

async function loadState(store) {
  const state = await store.get(STATE_KEY, { type: "json" });
  if (!state) return defaultState();
  // Guard against partially-shaped stored data.
  return { ...defaultState(), ...state };
}

async function saveState(store, state) {
  await store.setJSON(STATE_KEY, state);
}

function currentHighestBid(state) {
  if (!state.bids || state.bids.length === 0) return 0;
  return Math.max(...state.bids.map((b) => Number(b.bidAmount) || 0));
}

function publicBid(bid) {
  // Strip private contact info for unauthenticated GET requests.
  const { upiOrEmail, ...rest } = bid;
  return rest;
}

function getAdminPassword(req, bodyPassword) {
  const header = req.headers.get("x-admin-password");
  if (header) return header;
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const url = new URL(req.url);
  const qp = url.searchParams.get("password");
  if (qp) return qp;
  if (bodyPassword) return bodyPassword;
  return null;
}

function isAdminAuthorized(req, bodyPassword) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // never allow admin access if not configured
  const provided = getAdminPassword(req, bodyPassword);
  return typeof provided === "string" && provided.length > 0 && provided === expected;
}

async function sendBidNotificationEmail(bid) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    // Email is a notification side-effect only; don't fail the bid over it.
    console.warn("Resend not configured; skipping email notification.");
    return;
  }

  const subject = `New bid: ₹${bid.bidAmount} from ${bid.brandName}`;
  const lines = [
    `Brand: ${bid.brandName}`,
    `Bid amount: ₹${bid.bidAmount}`,
    bid.website ? `Website: ${bid.website}` : null,
    bid.tagline ? `Tagline: ${bid.tagline}` : null,
    `Contact (UPI/Email): ${bid.upiOrEmail}`,
    bid.creative ? `Creative: ${bid.creative}` : null,
    `Submitted at: ${bid.timestamp}`,
  ].filter(Boolean);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail,
        to: ["dazzamit98@gmail.com"],
        subject,
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("Resend email failed:", res.status, errText);
    }
  } catch (err) {
    console.error("Resend email error:", err);
  }
}

function validateBidPayload(payload) {
  const { brandName, bidAmount, upiOrEmail, policy } = payload;

  if (!brandName || typeof brandName !== "string" || !brandName.trim()) {
    return "Brand name is required.";
  }
  if (!upiOrEmail || typeof upiOrEmail !== "string" || !upiOrEmail.trim()) {
    return "UPI ID or email is required.";
  }
  if (policy !== true && policy !== "true" && policy !== "on" && policy !== 1) {
    return "You must agree to the policy.";
  }

  const amount = Number(bidAmount);
  if (!Number.isFinite(amount) || Number.isNaN(amount)) {
    return "Bid amount must be a valid number.";
  }
  if (amount < MIN_BID || amount > MAX_BID) {
    return `Bid must be between ₹${MIN_BID} and ₹${MAX_BID}.`;
  }

  return null;
}

async function handlePlaceBid(req, store) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const fieldError = validateBidPayload(payload);
  if (fieldError) {
    return errorResponse(fieldError, 400);
  }

  const state = await loadState(store);
  const highest = currentHighestBid(state);
  const amount = Number(payload.bidAmount);

  if (amount <= highest) {
    return errorResponse(
      `Bid must be higher than the current highest bid (₹${highest}).`,
      400
    );
  }

  const bid = {
    id: crypto.randomUUID(),
    brandName: String(payload.brandName).trim(),
    bidAmount: amount,
    website: payload.website ? String(payload.website).trim() : "",
    tagline: payload.tagline ? String(payload.tagline).trim() : "",
    upiOrEmail: String(payload.upiOrEmail).trim(),
    policy: true,
    creative: payload.creative ? String(payload.creative).trim() : "",
    timestamp: new Date().toISOString(),
  };

  state.bids.push(bid);
  await saveState(store, state);

  // Fire-and-forget style, but awaited so Netlify doesn't kill the function
  // before the request completes.
  await sendBidNotificationEmail(bid);

  return json({ success: true, bid: publicBid(bid) }, 200);
}

async function handleDeleteBid(req, store, payload) {
  if (!isAdminAuthorized(req, payload.password)) {
    return errorResponse("Unauthorized.", 401);
  }
  const { id } = payload;
  if (!id) {
    return errorResponse("Bid id is required.", 400);
  }

  const state = await loadState(store);
  const before = state.bids.length;
  state.bids = state.bids.filter((b) => b.id !== id);

  if (state.bids.length === before) {
    return errorResponse("Bid not found.", 400);
  }

  await saveState(store, state);
  return json({ success: true, highestBid: currentHighestBid(state) }, 200);
}

async function handleSelectNext(req, store, payload) {
  if (!isAdminAuthorized(req, payload.password)) {
    return errorResponse("Unauthorized.", 401);
  }
  const { id } = payload;
  if (!id) {
    return errorResponse("Bid id is required.", 400);
  }

  const state = await loadState(store);
  const chosen = state.bids.find((b) => b.id === id);
  if (!chosen) {
    return errorResponse("Bid not found.", 400);
  }

  state.pendingBillboard = {
    id: chosen.id,
    brandName: chosen.brandName,
    website: chosen.website,
    tagline: chosen.tagline,
    creative: chosen.creative,
    bidAmount: chosen.bidAmount,
  };

  await saveState(store, state);
  return json({ success: true, pendingBillboard: state.pendingBillboard }, 200);
}

async function handleStartNextBillboard(req, store, payload) {
  if (!isAdminAuthorized(req, payload.password)) {
    return errorResponse("Unauthorized.", 401);
  }

  const state = await loadState(store);

  let nextBillboard = state.pendingBillboard;
  if (!nextBillboard) {
    // Fall back to the current highest bidder if nothing was explicitly selected.
    if (!state.bids || state.bids.length === 0) {
      return errorResponse("No bids available to start a billboard.", 400);
    }
    const highestBid = state.bids.reduce((a, b) =>
      Number(a.bidAmount) >= Number(b.bidAmount) ? a : b
    );
    nextBillboard = {
      id: highestBid.id,
      brandName: highestBid.brandName,
      website: highestBid.website,
      tagline: highestBid.tagline,
      creative: highestBid.creative,
      bidAmount: highestBid.bidAmount,
    };
  }

  const now = Date.now();
  state.activeBillboard = nextBillboard;
  state.pendingBillboard = null;
  state.periodStart = now;
  state.periodEnd = now + BILLBOARD_DURATION_MS;
  state.bids = []; // reset bidding for the next round

  await saveState(store, state);

  return json(
    {
      success: true,
      activeBillboard: state.activeBillboard,
      periodStart: state.periodStart,
      periodEnd: state.periodEnd,
    },
    200
  );
}

async function handleGet(req, store) {
  const url = new URL(req.url);
  const isAdminRequest =
    url.searchParams.get("admin") === "1" || url.searchParams.get("admin") === "true";

  const state = await loadState(store);
  const highestBid = currentHighestBid(state);
  const now = Date.now();
  const remainingMs = state.periodEnd ? Math.max(0, state.periodEnd - now) : 0;

  const base = {
    success: true,
    highestBid,
    highestBrand:
      state.bids.length > 0
        ? state.bids.reduce((a, b) => (Number(a.bidAmount) >= Number(b.bidAmount) ? a : b))
            .brandName
        : null,
    activeBillboard: state.activeBillboard,
    periodStart: state.periodStart,
    periodEnd: state.periodEnd,
    remainingMs,
  };

  if (isAdminRequest) {
    if (!isAdminAuthorized(req, null)) {
      return errorResponse("Unauthorized.", 401);
    }
    return json({
      ...base,
      bids: state.bids,
      pendingBillboard: state.pendingBillboard,
    });
  }

  return json({
    ...base,
    bids: state.bids.map(publicBid),
  });
}

export default async (req, context) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const store = getStoreClient();

  try {
    if (req.method === "GET") {
      return await handleGet(req, store);
    }

    if (req.method === "POST") {
      let payload;
      try {
        payload = await req.clone().json();
      } catch {
        return errorResponse("Invalid JSON body.", 400);
      }

      const action = payload.action || "placeBid";

      switch (action) {
        case "placeBid":
          return await handlePlaceBid(req, store);
        case "deleteBid":
          return await handleDeleteBid(req, store, payload);
        case "selectNext":
          return await handleSelectNext(req, store, payload);
        case "startNextBillboard":
          return await handleStartNextBillboard(req, store, payload);
        default:
          return errorResponse(`Unknown action: ${action}`, 400);
      }
    }

    return errorResponse("Method not allowed.", 405);
  } catch (err) {
    console.error("bids function error:", err);
    return errorResponse("Internal server error.", 500);
  }
};

export const config = {
  path: "/.netlify/functions/bids",
};
