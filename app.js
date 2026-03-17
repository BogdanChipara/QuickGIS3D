let viewer = null;
let lastTargetText = "";
const DEFAULT_LON = 13.410755;
const DEFAULT_LAT = 52.520926;
const DEFAULT_HEIGHT = 2500;

// selection variables
let selectedFeature = null;
let originalColor = null;
let lastStartedToken = "";
let sunAzimuthDegrees = 0;

function setWelcomePanelVisible(isVisible) {

  const panel = document.getElementById("welcomePanel");
  if (!panel) return;

  panel.classList.toggle("hidden", !isVisible);

}

function getImageryProviderConfig() {

  const excludedNames = new Set([
    "sentinel-2",
    "blue marble",
    "azure maps aerial",
    "azure maps areal",
    "azure maps roads"
  ]);

  const imageryProviderViewModels = Cesium.createDefaultImageryProviderViewModels()
    .filter((viewModel) => !excludedNames.has(viewModel.name.toLowerCase()));

  const defaultImageryProviderViewModel = imageryProviderViewModels.find((viewModel) =>
    viewModel.name === "Bing Maps Aerial with Labels"
  ) || imageryProviderViewModels[0];

  return {
    imageryProviderViewModels,
    defaultImageryProviderViewModel
  };

}

function isLikelyCesiumIonToken(token) {

  if (!token) return false;

  // Cesium ion access tokens are JWT-like: header.payload.signature
  return (
    token.startsWith("eyJ") &&
    token.length >= 100 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  );

}

const savedToken = localStorage.getItem("cesiumIonToken");
if (savedToken) {
  const tokenInput = document.getElementById("ionToken");
  if (tokenInput) {
    tokenInput.value = savedToken;
  }
}

function getCenterGroundPoint(currentViewer) {

  const scene = currentViewer.scene;
  const canvas = scene.canvas;

  const center = new Cesium.Cartesian2(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2
  );

  const ray = currentViewer.camera.getPickRay(center);
  if (!ray) return null;

  const hit = scene.globe.pick(ray, scene);
  if (!hit) return null;

  return Cesium.Cartographic.fromCartesian(hit);

}

function updateCoords() {

  if (!viewer) return;

  const target = getCenterGroundPoint(viewer);
  if (!target) return;

  const lon = Cesium.Math.toDegrees(target.longitude).toFixed(6);
  const lat = Cesium.Math.toDegrees(target.latitude).toFixed(6);

  const cam = viewer.camera.positionCartographic;
  const h = cam ? cam.height.toFixed(1) : "-";

  lastTargetText = `${lon}, ${lat}`;

  document.getElementById("coords").textContent =
    `Target Lon: ${lon}   Lat: ${lat}   Camera Height: ${h} m`;

}

function getCardinalLabelFromAzimuth(azimuthDegrees) {

  const normalized = ((azimuthDegrees % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "East";
  if (normalized < 67.5) return "NE";
  if (normalized < 112.5) return "North";
  if (normalized < 157.5) return "NW";
  if (normalized < 202.5) return "West";
  if (normalized < 247.5) return "SW";
  if (normalized < 292.5) return "South";
  return "SE";

}

function updateSunAzimuthLabel() {

  const labelEl = document.getElementById("sunAzimuthValue");
  if (!labelEl) return;

  const cardinal = getCardinalLabelFromAzimuth(sunAzimuthDegrees);
  labelEl.textContent = `${sunAzimuthDegrees.toFixed(0)}° (${cardinal})`;

}

function getLightReferenceLonLat() {

  if (viewer) {
    const center = getCenterGroundPoint(viewer);
    if (center) {
      return {
        lon: Cesium.Math.toDegrees(center.longitude),
        lat: Cesium.Math.toDegrees(center.latitude)
      };
    }
  }

  return {
    lon: DEFAULT_LON,
    lat: DEFAULT_LAT
  };

}

function parseGoogleMapsLocationUrl(value) {

  if (!value) return null;

  const atMatch = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(-?\d+(?:\.\d+)?)([am]))?/i);
  if (!atMatch) return null;

  const lat = Number.parseFloat(atMatch[1]);
  const lon = Number.parseFloat(atMatch[2]);
  let height = DEFAULT_HEIGHT;

  if (atMatch[3]) {
    const amount = Number.parseFloat(atMatch[3]);
    const unit = (atMatch[4] || "").toLowerCase();
    if (Number.isFinite(amount)) {
      height = unit === "a" ? amount : unit === "m" ? amount : DEFAULT_HEIGHT;
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return { lon, lat, height };

}

function getStartupCameraTarget() {

  const mapsLocationEl = document.getElementById("mapsLocation");
  const mapsLink = mapsLocationEl ? mapsLocationEl.value.trim() : "";
  const parsed = parseGoogleMapsLocationUrl(mapsLink);

  if (parsed) {
    return parsed;
  }

  return {
    lon: DEFAULT_LON,
    lat: DEFAULT_LAT,
    height: DEFAULT_HEIGHT
  };

}

async function goToGoogleMapsLocationLink(linkValue, options = {}) {

  const { silent = false } = options;
  const parsed = parseGoogleMapsLocationUrl(linkValue);

  if (!parsed) {
    if (!silent) {
      alert("Could not read location from that Google Maps link.");
    }
    return;
  }

  if (!viewer) {
    await startViewer({ silent: true });
  }

  if (!viewer) {
    if (!silent) {
      alert("Viewer is not started yet. Paste a valid token first.");
    }
    return;
  }

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(parsed.lon, parsed.lat, parsed.height),
    duration: 1.8
  });

}

function getEastToWestLightDirection(lon, lat) {

  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const eastNorthUp = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const east = Cesium.Matrix4.getColumn(eastNorthUp, 0, new Cesium.Cartesian4());

  return Cesium.Cartesian3.normalize(
    new Cesium.Cartesian3(-east.x, -east.y, -east.z),
    new Cesium.Cartesian3()
  );

}

function getLightDirectionFromAzimuth(lon, lat, azimuthDegrees) {

  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const eastNorthUp = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const east = Cesium.Matrix4.getColumn(eastNorthUp, 0, new Cesium.Cartesian4());
  const north = Cesium.Matrix4.getColumn(eastNorthUp, 1, new Cesium.Cartesian4());

  const radians = Cesium.Math.toRadians(azimuthDegrees);
  const sourceDirection = new Cesium.Cartesian3(
    east.x * Math.cos(radians) + north.x * Math.sin(radians),
    east.y * Math.cos(radians) + north.y * Math.sin(radians),
    east.z * Math.cos(radians) + north.z * Math.sin(radians)
  );

  return Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(sourceDirection, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

}

function applySunDirectionFromAzimuth() {

  if (!viewer) return;

  const reference = getLightReferenceLonLat();
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: getLightDirectionFromAzimuth(reference.lon, reference.lat, sunAzimuthDegrees),
    color: Cesium.Color.WHITE,
    intensity: 4.0
  });

}

async function startViewer(options = {}) {

  const { silent = false } = options;
  const token = document.getElementById("ionToken").value.trim();

  if (!token) {
    setWelcomePanelVisible(true);
    if (!silent) {
      alert("Paste your Cesium ion token first.");
    }
    return;
  }

  if (!isLikelyCesiumIonToken(token)) {
    setWelcomePanelVisible(true);
    if (!silent) {
      alert("Token format looks invalid. Paste a full Cesium ion token.");
    }
    return;
  }

  if (viewer && token === lastStartedToken) {
    const startupTarget = getStartupCameraTarget();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        startupTarget.lon,
        startupTarget.lat,
        startupTarget.height
      ),
      duration: 1.3
    });
    setWelcomePanelVisible(false);
    return;
  }

  setWelcomePanelVisible(false);

  Cesium.Ion.defaultAccessToken = token;

  let nextViewer = null;
  const {
    imageryProviderViewModels,
    defaultImageryProviderViewModel
  } = getImageryProviderConfig();

  try {
    const startupTarget = getStartupCameraTarget();

    nextViewer = new Cesium.Viewer("cesiumContainer", {
      terrain: Cesium.Terrain.fromWorldTerrain(),
      animation: false,
      timeline: false,
      baseLayerPicker: true,
      imageryProviderViewModels,
      selectedImageryProviderViewModel: defaultImageryProviderViewModel,
      geocoder: true,
      sceneModePicker: false,
      navigationHelpButton: true,
      homeButton: true,
      fullscreenButton: true
    });

    nextViewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        startupTarget.lon,
        startupTarget.lat,
        startupTarget.height
      )
    });

    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    osmBuildings.maximumScreenSpaceError = 4;
    if (osmBuildings.environmentMapManager) {
      osmBuildings.environmentMapManager.enabled = false;
    }
    if (osmBuildings.imageBasedLighting) {
      osmBuildings.imageBasedLighting.imageBasedLightingFactor =
        new Cesium.Cartesian2(1.0, 0.0);
      osmBuildings.imageBasedLighting.sphericalHarmonicCoefficients =
        Cesium.DynamicEnvironmentMapManager.DEFAULT_SPHERICAL_HARMONIC_COEFFICIENTS;
    }

    if (viewer) {
      viewer.destroy();
      viewer = null;
    }

    selectedFeature = null;
    originalColor = null;

    viewer = nextViewer;
    lastStartedToken = token;
    localStorage.setItem("cesiumIonToken", token);
    window.cesiumViewer = viewer;
    window.osmBuildingsTileset = osmBuildings;

    applySunDirectionFromAzimuth();

    osmBuildings.style = new Cesium.Cesium3DTileStyle({
      color: "color('lightgray')"
    });

    viewer.scene.primitives.add(osmBuildings);

    viewer.camera.changed.addEventListener(updateCoords);
    updateCoords();

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction(function(click) {

      const picked = viewer.scene.pick(click.position);

      if (Cesium.defined(picked) && picked.getProperty) {

        if (selectedFeature) {
          selectedFeature.color = originalColor;
        }

        selectedFeature = picked;
        originalColor = Cesium.Color.clone(picked.color, new Cesium.Color());

        picked.color = Cesium.Color.YELLOW;

      } else {

        if (selectedFeature) {
          selectedFeature.color = originalColor;
          selectedFeature = null;
          originalColor = null;
        }

      }

    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  } catch (error) {
    if (nextViewer && nextViewer !== viewer && !(typeof nextViewer.isDestroyed === "function" && nextViewer.isDestroyed())) {
      nextViewer.destroy();
    }

    if (!viewer) {
      window.cesiumViewer = null;
      window.osmBuildingsTileset = null;
      setWelcomePanelVisible(true);
    }

    if (!silent) {
      alert(`Could not start Cesium viewer: ${error?.message || error}`);
    }
  }

}

function copyCoords() {

  if (!lastTargetText) {
    alert("No coordinates available yet.");
    return;
  }

  navigator.clipboard.writeText(lastTargetText)
    .then(() => alert(`Copied: ${lastTargetText}`))
    .catch(() => alert("Could not copy coordinates."));

}

function clearSavedToken() {

  localStorage.removeItem("cesiumIonToken");

  const tokenInput = document.getElementById("ionToken");
  if (tokenInput) {
    tokenInput.value = "";
  }

  Cesium.Ion.defaultAccessToken = "";
  lastStartedToken = "";
  lastTargetText = "";

  if (viewer) {
    viewer.destroy();
    viewer = null;
  }

  selectedFeature = null;
  originalColor = null;
  window.cesiumViewer = null;
  window.osmBuildingsTileset = null;

  const coordsEl = document.getElementById("coords");
  if (coordsEl) {
    coordsEl.textContent = "";
  }

  setWelcomePanelVisible(true);
  alert("Saved token cleared.");

}

function openTokenPage() {

  window.open("https://ion.cesium.com/tokens", "_blank", "noopener,noreferrer");

}

document.getElementById("getTokenBtn").addEventListener("click", openTokenPage);
document.getElementById("clearTokenBtn").addEventListener("click", clearSavedToken);
document.getElementById("copyBtn").addEventListener("click", copyCoords);

const tokenInputEl = document.getElementById("ionToken");
if (tokenInputEl) {
  tokenInputEl.addEventListener("input", function() {
    const value = tokenInputEl.value.trim();
    setWelcomePanelVisible(!isLikelyCesiumIonToken(value));
  });

  tokenInputEl.addEventListener("paste", function() {
    setTimeout(() => startViewer({ silent: true }), 0);
  });

  tokenInputEl.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
      startViewer({ silent: true });
    }
  });
}

const mapsLocationEl = document.getElementById("mapsLocation");
if (mapsLocationEl) {
  mapsLocationEl.addEventListener("paste", function() {
    setTimeout(() => goToGoogleMapsLocationLink(mapsLocationEl.value, { silent: true }), 0);
  });

  mapsLocationEl.addEventListener("change", function() {
    goToGoogleMapsLocationLink(mapsLocationEl.value, { silent: true });
  });

  mapsLocationEl.addEventListener("keydown", function(event) {
    if (event.key === "Enter") {
      goToGoogleMapsLocationLink(mapsLocationEl.value, { silent: true });
    }
  });
}

const sunAzimuthEl = document.getElementById("sunAzimuth");
if (sunAzimuthEl) {
  const parsed = Number.parseFloat(sunAzimuthEl.value);
  if (Number.isFinite(parsed)) {
    sunAzimuthDegrees = parsed;
  }
  updateSunAzimuthLabel();

  sunAzimuthEl.addEventListener("input", function() {
    const value = Number.parseFloat(sunAzimuthEl.value);
    if (!Number.isFinite(value)) return;
    sunAzimuthDegrees = value;
    updateSunAzimuthLabel();
    applySunDirectionFromAzimuth();
  });
}

if (savedToken) {
  lastStartedToken = savedToken;
  startViewer({ silent: true });
} else {
  setWelcomePanelVisible(true);
}
