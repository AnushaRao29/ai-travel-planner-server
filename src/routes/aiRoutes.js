import express from "express";
import dotenv from "dotenv";
import Groq from "groq-sdk";

dotenv.config();
const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

router.post("/generate-itinerary", async (req, res) => {
  console.log("✅ Route hit with body:", req.body);
  console.log("Groq API key exists:", !!process.env.GROQ_API_KEY);

  try {
    const { destination, days } = req.body;
    if (!destination || !days) {
      console.log("❌ Missing fields");
      return res.status(400).json({ error: "Destination and days are required" });
    }

    const prompt = `Create a detailed ${days}-day travel itinerary for ${destination}.

Use exactly this format and these exact section labels:

ITINERARY
Day 1: [Theme]
- Morning: [activity with 1-sentence description]
- Afternoon: [activity with 1-sentence description]
- Evening: [activity with 1-sentence description]

Day 2: [Theme]
- Morning: [activity with 1-sentence description]
- Afternoon: [activity with 1-sentence description]
- Evening: [activity with 1-sentence description]

...repeat for all ${days} days

VISA
- Visa type required for Indian passport holders
- How to apply (online / on arrival / embassy)
- Approximate cost and processing time

WEATHER
- Best time to visit ${destination}
- Expected weather during a typical trip

BUDGET
- Approximate daily budget in INR (budget / mid-range / luxury)
- Local currency and rough exchange rate from INR

TIPS
- 3 practical travel tips specific to ${destination}

IMPORTANT: Output only the above 5 sections. No markdown bold (**text**), no ### headers, no extra commentary. Plain text only.`;

    console.log("🧠 Sending request to Groq API...");
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
    });

    console.log("✅ Groq response received");
    res.json({ itinerary: completion.choices[0].message.content });
  } catch (error) {
    console.error("🔥 Full error:", error);
    res.status(500).json({
      error: error.response?.data || error.message || "Failed to generate itinerary",
    });
  }
});

export default router;