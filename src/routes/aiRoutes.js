import express from "express";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();
const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
// Frontend pings this on load to wake the Render free-tier server before the
// user hits Generate — prevents the first request from timing out after sleep

router.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── CURRENCY MAP ─────────────────────────────────────────────────────────────

const CURRENCY_MAP = {
  India: "INR",  USA: "USD",  "United States": "USD",
  UK: "GBP",     "United Kingdom": "GBP",
  Canada: "CAD", Australia: "AUD",
  Germany: "EUR", France: "EUR",  Italy: "EUR",   Spain: "EUR",
  Netherlands: "EUR", Austria: "EUR", Portugal: "EUR", Greece: "EUR",
  Japan: "JPY",  Singapore: "SGD", UAE: "AED",
  China: "CNY",  Brazil: "BRL",  "South Africa": "ZAR",
  Mexico: "MXN", "South Korea": "KRW", "New Zealand": "NZD",
  Switzerland: "CHF", Thailand: "THB", Malaysia: "MYR",
  Indonesia: "IDR",   Vietnam: "VND",  Pakistan: "PKR",
  Bangladesh: "BDT",  "Sri Lanka": "LKR", Nepal: "NPR",
  Philippines: "PHP", Turkey: "TRY",   Egypt: "EGP",
  Sweden: "SEK",  Denmark: "DKK",  Norway: "NOK",
  "Czech Republic": "CZK", Hungary: "HUF", Russia: "RUB",
};

// Fallback rates — used when all live FX APIs fail
const FALLBACK_RATES = {
  USD: 1,    INR: 84.5,  GBP: 0.79, EUR: 0.92, CAD: 1.38, AUD: 1.55,
  JPY: 149,  SGD: 1.34,  AED: 3.67, CNY: 7.26, BRL: 5.1,  ZAR: 18.6,
  MXN: 17.2, KRW: 1345,  NZD: 1.64, CHF: 0.89, THB: 36.2, MYR: 4.72,
  IDR: 15900,VND: 25100, PKR: 279,  BDT: 110,  LKR: 321,  NPR: 135,
  PHP: 56.5, TRY: 32.4,  EGP: 48.5, SEK: 10.6, DKK: 6.95, NOK: 10.9,
  CZK: 23.2, HUF: 362,   RUB: 91,
};

// ─── SAFE FETCH HELPER ────────────────────────────────────────────────────────
// Works on Node 16, 17, 18+ — no AbortSignal.timeout(), no node-fetch dependency

function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal, headers: { "User-Agent": "TravelPlannerApp/1.0" } })
    .finally(() => clearTimeout(timer));
}

// ─── LIVE FX RATE CACHE ───────────────────────────────────────────────────────

const fxCache = { rates: null, fetchedAt: 0 };
const FX_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getLiveRates() {
  const now = Date.now();
  if (fxCache.rates && (now - fxCache.fetchedAt) < FX_CACHE_TTL_MS) {
    console.log("💱 FX from cache");
    return fxCache.rates;
  }

  const endpoints = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
    "https://open.er-api.com/v6/latest/USD",
    "https://api.exchangerate-api.com/v4/latest/USD",
  ];

  for (const url of endpoints) {
    try {
      console.log(`💱 Trying FX: ${url}`);
      const res = await fetchWithTimeout(url, 4000);
      if (!res.ok) continue;
      const json = await res.json();

      // Normalise different response shapes to uppercase key map
      const raw = json.usd || json.rates || json.conversion_rates || null;
      if (!raw) continue;

      const normalised = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v])
      );

      if (!normalised.INR && !normalised.USD) continue; // sanity check

      fxCache.rates = normalised;
      fxCache.fetchedAt = now;
      console.log(`✅ FX live: 1 USD = ${normalised.INR} INR, ${normalised.EUR} EUR`);
      return normalised;
    } catch (e) {
      console.warn(`FX endpoint failed (${url}): ${e.message}`);
    }
  }

  console.warn("⚠️ All FX endpoints failed — using fallback rates");
  return null;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getOriginCountry(origin = "") {
  return origin.includes(",") ? origin.split(",").pop().trim() : origin.trim();
}

function convertUSD(usdAmount, currency, rates) {
  if (!usdAmount || isNaN(usdAmount)) return 0;
  const rate = rates[currency] ?? FALLBACK_RATES[currency] ?? 1;
  return Math.round(usdAmount * rate);
}

function convertRangeStr(rangeStr = "", currency, rates) {
  const nums = rangeStr.match(/\d+/g);
  if (!nums || nums.length < 2) return "";
  return `${convertUSD(+nums[0], currency, rates)}-${convertUSD(+nums[1], currency, rates)}`;
}

// ─── DOMESTIC DETECTION ──────────────────────────────────────────────────────

// Country name variants to normalise (handles "USA"/"United States", "UK"/"United Kingdom" etc)
const COUNTRY_ALIASES = {
  "united states": "usa", "us": "usa",
  "united kingdom": "uk", "great britain": "uk", "england": "uk",
  "india": "india",
};

function normaliseCountry(c = "") {
  const lower = c.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] || lower;
}

// Known Indian cities and states — used to detect domestic Indian destinations
const INDIA_PLACES = new Set([
  "goa","kerala","rajasthan","mumbai","delhi","bangalore","bengaluru","chennai",
  "kolkata","hyderabad","pune","agra","jaipur","udaipur","varanasi","rishikesh",
  "manali","shimla","darjeeling","ooty","kodaikanal","mysore","mysuru","coorg",
  "hampi","pondicherry","puducherry","andaman","lakshadweep","kashmir","ladakh",
  "spiti","sikkim","meghalaya","assam","arunachal","manipur","nagaland","tripura",
  "mizoram","amritsar","chandigarh","lucknow","bhopal","indore","nagpur","surat",
  "kochi","thiruvananthapuram","kozhikode","madurai","coimbatore","tirupati",
  "visakhapatnam","vijayawada","ahmedabad","vadodara","srinagar","jammu","leh",
  "jodhpur","jaisalmer","bikaner","pushkar","mount abu","ajmer","aurangabad",
  "nashik","kolhapur","allahabad","prayagraj","mathura","vrindavan","haridwar",
  "dehradun","mussoorie","nainital","jim corbett","ranthambore","khajuraho",
  "bhubaneswar","puri","konark","patna","ranchi","raipur","guwahati","shillong",
  "aizawl","imphal","kohima","agartala","itanagar","port blair","daman","diu",
  "silvassa","panaji","vasco","margao","calangute","palolem","varkala","munnar",
  "alleppey","alappuzha","kovalam","thrissur","kozhikode","wayanad","coorg",
  "mahabaleshwar","lonavala","matheran","alibag","mahabalipuram","thanjavur",
  "tiruchirappalli","trichy","madurai","rameswaram","kanyakumari","yercaud",
]);

function isDomesticTrip(originCountry, destination) {
  const destLower = destination.toLowerCase().trim();
  const originNorm = normaliseCountry(originCountry);

  if (originNorm === "india") {
    // Check if destination is a known Indian place
    if (INDIA_PLACES.has(destLower)) return true;
    // Check if dest contains an Indian place name
    for (const place of INDIA_PLACES) {
      if (destLower.includes(place)) return true;
    }
  }
  // For other countries: if destination appears to be in the same country
  // (we don't have exhaustive lists, so keep it conservative)
  return false;
}

// ─── MAIN ROUTE ───────────────────────────────────────────────────────────────

router.post("/generate-itinerary", async (req, res) => {
  console.log("✅ POST /generate-itinerary", req.body);

  // ── Input validation ──────────────────────────────────────────────────────
  const { destination, days, origin } = req.body || {};
  if (!destination || !days) {
    return res.status(400).json({ error: "destination and days are required" });
  }

  // ── Environment check ─────────────────────────────────────────────────────
  if (!process.env.GROQ_API_KEY) {
    console.error("❌ GROQ_API_KEY not set in environment");
    return res.status(500).json({ error: "Server misconfiguration: GROQ_API_KEY missing. Set it in Render → Environment." });
  }

  try {
    const originLabel   = origin || "India";
    const originCountry = getOriginCountry(originLabel);
    const currency      = CURRENCY_MAP[originCountry] || "USD";

    // ── Live FX rates (non-blocking — falls back gracefully) ─────────────────
    const liveRates = await getLiveRates();
    const rates     = liveRates || FALLBACK_RATES;
    const fxRate    = rates[currency] ?? FALLBACK_RATES[currency] ?? 1;
    const fxSource  = liveRates ? "live" : "fallback";

    // ── Domestic vs international detection ──────────────────────────────────
    const domestic = isDomesticTrip(originCountry, destination);
    console.log(`Trip type: ${domestic ? "🏠 DOMESTIC" : "✈️ INTERNATIONAL"} (${originLabel} → ${destination})`);

    // ── Groq prompt ───────────────────────────────────────────────────────────
    const systemMsg = [
      "You are a structured travel data API.",
      "Follow the output format EXACTLY.",
      "Lines starting with DATA_ are machine-readable — output only the value after the colon.",
      "All monetary values must be in USD.",
      "No markdown, no bold (**text**), no headers with #.",
    ].join(" ");

    // Domestic prompt — no VISA, TRANSPORT instead of FLIGHTS (trains/buses/flights)
    const domesticPrompt = `Traveler from: ${originLabel}
Destination: ${destination}
Trip length: ${days} days
This is a DOMESTIC trip within the same country.

Output these sections with EXACT headers (==SECTION==). No text outside sections.

==ITINERARY==
Day N: [Theme]
- Morning: [specific activity with real place name, 1 sentence]
- Afternoon: [specific activity with real place name, 1 sentence]
- Evening: [specific activity with real place name, 1 sentence]
Repeat for all ${days} days.

==WEATHER==
- Best months to visit ${destination}
- What to expect each season
- Packing tips for a traveler from ${originLabel}

==BUDGET==
All costs in USD only.
- Backpacker daily (budget stay + street food + local transport)
- Mid-range daily (comfortable hotel + restaurant meals + entry fees)
- Luxury daily (resort + fine dining + private cab)
- Budget stay/night, mid stay/night, street food meal, restaurant meal, local transport/day
DATA_BUDGET_BACKPACKER_USD: [integer daily total USD]
DATA_BUDGET_MID_USD: [integer daily total USD]
DATA_BUDGET_LUXURY_USD: [integer daily total USD]

==TRANSPORT==
How to travel from ${originLabel} to ${destination}. Give ALL practical options.
- Train options: train names, class options (sleeper/3AC/2AC), approx duration, booking via IRCTC
- Bus options: type (state bus / private / Volvo), duration, approx cost in USD
- Flight options if available: airlines, airports, duration, approx roundtrip cost in USD
- Which option is recommended and why
DATA_TRANSPORT_MODE: [best mode: train OR bus OR flight OR train+local]
DATA_TRANSPORT_OPERATORS: [comma-separated — train names / airline names / bus operators]
DATA_TRANSPORT_DURATION: [e.g. 8 hrs by train, or 1 hr by flight]
DATA_TRANSPORT_PRICE_LOW_USD: [cheapest roundtrip option in USD]
DATA_TRANSPORT_PRICE_MID_USD: [mid-range roundtrip option in USD]
DATA_TRANSPORT_PRICE_HIGH_USD: [comfortable/premium roundtrip option in USD]
DATA_TRANSPORT_PEAK_MONTHS: [e.g. Dec, Jan, Apr, Oct]
DATA_TRANSPORT_OFFPEAK_MONTHS: [e.g. Jun, Jul, Aug, Sep]

==TIPS==
- 3-5 practical tips specific to ${destination}
- Local customs and cultural etiquette
- Best areas to stay, what to avoid
- Any permits or entry requirements for ${destination}

==PLACES==
Every named place from the itinerary, one per line:
- [Place Name], [City/District], [State], India`;

    // International prompt — with VISA and FLIGHTS
    const internationalPrompt = `Traveler from: ${originLabel}
Destination: ${destination}
Trip length: ${days} days

Output these sections with EXACT headers (==SECTION==). No text outside sections.

==ITINERARY==
Day N: [Theme]
- Morning: [specific activity with real place name, 1 sentence]
- Afternoon: [specific activity with real place name, 1 sentence]
- Evening: [specific activity with real place name, 1 sentence]
Repeat for all ${days} days.

==VISA==
- Visa rules for ${originCountry} passport holders visiting ${destination}
- Visa-free / on-arrival / e-visa / embassy — which applies and how to apply
- Approximate fee in USD and processing time
DATA_VISA_URL: [official government visa URL for ${destination}]
DATA_VISA_FREE: [YES or NO]

==WEATHER==
- Best months to visit ${destination}
- What to expect each season
- Packing tips for travelers from ${originLabel}

==BUDGET==
All costs in USD only.
- Backpacker daily (budget hostel + street food + local transport)
- Mid-range daily (3-star hotel + sit-down meals + attractions)
- Luxury daily (5-star hotel + fine dining + private transport)
- Budget hotel/night, mid hotel/night, street food meal, restaurant meal, local transport/day
DATA_BUDGET_BACKPACKER_USD: [integer daily total USD]
DATA_BUDGET_MID_USD: [integer daily total USD]
DATA_BUDGET_LUXURY_USD: [integer daily total USD]

==FLIGHTS==
Roundtrip flights from ${originLabel} to ${destination}. All prices USD.
- Airlines that operate this route
- Departure airport(s) with IATA code
- Arrival airport(s) with IATA code
- Typical duration and stops
DATA_FLIGHT_AIRLINES: [comma-separated]
DATA_FLIGHT_FROM_AIRPORT: [name and IATA]
DATA_FLIGHT_TO_AIRPORT: [name and IATA]
DATA_FLIGHT_DURATION: [e.g. 9-12 hrs, 1 stop]
DATA_FLIGHT_PRICE_PEAK_USD: [USD range e.g. 1100-1600]
DATA_FLIGHT_PRICE_SHOULDER_USD: [USD range e.g. 750-1050]
DATA_FLIGHT_PRICE_OFFPEAK_USD: [USD range e.g. 600-850]
DATA_FLIGHT_PEAK_MONTHS: [e.g. Dec, Jan, Jun, Jul]
DATA_FLIGHT_SHOULDER_MONTHS: [e.g. Mar, Apr, May, Sep, Oct, Nov]
DATA_FLIGHT_OFFPEAK_MONTHS: [e.g. Feb, Aug]

==TIPS==
- 3-5 practical local tips for ${destination}
- Cultural etiquette
- Safety tips for ${originCountry} travelers

==PLACES==
Every named place from the itinerary, one per line:
- [Place Name], [City], [Country]`;

    const userMsg = domestic ? domesticPrompt : internationalPrompt;

    // ── Call Groq ────────────────────────────────────────────────────────────
    // Model: llama-3.1-8b-instant
    //   TPM limit:  20,000  (per minute)
    //   TPD limit: 500,000  (per day) — 5x more headroom than 70b (100k/day)
    //   RPM limit:  30

    console.log("🧠 Calling Groq llama-3.1-8b-instant...");

    let completion;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        completion = await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: systemMsg },
            { role: "user",   content: userMsg   },
          ],
          max_tokens: 2800,
          temperature: 0.3,
        });
        break; // success — exit retry loop

      } catch (groqErr) {
        const status = groqErr?.status || groqErr?.statusCode;

        if (status === 401) {
          return res.status(500).json({ error: "Invalid GROQ_API_KEY — check your Render environment variables." });
        }

        if (status === 429) {
          // Parse the retry-after wait time from multiple sources:
          // 1. retry-after header (seconds as float)
          // 2. Groq error message e.g. "Please try again in 8m53.952s"
          const parseRetryAfterMs = () => {
            // Try header first
            const h = groqErr?.headers?.["retry-after"] || groqErr?.response?.headers?.["retry-after"];
            if (h && !isNaN(parseFloat(h))) return Math.ceil(parseFloat(h)) * 1000;

            // Parse from error message: "try again in 8m53.952s" or "try again in 45.2s"
            const msg = groqErr?.message || groqErr?.error?.message || "";
            const minsMatch = msg.match(/(\d+)m([\d.]+)s/);
            if (minsMatch) return (parseInt(minsMatch[1]) * 60 + parseFloat(minsMatch[2])) * 1000 + 2000;
            const secsMatch = msg.match(/in ([\d.]+)s/);
            if (secsMatch) return parseFloat(secsMatch[1]) * 1000 + 2000;

            return 65000; // safe default: 65s
          };

          const retryAfterMs = parseRetryAfterMs();

          // TPD (daily) limit: wait is many minutes — don't retry, tell user to come back
          const isTPD = (groqErr?.message || "").toLowerCase().includes("per day") ||
                        (groqErr?.error?.message || "").toLowerCase().includes("per day");

          if (isTPD) {
            const waitMins = Math.ceil(retryAfterMs / 60000);
            return res.status(429).json({
              error: `Daily AI token limit reached. Please try again in ~${waitMins} minutes.`,
              retryAfterMs,
              isTPD: true,
            });
          }

          if (attempt < MAX_RETRIES) {
            console.log(`⏳ Rate limited (attempt ${attempt}/${MAX_RETRIES}) — waiting ${Math.round(retryAfterMs/1000)}s...`);
            await new Promise(r => setTimeout(r, retryAfterMs));
            continue; // retry
          } else {
            // All retries exhausted — tell frontend to retry later
            return res.status(429).json({
              error: "Rate limit reached — the AI is busy. Please wait 60 seconds and try again.",
              retryAfterMs,
            });
          }
        }

        throw groqErr; // unexpected error — let outer catch handle it
      }
    }

    let text = completion.choices[0]?.message?.content || "";
    if (!text) throw new Error("Groq returned empty response");
    console.log(`✅ Groq OK — ${text.length} chars`);

    // ── Parse USD values and inject converted tags ────────────────────────────
    const getUSD = (tag) => {
      const m = text.match(new RegExp(`DATA_${tag}:\\s*(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };
    const getRangeStr = (tag) => {
      const m = text.match(new RegExp(`DATA_${tag}:\\s*([\\d]+-[\\d]+)`));
      return m ? m[1] : "";
    };

    const budgetB = getUSD("BUDGET_BACKPACKER_USD");
    const budgetM = getUSD("BUDGET_MID_USD");
    const budgetL = getUSD("BUDGET_LUXURY_USD");

    // Also convert domestic transport prices if present
    const transportLowUSD  = getUSD("TRANSPORT_PRICE_LOW_USD");
    const transportMidUSD  = getUSD("TRANSPORT_PRICE_MID_USD");
    const transportHighUSD = getUSD("TRANSPORT_PRICE_HIGH_USD");

    const converted = `

==CONVERTED==
DATA_CURRENCY: ${currency}
DATA_FX_RATE: ${fxRate}
DATA_FX_SOURCE: ${fxSource}
DATA_FX_TIMESTAMP: ${new Date().toISOString()}
DATA_IS_DOMESTIC: ${domestic ? "YES" : "NO"}
DATA_BUDGET_BACKPACKER: ${convertUSD(budgetB, currency, rates)}
DATA_BUDGET_MID: ${convertUSD(budgetM, currency, rates)}
DATA_BUDGET_LUXURY: ${convertUSD(budgetL, currency, rates)}
DATA_FLIGHT_PRICE_PEAK: ${convertRangeStr(getRangeStr("FLIGHT_PRICE_PEAK_USD"), currency, rates)}
DATA_FLIGHT_PRICE_SHOULDER: ${convertRangeStr(getRangeStr("FLIGHT_PRICE_SHOULDER_USD"), currency, rates)}
DATA_FLIGHT_PRICE_OFFPEAK: ${convertRangeStr(getRangeStr("FLIGHT_PRICE_OFFPEAK_USD"), currency, rates)}
DATA_TRANSPORT_PRICE_LOW: ${convertUSD(transportLowUSD, currency, rates)}
DATA_TRANSPORT_PRICE_MID: ${convertUSD(transportMidUSD, currency, rates)}
DATA_TRANSPORT_PRICE_HIGH: ${convertUSD(transportHighUSD, currency, rates)}`;

    text += converted;
    console.log(`💱 Converted at ${fxRate} ${currency} (${fxSource})`);

    res.json({ itinerary: text, fxRate, currency, fxSource });

  } catch (err) {
    console.error("🔥 Unhandled error:", err);
    res.status(500).json({
      error: err.message || "Internal server error",
      hint: "Check Render logs for details",
    });
  }
});

export default router;
