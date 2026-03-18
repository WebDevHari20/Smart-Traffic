import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN || '';

const getBackendBaseUrl = () => {
  const envUrl = import.meta.env.VITE_BACKEND_URL;
  return envUrl && typeof envUrl === 'string' ? envUrl : 'http://localhost:4000';
};

const DEFAULT_AMBULANCE_PROXIMITY_METERS = 450;
const DEFAULT_SIMULATION_SPEED_MS = 700;

const getDistanceMeters = (aLng, aLat, bLng, bLat) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  return 2 * earthRadius * Math.asin(Math.sqrt(h));
};

const pickRouteVariants = (drivingRoutes = [], trafficRoutes = []) => {
  const safeDriving = Array.isArray(drivingRoutes) ? drivingRoutes : [];
  const safeTraffic = Array.isArray(trafficRoutes) ? trafficRoutes : [];

  if (!safeDriving.length && !safeTraffic.length) {
    return { shortest: null, traffic: null, optimized: null };
  }

  const shortest = safeDriving.length
    ? [...safeDriving].sort((a, b) => (a?.distance || Infinity) - (b?.distance || Infinity))[0]
    : safeTraffic[0];

  const leastTraffic = safeTraffic.length
    ? [...safeTraffic].sort((a, b) => (a?.duration || Infinity) - (b?.duration || Infinity))[0]
    : shortest;

  const shortestDistance = shortest?.distance || 0;
  const leastTrafficDuration = leastTraffic?.duration || 0;

  // Optimized rule requested by user:
  // - duration should be more than least-traffic route
  // - distance should be more than shortest route
  const constrainedCandidates = safeTraffic.filter((route) => {
    const distance = route?.distance || 0;
    const duration = route?.duration || 0;
    return distance > shortestDistance && duration > leastTrafficDuration;
  });

  const optimizedPool = constrainedCandidates.length ? constrainedCandidates : safeTraffic;
  const optimized = optimizedPool.length
    ? [...optimizedPool].sort((a, b) => {
        const aDistanceDelta = Math.max(0, (a?.distance || 0) - shortestDistance);
        const aDurationDelta = Math.max(0, (a?.duration || 0) - leastTrafficDuration);
        const bDistanceDelta = Math.max(0, (b?.distance || 0) - shortestDistance);
        const bDurationDelta = Math.max(0, (b?.duration || 0) - leastTrafficDuration);
        return (aDistanceDelta + aDurationDelta) - (bDistanceDelta + bDurationDelta);
      })[0]
    : shortest;

  return {
    shortest,
    traffic: leastTraffic,
    optimized,
  };
};

const getAmbulanceFlagFromRow = (junctionRow) => {
  if (!junctionRow || typeof junctionRow !== 'object') return false;

  return Object.entries(junctionRow).some(([key, value]) => {
    return key.toLowerCase().includes('ambulance') && value === true;
  });
};

const getDbSignalFromRow = (junctionRow) => {
  const value = String(junctionRow?.signal_status || '').toLowerCase();
  return value === 'green' ? 'green' : 'red';
};

const deriveSignalsFromDbRows = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const hasAnyAmbulance = list.some((row) => getAmbulanceFlagFromRow(row));

  return list.reduce((acc, row) => {
    if (hasAnyAmbulance) {
      acc[row.id] = getAmbulanceFlagFromRow(row) ? 'green' : 'red';
      return acc;
    }

    acc[row.id] = getDbSignalFromRow(row);
    return acc;
  }, {});
};

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const startMarker = useRef(null);
  const endMarker = useRef(null);
  const trafficSignalMarkers = useRef([]);
  const ambulanceMarker = useRef(null);
  const corridorIntervalRef = useRef(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [routes, setRoutes] = useState({ shortest: null, traffic: null, optimized: null });
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [simulationRouteId, setSimulationRouteId] = useState('optimized');
  const [dbJunctions, setDbJunctions] = useState([]);
  const [signalByJunction, setSignalByJunction] = useState({});
  const [corridorActive, setCorridorActive] = useState(false);
  const [ambulanceProximityMeters, setAmbulanceProximityMeters] = useState(DEFAULT_AMBULANCE_PROXIMITY_METERS);
  const [simulationSpeedMs, setSimulationSpeedMs] = useState(DEFAULT_SIMULATION_SPEED_MS);
  const [followAmbulance, setFollowAmbulance] = useState(true);

  useEffect(() => {
    if (map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/navigation-night-v1',
      center: [77.5946, 12.9716], // Bengaluru
      zoom: 11
    });

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.current.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true,
      }),
      'top-right'
    );

    return () => {
      if (corridorIntervalRef.current) {
        clearInterval(corridorIntervalRef.current);
        corridorIntervalRef.current = null;
      }
      trafficSignalMarkers.current.forEach((marker) => marker.remove());
      trafficSignalMarkers.current = [];
      ambulanceMarker.current?.remove();
      ambulanceMarker.current = null;
      startMarker.current?.remove();
      endMarker.current?.remove();
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const fetchDbTraffic = async () => {
      try {
        const backendBaseUrl = getBackendBaseUrl();
        const response = await fetch(`${backendBaseUrl}/api/junctions`);
        const data = await response.json();

        if (!response.ok || !Array.isArray(data)) {
          throw new Error(data?.message || 'Failed to fetch junction traffic details from database.');
        }

        const onlyThreeJunctions = data
          .filter((item) => [1, 2, 3].includes(Number(item?.id)))
          .sort((a, b) => Number(a.id) - Number(b.id));

        if (isMounted) {
          setDbJunctions(onlyThreeJunctions);

          // DB-driven signal logic with ambulance override:
          // if ambulance occurs, force that junction green and others red.
          if (!corridorActive) {
            const derivedSignals = deriveSignalsFromDbRows(onlyThreeJunctions);
            setSignalByJunction(derivedSignals);
          }
        }
      } catch (error) {
        // no-op
      }
    };

    fetchDbTraffic();
    const intervalId = setInterval(fetchDbTraffic, 10000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [corridorActive]);

  const geocode = async (query) => {
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${mapboxgl.accessToken}`);
    const data = await res.json();
    return data.features[0]?.center;
  };

  const updateLocationMarkers = (startCoords, endCoords) => {
    if (!map.current) return;

    const createVehicleMarker = () => {
      const el = document.createElement('div');
      el.textContent = '🚗';
      el.style.fontSize = '26px';
      el.style.lineHeight = '1';
      el.style.filter = 'drop-shadow(0 3px 6px rgba(0, 0, 0, 0.45))';
      return el;
    };

    if (startMarker.current) startMarker.current.remove();
    if (endMarker.current) endMarker.current.remove();

    startMarker.current = new mapboxgl.Marker({ element: createVehicleMarker(), anchor: 'bottom' })
      .setLngLat(startCoords)
      .setPopup(new mapboxgl.Popup({ offset: 20 }).setText('Start Location'))
      .addTo(map.current);

    endMarker.current = new mapboxgl.Marker({ color: '#ef4444' })
      .setLngLat(endCoords)
      .setPopup(new mapboxgl.Popup({ offset: 20 }).setText('Destination'))
      .addTo(map.current);
  };

  const handleSearch = async () => {
    const startCoords = await geocode(start);
    const endCoords = await geocode(end);

    if (!startCoords || !endCoords) return alert("Location not found");

    updateLocationMarkers(startCoords, endCoords);

    const query = `${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}`;
   
    // Fetch Driving (Shortest) and Traffic (Least Traffic/Optimized)
    const [distRes, trafficRes] = await Promise.all([
      fetch(`https://api.mapbox.com/directions/v5/mapbox/driving/${query}?geometries=geojson&alternatives=true&access_token=${mapboxgl.accessToken}`),
      fetch(`https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${query}?geometries=geojson&alternatives=true&access_token=${mapboxgl.accessToken}`)
    ]);

    const distData = await distRes.json();
    const trafficData = await trafficRes.json();

    const newRoutes = pickRouteVariants(distData?.routes || [], trafficData?.routes || []);

    if (!newRoutes.shortest || !newRoutes.traffic || !newRoutes.optimized) {
      return alert('Could not calculate route variants. Try another start/end pair.');
    }

    setRoutes(newRoutes);
    setSelectedRoute('traffic'); // Default to traffic
    updateMap(newRoutes, 'traffic');
   
    // Fit map to route
    const bounds = new mapboxgl.LngLatBounds(startCoords, startCoords).extend(endCoords);
    map.current.fitBounds(bounds, { padding: 50 });
  };

  const resetSignalsToRed = () => {
    const redSignals = dbJunctions.reduce((acc, item) => {
      acc[item.id] = 'red';
      return acc;
    }, {});
    setSignalByJunction(redSignals);
  };

  const stopCorridorSimulation = () => {
    if (corridorIntervalRef.current) {
      clearInterval(corridorIntervalRef.current);
      corridorIntervalRef.current = null;
    }

    ambulanceMarker.current?.remove();
    ambulanceMarker.current = null;
    setCorridorActive(false);
    resetSignalsToRed();
  };

  const handleAmbulanceSimulation = () => {
    const routeToSimulate = routes?.[simulationRouteId];

    if (!map.current || !routeToSimulate?.geometry?.coordinates?.length) {
      alert('Please calculate routes first and choose a valid simulation path.');
      return;
    }

    if (corridorActive) {
      stopCorridorSimulation();
      return;
    }

    const coords = routeToSimulate.geometry.coordinates;
    let step = 0;

    const ambulanceEl = document.createElement('div');
    ambulanceEl.textContent = '🚑';
    ambulanceEl.style.fontSize = '24px';
    ambulanceEl.style.filter = 'drop-shadow(0 0 8px rgba(255,255,255,0.45))';

    ambulanceMarker.current = new mapboxgl.Marker({ element: ambulanceEl, anchor: 'bottom' })
      .setLngLat(coords[0])
      .addTo(map.current);

    setCorridorActive(true);

    corridorIntervalRef.current = setInterval(() => {
      if (!map.current || step >= coords.length) {
        stopCorridorSimulation();
        return;
      }

      const [lng, lat] = coords[step];
      ambulanceMarker.current?.setLngLat([lng, lat]);

      if (followAmbulance && map.current) {
        map.current.easeTo({ center: [lng, lat], duration: Math.max(250, Math.min(simulationSpeedMs, 1200)) });
      }

      const nextSignals = dbJunctions.reduce((acc, junction) => {
        const junctionLng = Number(junction?.lng);
        const junctionLat = Number(junction?.lat);

        if (!Number.isFinite(junctionLng) || !Number.isFinite(junctionLat)) {
          acc[junction.id] = 'red';
          return acc;
        }

        const distance = getDistanceMeters(lng, lat, junctionLng, junctionLat);
        acc[junction.id] = distance <= ambulanceProximityMeters ? 'green' : 'red';
        return acc;
      }, {});

      setSignalByJunction(nextSignals);
      step += 1;
    }, simulationSpeedMs);
  };

  useEffect(() => {
    if (!map.current) return;

    trafficSignalMarkers.current.forEach((marker) => marker.remove());
    trafficSignalMarkers.current = [];

    if (!corridorActive || !dbJunctions.length) {
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    let hasValidPoint = false;

    dbJunctions.forEach((junction) => {
      const lat = Number(junction?.lat);
      const lng = Number(junction?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      hasValidPoint = true;
      bounds.extend([lng, lat]);

      const signalColor = signalByJunction[junction.id] === 'green' ? 'green' : 'red';
      const color = signalColor === 'green' ? '#34d399' : '#ef4444';

      const markerEl = document.createElement('div');
      markerEl.style.display = 'flex';
      markerEl.style.flexDirection = 'column';
      markerEl.style.alignItems = 'center';
      markerEl.style.pointerEvents = 'auto';

      const signalBox = document.createElement('div');
      signalBox.style.width = '28px';
      signalBox.style.padding = '4px 4px';
      signalBox.style.borderRadius = '10px';
      signalBox.style.background = '#0f172a';
      signalBox.style.border = '2px solid #334155';
      signalBox.style.boxShadow = '0 6px 14px rgba(0,0,0,0.45)';
      signalBox.style.display = 'flex';
      signalBox.style.flexDirection = 'column';
      signalBox.style.gap = '3px';

      const createLamp = (lampColor, isActive) => {
        const lamp = document.createElement('div');
        lamp.style.width = '14px';
        lamp.style.height = '14px';
        lamp.style.borderRadius = '9999px';
        lamp.style.margin = '0 auto';
        lamp.style.border = '1px solid rgba(0,0,0,0.45)';

        if (lampColor === 'red') {
          lamp.style.background = isActive ? '#ef4444' : '#7f1d1d';
          lamp.style.boxShadow = isActive ? '0 0 10px rgba(239,68,68,0.9)' : 'none';
        } else if (lampColor === 'yellow') {
          lamp.style.background = '#713f12';
          lamp.style.boxShadow = 'none';
        } else {
          lamp.style.background = isActive ? '#34d399' : '#064e3b';
          lamp.style.boxShadow = isActive ? '0 0 10px rgba(52,211,153,0.9)' : 'none';
        }

        return lamp;
      };

      signalBox.appendChild(createLamp('red', signalColor === 'red'));
      signalBox.appendChild(createLamp('yellow', false));
      signalBox.appendChild(createLamp('green', signalColor === 'green'));

      const pole = document.createElement('div');
      pole.style.width = '4px';
      pole.style.height = '12px';
      pole.style.marginTop = '2px';
      pole.style.background = '#475569';
      pole.style.borderRadius = '2px';

      markerEl.appendChild(signalBox);
      markerEl.appendChild(pole);

      const marker = new mapboxgl.Marker({ element: markerEl })
        .setLngLat([lng, lat])
        .setPopup(
          new mapboxgl.Popup({ offset: 18 }).setHTML(
            `<div style="font-size:12px;line-height:1.35;">
              <strong>${junction.name || `Junction ${junction.id}`}</strong><br/>
              Vehicles: ${junction.vehicle_count ?? 0}<br/>
              Type: Traffic Signal<br/>
              Signal: ${String(signalColor).toUpperCase()}
            </div>`
          )
        )
        .addTo(map.current);

      trafficSignalMarkers.current.push(marker);
    });

    if (hasValidPoint && !routes.shortest) {
      map.current.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 800 });
    }
  }, [corridorActive, dbJunctions, signalByJunction, routes.shortest]);

  const optimizedDistanceKm = routes?.optimized?.distance
    ? (routes.optimized.distance / 1000).toFixed(2)
    : null;
  const optimizedDurationMin = routes?.optimized?.duration
    ? (routes.optimized.duration / 60).toFixed(0)
    : null;

  const updateMap = (allRoutes, activeId) => {
    const layers = [
      { id: 'shortest', data: allRoutes.shortest.geometry, color: '#3bb2d0' }, // Blue
      { id: 'traffic', data: allRoutes.traffic.geometry, color: '#f44336' },   // Red
      { id: 'optimized', data: allRoutes.optimized.geometry, color: '#4caf50' } // Green
    ];

    layers.forEach(layer => {
      const isActive = layer.id === activeId;
      const opacity = isActive ? 1 : 0.15;
      const width = isActive ? 7 : 3;
      const color = isActive ? layer.color : '#888888';

      if (map.current.getSource(layer.id)) {
        map.current.getSource(layer.id).setData(layer.data);
        map.current.setPaintProperty(layer.id, 'line-color', color);
        map.current.setPaintProperty(layer.id, 'line-opacity', opacity);
        map.current.setPaintProperty(layer.id, 'line-width', width);
      } else {
        map.current.addLayer({
          id: layer.id,
          type: 'line',
          source: { type: 'geojson', data: layer.data },
          paint: { 'line-color': color, 'line-width': width, 'line-opacity': opacity }
        });
      }
    });
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100">
      {/* Sidebar UI */}
      <div className="w-full max-w-[350px] overflow-y-auto border-r border-slate-700/70 bg-slate-900 p-5 shadow-2xl">
        <h2 className="mb-5 text-2xl font-semibold tracking-tight">Traffic Manager</h2>
       
        <div className="mb-5">
          <input
            placeholder="Start location"
            value={start}
            onChange={e => setStart(e.target.value)}
            className="mb-2.5 w-full rounded-md border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30"
          />
          <input
            placeholder="Destination"
            value={end}
            onChange={e => setEnd(e.target.value)}
            className="mb-2.5 w-full rounded-md border border-slate-600 bg-slate-800 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30"
          />
          <button
            onClick={handleSearch}
            className="w-full rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-400 active:scale-[0.99]"
          >
            Calculate Routes
          </button>

          <button
            onClick={handleAmbulanceSimulation}
            disabled={!routes?.[simulationRouteId]}
            className="mt-2.5 w-full rounded-md bg-rose-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-slate-600"
          >
            {corridorActive ? 'Stop Ambulance' : 'Ambulance'}
          </button>

          <div className="mt-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-300">Corridor Controls</p>

            <label className="mb-1 block text-[11px] text-slate-400">Simulation Path</label>
            <select
              value={simulationRouteId}
              onChange={(e) => setSimulationRouteId(e.target.value)}
              className="mb-2 w-full rounded-md border border-slate-600 bg-slate-900 px-2.5 py-2 text-xs text-slate-100 outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/20"
            >
              <option value="shortest">Shortest Path</option>
              <option value="traffic">Least Traffic Path</option>
              <option value="optimized">Optimized Path</option>
            </select>

            <label className="mb-1 block text-[11px] text-slate-400">
              Proximity Range (meters): {ambulanceProximityMeters}
            </label>
            <input
              type="range"
              min="200"
              max="1200"
              step="50"
              value={ambulanceProximityMeters}
              onChange={(e) => setAmbulanceProximityMeters(Number(e.target.value))}
              className="mb-2 w-full"
            />

            <label className="mb-1 block text-[11px] text-slate-400">
              Simulation Speed (ms/step): {simulationSpeedMs}
            </label>
            <input
              type="range"
              min="250"
              max="1800"
              step="50"
              value={simulationSpeedMs}
              onChange={(e) => setSimulationSpeedMs(Number(e.target.value))}
              className="mb-2 w-full"
            />

            <label className="inline-flex items-center gap-2 text-[12px] text-slate-300">
              <input
                type="checkbox"
                checked={followAmbulance}
                onChange={(e) => setFollowAmbulance(e.target.checked)}
              />
              Auto-follow ambulance on map
            </label>
          </div>
        </div>

        {routes.shortest && (
          <div>
            <div className="mb-2.5 rounded-lg border border-emerald-400/35 bg-emerald-900/15 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">Optimized Path Estimation</p>
              <p className="mt-1 text-sm text-slate-100">
                {optimizedDistanceKm} km
                {optimizedDurationMin ? ` | ${optimizedDurationMin} mins` : ''}
              </p>
            </div>

            <div
              onClick={() => { setSelectedRoute('shortest'); updateMap(routes, 'shortest'); }}
              className={`mb-2.5 cursor-pointer rounded-lg border-l-4 p-4 transition ${
                selectedRoute === 'shortest'
                  ? 'border-[#3bb2d0] bg-slate-700/80'
                  : 'border-slate-500 bg-slate-800/80 hover:bg-slate-700/70'
              }`}
            >
              <h4 className="text-base font-semibold text-sky-300">Shortest Path (Blue)</h4>
              <p className="mt-1 text-sm text-slate-200">{(routes.shortest.distance / 1000).toFixed(1)} km | {(routes.shortest.duration / 60).toFixed(0)} mins</p>
            </div>

            <div
              onClick={() => { setSelectedRoute('traffic'); updateMap(routes, 'traffic'); }}
              className={`mb-2.5 cursor-pointer rounded-lg border-l-4 p-4 transition ${
                selectedRoute === 'traffic'
                  ? 'border-[#f44336] bg-slate-700/80'
                  : 'border-slate-500 bg-slate-800/80 hover:bg-slate-700/70'
              }`}
            >
              <h4 className="text-base font-semibold text-rose-300">Least Traffic (Red)</h4>
              <p className="mt-1 text-sm text-slate-200">{(routes.traffic.distance / 1000).toFixed(1)} km | {(routes.traffic.duration / 60).toFixed(0)} mins</p>
            </div>

            <div
              onClick={() => { setSelectedRoute('optimized'); updateMap(routes, 'optimized'); }}
              className={`cursor-pointer rounded-lg border-l-4 p-4 transition ${
                selectedRoute === 'optimized'
                  ? 'border-[#4caf50] bg-slate-700/80'
                  : 'border-slate-500 bg-slate-800/80 hover:bg-slate-700/70'
              }`}
            >
              <h4 className="text-base font-semibold text-emerald-300">Optimized (Green)</h4>
              <p className="mt-1 text-sm text-slate-200">
                {optimizedDistanceKm} km
                {optimizedDurationMin ? ` | ${optimizedDurationMin} mins` : ''}
              </p>
            </div>
          </div>
        )}
      </div>

      <div ref={mapContainer} className="flex-1" />
    </div>
  );
};

export default App;