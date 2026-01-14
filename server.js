import express from "express";
import axios from "axios";
import twilio from "twilio";
import { z } from "zod";

const app = express();

// Twilio sends form-encoded by default for voice webhooks
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  TWILIO_AUTH_TOKEN,
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL
} = process.env;

if (!TWILIO_AUTH_TOKEN) console.warn("Missing TWILIO_AUTH_TOKEN");
if (!MAKE_GETQUOTE_WEBHOOK_URL) console.warn("Missing MAKE_GETQUOTE_WEBHOOK_URL");
if (!MAKE_CONFIRMBOOKING_WEBHOOK_URL) console.warn("Missing MAKE_CONFIRMBOOKING_WEBHOOK_URL");

const VoiceResponse = twilio.twiml.VoiceResponse;

// In-memory state keyed by CallSid. Use Redis later if you need persistence across replicas.
const callState = new Map();

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("$") || t.includes("usd") || t.includes("dollar") || t.includes("bucks");
}

function ensureGbpOnly(text) {
  // This protects what Spark says. It does not block callers from saying “dollars”.
  if (containsDollar(text)) {
    return "Sorry, I only quote in pounds. Is the cleaning for a home or for a business premises?";
  }
  return text;
}

function sayGather(twiml, text) {
  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/call/input",
    method: "POST"
  });

  gather.say({ voice: "alice", language: "en-GB" }, ensureGbpOnly(text));
  twiml.redirect({ method: "POST" }, "/call/input");
}

function validateTwilioSignature(req) {
  // If you are testing with curl or a browser, signature validation will fail.
  // In production with Twilio, it should pass.
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;

  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
}

// Schemas for downstream Make webhooks when you wire them in
const ExtraSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().nonnegative()
});

const GetQuoteSchema = z.object({
  intent: z.literal("get_quote"),
  service_category: z.enum(["domestic", "commercial"]),
  domestic_service_type: z.string(),
  commercial_service_type: z.string(),
  domestic_property_type: z.string(),
  commercial_property_type: z.string(),
  job_type: z.string(),
  bedrooms: z.number().int().nonnegative(),
  bathrooms: z.number().int().nonnegative(),
  toilets: z.number().int().nonnegative(),
  kitchens: z.number().int().nonnegative(),
  postcode: z.string().min(1),
  preferred_hours: z.number().nonnegative(),
  visit_frequency_per_week: z.number().nonnegative(),
  areas_scope: z.string(),
  extras: z.array(ExtraSchema),
  notes: z.string()
});

const ConfirmBookingSchema = z.object({
  intent: z.literal("confirm_booking"),
  full_name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().min(1),
  address: z.string().min(1),
  postcode: z.string().min(1),
  preferred_date: z.string().min(1),
  preferred_time: z.string().min(1)
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/call/start", (req, res) => {
  // Optional: enforce Twilio signature in production
  // if (!validateTwilioSignature(req)) return res.status(403).send("Forbidden");

  const callSid = req.body.CallSid || `local_${Date.now()}`;

  callState.set(callSid, {
    stage: "start",
    transcript: [],
    data: {}
  });

  const twiml = new VoiceResponse();
  sayGather(
    twiml,
    "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?"
  );
  res.type("text/xml").send(twiml.toString());
});

app.post("/call/input", async (req, res) => {
  // Optional: enforce Twilio signature in production
  // if (!validateTwilioSignature(req)) return res.status(403).send("Forbidden");

  const callSid = req.body.CallSid || `local_${Date.now()}`;
  const speech = String(req.body.SpeechResult || "").trim();
  const state = callState.get(callSid) || { stage: "start", transcript: [], data: {} };

  if (speech) state.transcript.push(speech);
  callState.set(callSid, state);

  const twiml = new VoiceResponse();

  if (!speech) {
    sayGather(twiml, "Sorry, I didn’t catch that. Is this for a home or a business premises?");
    return res.type("text/xml").send(twiml.toString());
  }

  const lower = speech.toLowerCase();

  // Category detection with a clarity-first approach
  const domesticHints = ["home", "house", "flat", "apartment", "studio", "tenancy", "move out", "landlord"];
  const commercialHints = ["office", "shop", "warehouse", "school", "clinic", "gym", "venue", "site", "business", "restaurant", "workplace"];

  const mentionedDomestic = domesticHints.some((x) => lower.includes(x));
  const mentionedCommercial = commercialHints.some((x) => lower.includes(x));

  if (!state.data.service_category) {
    if (mentionedDomestic && !mentionedCommercial) state.data.service_category = "domestic";
    if (mentionedCommercial && !mentionedDomestic) state.data.service_category = "commercial";
  }

  if (!state.data.service_category) {
    // Ask for clarity instead of refusing
    sayGather(twiml, "Thanks. Is the cleaning for a home or for a business premises?");
    return res.type("text/xml").send(twiml.toString());
  }

  if (!state.data.service_type) {
    if (state.data.service_category === "domestic") {
      sayGather(twiml, "What type of domestic cleaning do you need. End of tenancy, deep clean, regular cleaning, post-construction, or disinfection?");
    } else {
      sayGather(twiml, "What type of commercial cleaning do you need. Regular commercial cleaning, deep clean, post-construction, or disinfection?");
    }
    return res.type("text/xml").send(twiml.toString());
  }

  // Placeholder next step
  sayGather(twiml, "Thanks. What is the property type and the postcode?");
  return res.type("text/xml").send(twiml.toString());
});

// Railway binds PORT automatically
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server listening on ${port}`));

