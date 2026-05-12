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

    const prompt = `Create a ${days}-day travel itinerary for ${destination}, including attractions, food, and experiences.`;

    console.log("🧠 Sending request to Groq API...");
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
    });

    console.log("✅ Groq response received");
    res.json({ itinerary: completion.choices[0].message.content });
  } catch (error) {
    console.error("🔥 Full error object:", error);
    console.error("🔥 Error response data:", error.response?.data);
    res.status(500).json({
      error: error.response?.data || error.message || "Failed to generate itinerary",
    });
  }
});

export default router;
