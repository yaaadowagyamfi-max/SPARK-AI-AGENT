const express = require("express");
const axios = require("axios");
const { z } = require("zod");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  MAKE_GETQUOTE_WEBHOOK_URL,
  MAKE_CONFIRMBOOKING_WEBHOOK_URL,
} = process.env;

const VoiceResponse = twilio.twiml.VoiceResponse;

// In-memory state keyed by CallSid (OK for MVP)
const callState = new Map();

function containsDollar(text = "") {
  const t = String(text).toLowerCase();
  return t.includes("$") || t.includes("usd") || t.includes("dollar") || t.includes("bucks");
}

// This protects what SPARK says, not what caller says.
function enforceGbpSpeech(text) {
  if (!text) return text;
  if (containsDollar(text)) {
    return "Sorry, that’s in pounds. I will quote in £ only. Is the cleaning for a home or a business premises?";
  }
  return text;
}

function sayGather(twiml, text) {
  const gather = twiml.gather({
    input: "speech",
    speechTimeout: "auto",
    action: "/call/input",
    method: "POST",
  });
  gather.say({ voice: "alice", language: "en-GB" }, enforceGbpSpeech(text));
  twiml.redirect({ method: "POST" }, "/call/input");
}

function getState(callSid) {
  if (!callState.has(callSid)) {
    callState.set(callSid, { transcript: [], stage: "start", data: {} });
  }
  return callState.get(callSid);
}

// Minimal phrase helpers
function includesAny(text, arr) {
  const t = (text || "").toLowerCase();
  return arr.some((x) => t.includes(x));
}

function detectCategory(text) {
  const t = (text || "").toLowerCase();
  const domesticHints = ["home", "house", "flat", "apartment", "studio", "tenancy", "landlord", "move out", "move-out"];
  const commercialHints = ["office", "shop", "warehouse", "school", "clinic", "gym", "venue", "site", "business", "restaurant", "workplace"];

  const d = domesticHints.some((x) => t.includes(x));
  const c = commercialHints.some((x) => t.includes(x));

  if (d && !c) return "domestic";
  if (c && !d) return "commercial";
  return "";
}

// Step: start call
app.post("/call/start", (req, res) => {
  const callSid = req.body.CallSid;
  callState.set(callSid, { transcript: [], stage: "need_category", data: {} });

  const twiml = new VoiceResponse();
  sayGather(twiml, "Hi, you’re through to TotalSpark Solutions. Is the cleaning for a home or for a business premises?");
  res.type("text/xml").send(twiml.toString());
});

// Input handler with stage machine
app.post("/call/input", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const state = getState(callSid);

  if (speech) state.transcript.push(speech);

  const twiml = new VoiceResponse();

  if (!speech) {
    sayGather(twiml, "Sorry, I didn’t catch that. Is the cleaning for a home or for a business premises?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Never refuse on vague input. Always clarify first.
  // Only refuse after caller confirms non-cleaning.
  // This MVP does not implement the refusal branch yet.

  // Stage 1: Category
  if (state.stage === "need_category") {
    let category = detectCategory(speech);

    if (!category) {
      // Allow direct answers like "domestic" / "commercial"
      const t = speech.toLowerCase();
      if (t.includes("home") || t.includes("domestic")) category = "domestic";
      if (t.includes("business") || t.includes("commercial")) category = "commercial";
    }

    if (!category) {
      sayGather(twiml, "Thanks. Is it for a home, like a flat or house, or for a business, like an office or shop?");
      return res.type("text/xml").send(twiml.toString());
    }

    state.data.service_category = category;
    state.stage = "need_service_type";

    if (category === "commercial") {
      sayGather(twiml, "Thanks. What type of commercial cleaning do you need? For example regular commercial cleaning, deep clean, post-construction, or disinfection.");
    } else {
      sayGather(twiml, "Thanks. What type of domestic cleaning do you need? For example end of tenancy, deep clean, regular cleaning, post-construction, or disinfection.");
    }

    return res.type("text/xml").send(twiml.toString());
  }

  // Stage 2: Service type
  if (state.stage === "need_service_type") {
    state.data.service_type_raw = speech;

    // Store into correct field placeholders (you will tighten this later)
    if (state.data.service_category === "commercial") {
      state.data.commercial_service_type = speech;
      state.data.domestic_service_type = "";
      state.stage = "need_job_type";
      sayGather(twiml, "Is this a one-time clean or an ongoing service?");
      return res.type("text/xml").send(twiml.toString());
    } else {
      state.data.domestic_service_type = speech;
      state.data.commercial_service_type = "";
      state.stage = "need_property_and_postcode";
      sayGather(twiml, "Thanks. What’s the property type and postcode?");
      return res.type("text/xml").send(twiml.toString());
    }
  }

  // Stage 3: Job type for commercial (mandatory)
  if (state.stage === "need_job_type") {
    const t = speech.toLowerCase();
    if (t.includes("one") || t.includes("once") || t.includes("one-off") || t.includes("one off")) state.data.job_type = "one_time";
    if (t.includes("ongoing") || t.includes("regular") || t.includes("weekly") || t.includes("monthly") || t.includes("recurring")) state.data.job_type = "regular";

    if (!state.data.job_type) {
      sayGather(twiml, "Just to confirm, is it a one-time clean, or ongoing regular visits?");
      return res.type("text/xml").send(twiml.toString());
    }

    state.stage = "need_property_and_postcode";
    sayGather(twiml, "Thanks. What’s the property type and postcode?");
    return res.type("text/xml").send(twiml.toString());
  }

  // Stage 4: Property + postcode (MVP parsing, you will tighten later)
  if (state.stage === "need_property_and_postcode") {
    state.data.property_and_postcode_raw = speech;
    state.stage = "next";

    sayGather(twiml, "Thanks. Next I will ask about rooms and any extras. For now, tell me the number of bedrooms and bathrooms.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Default
  sayGather(twiml, "Thanks. I will ask the next detail. What’s the postcode?");
  return res.type("text/xml").send(twiml.toString());
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Spark brain listening on ${port}`));
