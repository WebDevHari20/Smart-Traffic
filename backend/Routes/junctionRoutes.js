const express = require('express');
const axios = require('axios');
const Junction = require('../model/junction');

const router = express.Router();

const ROUTE_ORDER = ['shortest', 'traffic', 'optimized'];

const MAX_JUNCTIONS = 3;
const VEHICLE_GREEN_THRESHOLD = Number(process.env.VEHICLE_GREEN_THRESHOLD || 10);

const VEHICLE_KEYWORDS = [
  'car',
  'vehicle',
  'truck',
  'bus',
  'motorcycle',
  'bike',
  'van',
  'auto',
  'suv',
  'taxi'
];

const AMBULANCE_KEYWORDS = ['ambulance', 'emergency vehicle'];

const toLower = (value) => String(value || '').toLowerCase();

const hasAnyKeyword = (text, keywords) => {
  const value = toLower(text);
  return keywords.some((keyword) => value.includes(keyword));
};

const countVehiclesFromVision = (visionPayload) => {
  const objects = Array.isArray(visionPayload?.objects) ? visionPayload.objects : [];
  const tags = Array.isArray(visionPayload?.tags) ? visionPayload.tags : [];

  const objectVehicleCount = objects.reduce((count, item) => {
    if (hasAnyKeyword(item?.object, VEHICLE_KEYWORDS)) {
      return count + 1;
    }
    return count;
  }, 0);

  if (objectVehicleCount > 0) {
    return objectVehicleCount;
  }

  const tagVehicleScore = tags.reduce((score, item) => {
    if (hasAnyKeyword(item?.name, VEHICLE_KEYWORDS) && typeof item?.confidence === 'number') {
      return score + item.confidence;
    }
    return score;
  }, 0);

  return Math.max(0, Math.round(tagVehicleScore * 10));
};

const hasAmbulanceFromVision = (visionPayload) => {
  const objects = Array.isArray(visionPayload?.objects) ? visionPayload.objects : [];
  const tags = Array.isArray(visionPayload?.tags) ? visionPayload.tags : [];

  const ambulanceInObjects = objects.some((item) => hasAnyKeyword(item?.object, AMBULANCE_KEYWORDS));
  const ambulanceInTags = tags.some((item) => hasAnyKeyword(item?.name, AMBULANCE_KEYWORDS));

  return ambulanceInObjects || ambulanceInTags;
};

const analyzeImageWithAzure = async (imageUrl) => {
  const endpoint = process.env.AZURE_COMPUTER_VISION_ENDPOINT;
  const key = process.env.AZURE_COMPUTER_VISION_KEY;

  if (!endpoint || !key) {
    throw new Error('Azure Computer Vision is not configured. Set AZURE_COMPUTER_VISION_ENDPOINT and AZURE_COMPUTER_VISION_KEY in backend .env');
  }

  if (!imageUrl || typeof imageUrl !== 'string') {
    return { vehicleCount: 0, hasAmbulance: false };
  }

  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const url = `${base}/vision/v3.2/analyze?visualFeatures=Objects,Tags`;

  const { data } = await axios.post(
    url,
    { url: imageUrl },
    {
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    }
  );

  return {
    vehicleCount: countVehiclesFromVision(data),
    hasAmbulance: hasAmbulanceFromVision(data)
  };
};

const parseBase64Image = (imageBase64) => {
  if (!imageBase64 || typeof imageBase64 !== 'string') return null;

  const dataUrlMatch = imageBase64.match(/^data:(.+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1] || 'application/octet-stream',
      buffer: Buffer.from(dataUrlMatch[2], 'base64')
    };
  }

  return {
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(imageBase64, 'base64')
  };
};

const analyzeInputWithAzure = async ({ imageUrl, imageBase64 }) => {
  const endpoint = process.env.AZURE_COMPUTER_VISION_ENDPOINT;
  const key = process.env.AZURE_COMPUTER_VISION_KEY;

  if (!endpoint || !key) {
    throw new Error('Azure Computer Vision is not configured. Set AZURE_COMPUTER_VISION_ENDPOINT and AZURE_COMPUTER_VISION_KEY in backend .env');
  }

  const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  const url = `${base}/vision/v3.2/analyze?visualFeatures=Objects,Tags`;

  if (imageUrl && typeof imageUrl === 'string') {
    const { data } = await axios.post(
      url,
      { url: imageUrl },
      {
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );

    return {
      vehicleCount: countVehiclesFromVision(data),
      hasAmbulance: hasAmbulanceFromVision(data)
    };
  }

  const parsed = parseBase64Image(imageBase64);
  if (!parsed || !parsed.buffer?.length) {
    return { vehicleCount: 0, hasAmbulance: false };
  }

  const { data } = await axios.post(
    url,
    parsed.buffer,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': parsed.mimeType || 'application/octet-stream'
      },
      timeout: 12000,
      maxBodyLength: Infinity
    }
  );

  return {
    vehicleCount: countVehiclesFromVision(data),
    hasAmbulance: hasAmbulanceFromVision(data)
  };
};

const buildSignalPlan = (routeResults) => {
  const ambulanceRoutes = routeResults.filter((item) => item.hasAmbulance);

  let greenRoutes = [];
  let strategy = 'lowest-traffic';
  let reason = 'No ambulance detected. Route with least vehicles gets green priority.';

  if (ambulanceRoutes.length === 1) {
    strategy = 'single-ambulance-all-green';
    reason = 'Single ambulance detected. All routes turned green for emergency clearance.';
    greenRoutes = [...ROUTE_ORDER];
  } else if (ambulanceRoutes.length >= 2) {
    strategy = 'multi-ambulance-shortest-priority';
    reason = 'Multiple ambulances detected. Shortest route gets green priority.';
    greenRoutes = ['shortest'];
  } else {
    const sorted = [...routeResults].sort((a, b) => a.vehicleCount - b.vehicleCount);
    greenRoutes = sorted.length ? [sorted[0].routeId] : ['shortest'];
  }

  const signalByRoute = ROUTE_ORDER.reduce((acc, routeId) => {
    acc[routeId] = {
      light: greenRoutes.includes(routeId) ? 'green' : 'red',
      hasPriority: greenRoutes.includes(routeId)
    };
    return acc;
  }, {});

  return {
    strategy,
    reason,
    greenRoutes,
    signalByRoute
  };
};

const buildJunctionSignalPlan = (junctionResults) => {
  const ambulanceJunctions = junctionResults.filter((item) => item.hasAmbulance);

  let greenJunctionIds = [];
  let strategy = 'vehicle-threshold-priority';
  let reason = `No ambulance detected. Junctions above vehicle threshold (${VEHICLE_GREEN_THRESHOLD}) get green.`;

  if (ambulanceJunctions.length > 0) {
    strategy = 'ambulance-priority';
    reason = 'Ambulance detected. Ambulance junctions are green and all other junctions are red.';
    greenJunctionIds = ambulanceJunctions.map((item) => item.junctionId);
  } else {
    greenJunctionIds = junctionResults
      .filter((item) => item.vehicleCount > VEHICLE_GREEN_THRESHOLD)
      .map((item) => item.junctionId);
  }

  const signalByJunction = junctionResults.reduce((acc, item) => {
    const isGreen = greenJunctionIds.includes(item.junctionId);
    acc[item.junctionId] = {
      light: isGreen ? 'green' : 'red',
      hasPriority: isGreen
    };
    return acc;
  }, {});

  return {
    strategy,
    reason,
    greenJunctionIds,
    signalByJunction
  };
};

// Get all junction rows.
router.get('/', async (req, res) => {
  try {
    const data = await Junction.find();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get total vehicle count and ambulance presence summary.
router.get('/summary', async (req, res) => {
  try {
    const summary = await Junction.getVehicleCountSummary();
    res.status(200).json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update ambulance status across all 3 junctions using request body.
router.patch('/ambulance', async (req, res) => {
  try {
    const { isAmbulancePresent } = req.body;

    if (typeof isAmbulancePresent !== 'boolean') {
      return res.status(400).json({
        message: 'isAmbulancePresent must be boolean (true or false).',
      });
    }

    const updatedRows = await Junction.updateAmbulanceForAllJunctions(isAmbulancePresent);
    res.status(200).json({ updatedRows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// If any junction has ambulance=true, set all 3 junctions to true.
router.patch('/sync-ambulance', async (req, res) => {
  try {
    const summary = await Junction.syncAmbulanceStatus();
    res.status(200).json(summary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Analyze route camera images using Azure Vision and compute signal state.
router.post('/vision-priority', async (req, res) => {
  try {
    const routeImages = req.body?.routeImages || {};

    const analyses = await Promise.all(
      ROUTE_ORDER.map(async (routeId) => {
        const imageUrl = routeImages[routeId] || '';
        const analysis = await analyzeImageWithAzure(imageUrl);
        return {
          routeId,
          imageUrl,
          vehicleCount: analysis.vehicleCount,
          hasAmbulance: analysis.hasAmbulance
        };
      })
    );

    const hasAnyAmbulance = analyses.some((item) => item.hasAmbulance);
    await Junction.updateAmbulanceForAllJunctions(hasAnyAmbulance);

    const signalPlan = buildSignalPlan(analyses);

    return res.status(200).json({
      routeStats: analyses,
      hasAnyAmbulance,
      signalPlan
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Analyze three junction images dynamically and persist result per junction.
router.post('/vision-junctions', async (req, res) => {
  try {
    const requestedJunctionImages = Array.isArray(req.body?.junctionImages)
      ? req.body.junctionImages
      : [];

    if (!requestedJunctionImages.length) {
      return res.status(400).json({ message: 'junctionImages is required and must be a non-empty array.' });
    }

    const availableJunctions = await Junction.find();
    const allowedJunctions = Array.isArray(availableJunctions)
      ? availableJunctions
          .filter((item) => [1, 2, 3].includes(Number(item?.id)))
          .slice(0, MAX_JUNCTIONS)
      : [];

    if (!allowedJunctions.length) {
      return res.status(404).json({ message: 'Configured junction rows (ids 1,2,3) were not found.' });
    }

    const allowedJunctionIds = new Set(allowedJunctions.map((item) => Number(item.id)));

    const normalizedInputs = requestedJunctionImages
      .map((item) => ({
        junctionId: Number(item?.junctionId),
        imageUrl: item?.imageUrl || '',
        imageBase64: item?.imageBase64 || '',
      }))
      .filter((item) => allowedJunctionIds.has(item.junctionId));

    if (!normalizedInputs.length) {
      return res.status(400).json({ message: 'No valid junctionId found in request. Use junction ids 1, 2, 3.' });
    }

    const analyses = await Promise.all(
      normalizedInputs.map(async (item) => {
        const analysis = await analyzeInputWithAzure({
          imageUrl: item.imageUrl,
          imageBase64: item.imageBase64,
        });

        const foundJunction = allowedJunctions.find((junctionItem) => Number(junctionItem.id) === item.junctionId);

        return {
          junctionId: item.junctionId,
          junctionName: foundJunction?.name || `Junction ${item.junctionId}`,
          vehicleCount: analysis.vehicleCount,
          hasAmbulance: analysis.hasAmbulance,
          imageUrl: item.imageUrl,
        };
      })
    );

    const signalPlan = buildJunctionSignalPlan(analyses);

    const junctionMetrics = analyses.map((item) => ({
      junctionId: item.junctionId,
      vehicleCount: item.vehicleCount,
      hasAmbulance: item.hasAmbulance,
      signalStatus: signalPlan.signalByJunction[item.junctionId]?.light === 'green' ? 'GREEN' : 'RED'
    }));

    const persisted = await Junction.updateJunctionMetricsBatch(junctionMetrics);

    return res.status(200).json({
      junctionStats: analyses,
      signalPlan,
      persisted
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;