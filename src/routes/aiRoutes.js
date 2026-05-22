import express from "express";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();
const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── LIVE FX RATE CACHE ───────────────────────────────────────────────────────
// Caches rates for 1 hour so we don't hit the API every single request

const fxCache = { rates: null, fetchedAt: 0 };
const FX_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const CURRENCY_MAP = {
  India: "INR", USA: "USD", "United States": "USD",
  UK: "GBP", "United Kingdom": "GBP",
  Canada: "CAD", Australia: "AUD",
  Germany: "EUR", France: "EUR", Italy: "EUR", Spain: "EUR",
  Netherlands: "EUR", Austria: "EUR", Portugal: "EUR", Greece: "EUR",
  Japan: "JPY", Singapore: "SGD", UAE: "AED",
  China: "CNY", Brazil: "BRL", "South Africa": "ZAR",
  Mexico: "MXN", "South Korea": "KRW", "New Zealand": "NZD",
  Switzerland: "CHF", Thailand: "THB", Malaysia: "MYR",
  Indonesia: "IDR", Vietnam: "VND", Pakistan: "PKR",
  Bangladesh: "BDT", "Sri Lanka": "LKR", Nepal: "NPR",
  Philippines: "PHP", Turkey: "TRY", Egypt: "EGP",
  Sweden: "SEK", Denmark: "DKK", Norway: "NOK",
  "Czech Republic": "CZK", Hungary: "HUF", Russia: "RUB",
};

async function getLiveRates() {
  const now = Date.now();
  if (fxCache.rates && (now - fxCache.fetchedAt) < FX_CACHE_TTL_MS) {
    console.log("💱 FX rates from cache");
    return fxCache.rates;
  }

  // Primary: fawazahmed0 currency API — free, no key, CDN-backed, updates daily
  // https://github.com/fawazahmed0/exchange-api
  const endpoints = [
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
    "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
    // Fallback: open.er-api (1500 req/month free)
    "https://open.er-api.com/v6/latest/USD",
    // Fallback 2: exchangerate-api (1500 req/month free)
    "https://api.exchangerate-api.com/v4/latest/USD",
  ];

  for (const url of endpoints) {
    try {
      console.log(`💱 Fetching live FX from ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const json = await res.json();

      // Different APIs return different shapes
      let rates = null;
      if (json.usd)             rates = json.usd;        // fawazahmed0 format
      else if (json.rates)      rates = json.rates;       // open.er-api / exchangerate-api format
      else if (json.conversion_rates) rates = json.conversion_rates;

      if (rates && rates.inr || rates && rates.INR) {
        // Normalize to uppercase keys
        const normalized = {};
        Object.entries(rates).forEach(([k, v]) => { normalized[k.toUpperCase()] = v; });
        fxCache.rates = normalized;
        fxCache.fetchedAt = now;
        console.log(`✅ Live FX fetched. USD→INR: ${normalized.INR}, USD→EUR: ${normalized.EUR}`);
        return normalized;
      }
    } catch (e) {
      console.warn(`FX fetch failed for ${url}:`, e.message);
    }
  }

  console.warn("⚠️ All FX endpoints failed — using fallback hardcoded rates");
  return null; // caller will use fallback
}

// Fallback rates when all APIs fail (updated periodically in code)
const FALLBACK_RATES = {
  USD: 1, INR: 84.5, GBP: 0.79, EUR: 0.92, CAD: 1.38, AUD: 1.55,
  JPY: 149, SGD: 1.34, AED: 3.67, CNY: 7.26, BRL: 5.1, ZAR: 18.6,
  MXN: 17.2, KRW: 1345, NZD: 1.64, CHF: 0.89, THB: 36.2, MYR: 4.72,
  IDR: 15900, VND: 25100, PKR: 279, BDT: 110, LKR: 321, NPR: 135,
  PHP: 56.5, TRY: 32.4, EGP: 48.5, SEK: 10.6, DKK: 6.95, NOK: 10.9,
  CZK: 23.2, HUF: 362, RUB: 91,
};

function getOriginCountry(origin = "") {
  return origin.includes(",") ? origin.split(",").pop().trim() : origin.trim();
}

// Convert a USD amount to origin currency using live rates
function convertUSD(usdAmount, targetCurrency, rates) {
  if (!usdAmount || isNaN(usdAmount)) return 0;
  const r = rates[targetCurrency] || FALLBACK_RATES[targetCurrency] || 1;
  return Math.round(usdAmount * r);
}

// Parse "500-800" USD range from AI output and convert both ends
function convertRange(usdRangeStr = "", targetCurrency, rates) {
  const parts = usdRangeStr.match(/[\d]+/g);
  if (!parts || parts.length < 2) return "";
  const lo = convertUSD(parseInt(parts[0]), targetCurrency, rates);
  const hi = convertUSD(parseInt(parts[1]), targetCurrency, rates);
  return `${lo}-${hi}`;
}

// ─── ROUTE ────────────────────────────────────────────────────────────────────

router.post("/generate-itinerary", async (req, res) => {
  console.log("✅ Route hit:", req.body);

  try {
    const { destination, days, origin } = req.body;
    if (!destination || !days) {
      return res.status(400).json({ error: "Destination and days are required" });
    }

    const originLabel   = origin || "India";
    const originCountry = getOriginCountry(originLabel);
    const currency      = CURRENCY_MAP[originCountry] || "USD";

    // Fetch live FX rates
    const liveRates = await getLiveRates();
    const rates     = liveRates || FALLBACK_RATES;
    const fxRate    = rates[currency] || FALLBACK_RATES[currency] || 1;

    // ── PROMPT: ask LLaMA for all costs in USD only ────────────────────────
    // We do the conversion ourselves using live rates — never trust AI for FX

    const systemMsg = `You are a structured travel data API. Follow the output format EXACTLY.
Lines starting with DATA_ are machine-readable — output only the value after the colon.
All monetary values must be in USD. No markdown, no bold, no headers with #.`;

    const userMsg = `Traveler from: ${originLabel}
Destination: ${destination}
Trip length: ${days} days

Output these sections with headers EXACTLY as shown (==SECTION==). No extra text outside sections.

==ITINERARY==
Day N: [Theme]
- Morning: [specific activity with real place name, 1 sentence]
- Afternoon: [specific activity with real place name, 1 sentence]
- Evening: [specific activity with real place name, 1 sentence]
Repeat for all ${days} days.

==VISA==
- Visa requirements for ${originCountry} passport holders visiting ${destination}
- Visa-free / visa-on-arrival / e-visa / embassy visa — which applies?
- If visa required: application process and typical fee in USD
- Processing time
DATA_VISA_URL: [official government visa/immigration URL for ${destination}, real URL only]
DATA_VISA_FREE: [YES or NO]

==WEATHER==
- Best months to visit ${destination}
- What to expect each season
- Packing tips for travelers from ${originLabel}

==BUDGET==
Give costs in USD (we handle currency conversion server-side).
- Backpacker daily: accommodation + food + transport + activities
- Mid-range daily: comfortable hotel + restaurants + attractions
- Luxury daily: 5-star hotel + fine dining + private tours
- Budget hotel per night in USD
- Mid-range hotel per night in USD
- Cheap meal / street food in USD
- Mid-range restaurant meal in USD
- Local transport per day in USD
DATA_BUDGET_BACKPACKER_USD: [integer, backpacker daily total in USD]
DATA_BUDGET_MID_USD: [integer, mid-range daily total in USD]
DATA_BUDGET_LUXURY_USD: [integer, luxury daily total in USD]

==FLIGHTS==
Typical roundtrip flights from ${originLabel} to ${destination}. All prices in USD.
- Recommended airlines for this route
- Departure airport(s) near ${originLabel} with IATA code
- Arrival airport(s) near ${destination} with IATA code
- Typical flight duration and stops
DATA_FLIGHT_AIRLINES: [comma-separated airline names]
DATA_FLIGHT_FROM_AIRPORT: [airport name and IATA code]
DATA_FLIGHT_TO_AIRPORT: [airport name and IATA code]
DATA_FLIGHT_DURATION: [e.g. 9-12 hrs, 1 stop]
DATA_FLIGHT_PRICE_PEAK_USD: [roundtrip USD range, e.g. 1100-1600]
DATA_FLIGHT_PRICE_SHOULDER_USD: [roundtrip USD range, e.g. 750-1050]
DATA_FLIGHT_PRICE_OFFPEAK_USD: [roundtrip USD range, e.g. 600-850]
DATA_FLIGHT_PEAK_MONTHS: [e.g. Dec, Jan, Jun, Jul]
DATA_FLIGHT_SHOULDER_MONTHS: [e.g. Mar, Apr, May, Sep, Oct, Nov]
DATA_FLIGHT_OFFPEAK_MONTHS: [e.g. Feb, Aug]

==TIPS==
- 3-5 practical tips for ${destination}
- Cultural etiquette
- Safety advice for ${originCountry} travelers

==PLACES==
Every named place from the itinerary, one per line:
- [Place Name], [City], [Country]`;

    console.log("🧠 Sending to Groq...");
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemMsg },
        { role: "user",   content: userMsg },
      ],
      max_tokens: 3500,
      temperature: 0.3,
    });

    let text = completion.choices[0].message.content;
    console.log("✅ Groq response, length:", text.length);

    // ── SERVER-SIDE: inject live-converted DATA_ tags ──────────────────────
    // Parse USD values from LLaMA output, convert to origin currency, inject as new tags

    const getUSD = (tag) => {
      const m = text.match(new RegExp(`DATA_${tag}:\\s*(\\d+)`));
      return m ? parseInt(m[1]) : 0;
    };

    const budgetBUSD = getUSD("BUDGET_BACKPACKER_USD");
    const budgetMUSD = getUSD("BUDGET_MID_USD");
    const budgetLUSD = getUSD("BUDGET_LUXURY_USD");

    const flightPeakUSD     = text.match(/DATA_FLIGHT_PRICE_PEAK_USD:\s*([\d]+-[\d]+)/)?.[1] || "";
    const flightShoulderUSD = text.match(/DATA_FLIGHT_PRICE_SHOULDER_USD:\s*([\d]+-[\d]+)/)?.[1] || "";
    const flightOffpeakUSD  = text.match(/DATA_FLIGHT_PRICE_OFFPEAK_USD:\s*([\d]+-[\d]+)/)?.[1] || "";

    // Inject converted tags at the end of the response
    const injected = `

==CONVERTED==
DATA_CURRENCY: ${currency}
DATA_FX_RATE: ${fxRate}
DATA_FX_SOURCE: live
DATA_FX_TIMESTAMP: ${new Date().toISOString()}
DATA_BUDGET_BACKPACKER: ${convertUSD(budgetBUSD, currency, rates)}
DATA_BUDGET_MID: ${convertUSD(budgetMUSD, currency, rates)}
DATA_BUDGET_LUXURY: ${convertUSD(budgetLUSD, currency, rates)}
DATA_FLIGHT_PRICE_PEAK: ${convertRange(flightPeakUSD, currency, rates)}
DATA_FLIGHT_PRICE_SHOULDER: ${convertRange(flightShoulderUSD, currency, rates)}
DATA_FLIGHT_PRICE_OFFPEAK: ${convertRange(flightOffpeakUSD, currency, rates)}`;

    text = text + injected;

    console.log(`💱 Injected live rates: 1 USD = ${fxRate} ${currency}`);
    res.json({ itinerary: text, fxRate, currency });

  } catch (error) {
    console.error("🔥 Error:", error);
    res.status(500).json({
      error: error.response?.data || error.message || "Failed",
    });
  }
});

export default router;
