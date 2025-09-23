const mongoose = require('mongoose');
mongoose.connect("mongodb://localhost:27017/WhereIsBus")
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
const Route = require('./RouteModel')
const Bus = require('./BusModel')
const Agency = require('./AgencyModel')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
console.log(Route)

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_key_change_me';

// --- In-memory live bus registry (multi-bus support) ---
// busRegistry[busId] = { routeId, routeName, busNumber, stops: [{name, lat, lon}], currentLocation, currentStopIndex, lastUpdate }
const busRegistry = Object.create(null);

// --- Utility: generate a unique 4-char alphanumeric ID ---
function generateCandidateId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function generateUniqueBusId() {
  // Try a number of times to avoid rare collisions
  for (let i = 0; i < 10000; i++) {
    const candidate = generateCandidateId();
    if (!busRegistry[candidate]) return candidate;
  }
  return null;
}

// --- Haversine distance (meters) ---
function getDistance(coord1, coord2) {
  const R = 6371000; // meters
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(coord2.lat - coord1.lat);
  const dLon = toRad(coord2.lon - coord1.lon);
  const lat1 = toRad(coord1.lat);
  const lat2 = toRad(coord2.lat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --- Auth helpers and routes ---
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function createToken(agency) {
  return jwt.sign({ sub: String(agency._id), email: agency.email }, JWT_SECRET, { expiresIn: '7d' });
}
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.agencyId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    console.log(req.body)
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    const exists = await Agency.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const agency = await Agency.create({ name, email: email.toLowerCase(), passwordHash, salt });
    const token = createToken(agency);
    return res.json({ token, agency: { id: String(agency._id), name: agency.name, email: agency.email } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
    const agency = await Agency.findOne({ email: email.toLowerCase() });
    if (!agency) return res.status(401).json({ error: 'Invalid credentials' });
    const computed = hashPassword(password, agency.salt);
    if (computed !== agency.passwordHash) return res.status(401).json({ error: 'Invalid credentials' });
    const token = createToken(agency);
    return res.json({ token, agency: { id: String(agency._id), name: agency.name, email: agency.email } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// --- Driver sends live location ---
// --- Register a bus to a route ---
app.post("/api/register-bus", async (req, res) => {
  try {
    const { busId, routeId, busNumber } = req.body;
    if (!busId || !routeId) {
      return res.status(400).json({ error: "busId and routeId are required" });
    }

    const routeDoc = await Route.findById(routeId);
    if (!routeDoc) return res.status(404).json({ error: "Route not found" });

    // If already in registry, just return success
    if (busRegistry[busId]) {
      return res.json({ success: true, busId, routeId });
    }

    // Try to find existing bus in DB; if exists, ensure registry entry and return
    const existing = await Bus.findOne({ shortId: busId });
    if (existing) {
      const routeForExisting = await Route.findById(existing.routeId);
      if (!routeForExisting) return res.status(404).json({ error: "Route not found for existing bus" });
      const stopsExisting = routeForExisting.stops.map((s) => ({ name: s.stopName, lat: s.latitude, lon: s.longitude }));
      busRegistry[busId] = {
        routeId: String(routeForExisting._id),
        routeName: routeForExisting.routeName,
        busNumber: busNumber || busId,
        stops: stopsExisting,
        currentLocation: { lat: null, lon: null },
        currentStopIndex: -1,
        lastUpdate: null,
      };
      return res.json({ success: true, busId, routeId: String(routeForExisting._id) });
    }

    const stops = routeDoc.stops.map((s) => ({
      name: s.stopName,
      lat: s.latitude,
      lon: s.longitude,
    }));

    busRegistry[busId] = {
      routeId,
      routeName: routeDoc.routeName,
      busNumber: busNumber || busId,
      stops,
      currentLocation: { lat: null, lon: null },
      currentStopIndex: -1,
      lastUpdate: null,
    };

    // Save persistent bus record
    await Bus.create({ shortId: busId, registration: busNumber || busId, routeId: routeDoc._id, routeName: routeDoc.routeName });

    return res.json({ success: true, busId, routeId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to register bus" });
  }
});

// --- Generate a unique 4-char bus id ---
app.get('/api/generate-bus-id', async (req, res) => {
  // Ensure uniqueness across both live registry and DB
  for (let i = 0; i < 10000; i++) {
    const candidate = generateCandidateId();
    if (busRegistry[candidate]) continue;
    const exists = await Bus.findOne({ shortId: candidate }).lean();
    if (!exists) return res.json({ id: candidate });
  }
  return res.status(500).json({ error: 'Unable to generate unique id' });
});

// --- Lookup bus by 4-char id and return its assigned route ---
app.get('/api/bus-lookup/:busId', async (req, res) => {
  try {
    const { busId } = req.params;
    const bus = await Bus.findOne({ shortId: busId.toUpperCase() }).lean();
    if (!bus) return res.status(404).json({ error: 'Bus not found' });
    const routeDoc = await Route.findById(bus.routeId).lean();
    if (!routeDoc) return res.status(404).json({ error: 'Route not found for bus' });
    return res.json({
      busId: bus.shortId,
      routeId: String(bus.routeId),
      routeName: routeDoc.routeName,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lookup failed' });
  }
});

// --- Driver sends live location ---
app.post("/api/update-location", (req, res) => {
  try {
    const { busId, latitude, longitude } = req.body;
    const entry = busRegistry[busId];

    if (!entry) {
      return res.status(404).json({ error: "Bus not registered" });
    }

    entry.currentLocation = { lat: latitude, lon: longitude };
    entry.lastUpdate = Date.now();

    // Find nearest stop and mark arrived if within 100m
    let status = "On Route";
    let currentStopIndex = -1;

    for (let i = 0; i < entry.stops.length; i++) {
      const stop = entry.stops[i];
      const distance = getDistance(
        { lat: latitude, lon: longitude },
        { lat: stop.lat, lon: stop.lon }
      );
      if (distance < 100) {
        status = `Arrived at ${stop.name}`;
        currentStopIndex = i;
        break;
      }
    }

    if (currentStopIndex > entry.currentStopIndex) {
      entry.currentStopIndex = currentStopIndex;
    }

    console.log(`Bus ${busId} location:`, latitude, longitude, "Status:", status);

    res.json({
      busId,
      latitude,
      longitude,
      status,
      currentStopIndex: entry.currentStopIndex,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- User fetches live bus locations ---
app.get("/api/bus-location/:busId", (req, res) => {
  try {
    const { busId } = req.params;
    const entry = busRegistry[busId];
    if (!entry) return res.status(404).json({ error: "Bus not found" });

    const { currentLocation, stops, currentStopIndex } = entry;

    // Estimate ETA to next stop with assumed avg speed 30km/h if we have a location
    let etaSeconds = null;
    let nextStop = null;
    if (currentLocation && currentLocation.lat != null) {
      const nextIndex = Math.min(currentStopIndex + 1, stops.length - 1);
      nextStop = stops[nextIndex] || null;
      if (nextStop) {
        const meters = getDistance(currentLocation, { lat: nextStop.lat, lon: nextStop.lon });
        const speedMps = 30_000 / 3600; // 30 km/h
        etaSeconds = Math.max(0, Math.round(meters / speedMps));
      }
    }

    res.json({
      busId,
      routeId: entry.routeId,
      routeName: entry.routeName,
      busNumber: entry.busNumber,
      currentLocation,
      stops,
      currentStopIndex,
      etaSeconds,
      lastUpdate: entry.lastUpdate,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- List live buses ---
app.get("/api/live-buses", (req, res) => {
  try {
    const list = Object.entries(busRegistry).map(([busId, e]) => {
      // compute ETA as above
      let etaSeconds = null;
      let nextStopName = null;
      if (e.currentLocation && e.currentLocation.lat != null) {
        const nextIndex = Math.min(e.currentStopIndex + 1, e.stops.length - 1);
        const nextStop = e.stops[nextIndex] || null;
        if (nextStop) {
          const meters = getDistance(e.currentLocation, { lat: nextStop.lat, lon: nextStop.lon });
          const speedMps = 30_000 / 3600;
          etaSeconds = Math.max(0, Math.round(meters / speedMps));
          nextStopName = nextStop.name;
        }
      }
      return {
        busId,
        routeId: e.routeId,
        routeName: e.routeName,
        busNumber: e.busNumber,
        currentStopIndex: e.currentStopIndex,
        etaSeconds,
        nextStopName,
        lastUpdate: e.lastUpdate,
      };
    });
    res.json(list);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// --- List all agency-registered buses (from DB)
app.get('/api/buses', authMiddleware, async (req, res) => {
  try {
    const buses = await Bus.find({ agencyId: req.agencyId }).lean();
    // Join route names
    const routeIds = [...new Set(buses.map(b => String(b.routeId)))];
    const routes = await Route.find({ _id: { $in: routeIds } }, '_id routeName').lean();
    const map = new Map(routes.map(r => [String(r._id), r.routeName]));
    const result = buses.map(b => ({
      id: String(b._id),
      shortId: b.shortId,
      registration: b.registration || '',
      routeId: String(b.routeId),
      routeName: map.get(String(b.routeId)) || '',
      createdAt: b.createdAt,
    }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch buses' });
  }
});

// --- Create/assign a bus (Agency)
app.post('/api/buses', authMiddleware, async (req, res) => {
  try {
    const { shortId, registration, routeId } = req.body;
    if (!shortId || !routeId) return res.status(400).json({ error: 'shortId and routeId are required' });
    const routeDoc = await Route.findOne({ _id: routeId, agencyId: req.agencyId });
    if (!routeDoc) return res.status(404).json({ error: 'Route not found' });

    const upsert = await Bus.findOneAndUpdate(
      { shortId: shortId.toUpperCase() },
      { shortId: shortId.toUpperCase(), registration: registration || shortId.toUpperCase(), busNumber: shortId.toUpperCase(), routeId: routeDoc._id, routeName: routeDoc.routeName, agencyId: req.agencyId },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    return res.json({
      id: String(upsert._id),
      shortId: upsert.shortId,
      registration: upsert.registration || '',
      routeId: String(upsert.routeId),
      routeName: upsert.routeName || routeDoc.routeName,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to save bus' });
  }
});



app.get("/api/routes", authMiddleware, async (req, res) => {
  try {
    const routes = await Route.find({ agencyId: req.agencyId }, "_id routeName stops distanceKm"); // select only required fields
    const formatted = routes.map(r => ({
      id: r._id,
      name: r.routeName,
      stops: r.stops,
      distance: r.distanceKm
    }));
    res.json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// --- POST new route ---
app.post("/api/routes", authMiddleware, async (req, res) => {
  try {
    console.log(req.body)
    const { routeName, distanceKm, stops } = req.body;
    if (!routeName || !distanceKm || !stops || stops.length === 0) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const newRoute = new Route({
      routeName,
      agencyId: req.agencyId,
      numberOfStops: stops.length,
      stops: stops.map((s, idx) => ({
        stopName: s.stopName,
        latitude: s.latitude,
        longitude: s.longitude,
        stopOrder: idx + 1,
      })),
      distanceKm,
    });

    const savedRoute = await newRoute.save();

    // Send only required fields
    res.json({
      id: savedRoute._id,
      name: savedRoute.routeName,
      stops: savedRoute.stops,
      distance: savedRoute.distanceKm
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
