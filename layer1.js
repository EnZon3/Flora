import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import FormData from "form-data";
import fetch from "node-fetch";

const CONFIDENCE_THRESHOLD = 0.7;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localModelDirectory = path.join(
  __dirname,
  "models",
  "pretrained_models",
);
const localModelWeights = path.join(
  localModelDirectory,
  "vit_base_patch14_reg4_dinov2_lvd142m_pc24_onlyclassifier_then_all",
  "model_best.pth.tar",
);
const localClassMapping = path.join(localModelDirectory, "class_mapping.txt");
const localSpeciesMapping = path.join(localModelDirectory, "species_id_to_name.json");

export class IdentificationServiceError extends Error {}

export function isLocalModelConfigured() {
  return (
    fs.existsSync(localModelWeights) &&
    fs.existsSync(localClassMapping) &&
    fs.existsSync(localSpeciesMapping)
  );
}

function normalizeCandidate(candidate) {
  const species = candidate.species ?? candidate;
  const scientificName =
    species.scientificNameWithoutAuthor ??
    species.scientificName ??
    candidate.scientificName ??
    "Unknown species";
  const family =
    species.family?.scientificNameWithoutAuthor ??
    species.family?.scientificName ??
    species.family ??
    candidate.family ??
    "Unknown";

  return {
    scientificName,
    commonNames: Array.isArray(species.commonNames)
      ? species.commonNames.filter(Boolean)
      : Array.isArray(candidate.commonNames)
        ? candidate.commonNames.filter(Boolean)
        : [],
    family,
    confidence: Number(candidate.score ?? candidate.confidence ?? 0),
  };
}

function pfafUrl(scientificName) {
  return `https://pfaf.org/user/Plant.aspx?LatinName=${encodeURIComponent(scientificName)}`;
}

function unknownEdibility() {
  return {
    isEdible: "unknown",
    edibleParts: [],
    toxicity: "unknown",
    safetyNote: "Always verify with a local expert before consuming any wild plant.",
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function temperatureValue(value) {
  return numberOrNull(value?.deg_c ?? value);
}

function precipitationValue(value) {
  return numberOrNull(value?.mm ?? value);
}

function normalizeEdibleParts(value) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part).toLowerCase()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function nativeRegions(species) {
  const distributions = species.distributions?.native ?? species.distribution?.native ?? [];
  if (!Array.isArray(distributions)) return [];
  return distributions
    .map((region) => region?.name ?? region)
    .filter((region) => typeof region === "string");
}

async function lookupTrefle(scientificName) {
  const token = process.env.TREFLE_TOKEN;
  if (!token) return null;

  const searchUrl = new URL("https://trefle.io/api/v1/species/search");
  searchUrl.searchParams.set("token", token);
  searchUrl.searchParams.set("q", scientificName);

  const searchResponse = await fetch(searchUrl);
  if (!searchResponse.ok) {
    throw new Error(`Trefle search returned ${searchResponse.status}`);
  }

  const searchPayload = await searchResponse.json();
  const match = searchPayload.data?.[0];
  if (!match?.id) return null;

  const detailUrl = new URL(`https://trefle.io/api/v1/species/${match.id}`);
  detailUrl.searchParams.set("token", token);
  const detailResponse = await fetch(detailUrl);
  if (!detailResponse.ok) {
    throw new Error(`Trefle detail returned ${detailResponse.status}`);
  }

  const species = (await detailResponse.json()).data ?? {};
  const edibleParts = normalizeEdibleParts(species.edible_part ?? species.edible_parts);
  const explicitlyEdible = species.edible === true;
  const explicitlyNotEdible = species.edible === false;

  return {
    trefleId: match.id,
    edibility: {
      isEdible: explicitlyEdible || edibleParts.length > 0
        ? true
        : explicitlyNotEdible
          ? false
          : "unknown",
      edibleParts,
      toxicity: species.toxicity ?? "unknown",
      safetyNote: "Always verify with a local expert before consuming any wild plant.",
    },
    growthConditions: {
      light: numberOrNull(species.light),
      soilRichness: numberOrNull(species.soil_nutriments),
      humidity: numberOrNull(species.soil_humidity),
      tempRange_C: [
        temperatureValue(species.minimum_temperature),
        temperatureValue(species.maximum_temperature),
      ],
      precipRange_mm: [
        precipitationValue(species.minimum_precipitation),
        precipitationValue(species.maximum_precipitation),
      ],
      nativeRegions: nativeRegions(species),
    },
  };
}

async function enrichCandidate(candidate) {
  let enrichment = null;
  try {
    enrichment = await lookupTrefle(candidate.scientificName);
  } catch (error) {
    console.warn("Trefle enrichment failed:", error.message);
  }

  return {
    edibility: enrichment?.edibility ?? unknownEdibility(),
    growthConditions: enrichment?.growthConditions ?? null,
    references: {
      pfafUrl: pfafUrl(candidate.scientificName),
      trefleId: enrichment?.trefleId ?? null,
    },
  };
}

async function buildResponse(candidates, backend, requestsRemaining = null) {
  const topCandidates = candidates.slice(0, 3).map(normalizeCandidate);
  const top = topCandidates[0];

  if (!top) {
    return {
      status: "no_plant",
      message: "No plant detected in this image.",
      meta: {
        backend,
        apiRequestsRemainingToday: requestsRemaining,
        timestamp: new Date().toISOString(),
      },
    };
  }

  const identification = {
    scientificName: top.scientificName,
    commonNames: top.commonNames,
    family: top.family,
    confidence: top.confidence,
    allCandidates: topCandidates.map(({ scientificName, commonNames, confidence }) => ({
      scientificName,
      commonNames,
      confidence,
    })),
  };

  const base = {
    status: top.confidence >= CONFIDENCE_THRESHOLD ? "identified" : "low_confidence",
    ...(top.confidence < CONFIDENCE_THRESHOLD && {
      message:
        "Couldn't identify with enough certainty. Try a clearer photo of the leaf, flower, or fruit.",
    }),
    identification,
    meta: {
      backend,
      apiRequestsRemainingToday: requestsRemaining,
      timestamp: new Date().toISOString(),
    },
  };

  if (top.confidence < CONFIDENCE_THRESHOLD) {
    return {
      ...base,
      edibility: unknownEdibility(),
      growthConditions: null,
      references: { pfafUrl: pfafUrl(top.scientificName), trefleId: null },
    };
  }

  return { ...base, ...(await enrichCandidate(top)) };
}

export async function identifyWithPlantNet(file, organ) {
  if (!process.env.PLANTNET_API_KEY) {
    throw new IdentificationServiceError("Pl@ntNet is not configured.");
  }

  const form = new FormData();
  form.append("images", fs.createReadStream(file.path), {
    filename: file.originalname,
    contentType: file.mimetype,
  });
  form.append("organs", organ);

  const url = new URL("https://my-api.plantnet.org/v2/identify/all");
  url.searchParams.set("api-key", process.env.PLANTNET_API_KEY);
  url.searchParams.set("lang", "en");
  url.searchParams.set("include-related-images", "false");
  url.searchParams.set("no-reject", "false");

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: form.getHeaders(),
      body: form,
    });
  } catch (error) {
    console.error("Pl@ntNet request failed:", error.message);
    throw new IdentificationServiceError("Identification service unavailable.");
  }

  if (!response.ok) {
    const diagnostic = await response.text();
    console.error(`Pl@ntNet returned ${response.status}:`, diagnostic.slice(0, 500));
    throw new IdentificationServiceError("Identification service unavailable.");
  }

  const payload = await response.json();
  const rejectedAsPlant =
    payload.is_plant === false ||
    payload.isPlant === false ||
    payload.isPlant?.binary === false;
  if (rejectedAsPlant) {
    return {
      status: "no_plant",
      message: "No plant detected in this image.",
      meta: {
        backend: "plantnet",
        apiRequestsRemainingToday: payload.remainingIdentificationRequests ?? null,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return buildResponse(
    payload.results ?? [],
    "plantnet",
    payload.remainingIdentificationRequests ?? null,
  );
}

function runInference(filePath, organ) {
  const scriptPath = path.join(__dirname, "models", "infer.py");
  const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

  return new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, "--image", filePath, "--organ", organ], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Local inference exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Local inference returned invalid JSON."));
      }
    });
  });
}

export async function identifyWithLocalModel(file, organ) {
  if (!isLocalModelConfigured()) {
    throw new IdentificationServiceError(
      "Local model is not installed. Use the Pl@ntNet API backend.",
    );
  }
  try {
    const payload = await runInference(file.path, organ);
    if (payload.isPlant === false || payload.is_plant === false) {
      return {
        status: "no_plant",
        message: "No plant detected in this image.",
        meta: {
          backend: "local",
          apiRequestsRemainingToday: null,
          timestamp: new Date().toISOString(),
        },
      };
    }
    return buildResponse(payload.candidates ?? payload.results ?? [], "local");
  } catch (error) {
    console.error("Local inference failed:", error.message);
    throw new IdentificationServiceError("Local identification service unavailable.");
  }
}
