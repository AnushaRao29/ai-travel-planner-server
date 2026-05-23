# Travel Planner Backend

A Node.js/Express backend that generates travel itineraries using Groq and exposes a small API for the frontend.

## Features

- `GET /api/health` health check endpoint
- `POST /api/generate-itinerary` generates a travel itinerary response
- Converts budget and transportation amounts to the user's currency using live FX data with fallback rates
- Supports domestic and international trip prompts

## Prerequisites

- Node.js 18+
- npm
- A Groq API key

## Installation

```bash
npm install
```

## Environment variables

Create a `.env` file in the project root:

```env
GROQ_API_KEY=your_groq_api_key
```

## Run locally

```bash
npm start
```

The server starts on port `8080`.

## API endpoints

### Health check

```bash
GET /api/health
```

Example response:

```json
{
  "ok": true,
  "ts": 1716470000000
}
```

### Generate itinerary

```bash
POST /api/generate-itinerary
Content-Type: application/json
```

Example request:

```json
{
  "destination": "Goa",
  "days": 4,
  "origin": "India"
}
```

Example response:

```json
{
  "itinerary": "...",
  "fxRate": 84.5,
  "currency": "INR",
  "fxSource": "live"
}
```

## Project structure

```text
src/
  server.js
  routes/
    aiRoutes.js
```

## Notes

- The backend expects `GROQ_API_KEY` to be configured in your environment or `.env` file.
- The current `npm test` script is placeholder-only and does not run automated tests yet.
- The server is configured for local development and can be deployed to Render or similar platforms.
