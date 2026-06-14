import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import {
  IdentificationServiceError,
  identifyWithLocalModel,
  identifyWithPlantNet,
  isLocalModelConfigured,
} from "./layer1.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const allowedOrgans = new Set(["auto", "leaf", "flower", "fruit", "bark"]);
const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const weatherLabels = new Map([
  [0, "Clear sky"],
  [1, "Mainly clear"],
  [2, "Partly cloudy"],
  [3, "Overcast"],
  [45, "Fog"],
  [48, "Rime fog"],
  [51, "Light drizzle"],
  [53, "Moderate drizzle"],
  [55, "Dense drizzle"],
  [56, "Freezing drizzle"],
  [57, "Dense freezing drizzle"],
  [61, "Slight rain"],
  [63, "Moderate rain"],
  [65, "Heavy rain"],
  [66, "Freezing rain"],
  [67, "Heavy freezing rain"],
  [71, "Slight snow"],
  [73, "Moderate snow"],
  [75, "Heavy snow"],
  [77, "Snow grains"],
  [80, "Slight rain showers"],
  [81, "Moderate rain showers"],
  [82, "Violent rain showers"],
  [85, "Slight snow showers"],
  [86, "Heavy snow showers"],
  [95, "Thunderstorm"],
  [96, "Thunderstorm with hail"],
  [99, "Severe thunderstorm with hail"],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_request, file, callback) => {
      const extension = file.mimetype === "image/png" ? ".png" : ".jpg";
      callback(null, `flora-${crypto.randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
      callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
      return;
    }
    callback(null, true);
  },
});

function receiveImage(request, response, next) {
  upload.single("image")(request, response, (error) => {
    if (error) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "Image must be 10MB or smaller."
          : "Upload a JPEG or PNG image.";
      response.status(400).json({ status: "error", message });
      return;
    }
    if (!request.file) {
      response.status(400).json({ status: "error", message: "An image is required." });
      return;
    }
    next();
  });
}

function selectedOrgan(request) {
  const organ = String(request.body.organ ?? "auto").toLowerCase();
  return allowedOrgans.has(organ) ? organ : "auto";
}

async function removeTemporaryFile(file) {
  if (!file?.path) return;
  try {
    await fs.unlink(file.path);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not remove temporary upload:", error.message);
    }
  }
}

function identificationRoute(handler) {
  return async (request, response, next) => {
    try {
      response.json(await handler(request.file, selectedOrgan(request)));
    } catch (error) {
      next(error);
    } finally {
      await removeTemporaryFile(request.file);
    }
  };
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function weatherLabel(code) {
  return weatherLabels.get(Number(code)) ?? "Unknown conditions";
}

function airQualityDetails(aqi) {
  const value = finiteNumber(aqi);
  if (value === null) {
    return { label: "Unavailable", plantImpact: "Air quality data unavailable." };
  }
  if (value <= 50) {
    return { label: "Good", plantImpact: "Low pollution. Suitable for outdoor cultivation." };
  }
  if (value <= 100) {
    return { label: "Moderate", plantImpact: "Moderate pollution. Most plants should tolerate current conditions." };
  }
  if (value <= 150) {
    return {
      label: "Unhealthy for sensitive groups",
      plantImpact: "Sensitive plants may show stress during prolonged exposure.",
    };
  }
  return { label: "Unhealthy", plantImpact: "High pollution may reduce plant vigor." };
}

function soilPhLabel(ph) {
  if (ph === null) return "Unavailable";
  if (ph < 5.5) return "Acidic";
  if (ph < 6.5) return "Slightly acidic";
  if (ph <= 7.5) return "Neutral";
  if (ph <= 8.5) return "Slightly alkaline";
  return "Alkaline";
}

function soilTextureClass(clay, sand) {
  if (clay === null || sand === null) return null;
  const silt = 100 - clay - sand;
  if (clay >= 40) return "Clay";
  if (sand >= 85) return "Sand";
  if (sand >= 70 && clay < 15) return "Sandy loam";
  if (clay >= 27 && clay < 40 && sand < 45) return "Clay loam";
  if (clay >= 20 && clay < 35 && sand < 45) return "Loam";
  if (silt >= 80) return "Silt";
  return "Loam";
}

function soilLayerMean(payload, property) {
  const layer = payload?.properties?.layers?.find((item) => item.name === property);
  return finiteNumber(layer?.depths?.[0]?.values?.mean);
}

function normalizeSoil(properties, classification) {
  if (!properties && !classification) return null;
  const rawPh = soilLayerMean(properties, "phh2o");
  const rawClay = soilLayerMean(properties, "clay");
  const rawSand = soilLayerMean(properties, "sand");
  const ph = rawPh === null ? null : round(rawPh / 10);
  const clayPercent = rawClay === null ? null : round(rawClay / 10);
  const sandPercent = rawSand === null ? null : round(rawSand / 10);
  const wrbClass =
    classification?.wrb_class_name ??
    classification?.classes?.[0]?.wrb_class_name ??
    classification?.classes?.[0]?.name ??
    null;
  const nitrogenCgKg = round(soilLayerMean(properties, "nitrogen"));
  const organicCarbonDgKg = round(soilLayerMean(properties, "soc"));
  if (
    ph === null &&
    clayPercent === null &&
    sandPercent === null &&
    nitrogenCgKg === null &&
    organicCarbonDgKg === null &&
    !wrbClass
  ) {
    return null;
  }

  return {
    ph,
    phLabel: soilPhLabel(ph),
    clayPercent,
    sandPercent,
    nitrogenCgKg,
    organicCarbonDgKg,
    wrbClass,
    textureClass: soilTextureClass(clayPercent, sandPercent),
  };
}

function normalizeWeather(payload) {
  if (!payload?.current || !payload?.daily) return null;
  const daily = payload.daily;
  const dates = Array.isArray(daily.time) ? daily.time : [];
  return {
    current: {
      tempC: round(payload.current.temperature_2m),
      precipMm: round(payload.current.precipitation),
      windKph: round(payload.current.wind_speed_10m ?? payload.current.windspeed_10m),
      conditionCode: finiteNumber(payload.current.weather_code ?? payload.current.weathercode),
      conditionLabel: weatherLabel(payload.current.weather_code ?? payload.current.weathercode),
    },
    forecast7day: dates.map((date, index) => ({
      date,
      maxC: round(daily.temperature_2m_max?.[index]),
      minC: round(daily.temperature_2m_min?.[index]),
      precipMm: round(daily.precipitation_sum?.[index]),
      conditionCode: finiteNumber(daily.weather_code?.[index] ?? daily.weathercode?.[index]),
      conditionLabel: weatherLabel(daily.weather_code?.[index] ?? daily.weathercode?.[index]),
    })),
  };
}

function normalizeAirQuality(payload) {
  if (!payload?.current) return null;
  const usAqi = round(payload.current.us_aqi, 0);
  const details = airQualityDetails(usAqi);
  return {
    usAqi,
    pm25: round(payload.current.pm2_5),
    pm10: round(payload.current.pm10),
    ...details,
  };
}

function monthlyClimate(payload) {
  const daily = payload?.daily;
  if (!Array.isArray(daily?.time)) return [];
  const buckets = Array.from({ length: 12 }, () => ({
    max: [],
    min: [],
    precipByPeriod: new Map(),
  }));

  daily.time.forEach((dateString, index) => {
    const date = new Date(`${dateString}T00:00:00Z`);
    const month = date.getUTCMonth();
    const period = dateString.slice(0, 7);
    const max = finiteNumber(daily.temperature_2m_max?.[index]);
    const min = finiteNumber(daily.temperature_2m_min?.[index]);
    const precip = finiteNumber(daily.precipitation_sum?.[index]) ?? 0;
    if (max !== null) buckets[month].max.push(max);
    if (min !== null) buckets[month].min.push(min);
    buckets[month].precipByPeriod.set(
      period,
      (buckets[month].precipByPeriod.get(period) ?? 0) + precip,
    );
  });

  const average = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  return buckets.map((bucket, month) => ({
    month: monthNames[month],
    avgMaxC: round(average(bucket.max)),
    avgMinC: round(average(bucket.min)),
    avgPrecipMm: round(average([...bucket.precipByPeriod.values()])),
  }));
}

function validRange(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const low = finiteNumber(value[0]);
  const high = finiteNumber(value[1]);
  return low === null || high === null || low > high ? null : [low, high];
}

function inRange(value, range) {
  return value !== null && range && value >= range[0] && value <= range[1];
}

function plantingDetails(monthlyAverages, growthConditions) {
  if (!growthConditions || !monthlyAverages.length) {
    return { bestPlantingMonths: null, currentMonthSuitability: null };
  }
  const tempRange = validRange(growthConditions.tempRange_C);
  const precipRange = validRange(growthConditions.precipRange_mm);
  if (!tempRange && !precipRange) {
    return { bestPlantingMonths: null, currentMonthSuitability: null };
  }

  const suitable = monthlyAverages.filter((month) => {
    const temperatureFits = !tempRange || inRange(month.avgMaxC, tempRange);
    const annualizedPrecip = month.avgPrecipMm === null ? null : month.avgPrecipMm * 12;
    const precipitationFits = !precipRange || inRange(annualizedPrecip, precipRange);
    return temperatureFits && precipitationFits;
  });
  const bestPlantingMonths = suitable.map((month) => month.month);
  const current = monthlyAverages[new Date().getMonth()];
  const isGood = current && bestPlantingMonths.includes(current.month);
  let currentMonthSuitability = isGood ? "good" : "poor";

  if (!isGood && current) {
    const tempCenter = tempRange ? (tempRange[0] + tempRange[1]) / 2 : current.avgMaxC;
    const precipAnnual = current.avgPrecipMm === null ? null : current.avgPrecipMm * 12;
    const tempMargin = tempRange
      ? Math.max(tempRange[1] - tempRange[0], 1) * 0.2
      : Infinity;
    const precipMargin = precipRange
      ? Math.max(precipRange[1] - precipRange[0], 1) * 0.2
      : Infinity;
    const tempNear =
      !tempRange ||
      Math.abs(current.avgMaxC - tempCenter) <= (tempRange[1] - tempRange[0]) / 2 + tempMargin;
    const precipNear =
      !precipRange ||
      (precipAnnual !== null &&
        precipAnnual >= precipRange[0] - precipMargin &&
        precipAnnual <= precipRange[1] + precipMargin);
    if (tempNear && precipNear) currentMonthSuitability = "marginal";
  }

  return { bestPlantingMonths, currentMonthSuitability };
}

// USDA zone derived from average annual minimum temp (F)
// Zone 1: < -50  Zone 2: -50 to -40  Zone 3: -40 to -30
// Zone 4: -30 to -20  Zone 5: -20 to -10  Zone 6: -10 to 0
// Zone 7: 0 to 10  Zone 8: 10 to 20  Zone 9: 20 to 30
// Zone 10: 30 to 40  Zone 11: 40 to 50  Zone 12: 50 to 60  Zone 13: > 60
function derivedHardinessZone(archive) {
  const minimums = archive?.daily?.temperature_2m_min
    ?.map(finiteNumber)
    .filter((value) => value !== null);
  if (!minimums?.length) return null;
  const minimumF = Math.min(...minimums) * 9 / 5 + 32;
  const zoneNumber = Math.max(1, Math.min(13, Math.floor((minimumF + 60) / 10) + 1));
  const lowerBoundary = -60 + (zoneNumber - 1) * 10;
  const subzone = minimumF < lowerBoundary + 5 ? "a" : "b";
  return `${zoneNumber}${subzone}`;
}

function extractZipCode(payload) {
  const match = payload?.result?.addressMatches?.[0];
  const direct = match?.addressComponents?.zip;
  if (direct) return String(direct).slice(0, 5);
  const geographies = match?.geographies ?? payload?.result?.geographies;
  const zipGroup = geographies?.["ZIP Code Tabulation Areas"] ?? geographies?.["2020 Census ZIP Code Tabulation Areas"];
  const zip = zipGroup?.[0]?.ZCTA5 ?? zipGroup?.[0]?.GEOID;
  return zip ? String(zip).slice(0, 5) : null;
}

function hardinessZoneNumber(zone) {
  const match = String(zone ?? "").match(/^(\d{1,2})/);
  return match ? Number(match[1]) : null;
}

function inferNativeHardinessRange(regions) {
  const text = Array.isArray(regions) ? regions.join(" ").toLowerCase() : "";
  if (!text) return null;
  if (/tropic|caribbean|equatorial|amazon|central america/.test(text)) return [9, 13];
  if (/mediterranean|southern europe|north africa|middle east/.test(text)) return [7, 11];
  if (/arctic|subarctic|siberia|northern canada|alaska/.test(text)) return [1, 6];
  if (/europe|western asia|temperate/.test(text)) return [3, 10];
  if (/africa|australia|south america/.test(text)) return [7, 13];
  return null;
}

function compatibilityDetails({ weather, airQuality, soil, seasonal, hardinessZone, growthConditions }) {
  let score = 100;
  const reasons = [];
  const warnings = [];
  const phRange = validRange(growthConditions?.phRange);
  const tempRange = validRange(growthConditions?.tempRange_C);
  const precipRange = validRange(growthConditions?.precipRange_mm);

  if (soil?.ph !== null && soil?.ph !== undefined) {
    if (phRange && !inRange(soil.ph, phRange)) {
      score -= 20;
      warnings.push(`Soil pH ${soil.ph} is outside the preferred ${phRange[0]}-${phRange[1]} range`);
    } else if (phRange) {
      reasons.push(`Soil pH ${soil.ph} is within the preferred range`);
    } else {
      reasons.push(`Local soil is ${soil.phLabel.toLowerCase()} at pH ${soil.ph}`);
    }
  }

  const currentTemp = weather?.current?.tempC ?? null;
  if (currentTemp !== null && tempRange) {
    if (inRange(currentTemp, tempRange)) {
      reasons.push("Current temperature is within the plant's tolerance");
    } else {
      score -= 15;
      warnings.push("Current temperature is outside the plant's preferred range");
    }
  }

  const climateMonths = seasonal?.monthlyAverages;
  const annualRainfall = climateMonths?.length
    ? climateMonths.reduce((total, month) => total + (month.avgPrecipMm ?? 0), 0)
    : null;
  if (annualRainfall !== null && precipRange) {
    if (inRange(annualRainfall, precipRange)) {
      reasons.push("Estimated annual rainfall is within the preferred range");
    } else {
      score -= 15;
      warnings.push("Estimated annual rainfall is outside the preferred range");
    }
  }

  const aqi = airQuality?.usAqi;
  if (aqi !== null && aqi !== undefined) {
    if (aqi <= 100) reasons.push("Air quality is suitable for outdoor cultivation");
    if (aqi > 100) {
      score -= 10;
      warnings.push("Elevated air pollution may stress sensitive plants");
    }
    if (aqi > 150) score -= 10;
  }

  const explicitZoneRange = validRange(growthConditions?.hardinessZones);
  const inferredZoneRange =
    explicitZoneRange ?? inferNativeHardinessRange(growthConditions?.nativeRegions);
  const zoneNumber = hardinessZoneNumber(hardinessZone);
  if (zoneNumber !== null && inferredZoneRange) {
    if (inRange(zoneNumber, inferredZoneRange)) {
      reasons.push(`Hardiness zone ${hardinessZone} aligns with the plant's typical range`);
    } else {
      score -= 20;
      warnings.push(`Hardiness zone ${hardinessZone} may be outside the plant's typical range`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  const label = score >= 75 ? "Good match" : score >= 50 ? "Fair match" : "Poor match";
  return { score, label, reasons: reasons.slice(0, 5), warnings: warnings.slice(0, 5) };
}

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    plantnetConfigured: Boolean(process.env.PLANTNET_API_KEY),
    trefleConfigured: Boolean(process.env.TREFLE_TOKEN),
    localModelConfigured: isLocalModelConfigured(),
  });
});

app.post(
  "/identify/plantnet",
  receiveImage,
  identificationRoute(identifyWithPlantNet),
);
app.post(
  "/identify/local",
  receiveImage,
  identificationRoute(identifyWithLocalModel),
);

app.post("/environment", async (request, response) => {
  const lat = finiteNumber(request.body?.lat);
  const lon = finiteNumber(request.body?.lon);
  const growthConditions = request.body?.plantGrowthConditions ?? null;
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    response.status(400).json({ message: "Valid latitude and longitude are required." });
    return;
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
    forecast_days: "7",
    timezone: "auto",
  });

  const airUrl = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  airUrl.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "us_aqi,pm2_5,pm10",
  });

  const archiveUrl = new URL("https://archive-api.open-meteo.com/v1/archive");
  archiveUrl.search = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    start_date: isoDateDaysAgo(365),
    end_date: isoDateDaysAgo(1),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum",
    timezone: "auto",
  });

  const soilPropertiesUrl = new URL("https://rest.isric.org/soilgrids/v2.0/properties/query");
  soilPropertiesUrl.searchParams.set("lon", String(lon));
  soilPropertiesUrl.searchParams.set("lat", String(lat));
  ["phh2o", "clay", "sand", "nitrogen", "soc"].forEach((property) =>
    soilPropertiesUrl.searchParams.append("property", property),
  );
  soilPropertiesUrl.searchParams.set("depth", "0-5cm");
  soilPropertiesUrl.searchParams.set("value", "mean");

  const soilClassUrl = new URL("https://rest.isric.org/soilgrids/v2.0/classification/query");
  soilClassUrl.search = new URLSearchParams({
    lon: String(lon),
    lat: String(lat),
    number_classes: "1",
  });

  const censusUrl = new URL("https://geocoding.geo.census.gov/geocoder/geographies/coordinates");
  censusUrl.search = new URLSearchParams({
    x: String(lon),
    y: String(lat),
    benchmark: "4",
    vintage: "4",
    format: "json",
  });

  const hardinessLookup = fetchJson(censusUrl, 3000).then(async (census) => {
    const zipCode = extractZipCode(census);
    if (!zipCode) return null;
    const hardiness = await fetchJson(`https://phzmapi.org/${zipCode}.json`, 3000);
    return hardiness.zone ?? null;
  });

  const settled = await Promise.allSettled([
    fetchJson(forecastUrl),
    fetchJson(airUrl),
    fetchJson(archiveUrl, 8000),
    fetchJson(soilPropertiesUrl, 4000),
    fetchJson(soilClassUrl, 4000),
    hardinessLookup,
  ]);
  const names = ["weather", "air quality", "archive", "soil properties", "soil classification", "hardiness"];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(`${names[index]} data unavailable:`, result.reason?.message ?? result.reason);
    }
  });
  const value = (index) => settled[index].status === "fulfilled" ? settled[index].value : null;

  const weather = normalizeWeather(value(0));
  const airQuality = normalizeAirQuality(value(1));
  const archive = value(2);
  const soil = normalizeSoil(value(3), value(4));
  if (!weather && !airQuality && !archive && !soil) {
    response.status(503).json({ message: "Environmental data is temporarily unavailable." });
    return;
  }
  const monthlyAverages = monthlyClimate(archive);
  const planting = plantingDetails(monthlyAverages, growthConditions);

  let hardinessZone = null;
  let hardinessSource = null;
  hardinessZone = value(5);
  hardinessSource = hardinessZone ? "phzmapi" : null;
  if (!hardinessZone) {
    hardinessZone = derivedHardinessZone(archive);
    hardinessSource = hardinessZone ? "open-meteo-derived" : null;
  }

  const seasonal = {
    monthlyAverages,
    ...planting,
  };
  const compatibility = compatibilityDetails({
    weather,
    airQuality,
    soil,
    seasonal,
    hardinessZone,
    growthConditions,
  });
  const sources = [];
  if (weather || archive) sources.push("open-meteo");
  if (soil) sources.push("soilgrids");
  if (hardinessSource === "phzmapi") sources.push("phzmapi");

  response.json({
    location: { lat, lon, hardinessZone, hardinessSource },
    weather,
    airQuality,
    soil,
    seasonal,
    compatibility,
    meta: { timestamp: new Date().toISOString(), sources },
  });
});

app.use((error, _request, response, _next) => {
  if (error instanceof IdentificationServiceError) {
    response.status(503).json({ status: "error", message: error.message });
    return;
  }
  console.error("Unexpected server error:", error);
  response.status(500).json({ status: "error", message: "Something went wrong." });
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`flora. is listening at http://localhost:${port}`);
});

export { app, server };
